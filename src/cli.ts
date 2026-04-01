#!/usr/bin/env node

import "dotenv/config";
import { existsSync, statSync } from "fs";
import { basename } from "path";
import type { CLIOptions, TierName } from "./types.js";
import { run, writeSkillReport } from "./runner.js";
import { setJudgeModel, getJudgeModel } from "./judge.js";
import { setSkillModel, getSkillModel } from "./skill-invoker.js";

const USAGE = `
crypto-skill-bench — Benchmark framework for crypto skills

USAGE:
  crypto-skill-bench evaluate <skill-dir> [skill-dir2 ...] [options]
  crypto-skill-bench pull [--force]
  crypto-skill-bench list

COMMANDS:
  evaluate <dirs...>      Evaluate one or more skill directories
  pull                    Pull/update all skills from registry.yaml
  list                    List all pulled skills with versions

OPTIONS:
  --ci                    CI mode: exit 1 if safety gate fails
  --tier TIER             Scenario tiers to run: basic, intermediate, adversarial, all
                          (default: all. Comma-separated.)
  --compare               Show score delta from last run
  --concurrency N         Max parallel API calls (default: 10)
  --model MODEL           OpenRouter model ID for LLM judge (default: anthropic/claude-opus-4-6)
  --skill-model MODEL     OpenRouter model ID for skill invocation (default: anthropic/claude-sonnet-4-6)
  --force                 Re-pull all skills (pull only)
  --help                  Show this help

ENVIRONMENT:
  OPENROUTER_API_KEY      Required. Get one at https://openrouter.ai/keys
  BENCH_JUDGE_MODEL       Override judge model (same as --model flag)
  BENCH_SKILL_MODEL       Override skill invocation model (same as --skill-model flag)

EXAMPLES:
  # Pull skills from registry
  crypto-skill-bench pull

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

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  // ── pull ──────────────────────────────────────────────────
  if (command === "pull") {
    const { pullAll } = await import("./registry.js");
    const force = args.includes("--force");
    console.log(`\nPulling skills from registry...${force ? " (force)" : ""}`);
    const { pulled, skipped, errors } = await pullAll({ force });

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
    console.log("  Name".padEnd(42) + "Category".padEnd(14) + "Version".padEnd(12) + "Commit");
    console.log("  " + "─".repeat(70));

    for (const s of skills) {
      console.log(
        `  ${s.name.padEnd(40)}${s.category.padEnd(14)}${s.version.padEnd(12)}${s.commit.slice(0, 8)}`
      );
    }
    console.log("");
    process.exit(0);
  }

  // ── evaluate ───────────────────────────────────────────────
  if (command === "evaluate") {
    const evalArgs = parseEvaluateArgs(args.slice(1));
    if (!evalArgs) process.exit(1);

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

      const { result, report, exitCode } = await run(options);
      const skillName = basename(options.skillDir);
      await writeSkillReport(skillName, result, report);
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

      console.log(`\n${"═".repeat(50)}`);
      console.log(`EVALUATE COMPLETE: ${passed} passed, ${failed} failed`);
      console.log(`Report: ${reportPath}`);
      console.log(`${"═".repeat(50)}`);

      process.exit(failed > 0 && evalArgs.ci ? 1 : 0);
    }
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
      // Positional arg = skill directory (skip non-directories)
      if (!existsSync(arg)) {
        console.error(`Error: Skill directory not found: ${arg}`);
        return null;
      }
      if (!statSync(arg).isDirectory()) continue;
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
