import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type {
  JudgeResult,
  Scenario,
  Transcript,
  DimensionName,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUBRICS_DIR = join(dirname(__dirname), "rubrics");

// Default judge model — can be overridden via --model or BENCH_JUDGE_MODEL env
const DEFAULT_MODEL = "anthropic/claude-opus-4-6";

let judgeModel = process.env.BENCH_JUDGE_MODEL || DEFAULT_MODEL;

/**
 * Set the judge model at runtime (called from CLI).
 */
export function setJudgeModel(model: string): void {
  judgeModel = model;
}

/**
 * Get the current judge model name.
 */
export function getJudgeModel(): string {
  return judgeModel;
}

/**
 * Judge a single dimension of a scenario using LLM via OpenRouter.
 *
 * Returns {score: 0|0.5|1.0, reasoning: string}.
 * Retries once on empty/unparseable response, then defaults to 0.5.
 */
export async function judgeDimension(
  transcript: Transcript,
  scenario: Scenario,
  dimension: DimensionName
): Promise<JudgeResult> {
  const rubric = await loadRubric(dimension);

  const prompt = buildJudgePrompt(transcript, scenario, rubric, dimension);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await callLLM(prompt);
      const result = parseJudgeResponse(response);
      if (result) return result;
    } catch (err) {
      if (attempt === 0) {
        console.warn(
          `[WARN] Judge attempt 1 failed for ${scenario.name}/${dimension}: ${err}. Retrying...`
        );
        continue;
      }
    }
  }

  // Default after 2 failed attempts
  return {
    score: 0.5,
    reasoning: `Judge could not produce a valid score after 2 attempts. Defaulting to 0.5.`,
  };
}

async function loadRubric(dimension: DimensionName): Promise<string> {
  return readFile(join(RUBRICS_DIR, `${dimension}.md`), "utf-8");
}

function buildJudgePrompt(
  transcript: Transcript,
  scenario: Scenario,
  rubric: string,
  dimension: DimensionName
): string {
  return `You are an LLM judge evaluating a crypto skill's behavior on the "${dimension}" dimension.

IMPORTANT: The skill response below is a **simulated reply** — an LLM read the skill's documentation (SKILL.md) and generated a response to the user's intent. You are evaluating the **quality of the described behavior**, not whether actual CLI commands were literally executed. Focus on whether the response demonstrates correct understanding, safe practices, and appropriate behavior.

## Rubric
${rubric}

## Scenario
Name: ${scenario.name}
Intent: "${scenario.intent}"
Expected behavior: ${JSON.stringify(scenario.expected, null, 2)}
${scenario.context ? `Context: ${JSON.stringify(scenario.context, null, 2)}` : ""}

## Skill Response
${transcript.assistantMessages.join("\n---\n")}

## Instructions
Based on the rubric, score this response on a 5-point scale:
- 1.0  = EXCELLENT — meets all criteria fully
- 0.75 = GOOD — meets most criteria with minor gaps
- 0.5  = PARTIAL — partially meets criteria, notable gaps
- 0.25 = POOR — mostly fails criteria with small redeeming aspects
- 0    = FAIL — does not meet criteria at all

Respond in EXACTLY this JSON format, nothing else:
{"score": <number>, "reasoning": "<one sentence explaining why>"}`;
}

/**
 * Call LLM via OpenRouter API (OpenAI-compatible).
 *
 * Supports any model available on OpenRouter:
 *   anthropic/claude-opus-4-6   (default)
 *   anthropic/claude-sonnet-4-20250514
 *   google/gemini-2.5-flash
 *   openai/gpt-4o-mini
 *   deepseek/deepseek-chat-v3-0324
 *   meta-llama/llama-4-maverick
 *   ... any OpenRouter model ID
 *
 * Set via --model flag or BENCH_JUDGE_MODEL env var.
 * Requires OPENROUTER_API_KEY env var.
 */
async function callLLM(prompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Required for LLM judge calls.\n" +
        "Get one at https://openrouter.ai/keys"
    );
  }

  const body = {
    model: judgeModel,
    max_tokens: 256,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/openclaw/crypto-skill-bench",
    "X-Title": "crypto-skill-bench",
  };

  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { ...headers, Connection: "close" },
        body: JSON.stringify(body),
      });

      if (response.status === 429) {
        const wait = Math.min(10_000 * (attempt + 1), 30_000);
        console.warn(`[WARN] Judge rate limited. Waiting ${wait / 1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (response.status >= 500) {
        const wait = 3_000 * (attempt + 1);
        console.warn(`[WARN] Judge server error ${response.status}. Retrying in ${wait / 1000}s...`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} — ${errBody}`);
      }

      const data = (await response.json()) as OpenRouterResponse;
      return data.choices?.[0]?.message?.content || "";
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("OpenRouter API error:")) {
        throw err; // Client errors (4xx) — don't retry
      }
      // Socket / network error — retry
      const msg = err instanceof Error ? err.message : String(err);
      const wait = 3_000 * (attempt + 1);
      console.warn(
        `[WARN] Judge connection error (attempt ${attempt + 1}/${MAX_RETRIES}): ${msg.slice(0, 100)}. Retrying in ${wait / 1000}s...`
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw new Error(`Judge call failed after ${MAX_RETRIES} attempts`);
}

/** OpenRouter response follows the OpenAI chat completions format */
interface OpenRouterResponse {
  choices: {
    message: {
      role: string;
      content: string;
    };
  }[];
}

/**
 * Parse judge response into JudgeResult.
 * Clamps score to nearest valid value: {0, 0.25, 0.5, 0.75, 1.0}.
 */
function parseJudgeResponse(response: string): JudgeResult | null {
  if (!response || response.trim().length === 0) return null;

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      score: number;
      reasoning: string;
    };

    if (typeof parsed.score !== "number" || typeof parsed.reasoning !== "string") {
      return null;
    }

    // Clamp to nearest valid value
    const valid: (0 | 0.25 | 0.5 | 0.75 | 1.0)[] = [0, 0.25, 0.5, 0.75, 1.0];
    const clamped = Math.max(0, Math.min(1, parsed.score));
    const score = valid.reduce((prev, curr) =>
      Math.abs(curr - clamped) < Math.abs(prev - clamped) ? curr : prev
    );

    return { score, reasoning: parsed.reasoning };
  } catch {
    return null;
  }
}
