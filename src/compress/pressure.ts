export type PressureLevel = "low" | "medium" | "high";

export interface PressureInfo {
  level: PressureLevel;
  ratio: number;
  estimatedTokens: number;
  maxContext: number;
}

const FALLBACK_MAX_CONTEXT = 1_000_000;
const OPENCODE_COMPACTION_RATIO = 0.75;

// Absolute token thresholds (not percentage-based)
// Percentage thresholds fail for large context windows:
//   200K context × 15% =  30K (too early)
//   1M context   × 15% = 150K (too late)
// Absolute thresholds behave consistently:
//   200K context: 50K/200K = 25% (reasonable)
//   1M context:   50K/1M   =  5% (reasonable)
// Based on Focus Agent paper (arXiv 2601.07190): post-compression context ~70K
const PRESSURE_MEDIUM_TOKENS = 50_000;
const PRESSURE_HIGH_TOKENS = 150_000;

let calibratedMaxContext = 0;

export function calibrateFromCompaction(lastInputTokens: number): void {
  if (lastInputTokens <= 0) return;
  calibratedMaxContext = Math.round(lastInputTokens / OPENCODE_COMPACTION_RATIO);
}

export function getCalibratedMaxContext(): number {
  return calibratedMaxContext;
}

export function maxContextFrom(modelContextWindow: number): number {
  if (modelContextWindow > 0) return modelContextWindow;
  if (calibratedMaxContext > 0) return calibratedMaxContext;
  return FALLBACK_MAX_CONTEXT;
}

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff]/.test(ch)) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 0.7 + other / 3.8);
}

export function extractTokensFromMessages(messages: Array<{ info: { role: string }; parts: unknown[] }>): number {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "text" && typeof p["text"] === "string") {
        total += estimateTokens(p["text"]);
      } else if (p["type"] === "tool") {
        const state = p["state"] as Record<string, unknown> | undefined;
        if (state?.["output"] && typeof state["output"] === "string") {
          total += estimateTokens(state["output"]);
        }
        if (state?.["error"] && typeof state["error"] === "string") {
          total += estimateTokens(state["error"]);
        }
      } else if (p["type"] === "reasoning" || p["type"] === "thinking") {
        if (typeof p["text"] === "string") {
          total += estimateTokens(p["text"]);
        }
      }
    }
  }
  return total;
}

export function extractInputTokensFromMessages(messages: Array<{ parts: unknown[] }>): number {
  let best = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "step-finish") continue;
      const tokens = p as { tokens?: { input?: number; cache?: { read?: number } } };
      const input = tokens.tokens?.input ?? 0;
      const cached = tokens.tokens?.cache?.read ?? 0;
      const total = input + cached;
      if (total > best) best = total;
      if (best > 0) return best;
    }
  }
  return best;
}

export function detectPressure(messages: Array<{ info: { role: string }; parts: unknown[] }>, modelContextWindow?: number): PressureInfo {
  const ctx = maxContextFrom(modelContextWindow || 0);
  const inputTokens = extractInputTokensFromMessages(messages);
  const estimated = inputTokens > 0 ? inputTokens : extractTokensFromMessages(messages);
  const ratio = Math.min(estimated / ctx, 1.0);

  let level: PressureLevel;
  if (estimated >= PRESSURE_HIGH_TOKENS) level = "high";
  else if (estimated >= PRESSURE_MEDIUM_TOKENS) level = "medium";
  else level = "low";

  return { level, ratio, estimatedTokens: estimated, maxContext: ctx };
}
