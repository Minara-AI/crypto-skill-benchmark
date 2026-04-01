import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

const CONFIG_DIR = join(process.env.HOME || "~", ".crypto-skill-bench");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  openrouter_api_key?: string;
}

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Ensure OPENROUTER_API_KEY is available.
 * Priority: env var > .env file > stored config > interactive prompt.
 */
export async function ensureApiKey(): Promise<void> {
  if (process.env.OPENROUTER_API_KEY) return;

  // Check stored config
  const config = loadConfig();
  if (config.openrouter_api_key) {
    process.env.OPENROUTER_API_KEY = config.openrouter_api_key;
    return;
  }

  // Interactive prompt
  console.log("\nOpenRouter API key not found.");
  console.log("Get one at: https://openrouter.ai/keys\n");

  const key = await prompt("Enter your OpenRouter API key: ");

  if (!key || key.trim().length === 0) {
    console.error("Error: API key is required.");
    process.exit(1);
  }

  const trimmed = key.trim();
  process.env.OPENROUTER_API_KEY = trimmed;

  // Ask to save
  const save = await prompt("Save key for future use? (Y/n): ");
  if (!save || save.trim().toLowerCase() !== "n") {
    config.openrouter_api_key = trimmed;
    saveConfig(config);
    console.log(`Saved to ${CONFIG_FILE}\n`);
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
