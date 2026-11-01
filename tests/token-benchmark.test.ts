import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeEvents,
  cancelBenchmark,
  runBenchmark,
  refreshReport,
  compareReports,
} from "../scripts/token-benchmark.js";

describe("Codex token accounting", () => {
  it("counts cached input and reasoning as subsets rather than adding them twice", () => {
    const result = analyzeEvents([
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "rg example src",
          exit_code: 0,
          aggregated_output: "abc",
        },
      },
      { type: "item.completed", item: { type: "agent_message", text: "Answer" } },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 50,
          reasoning_output_tokens: 30,
        },
      },
    ]);
    expect(result.usage).toMatchObject({
      input: 1000,
      cached: 800,
      uncached: 200,
      output: 50,
      total: 1050,
    });
    expect(result.commands).toBe(1);
    expect(result.outputChars).toBe(3);
    expect(result.answer).toBe("Answer");
    expect(result.errors).toEqual([]);
  });

  it.each([
    [{ input_tokens: 5, cached_input_tokens: 6, output_tokens: 1 }],
    [{ input_tokens: 5, output_tokens: 1 }],
    [{ input_tokens: -1, cached_input_tokens: 0, output_tokens: 1 }],
    [{ input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 2 }],
  ])("rejects unusable usage instead of silently reporting zero tokens", (usage) => {
    const result = analyzeEvents([{ type: "turn.completed", usage }]);
    expect(result.usage).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("does not treat a failed or ambiguous multi-turn stream as a valid measurement", () => {
    const complete = {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 },
    };
    expect(analyzeEvents([complete, complete]).errors.length).toBeGreaterThan(0);
    expect(
      analyzeEvents([complete, { type: "turn.failed", error: { message: "disconnected" } }]).errors
        .length,
    ).toBeGreaterThan(0);
    expect(analyzeEvents([]).errors.length).toBeGreaterThan(0);
  });
});

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

async function fixture(
  options: {
    emptyMap?: boolean;
    blankSource?: boolean;
    failMap?: boolean;
    hang?: boolean;
    mutate?: boolean;
    cancel?: boolean;
    ignoreMap?: boolean;
    wrongCli?: boolean;
    searchCommand?: string;
  } = {},
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "token-benchmark-test-")));
  temporary.push(root);
  const project = path.join(root, "project");
  await fs.mkdir(path.join(project, ".ai/code-map"), { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(project, "entry.ts"), "export const value = 1;\n");
  await fs.writeFile(
    path.join(project, ".ai/code-map/symbols.jsonl"),
    '{"id":"variable:entry.ts#value"}\n',
  );
  await fs.writeFile(
    path.join(root, "SKILL.md"),
    "SKILL SENTINEL: use the indexed symbol and read source.\n",
  );
  await fs.writeFile(
    path.join(root, "map.mjs"),
    `
import path from 'node:path';
const args=process.argv.slice(2); const root=args[args.indexOf('--root')+1];
if (${String(options.emptyMap ?? false)}) process.exit(0);
if(args[0]==='--version') console.log('fixture-map 1');
else if(args[0]==='check') console.log(JSON.stringify({current:true,status:'current',root,outputDir:path.join(root,'.ai/code-map')}));
else if(args[0]==='read') console.log(JSON.stringify({source:${JSON.stringify(options.blankSource ? "" : "export const value = 1;")},id:args[1],file:'entry.ts',startLine:1,endLine:1}));
else process.exit(9);
`,
  );
  await fs.writeFile(
    path.join(root, "codex.mjs"),
    `
import fs from 'node:fs';
if(process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
let prompt=''; for await (const part of process.stdin) prompt+=part;
if(!process.argv.includes('--json') || !process.argv.includes('read-only')) process.exit(8);
const map=prompt.includes('Navigation mode: map');
if(map && !prompt.includes('SKILL SENTINEL')) process.exit(7);
if(${String(options.hang ?? options.cancel ?? false)}) { fs.writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid)); setInterval(()=>{},1000); }
else {
 if(map && ${String(options.mutate ?? false)}) fs.appendFileSync('entry.ts','// changed\\n');
 if(!map && fs.existsSync('.ai')) process.exit(9);
 console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:map && !${String(options.ignoreMap ?? false)} ? ${JSON.stringify(options.wrongCli ? "pnpm exec ai-code-map read value" : JSON.stringify(process.execPath) + " " + JSON.stringify(path.join(root, "map.mjs")) + " read value")} : ${JSON.stringify(options.searchCommand ?? "rg value entry.ts")},aggregated_output:'value'}}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'value is 1 (entry.ts:1)'}}));
 if(map && ${String(options.failMap ?? false)}) { console.log(JSON.stringify({type:'turn.failed'})); process.exit(1); }
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:map?60:100,cached_input_tokens:map?10:20,output_tokens:10}}));
}
`,
  );
  const config = path.join(root, "config.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      model: "fixture-model",
      codex: [process.execPath, "./codex.mjs"],
      repeats: 1,
      timeoutSeconds: options.hang ? 0.15 : 5,
      budgetSeconds: 15,
      concurrency: 1,
      baseline: "search",
      projects: [
        {
          id: "fixture",
          root: "./project",
          tasks: [
            {
              id: "value",
              prompt: "What is value?",
              rubric: ["Identifies value 1 and cites source"],
            },
          ],
        },
      ],
      variants: [
        { id: "search", mode: "search" },
        { id: "map", mode: "map", mapCli: "./map.mjs", skill: "./SKILL.md" },
      ],
    }),
  );
  return { root, project, config, output: path.join(root, "results") };
}

describe("reproducible token benchmark", () => {
  it("rejects empty successful map output before spending any model tokens", async () => {
    const f = await fixture({ emptyMap: true });
    const result = await runBenchmark(f.config, f.output);
    expect(result.status).toBe("preflight_failed");
    expect(result.runs).toHaveLength(0);
    expect(result.errors.join(" ")).toMatch(/map|output|JSON/i);
  });

  it("accepts a valid map read whose first source line is blank", async () => {
    const f = await fixture({ blankSource: true });
    expect((await runBenchmark(f.config, f.output, true)).status).toBe("checked");
  });

  it("rejects an output directory inside the source before creating it", async () => {
    const f = await fixture();
    const output = path.join(f.project, "new-results");
    await expect(runBenchmark(f.config, output)).rejects.toThrow(/outside/);
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("keeps a control copy verifiable when its output is ignored by an ancestor Git repository", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, ".gitignore"), "results/\n");
    const init = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      const child = init.spawn("git", ["init", "-q"], { cwd: f.root });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git init ${code}`))));
    });
    expect((await runBenchmark(f.config, f.output)).status).toBe("complete");
  });

  it("allows excluding .ai from search while still rejecting an actual map read", async () => {
    for (const searchCommand of [
      "rg -g '!.ai/**' value entry.ts",
      "rg --glob '!.ai/**' value entry.ts",
      "rg --glob '!**/.ai/**' value entry.ts",
      "/bin/zsh -lc \"rg --glob '\"'!**/.ai/**'\"' value entry.ts\"",
      "/bin/zsh -lc \"rg --glob '\"'!.ai/**'\"' value entry.ts\"",
    ]) {
      const exclusion = await fixture({ searchCommand });
      const excluded = await runBenchmark(exclusion.config, exclusion.output);
      expect(excluded.runs.map((run) => run.errors)).toEqual([[], []]);
      expect(excluded.status).toBe("complete");
    }
    for (const searchCommand of [
      "rg -g '!.ai/**' value .ai/code-map/symbols.jsonl",
      "rg -g '!**/.ai/**' value .ai/code-map/symbols.jsonl",
    ]) {
      const access = await fixture({ searchCommand });
      const report = await runBenchmark(access.config, access.output);
      expect(report.runs.find((run) => run.variant === "search")?.errors.join(" ")).toMatch(
        /map navigation/i,
      );
    }
    const absolute = await fixture({
      searchCommand: "cat /private/tmp/project/.ai/code-map/symbols.jsonl",
    });
    const absoluteReport = await runBenchmark(absolute.config, absolute.output);
    expect(absoluteReport.runs.find((run) => run.variant === "search")?.errors.join(" ")).toMatch(
      /map navigation/i,
    );
  });

  it("compares quality across versions without rewriting saved reports", async () => {
    const f = await fixture();
    const before = await runBenchmark(f.config, f.output);
    const after = await runBenchmark(f.config, f.output);
    for (const report of [before, after]) {
      const quality = Object.fromEntries(
        report.runs.map((r) => [
          r.reviewId,
          {
            accepted: true,
            scores: [r.variant === "search" ? 0.5 : report === before ? 1 : 0.75],
          },
        ]),
      );
      await fs.writeFile(path.join(report.directory, "quality.json"), JSON.stringify(quality));
    }
    const saved = await fs.readFile(path.join(before.directory, "summary.json"), "utf8");
    const compared = await compareReports(before.directory, after.directory);
    expect(compared.changes.find((v) => v.variant === "map")?.qualityComparable).toBe(false);
    expect(compared.changes.find((v) => v.variant === "search")?.qualityComparable).toBe(true);
    expect(await fs.readFile(path.join(before.directory, "summary.json"), "utf8")).toBe(saved);
  });

  it("rejects a saved report with duplicate pairs", async () => {
    const f = await fixture();
    const report = await runBenchmark(f.config, f.output);
    const first = report.runs[0];
    if (!first) throw new Error("Missing test run");
    report.runs[1] = first;
    await fs.writeFile(path.join(report.directory, "summary.json"), JSON.stringify(report));
    await expect(compareReports(report.directory, report.directory)).rejects.toThrow();
  });

  it.each([{ ignoreMap: true }, { wrongCli: true }])(
    "rejects a candidate that ignores the map or runs another CLI: %j",
    async (options) => {
      const f = await fixture(options);
      const report = await runBenchmark(f.config, f.output);
      expect(report.status).toBe("incomplete");
      expect(report.runs.find((r) => r.variant === "map")?.errors.join(" ")).toMatch(/Candidate/);
      expect(report.comparisons[0]?.observedSavings).toBe(false);
    },
  );

  it("cancels the active process and skips remaining sessions", async () => {
    const f = await fixture({ cancel: true });
    const pending = runBenchmark(f.config, f.output);
    let pid = 0;
    for (let i = 0; i < 200; i++) {
      try {
        pid = Number(await fs.readFile(path.join(f.root, "pid"), "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    cancelBenchmark();
    const report = await pending;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(report.status).toBe("incomplete");
    expect(report.runs.at(-1)?.status).toBe("skipped");
  });

  it("runs both variants, saves skill provenance and gates savings on manual quality review", async () => {
    const f = await fixture();
    const result = await runBenchmark(f.config, f.output);
    expect(result.status).toBe("complete");
    expect(result.runs).toHaveLength(2);
    expect(result.comparisons[0]).toMatchObject({
      baselineTotal: 110,
      candidateTotal: 70,
      qualityComparable: false,
      observedSavings: false,
    });
    expect(result.variants.find((v) => v.id === "map")?.skillHash).toMatch(/^[a-f0-9]{64}$/);
    const qualityFile = path.join(result.directory, "quality.json");
    const quality = JSON.parse(await fs.readFile(qualityFile, "utf8")) as Record<
      string,
      { scores: (number | null)[]; accepted: boolean | null }
    >;
    for (const assessment of Object.values(quality)) {
      assessment.scores = [1];
      assessment.accepted = true;
    }
    await fs.writeFile(qualityFile, JSON.stringify(quality));
    const reviewed = await refreshReport(result.directory);
    expect(reviewed.comparisons[0]).toMatchObject({
      qualityComparable: true,
      observedSavings: true,
    });
    expect((await fs.readdir(path.join(result.directory, "review"))).length).toBe(2);
    expect((await compareReports(result.directory, result.directory)).compatible).toBe(true);
  });

  it("keeps failed attempts visible and refuses a partial-pair savings claim without retrying", async () => {
    const f = await fixture({ failMap: true });
    const result = await runBenchmark(f.config, f.output);
    expect(result.status).toBe("incomplete");
    expect(result.runs).toHaveLength(2);
    expect(result.runs.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({
      complete: false,
      savingsPercent: null,
      observedSavings: false,
    });
  });

  it("terminates a timed-out session and does not schedule retries", async () => {
    const f = await fixture({ hang: true });
    const result = await runBenchmark(f.config, f.output);
    expect(result.status).toBe("incomplete");
    expect(result.runs.filter((r) => r.status === "timeout").length).toBeGreaterThan(0);
    expect(result.runs.length).toBeLessThanOrEqual(2);
    expect(result.comparisons[0]?.observedSavings).not.toBe(true);
  });

  it("rejects changed source snapshots instead of treating the shorter answer as a win", async () => {
    const f = await fixture({ mutate: true });
    const result = await runBenchmark(f.config, f.output);
    expect(result.status).toBe("incomplete");
    expect(result.runs.some((r) => r.errors.some((e) => /source.*changed/i.test(e)))).toBe(true);
    expect(result.comparisons[0]?.observedSavings).not.toBe(true);
  });

  it("refuses saved-report comparisons with different tasks or settings", async () => {
    const f = await fixture();
    const before = await runBenchmark(f.config, f.output);
    const cfg = JSON.parse(await fs.readFile(f.config, "utf8")) as { model: string };
    cfg.model = "different-model";
    await fs.writeFile(f.config, JSON.stringify(cfg));
    const after = await runBenchmark(f.config, f.output);
    await expect(compareReports(before.directory, after.directory)).rejects.toThrow(
      /incompatible/i,
    );
  });
});
