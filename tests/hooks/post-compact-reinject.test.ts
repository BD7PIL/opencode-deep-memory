import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { createCompactingHandler } from "../../src/hooks/compacting.js";
import { RepoMapTracker } from "../../src/repomap/tracker.js";

function tmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dm-postcompact-"));
}

function mockClient(messages: Array<{ info: unknown; parts: unknown[] }>) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
      create: vi.fn().mockResolvedValue({ data: { id: "mock-sub" } }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    tui: { showToast: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeMessages(count: number): Array<{ info: unknown; parts: unknown[] }> {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", sessionID: "s1" },
      parts: [{ type: "text", text: `Message ${i} content with enough text` }],
    });
  }
  return msgs;
}

describe("Post-compact file re-injection (G3 Claude Code)", () => {
  let projectPath: string;
  let state: ReturnType<typeof createPluginState>;
  let tracker: RepoMapTracker;

  beforeEach(() => {
    projectPath = tmpProject();
    state = createPluginState();
    tracker = new RepoMapTracker();
  });

  afterEach(() => {
    try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch {}
  });

  it("re-injects recently read files after compaction", async () => {
    // Create a test file and track it as "recently read"
    const testFile = path.join(projectPath, "test.ts");
    fs.writeFileSync(testFile, "export function hello() { return 42; }\n", "utf8");
    tracker.recordRead(testFile, "export function hello() { return 42; }");

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({
      client,
      state,
      projectPath,
      tracker,
    } as never);

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "s1" }, output);

    // Verify the file content was re-injected into context
    const reInjected = output.context.find((c) => c.includes("post-compact context"));
    expect(reInjected).toBeDefined();
    expect(reInjected).toContain("hello()");
    expect(reInjected).toContain("test.ts");
  });

  it("caps re-injected file content at 5K chars", async () => {
    // Create a large test file
    const testFile = path.join(projectPath, "large.ts");
    const largeContent = "x".repeat(10_000);
    fs.writeFileSync(testFile, largeContent, "utf8");
    tracker.recordRead(testFile, largeContent);

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({
      client,
      state,
      projectPath,
      tracker,
    } as never);

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    await handler({ sessionID: "s1" }, output);

    const reInjected = output.context.find((c) => c.includes("post-compact context"));
    expect(reInjected).toBeDefined();
    expect(reInjected).toContain("[... file truncated at 5K");
  });

  it("skips re-injection gracefully when file has been deleted", async () => {
    const testFile = path.join(projectPath, "deleted.ts");
    fs.writeFileSync(testFile, "content", "utf8");
    tracker.recordRead(testFile, "content");
    // Now delete the file
    fs.unlinkSync(testFile);

    const messages = makeMessages(25);
    const client = mockClient(messages);
    const handler = createCompactingHandler({
      client,
      state,
      projectPath,
      tracker,
    } as never);

    const output = { context: [] as string[], prompt: undefined as string | undefined };
    // Should not throw
    await handler({ sessionID: "s1" }, output);

    // Other context entries should still exist (checkpoint, handoff)
    expect(output.context.length).toBeGreaterThan(0);
    // No post-compact context for deleted file
    const reInjected = output.context.filter((c) => c.includes("post-compact context"));
    expect(reInjected.length).toBe(0);
  });
});
