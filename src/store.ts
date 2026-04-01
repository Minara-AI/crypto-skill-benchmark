import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import type { BenchmarkResult, HistoryEntry } from "./types.js";
import { randomBytes } from "crypto";

const STORE_DIR = join(
  process.env.HOME || "~",
  ".crypto-skill-bench"
);

function getHistoryPath(skillName: string): string {
  return join(STORE_DIR, skillName, "history.jsonl");
}

/**
 * Append a benchmark result to the JSONL history file.
 * Uses atomic write: temp file + rename to prevent corruption from concurrent CI.
 */
export async function append(
  skillName: string,
  result: BenchmarkResult
): Promise<void> {
  const historyPath = getHistoryPath(skillName);
  const dir = dirname(historyPath);

  try {
    await mkdir(dir, { recursive: true });
  } catch {
    console.warn(`[WARN] Cannot create history directory: ${dir}`);
    return;
  }

  const entry: HistoryEntry = {
    ts: result.timestamp,
    skill: result.skillName,
    version: result.skillVersion,
    claude_version: result.claudeVersion,
    total_score: result.qualityScore,
    safety_gate: result.safetyGate,
    raw_scores: Object.fromEntries(
      Object.entries(result.dimensions).map(([k, v]) => [k, v.rawAverage])
    ),
    weights: Object.fromEntries(
      Object.entries(result.dimensions).map(([k, v]) => [k, v.weight])
    ),
    scenarios_passed: result.scenariosPassed,
    scenarios_failed: result.scenariosFailed,
  };

  const line = JSON.stringify(entry) + "\n";

  // Atomic write: write to temp, then rename
  const suffix = randomBytes(4).toString("hex");
  const tmpPath = `${historyPath}.tmp-${Date.now()}-${suffix}`;

  try {
    // Read existing content (if any)
    let existing = "";
    if (existsSync(historyPath)) {
      existing = await readFile(historyPath, "utf-8");
    }

    await writeFile(tmpPath, existing + line, "utf-8");
    await rename(tmpPath, historyPath);
  } catch (err) {
    console.warn(`[WARN] Cannot write history (non-fatal): ${err}`);
    // Clean up temp file
    try {
      const { unlink } = await import("fs/promises");
      await unlink(tmpPath);
    } catch {}
  }
}

/**
 * Read the last entry from the history file for --compare.
 * Returns null on first run or corrupted history.
 */
export async function readLast(
  skillName: string
): Promise<HistoryEntry | null> {
  const historyPath = getHistoryPath(skillName);

  if (!existsSync(historyPath)) return null;

  try {
    const content = await readFile(historyPath, "utf-8");
    const lines = content
      .split("\n")
      .filter((l) => l.trim().length > 0);

    if (lines.length === 0) return null;

    // Get second-to-last entry (last is the current run)
    const targetLine = lines.length >= 2 ? lines[lines.length - 2] : null;
    if (!targetLine) return null;

    return JSON.parse(targetLine) as HistoryEntry;
  } catch (err) {
    console.warn(
      `[WARN] History corrupted, starting fresh: ${err}`
    );
    return null;
  }
}
