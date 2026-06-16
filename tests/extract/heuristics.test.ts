/**
 * Tests for heuristic extraction — 5 patterns + edge cases.
 */
import { describe, it, expect } from "vitest";
import { extractHeuristics } from "../../src/extract/heuristics.js";
import type { MessageInput } from "../../src/extract/heuristics.js";

// Helper: build a message with text parts
function userMsg(text: string): MessageInput {
  return {
    info: { role: "user" },
    parts: [{ type: "text", text }],
  };
}

function assistantMsg(text: string): MessageInput {
  return {
    info: { role: "assistant" },
    parts: [{ type: "text", text }],
  };
}

function toolMsg(tool: string, args: Record<string, unknown>, output?: string): MessageInput {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool,
        args,
        output,
        state: output !== undefined ? { status: "completed", output } : undefined,
      },
    ],
  };
}

function toolErrorMsg(tool: string, args: Record<string, unknown>, error: string): MessageInput {
  return {
    info: { role: "assistant" },
    parts: [
      {
        type: "tool",
        tool,
        args,
        state: { status: "error", error },
      },
    ],
  };
}

describe("extractHeuristics", () => {
  // ---- Edge cases ----

  it("returns empty arrays for empty input", () => {
    const result = extractHeuristics([]);
    expect(result.userIntents).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.gotchas).toEqual([]);
    expect(result.fileChanges).toEqual([]);
  });

  it("returns empty arrays when no patterns match", () => {
    const msgs: MessageInput[] = [
      { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ];
    const result = extractHeuristics(msgs);
    expect(result.userIntents).toEqual(["hello"]);
    expect(result.decisions).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.gotchas).toEqual([]);
    expect(result.fileChanges).toEqual([]);
  });

  // ---- Pattern 1: User Intents ----

  it("extracts user intents from user messages", () => {
    const msgs: MessageInput[] = [
      userMsg("I want to build a REST API"),
      assistantMsg("Sure, let me help"),
      userMsg("Also need authentication"),
    ];
    const result = extractHeuristics(msgs);
    expect(result.userIntents).toEqual([
      "I want to build a REST API",
      "Also need authentication",
    ]);
  });

  it("skips tool result parts when extracting user intents", () => {
    const msgs: MessageInput[] = [
      {
        info: { role: "user" },
        parts: [
          { type: "text", text: "Run this command" },
          { type: "tool", tool: "bash", output: "some output" },
        ],
      },
    ];
    const result = extractHeuristics(msgs);
    expect(result.userIntents).toEqual(["Run this command"]);
  });

  it("truncates long user intents to 200 tokens", () => {
    const longText = "word ".repeat(1000); // ~5000 chars, ~1250 tokens
    const msgs: MessageInput[] = [userMsg(longText)];
    const result = extractHeuristics(msgs);
    expect(result.userIntents).toHaveLength(1);
    // 200 tokens = 800 chars max, plus truncation marker
    expect(result.userIntents[0]!.length).toBeLessThanOrEqual(820);
    expect(result.userIntents[0]!).toContain("[truncated]");
  });

  // ---- Pattern 2: Decisions ----

  it("extracts decisions with English patterns", () => {
    const msgs: MessageInput[] = [
      assistantMsg("I recommend using TypeScript for this project."),
      assistantMsg("We should adopt a modular architecture."),
    ];
    const result = extractHeuristics(msgs);
    expect(result.decisions.length).toBeGreaterThanOrEqual(2);
    expect(result.decisions[0]).toContain("I recommend");
    expect(result.decisions[1]).toContain("We should");
  });

  it("extracts decisions with Chinese patterns", () => {
    const msgs: MessageInput[] = [
      assistantMsg("建议采用微服务架构。这样更灵活。"),
    ];
    const result = extractHeuristics(msgs);
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions[0]).toContain("建议");
  });

  it("deduplicates identical decision sentences", () => {
    const msgs: MessageInput[] = [
      assistantMsg("I recommend using Docker."),
      assistantMsg("I recommend using Docker."),
    ];
    const result = extractHeuristics(msgs);
    expect(result.decisions).toHaveLength(1);
  });

  // ---- Pattern 3: Constraints ----

  it("extracts constraints with English patterns", () => {
    const msgs: MessageInput[] = [
      assistantMsg("You must not expose the API key in client code."),
      assistantMsg("Never commit secrets to the repository."),
    ];
    const result = extractHeuristics(msgs);
    expect(result.constraints.length).toBeGreaterThanOrEqual(2);
    expect(result.constraints[0]).toContain("must not");
    expect(result.constraints[1]).toContain("Never");
  });

  it("extracts constraints with Chinese patterns", () => {
    const msgs: MessageInput[] = [
      assistantMsg("必须使用 HTTPS 协议。绝不能用 HTTP。"),
    ];
    const result = extractHeuristics(msgs);
    expect(result.constraints.length).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates identical constraint sentences", () => {
    const msgs: MessageInput[] = [
      assistantMsg("Do not use eval()."),
      assistantMsg("Do not use eval()."),
    ];
    const result = extractHeuristics(msgs);
    expect(result.constraints).toHaveLength(1);
  });

  // ---- Pattern 4: Gotchas (error → fix pairs) ----

  it("pairs tool errors with corrective actions in next messages", () => {
    const msgs: MessageInput[] = [
      toolErrorMsg("bash", { command: "npm test" }, "Error: test failed"),
      userMsg("Fix the test"),
      toolMsg("write", { filePath: "/src/test.ts", content: "fixed" }),
    ];
    const result = extractHeuristics(msgs);
    expect(result.gotchas).toHaveLength(1);
    expect(result.gotchas[0]!.error).toContain("Error");
    expect(result.gotchas[0]!.fix).toContain("write /src/test.ts");
  });

  it("does not create gotcha without corrective action in window", () => {
    const msgs: MessageInput[] = [
      toolErrorMsg("bash", { command: "npm test" }, "Error: test failed"),
      userMsg("What happened?"),
      assistantMsg("The test failed because..."),
    ];
    const result = extractHeuristics(msgs);
    expect(result.gotchas).toHaveLength(0);
  });

  // ---- Pattern 5: File Changes ----

  it("extracts file changes from write tool calls", () => {
    const msgs: MessageInput[] = [
      toolMsg("write", { filePath: "/src/index.ts" }),
      toolMsg("edit", { filePath: "/src/utils.ts" }),
    ];
    const result = extractHeuristics(msgs);
    expect(result.fileChanges).toEqual([
      { path: "/src/index.ts", operation: "write" },
      { path: "/src/utils.ts", operation: "edit" },
    ]);
  });

  it("extracts file changes from bash commands", () => {
    const msgs: MessageInput[] = [
      toolMsg("bash", { command: "rm /tmp/old-file.txt" }),
    ];
    const result = extractHeuristics(msgs);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.fileChanges[0]!.path).toBe("/tmp/old-file.txt");
    expect(result.fileChanges[0]!.operation).toBe("bash");
  });

  it("deduplicates identical file changes", () => {
    const msgs: MessageInput[] = [
      toolMsg("write", { filePath: "/src/index.ts" }),
      toolMsg("write", { filePath: "/src/index.ts" }),
    ];
    const result = extractHeuristics(msgs);
    expect(result.fileChanges).toHaveLength(1);
  });
});
