/**
 * chat.message hook — the write side of the auto-search whisper.
 *
 * Why this file exists: `state.consumeLastUserText(sessionID)` was wired in
 * the system transform, but NOTHING ever called `recordLastUserText` — so
 * `userQuery` was always undefined and the whisper branch was unreachable in
 * both v1 and v2. These cases pin the write side (and its skip conditions).
 *
 * The host's `Part` type is strict; the handler is deliberately permissive
 * (it only reads `part.type`/`part.text`), so the cases drive it through a
 * cast — some of them are exactly the "host sent something odd" shapes.
 */
import { describe, it, expect, vi } from "vitest";
import { createChatMessageHandler } from "../../src/hooks/chat-message.js";
import { createPluginState } from "../../src/hooks/shared-state.js";
import type { Logger } from "../../src/shared/log.js";

type Handler = ReturnType<typeof createChatMessageHandler>;

function handlerWith(state = createPluginState(), logger?: Logger): Handler {
  return createChatMessageHandler(state, logger);
}

function run(handler: Handler, sessionID: string, parts: unknown[]) {
  return handler({ sessionID } as never, { parts } as never);
}

describe("chat.message: records the turn's user text", () => {
  it("joins text parts and records them for the session", async () => {
    const state = createPluginState();
    await run(handlerWith(state), "s1", [
      { type: "text", text: "first" },
      { type: "tool", text: "ignored" },
      { type: "text", text: "second" },
    ]);
    expect(state.consumeLastUserText("s1")).toBe("first\nsecond");
  });

  it("skips when there is no sessionID or no text at all", async () => {
    const state = createPluginState();
    const handler = handlerWith(state);
    await run(handler, "", [{ type: "text", text: "dropped" }]);
    expect(state.consumeLastUserText("")).toBeUndefined();

    await run(handler, "s2", []);
    await run(handler, "s2", [{ type: "text", text: "" }]);
    await handler({ sessionID: "s2" } as never, {} as never);
    expect(state.consumeLastUserText("s2")).toBeUndefined();
  });

  it("ignores non-string text and logs the recording with its length", async () => {
    const debug = vi.fn();
    const state = createPluginState();
    const logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    await run(handlerWith(state, logger), "s3", [
      { type: "text", text: 42 },
      { type: "text", text: "kept" },
    ]);
    expect(state.consumeLastUserText("s3")).toBe("kept");
    expect(debug).toHaveBeenCalledWith(
      "chat.message: recorded last user text",
      expect.objectContaining({ sessionID: "s3", length: 4 }),
    );
  })

  it("caps the recorded text at 500 chars (consume side wants a query, not a transcript)", async () => {
    const state = createPluginState();
    await run(handlerWith(state), "s4", [{ type: "text", text: "x".repeat(900) }]);
    expect(state.consumeLastUserText("s4")).toHaveLength(500);
  });
});