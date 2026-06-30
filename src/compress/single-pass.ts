import type { PluginState } from "../hooks/shared-state.js";
import { createToolSignature } from "./dedup.js";
import { compressToolOutput } from "./tool-compress.js";
import { crushJsonArray } from "./json-crush.js";
import { ccrStore, ccrInjectMarker } from "./ccr.js";
import { detectContentType } from "./detector.js";

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

interface TextSegment {
  type: "prose" | "code";
  lines: string[];
}

/**
 * Split text into alternating prose and code segments based on ``` fences.
 * Code segments include the opening and closing fence lines.
 * Trailing unterminated code is flushed as a code segment.
 */
export function splitByCodeFences(text: string): TextSegment[] {
  const lines = text.split("\n");
  const segments: TextSegment[] = [];
  let current: string[] = [];
  let inCode = false;

  const flush = (type: "prose" | "code") => {
    if (current.length > 0) {
      segments.push({ type, lines: current });
      current = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        flush("prose");
        current.push(line);
        inCode = true;
      } else {
        current.push(line);
        flush("code");
        inCode = false;
      }
    } else {
      current.push(line);
    }
  }
  flush(inCode ? "code" : "prose");
  return segments;
}

/**
 * Compress pure prose text (no code blocks).
 * Keeps head 3 + tail 3 lines, plus structural lines (headings, errors,
 * list items, numbered lists, file paths).
 */
export function compressPureProse(text: string): string {
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
  return kept.join("\n");
}

/**
 * Code-block-aware assistant text compression.
 *
 * Splits text into prose/code segments, compresses only prose segments
 * (preserving all code blocks verbatim), then reassembles. Falls back to
 * returning original text if code blocks are unbalanced (odd fence count)
 * to avoid the empty-block bug from malformed/nested fences.
 *
 * Replaces the v0.8.7 approach of `if (text.includes("```")) return text;`
 * which over-skipped: any assistant reply containing a code block was
 * entirely exempt from compression, even when the surrounding prose was
 * long enough to safely compress.
 */
function compressAssistantText(text: string): string {
  if (text.length < ASSISTANT_COMPRESS_MIN_LENGTH) return text;

  // Defensive: unbalanced fences → skip entirely (safe fallback like v0.8.7).
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) return text;

  const segments = splitByCodeFences(text);
  const hasCode = segments.some(s => s.type === "code");

  if (!hasCode) {
    const result = compressPureProse(text);
    return result.length < text.length * ASSISTANT_COMPRESS_SAVINGS_RATIO ? result : text;
  }

  const rebuilt = segments
    .map(seg => {
      if (seg.type === "code") return seg.lines.join("\n");
      const proseText = seg.lines.join("\n");
      if (proseText.length < ASSISTANT_COMPRESS_MIN_LENGTH) return proseText;
      return compressPureProse(proseText);
    })
    .join("\n");

  return rebuilt.length < text.length * ASSISTANT_COMPRESS_SAVINGS_RATIO ? rebuilt : text;
}

export { compressAssistantText };

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
      if (output === "[superseded by duplicate call]") continue;
      if (output.includes("[ccr:")) continue;

      // === Dedup ===
      if (!PROTECTED_TOOLS.has(toolName) && !NEVER_DEDUP.has(toolName)) {
        const input = toolState["input"] as Record<string, unknown> | undefined;
        const signature = createToolSignature(toolName, input);
        const outputHash = simpleHash(output);

        const existing = seen.get(signature);
        if (existing) {
          if (existing.outputHash === outputHash) {
            const prevMsg = messages[existing.msgIdx];
            for (const prevPart of prevMsg.parts) {
              if (typeof prevPart !== "object" || prevPart === null) continue;
              const pp = prevPart as Record<string, unknown>;
              const ppState = pp["state"] as Record<string, unknown> | undefined;
              if (ppState?.["output"] === "[superseded by duplicate call]") continue;
              if (typeof ppState?.["output"] === "string" && simpleHash(ppState["output"]) === outputHash) {
                ppState["output"] = "[superseded by duplicate call]";
                stats.toolDedup++;
              }
            }
          }
          seen.set(signature, { msgIdx: i, outputHash });
        } else {
          seen.set(signature, { msgIdx: i, outputHash });
        }
      }

      // === Tool output compression ===
      // PROTECTED_TOOLS (edit/write/etc.) are NEVER compressed — their output
      // may contain LSP diagnostics or file content the agent needs for verification.
      if (output.length >= 200 && !PROTECTED_TOOLS.has(toolName)) {
        const result = compressToolOutput(toolName, output);
        if (result.length < output.length * 0.85) {
          const hash = ccrStore(state, output, result, toolName, callID);
          toolState["output"] = ccrInjectMarker(result, hash);
          stats.toolOutputCompressed++;
          continue;
        }
      }

      // === JSON crush ===
      if (output.length >= 200 && detectContentType(output) === "json" && !PROTECTED_TOOLS.has(toolName)) {
        const crushed = crushJsonArray(output);
        if (crushed.length < output.length * 0.85) {
          const hash = ccrStore(state, output, crushed, toolName, callID);
          toolState["output"] = ccrInjectMarker(crushed, hash);
          stats.jsonCrushed++;
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
          const callRef = `assistant-${i}-${j}`;
          const hash = ccrStore(state, text, compressed, "assistant-text", callRef);
          p["text"] = ccrInjectMarker(compressed, hash);
          stats.assistantCompressed++;
          stats.ccrStored++;
        }
      }
    }
  }

  return stats;
}
