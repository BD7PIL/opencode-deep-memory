import type { PluginState } from "../hooks/shared-state.js";
import { capToolOutput } from "./capture-cap.js";
import { ccrStore, ccrInjectMarker } from "./ccr.js";

export interface SinglePassStats {
  toolDedup: number;
  errorPurge: number;
  toolOutputCompressed: number;
  jsonCrushed: number;
  assistantCompressed: number;
  ccrStored: number;
}

interface Message {
  info: { role: string };
  parts: unknown[];
}

const PROTECTED_TOOLS = new Set([
  "question", "edit", "write", "todowrite",
  "memory_store", "memory_search", "memory_forget", "memory_expand",
  "deep_expand",
  "skill",
]);

const NEVER_DEDUP = new Set(["read", "bash", "grep", "glob", "find", "search"]);

const ERROR_PURGE_TURN_THRESHOLD = 4;
const PROTECTED_HEAD_SINGLE = 2;
const ASSISTANT_COMPRESS_MIN_LENGTH = 500;
const ASSISTANT_COMPRESS_SAVINGS_RATIO = 0.6;

function simpleHash(s: string): string {
  const len = s.length;
  const sampleSize = 500;
  let h = len;
  for (let i = 0; i < Math.min(len, sampleSize); i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  const tailStart = Math.max(sampleSize, len - sampleSize);
  for (let i = tailStart; i < len; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${len}:${h.toString(36)}`;
}

// LLMLingua selective compression: preserve structure, compress prose.
// IMPORTANT: tracks code-block state to keep ALL lines between ``` fences.
function compressAssistantText(text: string): string {
  if (text.length < ASSISTANT_COMPRESS_MIN_LENGTH) return text;

  // Skip texts containing code blocks to avoid empty-block bugs from
  // nested fence references (e.g. ```mermaid inside a ``` block).
  if (text.includes("```")) return text;

  const lines = text.split("\n");
  const head = 3;
  const tail = 3;
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < head || i >= lines.length - tail) { kept.push(line); continue; }

    if (/^#{1,3}\s/.test(line) ||
        /error|fail|warning|critical|important/i.test(line) ||
        /^\s*[-*]\s/.test(line) ||
        /^\s*\d+\.\s/.test(line) ||
        /^\/[^\s:]+/.test(line)) {
      kept.push(line);
    }
  }

  const result = kept.join("\n");
  return result.length < text.length * ASSISTANT_COMPRESS_SAVINGS_RATIO ? result : text;
}

export function singlePassCompress(
  messages: Message[],
  state: PluginState,
  protectedTail: number,
): SinglePassStats {
  const stats: SinglePassStats = {
    toolDedup: 0,
    errorPurge: 0,
    toolOutputCompressed: 0,
    jsonCrushed: 0,
    assistantCompressed: 0,
    ccrStored: 0,
  };

  const totalMessages = messages.length;
  if (totalMessages <= PROTECTED_HEAD_SINGLE) return stats;

  const seen = new Map<string, { msgIdx: number; outputHash: string }>();

  for (let i = PROTECTED_HEAD_SINGLE; i < totalMessages; i++) {
    const msg = messages[i];
    if (!msg?.parts?.length) continue;
    if (msg.info.role === "user") continue;

    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j];
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool") continue;

      const toolName = p["tool"] as string | undefined;
      const callID = p["callID"] as string | undefined;

      // === Error purge (age-based, all zones) ===
      const toolState = p["state"] as Record<string, unknown> | undefined;
      if (toolState?.["status"] === "error" && !PROTECTED_TOOLS.has(toolName ?? "")) {
        const age = totalMessages - i;
        if (age >= ERROR_PURGE_TURN_THRESHOLD) {
          if (typeof toolState["input"] === "object" && toolState["input"] !== null) {
            const input = toolState["input"] as Record<string, unknown>;
            for (const key of Object.keys(input)) {
              if (key === "command" || key === "query" || key === "path" || key === "filePath") continue;
              delete input[key];
            }
          }
          stats.errorPurge++;
        }
      }

      // === Tool compression + dedup + JSON crush (only outside protected tail) ===
      if (i >= protectedTail) continue;
      if (!toolName || !callID) continue;
      if (toolState?.["status"] !== "completed") continue;

      const output = typeof toolState?.["output"] === "string" ? toolState["output"] : undefined;
      if (!output) continue;
      if (output === "[OUTDATED — superseded by duplicate call]") continue;
      if (output.includes("deep_expand(")) continue;

      // === Stale-read marking (Layer 2) ===
      if (!PROTECTED_TOOLS.has(toolName) && !NEVER_DEDUP.has(toolName)) {
        const input = toolState["input"] as Record<string, unknown> | undefined;
        const signature = `${toolName}:${JSON.stringify(input ?? {})}`;
        const outputHash = simpleHash(output);

        const existing = seen.get(signature);
        if (existing && existing.outputHash === outputHash) {
          const prevMsg = messages[existing.msgIdx];
          for (const prevPart of prevMsg.parts) {
            if (typeof prevPart !== "object" || prevPart === null) continue;
            const pp = prevPart as Record<string, unknown>;
            const ppState = pp["state"] as Record<string, unknown> | undefined;
            if (typeof ppState?.["output"] === "string" &&
                !ppState["output"].includes("[OUTDATED") &&
                simpleHash(ppState["output"]) === outputHash) {
              ppState["output"] = "[OUTDATED — superseded by newer identical call]";
              stats.toolDedup++;
            }
          }
        }
        seen.set(signature, { msgIdx: i, outputHash });
      }

      // === V4 capture-time cap (replaces post-hoc tool compression + JSON crush) ===
      // Applied once per tool result. Original stored in CCR for deep_expand recovery.
      if (output.length >= 200 && !PROTECTED_TOOLS.has(toolName)) {
        const capResult = capToolOutput(output, toolName);
        if (capResult.capped) {
          const hash = ccrStore(state, output, capResult.output, toolName, callID);
          toolState["output"] = ccrInjectMarker(capResult.output, hash);
          stats.toolOutputCompressed++;
        }
      }
    }

    // === Assistant text compression (only outside protected tail) ===
    if (i < protectedTail && msg.info.role === "assistant") {
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j];
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (p["type"] !== "text") continue;
        const text = p["text"];
        if (typeof text !== "string") continue;
        const compressed = compressAssistantText(text);
        if (compressed !== text) {
          p["text"] = compressed;
          stats.assistantCompressed++;
        }
      }
    }
  }

  return stats;
}
