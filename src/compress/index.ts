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
  const pressure = detectPressure(messages as Array<{ info: { role: string }; parts: unknown[] }>, ctx.modelId);
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

  if (pressure.level === "low") {
    logger?.debug("compress: low pressure, skipping", { ratio: pressure.ratio.toFixed(2) });
    return { stats };
  }

  logger?.debug("compress: pipeline running", {
    level: pressure.level,
    ratio: pressure.ratio.toFixed(2),
    tokens: pressure.estimatedTokens,
  });

  if (pressure.level === "medium" || pressure.level === "high" || pressure.level === "critical") {
    stats.toolDedup = deduplicateToolOutputs(messages, state);
    stats.errorPurge = purgeOldErrors(messages);
    stats.toolOutputCompressed = compressOldToolOutputs(messages, state);
  }

  if (pressure.level === "high" || pressure.level === "critical") {
    stats.jsonCrushed = crushJsonToolOutputs(messages, state);
    stats.messagePruned = pruneOldMessages(messages);
  }

  if (shouldInjectNudge(pressure.level, messages.length, 0)) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      const textParts = lastMsg.parts.filter(
        (p): p is MessagePart => typeof p === "object" && p !== null && p.type === "text"
      );
      const lastTextPart = textParts[textParts.length - 1];
      if (lastTextPart && typeof lastTextPart.text === "string") {
        lastTextPart.text += buildNudgeText(pressure.level);
        stats.nudgeInjected = true;
      }
    }
  }

  if (stats.toolDedup > 0 || stats.errorPurge > 0 || stats.toolOutputCompressed > 0 ||
      stats.jsonCrushed > 0 || stats.messagePruned > 0 || stats.nudgeInjected) {
    logger?.debug("compress: pipeline complete", { ...stats });
  }
  return { stats };
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
      if (p.state.output.startsWith("[compressed")) continue;

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
      if (p.state.output.startsWith("[compressed")) continue;
      if (p.state.output.startsWith("[superseded")) continue;

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
