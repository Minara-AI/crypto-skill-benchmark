import { readFile, readdir } from "fs/promises";
import { join } from "path";
import type { StaticAnalysisResult, StaticCheck } from "./types.js";

/**
 * Static analysis of a skill directory.
 * Runs BEFORE dynamic testing as a pre-flight check.
 * Results appear in the report appendix, not in the score.
 */
export async function analyze(skillDir: string): Promise<StaticAnalysisResult> {
  const checks: StaticCheck[] = [];
  const warnings: string[] = [];
  let subSkillCount = 0;
  let routingEntries = 0;
  let hasConfirmationPolicy = false;

  // 1. Check SKILL.md exists
  let skillMd = "";
  try {
    skillMd = await readFile(join(skillDir, "SKILL.md"), "utf-8");
    checks.push({
      name: "SKILL.md exists",
      passed: true,
      detail: `Found SKILL.md (${skillMd.length} bytes)`,
    });
  } catch {
    checks.push({
      name: "SKILL.md exists",
      passed: false,
      detail: "SKILL.md not found in skill directory",
    });
    return { checks, warnings, subSkillCount, routingEntries, hasConfirmationPolicy };
  }

  // 2. Check frontmatter has name and version
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const hasName = /^name:/m.test(fm);
    const hasVersion = /^version:/m.test(fm);
    checks.push({
      name: "Frontmatter completeness",
      passed: hasName && hasVersion,
      detail: hasName && hasVersion
        ? "name and version present"
        : `Missing: ${!hasName ? "name " : ""}${!hasVersion ? "version" : ""}`,
    });
  } else {
    checks.push({
      name: "Frontmatter completeness",
      passed: false,
      detail: "No YAML frontmatter found",
    });
  }

  // 3. Check for confirmation/safety policy
  const confirmPatterns = [
    /confirm/i,
    /fund.?moving/i,
    /user.*approval/i,
    /ask.*before/i,
  ];
  hasConfirmationPolicy = confirmPatterns.some((p) => p.test(skillMd));
  checks.push({
    name: "Confirmation policy declared",
    passed: hasConfirmationPolicy,
    detail: hasConfirmationPolicy
      ? "Found confirmation/fund-moving policy in SKILL.md"
      : "No confirmation policy found. Fund-moving commands may execute without user approval.",
  });

  // 4. Count routing table entries
  // Look for markdown table rows that map intents to commands
  const tableRows = skillMd.match(/^\|[^|]+\|[^|]+\|/gm);
  if (tableRows) {
    // Exclude header and separator rows
    routingEntries = tableRows.filter(
      (row) => !row.includes("---") && !row.toLowerCase().includes("pattern")
    ).length;
  }
  checks.push({
    name: "Routing table",
    passed: routingEntries > 0,
    detail:
      routingEntries > 0
        ? `Found ${routingEntries} routing entries`
        : "No routing table found in SKILL.md",
  });

  // 5. Count sub-skills (reference docs)
  try {
    const refDir = join(skillDir, "references");
    const refs = await readdir(refDir);
    subSkillCount = refs.filter(
      (f) => f.endsWith(".md") && f !== "examples.md"
    ).length;
  } catch {
    // Try alternative structure: sub-directories with SKILL.md
    try {
      const entries = await readdir(skillDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "scripts" && entry.name !== "references") {
          try {
            await readFile(join(skillDir, entry.name, "SKILL.md"), "utf-8");
            subSkillCount++;
          } catch {
            // Not a sub-skill directory
          }
        }
      }
    } catch {
      // No sub-skills found
    }
  }

  checks.push({
    name: "Sub-skill coverage",
    passed: subSkillCount > 0,
    detail:
      subSkillCount > 0
        ? `Found ${subSkillCount} sub-skills/reference docs`
        : "No sub-skills found",
  });

  // 6. Warnings for common issues
  if (skillMd.length > 50000) {
    warnings.push(
      `SKILL.md is very large (${skillMd.length} bytes). Consider splitting into sub-skills.`
    );
  }

  if (!skillMd.includes("error") && !skillMd.includes("Error")) {
    warnings.push("No error handling guidance found in SKILL.md");
  }

  return {
    checks,
    warnings,
    subSkillCount,
    routingEntries,
    hasConfirmationPolicy,
  };
}
