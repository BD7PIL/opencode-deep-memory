import type { PressureLevel } from "./pressure.js";

const NUDGE_COOLDOWN = 5;

export function shouldInjectNudge(level: PressureLevel, messageCount: number, lastNudgeAt: number): boolean {
  if (level !== "high" && level !== "critical") return false;
  if (messageCount - lastNudgeAt < NUDGE_COOLDOWN) return false;
  return true;
}

export function buildNudgeText(level: PressureLevel): string {
  if (level === "critical") {
    return "\n<dm-nudge level=\"critical\">Context is nearly full. Use deep_compress tool to compress old messages before the conversation becomes unusable.</dm-nudge>";
  }
  return "\n<dm-nudge level=\"high\">Context is getting large. Consider compressing old tool outputs and messages to free space.</dm-nudge>";
}
