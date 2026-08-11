import { describe, it, expect } from "vitest";
import { buildCompressionPrompt } from "../../src/compress/compression-prompt.js";

describe("buildCompressionPrompt", () => {
  const sampleMessages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "Fix the auth bug in login.ts" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "I'll fix the JWT validation." }] },
  ];

  it("generates a non-empty prompt", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("includes 'CONTEXT COMPRESSION' role instruction", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("CONTEXT COMPRESSION");
  });

  it("includes structured summary schema (Goal, Decisions, Constraints, etc.)", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("Goal");
    expect(prompt).toContain("Key Decisions");
    expect(prompt).toContain("Constraints");
    expect(prompt).toContain("Progress");
    expect(prompt).toContain("Errors");
    expect(prompt).toContain("Current State");
  });

  it("includes the conversation content", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("Fix the auth bug");
    expect(prompt).toContain("JWT validation");
  });

  it("includes 'be concise' instruction", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("concise");
  });

  it("includes 'preserve file paths' instruction", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("file paths");
  });

  it("handles empty messages array", () => {
    const prompt = buildCompressionPrompt([]);
    expect(prompt).toContain("CONTEXT COMPRESSION");
    // Should still have the schema even with no messages
    expect(prompt).toContain("Goal");
  });

  it("includes tool outputs in compressed form", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{
          type: "tool",
          tool: "bash",
          state: { output: "Command succeeded\nExit code: 0" },
        }],
      },
    ];
    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain("bash");
    expect(prompt).toContain("Command succeeded");
  });

  it("truncates long tool outputs (>500 chars) in the prompt", () => {
    const longOutput = "x".repeat(600);
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { output: longOutput } }],
      },
    ];
    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain("[truncated]");
    // Full 600 chars should NOT be in the prompt
    expect(prompt).not.toContain(longOutput);
  });

  it("labels messages with role and index", () => {
    const prompt = buildCompressionPrompt(sampleMessages);
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("user");
    expect(prompt).toContain("assistant");
  });

  it("skips messages with empty text", () => {
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "   " }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "real content" }] },
    ];
    const prompt = buildCompressionPrompt(messages);
    expect(prompt).toContain("real content");
    // The empty user message should not produce a labeled block
    expect(prompt).not.toContain("[0] user:\n   \n");
  });
});
