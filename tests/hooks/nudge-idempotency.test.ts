/**
 * Nudge injection must be idempotent.
 *
 * The transform runs once per model request, so a nudge that re-appends itself
 * to the same tool output grew that output without bound AND rewrote the tail
 * every turn — paying a fresh cache miss each time for bytes the model had
 * already seen. The guard is a stable per-kind marker prefix, needed because the
 * rendered emergency/threshold text embeds a token count that changes between
 * turns and therefore cannot act as its own marker.
 */
import { describe, expect, it } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";
import { createMessagesTransformHandler } from "../../src/hooks/messages-transform.js";
import { withTempProject } from "../helpers/mock-host.js";

type Msg = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };

function makeMessages(count: number): Msg[] {
  const messages: Msg[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant" },
      parts: [{ type: "text", text: `plain content ${i}` }],
    });
  }
  // A tool part for the nudge to attach to.
  messages.push({
    info: { id: "m-tool", role: "assistant" },
    parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: "tool result body" } }],
  });
  return messages;
}

function lastToolOutput(messages: Msg[]): string {
  return (messages[messages.length - 1]!.parts[0]!.state as { output: string }).output;
}

describe("nudge injection idempotency", () => {
  it("injects the post-compact nudge once, not once per request", async () => {
    await withTempProject(async (project) => {
      const state = createPluginState();
      const handler = createMessagesTransformHandler(state, {}, project);
      const messages = makeMessages(14);

      state.setPendingPostCompactNudge("ses_nudge");
      await handler({ sessionID: "ses_nudge" } as never, { messages } as never);
      const afterFirst = lastToolOutput(messages);
      expect(afterFirst).toContain("context was compacted");

      // A second request in the same turn (a tool loop) must not duplicate it.
      state.setPendingPostCompactNudge("ses_nudge");
      await handler({ sessionID: "ses_nudge" } as never, { messages } as never);
      expect(lastToolOutput(messages)).toBe(afterFirst);
    });
  });

  it("still nudges a NEW tool output, so the signal is not lost", async () => {
    await withTempProject(async (project) => {
      const state = createPluginState();
      const handler = createMessagesTransformHandler(state, {}, project);
      const messages = makeMessages(14);

      state.setPendingPostCompactNudge("ses_nudge2");
      await handler({ sessionID: "ses_nudge2" } as never, { messages } as never);
      const firstOutput = lastToolOutput(messages);

      // A fresh tool call produces a new output that has never carried a nudge.
      messages.push({
        info: { id: "m-tool2", role: "assistant" },
        parts: [{ type: "tool", tool: "bash", state: { status: "completed", output: "second result" } }],
      });
      state.setPendingPostCompactNudge("ses_nudge2");
      await handler({ sessionID: "ses_nudge2" } as never, { messages } as never);

      expect(lastToolOutput(messages)).toContain("context was compacted");
      expect(lastToolOutput(messages)).not.toBe(firstOutput);
    });
  });
});