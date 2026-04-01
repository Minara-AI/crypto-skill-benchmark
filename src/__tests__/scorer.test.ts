import { describe, test, expect } from "vitest";
import { aggregate, checkInstantFail } from "../scorer.js";
import type { ScenarioJudgment, DimensionsConfig, Scenario } from "../types.js";

const mockDimensionsConfig: DimensionsConfig = {
  dimensions: {
    safety: { weight: 30, description: "safety", instant_fail_rules: [] },
    coverage: { weight: 25, description: "coverage" },
    robustness: { weight: 20, description: "robustness" },
    routing: { weight: 15, description: "routing" },
    ux: { weight: 10, description: "ux" },
  },
};

function makeScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    name: "test-scenario",
    category: "core",
    tier: "basic",
    intent: "test intent",
    expected: {},
    dimensions_tested: ["safety", "routing"],
    source: "public",
    filePath: "/test/scenario.yaml",
    ...overrides,
  };
}

function makeJudgment(
  dimScores: Record<string, number>,
  instantFail = false,
  scenario?: Partial<Scenario>
): ScenarioJudgment {
  return {
    scenario: makeScenario(scenario),
    transcript: { toolCalls: [], assistantMessages: [], hasConfirmation: true, raw: "" },
    invocationError: null,
    dimensionResults: Object.fromEntries(
      Object.entries(dimScores).map(([k, v]) => [k, { score: v as 0 | 0.25 | 0.5 | 0.75 | 1.0, reasoning: "test" }])
    ),
    instantFailTriggered: instantFail,
  };
}

describe("scorer.aggregate", () => {
  test("computes quality score from weighted averages", () => {
    const judgments = [
      makeJudgment({ safety: 1.0, routing: 1.0 }),
      makeJudgment({ safety: 1.0, routing: 0.5 }),
    ];

    const result = aggregate(judgments, mockDimensionsConfig, "test", "1.0", "1.0");

    // safety: avg 1.0, weighted = 30. routing: avg 0.75, weighted = 11.25.
    expect(result.qualityScore).toBe(41); // round(30 + 11.25)
    expect(result.dimensions.safety.rawAverage).toBe(1.0);
    expect(result.dimensions.routing.rawAverage).toBe(0.75);
  });

  test("Safety Gate FAIL when instant-fail triggered", () => {
    const judgments = [
      makeJudgment({ safety: 0, routing: 1.0 }, true),
      makeJudgment({ safety: 1.0, routing: 1.0 }),
    ];

    const result = aggregate(judgments, mockDimensionsConfig, "test", "1.0", "1.0");

    expect(result.safetyGate).toBe("FAIL");
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  test("Safety Gate PASS when no instant-fail", () => {
    const judgments = [
      makeJudgment({ safety: 1.0, routing: 1.0 }),
    ];

    const result = aggregate(judgments, mockDimensionsConfig, "test", "1.0", "1.0");
    expect(result.safetyGate).toBe("PASS");
  });

  test("stores raw averages and weights separately", () => {
    const judgments = [makeJudgment({ safety: 1.0, routing: 0.5 })];

    const result = aggregate(judgments, mockDimensionsConfig, "test", "1.0", "1.0");

    expect(result.dimensions.safety.rawAverage).toBe(1.0);
    expect(result.dimensions.safety.weight).toBe(30);
    expect(result.dimensions.routing.rawAverage).toBe(0.5);
    expect(result.dimensions.routing.weight).toBe(15);
  });

  test("skips dimensions with 0 scenarios", () => {
    const judgments = [makeJudgment({ safety: 1.0 })];

    const result = aggregate(judgments, mockDimensionsConfig, "test", "1.0", "1.0");

    expect(result.dimensions.safety).toBeDefined();
    expect(result.dimensions.robustness).toBeUndefined();
  });
});

describe("scorer.checkInstantFail", () => {
  test("triggers when safety scores 0", () => {
    const judgment = makeJudgment({ safety: 0 });
    expect(checkInstantFail(judgment)).toBe(true);
  });

  test("does not trigger on partial safety score", () => {
    const judgment: ScenarioJudgment = {
      scenario: makeScenario({ expected: { confirms_before_execution: true } }),
      transcript: { toolCalls: [], assistantMessages: [], hasConfirmation: false, raw: "" },
      invocationError: null,
      dimensionResults: { safety: { score: 0.5, reasoning: "partial" } },
      instantFailTriggered: false,
    };
    expect(checkInstantFail(judgment)).toBe(false);
  });

  test("does not trigger for normal pass", () => {
    const judgment = makeJudgment({ safety: 1.0, routing: 1.0 });
    expect(checkInstantFail(judgment)).toBe(false);
  });
});
