/**
 * context_compress tool — the scheduling branches (37% before this file).
 *
 * The tool is pure orchestration: which of the four exits it takes depends on
 * (summary provided? client available? messages fetchable? enough messages to
 * compress?), and every exit must schedule SOMETHING the next turn can consume.
 */
import { describe, it, expect } from "vitest";
import { createContextCompressTool } from "../../src/tools/context-compress.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { mockHostClient, makeMessages } from "../helpers/mock-host.js";

function build(opts: { client?: unknown; messages?: number; projectPath?: string } = {}) {
  const state = createPluginState();
  // `'client' in opts` and not `??`: passing an explicit undefined means
  // "no host client at all" — a different branch from "client present".
  const client = "client" in opts ? opts.client : mockHostClient({ messages: makeMessages(opts.messages ?? 20) });
  const toolInstance = createContextCompressTool(state, client, opts.projectPath ?? "/tmp/proj");
  return { state, client, toolInstance };
}

const ctx = {
  sessionID: "ses-1",
  messageID: "msg-1",
  agent: "build",
  directory: "/tmp/proj",
  worktree: "/tmp/proj",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} as never;

describe("context_compress scheduling branches", () => {
  it("uses a caller-provided summary without touching the host", async () => {
    const { state, client, toolInstance } = build();
    const result = (await toolInstance.execute({ summary: "keep the decisions", keep_recent: 5 }, ctx)) as {
      title: string;
      output: string;
    };
    expect(result.title).toBe("Compression scheduled");
    expect(result.output).toContain("last 5");
    expect((client as ReturnType<typeof mockHostClient>).session.messages).not.toHaveBeenCalled();
    expect(state.consumeContentAwareCompression()).toEqual({ keepRecent: 5, summary: "keep the decisions" });
  });

  it("says so when no client (subagent) is available", async () => {
    const { state, toolInstance } = build({ client: undefined });
    const result = (await toolInstance.execute({ keep_recent: 4 }, ctx)) as { title: string; output: string };
    expect(result.title).toBe("Compression scheduled (no subagent)");
    expect(state.consumeContentAwareCompression()).toEqual({ keepRecent: 4, summary: "" });
  });

  it("reports unreadable session messages instead of pretending", async () => {
    const client = mockHostClient();
    client.session.messages.mockRejectedValueOnce(new Error("boom"));
    const { toolInstance } = build({ client });
    const result = (await toolInstance.execute({ keep_recent: 8 }, ctx)) as { title: string; output: string };
    expect(result.title).toBe("Error");
    expect(result.output).toContain("Failed to fetch session messages");
  });

  it("counts honestly when there is nothing older than keep_recent", async () => {
    const { toolInstance } = build({ messages: 3 });
    const result = (await toolInstance.execute({ keep_recent: 8 }, ctx)) as { title: string; output: string };
    expect(result.title).toBe("Nothing to compress");
    expect(result.output).toContain("Only 3 messages");
  });

  it("spawns the subagent, marks it, schedules with its id and toasts (happy path)", async () => {
    const client = mockHostClient({ messages: makeMessages(20), subSessionId: "sub-9" });
    const { state, toolInstance } = build({ client });
    const result = (await toolInstance.execute({ keep_recent: 6 }, ctx)) as { title: string; output: string };

    expect(result.title).toBe("Compression scheduled");
    expect(result.output).toContain("summarize 14 messages");
    expect(client.session.create).toHaveBeenCalledWith({
      body: expect.objectContaining({ parentID: "ses-1" }),
      query: { directory: "/tmp/proj" },
    });
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: "sub-9" }, body: expect.objectContaining({ agent: "general" }) }),
    );
    expect(state.isSpawnedSubSession("sub-9")).toBe(true);
    expect(state.consumeContentAwareCompression()).toEqual({ keepRecent: 6, summary: "" });
    expect(client.tui.showToast).toHaveBeenCalled();
  });

  it("reports a failed spawn — both the throw and the empty-id cases", async () => {
    const throwing = mockHostClient({ messages: makeMessages(20) });
    throwing.session.create.mockRejectedValueOnce(new Error("spawn refused"));
    const a = (await build({ client: throwing }).toolInstance.execute({ keep_recent: 2 }, ctx)) as { output: string };
    expect(a.output).toContain("Failed to spawn compression subagent");

    const empty = mockHostClient({ messages: makeMessages(20) });
    empty.session.create.mockResolvedValueOnce({ data: {} });
    const b = (await build({ client: empty }).toolInstance.execute({ keep_recent: 2 }, ctx)) as { output: string };
    expect(b.output).toContain("no session ID");
  });

  it("reports a failed prompt instead of scheduling a dead subagent", async () => {
    const client = mockHostClient({ messages: makeMessages(20) });
    client.session.promptAsync.mockRejectedValueOnce(new Error("engine busy"));
    const { state, toolInstance } = build({ client });
    const result = (await toolInstance.execute({ keep_recent: 2 }, ctx)) as { output: string };
    expect(result.output).toContain("Failed to prompt compression subagent");
    expect(state.isSpawnedSubSession("mock-sub")).toBe(false);
  });

  it("floors keep_recent at 2 (a caller asking for 0 must not delete everything)", async () => {
    const client = mockHostClient({ messages: makeMessages(20) });
    const { state, toolInstance } = build({ client });
    await toolInstance.execute({ keep_recent: 0 }, ctx);
    expect(state.consumeContentAwareCompression()?.keepRecent).toBe(2);
    expect(client.session.create).toHaveBeenCalled();
  });
});