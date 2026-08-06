import {
  checkFreshness,
  createAnalyzer,
  initProject,
  loadCodeMap,
  type FreshnessResult,
  type ScanResult,
  scanProject,
  type ShowResult,
  showSymbol,
  NextJsAnalyzer,
  NestJsAnalyzer,
} from "ai-code-map";

const root = process.cwd();

await initProject({ root });
const scan: ScanResult = await scanProject({ root });
console.log("scanned:", scan.counts);

const map = await loadCodeMap({ root });
const match: ShowResult = showSymbol(map, "Calculator");
console.log("calculator matches:", match.matches.length);

const freshness: FreshnessResult = await checkFreshness({ root });
console.log("fresh:", freshness.current, freshness.reasons);

const analyzer = createAnalyzer({
  // Experimental and default-off in the alpha; opt in only for evaluation.
  analyzers: [new NextJsAnalyzer(), new NestJsAnalyzer()],
});
await analyzer.scan({ root, output: ".ai/code-map-advanced" });
console.log("advanced scan complete");
