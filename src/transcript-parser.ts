import type { Transcript, ToolCall } from "./types.js";

/**
 * Parse skill invocation output into a structured Transcript.
 *
 * Supports two formats:
 * 1. Plain text response from OpenRouter API
 * 2. Stream-json format (one JSON per line, legacy claude -p support)
 */
export function parse(output: string): Transcript {
  const toolCalls: ToolCall[] = [];
  const assistantMessages: string[] = [];
  let hasConfirmation = false;

  if (!output || output.trim().length === 0) {
    return { toolCalls, assistantMessages, hasConfirmation, raw: "" };
  }

  // Detect format: if first non-empty line is valid JSON, try stream-json
  const firstLine = output.trim().split("\n")[0];
  let isStreamJson = false;
  try {
    JSON.parse(firstLine);
    isStreamJson = true;
  } catch {
    isStreamJson = false;
  }

  if (isStreamJson) {
    return parseStreamJson(output);
  }

  return parsePlainText(output);
}

/**
 * Parse plain text response from OpenRouter API.
 * Extracts command mentions, confirmation patterns, and tool-like references.
 */
function parsePlainText(text: string): Transcript {
  const toolCalls: ToolCall[] = [];
  const assistantMessages: string[] = [text];
  let hasConfirmation = false;

  const lowerText = text.toLowerCase();

  // Detect confirmation patterns in the response
  const confirmPatterns = [
    /\bconfirm\b.*\b(before|proceed|execute|transaction)/i,
    /\bwould you like to proceed/i,
    /\bare you sure/i,
    /\bplease confirm/i,
    /\bapprove.*transaction/i,
    /\bverif(y|ication).*before/i,
    /\by\/n\b/i,
    /\byes.*no\b.*\bproceed/i,
  ];

  for (const pattern of confirmPatterns) {
    if (pattern.test(text)) {
      hasConfirmation = true;
      break;
    }
  }

  // Extract command/tool references from text
  // Look for patterns like: `minara swap`, `minara balance`, command-line invocations
  const cmdPatterns = [
    /`([a-z][\w-]+(?:\s+[a-z][\w-]+)*)`/g,    // backtick commands
    /\b(minara|claude|npx|npm)\s+([\w-]+)/gi,   // CLI tool invocations
    /\brunning\s+`?([^`\n]+)`?/gi,              // "running X"
    /\bexecute\s+`?([^`\n]+)`?/gi,              // "execute X"
  ];

  for (const pattern of cmdPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[0].replace(/`/g, "").trim();
      // Only record meaningful command references
      if (fullMatch.length > 2 && fullMatch.length < 100) {
        toolCalls.push({
          name: fullMatch.split(/\s+/)[0],
          args: { raw: fullMatch },
        });
      }
    }
  }

  // Deduplicate tool calls by name
  const seen = new Set<string>();
  const uniqueToolCalls = toolCalls.filter((tc) => {
    const key = `${tc.name}:${JSON.stringify(tc.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    toolCalls: uniqueToolCalls,
    assistantMessages,
    hasConfirmation,
    raw: text,
  };
}

/**
 * Parse stream-json format (legacy claude -p support).
 */
function parseStreamJson(streamJson: string): Transcript {
  const toolCalls: ToolCall[] = [];
  const assistantMessages: string[] = [];
  let hasConfirmation = false;

  const lines = streamJson.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const type = parsed.type as string | undefined;

    if (type === "tool_use" || parsed.tool_name) {
      const name = (parsed.tool_name || parsed.name || "") as string;
      const args = (parsed.tool_input || parsed.input || parsed.args || {}) as Record<string, unknown>;
      toolCalls.push({ name, args });
      if (isConfirmationToolCall(name, args)) {
        hasConfirmation = true;
      }
    }

    if (type === "text" || type === "assistant") {
      const text = (parsed.text || parsed.content || "") as string;
      if (text) assistantMessages.push(text);
    }

    if (parsed.content && Array.isArray(parsed.content)) {
      for (const block of parsed.content as Record<string, unknown>[]) {
        if (block.type === "tool_use") {
          const name = (block.name || "") as string;
          const args = (block.input || {}) as Record<string, unknown>;
          toolCalls.push({ name, args });
          if (isConfirmationToolCall(name, args)) {
            hasConfirmation = true;
          }
        }
        if (block.type === "text") {
          const text = (block.text || "") as string;
          if (text) assistantMessages.push(text);
        }
      }
    }
  }

  return { toolCalls, assistantMessages, hasConfirmation, raw: streamJson };
}

function isConfirmationToolCall(
  name: string,
  args: Record<string, unknown>
): boolean {
  const confirmPatterns = [
    "askuserquestion",
    "ask_user",
    "confirm",
    "user_confirm",
    "approval",
  ];

  const lowerName = name.toLowerCase();
  if (confirmPatterns.some((p) => lowerName.includes(p))) {
    return true;
  }

  const argsStr = JSON.stringify(args).toLowerCase();
  if (
    argsStr.includes("confirm") &&
    (argsStr.includes("proceed") ||
      argsStr.includes("approve") ||
      argsStr.includes("yes"))
  ) {
    return true;
  }

  return false;
}
