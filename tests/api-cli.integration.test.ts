import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
    for (const command of ["init", "scan", "check", "show"]) {
      const result = await runCli([command, "--help"]);
      expect(result.code, `${command}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("--root");
      expect(result.stdout).toContain("--config");
      expect(result.stdout).toContain("--output");
    }
  }, 60_000);
});
