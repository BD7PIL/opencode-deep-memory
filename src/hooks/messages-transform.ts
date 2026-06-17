/**
 * experimental.chat.messages.transform hook handler.
 *
 * Deterministic content compression: removes old reasoning/thinking parts,
 * deletes system-injected messages, truncates tool errors, strips inline
 * thinking tags. NO marker text is injected — parts and messages are
 * physically removed from the arrays to prevent context confusion.
 *
 * Only touches assistant messages outside the protected tail (last 8 msgs).
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { PluginState } from "./shared-state.js";
import type { Logger } from "../shared/log.js";
import { runCompressionPipeline } from "../compress/index.js";

const KEEP_RECENT = 8;

/** C1: First N messages are never touched (system prompt + first user + first assistant). */
const PROTECTED_HEAD = 3;

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
 * A3: Defensive repair — ensure assistant messages with tool_use parts have
 * matching tool_result parts in subsequent messages. If a tool_result is
 * missing (e.g., due to aggressive future stripping), inject a synthetic one.
 *
 * Current implementation already skips messages containing tool parts, so this
 * is a safety net for forward-compatibility.
 */
function repairOrphanedToolCalls(
  messages: Array<{ info: { role: string }; parts: unknown[] }>,
): void {
  // Collect all tool_use IDs from assistant messages
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "tool_use" && typeof p["id"] === "string") {
        toolUseIds.add(p["id"]);
      }
    }
  }

  if (toolUseIds.size === 0) return;

  // Collect all tool_result IDs from user/tool-result messages
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "tool_result" && typeof p["tool_use_id"] === "string") {
        toolResultIds.add(p["tool_use_id"]);
      }
    }
  }

  // Find orphaned tool_use IDs (no matching tool_result)
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue;
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "tool_use" && typeof p["id"] === "string") {
        if (!toolResultIds.has(p["id"])) {
          // Convert orphaned tool_use to a synthetic tool result to prevent API errors
          p["type"] = "tool";
          p["state"] = { status: "ok" };
          p["text"] = "[context-stripped]";
        }
      }
    }
  }
}

/**
 * Create a messages.transform handler for content compression.
 *
 * Operates only on assistant messages outside the protected tail (last 8).
 * User messages are NEVER touched.
 */
export function createMessagesTransformHandler(
  state: PluginState,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async (input, output) => {
    const messages = output.messages;
    if (messages.length <= KEEP_RECENT) return;

    if (messages.length <= KEEP_RECENT + PROTECTED_HEAD) return;

    const protectedTailStart = messages.length - KEEP_RECENT;
    const stats = {
      reasoning_cleared: 0,
      metadata_stripped: 0,
      system_neutralized: 0,
      tool_errors_truncated: 0,
      thinking_stripped: 0,
    };

    const toRemove: number[] = [];

    for (let i = PROTECTED_HEAD; i < protectedTailStart; i++) {
      const msg = messages[i];
      if (!msg?.parts?.length) continue;

      // NEVER touch user messages
      if (msg.info.role === "user") continue;

      // Iterate parts IN REVERSE — safe for splice removal
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (typeof p["type"] !== "string") continue;
        const partType = p["type"] as string;

        // Skip metadata parts
        if (METADATA_PART_TYPES.has(partType)) continue;

        // O15: Reasoning/thinking parts — strip metadata, then REMOVE entirely
        // (not replaced with "[cleared]" — that causes context confusion)
        if (partType === "reasoning" || partType === "thinking" || partType === "redacted_thinking") {
          const meta = p["metadata"] as Record<string, unknown> | undefined;
          if (meta) {
            const openrouter = meta["openrouter"] as Record<string, unknown> | undefined;
            if (openrouter?.["reasoning_details"]) {
              delete openrouter["reasoning_details"];
              stats.metadata_stripped++;
            }
          }
          msg.parts.splice(j, 1);
          stats.reasoning_cleared++;
          continue;
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

      // O16: Collect system-injected messages for removal (deferred — safe splice)
      // NOT replaced with "[stripped]" — that causes context confusion
      if (isSystemInjected(msg)) {
        toRemove.push(i);
        stats.system_neutralized++;
      }
    }

    // Apply deferred message removals (reverse order — safe splice)
    for (let r = toRemove.length - 1; r >= 0; r--) {
      messages.splice(toRemove[r], 1);
    }

    // A3: Defensive repair — scan for orphaned tool_use parts.
    // Current code already skips messages with tool parts, so this is a
    // safety net in case future changes allow tool-part stripping.
    repairOrphanedToolCalls(messages);

    if (Object.values(stats).some(v => v > 0)) {
      logger?.debug("messages.transform: stripped", stats);
    }

    const pipelineResult = runCompressionPipeline({
      messages: output.messages as never,
      state,
      sessionID: (input as Record<string, unknown>)["sessionID"] as string | undefined,
      logger,
    });

    const ds = pipelineResult.stats;
    if (ds.toolDedup > 0 || ds.errorPurge > 0 || ds.toolOutputCompressed > 0 ||
        ds.jsonCrushed > 0 || ds.nudgeInjected) {
      logger?.debug("messages.transform: deep compression", { ...ds });
      state.mergeNotify({
        compression: stats,
        deepCompression: ds,
        messageCount: messages.length,
        protectedHead: PROTECTED_HEAD,
        protectedTail: KEEP_RECENT,
      });
    } else if (Object.values(stats).some(v => v > 0)) {
      state.mergeNotify({
        compression: stats,
        messageCount: messages.length,
        protectedHead: PROTECTED_HEAD,
        protectedTail: KEEP_RECENT,
      });
    }
  };
}
