/**
 * Tests for memory-expand tool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import {
  createMemoryExpandTool,
  formatExpandedMessage,
} from "../../src/tools/memory-expand.js";

// Mock fs.existsSync and fs.readFileSync
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  };
});

describe("memory_expand tool", () => {
  const existsSync = vi.mocked(fs.existsSync);
  const readFileSync = vi.mocked(fs.readFileSync);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'no checkpoint' when checkpoint.raw.json does not exist", async () => {
    existsSync.mockReturnValue(false);

    const tool = createMemoryExpandTool({ projectPath: "/test/project" });
    const result = await tool.execute({ messageID: "msg-1" });

    expect(result).toBe(
      "No checkpoint.raw.json found. No compressed messages to expand.",
    );
    expect(existsSync).toHaveBeenCalled();
  });

  it("returns formatted content when message ID is found", async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        messages: [
          {
            info: { id: "msg-1", role: "user", time: { created: 1700000000000 } },
            parts: [
              { type: "text", text: "Hello world" },
              { type: "reasoning", thinking: "Let me think..." },
              {
                type: "tool",
                tool: "read",
                state: { status: "completed", output: "file contents here" },
              },
            ],
          },
        ],
      }),
    );

    const tool = createMemoryExpandTool({ projectPath: "/test/project" });
    const result = await tool.execute({ messageID: "msg-1" });

    expect(result).toContain("=== Expanded Message msg-1 ===");
    expect(result).toContain("Role: user");
    expect(result).toContain("[TEXT]");
    expect(result).toContain("Hello world");
    expect(result).toContain("[REASONING]");
    expect(result).toContain("Let me think...");
    expect(result).toContain("[TOOL: read]");
    expect(result).toContain("Status: completed");
  });

  it("returns 'not found' with available count when message ID is missing", async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(
      JSON.stringify({
        messages: [
          { info: { id: "msg-1" }, parts: [] },
          { info: { id: "msg-2" }, parts: [] },
          { info: { id: "msg-3" }, parts: [] },
        ],
      }),
    );

    const tool = createMemoryExpandTool({ projectPath: "/test/project" });
    const result = await tool.execute({ messageID: "msg-999" });

    expect(result).toContain("Message msg-999 not found in checkpoint");
    expect(result).toContain("Available: 3 messages");
  });

  it("returns error message when JSON is malformed", async () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("this is not json {{{");

    const tool = createMemoryExpandTool({ projectPath: "/test/project" });
    const result = await tool.execute({ messageID: "msg-1" });

    expect(result).toContain("Error reading checkpoint:");
  });
});

describe("formatExpandedMessage", () => {
  it("handles message with no parts", () => {
    const result = formatExpandedMessage({
      info: { id: "msg-1", role: "assistant" },
      parts: [],
    });
    expect(result).toContain("=== Expanded Message msg-1 ===");
    expect(result).toContain("Role: assistant");
  });

  it("handles missing info fields gracefully", () => {
    const result = formatExpandedMessage({});
    expect(result).toContain("=== Expanded Message ? ===");
    expect(result).toContain("Role: unknown");
    expect(result).toContain("Time: unknown");
  });

  it("truncates long tool output to 500 chars", () => {
    const longOutput = "x".repeat(1000);
    const result = formatExpandedMessage({
      info: { id: "msg-1" },
      parts: [
        {
          type: "tool",
          tool: "read",
          state: { output: longOutput },
        },
      ],
    });
    expect(result).toContain("Output:");
    // The output should be truncated — should not contain all 1000 x's
    const outputLine = result.split("\n").find((l) => l.startsWith("Output:"));
    expect(outputLine).toBeDefined();
    expect(outputLine!.length).toBeLessThan(1000 + 50); // 500 chars + "Output: " prefix + "..."
  });

  it("handles thinking type as reasoning", () => {
    const result = formatExpandedMessage({
      info: { id: "msg-1" },
      parts: [{ type: "thinking", text: "internal thought" }],
    });
    expect(result).toContain("[REASONING]");
    expect(result).toContain("internal thought");
  });
});
