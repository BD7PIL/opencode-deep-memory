/**
 * Tests for distill-executor.
 */

import { describe, it, expect, vi } from "vitest";
import { runDistill, DISTILL_INTERVAL_MS } from "../../src/schedule/distill-executor.js";

function makeMockClient(overrides: {
  createResult?: { data?: { id?: string } };
  createError?: Error;
  promptAsyncResult?: void;
  promptAsyncError?: Error;
} = {}) {
  const session = {
    create: vi.fn(),
    promptAsync: vi.fn(),
  };

  if (overrides.createError) {
    session.create.mockRejectedValue(overrides.createError);
  } else {
    session.create.mockResolvedValue(
      overrides.createResult ?? { data: { id: "distill-1" } },
    );
  }

  if (overrides.promptAsyncError) {
    session.promptAsync.mockRejectedValue(overrides.promptAsyncError);
  } else {
    session.promptAsync.mockResolvedValue(
      overrides.promptAsyncResult ?? undefined,
    );
  }

  return { session } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("runDistill", () => {
  const baseOpts = {
    parentSessionID: "parent-123",
    projectPath: "/test/project",
    directory: "/test/project",
  };

  it("happy path: create returns id, promptAsync succeeds → returns spawned", async () => {
    const client = makeMockClient();

    const result = await runDistill({ ...baseOpts, client });

    expect(result).toEqual({ sessionID: "distill-1", status: "spawned" });
    expect(client.session.create).toHaveBeenCalledWith({
      body: {
        parentID: "parent-123",
        title: expect.stringContaining("Memory Distill Workflow Packaging"),
      },
      query: { directory: "/test/project" },
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "distill-1" },
      body: expect.objectContaining({
        parts: [{ type: "text", text: expect.any(String) }],
        agent: "general",
        tools: {
          memory_search: true,
          memory_store: true,
          memory_forget: false,
          read: true,
          list: true,
        },
      }),
    });
  });

  it("create() throws → returns failed, does NOT rethrow", async () => {
    const client = makeMockClient({
      createError: new Error("connection refused"),
    });

    const result = await runDistill({ ...baseOpts, client });

    expect(result).toEqual({ sessionID: "", status: "failed" });
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("promptAsync() throws → returns failed", async () => {
    const client = makeMockClient({
      promptAsyncError: new Error("timeout"),
    });

    const result = await runDistill({ ...baseOpts, client });

    expect(result).toEqual({ sessionID: "distill-1", status: "failed" });
  });

  it("prompt contains substituted paths (no {{...}} placeholders remain)", async () => {
    const client = makeMockClient();
    await runDistill({ ...baseOpts, client });

    const promptCall = client.session.promptAsync.mock.calls[0][0];
    const promptText: string = promptCall.body.parts[0].text;

    // Should NOT contain template placeholders
    expect(promptText).not.toContain("{{projectPath}}");
    expect(promptText).not.toContain("{{memoryFilePath}}");
    expect(promptText).not.toContain("{{notesFilePath}}");
    expect(promptText).not.toContain("{{sessionsDir}}");
    expect(promptText).not.toContain("{{outputFilePath}}");
    expect(promptText).not.toContain("{{ISO timestamp}}");

    // Should contain the actual project path
    expect(promptText).toContain("/test/project");

    // Should reference MEMORY.md and notes.md
    expect(promptText).toContain("MEMORY.md");
    expect(promptText).toContain("notes.md");
  });

  it("DISTILL_INTERVAL_MS is 30 days", () => {
    expect(DISTILL_INTERVAL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
