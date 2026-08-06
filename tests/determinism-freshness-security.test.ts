import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkFreshness,
  createGitIgnoreAdapter,
  initProject,
  loadCodeMap,
  scanProject,
} from "../src/index.js";
import { createEmptyProject, createFixture, readPersistedMap, removeProject } from "./helpers.js";
import type { PersistedMap } from "./helpers.js";

const temporaryProjects: string[] = [];

async function fixture(name: Parameters<typeof createFixture>[0]): Promise<string> {
  const root = await createFixture(name);
  temporaryProjects.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map(removeProject));
});

function artifact(map: PersistedMap, name: string): Buffer {
  const value = map.raw[name];
  if (!value) throw new Error(`Missing persisted artifact ${name}`);
  return value;
}

describe("determinism and incremental freshness", () => {
  it("produces byte-identical sorted artifacts and does not rewrite an unchanged map", async () => {
    const root = await fixture("typescript-node");
    const output = "artifacts/custom-code-map";
    const firstScan = await scanProject({ root, output });
    const first = await readPersistedMap(root, output);
    await expect(access(join(root, ".ai/code-map/manifest.json"))).rejects.toThrow();
    await delay(25);
    const secondScan = await scanProject({ root, output });
    const second = await readPersistedMap(root, output);

    expect(firstScan.wrote).toBe(true);
    expect(secondScan.wrote).toBe(false);
    expect(secondScan.changes).toEqual({ added: [], modified: [], deleted: [], moved: [] });
    expect(Object.keys(second.raw).sort()).toEqual(Object.keys(first.raw).sort());
    for (const name of Object.keys(first.raw)) {
      expect(artifact(second, name).equals(artifact(first, name))).toBe(true);
      expect(second.mtimes[name]).toBe(first.mtimes[name]);
    }
    expect(second.symbols.map((symbol) => symbol.id)).toEqual(
      first.symbols.map((symbol) => symbol.id),
    );
    expect(second.symbols.map((symbol) => symbol.id)).toEqual(
      [...second.symbols.map((symbol) => symbol.id)].sort(),
    );
    const relationKeys = second.relations.map(
      (relation) => `${relation.from}\0${relation.type}\0${relation.to}\0${relation.origin.file}`,
    );
    expect(relationKeys).toEqual([...relationKeys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const persistedText = Object.values(second.raw)
      .map((value) => value.toString("utf8"))
      .join("\n");
    expect(persistedText).not.toContain(root);
    const overview = artifact(second, "overview.md").toString("utf8");
    expect(overview).toMatch(/code map/i);
    expect(overview).toMatch(/files/i);
    expect(overview).toMatch(/symbols/i);
    expect(overview).not.toContain("export async function main(): Promise<number> {");
  });

  it("detects additions, modifications, deletions, and moves and removes obsolete records", async () => {
    const root = await fixture("typescript-node");
    await scanProject({ root });
    expect((await checkFreshness({ root })).status).toBe("current");

    await appendFile(join(root, "src/math.ts"), "\nexport const newlyModified = true;\n");
    const modified = await checkFreshness({ root });
    expect(modified.status).toBe("stale");
    expect(modified.changes.modified).toContain("src/math.ts");
    expect(modified.reasons.join(" ").toLowerCase()).toMatch(/modified|source/);
    const modificationScan = await scanProject({ root });
    expect(modificationScan.changes.modified).toContain("src/math.ts");
    expect(modificationScan.map.symbols.some((symbol) => symbol.name === "newlyModified")).toBe(
      true,
    );

    await writeFile(join(root, "src/added.ts"), "export const addedLater = 1;\n");
    expect((await checkFreshness({ root })).changes.added).toContain("src/added.ts");
    const additionScan = await scanProject({ root });
    expect(additionScan.changes.added).toContain("src/added.ts");

    await rename(join(root, "src/duplicate-b.ts"), join(root, "src/moved-duplicate.ts"));
    const moved = await checkFreshness({ root });
    expect(moved.status).toBe("stale");
    expect(moved.changes.moved).toContainEqual({
      from: "src/duplicate-b.ts",
      to: "src/moved-duplicate.ts",
    });
    await scanProject({ root });
    const afterMove = await loadCodeMap({ root });
    expect(afterMove.files.some((file) => file.path === "src/duplicate-b.ts")).toBe(false);
    expect(afterMove.files.some((file) => file.path === "src/moved-duplicate.ts")).toBe(true);
    expect(JSON.stringify(afterMove)).not.toContain("src/duplicate-b.ts");

    await writeFile(join(root, "src/moved-duplicate.ts"), "", { flag: "w" });
    await scanProject({ root });
    await rename(join(root, "src/duplicate-a.ts"), join(root, "deleted-source.tmp"));
    const deleted = await checkFreshness({ root });
    expect(deleted.changes.deleted).toContain("src/duplicate-a.ts");
    await scanProject({ root });
    const afterDelete = await loadCodeMap({ root });
    expect(afterDelete.files.some((file) => file.path === "src/duplicate-a.ts")).toBe(false);
    expect(JSON.stringify(afterDelete.relations)).not.toContain("src/duplicate-a.ts");
  });

  it("includes configuration, analyzer, and schema compatibility in freshness decisions", async () => {
    const root = await fixture("typescript-node");
    await initProject({ root });
    await scanProject({ root });
    const configPath = join(root, ".ai/code-map/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { include: string[] };
    config.include.push("extra/**/*");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const configFreshness = await checkFreshness({ root });
    expect(configFreshness.status).toBe("stale");
    expect(configFreshness.reasons.join(" ").toLowerCase()).toContain("config");
    await scanProject({ root });

    const manifestPath = join(root, ".ai/code-map/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemaVersion: number;
      analyzerVersion: string;
    };
    const expectedAnalyzerVersion = manifest.analyzerVersion;
    manifest.analyzerVersion = "incompatible-test-analyzer";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const analyzerFreshness = await checkFreshness({ root });
    expect(analyzerFreshness.status).toBe("stale");
    expect(analyzerFreshness.reasons.join(" ").toLowerCase()).toContain("analyzer");

    manifest.analyzerVersion = expectedAnalyzerVersion;
    manifest.schemaVersion = 999;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(loadCodeMap({ root })).rejects.toThrow(/rescan|scan to regenerate/i);
  });

  it("rejects aggregate count and symbol ownership corruption when loading persisted records", async () => {
    const root = await fixture("typescript-node");
    await scanProject({ root });
    const projectPath = join(root, ".ai/code-map/project.json");
    const filesPath = join(root, ".ai/code-map/files.jsonl");
    const originalProject = await readFile(projectPath);
    const originalFiles = await readFile(filesPath, "utf8");

    const project = JSON.parse(originalProject.toString("utf8")) as {
      counts: { files: number };
    };
    project.counts.files += 1;
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    await expect(loadCodeMap({ root })).rejects.toThrow(/count|invalid persisted code map/i);

    await writeFile(projectPath, originalProject);
    const files = originalFiles
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { path: string; symbolIds: string[] });
    const owner = files.find((file) => file.symbolIds.length > 0);
    if (!owner) throw new Error("Expected a persisted file with owned symbols");
    owner.symbolIds = [];
    await writeFile(filesPath, `${files.map((file) => JSON.stringify(file)).join("\n")}\n`);
    await expect(loadCodeMap({ root })).rejects.toThrow(/symbol|invalid persisted code map/i);
  });
});

describe("failure isolation and privacy boundaries", () => {
  it("isolates a selected child package from its parent pnpm workspace and siblings", async () => {
    const parent = await createEmptyProject();
    temporaryProjects.push(parent);
    const selectedRoot = join(parent, "packages/selected");
    const siblingRoot = join(parent, "packages/sibling");
    await Promise.all([
      mkdir(join(selectedRoot, "src"), { recursive: true }),
      mkdir(join(siblingRoot, "src"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(parent, "package.json"),
        '{"name":"parent-workspace","private":true,"packageManager":"pnpm@10.0.0"}\n',
      ),
      writeFile(join(parent, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n'),
      writeFile(
        join(selectedRoot, "package.json"),
        '{"name":"selected-child","private":true,"main":"src/index.ts"}\n',
      ),
      writeFile(
        join(selectedRoot, "src/index.ts"),
        "export const selectedMarker = 'selected-only';\n",
      ),
      writeFile(
        join(siblingRoot, "package.json"),
        '{"name":"sibling-secret-package","private":true,"main":"src/sibling-secret.ts"}\n',
      ),
      writeFile(
        join(siblingRoot, "src/sibling-secret.ts"),
        "export const siblingSecretMarker = 'must-not-cross-package-boundary';\n",
      ),
    ]);

    const scan = await scanProject({ root: selectedRoot });
    const persisted = await readPersistedMap(selectedRoot);
    const persistedText = Object.values(persisted.raw)
      .map((value) => value.toString("utf8"))
      .join("\n");

    expect(scan.map.project.name).toBe("selected-child");
    expect(scan.map.project.workspaces).toEqual([]);
    expect(scan.map.files.map((file) => file.path)).toEqual(["src/index.ts"]);
    expect(persistedText).not.toContain("sibling-secret-package");
    expect(persistedText).not.toContain("sibling-secret.ts");
    expect(persistedText).not.toContain("must-not-cross-package-boundary");
  });

  it("honors ignored-parent precedence and safely rejects escaped or absolute candidates", async () => {
    const root = await createEmptyProject();
    temporaryProjects.push(root);
    await Promise.all([
      mkdir(join(root, "src"), { recursive: true }),
      mkdir(join(root, "ignored"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "package.json"), '{"name":"ignore-boundary","private":true}\n'),
      writeFile(join(root, "src/included.ts"), "export const included = true;\n"),
      writeFile(join(root, "ignored/keep.ts"), "export const mustRemainIgnored = true;\n"),
      writeFile(join(root, ".gitignore"), "ignored/\n"),
      writeFile(join(root, "ignored/.gitignore"), "!keep.ts\n"),
    ]);

    await initProject({ root });
    const configPath = join(root, ".ai/code-map/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { include: string[] };
    config.include = ["**/*.ts"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const scan = await scanProject({ root });
    expect(scan.map.files.map((file) => file.path)).toEqual(["src/included.ts"]);

    const filtered = await createGitIgnoreAdapter().filter(root, [
      "src/included.ts",
      "ignored/keep.ts",
      "../outside.ts",
      "src/../../outside.ts",
      "..\\outside.ts",
      "/absolute.ts",
      "C:/absolute.ts",
    ]);
    expect(filtered).toEqual(["src/included.ts"]);
  });

  it("continues after parse failures while preserving source, secrets, symlink boundaries, and unrelated .ai files", async () => {
    const root = await fixture("typescript-node");
    const outsideRoot = await createEmptyProject();
    temporaryProjects.push(outsideRoot);
    const envSecret = "ENV_SECRET_MUST_NOT_APPEAR_91e1a";
    const outsideSecret = "OUTSIDE_ROOT_MUST_NOT_APPEAR_97d2b";
    const sourceSecret = "SOURCE_LITERAL_MUST_NOT_APPEAR_bac71";
    await writeFile(join(root, ".env"), `API_TOKEN=${envSecret}\n`);
    await writeFile(join(outsideRoot, "escape.ts"), `export const leaked = "${outsideSecret}";\n`);
    await symlink(join(outsideRoot, "escape.ts"), join(root, "src/escape.ts"));
    await writeFile(
      join(root, "src/literal.ts"),
      `export function literalMessage() { return "${sourceSecret}"; }\n`,
    );
    const executionMarker = join(root, "source-was-executed.txt");
    await writeFile(
      join(root, "src/must-not-execute.ts"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(executionMarker)}, "executed");\n`,
    );
    await writeFile(join(root, "src/broken.ts"), "export function broken( {\n");
    await mkdir(join(root, ".ai/code-map"), { recursive: true });
    await writeFile(join(root, ".ai/owner-note.txt"), "keep-owner-note\n");
    await writeFile(join(root, ".ai/code-map/user-note.txt"), "keep-user-note\n");

    const sourceBefore = await readFile(join(root, "src/index.ts"));
    const result = await scanProject({ root });
    const map = await readPersistedMap(root);
    const persistedText = Object.values(map.raw)
      .map((value) => value.toString("utf8"))
      .join("\n");

    expect(result.criticalParseErrors).toBe(true);
    expect(map.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "parse-error", file: "src/broken.ts", severity: "error" }),
        expect.objectContaining({ code: "unresolved-import", file: "src/index.ts" }),
      ]),
    );
    expect(map.files.some((file) => file.path.includes(".env"))).toBe(false);
    expect(map.files.some((file) => file.path === "src/escape.ts")).toBe(false);
    expect(persistedText).not.toContain(envSecret);
    expect(persistedText).not.toContain(outsideSecret);
    expect(persistedText).not.toContain(sourceSecret);
    expect(persistedText).not.toContain(root);
    await expect(access(executionMarker)).rejects.toThrow();
    expect(await readFile(join(root, ".ai/owner-note.txt"), "utf8")).toBe("keep-owner-note\n");
    expect(await readFile(join(root, ".ai/code-map/user-note.txt"), "utf8")).toBe(
      "keep-user-note\n",
    );
    expect(await readFile(join(root, "src/index.ts"))).toEqual(sourceBefore);

    const outputNames = await readdir(resolve(root, ".ai/code-map"));
    const allowedNames = new Set([
      "config.json",
      "diagnostics.json",
      "files.jsonl",
      "manifest.json",
      "overview.md",
      "project.json",
      "relations.jsonl",
      "symbols.jsonl",
      "user-note.txt",
    ]);
    expect(outputNames).toEqual(
      expect.arrayContaining([
        "diagnostics.json",
        "files.jsonl",
        "manifest.json",
        "overview.md",
        "relations.jsonl",
        "symbols.jsonl",
        "user-note.txt",
      ]),
    );
    expect(outputNames.every((name) => allowedNames.has(name))).toBe(true);
  });
});
