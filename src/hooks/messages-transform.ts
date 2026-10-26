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
import { maybeProactiveExpand } from "../compress/proactive-expand.js";

const NUDGE_THRESHOLD_TOKENS = 50_000;
const NUDGE_EMERGENCY_TOKENS = 120_000;

const KEEP_RECENT = 8;

/** C1: First N messages are never touched (system prompt + first user + first assistant). */
const PROTECTED_HEAD = 3;

/**
 * Stable per-kind nudge markers. These are prefixes of the rendered nudge text
 * and exist so the idempotency guard above survives the token count embedded in
 * the emergency/threshold messages changing between turns.
 */
const NUDGE_MARKER_POSTCOMPACT = "[context was compacted";
const NUDGE_MARKER_EMERGENCY = "[context at emergency level";
const NUDGE_MARKER_THRESHOLD = "[context at ";

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
  client: unknown,
  projectPath: string,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async (input, output) => {
    const messages = output.messages;

    // G9 (Headroom): proactive expansion — auto-restore compressed content
    // that matches the user's latest query, before any compression runs.
    await maybeProactiveExpand(state, messages as never);

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
        //
        // PAIRING GUARD (0.16.11): if removing the reasoning would leave this
        // assistant message with only whitespace text + tool parts, KEEP the
        // reasoning. The engine's wire conversion drops assistant messages
        // whose text is empty/whitespace, but their tool parts still become
        // tool-result messages — orphaned `tool` messages with no preceding
        // `tool_calls` (observed live: DeepSeek rejects the whole request with
        // "Messages with role 'tool' must be a response to a preceding message
        // with 'tool_calls'" while lenient providers accept it). The reasoning
        // part is what keeps such messages alive on the wire.
        if (partType === "reasoning" || partType === "thinking" || partType === "redacted_thinking") {
          const meta = p["metadata"] as Record<string, unknown> | undefined;
          if (meta) {
            const openrouter = meta["openrouter"] as Record<string, unknown> | undefined;
            if (openrouter?.["reasoning_details"]) {
              delete openrouter["reasoning_details"];
              stats.metadata_stripped++;
            }
          }
          const hasToolParts = msg.parts.some(
            (q) => q !== p && typeof q === "object" && q !== null && (q as Record<string, unknown>)["type"] === "tool",
          );
          const remainingSubstantive = hasToolParts
            ? msg.parts.some((q) => {
              if (typeof q !== "object" || q === null || q === p) return false;
              const qp = q as Record<string, unknown>;
              if (qp["type"] === "text") return typeof qp["text"] === "string" && qp["text"].trim() !== "";
              if (qp["type"] === "tool") return false;
              return !METADATA_PART_TYPES.has(String(qp["type"]));
            })
            : true;
          if (!remainingSubstantive) continue;
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

    // PAIRING PIN (0.16.11): an assistant message with tool parts whose text is
    // whitespace-only can be dropped by the engine's wire conversion (empty text)
    // while its tool results still emit — an orphaned `tool` message with no
    // preceding `tool_calls` (DeepSeek rejects the whole request; lenient
    // providers accept it, so the failure looked model-specific). Pin such
    // messages to the wire with minimal non-whitespace text, regardless of what
    // else the transform did to them.
    for (let i = PROTECTED_HEAD; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg?.parts?.length) continue;
      if (msg.info.role !== "assistant") continue;
      const hasTool = msg.parts.some((q) => typeof q === "object" && q !== null && (q as Record<string, unknown>)["type"] === "tool");
      if (!hasTool) continue;
      const substantive = msg.parts.some((q) => {
        if (typeof q !== "object" || q === null) return false;
        const qp = q as Record<string, unknown>;
        if (qp["type"] === "text") return typeof qp["text"] === "string" && qp["text"].trim() !== "";
        if (qp["type"] === "tool") return false;
        return !METADATA_PART_TYPES.has(String(qp["type"]));
      });
      if (substantive) continue;
      const textPart = msg.parts.find((q) => typeof q === "object" && q !== null && (q as Record<string, unknown>)["type"] === "text") as Record<string, unknown> | undefined;
      if (textPart) textPart["text"] = "(tool call)";
      else msg.parts.push({ type: "text", text: "(tool call)" } as never);
    }

    if (Object.values(stats).some(v => v > 0)) {
      logger?.debug("messages.transform: stripped", stats);
    }

    // P1: Content-aware compression (context_compress tool or subagent)
    const compressReq = await state.resolveContentAwareCompression(client as never);

    if (state.consumeCompressionTimedOut()) {
      const tuiClient = (client as { tui?: { showToast?: (args: unknown) => Promise<unknown> } })?.tui;
      if (tuiClient?.showToast) {
        tuiClient.showToast({
          body: {
            title: "deep-memory",
            message: "▣ deep-memory | compression timed out (5min)",
            variant: "warning",
            duration: 5000,
          },
        }).catch(() => {});
      }
    }

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

            // G5 (Cursor dynamic-context-discovery): write full output to file,
            // leave searchable pointer inline. Dual recovery: deep_expand(hash) or read(filePath).
            try {
              const { projectMemoryDir } = await import("../shared/paths.js");
              const { createHash } = await import("node:crypto");
              const { mkdir, writeFile } = await import("node:fs/promises");
              const { join } = await import("node:path");
              const outputDir = join(projectMemoryDir(projectPath), ".tool-outputs");
              await mkdir(outputDir, { recursive: true });
              const outputHash = createHash("sha256").update(output).digest("hex").slice(0, 12);
              const outputFilePath = join(outputDir, `${toolName}-${outputHash}.txt`);
              await writeFile(outputFilePath, output, "utf8");

              const capped = lines.slice(0, 10).join("\n") +
                `\n[... ${lines.length - 20} lines omitted. Full output: ${outputFilePath}\n` +
                `Use read or grep on that path. deep_expand also available.]\n` +
                lines.slice(-10).join("\n");
              const { ccrStore, ccrInjectMarker } = await import("../compress/ccr.js");
              const hash = ccrStore(state, output, capped, toolName);
              toolState["output"] = ccrInjectMarker(capped, hash);
            } catch {
              // Fallback: if file write fails, use CCR-only compression (original behavior)
              const capped = lines.slice(0, 10).join("\n") +
                `\n[... ${lines.length - 20} lines compressed — call deep_expand to restore ...]\n` +
                lines.slice(-10).join("\n");
              const { ccrStore, ccrInjectMarker } = await import("../compress/ccr.js");
              const hash = ccrStore(state, output, capped, toolName);
              toolState["output"] = ccrInjectMarker(capped, hash);
            }
            compressed++;
          } else if (decision === "stale") {
            toolState["output"] = "[OUTDATED — file was edited since this read. Use read to get current content.]";
            compressed++;
          }
        }
      }

      if (compressReq.summary) {
        // Mark old assistant messages in the compressed zone FIRST, so the
        // summary insert can be placed based on what the pass actually did.
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

        const summaryMsg = {
          info: { role: "assistant" },
          parts: [{
            type: "text",
            text: `[compressed-block: messages 1-${cutoff}]\n${compressReq.summary}\n[/compressed-block]`,
          }],
        };

        // Placement is measured, not assumed —
        // see scripts/measure-summary-placement.mts and docs/research/stage4-cache-work.md.
        //
        // When this pass rewrote anything, splicing at `cutoff` costs exactly
        // nothing: the divergence point is set by the rewrites just above, not by
        // the insert, so the ordered placement is free — and order is the reason
        // the block exists.
        //
        // When this pass rewrote nothing, the insert is the ONLY mutation, and a
        // mid-array splice re-prefilled the entire retained tail (8 messages /
        // 656 chars measured). Appending costs zero. Ordering is moot in that
        // case: with no compressed block, there is nothing for the summary to
        // precede.
        if (compressed > 0) {
          messages.splice(cutoff, 0, summaryMsg as never);
        } else {
          messages.push(summaryMsg as never);
          logger?.debug("messages.transform: summary appended (pass compressed nothing)");
        }
      }

      if (compressed > 0) {
        logger?.debug("messages.transform: content-aware compression", { compressed, summaryLen: compressReq.summary.length });

        const tuiClient = (client as { tui?: { showToast?: (args: unknown) => Promise<unknown> } })?.tui;
        if (tuiClient?.showToast) {
          tuiClient.showToast({
            body: {
              title: "deep-memory",
              message: `▣ deep-memory | context compressed: ${cutoff} msgs → summary block (${compressed} outputs compressed)`,
              variant: "info",
              duration: 5000,
            },
          }).catch(() => {});
        }
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
        // Idempotency guard: the transform runs once per request, so without a
        // stable marker the emergency nudge re-appended itself to the same tool
        // output on every request — growing that output without bound and
        // rewriting the tail every turn. The marker is per nudge KIND (not the
        // rendered text, which embeds a changing token count), so a new tool
        // output still gets a fresh nudge while a stable one gets exactly one.
        const nudgeMarker = postCompactNudge
          ? NUDGE_MARKER_POSTCOMPACT
          : estimated >= NUDGE_EMERGENCY_TOKENS
            ? NUDGE_MARKER_EMERGENCY
            : NUDGE_MARKER_THRESHOLD;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as { info: { role: string }; parts: unknown[] } | undefined;
          if (!msg?.parts) continue;
          for (const part of msg.parts) {
            const p = part as Record<string, unknown>;
            const toolState = p["state"] as Record<string, unknown> | undefined;
            if (p["type"] === "tool" && toolState && typeof toolState["output"] === "string") {
              if (!(toolState["output"] as string).includes(nudgeMarker)) {
                toolState["output"] += nudgeText;
                logger?.debug("messages.transform: nudge injected", {
                  type: postCompactNudge ? "postcompact" : estimated >= NUDGE_EMERGENCY_TOKENS ? "emergency" : "threshold",
                  tokens: estimated,
                });
              }
              break;
            }
          }
          if (nudgeText && Object.values(messages[i]?.parts?.[0] ?? {}).length > 0) break;
        }
      }
    }
  };
}
