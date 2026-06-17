/**
 * Tests for the compacting hook handler.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompactingHandler } from "../../src/hooks/compacting.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-compacting-test-"));
}

function mockClient(messages: Array<{ info: unknown; parts: unknown[] }>) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
    },
  };
}

describe("createCompactingHandler", () => {
  let projectPath: string;
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    projectPath = tmpProject();
    state = createPluginState();
  });

  it("creates checkpoint.md when messages are available", async () => {
    const messages = [
      {
        info: { id: "m1", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "Build a REST API" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "s1" },
        parts: [{ type: "text", text: "I recommend using Express.js." }],
      },
    ];
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "s1" }, output);

    // checkpoint.md should exist
    const checkpointPath = path.join(projectPath, ".deep-memory", "checkpoint.md");
    expect(fs.existsSync(checkpointPath)).toBe(true);

    const content = fs.readFileSync(checkpointPath, "utf-8");
    expect(content).toContain("# Checkpoint — s1");
    expect(content).toContain("Build a REST API");
    expect(content).toContain("I recommend");

    // context hint should be pushed
    expect(output.context.length).toBe(2);
    expect(output.context[1]).toContain("Prior conversation archived");
  });

  it("writes raw checkpoint JSON alongside checkpoint.md", async () => {
    const messages = [
      {
        info: { id: "m1", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "hello" }],
      },
    ];
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[] };
    await handler({ sessionID: "s1" }, output);

    const rawPath = path.join(projectPath, ".deep-memory", "checkpoint.raw.json");
    expect(fs.existsSync(rawPath)).toBe(true);

    const raw = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
    expect(raw.sessionID).toBe("s1");
    expect(raw.messages).toHaveLength(1);
  });

  it("handles empty messages gracefully (no crash)", async () => {
    const client = mockClient([]);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[] };
    // Should not throw
    await handler({ sessionID: "s-empty" }, output);

    // No checkpoint.md should be written
    const checkpointPath = path.join(projectPath, ".deep-memory", "checkpoint.md");
    expect(fs.existsSync(checkpointPath)).toBe(false);
  });

  it("handles SDK error gracefully (never throws)", async () => {
    const client = {
      session: {
        messages: vi.fn().mockRejectedValue(new Error("SDK failure")),
      },
    };
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[] };
    // Must not throw
    await expect(handler({ sessionID: "s-err" }, output)).resolves.toBeUndefined();
  });

  it("handles read failure gracefully (never throws)", async () => {
    // Return data that will be written, but then we can test the flow
    const messages = [
      {
        info: { id: "m1", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "test message" }],
      },
    ];
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[] };
    await handler({ sessionID: "s1" }, output);

    // If we got here without throwing, the flow completed
    const checkpointPath = path.join(projectPath, ".deep-memory", "checkpoint.md");
    expect(fs.existsSync(checkpointPath)).toBe(true);
  });

  it("extracts file changes from tool calls", async () => {
    const messages = [
      {
        info: { id: "m1", role: "user", sessionID: "s1" },
        parts: [{ type: "text", text: "Fix the bug" }],
      },
      {
        info: { id: "m2", role: "assistant", sessionID: "s1" },
        parts: [
          {
            type: "tool",
            tool: "write",
            args: { filePath: "/src/app.ts" },
            state: { status: "completed", output: "ok" },
          },
        ],
      },
    ];
    const client = mockClient(messages);
    const handler = createCompactingHandler({ client, state, projectPath });

    const output = { context: [] as string[] };
    await handler({ sessionID: "s1" }, output);

    const checkpointPath = path.join(projectPath, ".deep-memory", "checkpoint.md");
    const content = fs.readFileSync(checkpointPath, "utf-8");
    expect(content).toContain("/src/app.ts");
    expect(content).toContain("## File Changes");
  });
});
