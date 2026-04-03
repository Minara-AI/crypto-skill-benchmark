import { z } from "zod";

// ─── Scenario Schema ───────────────────────────────────────────

export const DimensionName = z.enum([
  "safety",
  "routing",
  "robustness",
  "coverage",
  "ux",
]);
export type DimensionName = z.infer<typeof DimensionName>;

export const TierName = z.enum(["basic", "intermediate", "adversarial"]);
export type TierName = z.infer<typeof TierName>;

export const ScenarioSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["core", "adversarial"]),
  tier: TierName,
  intent: z.string().min(1),
  // Multi-turn: optional array of follow-up user messages after the initial intent.
  // Each turn simulates the user responding to the skill's previous reply.
  turns: z.array(z.string()).optional(),
  context: z
    .object({
      chain: z.string().optional(),
      balance: z.record(z.number()).optional(),
      note: z.string().optional(),
    })
    .optional(),
  expected: z.object({
    confirms_before_execution: z.boolean().optional(),
    correct_command: z.string().optional(),
    correct_args: z.record(z.string()).optional(),
    shows_summary: z.boolean().optional(),
    warns_about_unknown_token: z.boolean().optional(),
    does_not_execute_blindly: z.boolean().optional(),
    suggests_alternatives: z.boolean().optional(),
  }),
  dimensions_tested: z.array(DimensionName).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema> & {
  source: "public" | "secret";
  filePath: string;
};

// ─── Dimension Config ──────────────────────────────────────────

export interface DimensionConfig {
  weight: number;
  description: string;
  instant_fail_rules?: string[];
}

export interface DimensionsConfig {
  dimensions: Record<string, DimensionConfig>;
}


// ─── Transcript ────────────────────────────────────────────────

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Transcript {
  toolCalls: ToolCall[];
  assistantMessages: string[];
  hasConfirmation: boolean;
  raw: string;
}

// ─── Invocation ────────────────────────────────────────────────

export type InvocationResult =
  | { ok: true; stdout: string; exitCode: number; duration_ms: number }
  | { ok: false; error: "timeout" | "crash" | "not_found"; message: string };

// ─── Judge ─────────────────────────────────────────────────────

export interface JudgeResult {
  score: 0 | 0.25 | 0.5 | 0.75 | 1.0;
  reasoning: string;
}

export interface ScenarioJudgment {
  scenario: Scenario;
  transcript: Transcript | null;
  invocationError: string | null;
  dimensionResults: Record<string, JudgeResult>;
  instantFailTriggered: boolean;
}

// ─── Scoring ───────────────────────────────────────────────────

export interface DimensionScore {
  rawAverage: number; // 0.0-1.0
  weight: number;
  weightedScore: number; // rawAverage * weight
  scenarioCount: number;
}

export interface BenchmarkResult {
  skillName: string;
  skillVersion: string;
  claudeVersion: string;
  timestamp: string;
  safetyGate: "PASS" | "CAUTION" | "FAIL";
  safetyGateReasons: string[];
  qualityScore: number; // 0-100
  dimensions: Record<string, DimensionScore>;
  scenarioResults: ScenarioJudgment[];
  totalScenarios: number;
  scenariosPassed: number;
  scenariosPartial: number;
  scenariosFailed: number;
}

// ─── Store ─────────────────────────────────────────────────────

export interface HistoryEntry {
  ts: string;
  skill: string;
  version: string;
  claude_version: string;
  total_score: number;
  safety_gate: "PASS" | "CAUTION" | "FAIL";
  raw_scores: Record<string, number>;
  weights: Record<string, number>;
  scenarios_passed: number;
  scenarios_failed: number;
}

// ─── Static Analysis ───────────────────────────────────────────

export interface StaticCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface StaticAnalysisResult {
  checks: StaticCheck[];
  warnings: string[];
  subSkillCount: number;
  routingEntries: number;
  hasConfirmationPolicy: boolean;
}

// ─── CLI Options ───────────────────────────────────────────────

export interface CLIOptions {
  skillDir: string;
  ci: boolean;
  tiers: TierName[];
  compare: boolean;
  concurrency: number;
  skillsbenchExport: boolean;
  model: string;
  skillModel: string;
}
