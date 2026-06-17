import type { PluginState } from "../hooks/shared-state.js";
import type { Logger } from "../shared/log.js";
import type { DeepCompressionStats } from "../hooks/shared-state.js";
import { detectPressure } from "./pressure.js";
import { shouldInjectNudge, buildNudgeText } from "./nudge.js";
import { detectMemoryNudge, buildMemoryNudge } from "./memory-nudge.js";
import { singlePassCompress, type SinglePassStats } from "./single-pass.js";

interface Message {
  info: { role: string };
  parts: unknown[];
}

interface PipelineContext {
  messages: Message[];
  state: PluginState;
  sessionID?: string;
  logger?: Logger;
}

interface PipelineResult {
  stats: DeepCompressionStats;
}

const KEEP_RECENT_TOKENS = 4000;

function estimateMessageTokens(msg: Message): number {
  let t = 0;
  for (const part of msg.parts) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    const text = typeof p["text"] === "string" ? p["text"] : "";
    if (p["type"] === "tool") {
      const s = p["state"] as Record<string, unknown> | undefined;
      const out = typeof s?.["output"] === "string" ? s["output"] : "";
      t += Math.ceil((text.length + out.length) / 4);
    } else {
      t += Math.ceil(text.length / 4);
    }
  }
  return t;
}

function computeProtectedTail(messages: Message[]): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateMessageTokens(messages[i]);
    if (tokens >= KEEP_RECENT_TOKENS) return i;
  }
  return 0;
}

export function runCompressionPipeline(ctx: PipelineContext): PipelineResult {
  const { messages, state, sessionID, logger } = ctx;
  const pressure = detectPressure(messages as Array<{ info: { role: string }; parts: unknown[] }>, state.getModelContextWindow());
  state.recordInputTokens(pressure.estimatedTokens);

  const protectedTail = computeProtectedTail(messages);

  // Single pass: dedup + error purge + tool output compress + JSON crush
  const spStats: SinglePassStats = singlePassCompress(messages, state, protectedTail);

  const stats: DeepCompressionStats = {
    toolDedup: spStats.toolDedup,
    errorPurge: spStats.errorPurge,
    toolOutputCompressed: spStats.toolOutputCompressed,
    jsonCrushed: spStats.jsonCrushed,
    assistantCompressed: spStats.assistantCompressed,
    ccrStored: spStats.ccrStored,
    nudgeInjected: false,
    pressureLevel: pressure.level,
    estimatedTokens: pressure.estimatedTokens,
  };

  const sid = sessionID || "default";

  // Nudge: only when pressure ≥ 50%
  const messagesSinceNudge = state.messagesSinceLastNudge(sid, messages.length);
  if (shouldInjectNudge(pressure.level, messagesSinceNudge)) {
    if (injectIntoLastAssistant(messages, buildNudgeText(pressure.level))) {
      stats.nudgeInjected = true;
      state.recordNudge(sid, messages.length);
    }
  }

  // Memory nudge
  const memoryNudge = detectMemoryNudge(messages as never, state.messagesSinceLastNudge(sid, messages.length));
  if (memoryNudge.injected) {
    if (injectIntoLastAssistant(messages, buildMemoryNudge(memoryNudge.type!))) {
      state.recordNudge(sid, messages.length);
      logger?.debug("compress: memory nudge", { type: memoryNudge.type });
    }
  }

  const active = stats.toolDedup > 0 || stats.errorPurge > 0 || stats.toolOutputCompressed > 0 ||
    stats.jsonCrushed > 0 || stats.assistantCompressed > 0 || stats.nudgeInjected;
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
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const p = msg.parts[j] as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        (p["text"] as string) += text;
        return true;
      }
    }
  }
  return false;
}
