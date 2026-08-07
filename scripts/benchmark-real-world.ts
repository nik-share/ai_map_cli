#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(os.tmpdir(), "ai-code-map-real-world-benchmark");
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "benchmarks", "real-world", "projects.json");
const DEFAULT_REPEATS = 3;
const MIN_REPEATS = 3;

const MANAGED_ARTIFACTS = [
  "overview.md",
  "manifest.json",
  "project.json",
  "files.jsonl",
  "symbols.jsonl",
  "relations.jsonl",
  "diagnostics.json",
] as const;

const RESOURCE_GATES_MIB: Record<string, number> = {
  "shade-factory": 1246,
  alpha: 1246,
  "crm-back": 1443,
  "crm-front": 972,
};

const FRESH_CONTEXTS = [
  { key: "target", label: "target-cwd", outputSuffix: "scan-output-target-cwd" },
  { key: "scanner", label: "scanner-cwd", outputSuffix: "scan-output-scanner-cwd" },
  { key: "temp", label: "temp-cwd", outputSuffix: "scan-output-temp-cwd" },
] as const;

interface CommandOptions {
  projects: Array<{ name: string; path: string }>;
  repeats: number;
  outputRoot: string;
  configPath: string;
  dryRun: boolean;
}

interface CLIProjectConfig {
  name: string;
  defaultPath: string | null;
  metrics?: {
    files: number;
    symbols: number;
    relations: number;
    diagnostics: number;
    freshMs: number;
    warmMs: number;
    peakRssMiB: number;
    exactRelations?: number;
    frameworkRelations?: number;
    heuristicRelations?: number;
    derivedRelations?: number;
  };
}

interface ProjectsConfigFile {
  schemaVersion: number;
  lastUpdated: string;
  projects: CLIProjectConfig[];
}

interface RepoState {
  root: string;
  commit: string;
  status: string;
  statusLineCount: number;
  statusHash: string;
  diffHash: string;
}

interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
}

interface CommandRun {
  invoked: CommandInvocation;
  command: string;
  elapsedMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  rssBytes?: number;
  rssMethod?: "darwin-time-l" | "linux-time-v";
  rssReason?: string;
}

interface ScanResult {
  wrote: boolean;
  changes: {
    added: string[];
    modified: string[];
    deleted: string[];
    moved: Array<{ from: string; to: string }>;
  };
  elapsedMs: number;
  counts: {
    files: number;
    symbols: number;
    relations: number;
    diagnostics: number;
  };
  outputDir: string;
}

interface CheckResult {
  status: string;
  current: boolean;
  reasons: string[];
  changes: {
    added: string[];
    modified: string[];
    deleted: string[];
    moved: Array<{ from: string; to: string }>;
  };
}

interface LoadResult {
  elapsedMs: number;
  counts: ScanResult["counts"];
}

interface ArtifactRecord {
  path: string;
  bytes: number;
  sha256: string;
}

interface RelationGrouping {
  kind: string;
  resolution: "resolved" | "unresolved";
  classification: string;
  target: "internal" | "external";
  count: number;
}

interface RelationSample {
  kind: string;
  resolution: "resolved" | "unresolved";
  classification: string;
  target: "internal" | "external";
  confidence: number;
  from: string;
  to: string;
  file: string;
  line: number;
  explanation: string;
}

interface RelationCompactnessMetrics {
  exactInternal: number;
  exactExternal: number;
  falseLocalModuleAttributedExternal: number;
  unresolvedHeuristic: number;
  inverseDerivedFromUnresolvedEndpoint: number;
}

interface CompilerUnitOwnership {
  id: string;
  kind: string;
  root: string;
  config: string | null;
  fileCount: number;
}

interface PackageSourceArtifact {
  manifestBytes: number;
  semanticInputCount: number;
}

interface RunRange {
  min: number;
  max: number;
  median: number;
  count: number;
}

interface ScanTimingSummary {
  wallMs: RunRange;
  internalMs: RunRange;
  rssMiB?: RunRange;
}

interface ScannerRun {
  label: string;
  context: string;
  cwd: string;
  outputDir: string;
  command: CommandRun;
  scan: ScanResult;
  artifacts: ArtifactRecord[];
}

interface ResourceGateResult {
  project: string;
  thresholdMiB?: number;
  status: "pass" | "fail" | "not-measured";
  observedPeakMiB?: number;
  reason?: string;
}

interface TargetBenchmarkResult {
  name: string;
  path: string;
  resolvedPath: string;
  preState: RepoState;
  postState?: RepoState;
  freshScans: ScannerRun[];
  freshScan?: {
    command: CommandRun;
    parser: ScanResult;
    artifacts: ArtifactRecord[];
    relationGroups: RelationGrouping[];
    relationSamples: RelationSample[];
    compilerUnits: CompilerUnitOwnership[];
    manifest: PackageSourceArtifact;
  };
  freshStats: ScanTimingSummary;
  warmScans: Array<{ command: CommandRun; scan: ScanResult }>;
  warmStats: ScanTimingSummary;
  warmArtifactsMatch: boolean;
  load?: { command: CommandRun; result: LoadResult };
  check?: { command: CommandRun; result: CheckResult };
  baseline?: CLIProjectConfig["metrics"];
  compactness?: RelationCompactnessMetrics;
  resourceGate: ResourceGateResult;
  success: boolean;
  error?: string;
}

interface TimeSupport {
  supported: boolean;
  command?: string;
  args?: string[];
  reason?: string;
}

interface PackagedScanner {
  packageRoot: string;
  cliPath: string;
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
  command: string;
  preparationCommands: CommandRun[];
  dependencyMode: "pnpm-offline-install" | "isolated-local-dependency-copy";
}

interface ScannerSnapshot {
  status: "captured" | "provisional";
  path: string;
  bytes: number;
  sha256: string;
  reason?: string;
}

interface BenchmarkSummary {
  schemaVersion: "rw-benchmark-v1";
  generatedAt: string;
  runDirectory: string;
  defaults: {
    repeats: number;
    outputRoot: string;
    configPath: string;
  };
  scanner: {
    root: string;
    node: string;
    pnpm: string;
    platform: {
      os: string;
      release: string;
      arch: string;
    };
    commit: string;
    preState: RepoState;
    postState: RepoState;
    command: string;
    package: PackagedScanner;
    snapshot: ScannerSnapshot;
  };
  timeCommandSupport: TimeSupport;
  projects: TargetBenchmarkResult[];
  overallSuccess: boolean;
  notes: string[];
}

const USAGE = `
Usage: pnpm benchmark:real-world --project <name=path> --project <name=path> --project <name=path> [options]

Options:
  --project <name=path>    Repeatable override for one target.
  --repeats <n>            Warm unchanged scan repetitions (default/minimum ${DEFAULT_REPEATS})
  --output <path>          Base output directory for raw results.
  --projects-config <path>  Path to project/baseline config.
                            Default: ${path.relative(REPO_ROOT, DEFAULT_CONFIG_PATH)}
  --dry-run                 Parse inputs and emit expected project resolutions only.
  --help                    Show this message.
`;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function runElapsedRange(values: number[]): RunRange {
  if (values.length === 0) {
    return { min: 0, max: 0, median: 0, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midValue = sorted[mid];
  if (typeof midValue !== "number") throw new Error("Invalid scan timing sample set.");
  const min = sorted[0];
  const max = sorted.at(-1);
  if (typeof min !== "number" || typeof max !== "number") {
    throw new Error("Invalid scan timing bounds.");
  }
  const median =
    sorted.length % 2 === 1 ? midValue : ((sorted[mid - 1] ?? midValue) + midValue) / 2;
  return {
    min,
    max,
    median,
    count: sorted.length,
  };
}

function summarizeScans(runs: Array<{ command: CommandRun; scan: ScanResult }>): ScanTimingSummary {
  const wall = runElapsedRange(runs.map((run) => run.command.elapsedMs));
  const internal = runElapsedRange(runs.map((run) => run.scan.elapsedMs));
  const rssValues = runs
    .map((run) => run.command.rssBytes)
    .filter((value): value is number => typeof value === "number");
  const rssMiB =
    rssValues.length > 0
      ? runElapsedRange(rssValues.map((value) => value / (1024 * 1024)))
      : undefined;

  return { wallMs: wall, internalMs: internal, ...(rssMiB ? { rssMiB } : {}) };
}

function computeBytes(bytes: number): string {
  return `${bytes} B`;
}

function computeMiB(bytes?: number): string {
  if (typeof bytes !== "number") return "n/a";
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatMiB(value?: number): string {
  return typeof value === "number" ? `${value.toFixed(2)} MiB` : "n/a";
}

function resolveResourceGate(projectName: string): number | undefined {
  const key = projectName.toLowerCase();
  if (key in RESOURCE_GATES_MIB) return RESOURCE_GATES_MIB[key];
  if (key.includes("shade")) return RESOURCE_GATES_MIB["shade-factory"];
  return undefined;
}

function resourceGateResult(
  projectName: string,
  freshScans: ScannerRun[],
  warmScans: Array<{ command: CommandRun; scan: ScanResult }>,
): ResourceGateResult {
  const thresholdMiB = resolveResourceGate(projectName);
  const freshRss = freshScans
    .map((run) => run.command.rssBytes)
    .filter((value): value is number => typeof value === "number")
    .map((value) => value / (1024 * 1024));
  const warmRss = warmScans
    .map((run) => run.command.rssBytes)
    .filter((value): value is number => typeof value === "number")
    .map((value) => value / (1024 * 1024));
  const allRss = [...freshRss, ...warmRss];
  const observedPeakMiB = allRss.length > 0 ? Math.max(...allRss) : undefined;

  if (thresholdMiB === undefined) {
    return {
      project: projectName,
      status: allRss.length > 0 ? "pass" : "not-measured",
      observedPeakMiB,
      reason: allRss.length > 0 ? undefined : "no RSS samples captured on this platform/runner",
    };
  }

  if (observedPeakMiB === undefined) {
    return {
      project: projectName,
      thresholdMiB,
      status: "not-measured",
      reason: "no RSS samples captured on this platform/runner",
    };
  }

  return {
    project: projectName,
    thresholdMiB,
    status: observedPeakMiB <= thresholdMiB ? "pass" : "fail",
    observedPeakMiB,
  };
}

function compareArtifactSets(a: ArtifactRecord[], b: ArtifactRecord[]): void {
  const byNameA = new Map(a.map((artifact) => [path.basename(artifact.path), artifact]));
  const byNameB = new Map(b.map((artifact) => [path.basename(artifact.path), artifact]));
  const names = [...new Set([...byNameA.keys(), ...byNameB.keys()])];
  for (const name of names) {
    const left = byNameA.get(name);
    const right = byNameB.get(name);
    if (!left || !right) {
      throw new Error(`artifact set mismatch: missing ${name} in one or more fresh runs`);
    }
    if (left.bytes !== right.bytes || left.sha256 !== right.sha256) {
      throw new Error(
        `artifact mismatch for ${name}: (${left.bytes}B/${left.sha256}) != (${right.bytes}B/${right.sha256})`,
      );
    }
  }
}

function showUsageAndExit(code = 0): void {
  process.stdout.write(`${USAGE.trim()}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): CommandOptions {
  const options: CommandOptions = {
    projects: [],
    repeats: DEFAULT_REPEATS,
    outputRoot: DEFAULT_OUTPUT_DIR,
    configPath: DEFAULT_CONFIG_PATH,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg || !arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    if (arg === "--help" || arg === "-h") showUsageAndExit(0);

    if (arg === "--project") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--project requires name=path");
      index += 1;
      const divider = raw.indexOf("=");
      if (divider <= 0) throw new Error(`Invalid --project format "${raw}"`);
      const name = raw.slice(0, divider).trim();
      const projectPath = raw.slice(divider + 1).trim();
      if (!name || !projectPath) throw new Error(`Invalid --project format "${raw}"`);
      options.projects.push({ name, path: projectPath });
      continue;
    }

    if (arg === "--repeats") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--repeats requires an integer");
      index += 1;
      const repeats = Number.parseInt(raw, 10);
      if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) {
        throw new Error(`--repeats must be an integer >= ${MIN_REPEATS}`);
      }
      options.repeats = repeats;
      continue;
    }

    if (arg === "--output") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--output requires a directory path");
      index += 1;
      options.outputRoot = raw;
      continue;
    }

    if (arg === "--projects-config") {
      const raw = argv[index + 1];
      if (!raw) throw new Error("--projects-config requires a path");
      index += 1;
      options.configPath = raw;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function quoted(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(invocation: CommandInvocation): Promise<CommandRun> {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string | Buffer) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: string | Buffer) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        invoked: invocation,
        command: `${quoted(invocation.command)} ${invocation.args.map(quoted).join(" ")}`.trim(),
        elapsedMs: Math.round(performance.now() - started),
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

interface ScannerRunner {
  packageRoot: string;
  cliPath: string;
}

function buildScannerRun(scanner: ScannerRunner, args: string[], cwd: string): CommandInvocation {
  return { command: "node", args: [scanner.cliPath, ...args], cwd };
}

async function runPackagedLoad(
  scanner: ScannerRunner,
  root: string,
  outputDir: string,
  cwd: string,
): Promise<{ command: CommandRun; result: LoadResult }> {
  const program = [
    'const { pathToFileURL } = await import("node:url");',
    "const api = await import(pathToFileURL(process.argv[1]).href);",
    "const started = performance.now();",
    "const map = await api.loadCodeMap({ root: process.argv[2], output: process.argv[3] });",
    "const elapsedMs = performance.now() - started;",
    "process.stdout.write(JSON.stringify({ elapsedMs, counts: map.project.counts }));",
  ].join(" ");
  const command = await runCommand({
    command: "node",
    args: [
      "--input-type=module",
      "--eval",
      program,
      path.join(scanner.packageRoot, "dist", "index.js"),
      root,
      outputDir,
    ],
    cwd,
  });
  if (command.exitCode !== 0) throw new Error(`packaged loadCodeMap failed: ${command.stderr}`);
  return {
    command,
    result: parseJsonFromOutput(command.stdout, "packaged loadCodeMap") as LoadResult,
  };
}

async function runScannerCommand(
  scanner: ScannerRunner,
  args: string[],
  cwd: string,
  measureMemory: boolean,
  timeSupport: TimeSupport,
): Promise<CommandRun> {
  const base = buildScannerRun(scanner, args, cwd);

  if (measureMemory && timeSupport.supported && timeSupport.command && timeSupport.args) {
    const wrapped: CommandInvocation = {
      command: timeSupport.command,
      args: [...timeSupport.args, base.command, ...base.args],
      cwd: base.cwd,
    };
    const result = await runCommand(wrapped);
    const method = isMac() ? "darwin-time-l" : "linux-time-v";
    const rssBytes = extractPeakRssBytes(result.stderr, method);
    return {
      ...result,
      rssMethod: method,
      rssBytes,
      rssReason:
        rssBytes === undefined ? "Could not parse max RSS from /usr/bin/time output" : undefined,
    };
  }

  const result = await runCommand(base);
  if (measureMemory && !timeSupport.supported) {
    return {
      ...result,
      rssReason:
        timeSupport.reason ??
        "Not captured (platform does not support isolated RSS measurement via /usr/bin/time)",
    };
  }

  return result;
}

function parseJsonFromOutput(raw: string, label: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`No output while parsing ${label}`);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidates = [trimmed, start >= 0 && end >= start ? trimmed.slice(start, end + 1) : ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next bounded candidate.
    }
  }
  throw new Error(`Could not parse JSON for ${label}`);
}

async function runGitCommand(root: string, args: string[]): Promise<string> {
  const result = await runCommand({ command: "git", args, cwd: root });
  if (result.exitCode !== 0) {
    throw new Error(`git command failed (${args.join(" ")}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function parseGitDiffHash(diff: string): string {
  return sha256Text(diff);
}

async function getRepoState(root: string): Promise<RepoState> {
  const commit = await runGitCommand(root, ["rev-parse", "HEAD"]);
  const status = (await runGitCommand(root, ["status", "--short"])).trim();
  const diff = await runGitCommand(root, ["diff", "--binary", "HEAD"]);
  const untracked = await runGitCommand(root, ["ls-files", "--others", "--exclude-standard"]);
  const untrackedHash = createHash("sha256");
  for (const relative of untracked.split(/\r?\n/).filter(Boolean).sort()) {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    untrackedHash.update(relative);
    untrackedHash.update("\0");
    untrackedHash.update(await fs.readFile(absolute));
    untrackedHash.update("\0");
  }

  return {
    root,
    commit: commit || "(no-commit)",
    status,
    statusLineCount: status
      ? status.split(/\r?\n/).filter((line) => line.trim().length > 0).length
      : 0,
    statusHash: sha256Text(status),
    diffHash: parseGitDiffHash(`${diff}\0${untrackedHash.digest("hex")}`),
  };
}

function isMac(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function extractPeakRssBytes(
  stderr: string,
  mode: "darwin-time-l" | "linux-time-v",
): number | undefined {
  const lines = stderr.split(/\r?\n/);
  const line =
    mode === "darwin-time-l"
      ? lines.find((entry) => /maximum resident set size/i.test(entry))
      : lines.find((entry) => /Maximum resident set size/i.test(entry));
  if (!line) return undefined;
  const match =
    mode === "darwin-time-l"
      ? line.match(/^\s*([0-9][0-9,]*)\s+maximum resident set size/i)
      : line.match(/:\s*([0-9][0-9,]*)\s*$/);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1].replace(/,/g, ""), 10);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return mode === "darwin-time-l" ? value : value * 1024;
}

async function getTimeCommandSupport(): Promise<TimeSupport> {
  if (!(isMac() || isLinux())) {
    return { supported: false, reason: `unsupported platform ${process.platform}` };
  }

  try {
    await fs.access("/usr/bin/time");
  } catch {
    return { supported: false, reason: "/usr/bin/time not available" };
  }

  return {
    supported: true,
    command: "/usr/bin/time",
    args: isMac() ? ["-l"] : ["-v"],
  };
}

async function ensureDirectory(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function parseJsonlLines(filePath: string, onLine: (value: unknown) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream });

    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        onLine(JSON.parse(trimmed) as unknown);
      } catch {
        reject(new Error(`Could not parse JSON line in ${filePath}`));
      }
    });

    reader.on("close", () => {
      resolve();
    });

    reader.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function gatherArtifacts(outputDir: string): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = [];
  for (const artifact of MANAGED_ARTIFACTS) {
    const absolute = path.join(outputDir, artifact);
    const raw = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    records.push({ path: absolute, bytes: stat.size, sha256: sha256Buffer(raw) });
  }
  return records;
}

interface RelationInput {
  type: string;
  confidence: number;
  from: string;
  to: string;
  origin: { file: string; line: number; explanation: string; classification: string };
}

interface ImportRecordSnapshot {
  source: string;
  external: boolean;
}

interface FileSnapshot {
  id: string;
  path: string;
  imports: ImportRecordSnapshot[];
}

export interface RelationClassification {
  target: "internal" | "external";
  classification: string;
  resolution: "resolved" | "unresolved";
  inverseFromUnresolved: boolean;
}

export function classifyRelationForBenchmark(relation: RelationInput): RelationClassification {
  const target = relation.to.startsWith("external:") ? "external" : "internal";
  const unresolvedEndpoint =
    relation.from.startsWith("external:unresolved#") ||
    relation.to.startsWith("external:unresolved#") ||
    /\bunresolved\b/i.test(relation.origin.explanation);
  const inverseFromUnresolved =
    relation.origin.classification === "derived" &&
    relation.origin.explanation.startsWith("inverse of ") &&
    unresolvedEndpoint;
  const resolution =
    relation.origin.classification === "heuristic" || unresolvedEndpoint || inverseFromUnresolved
      ? "unresolved"
      : "resolved";
  return {
    target,
    classification: relation.origin.classification,
    resolution,
    inverseFromUnresolved,
  };
}

async function gatherRelationStats(
  relationsFile: string,
  filesFile: string,
): Promise<{
  groups: RelationGrouping[];
  samples: RelationSample[];
  compactness: RelationCompactnessMetrics;
}> {
  const grouped = new Map<string, RelationGrouping>();
  const sampleBuckets = new Map<string, RelationSample[]>();
  let exactInternal = 0;
  let exactExternal = 0;
  let falseLocalModuleAttributedExternal = 0;
  let unresolvedHeuristic = 0;
  let inverseUnresolved = 0;

  const localImportModulesByFile = new Map<string, Set<string>>();
  await parseJsonlLines(filesFile, (value) => {
    const file = value as FileSnapshot;
    for (const importRecord of file.imports) {
      if (importRecord.external) continue;
      const modules = localImportModulesByFile.get(file.path) ?? new Set<string>();
      modules.add(importRecord.source);
      localImportModulesByFile.set(file.path, modules);
    }
  });

  await parseJsonlLines(relationsFile, (value) => {
    const relation = value as RelationInput;
    const classification = classifyRelationForBenchmark(relation);
    const key = `${relation.type}|${classification.resolution}|${classification.classification}|${classification.target}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, {
        kind: relation.type,
        resolution: classification.resolution,
        classification: classification.classification,
        target: classification.target,
        count: 1,
      });
    }

    if (classification.target === "internal" && classification.classification === "exact") {
      exactInternal += 1;
    }
    if (classification.target === "external" && classification.classification === "exact") {
      exactExternal += 1;
    }
    if (
      classification.classification === "heuristic" &&
      classification.resolution === "unresolved"
    ) {
      unresolvedHeuristic += 1;
    }
    if (classification.inverseFromUnresolved) {
      inverseUnresolved += 1;
    }
    const separator = relation.to.lastIndexOf("#");
    const externalModule = relation.to.startsWith("external:")
      ? relation.to.slice(
          "external:".length,
          separator > "external:".length ? separator : undefined,
        )
      : undefined;
    if (
      classification.target === "external" &&
      classification.classification === "exact" &&
      externalModule !== undefined &&
      localImportModulesByFile.get(relation.origin.file)?.has(externalModule)
    ) {
      falseLocalModuleAttributedExternal += 1;
    }

    const existingSamples = sampleBuckets.get(relation.type) ?? [];
    if (existingSamples.length < 2) {
      sampleBuckets.set(relation.type, [
        ...existingSamples,
        {
          kind: relation.type,
          resolution: classification.resolution,
          target: classification.target,
          classification: classification.classification,
          confidence: relation.confidence,
          from: relation.from,
          to: relation.to,
          file: relation.origin.file,
          line: relation.origin.line,
          explanation: relation.origin.explanation,
        },
      ]);
    }
  });

  return {
    groups: Array.from(grouped.values()).sort(
      (a, b) =>
        b.count - a.count ||
        compareText(a.kind, b.kind) ||
        compareText(a.target, b.target) ||
        compareText(a.resolution, b.resolution) ||
        compareText(a.classification, b.classification),
    ),
    samples: Array.from(sampleBuckets.values())
      .flatMap((relations) => relations)
      .sort(
        (a, b) =>
          compareText(a.kind, b.kind) ||
          compareText(a.classification, b.classification) ||
          compareText(a.target, b.target) ||
          compareText(a.file, b.file) ||
          a.line - b.line ||
          a.resolution.localeCompare(b.resolution) ||
          a.confidence - b.confidence,
      ),
    compactness: {
      exactInternal,
      exactExternal,
      falseLocalModuleAttributedExternal,
      unresolvedHeuristic,
      inverseDerivedFromUnresolvedEndpoint: inverseUnresolved,
    },
  };
}

async function gatherCompilerUnits(outputDir: string): Promise<CompilerUnitOwnership[]> {
  const projectRaw = await fs.readFile(path.join(outputDir, "project.json"), "utf8");
  const projectRecord = JSON.parse(projectRaw) as {
    compilerUnits: Array<{ id: string; kind: string; root: string; config?: string }>;
  };
  const ownership = new Map<string, number>();
  await parseJsonlLines(path.join(outputDir, "files.jsonl"), (value) => {
    const entry = value as { compilerUnit: string };
    ownership.set(entry.compilerUnit, (ownership.get(entry.compilerUnit) ?? 0) + 1);
  });

  return projectRecord.compilerUnits
    .map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      root: unit.root,
      config: unit.config ?? null,
      fileCount: ownership.get(unit.id) ?? 0,
    }))
    .sort((a, b) => compareText(a.id, b.id));
}

async function gatherManifestInfo(outputDir: string): Promise<PackageSourceArtifact> {
  const manifestPath = path.join(outputDir, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as { semanticInputs?: unknown[] };
  return {
    manifestBytes: raw.length,
    semanticInputCount: Array.isArray(manifest.semanticInputs) ? manifest.semanticInputs.length : 0,
  };
}

function requireSameArtifactState(before: RepoState, after: RepoState): void {
  if (before.commit !== after.commit) {
    throw new Error(`Target commit changed from ${before.commit} to ${after.commit}`);
  }
  if (before.statusHash !== after.statusHash || before.diffHash !== after.diffHash) {
    throw new Error(`Target mutating after run:\nBEFORE=${before.status}\nAFTER=${after.status}`);
  }
}

function parsePackTarballPathFromStdout(stdout: string, packRoot: string): string {
  const match = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith(".tgz") && line.includes("-"));
  if (match) {
    if (path.isAbsolute(match)) return match;
    return path.join(packRoot, match);
  }
  return "";
}

async function preparePackagedScanner(runDirectory: string): Promise<PackagedScanner> {
  const buildCommand = await runCommand({
    command: "pnpm",
    args: ["run", "build"],
    cwd: REPO_ROOT,
  });
  if (buildCommand.exitCode !== 0) {
    throw new Error(`build failed:\n${buildCommand.stderr || buildCommand.stdout}`);
  }

  const packRoot = await fs.mkdtemp(path.join(runDirectory, "package-tar-"));
  const packCommand = await runCommand({
    command: "pnpm",
    args: ["pack", "--pack-destination", packRoot],
    cwd: REPO_ROOT,
  });
  if (packCommand.exitCode !== 0) {
    throw new Error(`pnpm pack failed:\n${packCommand.stderr || packCommand.stdout}`);
  }

  const declaredPath = parsePackTarballPathFromStdout(packCommand.stdout, packRoot);
  let tarballPath = declaredPath || "";
  if (!tarballPath || !(await pathExists(tarballPath))) {
    const candidates = await fs.readdir(packRoot);
    const tgz = candidates
      .filter((candidate) => candidate.endsWith(".tgz"))
      .sort()
      .at(-1);
    if (!tgz) {
      throw new Error(`pnpm pack produced no tarball in ${packRoot}`);
    }
    tarballPath = path.join(packRoot, tgz);
  }

  const tarball = await fs.readFile(tarballPath);
  const tarballBytes = tarball.length;
  const tarballSha256 = sha256Buffer(tarball);

  const extractRoot = await fs.mkdtemp(path.join(runDirectory, "scanner-package-"));
  const extractCommand = await runCommand({
    command: "tar",
    args: ["-xzf", tarballPath, "-C", extractRoot],
    cwd: runDirectory,
  });
  if (extractCommand.exitCode !== 0) {
    throw new Error(`extract package failed:\n${extractCommand.stderr || extractCommand.stdout}`);
  }

  const extractedCandidates = await fs.readdir(extractRoot, { withFileTypes: true });
  const extractedPackageDir = extractedCandidates.find(
    (entry) => entry.isDirectory() && entry.name !== ".",
  );
  if (!extractedPackageDir) {
    throw new Error(`pack extraction produced no directory in ${extractRoot}`);
  }
  const packageRoot = path.join(extractRoot, extractedPackageDir.name);
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  try {
    await fs.access(cliPath);
  } catch {
    throw new Error(`packaged CLI missing at ${cliPath}`);
  }

  const installCommand = await runCommand({
    command: "pnpm",
    args: [
      "install",
      "--offline",
      "--prod",
      "--ignore-scripts",
      "--store-dir",
      path.join(REPO_ROOT, ".pnpm-store"),
    ],
    cwd: packageRoot,
  });
  const preparationCommands = [buildCommand, packCommand, extractCommand, installCommand];
  let dependencyMode: PackagedScanner["dependencyMode"] = "pnpm-offline-install";
  if (installCommand.exitCode !== 0) {
    const nodeModulesTarget = path.join(packageRoot, "node_modules");
    await fs.rm(nodeModulesTarget, { force: true, recursive: true });
    const copyCommand = await runCommand({
      command: "cp",
      args: ["-R", path.join(REPO_ROOT, "node_modules"), nodeModulesTarget],
      cwd: packageRoot,
    });
    preparationCommands.push(copyCommand);
    if (copyCommand.exitCode !== 0) {
      throw new Error(
        `offline production dependency install and isolated local dependency copy failed:\n${installCommand.stderr || installCommand.stdout}\n${copyCommand.stderr || copyCommand.stdout}`,
      );
    }
    dependencyMode = "isolated-local-dependency-copy";
  }

  const command = `${quoted("node")} ${quoted(cliPath)}`;

  return {
    packageRoot,
    cliPath,
    tarballPath,
    tarballSha256,
    tarballBytes,
    command,
    preparationCommands,
    dependencyMode,
  };
}

async function snapshotFileTree(root: string, destination: string): Promise<void> {
  const tracked = await runCommand({ command: "git", args: ["ls-files"], cwd: root });
  const untracked = await runCommand({
    command: "git",
    args: ["ls-files", "--others", "--exclude-standard"],
    cwd: root,
  });
  const paths = [
    ...tracked.stdout.split(/\r?\n/).filter(Boolean),
    ...untracked.stdout.split(/\r?\n/).filter(Boolean),
  ];
  await fs.mkdir(destination, { recursive: true });

  for (const entry of paths) {
    const source = path.join(root, entry);
    const target = path.join(destination, entry);
    const stat = await fs.lstat(source);
    if (!stat.isFile()) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function createScannerSnapshot(runDirectory: string): Promise<ScannerSnapshot> {
  const snapshotRoot = path.join(runDirectory, "scanner-source-snapshot");
  const snapshotTar = `${snapshotRoot}.tar`;
  try {
    const treeRoot = path.join(runDirectory, "scanner-source-tree");
    await fs.rm(treeRoot, { force: true, recursive: true });
    await snapshotFileTree(REPO_ROOT, treeRoot);
    const tarCommand = await runCommand({
      command: "tar",
      args: ["-cf", snapshotTar, "-C", treeRoot, "."],
      cwd: runDirectory,
    });
    if (tarCommand.exitCode !== 0) {
      throw new Error(`snapshot tar failed: ${tarCommand.stderr || tarCommand.stdout}`);
    }
    await fs.rm(treeRoot, { force: true, recursive: true });
    const snapshotStat = await fs.stat(snapshotTar);
    const snapshotSha = sha256Buffer(await fs.readFile(snapshotTar));
    return {
      status: "captured",
      path: snapshotTar,
      bytes: snapshotStat.size,
      sha256: snapshotSha,
    };
  } catch (error) {
    return {
      status: "provisional",
      path: `${snapshotRoot}.manifest`,
      bytes: 0,
      sha256: "",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeScannerSnapshotManifest(snapshot: ScannerSnapshot): Promise<void> {
  if (snapshot.status === "provisional" && snapshot.reason) {
    await fs.writeFile(
      `${snapshot.path}.txt`,
      `provisional snapshot: ${snapshot.reason}\n`,
      "utf8",
    );
  }
}

function buildMarkdown(summary: BenchmarkSummary): string {
  const lines: string[] = [];
  lines.push(`# Real-world benchmark report`);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Run directory: ${summary.runDirectory}`);
  lines.push(`Scanner commit: ${summary.scanner.commit}`);
  lines.push(`Scanner snapshot: ${summary.scanner.snapshot.status}`);
  lines.push(`Package tarball: ${summary.scanner.package.tarballPath}`);
  lines.push(`Tarball checksum: ${summary.scanner.package.tarballSha256}`);
  lines.push(`Scanner command: ${summary.scanner.package.command}`);
  lines.push(`Scanner package root: ${summary.scanner.package.packageRoot}`);
  lines.push(`Dependency preparation: ${summary.scanner.package.dependencyMode}`);
  lines.push("Package preparation commands:");
  for (const command of summary.scanner.package.preparationCommands) {
    lines.push(`- cwd=${command.invoked.cwd}: ${command.command}`);
  }
  lines.push(
    `Target config: repeats=${summary.defaults.repeats}, output=${summary.defaults.outputRoot}`,
  );
  lines.push(
    `Environment: node ${summary.scanner.node}, pnpm ${summary.scanner.pnpm}, ${summary.scanner.platform.os} ${summary.scanner.platform.release} ${summary.scanner.platform.arch}`,
  );
  lines.push(
    `Scanner status hash: ${summary.scanner.preState.statusHash}, diff hash: ${summary.scanner.preState.diffHash}`,
  );
  lines.push(
    `Scanner post hash: ${summary.scanner.postState.statusHash}, diff hash: ${summary.scanner.postState.diffHash}`,
  );
  if (summary.scanner.snapshot.status === "provisional") {
    lines.push(`Scanner snapshot provisional: ${summary.scanner.snapshot.reason}`);
  }
  if (summary.timeCommandSupport.supported) {
    lines.push(
      `RSS command: ${summary.timeCommandSupport.command} ${summary.timeCommandSupport.args?.join(" ")}`,
    );
  } else {
    lines.push(`RSS command: unsupported (${summary.timeCommandSupport.reason ?? "n/a"})`);
  }
  if (summary.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of summary.notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push("");

  for (const target of summary.projects) {
    lines.push(`## ${target.name}`);
    lines.push(`path: ${target.resolvedPath}`);
    lines.push(`clean before: ${target.preState.statusLineCount === 0 ? "yes" : "no"}`);
    if (target.postState) {
      lines.push(`clean after: ${target.postState.statusLineCount === 0 ? "yes" : "no"}`);
      lines.push(
        `status hash: ${target.postState.statusHash}, diff hash: ${target.postState.diffHash}`,
      );
    }
    lines.push(`resource gate: ${target.resourceGate.status}`);
    if (target.resourceGate.thresholdMiB) {
      lines.push(
        `peak RSS: ${formatMiB(target.resourceGate.observedPeakMiB)}, threshold: ${target.resourceGate.thresholdMiB} MiB`,
      );
    } else if (target.resourceGate.observedPeakMiB !== undefined) {
      lines.push(`peak RSS: ${formatMiB(target.resourceGate.observedPeakMiB)}`);
    } else {
      lines.push("peak RSS: n/a");
    }

    if (target.freshScans.length > 0) {
      lines.push(
        `fresh scans (run matrix): wall median/min-max ${target.freshStats.wallMs.median}ms (${target.freshStats.wallMs.min} — ${target.freshStats.wallMs.max}) / internal median/min-max ${target.freshStats.internalMs.median}ms (${target.freshStats.internalMs.min} — ${target.freshStats.internalMs.max})`,
      );
      lines.push(
        `warm scans: wall median/min-max ${target.warmStats.wallMs.median}ms (${target.warmStats.wallMs.min} — ${target.warmStats.wallMs.max}) / internal median/min-max ${target.warmStats.internalMs.median}ms (${target.warmStats.internalMs.min} — ${target.warmStats.internalMs.max})`,
      );
      lines.push("Fresh run contexts:");
      for (const run of target.freshScans) {
        lines.push(
          `- ${run.label}: cwd=${run.cwd}, output=${path.relative(summary.runDirectory, run.outputDir)}, wall=${run.command.elapsedMs}ms, internal=${run.scan.elapsedMs}ms, wrote=${run.scan.wrote}, rss=${computeMiB(run.command.rssBytes)}`,
        );
      }
    }

    if (!target.success) {
      lines.push(`status: failed — ${target.error ?? "unknown"}`);
      lines.push("");
      continue;
    }

    if (target.freshScan) {
      lines.push(
        `compactness: exact-internal=${target.compactness?.exactInternal ?? 0}, exact-external=${target.compactness?.exactExternal ?? 0}, false-local-external=${target.compactness?.falseLocalModuleAttributedExternal ?? 0}, unresolved-heuristic=${target.compactness?.unresolvedHeuristic ?? 0}, inverse-unresolved=${target.compactness?.inverseDerivedFromUnresolvedEndpoint ?? 0}`,
      );
      lines.push(
        `manifest bytes=${computeBytes(target.freshScan.manifest.manifestBytes)}, semanticInputs=${target.freshScan.manifest.semanticInputCount}`,
      );
      lines.push(`check current: ${target.check?.result.current ? "true" : "false"}`);
      if (target.load) {
        lines.push(
          `loadCodeMap: wall=${target.load.command.elapsedMs}ms, internal=${target.load.result.elapsedMs.toFixed(2)}ms`,
        );
      }
      if (target.check) lines.push(`check wall=${target.check.command.elapsedMs}ms`);
      lines.push("Artifacts (size / sha256):");
      for (const artifact of target.freshScan.artifacts) {
        lines.push(
          `- ${path.relative(summary.runDirectory, artifact.path)}: ${computeBytes(artifact.bytes)} ${artifact.sha256}`,
        );
      }

      lines.push("\nWarm unchanged scans");
      lines.push("| i | wall-ms | internal-ms | rss MiB | wrote |");
      lines.push("| ---: | ---: | ---: | ---: | ---: |");
      target.warmScans.forEach((entry, index) => {
        lines.push(
          `| ${index + 1} | ${entry.command.elapsedMs} | ${entry.scan.elapsedMs} | ${computeMiB(entry.command.rssBytes)} | ${entry.scan.wrote} |`,
        );
      });

      lines.push("\nRelation groups");
      lines.push("| kind | resolution | classification | target | count |");
      lines.push("| --- | --- | --- | --- | ---: |");
      for (const group of target.freshScan.relationGroups.slice(0, 50)) {
        lines.push(
          `| ${group.kind} | ${group.resolution} | ${group.classification} | ${group.target} | ${group.count} |`,
        );
      }

      lines.push("\nCompiler-unit ownership");
      lines.push("| id | kind | root | config | files |");
      lines.push("| --- | --- | --- | --- | ---: |");
      for (const unit of target.freshScan.compilerUnits) {
        lines.push(
          `| ${unit.id} | ${unit.kind} | ${unit.root} | ${unit.config ?? "-"} | ${unit.fileCount} |`,
        );
      }

      lines.push("\nRepresentative relation samples");
      lines.push("| kind | resolution | target | file:line | explanation |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const sample of target.freshScan.relationSamples.slice(0, 20)) {
        lines.push(
          `| ${sample.kind} | ${sample.resolution} | ${sample.target} | ${sample.file}:${sample.line} | ${sample.explanation} |`,
        );
      }
    }

    if (target.baseline) {
      lines.push(
        `Prior milestone baseline: files=${target.baseline.files}, symbols=${target.baseline.symbols}, relations=${target.baseline.relations}, diagnostics=${target.baseline.diagnostics}, fresh=${target.baseline.freshMs}ms, warm=${target.baseline.warmMs}ms`,
      );
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function loadProjectsConfig(filePath: string): Promise<ProjectsConfigFile> {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as ProjectsConfigFile;
}

function resolveProjects(
  supplied: Array<{ name: string; path: string }>,
  config: ProjectsConfigFile,
): Array<{ name: string; path: string }> {
  if (supplied.length > 0) return supplied;

  const defaults = config.projects
    .filter((project) => project.defaultPath)
    .map((project) => ({ name: project.name, path: project.defaultPath as string }));
  if (defaults.length === 0) {
    throw new Error(
      "No --project arguments supplied and projects config has no defaultPath entries.",
    );
  }
  return defaults;
}

function requireScannerArtifactsMatch(
  a: ArtifactRecord[],
  b: ArtifactRecord[],
  projectName: string,
): void {
  try {
    compareArtifactSets(a, b);
  } catch (error) {
    throw new Error(
      `artifact mismatch across fresh/warm scans for ${projectName}: ${String(error)}`,
    );
  }
}

async function runFreshScan(
  project: { name: string; path: string },
  scanner: ScannerRunner,
  run: { label: string; cwd: string; outputDir: string },
  timeSupport: TimeSupport,
): Promise<ScannerRun> {
  const command = await runScannerCommand(
    scanner,
    ["scan", "--root", project.path, "--output", run.outputDir, "--json"],
    run.cwd,
    true,
    timeSupport,
  );
  if (command.exitCode !== 0) {
    throw new Error(`fresh scan (${run.label}) failed: ${command.stderr}`);
  }
  const scan = parseJsonFromOutput(
    command.stdout,
    `scan (${project.name} / ${run.label})`,
  ) as ScanResult;
  const artifacts = await gatherArtifacts(run.outputDir);
  return {
    label: run.label,
    context: run.label,
    cwd: run.cwd,
    outputDir: run.outputDir,
    command,
    scan,
    artifacts,
  };
}

async function runProjectBenchmark(
  project: { name: string; path: string },
  repeats: number,
  outputRoot: string,
  scanner: PackagedScanner,
  timeSupport: TimeSupport,
  baseline?: CLIProjectConfig["metrics"],
): Promise<TargetBenchmarkResult> {
  const resolvedPath = path.resolve(project.path);
  const targetRoot = path.join(outputRoot, `target-${project.name}`);
  const tempCwd = await fs.mkdtemp(
    path.join(os.tmpdir(), `ai-code-map-real-world-${project.name}-`),
  );
  await ensureDirectory(targetRoot);
  const preState = await getRepoState(resolvedPath);

  const contexts = [
    {
      label: FRESH_CONTEXTS[0].label,
      cwd: resolvedPath,
      outputDir: path.join(targetRoot, FRESH_CONTEXTS[0].outputSuffix),
    },
    {
      label: FRESH_CONTEXTS[1].label,
      cwd: scanner.packageRoot,
      outputDir: path.join(targetRoot, FRESH_CONTEXTS[1].outputSuffix),
    },
    {
      label: FRESH_CONTEXTS[2].label,
      cwd: tempCwd,
      outputDir: path.join(targetRoot, FRESH_CONTEXTS[2].outputSuffix),
    },
  ];

  const freshScans: ScannerRun[] = [];
  let canonicalFresh: ScannerRun | undefined;
  let freshCompilerUnits: CompilerUnitOwnership[] = [];
  let freshManifest = { manifestBytes: 0, semanticInputCount: 0 };
  let firstScanCounts: ScanResult["counts"] | undefined;

  for (const context of contexts) {
    if (await pathExists(context.outputDir)) {
      throw new Error(`fresh context output must be absent but exists: ${context.outputDir}`);
    }
    const run = await runFreshScan(
      project,
      scanner,
      { label: context.label, cwd: context.cwd, outputDir: context.outputDir },
      timeSupport,
    );
    if (!firstScanCounts) {
      firstScanCounts = run.scan.counts;
      canonicalFresh = run;
      freshCompilerUnits = await gatherCompilerUnits(run.outputDir);
      freshManifest = await gatherManifestInfo(run.outputDir);
    } else {
      if (
        run.scan.counts.files !== firstScanCounts.files ||
        run.scan.counts.symbols !== firstScanCounts.symbols ||
        run.scan.counts.relations !== firstScanCounts.relations ||
        run.scan.counts.diagnostics !== firstScanCounts.diagnostics
      ) {
        throw new Error(
          `fresh scan (${context.label}) count mismatch for ${project.name}: ${JSON.stringify(
            firstScanCounts,
          )} vs ${JSON.stringify(run.scan.counts)}`,
        );
      }
      requireScannerArtifactsMatch(canonicalFresh?.artifacts ?? [], run.artifacts, project.name);
    }
    freshScans.push(run);
  }

  const canonicalFreshScan = canonicalFresh;
  if (!canonicalFreshScan) throw new Error(`fresh scan failed to initialize for ${project.name}`);

  const firstFreshScanCounts = canonicalFreshScan.scan.counts;
  const targetContext = contexts[0];
  if (!targetContext) throw new Error(`Missing target context for ${project.name}`);
  const relationStats = await gatherRelationStats(
    path.join(canonicalFreshScan.outputDir, "relations.jsonl"),
    path.join(canonicalFreshScan.outputDir, "files.jsonl"),
  );

  const warmScans: Array<{ command: CommandRun; scan: ScanResult }> = [];
  let warmArtifactsMatch = true;
  for (let iteration = 0; iteration < repeats; iteration += 1) {
    const command = await runScannerCommand(
      scanner,
      ["scan", "--root", resolvedPath, "--output", canonicalFreshScan.outputDir, "--json"],
      targetContext.cwd,
      true,
      timeSupport,
    );
    if (command.exitCode !== 0) {
      throw new Error(`warm scan ${iteration + 1} failed: ${command.stderr}`);
    }
    const scan = parseJsonFromOutput(
      command.stdout,
      `warm scan ${iteration + 1} (${project.name})`,
    ) as ScanResult;
    if (scan.wrote) {
      throw new Error(`warm scan ${iteration + 1} reported wrote=true`);
    }
    if (
      scan.counts.files !== firstFreshScanCounts.files ||
      scan.counts.symbols !== firstFreshScanCounts.symbols ||
      scan.counts.relations !== firstFreshScanCounts.relations ||
      scan.counts.diagnostics !== firstFreshScanCounts.diagnostics
    ) {
      throw new Error(
        `warm scan ${iteration + 1} changed counts from ${JSON.stringify(
          firstFreshScanCounts,
        )} to ${JSON.stringify(scan.counts)}`,
      );
    }
    const warmArtifacts = await gatherArtifacts(canonicalFreshScan.outputDir);
    try {
      requireScannerArtifactsMatch(canonicalFreshScan.artifacts, warmArtifacts, project.name);
    } catch {
      warmArtifactsMatch = false;
      throw new Error(`warm scan ${iteration + 1} changed artifact bytes/hashes`);
    }
    warmScans.push({ command, scan });
  }

  const checkCommand = await runScannerCommand(
    scanner,
    ["check", "--root", resolvedPath, "--output", canonicalFreshScan.outputDir, "--json"],
    targetContext.cwd,
    false,
    timeSupport,
  );
  if (checkCommand.exitCode !== 0) {
    throw new Error(`check failed: ${checkCommand.stderr}`);
  }
  const check = parseJsonFromOutput(checkCommand.stdout, `check (${project.name})`) as CheckResult;
  if (!check.current) {
    throw new Error(`target check returned current=false: ${check.reasons.join(" ")}`);
  }
  const load = await runPackagedLoad(
    scanner,
    resolvedPath,
    canonicalFreshScan.outputDir,
    targetContext.cwd,
  );

  const postState = await getRepoState(resolvedPath);
  requireSameArtifactState(preState, postState);

  const freshStats = summarizeScans(freshScans);
  const warmStats = summarizeScans(warmScans);
  const resourceGate = resourceGateResult(project.name, freshScans, warmScans);
  return {
    name: project.name,
    path: project.path,
    resolvedPath,
    preState,
    postState,
    freshScans,
    freshScan: {
      command: canonicalFreshScan.command,
      parser: canonicalFreshScan.scan,
      artifacts: canonicalFreshScan.artifacts,
      relationGroups: relationStats.groups,
      relationSamples: relationStats.samples,
      compilerUnits: freshCompilerUnits,
      manifest: freshManifest,
    },
    freshStats,
    warmScans,
    warmStats,
    warmArtifactsMatch,
    load,
    check: { command: checkCommand, result: check },
    baseline,
    compactness: relationStats.compactness,
    resourceGate,
    success: true,
  };
}

async function runProjectBenchmarkSafe(
  project: { name: string; path: string },
  repeats: number,
  outputRoot: string,
  scanner: PackagedScanner,
  timeSupport: TimeSupport,
  baseline?: CLIProjectConfig["metrics"],
): Promise<TargetBenchmarkResult> {
  try {
    return await runProjectBenchmark(project, repeats, outputRoot, scanner, timeSupport, baseline);
  } catch (error) {
    const resolvedPath = path.resolve(project.path);
    const preState = await getRepoState(resolvedPath).catch(() => ({
      root: resolvedPath,
      commit: "(unavailable)",
      status: "",
      statusLineCount: 0,
      statusHash: "",
      diffHash: "",
    }));
    const postState = await getRepoState(resolvedPath).catch(() => ({
      root: resolvedPath,
      commit: preState.commit,
      status: "",
      statusLineCount: 0,
      statusHash: preState.statusHash,
      diffHash: preState.diffHash,
    }));
    return {
      name: project.name,
      path: project.path,
      resolvedPath,
      preState,
      postState,
      freshScans: [],
      freshStats: {
        wallMs: { min: 0, max: 0, median: 0, count: 0 },
        internalMs: { min: 0, max: 0, median: 0, count: 0 },
      },
      warmScans: [],
      warmStats: {
        wallMs: { min: 0, max: 0, median: 0, count: 0 },
        internalMs: { min: 0, max: 0, median: 0, count: 0 },
      },
      warmArtifactsMatch: false,
      baseline,
      compactness: {
        exactInternal: 0,
        exactExternal: 0,
        falseLocalModuleAttributedExternal: 0,
        unresolvedHeuristic: 0,
        inverseDerivedFromUnresolvedEndpoint: 0,
      },
      resourceGate: {
        project: project.name,
        status: "fail",
        reason: "benchmark did not produce complete scan data",
      },
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function compareProjectCount(projects: Array<{ name: string }>): void {
  if (projects.length !== 3) {
    throw new Error(
      `Expected exactly three target projects, resolved ${projects.length}. Use --project for each target.`,
    );
  }
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(options.configPath);
  const resolvedOutputRoot = path.resolve(options.outputRoot);
  await ensureDirectory(resolvedOutputRoot);
  const runDirectory = await fs.mkdtemp(path.join(resolvedOutputRoot, "run-"));

  const config = await loadProjectsConfig(configPath);
  const projects = resolveProjects(options.projects, config);
  compareProjectCount(projects);

  const notes: string[] = [];
  const timeCommandSupport = await getTimeCommandSupport();

  const scannerPre = await getRepoState(REPO_ROOT);
  const pnpmVersionRun = await runCommand({ command: "pnpm", args: ["--version"], cwd: REPO_ROOT });
  const scannerPackage = options.dryRun ? undefined : await preparePackagedScanner(runDirectory);
  const scannerSnapshot = await createScannerSnapshot(runDirectory);
  await writeScannerSnapshotManifest(scannerSnapshot);
  if (scannerPackage?.dependencyMode === "isolated-local-dependency-copy") {
    notes.push(
      "The offline pnpm store lacked tarballs, so the isolated extracted package used a copied local node_modules tree; package code still came from the checksummed tarball.",
    );
  }
  if (scannerPre.statusLineCount > 0) {
    notes.push(
      scannerSnapshot.status === "captured"
        ? "Provisional dirty-tree benchmark with an exact reconstructable source snapshot; the official clean-commit benchmark remains pending."
        : "Provisional dirty-tree benchmark without a reconstructable snapshot; the official clean-commit benchmark remains pending.",
    );
  }
  notes.push(
    "Heuristic and unresolved relations are excluded from future default compact context unless explicitly requested.",
  );

  const scannerSummary = {
    root: REPO_ROOT,
    node: process.version,
    pnpm: pnpmVersionRun.stdout.trim(),
    platform: {
      os: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    commit: scannerPre.commit,
    preState: scannerPre,
    postState: scannerPre,
    command: scannerPackage ? scannerPackage.command : "not prepared (dry-run)",
    package: scannerPackage
      ? {
          packageRoot: scannerPackage.packageRoot,
          cliPath: scannerPackage.cliPath,
          tarballPath: scannerPackage.tarballPath,
          tarballSha256: scannerPackage.tarballSha256,
          tarballBytes: scannerPackage.tarballBytes,
          command: scannerPackage.command,
          preparationCommands: scannerPackage.preparationCommands,
          dependencyMode: scannerPackage.dependencyMode,
        }
      : {
          packageRoot: "(dry-run)",
          cliPath: "(dry-run)",
          tarballPath: "(dry-run)",
          tarballSha256: "(dry-run)",
          tarballBytes: 0,
          command: "dry-run",
          preparationCommands: [],
          dependencyMode: "pnpm-offline-install" as const,
        },
    snapshot: scannerSnapshot,
  };

  if (options.dryRun) {
    const summary: BenchmarkSummary = {
      schemaVersion: "rw-benchmark-v1",
      generatedAt: new Date().toISOString(),
      runDirectory,
      defaults: {
        repeats: options.repeats,
        outputRoot: resolvedOutputRoot,
        configPath,
      },
      scanner: scannerSummary,
      timeCommandSupport,
      projects: [],
      overallSuccess: true,
      notes: [
        "Dry-run mode skips build/pack install and target scanning.",
        scannerSnapshot.status === "provisional"
          ? "Scanner snapshot is provisional; reproducibility from snapshot requires a valid tar capture."
          : "Scanner snapshot captured for reproducibility.",
      ],
    };

    await fs.writeFile(
      path.join(runDirectory, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(runDirectory, "summary.md"), buildMarkdown(summary), "utf8");

    process.stdout.write(
      `Dry-run complete. Targets that would run:\n${projects
        .map((project) => `- ${project.name}: ${path.resolve(project.path)}`)
        .join("\n")}\n`,
    );
    process.stdout.write(`Raw output written to ${runDirectory}\n`);
    return 0;
  }

  const results: TargetBenchmarkResult[] = [];
  let overallSuccess = true;
  if (!scannerPackage) throw new Error("Packaged scanner was not prepared.");

  for (const project of projects) {
    const baseline = config.projects.find((entry) => entry.name === project.name)?.metrics;
    const result = await runProjectBenchmarkSafe(
      project,
      options.repeats,
      runDirectory,
      scannerPackage,
      timeCommandSupport,
      baseline,
    );
    if (!result.success) overallSuccess = false;
    if (!result.resourceGate.thresholdMiB) {
      notes.push(`No resource gate configured for ${project.name}.`);
    } else if (result.resourceGate.status === "pass") {
      notes.push(
        `${project.name}: resource gate PASS (${result.resourceGate.observedPeakMiB?.toFixed(2)} MiB <= ${result.resourceGate.thresholdMiB} MiB)`,
      );
    } else if (result.resourceGate.status === "fail") {
      notes.push(
        `${project.name}: resource gate FAIL (${result.resourceGate.observedPeakMiB?.toFixed(2)} MiB > ${result.resourceGate.thresholdMiB} MiB)`,
      );
      notes.push(`${project.name}: an explicit resource go/no-go decision remains pending.`);
    } else {
      notes.push(`${project.name}: resource gate was not measured; go/no-go remains pending.`);
    }
    if (result.compactness && result.compactness.falseLocalModuleAttributedExternal > 0) {
      notes.push(
        `${project.name}: expected zero false local-module-attributed externals, observed ${result.compactness.falseLocalModuleAttributedExternal}`,
      );
    }
    results.push(result);
  }

  const scannerPost = await getRepoState(REPO_ROOT);
  const scanner = {
    ...scannerSummary,
    postState: scannerPost,
  };

  const summary: BenchmarkSummary = {
    schemaVersion: "rw-benchmark-v1",
    generatedAt: new Date().toISOString(),
    runDirectory,
    defaults: {
      repeats: options.repeats,
      outputRoot: resolvedOutputRoot,
      configPath,
    },
    scanner: {
      ...scanner,
      postState: scannerPost,
    },
    timeCommandSupport,
    projects: results,
    overallSuccess,
    notes,
  };

  await fs.writeFile(
    path.join(runDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(runDirectory, "summary.md"), buildMarkdown(summary), "utf8");

  process.stdout.write(`Wrote report to ${runDirectory}\n`);
  return overallSuccess ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      if (error instanceof Error) {
        process.stderr.write(`${error.message}\n`);
      } else {
        process.stderr.write(`${String(error)}\n`);
      }
      process.exit(1);
    },
  );
}
