import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };

import {
  checkFreshness,
  createAnalyzer,
  initProject,
  loadCodeMap,
  scanProject,
  showSymbol,
} from "../src/index.js";
import {
  createEmptyProject,
  createFixture,
  parseCliJson,
  removeProject,
  runCli,
  symbolNamed,
} from "./helpers.js";

const temporaryProjects: string[] = [];

async function fixture(name: Parameters<typeof createFixture>[0]): Promise<string> {
  const root = await createFixture(name);
  temporaryProjects.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryProjects.splice(0).map(removeProject));
});

describe("programmatic API", () => {
  it("scans, loads exact symbols and relations, checks freshness, and never exits the process", async () => {
    const root = await fixture("typescript-node");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("library called process.exit");
    });

    const analyzer = createAnalyzer();
    expect(Array.isArray(analyzer.analyzers)).toBe(true);
    const scan = await scanProject({ root });
    expect(scan.counts.files).toBeGreaterThan(0);
    const unchanged = await analyzer.scan({ root });
    expect(unchanged.wrote).toBe(false);
    const map = await loadCodeMap({ root });
    const calculator = symbolNamed(map, "Calculator");
    expect(calculator.signature).toMatch(/class Calculator/);
    expect(map.relations.some((relation) => relation.to === calculator.id)).toBe(true);
    expect(showSymbol(map, "Calculator").matches.map((match) => match.symbol.id)).toContain(
      calculator.id,
    );
    expect(showSymbol(map, calculator.id).matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: calculator })]),
    );
    expect(showSymbol(map, "src/service.ts").matches.length).toBeGreaterThan(0);
    expect((await checkFreshness({ root })).status).toBe("current");
    expect(exit).not.toHaveBeenCalled();
  });

  it("initializes only missing configuration, honors force, and leaves .gitignore untouched", async () => {
    const root = await createEmptyProject();
    temporaryProjects.push(root);
    await writeFile(join(root, "package.json"), '{"name":"init-fixture","private":true}\n');
    await writeFile(join(root, ".gitignore"), "owner-rule\n");

    await initProject({ root });
    const configPath = join(root, ".ai/code-map/config.json");
    const initial = JSON.parse(await readFile(configPath, "utf8")) as { include: string[] };
    const customized = { ...initial, include: ["custom-source/**/*"] };
    await writeFile(configPath, `${JSON.stringify(customized, null, 2)}\n`);
    const customizedBytes = await readFile(configPath);

    await initProject({ root });
    expect(await readFile(configPath)).toEqual(customizedBytes);
    await initProject({ root, force: true });
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toEqual(customized);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("owner-rule\n");

    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("library called process.exit");
    });
    await writeFile(configPath, '{"version":1,"include":"not-an-array"}\n');
    await expect(scanProject({ root })).rejects.toThrow(/config|include|array/i);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("CLI observable behavior", () => {
  it("returns the whole structural map in one call and refuses missing or stale maps", async () => {
    const root = await fixture("typescript-node");
    const missing = await runCli(["map", "--root", root, "--json"]);
    expect(missing.code, missing.stderr).toBe(2);
    expect(parseCliJson(missing)).toMatchObject({ current: false, status: "missing" });
    await scanProject({ root });
    const map = await loadCodeMap({ root });
    const result = await runCli(["map", "--root", root, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const graph = parseCliJson(result) as {
      files: { id: string }[];
      symbols: { id: string }[];
      relations: { targets: { count: number }[] }[];
    };
    expect(graph.files.map((file) => file.id).sort()).toEqual(
      map.files.map((file) => file.id).sort(),
    );
    expect(graph.symbols.map((symbol) => symbol.id).sort()).toEqual(
      map.symbols.map((symbol) => symbol.id).sort(),
    );
    expect(
      graph.relations
        .flatMap((group) => group.targets)
        .reduce((sum, target) => sum + target.count, 0),
    ).toBe(map.relations.length);
    const text = await runCli(["map", "--root", root]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain("Complete structural map");
    expect(text.stdout).toContain(symbolNamed(map, "Calculator").id);
    expect(text.stdout).toContain("End of map");
    await writeFile(join(root, "src/changed.ts"), "export const changed = true;\n");
    const stale = await runCli(["map", "--root", root, "--json"]);
    expect(stale.code, stale.stderr).toBe(2);
    expect(parseCliJson(stale)).toMatchObject({ current: false, status: "stale" });
    expect(parseCliJson(stale)).not.toHaveProperty("symbols");
  });

  it("finds usable selectors, suggests typos, and supports compact/full show without changing JSON", async () => {
    const root = await fixture("typescript-node");
    await writeFile(
      join(root, "src/notifications.ts"),
      "export function markNotificationsAsViewed() {\n  notify();\n}\nexport function notify() {}\n",
    );
    await writeFile(
      join(root, "src/notifications.spec.ts"),
      'import { markNotificationsAsViewed } from "./notifications";\nmarkNotificationsAsViewed();\n',
    );
    await scanProject({ root });
    const map = await loadCodeMap({ root });
    const calculator = symbolNamed(map, "Calculator");
    const found = await runCli(["find", "calcul", "--root", root, "--limit", "1", "--json"]);
    expect(found.code, found.stderr).toBe(0);
    expect(parseCliJson(found)).toMatchObject({
      matches: [{ id: calculator.id }],
    });
    const readable = await runCli(["find", "Calculator", "--root", root]);
    expect(readable.stdout).toContain(calculator.id);
    expect(readable.stdout).toContain(`src/service.ts:${calculator.range.startLine}`);
    expect(readable.stdout).toContain("Use ai-code-map read");
    const partial = await runCli(["find", "notification mark read", "--root", root]);
    expect(partial.code, partial.stderr).toBe(0);
    expect(partial.stdout).toContain("markNotificationsAsViewed");
    expect(partial.stdout).toContain("partial; unmatched: read");
    const partialJson = await runCli(["find", "notification mark read", "--root", root, "--json"]);
    expect(parseCliJson(partialJson)).toMatchObject({
      matches: [{ name: "markNotificationsAsViewed", unmatchedTerms: ["read"] }],
    });
    const source = await runCli(["read", calculator.id, "--root", root, "--limit", "2", "--json"]);
    expect(source.code, source.stderr).toBe(0);
    expect(parseCliJson(source)).toMatchObject({
      id: calculator.id,
      file: "src/service.ts",
      truncated: true,
      nextOffset: 2,
    });
    const sourceText = await runCli(["read", calculator.id, "--root", root, "--limit", "2"]);
    expect(sourceText.stdout).toContain(`Continue: ai-code-map read '${calculator.id}' --offset 2`);
    expect(sourceText.stdout).toContain(`--root '${root}'`);
    const notification = symbolNamed(map, "markNotificationsAsViewed");
    const notificationPage = await runCli([
      "read",
      notification.id,
      "--root",
      root,
      "--limit",
      "1",
    ]);
    expect(notificationPage.code, notificationPage.stderr).toBe(0);
    expect(notificationPage.stdout).toContain("-> calls function:src/notifications.ts#notify");
    expect(notificationPage.stdout).toContain("#notify [lines 4-4; exact]");
    expect(notificationPage.stdout).toContain("src/notifications.spec.ts:2");
    expect(notificationPage.stdout).toContain("0 omitted");
    const continuation = await runCli(["read", notification.id, "--root", root, "--offset", "1"]);
    expect(continuation.code, continuation.stderr).toBe(0);
    expect(continuation.stdout).not.toContain("Map links:");
    expect(continuation.stdout).not.toContain("Test call sites:");
    const badLimit = await runCli(["read", calculator.id, "--root", root, "--limit", "201"]);
    expect(badLimit.code).toBe(1);
    const compact = await runCli(["show", calculator.id, "--root", root, "--limit", "1"]);
    expect(compact.code, compact.stderr).toBe(0);
    expect(compact.stdout).toContain("Compact view");
    expect(compact.stdout).toContain(`-${calculator.range.endLine}:${calculator.range.endColumn}`);
    const full = await runCli(["show", calculator.id, "--root", root, "--full"]);
    expect(full.code, full.stderr).toBe(0);
    expect(full.stdout).toContain("exported: true");
    const json = await runCli(["show", calculator.id, "--root", root, "--json"]);
    expect(parseCliJson(json)).toEqual(showSymbol(map, calculator.id));
    const typo = await runCli(["show", "Calculatr", "--root", root]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("Did you mean");
    expect(typo.stderr).toContain(calculator.id);
    expect(typo.stderr).not.toContain("Run ai-code-map scan");
    const missing = await runCli(["find", "zzzzzzzzzzzz", "--root", root, "--json"]);
    expect(missing.code).toBe(0);
    expect(parseCliJson(missing)).toMatchObject({ total: 0, matches: [] });
    const invalid = await runCli(["find", "Calculator", "--root", root, "--limit", "2x"]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("integer between 1 and 50");
  }, 60_000);

  it("reports the package release version", async () => {
    const result = await runCli(["--version"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("supports init, scan, show, and check from a nested directory with machine-readable output", async () => {
    const root = await fixture("typescript-node");
    const init = await runCli(["init", "--root", root]);
    expect(init.code, init.stderr).toBe(0);
    const nested = join(root, "src");
    const scan = await runCli(["scan", "--json"], nested);
    expect(scan.code, scan.stderr).toBe(0);
    expect(JSON.stringify(parseCliJson(scan))).toMatch(/files|symbols/);

    const show = await runCli(["show", "Calculator", "--root", root, "--json"]);
    expect(show.code, show.stderr).toBe(0);
    const shown = JSON.stringify(parseCliJson(show));
    expect(shown).toContain("Calculator");
    expect(shown).toContain("src/service.ts");
    expect(shown).toMatch(/signature|relations|references/i);

    const check = await runCli(["check", "--root", root, "--json"]);
    expect(check.code, check.stderr).toBe(0);
    expect(JSON.stringify(parseCliJson(check))).toMatch(/current/);
  }, 60_000);

  it("maps current, stale, strict parse, and invalid-configuration outcomes to documented exit codes", async () => {
    const root = await fixture("typescript-node");
    expect((await runCli(["scan", "--root", root])).code).toBe(0);
    expect((await runCli(["check", "--root", root])).code).toBe(0);

    await writeFile(join(root, "src/stale.ts"), "export const staleAddition = true;\n");
    const stale = await runCli(["check", "--root", root]);
    expect(stale.code).toBe(2);
    expect(`${stale.stdout}\n${stale.stderr}`).toMatch(/stale|added/i);

    const missingSymbol = await runCli(["show", "NoSuchSymbol", "--root", root]);
    expect(missingSymbol.code).toBe(1);
    expect(`${missingSymbol.stdout}\n${missingSymbol.stderr}`).toMatch(/not found|no .*match/i);

    await writeFile(join(root, "src/broken.ts"), "export function broken( {\n");
    const strict = await runCli(["scan", "--strict", "--root", root]);
    expect(strict.code).toBe(3);
    expect(`${strict.stdout}\n${strict.stderr}`).toMatch(/diagnostic/i);

    const invalidRoot = await createEmptyProject();
    temporaryProjects.push(invalidRoot);
    await writeFile(join(invalidRoot, "package.json"), '{"name":"invalid-config"}\n');
    await mkdir(join(invalidRoot, ".ai/code-map"), { recursive: true });
    await writeFile(
      join(invalidRoot, ".ai/code-map/config.json"),
      '{"version":1,"include":"src"}\n',
    );
    const invalid = await runCli(["scan", "--root", invalidRoot]);
    expect(invalid.code).toBe(1);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toMatch(/config|include|array/i);
    expect(`${invalid.stdout}\n${invalid.stderr}`).not.toMatch(/\n\s+at .*\(/);
  }, 60_000);

  it("provides help for every public command", async () => {
    for (const command of ["init", "scan", "check", "show", "find", "read", "map"]) {
      const result = await runCli([command, "--help"]);
      expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("--root");
      expect(result.stdout).toContain("--config");
      expect(result.stdout).toContain("--output");
    }
  }, 60_000);
});
