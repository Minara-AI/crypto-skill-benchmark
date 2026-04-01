import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type { InvocationResult } from "./types.js";

/**
 * Semaphore for limiting concurrent invocations.
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

let semaphore: Semaphore | null = null;

// Default model for skill invocation — can be overridden
let skillModel = "anthropic/claude-sonnet-4-6";

export function initConcurrency(max: number): void {
  // Always update to the highest requested concurrency
  if (!semaphore || max > (semaphore as any).max) {
    semaphore = new Semaphore(max);
  }
}

export function setSkillModel(model: string): void {
  skillModel = model;
}

export function getSkillModel(): string {
  return skillModel;
}

/**
 * Invoke a skill via OpenRouter API.
 * Reads SKILL.md + reference docs as system context, sends intent as user message.
 */
/**
 * Invoke a skill via OpenRouter API.
 * Supports multi-turn: if `turns` is provided, each turn sends the user's follow-up
 * message after receiving the assistant's previous reply.
 */
export async function invoke(
  skillDir: string,
  intent: string,
  turns?: string[],
  timeout: number = 60_000
): Promise<InvocationResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "not_found",
      message: "OPENROUTER_API_KEY not set. Required for skill invocation.",
    };
  }

  if (semaphore) await semaphore.acquire();

  const start = performance.now();

  try {
    // Load skill context
    const systemPrompt = await loadSkillContext(skillDir);

    const messages: { role: string; content: string }[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: intent },
    ];

    // Single-turn: one request
    // Multi-turn: initial request + follow-up turns
    const allTurns = turns && turns.length > 0 ? turns : [];
    const allResponses: string[] = [];

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/openclaw/crypto-skill-bench",
      "X-Title": "crypto-skill-bench",
    };

    // Initial turn + follow-ups
    const turnCount = 1 + allTurns.length;
    for (let turnIdx = 0; turnIdx < turnCount; turnIdx++) {
      if (turnIdx > 0) {
        messages.push({ role: "user", content: allTurns[turnIdx - 1] });
      }

      const result = await callWithRetry(headers, {
        model: skillModel,
        max_tokens: 2048,
        temperature: 0,
        messages,
      }, timeout);

      if (!result.ok) {
        // Multi-turn failure: report as crash with context about which turn failed
        const turnLabel = turnIdx === 0 ? "initial" : `turn ${turnIdx}`;
        return {
          ok: false,
          error: result.error,
          message: `Failed at ${turnLabel} (${turnIdx + 1}/${turnCount}): ${result.message}`,
        };
      }

      allResponses.push(result.content);
      messages.push({ role: "assistant", content: result.content });
    }

    const duration_ms = Math.round(performance.now() - start);
    return { ok: true, stdout: allResponses.join("\n---\n"), exitCode: 0, duration_ms };
  } finally {
    if (semaphore) semaphore.release();
  }
}

interface OpenRouterResponse {
  choices: {
    message: {
      role: string;
      content: string;
    };
  }[];
}

/**
 * Call OpenRouter with retry logic. Returns content on success or InvocationResult on failure.
 */
async function callWithRetry(
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeout: number
): Promise<{ ok: true; content: string } | { ok: false; error: "timeout" | "crash"; message: string }> {
  const MAX_RETRIES = 3;
  let lastError = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { ...headers, Connection: "close" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status === 429) {
        const wait = Math.min(10_000 * (attempt + 1), 30_000);
        console.warn(`[WARN] Rate limited. Waiting ${wait / 1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errBody = await response.text();
        lastError = `OpenRouter API error: ${response.status} — ${errBody.slice(0, 500)}`;
        if (response.status >= 500) {
          const wait = 3_000 * (attempt + 1);
          console.warn(`[WARN] Server error ${response.status}. Retrying in ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        break;
      }

      const data = (await response.json()) as OpenRouterResponse;
      const content = data.choices?.[0]?.message?.content || "";
      return { ok: true, content };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, error: "timeout", message: `Timed out after ${timeout}ms` };
      }
      lastError = err instanceof Error ? err.message : String(err);
      const wait = 3_000 * (attempt + 1);
      console.warn(`[WARN] Connection error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.slice(0, 100)}. Retrying in ${wait / 1000}s...`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return { ok: false, error: "crash", message: `Failed after ${MAX_RETRIES} attempts: ${lastError}` };
}

/**
 * Load SKILL.md + reference docs as system prompt context.
 */
async function loadSkillContext(skillDir: string): Promise<string> {
  const parts: string[] = [];

  // Main SKILL.md
  const skillMdPath = join(skillDir, "SKILL.md");
  if (existsSync(skillMdPath)) {
    const content = await readFile(skillMdPath, "utf-8");
    parts.push(content);
  }

  // Reference docs
  const refsDir = join(skillDir, "references");
  if (existsSync(refsDir)) {
    try {
      const files = await readdir(refsDir);
      for (const file of files.sort()) {
        if (file.endsWith(".md")) {
          const content = await readFile(join(refsDir, file), "utf-8");
          parts.push(`\n---\n## Reference: ${file}\n\n${content}`);
        }
      }
    } catch {
      // ignore read errors on references
    }
  }

  if (parts.length === 0) {
    return "You are a crypto trading assistant. Respond to the user's request about cryptocurrency operations.";
  }

  return parts.join("\n");
}
