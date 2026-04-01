import { readdir, readFile } from "fs/promises";
import { join } from "path";
import yaml from "js-yaml";
import { ScenarioSchema, type Scenario, type TierName } from "./types.js";

export async function loadDir(
  dirPath: string,
  source: "public" | "secret"
): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];
  const entries = await readdir(dirPath, { recursive: true });

  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;

    const filePath = join(dirPath, entry);
    const content = await readFile(filePath, "utf-8");

    // Strip BOM if present
    const clean = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

    let parsed: unknown;
    try {
      parsed = yaml.load(clean);
    } catch (err) {
      console.warn(`[WARN] Skipping ${filePath}: YAML parse error — ${err}`);
      continue;
    }

    const result = ScenarioSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(", ");
      console.warn(`[WARN] Skipping ${filePath}: validation failed — ${issues}`);
      continue;
    }

    scenarios.push({ ...result.data, source, filePath });
  }

  return scenarios;
}

export async function mergeScenarios(
  publicDir: string,
  secretDir?: string,
  ciMode: boolean = false
): Promise<Scenario[]> {
  const publicScenarios = await loadDir(publicDir, "public");

  if (!secretDir) {
    return publicScenarios;
  }

  // Check if secret dir exists
  try {
    await readdir(secretDir);
  } catch {
    if (ciMode) {
      throw new Error(
        `CRYPTO_BENCH_SECRET_DIR is set to "${secretDir}" but directory does not exist. ` +
          `In --ci mode, this is a fatal error (missing adversarial coverage).`
      );
    }
    console.warn(
      `[WARN] CRYPTO_BENCH_SECRET_DIR="${secretDir}" does not exist. Running with public scenarios only.`
    );
    return publicScenarios;
  }

  const secretScenarios = await loadDir(secretDir, "secret");

  // No dedup — both run, tagged by source
  return [...publicScenarios, ...secretScenarios];
}

export function filterByTier(
  scenarios: Scenario[],
  tiers: TierName[]
): Scenario[] {
  return scenarios.filter((s) => tiers.includes(s.tier));
}
