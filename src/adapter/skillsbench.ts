import type { BenchmarkResult } from "../types.js";

/**
 * SkillsBench v1 evaluation format.
 * Interface only for MVP — implementation deferred to post-dogfood.
 *
 * Dimension mapping:
 *   safety       -> Safety
 *   accuracy     -> Correctness
 *   resilience   -> Robustness
 *   error_handling -> Reliability
 *   ux           -> Usability
 *   completeness -> Coverage
 */
export interface SkillsBenchResult {
  version: "1.0";
  skill: string;
  timestamp: string;
  overall_score: number;
  dimensions: {
    name: string;
    score: number;
    max_score: number;
  }[];
  metadata: Record<string, unknown>;
}

const DIMENSION_MAP: Record<string, string> = {
  safety: "Safety",
  accuracy: "Correctness",
  resilience: "Robustness",
  error_handling: "Reliability",
  ux: "Usability",
  completeness: "Coverage",
};

export function toSkillsBenchFormat(
  _result: BenchmarkResult
): SkillsBenchResult {
  throw new Error(
    "SkillsBench adapter not yet implemented. " +
      "Interface defined, implementation deferred to post-dogfood. " +
      "See: https://github.com/openclaw/crypto-skill-bench/issues/1"
  );
}

/** Export the dimension mapping for reference */
export { DIMENSION_MAP };
