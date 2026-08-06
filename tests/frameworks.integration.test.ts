import { afterEach, describe, expect, it } from "vitest";

import { NestJsAnalyzer, NextJsAnalyzer, scanProject, showSymbol } from "../src/index.js";
import {
  createFixture,
  factsText,
  readPersistedMap,
  relationExists,
  removeProject,
  symbolNamed,
} from "./helpers.js";

const temporaryProjects: string[] = [];

async function fixture(name: Parameters<typeof createFixture>[0]): Promise<string> {
  const root = await createFixture(name);
  temporaryProjects.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(removeProject));
});

const optionalFrameworkIt = process.env.AI_CODE_MAP_TEST_OPTIONAL_FRAMEWORKS === "1" ? it : it.skip;

describe("framework analysis through persisted public schemas", () => {
  it("indexes TypeScript, Node.js, aliases, CommonJS, exports, calls, and stable human-readable IDs", async () => {
    const root = await fixture("typescript-node");
    await scanProject({ root });
    const map = await readPersistedMap(root);

    expect(map.files.map((file) => file.path)).toEqual(
      [...map.files.map((file) => file.path)].sort(),
    );
    expect(map.files.every((file) => !file.path.startsWith("/") && !file.path.includes("\\"))).toBe(
      true,
    );
    expect(
      map.symbols.every(
        (symbol) => symbol.range.startLine > 0 && symbol.range.endLine >= symbol.range.startLine,
      ),
    ).toBe(true);

    const main = symbolNamed(map, "main");
    const calculator = symbolNamed(map, "Calculator");
    const compute = symbolNamed(map, "compute");
    expect(main.kind).toBe("function");
    expect(main.signature).toMatch(/Promise<number>/);
    expect(calculator.kind).toBe("class");
    expect(compute.kind).toBe("method");
    expect(compute.signature).toMatch(/Promise<number>/);
    expect(relationExists(map, "instantiates", "main", "calculator")).toBe(true);
    expect(relationExists(map, "calls", "main", "compute")).toBe(true);
    expect(relationExists(map, "calls", "compute", "add")).toBe(true);
    const compilerRelation = map.relations.find(
      (relation) => relation.type === "contains" && relation.to === main.id,
    );
    expect(compilerRelation).toMatchObject({
      confidence: 1,
      origin: { classification: "exact", analyzer: "typescript-node" },
    });

    const serviceFile = map.files.find((file) => file.path === "src/service.ts");
    const aliasImport = serviceFile?.imports.find((item) => item.source === "@/math");
    expect(aliasImport?.resolved).toBe("src/math.ts");
    expect(aliasImport?.specifiers).toContainEqual(
      expect.objectContaining({ imported: "add", local: "calculate" }),
    );
    const indexFile = map.files.find((file) => file.path === "src/index.ts");
    expect(indexFile?.env).toContain("API_TOKEN");
    expect(indexFile?.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "filesystem" })]),
    );
    expect(indexFile?.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sum", source: "@/math" }),
        expect.objectContaining({ source: "./service.js" }),
      ]),
    );
    expect(relationExists(map, "reexports", "index", "math")).toBe(true);

    const legacy = map.files.find((file) => file.path === "src/legacy.js");
    expect(legacy?.imports).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "node:path", kind: "commonjs" })]),
    );
    expect(legacy?.exports.length).toBeGreaterThan(0);
    expect(symbolNamed(map, "basename").file).toBe("src/legacy.js");

    const duplicates = map.symbols.filter((symbol) => symbol.name === "duplicate");
    expect(new Set(map.symbols.map((symbol) => symbol.id)).size).toBe(map.symbols.length);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((symbol) => symbol.id)).size).toBe(2);
    expect(
      duplicates.every((symbol) => symbol.id.includes(symbol.file) && !symbol.id.includes(root)),
    ).toBe(true);
    expect(compute.id.toLowerCase()).toMatch(/calculator.*compute/);
    const anonymousDefault = map.symbols.find(
      (symbol) => symbol.file === "src/anonymous.ts" && symbol.defaultExport,
    );
    expect(anonymousDefault?.id).toMatch(/anonymous\.ts#.+/);
    expect(map.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unresolved-import", file: "src/index.ts" }),
      ]),
    );
    expect(
      map.relations.every(
        (relation) =>
          relation.confidence >= 0 &&
          relation.confidence <= 1 &&
          relation.origin.line > 0 &&
          Boolean(relation.origin.explanation),
      ),
    ).toBe(true);
    const manifestHashes = new Map(map.manifest.sourceFiles.map((file) => [file.path, file.hash]));
    expect(
      map.files.every(
        (file) =>
          file.hash.length > 0 &&
          manifestHashes.get(file.path) === file.hash &&
          file.symbolIds.every(
            (id) => map.symbols.find((symbol) => symbol.id === id)?.sourceHash === file.hash,
          ),
      ),
    ).toBe(true);
  });

  it("normalizes React props, state, memoization, effects, custom hooks, and render edges", async () => {
    const root = await fixture("react");
    const scan = await scanProject({ root });
    const map = await readPersistedMap(root);

    const list = symbolNamed(map, "UserList");
    const badge = symbolNamed(map, "Badge");
    expect(list.kind).toBe("react-component");
    expect(badge.kind).toBe("react-component");
    expect(badge.file).toBe("src/Badge.jsx");
    expect(factsText(list)).toMatch(/userlistprops|users/);
    expect(factsText(list)).toContain("search");
    expect(factsText(list)).toContain("descending");
    expect(factsText(list)).toContain("visibleusers");
    expect(factsText(list)).toMatch(/usememo|memo/);
    expect(factsText(list)).toMatch(/usereducer|reducer/);
    expect(factsText(list)).toMatch(/usecallback|callback/);
    expect(factsText(list)).toMatch(/useeffect|effect/);
    expect(factsText(list)).toContain("visibleusers.length");
    expect(factsText(list)).toMatch(/users.*search.*descending|descending.*search.*users/);
    expect(factsText(list)).toMatch(/onselect.*select|select.*onselect/);
    expect(relationExists(map, "renders", "userlist", "userrow")).toBe(true);
    expect(relationExists(map, "renders", "app", "userlist")).toBe(true);
    expect(relationExists(map, "renders", "userrow", "badge")).toBe(true);
    const row = symbolNamed(map, "UserRow");
    const frameworkRelation = map.relations.find(
      (relation) =>
        relation.type === "renders" && relation.from === list.id && relation.to === row.id,
    );
    expect(frameworkRelation).toMatchObject({
      origin: { classification: "framework-derived", analyzer: "react" },
    });
    expect(
      showSymbol(scan.map, "component:UserList").matches.some(
        (match) => match.symbol.id === list.id,
      ),
    ).toBe(true);
  });

  optionalFrameworkIt(
    "derives App Router routes without leaking route groups and links pages to layouts",
    async () => {
      const root = await fixture("next-app");
      await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
      const map = await readPersistedMap(root);

      const page = map.symbols.find(
        (symbol) => symbol.kind === "next-page" && factsText(symbol).includes("/products/[id]"),
      );
      if (!page) throw new Error("Expected an App Router page symbol");
      expect(factsText(page)).toContain("app");
      expect(factsText(page)).toContain("server");
      expect(factsText(page)).not.toContain("(shop)");
      expect(factsText(page)).toContain("id");

      const layouts = map.symbols.filter((symbol) => symbol.kind === "next-layout");
      expect(layouts.map((symbol) => symbol.file)).toEqual(
        expect.arrayContaining(["app/layout.tsx", "app/(shop)/products/layout.tsx"]),
      );
      expect(relationExists(map, "uses-layout", page.id, "app/layout.tsx")).toBe(true);
      expect(relationExists(map, "uses-layout", page.id, "products/layout.tsx")).toBe(true);

      const client = symbolNamed(map, "ClientProduct");
      expect(client.kind).toBe("react-component");
      expect(factsText(client)).toContain("client");
      const routeHandler = map.symbols.find((symbol) => symbol.kind === "next-route-handler");
      if (!routeHandler) throw new Error("Expected an App Router route handler symbol");
      expect(factsText(routeHandler)).toContain("/api/products/[id]");
      expect(factsText(routeHandler)).toMatch(/get/);
      expect(factsText(routeHandler)).toMatch(/post/);
    },
  );

  optionalFrameworkIt(
    "derives Pages Router dynamic pages, data loading, and API routes",
    async () => {
      const root = await fixture("next-pages");
      await scanProject({ root, analyzers: [new NextJsAnalyzer()] });
      const map = await readPersistedMap(root);

      const page = map.symbols.find((symbol) => symbol.kind === "next-page");
      if (!page) throw new Error("Expected a Pages Router page symbol");
      expect(factsText(page)).toContain("/products/[id]");
      expect(factsText(page)).toContain("pages");
      expect(factsText(page)).toContain("getserversideprops");
      const apiRoute = map.symbols.find(
        (symbol) =>
          symbol.kind === "next-route-handler" && factsText(symbol).includes("/api/products/[id]"),
      );
      expect(apiRoute).toBeDefined();
    },
  );

  optionalFrameworkIt(
    "recognizes NestJS only from imported decorators, including aliases, and emits route/injection relations",
    async () => {
      const root = await fixture("nest");
      await scanProject({ root, analyzers: [new NestJsAnalyzer()] });
      const map = await readPersistedMap(root);

      const module = symbolNamed(map, "UsersModule");
      const controller = symbolNamed(map, "UsersController");
      const service = symbolNamed(map, "UsersService");
      const guard = symbolNamed(map, "AuthGuard");
      const dto = symbolNamed(map, "CreateUserDto");
      const unusedDto = symbolNamed(map, "UnusedDto");
      const appModule = symbolNamed(map, "AppModule");
      expect(module.kind).toBe("nest-module");
      expect(controller.kind).toBe("nest-controller");
      expect(service.kind).toBe("nest-provider");
      expect(guard.kind).toBe("nest-guard");
      expect(dto.kind).toBe("dto");
      expect(unusedDto.kind).toBe("class");
      expect(appModule.kind).toBe("nest-module");
      expect(factsText(appModule)).toContain("usersmodule");
      expect(factsText(controller)).toContain("users");
      expect(factsText(controller)).toMatch(/get/);
      expect(factsText(controller)).toMatch(/post/);
      expect(factsText(controller)).toContain(":id");
      expect(factsText(controller)).toContain("authguard");
      expect(map.relations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: module.id, type: "contains", to: controller.id }),
          expect.objectContaining({ from: controller.id, type: "injects", to: service.id }),
          expect.objectContaining({
            from: controller.id,
            type: "belongs-to-module",
            to: module.id,
          }),
        ]),
      );
      expect(relationExists(map, "handles-route", "getbyid", "get")).toBe(true);
      expect(map.relations).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "consumes-dto", to: dto.id })]),
      );
    },
  );
});
