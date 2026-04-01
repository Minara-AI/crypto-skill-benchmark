import { writeFile, mkdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import type { CLIOptions, BenchmarkResult } from "./types.js";
import { run } from "./runner.js";
import { generateSkillReportMd } from "./reporter.js";
import { initConcurrency } from "./skill-invoker.js";
import { loadLock, getSkillDir, getLocalSkills } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
const REPORTS_DIR = join(PROJECT_ROOT, "reports");

/** Zero-pad to 2 digits */
function p(n: number): string {
  return n.toString().padStart(2, "0");
}

export interface BatchResult {
  skill: string;
  category: string;
  version: string;
  result: BenchmarkResult | null;
  report: string;
  exitCode: number;
  error?: string;
}

/**
 * Run benchmark against all pulled skills and generate reports.
 *
 * Directory structure:
 *   reports/
 *     batch-2026-03-31T13-00-00/
 *       summary.md          ← overview table + category breakdown + dimension heatmap
 *       summary.json        ← structured data for all skills
 *       skills/
 *         minara-official.md
 *         minara-official.json
 *         binance-spot-trading.md
 *         binance-spot-trading.json
 *         ...
 */
export async function runBatch(
  baseOptions: Omit<CLIOptions, "skillDir" | "skillsbenchExport">,
  filter?: string[]
): Promise<{ results: BatchResult[]; reportPath: string }> {
  const lock = await loadLock();
  if (!lock || lock.skills.length === 0) {
    throw new Error(
      "No skills pulled yet. Run `crypto-skill-bench pull` first."
    );
  }

  const localSkills = await getLocalSkills();
  let skills = lock.skills.filter((s) => localSkills.includes(s.name));

  if (filter && filter.length > 0) {
    skills = skills.filter(
      (s) => filter.includes(s.name) || filter.includes(s.category)
    );
  }

  if (skills.length === 0) {
    throw new Error("No matching skills found locally.");
  }

  // Create batch directory
  const now = new Date();
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const batchDir = join(REPORTS_DIR, `bench-${ts}`);
  const skillsDir = join(batchDir, "skill-reports");
  await mkdir(skillsDir, { recursive: true });

  // Skill-level parallelism: all skills run concurrently, staggered 1s apart
  const skillConcurrency = skills.length;

  // Initialize the shared semaphore ONCE before any workers start,
  // so all skills share the same concurrency limiter
  initConcurrency(baseOptions.concurrency);

  console.log(`\nBATCH BENCHMARK — ${skills.length} skills (${skillConcurrency} parallel)`);
  console.log(`Report dir: ${batchDir}`);
  console.log("=".repeat(50));

  let completed = 0;

  async function benchmarkSkill(skill: typeof skills[number]): Promise<BatchResult> {
    const sDir = getSkillDir(skill.name);
    console.log(`[START] ${skill.name} (${skill.category}) v${skill.version}`);

    try {
      const options: CLIOptions = {
        ...baseOptions,
        skillDir: sDir,
        skillsbenchExport: false,
      };

      const { result, report, exitCode } = await run(options);

      // Write individual skill report
      await writeFile(join(skillsDir, `${skill.name}.md`), generateSkillReportMd(result));
      await writeFile(join(skillsDir, `${skill.name}.json`), JSON.stringify(result, null, 2) + "\n");

      completed++;
      console.log(`[${result.qualityScore}/100] ${skill.name} (${completed}/${skills.length} done)`);

      return {
        skill: skill.name,
        category: skill.category,
        version: skill.version,
        result,
        report,
        exitCode,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      completed++;
      console.error(`[ERROR] ${skill.name}: ${msg} (${completed}/${skills.length} done)`);

      return {
        skill: skill.name,
        category: skill.category,
        version: skill.version,
        result: null,
        report: `ERROR: ${msg}`,
        exitCode: 1,
        error: msg,
      };
    }
  }

  // Run skills in parallel with concurrency limit
  const results: BatchResult[] = [];
  let nextIndex = 0;
  let summaryWriting: Promise<void> = Promise.resolve();

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= skills.length) break;

      // Stagger start: each worker waits 1s * workerId to spread requests
      if (workerId > 0 && idx === workerId) {
        await new Promise((r) => setTimeout(r, workerId * 1_000));
      }

      const skill = skills[idx];
      const r = await benchmarkSkill(skill);
      results.push(r);
      // Serialize summary writes to prevent concurrent file corruption
      summaryWriting = summaryWriting.then(() =>
        generateSummary(results, lock!.commit, batchDir, skills.length).catch((err) =>
          console.warn(`[WARN] Failed to write interim summary: ${err}`)
        )
      );
      await summaryWriting;
    }
  }

  // Launch workers
  await Promise.all(
    Array.from({ length: skillConcurrency }, (_, i) => worker(i))
  );

  // Final summary
  await generateSummary(results, lock!.commit, batchDir, skills.length);
  return { results, reportPath: batchDir };
}

/**
 * Run benchmark against a list of skill directories (from CLI evaluate command).
 */
export async function runBatchDirs(
  skillDirs: string[],
  baseOptions: Omit<CLIOptions, "skillDir" | "skillsbenchExport">,
): Promise<{ results: BatchResult[]; reportPath: string }> {
  // Load lock file to get category info
  const lock = await loadLock();
  const lockMap = new Map(lock?.skills.map((s) => [s.name, s]) ?? []);

  const now = new Date();
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const batchDir = join(REPORTS_DIR, `bench-${ts}`);
  const skillsDir = join(batchDir, "skill-reports");
  await mkdir(skillsDir, { recursive: true });

  const skillConcurrency = skillDirs.length;

  initConcurrency(baseOptions.concurrency);

  console.log(`\nEVALUATE — ${skillDirs.length} skills (${skillConcurrency} parallel)`);
  console.log(`Report dir: ${batchDir}`);
  console.log("=".repeat(50));

  let completed = 0;
  const results: BatchResult[] = [];

  async function benchmarkDir(skillDir: string): Promise<BatchResult> {
    const skillName = basename(skillDir);
    const lockEntry = lockMap.get(skillName);
    const category = lockEntry?.category ?? "unknown";
    console.log(`[START] ${skillName} (${category})`);

    try {
      const options: CLIOptions = {
        ...baseOptions,
        skillDir,
        skillsbenchExport: false,
      };

      const { result, report, exitCode } = await run(options);

      await writeFile(join(skillsDir, `${skillName}.md`), generateSkillReportMd(result));
      await writeFile(join(skillsDir, `${skillName}.json`), JSON.stringify(result, null, 2) + "\n");

      completed++;
      console.log(`[${result.qualityScore}/100] ${skillName} (${completed}/${skillDirs.length} done)`);

      return {
        skill: skillName,
        category,
        version: result.skillVersion,
        result,
        report,
        exitCode,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      completed++;
      console.error(`[ERROR] ${skillName}: ${msg} (${completed}/${skillDirs.length} done)`);

      return {
        skill: skillName,
        category,
        version: "unknown",
        result: null,
        report: `ERROR: ${msg}`,
        exitCode: 1,
        error: msg,
      };
    }
  }

  let nextIndex = 0;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= skillDirs.length) break;

      if (workerId > 0 && idx === workerId) {
        await new Promise((r) => setTimeout(r, workerId * 1_000));
      }

      const r = await benchmarkDir(skillDirs[idx]);
      results.push(r);
    }
  }

  await Promise.all(
    Array.from({ length: skillConcurrency }, (_, i) => worker(i))
  );

  await generateSummary(results, "local", batchDir, skillDirs.length);
  return { results, reportPath: batchDir };
}

async function generateSummary(
  results: BatchResult[],
  commit: string,
  batchDir: string,
  totalSkills?: number
): Promise<void> {
  const total = totalSkills ?? results.length;
  const isComplete = results.length >= total;
  const lines: string[] = [];

  lines.push(`# Crypto Skill Benchmark — Batch Report`);
  lines.push("");
  if (!isComplete) {
    lines.push(`> **In Progress:** ${results.length}/${total} skills completed`);
    lines.push("");
  }
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Source:** cryptoskill.org (commit \`${commit.slice(0, 8)}\`)`);
  lines.push(`**Skills tested:** ${results.length}/${total}`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| # | Skill | Category | Version | Safety Gate | Score | Report |");
  lines.push("|---|-------|----------|---------|-------------|-------|--------|");

  const sorted = [...results].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (!a.error && b.error) return -1;
    if (!a.result || !b.result) return 0;
    return b.result.qualityScore - a.result.qualityScore;
  });

  sorted.forEach((r, i) => {
    const link = r.error ? "-" : `[detail](skill-reports/${r.skill}.md)`;
    if (r.error) {
      lines.push(
        `| ${i + 1} | ${r.skill} | ${r.category} | ${r.version} | - | - | - |`
      );
    } else if (r.result) {
      const score = r.result.qualityScore;
      const gate = r.result.safetyGate === "PASS" ? "\u2705 PASS" : "\u274C FAIL";
      lines.push(
        `| ${i + 1} | ${r.skill} | ${r.category} | ${r.version} | ${gate} | ${score}/100 | ${link} |`
      );
    }
  });

  lines.push("");



  // Dimension heatmap
  lines.push("## Dimension Scores");
  lines.push("");
  lines.push("| Skill | Safety | Coverage | Robustness | Routing | UX |");
  lines.push("|-------|--------|----------|------------|---------|-----|");

  for (const r of sorted) {
    if (r.error || !r.result) continue;
    const dims = r.result.dimensions;
    const pct = (name: string) => {
      const d = dims[name];
      return d ? `${Math.round(d.rawAverage * 100)}` : "-";
    };
    lines.push(
      `| ${r.skill} | ${pct("safety")} | ${pct("coverage")} | ${pct("robustness")} | ${pct("routing")} | ${pct("ux")} |`
    );
  }

  lines.push("");

  // Stats
  const totalPassed = results.filter((r) => r.exitCode === 0).length;
  const totalFailed = results.filter((r) => r.exitCode !== 0 && !r.error).length;
  const totalErrors = results.filter((r) => r.error).length;
  lines.push("## Stats");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Skills | ${results.length} |`);
  lines.push(`| Completed | ${totalPassed + totalFailed} |`);
  lines.push(`| Errors | ${totalErrors} |`);
  lines.push("");

  await writeFile(join(batchDir, "summary.md"), lines.join("\n"));

  // JSON summary
  const jsonData = {
    timestamp: new Date().toISOString(),
    commit,
    total: results.length,
    passed: totalPassed,
    failed: totalFailed,
    errors: totalErrors,
    results: results.map((r) => ({
      skill: r.skill,
      category: r.category,
      version: r.version,
      exitCode: r.exitCode,
      error: r.error || null,
      safetyGate: r.result?.safetyGate ?? null,
      qualityScore: r.result?.qualityScore ?? null,
      dimensions: r.result?.dimensions
        ? Object.fromEntries(
            Object.entries(r.result.dimensions).map(([k, v]) => [
              k,
              { rawAverage: v.rawAverage, weight: v.weight },
            ])
          )
        : null,
    })),
  };
  await writeFile(join(batchDir, "summary.json"), JSON.stringify(jsonData, null, 2) + "\n");

  console.log(`\nBatch report: ${batchDir}/`);
  console.log(`  summary.md`);
  console.log(`  summary.json`);
  console.log(`  skill-reports/ (${results.filter((r) => !r.error).length} individual reports)`);
}
