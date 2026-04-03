#!/usr/bin/env node

import "dotenv/config";
import { existsSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import type { CLIOptions, TierName } from "./types.js";
import { run, writeSkillReport, retryFailedScenarios } from "./runner.js";
import { setJudgeModel, getJudgeModel } from "./judge.js";
import { setSkillModel, getSkillModel } from "./skill-invoker.js";
import { ensureApiKey } from "./config.js";

const USAGE = `
crypto-skill-bench — Benchmark framework for crypto skills

USAGE:
  crypto-skill-bench evaluate <skill-dir> [skill-dir2 ...] [options]
  crypto-skill-bench retry <report-dir> [options]
  crypto-skill-bench pull [options]
  crypto-skill-bench list

COMMANDS:
  evaluate <dirs...>      Evaluate one or more skill directories
  retry <report-dir>      Re-run failed scenarios from a previous evaluation
  pull                    Pull skills from registry (default: official only)
  list                    List all pulled skills with versions

PULL OPTIONS:
  --all                   Pull all skills (official + community)
  --community             Pull only community skills
  --category CAT          Filter by category (exchanges, defi, trading, wallets)
  --force                 Re-pull even if already at latest commit

EVALUATE OPTIONS:
  --ci                    CI mode: exit 1 if safety gate fails
  --tier TIER             Scenario tiers to run: basic, intermediate, adversarial, all
                          (default: all. Comma-separated.)
  --compare               Show score delta from last run
  --concurrency N         Max parallel API calls (default: 10)
  --model MODEL           OpenRouter model ID for LLM judge (default: anthropic/claude-opus-4-6)
  --skill-model MODEL     OpenRouter model ID for skill invocation (default: anthropic/claude-sonnet-4-6)

GENERAL:
  --version, -v           Show version and check for updates
  --help                  Show this help

ENVIRONMENT:
  OPENROUTER_API_KEY      Required. Get one at https://openrouter.ai/keys
  BENCH_JUDGE_MODEL       Override judge model (same as --model flag)
  BENCH_SKILL_MODEL       Override skill invocation model (same as --skill-model flag)

EXAMPLES:
  # Pull official skills (default)
  crypto-skill-bench pull

  # Pull all skills (official + community)
  crypto-skill-bench pull --all

  # Pull only DeFi skills
  crypto-skill-bench pull --all --category defi

  # Evaluate a single skill
  crypto-skill-bench evaluate ./skills/minara-official

  # Evaluate multiple skills
  crypto-skill-bench evaluate ./skills/minara-official ./skills/jupiter-swap ./skills/okx-dex-swap

  # Evaluate all pulled skills
  crypto-skill-bench evaluate ./skills/*

  # Evaluate with options
  crypto-skill-bench evaluate ./skills/* --tier all --model google/gemini-2.5-flash
  crypto-skill-bench evaluate ./skills/minara-official --ci
`.trim();

async function checkForUpdate(): Promise<void> {
  try {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    const currentVersion = pkg.version;

    const res = await fetch("https://registry.npmjs.org/crypto-skill-bench/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;

    const data = await res.json() as { version: string };
    const latestVersion = data.version;

    if (latestVersion && latestVersion !== currentVersion) {
      console.log(`\n  Update available: ${currentVersion} → ${latestVersion}`);
      console.log(`  Run: npm install -g crypto-skill-bench@latest\n`);
    }
  } catch {
    // Silent fail — don't block CLI on network errors
  }
}

async function main() {
  const args = process.argv.slice(2);

  // ── version ──────────────────────────────────────────────
  if (args.includes("--version") || args.includes("-v")) {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    console.log(`crypto-skill-bench v${pkg.version}`);
    await checkForUpdate();
    process.exit(0);
  }

  if (args.length === 0 || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  // Check for updates in the background (non-blocking)
  checkForUpdate();

  const command = args[0];

  // ── pull ──────────────────────────────────────────────────
  if (command === "pull") {
    const { pullAll } = await import("./registry.js");
    const force = args.includes("--force");
    const all = args.includes("--all");
    const community = args.includes("--community");
    const scope = all ? "all" as const : community ? "community" as const : "official" as const;

    let category: string | undefined;
    const catIdx = args.indexOf("--category");
    if (catIdx !== -1) {
      category = args[catIdx + 1];
      if (!category || category.startsWith("--")) {
        console.error("Error: --category requires a value (exchanges, defi, trading, wallets)");
        process.exit(1);
      }
    }

    console.log(`\nPulling skills from registry (scope: ${scope})...${force ? " (force)" : ""}${category ? ` (category: ${category})` : ""}`);
    const { pulled, skipped, errors } = await pullAll({ force, scope, category });

    console.log(`\nDone: ${pulled.length} pulled, ${skipped.length} skipped, ${errors.length} errors`);
    if (errors.length > 0) {
      console.error("\nErrors:");
      errors.forEach((e) => console.error(`  ${e}`));
      process.exit(1);
    }
    process.exit(0);
  }

  // ── list ──────────────────────────────────────────────────
  if (command === "list") {
    const { listSkills } = await import("./registry.js");
    const skills = await listSkills();

    if (skills.length === 0) {
      console.log("No skills pulled yet. Run `crypto-skill-bench pull` first.");
      process.exit(0);
    }

    console.log(`\nPulled skills (${skills.length}):\n`);
    console.log("  Name".padEnd(42) + "Type".padEnd(12) + "Category".padEnd(14) + "Version".padEnd(12) + "Commit");
    console.log("  " + "─".repeat(82));

    for (const s of skills) {
      const badge = s.official ? "official" : "community";
      console.log(
        `  ${s.name.padEnd(40)}${badge.padEnd(12)}${s.category.padEnd(14)}${s.version.padEnd(12)}${s.commit.slice(0, 8)}`
      );
    }
    console.log("");
    process.exit(0);
  }

  // ── evaluate ───────────────────────────────────────────────
  if (command === "evaluate") {
    const evalArgs = parseEvaluateArgs(args.slice(1));
    if (!evalArgs) process.exit(1);

    await ensureApiKey();

    setJudgeModel(evalArgs.model);
    setSkillModel(evalArgs.skillModel);

    const { skillDirs } = evalArgs;

    if (skillDirs.length === 1) {
      // Single skill — run directly
      const options: CLIOptions = { ...evalArgs, skillDir: skillDirs[0], skillsbenchExport: false };

      console.log(`\nCRYPTO SKILL BENCHMARK`);
      console.log(`Skill: ${options.skillDir}`);
      console.log(`Skill model: ${getSkillModel()} (via OpenRouter)`);
      console.log(`Judge model: ${getJudgeModel()} (via OpenRouter)`);
      console.log("");

      const { result, report, exitCode, failures } = await run(options);
      const skillName = basename(options.skillDir);
      const reportPath = await writeSkillReport(skillName, result, report);

      // Save failures for potential retry
      if (failures && failures.length > 0) {
        const failuresPath = reportPath.replace(/\.md$/, "-failures.json");
        writeFileSync(failuresPath, JSON.stringify(failures, null, 2) + "\n");
        const reportDir = reportPath.replace(/\/[^/]*$/, "");
        console.log(`\n  ${failures.length} scenario(s) failed due to invocation errors.`);
        console.log(`  Retry with: crypto-skill-bench retry ${reportDir}`);
      }

      console.log("\n" + report);

      process.exit(exitCode);
    } else {
      // Multiple skills — batch mode
      console.log(`\nSkill model: ${getSkillModel()} (via OpenRouter)`);
      console.log(`Judge model: ${getJudgeModel()} (via OpenRouter)`);
      console.log(`Concurrency: ${evalArgs.concurrency}`);

      const { runBatchDirs } = await import("./batch-runner.js");
      const { results, reportPath } = await runBatchDirs(
        skillDirs,
        {
          ci: evalArgs.ci,
          tiers: evalArgs.tiers,
          compare: evalArgs.compare,
          concurrency: evalArgs.concurrency,
          model: evalArgs.model,
          skillModel: evalArgs.skillModel,
        },
      );

      const passed = results.filter((r) => r.exitCode === 0).length;
      const failed = results.length - passed;

      // Check for any skills with failures
      const { readdirSync } = await import("fs");
      const skillReportsDir = join(reportPath, "skill-reports");
      const failureFiles = existsSync(skillReportsDir)
        ? readdirSync(skillReportsDir).filter((f: string) => f.endsWith("-failures.json"))
        : [];

      console.log(`\n${"═".repeat(50)}`);
      console.log(`EVALUATE COMPLETE: ${passed} passed, ${failed} failed`);
      console.log(`Report: ${reportPath}`);
      if (failureFiles.length > 0) {
        console.log("");
        console.log(`  ${failureFiles.length} skill(s) have failed scenarios that can be retried:`);
        console.log(`  crypto-skill-bench retry ${reportPath}`);
      }
      console.log(`${"═".repeat(50)}`);

      process.exit(failed > 0 && evalArgs.ci ? 1 : 0);
    }
  }

  // ── retry ──────────────────────────────────────────────────
  if (command === "retry") {
    const reportDir = args[1];
    if (!reportDir || reportDir.startsWith("--")) {
      console.error("Error: report directory is required.");
      console.log("\nUsage: crypto-skill-bench retry <report-dir>");
      console.log("Example: crypto-skill-bench retry ./reports/bench-20260402-1312");
      process.exit(1);
    }

    if (!existsSync(reportDir)) {
      console.error(`Error: Report directory not found: ${reportDir}`);
      process.exit(1);
    }

    // Find all failures.json files in the report dir
    const { readdirSync } = await import("fs");
    const skillReportsDir = join(reportDir, "skill-reports");
    const isSkillReport = existsSync(skillReportsDir);

    // Parse options
    let concurrency = 30;
    let model = process.env.BENCH_JUDGE_MODEL || "anthropic/claude-opus-4-6";
    let skillModel = process.env.BENCH_SKILL_MODEL || "anthropic/claude-sonnet-4-6";

    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--concurrency") concurrency = parseInt(args[++i], 10);
      else if (args[i] === "--model") model = args[++i];
      else if (args[i] === "--skill-model") skillModel = args[++i];
    }

    setJudgeModel(model);
    setSkillModel(skillModel);

    const { generateSkillReportMd } = await import("./reporter.js");
    const { writeFile: writeFileAsync } = await import("fs/promises");

    if (isSkillReport) {
      // Batch report — retry each skill that has failures
      const files = readdirSync(skillReportsDir).filter((f: string) => f.endsWith("-failures.json"));

      if (files.length === 0) {
        console.log("No failed scenarios to retry.");
        process.exit(0);
      }

      console.log(`\nFound ${files.length} skills with failures to retry`);

      let totalRecovered = 0;
      let totalFailed = 0;

      for (const failFile of files) {
        const skillName = failFile.replace("-failures.json", "");
        const failuresPath = join(skillReportsDir, failFile);
        const jsonPath = join(skillReportsDir, `${skillName}.json`);

        if (!existsSync(jsonPath)) {
          console.log(`  [SKIP] ${skillName} — no JSON report found`);
          continue;
        }

        const failures = JSON.parse(readdirSync.length > 0 ? "" : "");
        // Read failures
        const failuresData: { scenario: string }[] = JSON.parse(
          await (await import("fs/promises")).readFile(failuresPath, "utf-8")
        );

        if (failuresData.length === 0) continue;

        console.log(`\n  [${skillName}] Retrying ${failuresData.length} failures...`);

        // Find skillDir from the report
        const existingResult = JSON.parse(
          await (await import("fs/promises")).readFile(jsonPath, "utf-8")
        );

        // We need the skill dir — look in ./skills/
        const skillDir = join(process.cwd(), "skills", skillName);
        if (!existsSync(skillDir)) {
          console.log(`    [SKIP] Skill directory not found: ${skillDir}`);
          continue;
        }

        const options: CLIOptions = {
          skillDir,
          ci: false,
          tiers: ["basic", "intermediate", "adversarial"],
          compare: false,
          concurrency,
          skillsbenchExport: false,
          model,
          skillModel,
        };

        const { result, report } = await retryFailedScenarios(
          skillDir, failuresPath, jsonPath, options
        );

        // Count recovered
        const remainingFailures = result.scenarioResults.filter((j) => j.invocationError !== null);
        const recovered = failuresData.length - remainingFailures.length;
        totalRecovered += recovered;
        totalFailed += remainingFailures.length;

        // Update report files
        await writeFileAsync(join(skillReportsDir, `${skillName}.md`), generateSkillReportMd(result));
        await writeFileAsync(jsonPath, JSON.stringify(result, null, 2) + "\n");

        if (remainingFailures.length === 0) {
          // All recovered — remove failures file
          const { unlink } = await import("fs/promises");
          await unlink(failuresPath);
        } else {
          // Update failures file with remaining
          const remaining = remainingFailures.map((j) => ({
            scenario: j.scenario.name,
            category: j.scenario.category,
            tier: j.scenario.tier,
            error: j.invocationError,
            filePath: j.scenario.filePath,
          }));
          await writeFileAsync(failuresPath, JSON.stringify(remaining, null, 2) + "\n");
        }

        console.log(`    ${recovered} recovered, ${remainingFailures.length} still failing`);
      }

      console.log(`\nRetry complete: ${totalRecovered} recovered, ${totalFailed} still failing`);
      // TODO: regenerate summary.md
    } else {
      // Single skill report — find failures file
      const dirFiles = readdirSync(reportDir);
      const failFile = dirFiles.find((f: string) => f.endsWith("-failures.json"));

      if (!failFile) {
        console.log("No failed scenarios to retry in this report.");
        process.exit(0);
      }

      const failuresPath = join(reportDir, failFile);
      const jsonFile = dirFiles.find((f: string) => f.endsWith(".json") && !f.includes("failures"));
      if (!jsonFile) {
        console.error("Error: No result JSON found in report directory.");
        process.exit(1);
      }

      const jsonPath = join(reportDir, jsonFile);
      const existingResult = JSON.parse(
        await (await import("fs/promises")).readFile(jsonPath, "utf-8")
      );

      const skillName = existingResult.skillName;
      const skillDir = join(process.cwd(), "skills", skillName);

      if (!existsSync(skillDir)) {
        console.error(`Error: Skill directory not found: ${skillDir}`);
        process.exit(1);
      }

      const options: CLIOptions = {
        skillDir,
        ci: false,
        tiers: ["basic", "intermediate", "adversarial"],
        compare: false,
        concurrency,
        skillsbenchExport: false,
        model,
        skillModel,
      };

      const { result, report } = await retryFailedScenarios(
        skillDir, failuresPath, jsonPath, options
      );

      // Update report
      const mdFile = dirFiles.find((f: string) => f.endsWith(".md"));
      if (mdFile) {
        await writeFileAsync(join(reportDir, mdFile), generateSkillReportMd(result));
      }
      await writeFileAsync(jsonPath, JSON.stringify(result, null, 2) + "\n");

      // Update or remove failures
      const remaining = result.scenarioResults.filter((j) => j.invocationError !== null);
      if (remaining.length === 0) {
        const { unlink } = await import("fs/promises");
        await unlink(failuresPath);
        console.log("\nAll failures recovered. Failures file removed.");
      } else {
        const remainingData = remaining.map((j) => ({
          scenario: j.scenario.name,
          category: j.scenario.category,
          tier: j.scenario.tier,
          error: j.invocationError,
          filePath: j.scenario.filePath,
        }));
        await writeFileAsync(failuresPath, JSON.stringify(remainingData, null, 2) + "\n");
        console.log(`\n${remaining.length} scenarios still failing.`);
      }

      console.log("\n" + report);
    }

    process.exit(0);
  }

  // Unknown command
  console.error(`Error: unknown command "${command}"`);
  console.log(USAGE);
  process.exit(1);
}

// ─── Argument Parser ──────────────────────────────────────────

interface EvaluateArgs {
  skillDirs: string[];
  ci: boolean;
  tiers: TierName[];
  compare: boolean;
  concurrency: number;
  model: string;
  skillModel: string;
}

function parseEvaluateArgs(args: string[]): EvaluateArgs | null {
  const skillDirs: string[] = [];
  let ci = false;
  let tiers: TierName[] = ["basic", "intermediate", "adversarial"];
  let compare = false;
  let concurrency = 20;
  let model = process.env.BENCH_JUDGE_MODEL || "anthropic/claude-opus-4-6";
  let skillModel = process.env.BENCH_SKILL_MODEL || "anthropic/claude-sonnet-4-6";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--ci") {
      ci = true;
    } else if (arg === "--tier") {
      const val = args[++i];
      if (val === "all") {
        tiers = ["basic", "intermediate", "adversarial"];
      } else {
        const parts = val.split(",") as TierName[];
        const valid = ["basic", "intermediate", "adversarial"];
        for (const p of parts) {
          if (!valid.includes(p)) {
            console.error(`Error: invalid tier "${p}". Valid: ${valid.join(", ")}`);
            return null;
          }
        }
        tiers = parts;
      }
    } else if (arg === "--compare") {
      compare = true;
    } else if (arg === "--concurrency") {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1 || val > 50) {
        console.error("Error: --concurrency must be between 1 and 50");
        return null;
      }
      concurrency = val;
    } else if (arg === "--model") {
      model = args[++i];
      if (!model) {
        console.error("Error: --model requires a value");
        return null;
      }
    } else if (arg === "--skill-model") {
      skillModel = args[++i];
      if (!skillModel) {
        console.error("Error: --skill-model requires a value");
        return null;
      }
    } else if (arg.startsWith("--")) {
      console.error(`Error: unknown option "${arg}"`);
      return null;
    } else {
      // Positional arg = skill directory
      if (!existsSync(arg)) {
        console.error(`Error: path not found: ${arg}`);
        return null;
      }
      if (!statSync(arg).isDirectory()) continue;
      // Validate skill directory has SKILL.md — skip without SKILL.md
      const skillMdPath = join(arg, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        console.warn(`  [SKIP] ${basename(arg)} — no SKILL.md found`);
        continue;
      }
      skillDirs.push(arg);
    }
  }

  if (skillDirs.length === 0) {
    console.error("Error: at least one skill directory is required.");
    console.log("\nUsage: crypto-skill-bench evaluate <skill-dir> [skill-dir2 ...] [options]");
    return null;
  }

  return { skillDirs, ci, tiers, compare, concurrency, model, skillModel };
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
