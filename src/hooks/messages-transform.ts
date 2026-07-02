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
import { extractTokensFromMessages } from "../compress/pressure.js";
import { classifyForCompression } from "../compress/classifier.js";

const NUDGE_THRESHOLD_TOKENS = 50_000;
const NUDGE_EMERGENCY_TOKENS = 120_000;

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

    if (Object.values(stats).some(v => v > 0)) {
      logger?.debug("messages.transform: stripped", stats);
    }

    // P1: Content-aware compression (context_compress tool)
    const compressReq = state.consumeContentAwareCompression();
    if (compressReq) {
      const cutoff = messages.length - compressReq.keepRecent;
      let compressed = 0;
      const recentEdits = state.getRecentEdits();
      const editSet = new Set(recentEdits);

      for (let i = 2; i < cutoff; i++) {
        const msg = messages[i] as { info: { role: string }; parts: unknown[] } | undefined;
        if (!msg?.parts?.length) continue;

        for (const part of msg.parts) {
          const p = part as Record<string, unknown>;
          if (p["type"] !== "tool") continue;
          const toolState = p["state"] as Record<string, unknown> | undefined;
          if (!toolState) continue;
          const toolName = p["tool"] as string | undefined;
          const output = typeof toolState["output"] === "string" ? toolState["output"] : "";
          if (!output || output.includes("deep_expand(")) continue;

          const decision = classifyForCompression(toolName, output, editSet);

          if (decision === "preserve") continue;

          if (decision === "transient") {
            const lines = output.split("\n");
            if (lines.length < 20) continue;
            const capped = lines.slice(0, 10).join("\n") +
              `\n[... ${lines.length - 20} lines compressed — call deep_expand to restore ...]\n` +
              lines.slice(-10).join("\n");
            const { ccrStore, ccrInjectMarker } = await import("../compress/ccr.js");
            const hash = ccrStore(state, output, capped, toolName);
            toolState["output"] = ccrInjectMarker(capped, hash);
            compressed++;
          } else if (decision === "stale") {
            toolState["output"] = "[OUTDATED — file was edited since this read. Use read to get current content.]";
            compressed++;
          }
        }
      }

      // Inject summary block as assistant message at cutoff position
      if (compressReq.summary) {
        const summaryMsg = {
          info: { role: "assistant" },
          parts: [{
            type: "text",
            text: `[compressed-block: messages 1-${cutoff}]\n${compressReq.summary}\n[/compressed-block]`,
          }],
        };
        messages.splice(cutoff, 0, summaryMsg as never);

        // Mark old assistant messages in compressed zone
        for (let i = 2; i < cutoff; i++) {
          const msg = messages[i] as { info: { role: string }; parts: unknown[] } | undefined;
          if (!msg?.parts) continue;
          if (msg.info.role !== "assistant") continue;
          for (const part of msg.parts) {
            const p = part as Record<string, unknown>;
            if (p["type"] !== "text") continue;
            const text = p["text"] as string;
            if (!text || text.includes("deep_expand(")) continue;
            const { ccrStore } = await import("../compress/ccr.js");
            const hash = ccrStore(state, text, "[compressed — see summary block above]", "assistant");
            p["text"] = `[compressed — call deep_expand("${hash}") to restore original]`;
            compressed++;
          }
        }
      }

      if (compressed > 0) {
        logger?.debug("messages.transform: content-aware compression", { compressed, summaryLen: compressReq.summary.length });
      }
    }

    const pipelineResult = runCompressionPipeline({
      messages: output.messages as never,
      state,
      sessionID: (input as Record<string, unknown>)["sessionID"] as string | undefined,
      logger,
    });

    const ds = pipelineResult.stats;
    if (ds.toolDedup > 0 || ds.errorPurge > 0 || ds.toolOutputCompressed > 0 ||
        ds.assistantCompressed > 0) {
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

    // P3: Nudge injector — threshold/emergency/postcompact
    const nudgeSessionID = (input as Record<string, unknown>)["sessionID"] as string | undefined;
    if (nudgeSessionID) {
      let nudgeText = "";
      const estimated = extractTokensFromMessages(messages as never);

      const postCompactNudge = state.consumePendingPostCompactNudge(nudgeSessionID);
      if (postCompactNudge) {
        nudgeText = `\n[context was compacted — context_compress tool is available if you need to reclaim token budget]`;
      } else if (estimated >= NUDGE_EMERGENCY_TOKENS) {
        nudgeText = `\n[context at emergency level (${Math.round(estimated / 1000)}K tokens) — use context_compress with a summary of older conversation to avoid compaction]`;
      } else if (estimated >= NUDGE_THRESHOLD_TOKENS && state.tryNudge("threshold", nudgeSessionID)) {
        nudgeText = `\n[context at ${Math.round(estimated / 1000)}K tokens — consider using context_compress with a summary of older conversation to reclaim space]`;
      }

      if (nudgeText) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as { info: { role: string }; parts: unknown[] } | undefined;
          if (!msg?.parts) continue;
          for (const part of msg.parts) {
            const p = part as Record<string, unknown>;
            const toolState = p["state"] as Record<string, unknown> | undefined;
            if (p["type"] === "tool" && toolState && typeof toolState["output"] === "string") {
              toolState["output"] += nudgeText;
              logger?.debug("messages.transform: nudge injected", {
                type: postCompactNudge ? "postcompact" : estimated >= NUDGE_EMERGENCY_TOKENS ? "emergency" : "threshold",
                tokens: estimated,
              });
              break;
            }
          }
          if (nudgeText && Object.values(messages[i]?.parts?.[0] ?? {}).length > 0) break;
        }
      }
    }
  };
}
