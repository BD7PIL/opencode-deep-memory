import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import type { DeepCompressionStats } from "../hooks/shared-state.js";
import { detectPressure } from "./pressure.js";
import { deduplicateToolOutputs } from "./dedup.js";
import { purgeOldErrors } from "./error-purge.js";
import { compressToolOutput } from "./tool-compress.js";
import { crushJsonArray } from "./json-crush.js";
import { pruneOldMessages } from "./message-prune.js";
import { ccrStore, ccrInjectMarker } from "./ccr.js";
import { shouldInjectNudge, buildNudgeText } from "./nudge.js";
import { detectMemoryNudge, buildMemoryNudge } from "./memory-nudge.js";
import { detectContentType } from "./detector.js";

interface MessagePart {
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    output?: string;
    error?: string;
    input?: Record<string, unknown>;
  };
}

interface Message {
  info: { role: string };
  parts: MessagePart[];
}

interface PipelineContext {
  messages: Message[];
  state: PluginState;
  logger?: Logger;
  modelId?: string;
}

interface PipelineResult {
  stats: DeepCompressionStats;
}

export function runCompressionPipeline(ctx: PipelineContext): PipelineResult {
  const { messages, state, logger } = ctx;
  const pressure = detectPressure(messages as Array<{ info: { role: string }; parts: unknown[] }>);
  state.recordInputTokens(pressure.estimatedTokens);

  const stats: DeepCompressionStats = {
    toolDedup: 0,
    errorPurge: 0,
    toolOutputCompressed: 0,
    jsonCrushed: 0,
    messagePruned: 0,
    ccrStored: 0,
    nudgeInjected: false,
    pressureLevel: pressure.level,
    estimatedTokens: pressure.estimatedTokens,
  };

  // === Always run (no threshold, every turn) ===
  stats.toolDedup = deduplicateToolOutputs(messages, state);
  stats.errorPurge = purgeOldErrors(messages);
  stats.jsonCrushed = crushJsonToolOutputs(messages, state);
  stats.toolOutputCompressed = compressOldToolOutputs(messages, state);

  // === Lossy: only when pressure ≥ 30% ===
  if (pressure.level === "medium" || pressure.level === "high") {
    stats.messagePruned = pruneOldMessages(messages);
  }

  // === Nudge: only when pressure ≥ 50% ===
  const messagesSinceNudge = state.messagesSinceLastNudge(messages.length);
  if (shouldInjectNudge(pressure.level, messagesSinceNudge)) {
    if (injectIntoLastAssistant(messages, buildNudgeText(pressure.level))) {
      stats.nudgeInjected = true;
      state.recordNudge(messages.length);
    }
  }

  // === Memory nudge: always check for memory-worthy patterns ===
  const memoryNudge = detectMemoryNudge(messages, state.messagesSinceLastNudge(messages.length));
  if (memoryNudge.injected) {
    if (injectIntoLastAssistant(messages, buildMemoryNudge(memoryNudge.type!))) {
      state.recordNudge(messages.length);
      logger?.debug("compress: memory nudge", { type: memoryNudge.type });
    }
  }

  const active = stats.toolDedup > 0 || stats.errorPurge > 0 || stats.toolOutputCompressed > 0 ||
    stats.jsonCrushed > 0 || stats.messagePruned > 0 || stats.nudgeInjected;
  if (active) {
    logger?.debug("compress: pipeline result", { ...stats });
  } else {
    logger?.debug("compress: no action needed", { ratio: pressure.ratio.toFixed(2) });
  }
  return { stats };
}

function injectIntoLastAssistant(messages: Message[], text: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;
    const textParts = msg.parts.filter(
      (p): p is MessagePart => typeof p === "object" && p !== null && p.type === "text"
    );
    const lastTextPart = textParts[textParts.length - 1];
    if (lastTextPart && typeof lastTextPart.text === "string") {
      lastTextPart.text += text;
      return true;
    }
  }
  return false;
}

function compressOldToolOutputs(messages: Message[], state: PluginState): number {
  let compressed = 0;
  const protectedTail = messages.length - 8;

  for (let i = 3; i < protectedTail; i++) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as MessagePart;
      if (p.type !== "tool") continue;
      if (p.state?.status !== "completed") continue;
      if (!p.state.output) continue;
      if (p.state.output === "[superseded by duplicate call]") continue;
      if (p.state.output.includes("[ccr:")) continue;

      const toolName = p.tool || "unknown";
      const output = p.state.output;
      const result = compressToolOutput(toolName, output);

      if (result.length < output.length * 0.7) {
        const hash = ccrStore(state, output, result, toolName, p.callID);
        p.state.output = ccrInjectMarker(result, hash);
        compressed++;
      }
    }
  }

  return compressed;
}

function crushJsonToolOutputs(messages: Message[], state: PluginState): number {
  let crushed = 0;
  const protectedTail = messages.length - 8;

  for (let i = 3; i < protectedTail; i++) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as MessagePart;
      if (p.type !== "tool") continue;
      if (p.state?.status !== "completed") continue;
      if (!p.state.output) continue;
      if (p.state.output.startsWith("[superseded")) continue;
      if (p.state.output.includes("[ccr:")) continue;

      if (detectContentType(p.state.output) !== "json") continue;

      const original = p.state.output;
      const crushed_output = crushJsonArray(original);

      if (crushed_output.length < original.length * 0.7) {
        const hash = ccrStore(state, original, crushed_output, p.tool, p.callID);
        p.state.output = ccrInjectMarker(crushed_output, hash);
        crushed++;
      }
    }
  }

  return crushed;
}
