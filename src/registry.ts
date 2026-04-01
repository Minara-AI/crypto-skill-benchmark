import { readFile, writeFile, mkdir, readdir, rm } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { execSync } from "child_process";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
const SKILLS_DIR = join(PROJECT_ROOT, "skills");
const LOCK_FILE = join(SKILLS_DIR, "registry-lock.json");

// ─── Types ────────────────────────────────────────────────────

interface RegistryEntry {
  name: string;
  path: string;
  category: string;
  official?: boolean;     // true = maintained by project team, pulled by default
  github_repo?: string;   // Direct source: e.g. "minara-ai/skills"
  github_path?: string;   // Path within that repo: e.g. "skills/minara"
}

interface RegistryConfig {
  repo: string;
  branch: string;
  skills: RegistryEntry[];
}

interface LockEntry {
  name: string;
  category: string;
  official: boolean;
  version: string;
  commit: string;
  pulled_at: string;
  path: string;
}

interface LockFile {
  pulled_at: string;
  repo: string;
  branch: string;
  commit: string;
  skills: LockEntry[];
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Load registry.yaml from project root.
 */
export async function loadRegistry(): Promise<RegistryConfig> {
  const raw = await readFile(join(PROJECT_ROOT, "registry.yaml"), "utf-8");
  return yaml.load(raw) as RegistryConfig;
}

/**
 * Load lock file (version tracking).
 */
export async function loadLock(): Promise<LockFile | null> {
  if (!existsSync(LOCK_FILE)) return null;
  const raw = await readFile(LOCK_FILE, "utf-8");
  return JSON.parse(raw) as LockFile;
}

export type PullScope = "official" | "community" | "all";

/**
 * Pull skills from the registry.
 *
 * Scope controls which skills are pulled:
 *   - "official"  (default): only skills with `official: true`
 *   - "community": only skills without `official: true`
 *   - "all": every skill in the registry
 *
 * Category optionally filters by skill category (e.g. "exchanges", "defi").
 */
export async function pullAll(options: {
  force?: boolean;
  scope?: PullScope;
  category?: string;
} = {}): Promise<{
  pulled: string[];
  skipped: string[];
  errors: string[];
}> {
  const registry = await loadRegistry();
  const lock = await loadLock();
  const scope = options.scope ?? "official";

  await mkdir(SKILLS_DIR, { recursive: true });

  // Get current HEAD commit of the repo
  const headCommit = await getRemoteHead(registry.repo, registry.branch);
  console.log(`Remote HEAD: ${headCommit.slice(0, 8)} (${registry.repo}@${registry.branch})`);

  // Filter skills by scope and category
  let skills = registry.skills;

  if (scope === "official") {
    skills = skills.filter((s) => s.official === true);
  } else if (scope === "community") {
    skills = skills.filter((s) => !s.official);
  }

  if (options.category) {
    skills = skills.filter((s) => s.category === options.category);
  }

  console.log(`Scope: ${scope} (${skills.length}/${registry.skills.length} skills)`);

  const pulled: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  // Preserve lock entries for skills not in this pull
  const lockEntries: LockEntry[] = [];
  const pulledNames = new Set(skills.map((s) => s.name));
  for (const prev of lock?.skills ?? []) {
    if (!pulledNames.has(prev.name)) {
      lockEntries.push(prev);
    }
  }

  for (const entry of skills) {
    const skillDir = join(SKILLS_DIR, entry.name);
    const lockEntry = lock?.skills.find((s) => s.name === entry.name);

    // Determine source: direct GitHub repo or aggregator
    const useDirectSource = entry.github_repo && entry.github_path;
    const sourceRepo = useDirectSource ? entry.github_repo! : registry.repo;
    const sourcePath = useDirectSource ? entry.github_path! : entry.path;
    const sourceBranch = "main";

    // Get HEAD for this skill's source repo
    let skillHeadCommit: string;
    try {
      skillHeadCommit = useDirectSource
        ? await getRemoteHead(sourceRepo, sourceBranch)
        : headCommit;
    } catch {
      skillHeadCommit = headCommit; // Fallback to aggregator
    }

    // Skip if already at same commit (unless --force)
    if (
      !options.force &&
      lockEntry &&
      lockEntry.commit === skillHeadCommit &&
      existsSync(skillDir)
    ) {
      console.log(`  [SKIP] ${entry.name} (already at ${skillHeadCommit.slice(0, 8)})`);
      skipped.push(entry.name);
      lockEntries.push(lockEntry);
      continue;
    }

    try {
      const sourceLabel = useDirectSource ? sourceRepo : "cryptoskill.org";
      console.log(`  [PULL] ${entry.name} (from ${sourceLabel}) ...`);
      await pullSkill(sourceRepo, sourceBranch, sourcePath, skillDir);

      const version = await extractVersion(skillDir);

      lockEntries.push({
        name: entry.name,
        category: entry.category,
        official: entry.official === true,
        version,
        commit: skillHeadCommit,
        pulled_at: new Date().toISOString(),
        path: entry.path,
      });

      pulled.push(entry.name);
      console.log(`         v${version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${entry.name}: ${msg}`);
      errors.push(`${entry.name}: ${msg}`);

      // Keep old lock entry if exists
      if (lockEntry) lockEntries.push(lockEntry);
    }
  }

  // Write lock file
  const newLock: LockFile = {
    pulled_at: new Date().toISOString(),
    repo: registry.repo,
    branch: registry.branch,
    commit: headCommit,
    skills: lockEntries,
  };
  await writeFile(LOCK_FILE, JSON.stringify(newLock, null, 2) + "\n");

  return { pulled, skipped, errors };
}

/**
 * List all pulled skills with their versions.
 */
export async function listSkills(): Promise<LockEntry[]> {
  const lock = await loadLock();
  return lock?.skills ?? [];
}

/**
 * Get the local directory for a skill.
 */
export function getSkillDir(name: string): string {
  return join(SKILLS_DIR, name);
}

/**
 * Get all skill directories that exist locally.
 */
export async function getLocalSkills(): Promise<string[]> {
  if (!existsSync(SKILLS_DIR)) return [];
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// ─── Internal ─────────────────────────────────────────────────

async function getRemoteHead(repo: string, branch: string): Promise<string> {
  try {
    const output = execSync(`git ls-remote https://github.com/${repo}.git ${branch}`, {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (!output) throw new Error(`Failed to get HEAD for ${repo}@${branch}`);
    return output.split("\t")[0];
  } catch (err) {
    throw new Error(`Failed to get HEAD for ${repo}@${branch}: ${err}`);
  }
}

async function pullSkill(
  repo: string,
  branch: string,
  remotePath: string,
  localDir: string
): Promise<void> {
  // Preserve local-only files (SOURCE.md, etc.) before cleaning
  const preserveFiles = ["SOURCE.md", "source.md"];
  const preserved: Map<string, string> = new Map();

  if (existsSync(localDir)) {
    for (const file of preserveFiles) {
      const filePath = join(localDir, file);
      if (existsSync(filePath)) {
        preserved.set(file, await readFile(filePath, "utf-8"));
      }
    }
    await rm(localDir, { recursive: true });
  }
  await mkdir(localDir, { recursive: true });

  // Download via GitHub API tarball, extract specific directory
  const tarUrl = `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`;

  // The tar archive has a root dir like "cryptoskill-main/"
  const repoName = repo.split("/")[1];
  const stripPrefix = `${repoName}-${branch}/${remotePath}/`;

  try {
    execSync(
      `curl -sL "${tarUrl}" | tar -xz --strip-components=${remotePath.split("/").length + 1} -C "${localDir}" "${stripPrefix}"`,
      { timeout: 60_000, encoding: "utf-8" }
    );
  } catch (err) {
    throw new Error(`tar extract failed: ${err}`);
  }

  // Verify SKILL.md exists
  if (!existsSync(join(localDir, "SKILL.md"))) {
    const files = await readdir(localDir);
    if (files.length === 0) {
      throw new Error("Empty directory after extraction");
    }
  }

  // Restore preserved local-only files
  for (const [file, content] of preserved) {
    await writeFile(join(localDir, file), content);
  }
}

async function extractVersion(skillDir: string): Promise<string> {
  try {
    const skillMd = await readFile(join(skillDir, "SKILL.md"), "utf-8");
    const match = skillMd.match(/version:\s*["']?([^"'\n]+)/);
    return match?.[1]?.trim() || "unknown";
  } catch {
    return "unknown";
  }
}
