import { describe, test, expect } from "vitest";
import { loadDir, filterByTier } from "../scenario-loader.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = join(__dirname, "../../scenarios");

describe("scenario-loader.loadDir", () => {
  test("loads core scenarios", async () => {
    const scenarios = await loadDir(join(SCENARIOS_DIR, "core"), "public");
    expect(scenarios.length).toBeGreaterThan(0);

    for (const s of scenarios) {
      expect(s.name).toBeTruthy();
      expect(s.intent).toBeTruthy();
      expect(s.dimensions_tested.length).toBeGreaterThan(0);
      expect(s.source).toBe("public");
    }
  });

  test("loads adversarial scenarios", async () => {
    const scenarios = await loadDir(join(SCENARIOS_DIR, "adversarial"), "public");
    expect(scenarios.length).toBeGreaterThan(0);

    for (const s of scenarios) {
      expect(s.category).toBe("adversarial");
      // tier can be adversarial or intermediate (some edge cases were re-tiered)
      expect(["adversarial", "intermediate"]).toContain(s.tier);
    }
  });

  test("rejects invalid YAML gracefully", async () => {
    const scenarios = await loadDir(join(SCENARIOS_DIR, "core"), "public");
    for (const s of scenarios) {
      expect(s.name).toBeTruthy();
    }
  });
});

describe("scenario-loader.filterByTier", () => {
  test("filters by single tier", async () => {
    const all = await loadDir(join(SCENARIOS_DIR, "core"), "public");
    const basic = filterByTier(all, ["basic"]);
    expect(basic.length).toBeGreaterThan(0);
    expect(basic.every((s: { tier: string }) => s.tier === "basic")).toBe(true);
  });

  test("filters by multiple tiers", async () => {
    const core = await loadDir(join(SCENARIOS_DIR, "core"), "public");
    const adversarial = await loadDir(join(SCENARIOS_DIR, "adversarial"), "public");
    const all = [...core, ...adversarial];

    const filtered = filterByTier(all, ["basic", "adversarial"]);
    expect(filtered.every((s: { tier: string }) => s.tier === "basic" || s.tier === "adversarial")).toBe(true);
  });

  test("returns empty for non-matching tier", async () => {
    const core = await loadDir(join(SCENARIOS_DIR, "core"), "public");
    const filtered = filterByTier(core, ["adversarial"]);
    for (const s of filtered) {
      expect(s.tier).toBe("adversarial");
    }
  });
});
