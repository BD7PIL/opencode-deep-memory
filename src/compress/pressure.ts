export type PressureLevel = "low" | "medium" | "high";

export interface PressureInfo {
  level: PressureLevel;
  ratio: number;
  estimatedTokens: number;
  maxContext: number;
}

const FALLBACK_MAX_CONTEXT = 128000;
const OPENCODE_COMPACTION_RATIO = 0.75;

const THRESHOLDS = {
  medium: 0.30,
  high: 0.50,
} as const;

let calibratedMaxContext = 0;

export function calibrateFromCompaction(lastInputTokens: number): void {
  if (lastInputTokens <= 0) return;
  const derived = Math.round(lastInputTokens / OPENCODE_COMPACTION_RATIO);
  calibratedMaxContext = derived;
}

export function getCalibratedMaxContext(): number {
  return calibratedMaxContext;
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] === "step-finish") {
        const tokens = (p as { tokens?: { input?: number } }).tokens;
        if (tokens?.input && tokens.input > 0) {
          return tokens.input;
        }
      }
    }
  }
  return 0;
}

export function detectPressure(messages: Array<{ info: { role: string }; parts: unknown[] }>): PressureInfo {
  const maxContext = calibratedMaxContext || FALLBACK_MAX_CONTEXT;
  const inputTokens = extractInputTokensFromMessages(messages);
  const estimated = inputTokens > 0 ? inputTokens : extractTokensFromMessages(messages);
  const ratio = Math.min(estimated / maxContext, 1.0);

  let level: PressureLevel;
  if (ratio >= THRESHOLDS.high) level = "high";
  else if (ratio >= THRESHOLDS.medium) level = "medium";
  else level = "low";

  return { level, ratio, estimatedTokens: estimated, maxContext };
}
