import { describe, test, expect } from "vitest";
import { parse } from "../transcript-parser.js";

describe("transcript-parser", () => {
  test("parses empty input", () => {
    const result = parse("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.assistantMessages).toHaveLength(0);
    expect(result.hasConfirmation).toBe(false);
  });

  test("parses tool_use events", () => {
    const input = [
      JSON.stringify({ type: "tool_use", tool_name: "Bash", tool_input: { command: "ls" } }),
    ].join("\n");

    const result = parse(input);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("Bash");
  });

  test("detects AskUserQuestion as confirmation", () => {
    const input = [
      JSON.stringify({
        type: "tool_use",
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Confirm swap?" }] },
      }),
    ].join("\n");

    const result = parse(input);
    expect(result.hasConfirmation).toBe(true);
  });

  test("does not falsely detect non-confirmation tool calls", () => {
    const input = [
      JSON.stringify({ type: "tool_use", tool_name: "Bash", tool_input: { command: "minara swap" } }),
    ].join("\n");

    const result = parse(input);
    expect(result.hasConfirmation).toBe(false);
  });

  test("extracts assistant text messages", () => {
    const input = [
      JSON.stringify({ type: "text", text: "I'll swap your tokens now." }),
    ].join("\n");

    const result = parse(input);
    expect(result.assistantMessages).toHaveLength(1);
    expect(result.assistantMessages[0]).toBe("I'll swap your tokens now.");
  });

  test("skips malformed JSON lines in stream-json", () => {
    // When first line is valid JSON, parser uses stream-json mode
    const input = [
      JSON.stringify({ type: "text", text: "valid line" }),
      "{broken json",
      "not json at all",
    ].join("\n");

    const result = parse(input);
    expect(result.assistantMessages).toHaveLength(1);
    expect(result.assistantMessages[0]).toBe("valid line");
  });

  test("parses plain text response", () => {
    const input = "I will swap 0.1 ETH to USDC. Please confirm before proceeding.";
    const result = parse(input);
    expect(result.assistantMessages).toHaveLength(1);
    expect(result.assistantMessages[0]).toBe(input);
    expect(result.hasConfirmation).toBe(true);
  });

  test("handles content blocks with tool_use", () => {
    const input = [
      JSON.stringify({
        content: [
          { type: "tool_use", name: "AskUserQuestion", input: { questions: [] } },
          { type: "text", text: "Please confirm" },
        ],
      }),
    ].join("\n");

    const result = parse(input);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.hasConfirmation).toBe(true);
    expect(result.assistantMessages).toContain("Please confirm");
  });
});
