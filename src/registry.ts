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
    skills = skills.filter((s) => s.official !== false);
  } else if (scope === "community") {
    skills = skills.filter((s) => s.official === false);
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

  // Group skills by source repo to download each tarball only once
  const repoGroups = new Map<string, typeof skills>();
  for (const entry of skills) {
    const sourceRepo = (entry.github_repo && entry.github_path) ? entry.github_repo : registry.repo;
    const group = repoGroups.get(sourceRepo) || [];
    group.push(entry);
    repoGroups.set(sourceRepo, group);
  }

  // Pre-download aggregator tarball (used by most skills + fallback for direct repos)
  let aggregatorTarball: string | null = null;
  if (repoGroups.has(registry.repo) || repoGroups.size > 1) {
    try {
      console.log(`\n  Downloading cryptoskill.org...`);
      aggregatorTarball = await downloadTarball(registry.repo, registry.branch);
    } catch (err) {
      console.warn(`  [WARN] Failed to pre-download aggregator tarball: ${err}`);
    }
  }

  // Download and extract per repo
  for (const [sourceRepo, repoSkills] of repoGroups) {
    const sourceBranch = "main";
    const repoName = sourceRepo.split("/")[1];
    const isAggregator = sourceRepo === registry.repo;

    // Get HEAD commit for this repo
    let repoHeadCommit: string;
    try {
      repoHeadCommit = isAggregator ? headCommit : await getRemoteHead(sourceRepo, sourceBranch);
    } catch {
      repoHeadCommit = headCommit;
    }

    // Check if any skill in this group needs pulling
    const needsPull = repoSkills.some((entry) => {
      const skillDir = join(SKILLS_DIR, entry.name);
      const lockEntry = lock?.skills.find((s) => s.name === entry.name);
      if (options.force) return true;
      if (!lockEntry || !existsSync(skillDir)) return true;
      return lockEntry.commit !== repoHeadCommit;
    });

    if (!needsPull) {
      for (const entry of repoSkills) {
        const lockEntry = lock?.skills.find((s) => s.name === entry.name);
        console.log(`  [SKIP] ${entry.name} (already at ${repoHeadCommit.slice(0, 8)})`);
        skipped.push(entry.name);
        if (lockEntry) lockEntries.push(lockEntry);
      }
      continue;
    }

    // Download tarball once for this repo (reuse aggregator if already downloaded)
    const sourceLabel = isAggregator ? "cryptoskill.org" : sourceRepo;

    let tarballPath: string | null = null;
    let actualRepoName = repoName;
    let fallbackToAggregator = false;

    if (isAggregator && aggregatorTarball) {
      tarballPath = aggregatorTarball;
    } else {
      console.log(`\n  Downloading ${sourceLabel}...`);
      try {
        tarballPath = await downloadTarball(sourceRepo, sourceBranch);
      } catch (err) {
        if (!isAggregator && aggregatorTarball) {
          console.warn(`  [WARN] Failed to download ${sourceLabel}, falling back to cryptoskill.org`);
          tarballPath = aggregatorTarball;
          actualRepoName = registry.repo.split("/")[1];
          fallbackToAggregator = true;
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [ERROR] Failed to download ${sourceLabel}: ${msg}`);
          for (const entry of repoSkills) {
            errors.push(`${entry.name}: tarball download failed`);
            const lockEntry = lock?.skills.find((s) => s.name === entry.name);
            if (lockEntry) lockEntries.push(lockEntry);
          }
          continue;
        }
      }
    }

    // Extract each skill from the tarball
    for (const entry of repoSkills) {
      const skillDir = join(SKILLS_DIR, entry.name);
      const lockEntry = lock?.skills.find((s) => s.name === entry.name);
      // Use aggregator path when falling back, otherwise use direct path
      const sourcePath = fallbackToAggregator ? entry.path : ((entry.github_repo && entry.github_path) ? entry.github_path! : entry.path);

      if (
        !options.force &&
        lockEntry &&
        lockEntry.commit === repoHeadCommit &&
        existsSync(skillDir)
      ) {
        console.log(`  [SKIP] ${entry.name} (already at ${repoHeadCommit.slice(0, 8)})`);
        skipped.push(entry.name);
        lockEntries.push(lockEntry);
        continue;
      }

      try {
        console.log(`  [PULL] ${entry.name} ...`);
        await extractSkillFromTarball(tarballPath!, actualRepoName, sourceBranch, sourcePath, skillDir);

        const version = await extractVersion(skillDir);

        lockEntries.push({
          name: entry.name,
          category: entry.category,
          official: entry.official !== false,
          version,
          commit: repoHeadCommit,
          pulled_at: new Date().toISOString(),
          path: entry.path,
        });

        pulled.push(entry.name);
        console.log(`         v${version}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [ERROR] ${entry.name}: ${msg}`);
        errors.push(`${entry.name}: ${msg}`);
        if (lockEntry) lockEntries.push(lockEntry);
      }
    }

    // Clean up tarball (don't delete aggregator — may be reused as fallback)
    if (tarballPath && tarballPath !== aggregatorTarball) {
      try { await rm(tarballPath); } catch { /* ignore */ }
    }
  }

  // Clean up aggregator tarball
  if (aggregatorTarball) {
    try { await rm(aggregatorTarball); } catch { /* ignore */ }
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
    const output = execSync(`git ls-remote https://github.com/${repo}.git ${branch} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    if (!output) throw new Error(`Failed to get HEAD for ${repo}@${branch}`);
    return output.split("\t")[0];
  } catch (err) {
    throw new Error(`Failed to get HEAD for ${repo}@${branch}: ${err}`);
  }
}

/**
 * Download a repo tarball once to a temp file.
 * Returns the temp file path. Caller must clean up.
 */
async function downloadTarball(repo: string, branch: string): Promise<string> {
  const tarUrl = `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`;
  const tmpFile = join(SKILLS_DIR, `.tarball-${repo.replace("/", "-")}-${Date.now()}.tar.gz`);

  try {
    execSync(`curl -sL "${tarUrl}" -o "${tmpFile}"`, {
      timeout: 120_000,
      encoding: "utf-8",
    });
  } catch (err) {
    throw new Error(`Failed to download tarball for ${repo}: ${err}`);
  }

  if (!existsSync(tmpFile)) {
    throw new Error(`Tarball download failed: ${tmpFile} not found`);
  }

  return tmpFile;
}

/**
 * Extract a skill directory from a local tarball file.
 */
async function extractSkillFromTarball(
  tarballPath: string,
  repoName: string,
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

  const stripPrefix = `${repoName}-${branch}/${remotePath}/`;

  try {
    execSync(
      `tar -xzf "${tarballPath}" --strip-components=${remotePath.split("/").length + 1} -C "${localDir}" "${stripPrefix}"`,
      { timeout: 30_000, encoding: "utf-8" }
    );
  } catch (err) {
    throw new Error(`tar extract failed for ${remotePath}: ${err}`);
  }

  // Verify SKILL.md exists
  if (!existsSync(join(localDir, "SKILL.md"))) {
    const files = await readdir(localDir);
    if (files.length === 0) {
      throw new Error("Empty directory after extraction — skill may not exist in this repo");
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
