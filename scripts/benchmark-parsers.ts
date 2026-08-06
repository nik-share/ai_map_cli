import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

type Language = "ts" | "tsx";
type ParserStatus = "success" | "error" | "skipped";

interface CandidateCounts {
  calls: number;
  hooks: number;
  jsx: number;
  decorators: number;
}

interface Inspection {
  candidates: CandidateCounts;
  errorNodes: number;
}

interface TimingSummary {
  iterations: number;
  durationMs: { min: number; median: number; average: number; max: number };
  observedRssBytes: { min: number; max: number; delta: number };
}

interface ParserReport {
  parser: string;
  status: ParserStatus;
  candidates: CandidateCounts;
  errorNodes: number;
  cold?: TimingSummary;
  warm?: TimingSummary;
  note?: string;
}

interface ParserHarness {
  name: string;
  parse(source: string, language: Language): unknown;
  inspect(tree: unknown): Inspection;
}

interface Sample {
  durationMs: number;
  rssBefore: number;
  rssAfter: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../benchmarks/fixtures");
const WARMUP_ITERATIONS = 5;
const MEASURED_ITERATIONS = 30;

const FIXTURE_CASES = [
  { id: "valid-ts", file: "valid-ts.ts", language: "ts" },
  { id: "valid-tsx", file: "valid-tsx.tsx", language: "tsx" },
  { id: "partially-invalid-tsx", file: "partially-invalid-tsx.tsx", language: "tsx" },
  { id: "syntax-error-tsx", file: "syntax-error.tsx", language: "tsx" },
] as const;

const typescriptHarness: ParserHarness = {
  name: `typescript@${ts.version}`,
  parse(source, language) {
    return ts.createSourceFile(
      `fixture.${language}`,
      source,
      ts.ScriptTarget.Latest,
      true,
      language === "tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  },
  inspect(tree) {
    const sourceFile = tree as ts.SourceFile;
    const candidates = emptyCounts();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        candidates.calls += 1;
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : "";
        if (/^use[A-Z]/.test(name)) candidates.hooks += 1;
      }
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
        candidates.jsx += 1;
      }
      if (ts.isDecorator(node)) candidates.decorators += 1;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const diagnostics = (
      sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    return { candidates, errorNodes: diagnostics?.length ?? 0 };
  },
};

interface AstGrepNode {
  kind(): string;
  text(): string;
  children(): AstGrepNode[];
  field(name: string): AstGrepNode | null;
}

async function loadAstGrepHarness(): Promise<ParserHarness | undefined> {
  try {
    const astGrep = await import("@ast-grep/napi");
    return {
      name: "@ast-grep/napi@0.45.0",
      parse(source, language) {
        const parsed = astGrep.parse(
          language === "tsx" ? astGrep.Lang.Tsx : astGrep.Lang.TypeScript,
          source,
        );
        return parsed.root();
      },
      inspect(tree) {
        const root = tree as AstGrepNode;
        const candidates = emptyCounts();
        let errorNodes = 0;
        const stack = [root];
        while (stack.length > 0) {
          const node = stack.pop();
          if (!node) {
            continue;
          }
          const kind = node.kind();
          if (kind === "ERROR" || kind === "MISSING") errorNodes += 1;
          if (kind === "call_expression") {
            candidates.calls += 1;
            const callee = node.field("function")?.text() ?? node.children()[0]?.text() ?? "";
            const name = callee.split(".").at(-1) ?? "";
            if (/^use[A-Z]/.test(name)) candidates.hooks += 1;
          }
          if (["jsx_element", "jsx_self_closing_element", "jsx_fragment"].includes(kind)) {
            candidates.jsx += 1;
          }
          if (kind === "decorator") candidates.decorators += 1;
          stack.push(...node.children());
        }
        return { candidates, errorNodes };
      },
    };
  } catch (error) {
    if (isMissingModule(error)) return undefined;
    throw error;
  }
}

function isMissingModule(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

function benchmark(harness: ParserHarness, source: string, language: Language): ParserReport {
  const cold = runSamples(harness, source, language, 1);
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    harness.parse(source, language);
  }
  const warm = runSamples(harness, source, language, MEASURED_ITERATIONS);
  const tree = harness.parse(source, language);
  const inspection = harness.inspect(tree);
  return {
    parser: harness.name,
    status: inspection.errorNodes === 0 ? "success" : "error",
    candidates: inspection.candidates,
    errorNodes: inspection.errorNodes,
    cold: summarize(cold),
    warm: summarize(warm),
  };
}

function runSamples(
  harness: ParserHarness,
  source: string,
  language: Language,
  iterations: number,
): Sample[] {
  const samples: Sample[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    harness.parse(source, language);
    const durationMs = performance.now() - started;
    samples.push({ durationMs, rssBefore, rssAfter: process.memoryUsage().rss });
  }
  return samples;
}

function summarize(samples: Sample[]): TimingSummary {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const rss = samples.flatMap((sample) => [sample.rssBefore, sample.rssAfter]);
  if (durations.length === 0 || rss.length === 0) {
    return {
      iterations: 0,
      durationMs: { min: 0, median: 0, average: 0, max: 0 },
      observedRssBytes: { min: 0, max: 0, delta: 0 },
    };
  }
  const middle = Math.floor(durations.length / 2);
  const minDuration = durations[0];
  const maxDuration = durations[durations.length - 1];
  const firstSample = samples[0];
  const lastSample = samples[samples.length - 1];
  const median =
    durations.length % 2 === 1
      ? (durations[middle] ?? 0)
      : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  return {
    iterations: samples.length,
    durationMs: {
      min: minDuration !== undefined ? round(minDuration) : 0,
      median: round(median),
      average: round(durations.reduce((sum, value) => sum + value, 0) / durations.length),
      max: maxDuration !== undefined ? round(maxDuration) : 0,
    },
    observedRssBytes: {
      min: Math.min(...rss),
      max: Math.max(...rss),
      delta:
        firstSample !== undefined && lastSample !== undefined
          ? lastSample.rssAfter - firstSample.rssBefore
          : 0,
    },
  };
}

function emptyCounts(): CandidateCounts {
  return { calls: 0, hooks: 0, jsx: 0, decorators: 0 };
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

async function main(): Promise<void> {
  const astGrepHarness = await loadAstGrepHarness();
  const cases = [];
  for (const fixture of FIXTURE_CASES) {
    const source = await fs.readFile(path.join(FIXTURES, fixture.file), "utf8");
    cases.push({
      id: fixture.id,
      file: `benchmarks/fixtures/${fixture.file}`,
      language: fixture.language,
      sizeBytes: Buffer.byteLength(source),
      parsers: {
        typescript: benchmark(typescriptHarness, source, fixture.language),
        astGrepNapi: astGrepHarness
          ? benchmark(astGrepHarness, source, fixture.language)
          : {
              parser: "@ast-grep/napi",
              status: "skipped" as const,
              candidates: emptyCounts(),
              errorNodes: 0,
              note: "Install the exact dev dependency with pnpm add -D -E @ast-grep/napi@0.45.0.",
            },
      },
    });
  }
  console.log(
    JSON.stringify(
      {
        metadata: {
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          warmupIterations: WARMUP_ITERATIONS,
          measuredIterations: MEASURED_ITERATIONS,
          timingScope: "in-process parse only; candidate inspection is outside timed samples",
          rssScope: "process RSS observations, not an isolated parser peak",
        },
        cases,
      },
      null,
      2,
    ),
  );
}

await main();
