import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkFreshness, NextJsAnalyzer, scanProject } from "../src/index.js";
import { createFixture, readPersistedMap, removeProject, runCli } from "./helpers.js";

const roots: string[] = [];

async function fixture(name: "next-app" | "next-pages" | "react") {
  const root = await createFixture(name);
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeProject));
});

describe("Next.js support", () => {
  it.each(["app", "pages"] as const)("preserves %s route facts under src", async (router) => {
    const root = await fixture(router === "app" ? "next-app" : "next-pages");
    const before = await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
    await mkdir(join(root, "src"));
    await rename(join(root, router), join(root, "src", router));
    const configPath = join(root, "tsconfig.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      include?: string[];
      frameworks?: string[];
    };
    config.include = [`src/${router}/**/*`];
    await writeFile(configPath, JSON.stringify(config));
    const after = await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
    const original = before.map.symbols.filter((symbol) => symbol.kind.startsWith("next-"));
    const moved = after.map.symbols.filter((symbol) => symbol.kind.startsWith("next-"));
    expect(original.length).toBeGreaterThan(0);
    expect(moved.map(({ file, kind, facts }) => ({ file, kind, facts }))).toEqual(
      original.map(({ file, kind, facts }) => ({ file: `src/${file}`, kind, facts })),
    );
    const layouts = after.map.relations.filter((relation) => relation.type === "uses-layout");
    expect(layouts).toHaveLength(
      before.map.relations.filter((relation) => relation.type === "uses-layout").length,
    );
    for (const relation of layouts) {
      expect(moved.some((symbol) => symbol.id === relation.from)).toBe(true);
      expect(
        moved.some((symbol) => symbol.id === relation.to && symbol.kind === "next-layout"),
      ).toBe(true);
    }
  });

  it("recognizes exported HTTP names, including destructuring and aliases", async () => {
    const root = await fixture("next-app");
    const cases: Array<[string, string, string]> = [
      [
        "types",
        "export interface GET {} const handler = () => {}; export type { handler as POST };",
        "",
      ],
      ["reexport", 'export { GET } from "../products/[id]/route";', "get"],
      [
        "destructured",
        "const handlers = { GET() {}, POST() {} }; export const { GET, POST } = handlers;",
        "get,post",
      ],
      [
        "aliases",
        "const handler = () => {}; export { handler as GET, handler as POST };",
        "get,post",
      ],
      ["wrapped", "const wrap = (fn: () => void) => fn; export const PUT = wrap(() => {});", "put"],
      ["local", "function DELETE() {} const HEAD = () => {}; export const get = () => {};", ""],
      [
        "binding-alias",
        "const handlers = { GET() {}, post() {} }; export const { GET: local, post: POST } = handlers;",
        "post",
      ],
    ];
    for (const [name, source] of cases) {
      const directory = join(root, "app", "api", name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "route.ts"), source);
    }
    const { map } = await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
    for (const [name, , methods] of cases) {
      expect(
        map.symbols.find(
          (symbol) =>
            symbol.kind === "next-route-handler" && symbol.file === `app/api/${name}/route.ts`,
        )?.facts.methods,
      ).toBe(methods);
    }
  });

  it("recognizes wrapped default exports for pages and middleware", async () => {
    const root = await fixture("next-app");
    const source =
      "const authMiddleware = (fn: () => null) => fn; export default authMiddleware(() => null);\n";
    await writeFile(join(root, "app/page.tsx"), source);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/middleware.ts"), source);
    const { map } = await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
    expect(
      map.symbols.find((symbol) => symbol.kind === "next-page" && symbol.file === "app/page.tsx"),
    ).toMatchObject({ exported: true, defaultExport: true });
    expect(
      map.symbols.find(
        (symbol) => symbol.kind === "next-special-file" && symbol.file === "src/middleware.ts",
      ),
    ).toMatchObject({ name: "middleware", exported: true, defaultExport: true });
  });

  it("indexes destructured handlers and resolves calls to their exported bindings", async () => {
    const root = await fixture("next-app");
    const file = "app/api/route.ts";
    await writeFile(
      join(root, file),
      "const handlers = { GET: () => null, POST: () => null }; export const { GET, POST } = handlers;\n",
    );
    await writeFile(
      join(root, "app/caller.ts"),
      'import { GET } from "./api/route"; export function call() { return GET(); }\n',
    );
    const { map } = await scanProject({ root });
    for (const name of ["GET", "POST"]) {
      expect(
        map.symbols.find((symbol) => symbol.file === file && symbol.name === name),
      ).toMatchObject({ kind: "variable", exported: true });
    }
    expect(map.relations).toContainEqual(
      expect.objectContaining({
        type: "calls",
        from: "function:app/caller.ts#call",
        to: "variable:app/api/route.ts#GET",
      }),
    );
  });

  it("automatically enables Next.js in CLI and preserves freshness and explicit opt-out", async () => {
    const root = await fixture("next-app");
    expect((await runCli(["scan", "--root", root])).code).toBe(0);
    const map = await readPersistedMap(root);
    expect(map.symbols.some((symbol) => symbol.kind === "next-page")).toBe(true);
    expect(map.manifest.analyzers.some((analyzer) => analyzer.name === "nextjs")).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);
    expect((await scanProject({ root })).wrote).toBe(false);
    const configPath = join(root, ".ai/code-map/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      include?: string[];
      frameworks?: string[];
    };
    config.frameworks = ["typescript", "react"];
    await writeFile(configPath, JSON.stringify(config));
    expect((await checkFreshness({ root })).current).toBe(false);
    expect(
      (await scanProject({ root })).map.symbols.some((symbol) => symbol.kind.startsWith("next-")),
    ).toBe(false);
    config.frameworks = ["nextjs"];
    await writeFile(configPath, JSON.stringify(config));
    expect(
      (await scanProject({ root })).map.symbols.some((symbol) => symbol.kind === "next-page"),
    ).toBe(true);
    expect((await checkFreshness({ root })).current).toBe(true);
  });

  it("does not treat a plain React app directory as Next.js", async () => {
    const root = await fixture("react");
    await mkdir(join(root, "src/app"));
    await writeFile(
      join(root, "src/app/page.tsx"),
      "export default function Page() { return null; }",
    );
    const { map } = await scanProject({ root });
    expect(map.symbols.some((symbol) => symbol.kind.startsWith("next-"))).toBe(false);
  });
});
