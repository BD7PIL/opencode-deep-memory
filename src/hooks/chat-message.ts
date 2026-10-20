/**
 * chat.message hook handler.
 *
 * Records the user's text for the turn so
 * `experimental.chat.system.transform` can run the one-time auto-search whisper
 * (README "Layer 4: Hybrid retrieval").
 *
 * The write side was missing entirely: `state.consumeLastUserText(sessionID)`
 * existed in the system transform, but nothing in src/ ever called
 * `recordLastUserText`, so `userQuery` was always undefined and the whisper
 * branch was unreachable in both v1 and v2.
 */
import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";

export function createChatMessageHandler(
  state: PluginState,
  logger?: Logger,
): NonNullable<Hooks["chat.message"]> {
  return async (input, output) => {
    if (!input.sessionID) return;

    const text = (output.parts ?? [])
      .map((part) => {
        const record = part as { type?: string; text?: unknown };
        return record.type === "text" && typeof record.text === "string" ? record.text : "";
      })
      .filter((chunk) => chunk.length > 0)
      .join("\n");

    if (text.length === 0) return;

    state.recordLastUserText(input.sessionID, text);
    logger?.debug("chat.message: recorded last user text", {
      sessionID: input.sessionID,
      length: text.length,
    });
  };
}