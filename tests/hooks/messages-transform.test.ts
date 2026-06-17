import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMessagesTransformHandler } from "../../src/hooks/messages-transform.js";
import {
  createPluginState,
  type PluginState,
} from "../../src/hooks/shared-state.js";

/**
 * Minimal mock message type matching the hook's expected shape.
 * Parts are `any[]` in the hook signature, so we use `unknown[]` here.
 */
interface MockMessage {
  info: { id: string; role: string; time: { created: number } };
  parts: unknown[];
}

/**
 * Minimal mock message factory matching the hook's expected shape.
 */
const mockMessage = (role: string, parts: unknown[], id?: string): MockMessage => ({
  info: { id: id ?? "msg-1", role, time: { created: 0 } },
  parts,
});

/** Build N filler messages to exceed the KEEP_RECENT (8) threshold. */
function fillerMessages(n: number): MockMessage[] {
  return Array.from({ length: n }, (_, i) =>
    mockMessage("assistant", [{ type: "text", text: `filler-${i}` }], `filler-${i}`),
  );
}

/**
 * Build messages for stripping tests: 3 protected head + target + 8 tail.
 * Total = 12, so stripping range = [3, 3] (one message processed).
 * Returns [messages, targetIndex] where targetIndex = 3.
 */
function buildStripTestMessages(
  targetParts: unknown[],
  targetId: string,
): { messages: MockMessage[]; targetIdx: number } {
  const head = [
    mockMessage("user", [{ type: "text", text: "system prompt" }], "head-0"),
    mockMessage("user", [{ type: "text", text: "first user msg" }], "head-1"),
    mockMessage("assistant", [{ type: "text", text: "first assistant" }], "head-2"),
  ];
  const target = mockMessage("assistant", targetParts, targetId);
  const tail = fillerMessages(8);
  return { messages: [...head, target, ...tail], targetIdx: 3 };
}

/** Helper to cast output for the handler. */
function makeOutput(msgs: MockMessage[]) {
  return { messages: msgs } as { messages: MockMessage[] };
}

describe("createMessagesTransformHandler", () => {
  let state: PluginState;
  let logger: { debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; trace: ReturnType<typeof vi.fn>; for: ReturnType<typeof vi.fn>; traceDir: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    state = createPluginState();
    logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      for: vi.fn().mockReturnThis(),
      traceDir: vi.fn().mockReturnValue(null),
    };
  });

  // 1. Empty messages array → no-op
  it("no-ops on empty messages array", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const output = makeOutput([]);
    await handler({} as never, output as never);
    expect(output.messages.length).toBe(0);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  // 2. ≤8 messages → no-op
  it("no-ops when messages.length <= 8", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const msgs = fillerMessages(8);
    // Add reasoning to a message — should NOT be cleared
    msgs[0] = mockMessage("assistant", [
      { type: "reasoning", text: "deep thoughts", metadata: {} },
    ], "r-1");
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[0].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("deep thoughts");
    expect(logger.debug).not.toHaveBeenCalled();
  });

  // 3. User messages NEVER touched (even if old)
  it("never touches user messages even if old", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const msgs = [
      mockMessage("user", [{ type: "text", text: "user query" }], "u-1"),
      ...fillerMessages(8),
    ];
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[0].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("user query");
  });

  // 4. Recent 8 messages preserved (even if assistant with reasoning)
  it("preserves reasoning in recent 8 messages", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const recent = mockMessage("assistant", [
      { type: "reasoning", text: "recent reasoning", metadata: {} },
    ], "recent-1");
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "reasoning", text: "old reasoning", metadata: {} }],
      "old-1",
    );
    // Place recent at the end (protected tail)
    msgs.push(recent);
    const output = makeOutput(msgs);
    await handler({} as never, output as never);

    const oldParts = output.messages[targetIdx].parts as Record<string, unknown>[];
    const recentParts = output.messages[msgs.length - 1].parts as Record<string, unknown>[];
    expect(oldParts[0]["text"]).toBe("[cleared]");
    expect(recentParts[0]["text"]).toBe("recent reasoning");
  });

  // 5. Old reasoning text cleared to "[cleared]"
  it("clears old reasoning text to [cleared]", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "reasoning", text: "some reasoning", metadata: {} }],
      "r-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("[cleared]");
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({ reasoning_cleared: 1 }),
    );
  });

  // 6. openrouter.reasoning_details metadata stripped
  it("strips openrouter.reasoning_details metadata", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const reasoningMeta = { openrouter: { reasoning_details: [{ text: "chain of thought" }] } };
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "reasoning", text: "old", metadata: reasoningMeta }],
      "r-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    const meta = parts[0]["metadata"] as Record<string, unknown>;
    const openrouter = meta["openrouter"] as Record<string, unknown>;
    expect(openrouter["reasoning_details"]).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({ metadata_stripped: 1 }),
    );
  });

  // 7. System injection message neutralized → parts replaced with [{type:"text",text:"[stripped]"}]
  it("neutralizes system-injected messages", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "text", text: "<system-reminder>Do the thing</system-reminder>" }],
      "sys-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(parts.length).toBe(1);
    expect(parts[0]["type"]).toBe("text");
    expect(parts[0]["text"]).toBe("[stripped]");
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({ system_neutralized: 1 }),
    );
  });

  // 8. Tool error >100 chars truncated
  it("truncates tool errors > 100 chars", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const longError = "x".repeat(200);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "tool", state: { status: "error", error: longError } }],
      "t-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    const toolState = parts[0]["state"] as Record<string, unknown>;
    expect(toolState["error"]).toBe("x".repeat(100) + "... [truncated]");
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({ tool_errors_truncated: 1 }),
    );
  });

  // 9. Inline <thinking> tags stripped from text parts
  it("strips inline thinking tags from text parts", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "text", text: "Hello <thinking>internal thought</thinking> world" }],
      "t-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("Hello world");
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({ thinking_stripped: 1 }),
    );
  });

  it("strips inline <think> tags from text parts", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "text", text: "Prefix <think>short</think> suffix" }],
      "t-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("Prefix suffix");
  });

  // 10. Mixed content (text + tool) NOT over-stripped
  it("does not over-strip mixed content messages", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [
        { type: "text", text: "Here is my analysis:" },
        { type: "tool", state: { status: "ok" } },
        { type: "text", text: "The result is 42." },
      ],
      "mix-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    // Should NOT be neutralized — real text content exists alongside tool
    expect(parts.length).toBe(3);
    expect(parts[0]["text"]).toBe("Here is my analysis:");
    expect(parts[2]["text"]).toBe("The result is 42.");
  });

  // 11. Stats logged when stripping occurs
  it("logs stats when any stripping occurs", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs } = buildStripTestMessages(
      [
        { type: "reasoning", text: "old reasoning" },
        { type: "text", text: "actual output" },
      ],
      "stat-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    expect(logger.debug).toHaveBeenCalledWith(
      "messages.transform: stripped",
      expect.objectContaining({
        reasoning_cleared: expect.any(Number),
        metadata_stripped: expect.any(Number),
      }),
    );
  });

  // 12. Empty text message (system injection pattern /^$/) neutralized
  it("neutralizes empty text messages", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "text", text: "" }],
      "empty-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("[stripped]");
  });

  // 13. Tool error ≤100 chars NOT truncated
  it("does not truncate tool errors <= 100 chars", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const shortError = "short error";
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "tool", state: { status: "error", error: shortError } }],
      "t-2",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    const toolState = parts[0]["state"] as Record<string, unknown>;
    expect(toolState["error"]).toBe("short error");
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("stripped"),
      expect.anything(),
    );
  });

  // 14. Metadata parts (step-start, etc.) are skipped
  it("skips metadata parts without modification", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [
        { type: "step-start", text: "step info" },
        { type: "text", text: "real content" },
      ],
      "meta-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[targetIdx].parts as Record<string, unknown>[];
    // step-start preserved, text not stripped (real content)
    expect(parts[0]["type"]).toBe("step-start");
    expect(parts[1]["text"]).toBe("real content");
  });

  // 15. Already-cleared reasoning not re-counted
  it("does not re-count already-cleared reasoning", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs } = buildStripTestMessages(
      [{ type: "reasoning", text: "[cleared]" }],
      "already-1",
    );
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    // No stripping stats should be logged (nothing changed)
    expect(logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining("stripped"),
      expect.anything(),
    );
  });

  // C1: No-op when messages.length <= KEEP_RECENT + PROTECTED_HEAD (11)
  it("C1: no-ops when messages.length <= 11 (KEEP_RECENT + PROTECTED_HEAD)", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    // 11 messages: exactly at the threshold — should be no-op
    const msgs = [
      mockMessage("assistant", [{ type: "reasoning", text: "old", metadata: {} }], "r-1"),
      ...fillerMessages(10),
    ];
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    const parts = output.messages[0].parts as Record<string, unknown>[];
    expect(parts[0]["text"]).toBe("old");
    expect(logger.debug).not.toHaveBeenCalled();
  });

  // C1: First 3 messages (protected head) are never touched
  it("C1: preserves first 3 messages even when old", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs, targetIdx } = buildStripTestMessages(
      [{ type: "reasoning", text: "strippable reasoning", metadata: {} }],
      "target-1",
    );
    // Add reasoning to all 3 head messages — should NOT be cleared
    msgs[0] = mockMessage("user", [{ type: "text", text: "system prompt" }], "head-0");
    msgs[1] = mockMessage("user", [{ type: "text", text: "first user" }], "head-1");
    msgs[2] = mockMessage("assistant", [
      { type: "reasoning", text: "protected reasoning", metadata: {} },
    ], "head-2");
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    // Head message preserved
    const headParts = output.messages[2].parts as Record<string, unknown>[];
    expect(headParts[0]["text"]).toBe("protected reasoning");
    // Target message stripped
    const targetParts = output.messages[targetIdx].parts as Record<string, unknown>[];
    expect(targetParts[0]["text"]).toBe("[cleared]");
  });

  // A3: Orphaned tool_use parts get converted to synthetic tool results
  it("A3: repairs orphaned tool_use parts with no matching tool_result", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs } = buildStripTestMessages(
      [{ type: "text", text: "real content" }],
      "target-1",
    );
    // Add an assistant message with tool_use at index 4 (in stripping range)
    msgs.splice(4, 0, mockMessage("assistant", [
      { type: "tool_use", id: "orphan-1", name: "read" },
      { type: "text", text: "I used a tool" },
    ], "tool-msg"));
    // No matching tool_result anywhere
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    // The orphaned tool_use should be converted to a tool part
    const toolMsg = output.messages[4];
    const toolPart = toolMsg.parts[0] as Record<string, unknown>;
    expect(toolPart["type"]).toBe("tool");
    expect(toolPart["text"]).toBe("[context-stripped]");
  });

  // A3: tool_use with matching tool_result is NOT modified
  it("A3: does not modify tool_use that has a matching tool_result", async () => {
    const handler = createMessagesTransformHandler(state, logger as never);
    const { messages: msgs } = buildStripTestMessages(
      [{ type: "text", text: "real content" }],
      "target-1",
    );
    // Add assistant with tool_use at index 4
    msgs.splice(4, 0, mockMessage("assistant", [
      { type: "tool_use", id: "matched-1", name: "read" },
    ], "tool-msg"));
    // Add user message with matching tool_result at index 5
    msgs.splice(5, 0, mockMessage("user", [
      { type: "tool_result", tool_use_id: "matched-1", text: "file content" },
    ], "result-msg"));
    const output = makeOutput(msgs);
    await handler({} as never, output as never);
    // tool_use should remain unchanged
    const toolMsg = output.messages[4];
    const toolPart = toolMsg.parts[0] as Record<string, unknown>;
    expect(toolPart["type"]).toBe("tool_use");
    expect(toolPart["id"]).toBe("matched-1");
  });
});
