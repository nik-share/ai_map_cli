import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodeMap,
  DiagnosticRecord,
  FileRecord,
  ManifestRecord,
  ProjectRecord,
  RelationRecord,
  SymbolRecord,
} from "../src/index.js";

export type FixtureName = "typescript-node" | "react" | "next-app" | "next-pages" | "nest";

export interface PersistedMap extends Omit<CodeMap, "project"> {
  project?: ProjectRecord;
  raw: Record<string, Buffer>;
  mtimes: Record<string, bigint>;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const testsDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(testsDirectory, "..");
const fixtureDirectory = join(testsDirectory, "fixtures");
const tsxImport = createRequire(import.meta.url).resolve("tsx");

const artifactNames = [
  "overview.md",
  "manifest.json",
  "files.jsonl",
  "symbols.jsonl",
  "relations.jsonl",
  "diagnostics.json",
] as const;

export async function createFixture(name: FixtureName): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `ai-code-map-${name}-`)));
  await cp(join(fixtureDirectory, name), root, { recursive: true });
  const copiedFiles = await readdir(root, { recursive: true });
  await Promise.all(
    copiedFiles
      .filter((path) => /\.tsx?$/.test(path))
      .map(async (path) => {
        const absolutePath = join(root, path);
        const source = await readFile(absolutePath, "utf8");
        await writeFile(absolutePath, source.replace(/^\/\/ @ts-nocheck\n/, ""));
      }),
  );
  return root;
}

export async function createEmptyProject(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "ai-code-map-empty-")));
}

export async function removeProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function parseJsonLines<T>(contents: string): T[] {
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function requiredBuffer(raw: Record<string, Buffer>, name: string): Buffer {
  const value = raw[name];
  if (!value) throw new Error(`Missing required artifact ${name}`);
  return value;
}

export async function readPersistedMap(
  root: string,
  output = ".ai/code-map",
): Promise<PersistedMap> {
  const outputDirectory = resolve(root, output);
  const raw: Record<string, Buffer> = {};
  const mtimes: Record<string, bigint> = {};

  await Promise.all(
    artifactNames.map(async (name) => {
      raw[name] = await readFile(join(outputDirectory, name));
      const fileStat = await stat(join(outputDirectory, name), { bigint: true });
      mtimes[name] = fileStat.mtimeNs;
    }),
  );

  try {
    raw["project.json"] = await readFile(join(outputDirectory, "project.json"));
    const projectStat = await stat(join(outputDirectory, "project.json"), { bigint: true });
    mtimes["project.json"] = projectStat.mtimeNs;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  return {
    manifest: JSON.parse(requiredBuffer(raw, "manifest.json").toString("utf8")) as ManifestRecord,
    ...(raw["project.json"]
      ? { project: JSON.parse(raw["project.json"].toString("utf8")) as ProjectRecord }
      : {}),
    files: parseJsonLines<FileRecord>(requiredBuffer(raw, "files.jsonl").toString("utf8")),
    symbols: parseJsonLines<SymbolRecord>(requiredBuffer(raw, "symbols.jsonl").toString("utf8")),
    relations: parseJsonLines<RelationRecord>(
      requiredBuffer(raw, "relations.jsonl").toString("utf8"),
    ),
    diagnostics: JSON.parse(
      requiredBuffer(raw, "diagnostics.json").toString("utf8"),
    ) as DiagnosticRecord[],
    raw,
    mtimes,
  };
}

export function symbolNamed(map: Pick<CodeMap, "symbols">, name: string): SymbolRecord {
  const symbol = map.symbols.find((candidate) => candidate.name === name);
  if (!symbol) {
    throw new Error(
      `Expected symbol ${name}; found ${map.symbols.map((item) => item.name).join(", ")}`,
    );
  }
  return symbol;
}

export function factsText(symbol: SymbolRecord): string {
  return JSON.stringify(symbol.facts).toLowerCase();
}

export function relationExists(
  map: Pick<CodeMap, "relations">,
  type: RelationRecord["type"],
  fromFragment: string,
  toFragment: string,
): boolean {
  return map.relations.some(
    (relation) =>
      relation.type === type &&
      relation.from.toLowerCase().includes(fromFragment.toLowerCase()) &&
      relation.to.toLowerCase().includes(toFragment.toLowerCase()),
  );
}

export function runCli(arguments_: string[], cwd = repositoryRoot): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, join(repositoryRoot, "src/cli.ts"), ...arguments_],
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function parseCliJson(result: CliResult): unknown {
  try {
    return JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    throw new Error(`CLI did not emit JSON. stdout=${result.stdout}\nstderr=${result.stderr}`);
  }
}
