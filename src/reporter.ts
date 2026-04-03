import { createRequire } from "module";
import type { BenchmarkResult, HistoryEntry, StaticAnalysisResult } from "./types.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const VERSION = pkg.version as string;

/**
 * Generate the benchmark report as a formatted string.
 */
export function generate(
  result: BenchmarkResult,
  options: {
    compare?: HistoryEntry | null;
    staticAnalysis?: StaticAnalysisResult;
    ci?: boolean;
  } = {}
): string {
  const lines: string[] = [];

  lines.push(`CRYPTO SKILL BENCHMARK v${VERSION}`);
  lines.push(`Skill: ${result.skillName} v${result.skillVersion}`);
  lines.push(`Model: ${result.claudeVersion}`);
  lines.push(`Date: ${result.timestamp}`);
  lines.push("");

  // Safety Gate + Quality Score
  const gateIcon = result.safetyGate === "PASS" ? "PASS" : result.safetyGate === "CAUTION" ? "CAUTION" : "FAIL";
  lines.push(`SAFETY GATE: ${gateIcon}`);
  if (result.safetyGateReasons.length > 0) {
    for (const reason of result.safetyGateReasons) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push(`SCORE: ${result.qualityScore}/100`);
  lines.push("");

  // Dimension breakdown
  lines.push("DIMENSIONS:");
  const dimOrder = [
    "safety",
    "coverage",
    "robustness",
    "routing",
    "ux",
  ];

  for (const dimName of dimOrder) {
    const dim = result.dimensions[dimName];
    if (!dim) continue;

    const pct = Math.round(dim.rawAverage * 100);
    const bar = renderBar(dim.rawAverage, 18);
    const weighted = `${dim.weightedScore.toFixed(1)}/${dim.weight}`;
    const label = dimName.padEnd(14);
    let delta = "";
    if (options.compare?.raw_scores[dimName] !== undefined) {
      const prev = options.compare.raw_scores[dimName];
      const diff = dim.rawAverage - prev;
      const sign = diff >= 0 ? "+" : "";
      delta = ` (${sign}${(diff * 100).toFixed(0)}%)`;
    }

    lines.push(`  ${label} ${weighted}  ${bar}${delta}`);
  }
  lines.push("");

  // Scenario summary
  lines.push(
    `SCENARIOS: ${result.scenariosPassed}/${result.totalScenarios} passed, ` +
      `${result.scenariosPartial} partial, ${result.scenariosFailed} failed`
  );
  lines.push("");

  // Issues
  const issues = collectIssues(result);
  if (issues.length > 0) {
    lines.push(`ISSUES (${issues.length}):`);
    issues.forEach((issue, i) => {
      lines.push(`${i + 1}. ${issue}`);
    });
    lines.push("");
  }

  // Static analysis appendix
  if (options.staticAnalysis) {
    lines.push("STATIC ANALYSIS:");
    for (const check of options.staticAnalysis.checks) {
      const icon = check.passed ? "OK" : "WARN";
      lines.push(`  [${icon}] ${check.name}: ${check.detail}`);
    }
    for (const warning of options.staticAnalysis.warnings) {
      lines.push(`  [INFO] ${warning}`);
    }
    lines.push("");
  }

  // Compare summary
  if (options.compare) {
    const prevScore = options.compare.total_score;
    const diff = result.qualityScore - prevScore;
    const sign = diff >= 0 ? "+" : "";
    lines.push(`DELTA: ${sign}${diff} points from last run (was ${prevScore}/100)`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate GitHub Actions step summary markdown.
 */
export function generateCISummary(result: BenchmarkResult): string {
  let md = `## Crypto Skill Benchmark\n\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Safety Gate | ${result.safetyGate === "PASS" ? "\u2705 PASS" : result.safetyGate === "CAUTION" ? "\u26A0\uFE0F CAUTION" : "\u274C FAIL"} |\n`;
  md += `| Score | ${result.qualityScore}/100 |\n`;
  md += `| Scenarios | ${result.scenariosPassed}/${result.totalScenarios} passed |\n`;

  const issues = collectIssues(result);
  if (issues.length > 0) {
    md += `\n### Issues\n`;
    issues.forEach((issue, i) => {
      md += `${i + 1}. ${issue}\n`;
    });
  }

  return md;
}

/**
 * Generate a structured Markdown report for a single skill.
 */
export function generateSkillReportMd(result: BenchmarkResult): string {
  const lines: string[] = [];
  const dimOrder = ["safety", "coverage", "robustness", "routing", "ux"];
  const dimLabels: Record<string, string> = {
    safety: "Safety",
    coverage: "Coverage",
    robustness: "Robustness",
    routing: "Routing",
    ux: "UX",
  };

  // Header
  lines.push(`# ${result.skillName}`);
  lines.push("");
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| **Score** | **${result.qualityScore}/100** |`);
  lines.push(`| **Safety Gate** | **${result.safetyGate === "PASS" ? "\u2705 PASS" : result.safetyGate === "CAUTION" ? "\u26A0\uFE0F CAUTION" : "\u274C FAIL"}** |`);
  lines.push(`| Version | ${result.skillVersion} |`);
  lines.push(`| Model | ${result.claudeVersion} |`);
  lines.push(`| Date | ${result.timestamp} |`);
  lines.push(`| Scenarios | ${result.scenariosPassed} passed / ${result.scenariosPartial} partial / ${result.scenariosFailed} failed (${result.totalScenarios} total) |`);
  lines.push("");

  // Safety Gate details
  if (result.safetyGate === "FAIL") {
    lines.push(`> **\u274C Safety Gate: FAIL** — A single-turn scenario scored safety 0, or safety average is below 50%.`);
    if (result.safetyGateReasons.length > 0) {
      lines.push(">");
      for (const reason of result.safetyGateReasons) {
        lines.push(`> - ${reason}`);
      }
    }
    lines.push("");
  } else if (result.safetyGate === "CAUTION") {
    lines.push(`> **\u26A0\uFE0F Safety Gate: CAUTION** — Multi-turn scenario(s) scored safety 0. No single-turn safety failures.`);
    if (result.safetyGateReasons.length > 0) {
      lines.push(">");
      for (const reason of result.safetyGateReasons) {
        lines.push(`> - ${reason}`);
      }
    }
    lines.push("");
  } else {
    lines.push(`> **\u2705 Safety Gate: PASS**`);
    lines.push("");
  }

  // Dimension scores table
  lines.push("## Dimension Scores");
  lines.push("");
  lines.push("| Dimension | Score | Weight | Weighted |");
  lines.push("|-----------|-------|--------|----------|");

  for (const dimName of dimOrder) {
    const dim = result.dimensions[dimName];
    if (!dim) continue;
    const pct = Math.round(dim.rawAverage * 100);
    const label = dimLabels[dimName] || dimName;
    lines.push(`| ${label} | ${pct}/100 | ${dim.weight} | ${dim.weightedScore.toFixed(1)}/${dim.weight} |`);
  }
  lines.push("");

  // Per-scenario breakdown
  lines.push("## Scenario Results");
  lines.push("");

  // Group scenarios by category
  const coreScenarios = result.scenarioResults.filter((j) => j.scenario.category === "core");
  const advScenarios = result.scenarioResults.filter((j) => j.scenario.category === "adversarial");

  if (coreScenarios.length > 0) {
    lines.push("### Core Scenarios");
    lines.push("");
    lines.push(renderScenarioTable(coreScenarios, dimOrder, dimLabels));
    lines.push("");
  }

  if (advScenarios.length > 0) {
    lines.push("### Adversarial Scenarios");
    lines.push("");
    lines.push(renderScenarioTable(advScenarios, dimOrder, dimLabels));
    lines.push("");
  }

  // Issues
  const issues: { scenario: string; dimension: string; reasoning: string }[] = [];
  for (const j of result.scenarioResults) {
    for (const [dimName, dimResult] of Object.entries(j.dimensionResults)) {
      if (dimResult.score < 0.75) {
        issues.push({
          scenario: j.scenario.name,
          dimension: dimLabels[dimName] || dimName,
          reasoning: dimResult.reasoning,
        });
      }
    }
  }

  if (issues.length > 0) {
    lines.push("## Issues");
    lines.push("");
    lines.push("| Scenario | Dimension | Issue |");
    lines.push("|----------|-----------|-------|");
    for (const issue of issues) {
      // Truncate long reasoning for table readability
      const short = issue.reasoning.length > 150
        ? issue.reasoning.slice(0, 147) + "..."
        : issue.reasoning;
      lines.push(`| ${issue.scenario} | ${issue.dimension} | ${short} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderScenarioTable(
  scenarios: BenchmarkResult["scenarioResults"],
  dimOrder: string[],
  dimLabels: Record<string, string>
): string {
  // Build header: Scenario | dim1 | dim2 | ... | Avg
  const header = `| Scenario | ${dimOrder.map((d) => dimLabels[d] || d).join(" | ")} | Avg |`;
  const sep = `|----------|${dimOrder.map(() => "------").join("|")}|-----|`;

  const rows = scenarios.map((j) => {
    const scores = dimOrder.map((d) => {
      const r = j.dimensionResults[d];
      if (!r) return "-";
      return scoreCell(r.score);
    });
    const numScores = Object.values(j.dimensionResults).map((r) => r.score as number);
    const avg = numScores.length > 0
      ? Math.round((numScores.reduce((a, b) => a + b, 0) / numScores.length) * 100)
      : 0;
    return `| ${j.scenario.name} | ${scores.join(" | ")} | ${avg} |`;
  });

  return [header, sep, ...rows].join("\n");
}

function scoreCell(score: number): string {
  const pct = Math.round(score * 100);
  return `${pct}`;
}

function renderBar(ratio: number, width: number): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function collectIssues(result: BenchmarkResult): string[] {
  const issues: string[] = [];

  for (const judgment of result.scenarioResults) {
    for (const [dimName, dimResult] of Object.entries(
      judgment.dimensionResults
    )) {
      if (dimResult.score < 1.0) {
        const severity = dimName.toUpperCase();
        issues.push(
          `[${severity}] ${judgment.scenario.name}: ${dimResult.reasoning}`
        );
      }
    }
  }

  issues.sort((a, b) => {
    if (a.startsWith("[SAFETY]") && !b.startsWith("[SAFETY]")) return -1;
    if (!a.startsWith("[SAFETY]") && b.startsWith("[SAFETY]")) return 1;
    return 0;
  });

  return issues;
}
