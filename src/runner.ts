import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import type {
  CLIOptions,
  Scenario,
  ScenarioJudgment,
  DimensionsConfig,
  DimensionName,
  BenchmarkResult,
} from "./types.js";
import { mergeScenarios, filterByTier } from "./scenario-loader.js";
import { invoke, initConcurrency, getSkillModel } from "./skill-invoker.js";
import { parse } from "./transcript-parser.js";
import { analyze } from "./static-analyzer.js";
import { judgeDimension } from "./judge.js";
import { aggregate, checkInstantFail } from "./scorer.js";
import { generate, generateCISummary, generateSkillReportMd } from "./reporter.js";
import { append, readLast } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);

/**
 * Main benchmark runner. Thin orchestration layer.
 *
 * Flow:
 * 1. Load config + scenarios
 * 2. Run static analysis (pre-flight, appendix only)
 * 3. Invoke skill per scenario (parallel, limited concurrency)
 * 4. Judge each dimension
 * 5. Score (await all before confidence band decision)
 * 6. Store history
 * 7. Generate report
 */
const REPORTS_DIR = join(process.cwd(), "reports");

function p(n: number): string {
  return n.toString().padStart(2, "0");
}

export async function run(options: CLIOptions): Promise<{
  result: BenchmarkResult;
  report: string;
  exitCode: number;
}> {
  // Load config
  const dimensionsConfig = yaml.load(
    await readFile(join(PROJECT_ROOT, "dimensions.yaml"), "utf-8")
  ) as DimensionsConfig;

  // Load scenarios
  const scenariosDir = join(PROJECT_ROOT, "scenarios");
  const secretDir = process.env.CRYPTO_BENCH_SECRET_DIR;
  let scenarios = await mergeScenarios(scenariosDir, secretDir, options.ci);
  scenarios = filterByTier(scenarios, options.tiers);

  if (scenarios.length === 0) {
    console.error(
      `No scenarios found for tiers: ${options.tiers.join(", ")}`
    );
    return {
      result: emptyResult(options),
      report: "No scenarios to run.",
      exitCode: 1,
    };
  }

  console.log(
    `Loaded ${scenarios.length} scenarios (tiers: ${options.tiers.join(", ")})`
  );

  // Static analysis (pre-flight)
  console.log("Running static analysis...");
  const staticAnalysis = await analyze(options.skillDir);

  // Init concurrency
  initConcurrency(options.concurrency);

  // Get skill metadata
  const skillName = basename(options.skillDir);
  const skillVersion = await getSkillVersion(options.skillDir);
  const claudeVersion = getSkillModel();

  // Run scenarios
  console.log(
    `Running ${scenarios.length} scenarios (concurrency: ${options.concurrency})...`
  );

  // Stagger scenario starts by 500ms to spread API calls
  const judgments: ScenarioJudgment[] = await Promise.all(
    scenarios.map((scenario, i) =>
      new Promise<ScenarioJudgment>((resolve) =>
        setTimeout(() => resolve(runScenario(scenario, options, dimensionsConfig)), i * 500)
      )
    )
  );

  // Score — all scenarios complete before this point
  const result = aggregate(
    judgments,
    dimensionsConfig,
    skillName,
    skillVersion,
    claudeVersion
  );

  // Store history
  await append(skillName, result);

  // Compare with last run
  const lastEntry = options.compare ? await readLast(skillName) : null;

  // Generate report
  const report = generate(result, {
    compare: lastEntry,
    staticAnalysis,
    ci: options.ci,
  });

  // CI summary
  if (options.ci && process.env.GITHUB_STEP_SUMMARY) {
    const summary = generateCISummary(result);
    const { appendFile } = await import("fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  const exitCode = 0;

  return { result, report, exitCode };
}

async function runScenario(
  scenario: Scenario,
  options: CLIOptions,
  dimensionsConfig: DimensionsConfig
): Promise<ScenarioJudgment> {
  console.log(`  [${scenario.tier}] ${scenario.name}...`);

  // Invoke skill
  const invocationResult = await invoke(options.skillDir, scenario.intent, scenario.turns);

  if (!invocationResult.ok) {
    console.log(`    FAIL: ${invocationResult.error} — ${invocationResult.message}`);
    return {
      scenario,
      transcript: null,
      invocationError: invocationResult.message,
      dimensionResults: Object.fromEntries(
        scenario.dimensions_tested.map((d) => [
          d,
          { score: 0 as const, reasoning: `Invocation failed: ${invocationResult.error}` },
        ])
      ),
      instantFailTriggered: true, // Invocation failure = all scores 0 = instant fail
    };
  }

  // Parse transcript
  const transcript = parse(invocationResult.stdout);

  // Judge each dimension
  const dimensionResults: Record<string, { score: 0 | 0.25 | 0.5 | 0.75 | 1.0; reasoning: string }> = {};
  for (const dim of scenario.dimensions_tested) {
    dimensionResults[dim] = await judgeDimension(transcript, scenario, dim);
  }

  const judgment: ScenarioJudgment = {
    scenario,
    transcript,
    invocationError: null,
    dimensionResults,
    instantFailTriggered: false,
  };

  // Check instant-fail
  judgment.instantFailTriggered = checkInstantFail(judgment);

  const dimValues = Object.values(dimensionResults);
  const avgScore = dimValues.length > 0
    ? dimValues.reduce((a, b) => a + b.score, 0) / dimValues.length
    : 0;
  const pctScore = Math.round(avgScore * 100);
  const icon = `${pctScore}%`;
  console.log(`    ${icon} (avg: ${avgScore.toFixed(2)})`);

  return judgment;
}

async function getSkillVersion(skillDir: string): Promise<string> {
  try {
    const skillMd = await readFile(join(skillDir, "SKILL.md"), "utf-8");
    const match = skillMd.match(/version:\s*["']?([^"'\n]+)/);
    return match?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

export async function writeSkillReport(
  skillName: string,
  result: BenchmarkResult,
  report: string
): Promise<string> {
  await mkdir(REPORTS_DIR, { recursive: true });

  const now = new Date();
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const mdPath = join(REPORTS_DIR, `${skillName}-${ts}.md`);
  const jsonPath = join(REPORTS_DIR, `${skillName}-${ts}.json`);

  await writeFile(mdPath, generateSkillReportMd(result));
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + "\n");

  console.log(`\nReport: ${mdPath}`);
  return mdPath;
}

function emptyResult(options: CLIOptions): BenchmarkResult {
  return {
    skillName: basename(options.skillDir),
    skillVersion: "unknown",
    claudeVersion: "unknown",
    timestamp: new Date().toISOString(),
    safetyGate: "FAIL",
    safetyGateReasons: ["No scenarios executed"],
    qualityScore: 0,
    dimensions: {},
    scenarioResults: [],
    totalScenarios: 0,
    scenariosPassed: 0,
    scenariosPartial: 0,
    scenariosFailed: 0,
  };
}
