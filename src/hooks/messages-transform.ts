/**
 * experimental.chat.messages.transform hook handler.
 *
 * Deterministic content compression: clears old reasoning, strips system
 * injections, truncates tool errors, removes inline thinking tags.
 * Only touches assistant messages outside the protected tail (last 8 messages).
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";

const KEEP_RECENT = 8;

const SYSTEM_INJECTION_PATTERNS = [
  /^$/,
  /^<!-- OMO_INTERNAL_INITIATOR -->$/,
  /^<system-reminder>[\s\S]*<\/system-reminder>$/,
  /^\[SYSTEM DIRECTIVE:/,
  /^\[Category\+Skill Reminder\]/,
  /^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/,
  /^\[task CALL FAILED/,
  /^\[EMERGENCY CONTEXT WINDOW WARNING\]/,
];

const INLINE_THINKING_RE = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

const METADATA_PART_TYPES = new Set([
  "step-start", "step-finish", "snapshot", "patch",
  "agent", "retry", "subtask", "compaction",
]);

/** Check if a message's non-metadata text parts ALL match system injection patterns. */
function isSystemInjected(msg: { parts: unknown[] }): boolean {
  let hasText = false;
  let allInjected = true;
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (typeof p["type"] !== "string") continue;
    const partType = p["type"] as string;
    if (METADATA_PART_TYPES.has(partType)) continue;
    if (partType === "tool") { allInjected = false; break; }
    if (partType === "text" && typeof p["text"] === "string") {
      hasText = true;
      if (!SYSTEM_INJECTION_PATTERNS.some(pat => pat.test((p["text"] as string).trim()))) {
        allInjected = false;
        break;
      }
    }
  }
  return hasText && allInjected;
}

/**
 * Create a messages.transform handler for content compression.
 *
 * Operates only on assistant messages outside the protected tail (last 8).
 * User messages are NEVER touched.
 */
export function createMessagesTransformHandler(
  _state: PluginState,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async (_input, output) => {
    const messages = output.messages;
    if (messages.length <= KEEP_RECENT) return;

    const protectedTailStart = messages.length - KEEP_RECENT;
    const stats = {
      reasoning_cleared: 0,
      metadata_stripped: 0,
      system_neutralized: 0,
      tool_errors_truncated: 0,
      thinking_stripped: 0,
    };

    for (let i = 0; i < protectedTailStart; i++) {
      const msg = messages[i];
      if (!msg?.parts?.length) continue;

      // NEVER touch user messages
      if (msg.info.role === "user") continue;

      for (let j = 0; j < msg.parts.length; j++) {
        const part = msg.parts[j];
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (typeof p["type"] !== "string") continue;
        const partType = p["type"] as string;

        // Skip metadata parts
        if (METADATA_PART_TYPES.has(partType)) continue;

        // O15: Strip reasoning metadata (OpenRouter)
        if (partType === "reasoning" || partType === "thinking" || partType === "redacted_thinking") {
          const meta = p["metadata"] as Record<string, unknown> | undefined;
          if (meta) {
            const openrouter = meta["openrouter"] as Record<string, unknown> | undefined;
            if (openrouter?.["reasoning_details"]) {
              delete openrouter["reasoning_details"];
              stats.metadata_stripped++;
            }
          }
          // O15b: Clear old reasoning text
          if (typeof p["text"] === "string" && p["text"] !== "[cleared]") {
            p["text"] = "[cleared]";
            stats.reasoning_cleared++;
          }
        }

        // O15: Strip tool reasoning metadata
        if (partType === "tool") {
          const meta = p["metadata"] as Record<string, unknown> | undefined;
          if (meta) {
            const openrouter = meta["openrouter"] as Record<string, unknown> | undefined;
            if (openrouter?.["reasoning_details"]) {
              delete openrouter["reasoning_details"];
              stats.metadata_stripped++;
            }
          }
          // O17: Truncate old tool errors
          const toolState = p["state"] as Record<string, unknown> | undefined;
          if (toolState?.["status"] === "error" && typeof toolState["error"] === "string") {
            if ((toolState["error"] as string).length > 100) {
              toolState["error"] = (toolState["error"] as string).slice(0, 100) + "... [truncated]";
              stats.tool_errors_truncated++;
            }
          }
        }

        // O19: Strip inline thinking tags
        if (partType === "text" && typeof p["text"] === "string") {
          const cleaned = (p["text"] as string).replace(INLINE_THINKING_RE, "");
          if (cleaned !== p["text"]) {
            p["text"] = cleaned;
            stats.thinking_stripped++;
          }
        }
      }

      // O16: Strip system-injected messages (sentinel replacement)
      if (isSystemInjected(msg)) {
        msg.parts.length = 0;
        msg.parts.push({ type: "text", text: "[stripped]" } as never);
        stats.system_neutralized++;
      }
    }

    if (Object.values(stats).some(v => v > 0)) {
      logger?.debug("messages.transform: stripped", stats);
    }
  };
}
