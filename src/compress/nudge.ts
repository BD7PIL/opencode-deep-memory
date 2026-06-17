import type { PressureLevel } from "./pressure.js";

const NUDGE_COOLDOWN = 5;

export function shouldInjectNudge(level: PressureLevel, messagesSinceLastNudge: number): boolean {
  if (level !== "high") return false;
  if (messagesSinceLastNudge < NUDGE_COOLDOWN) return false;
  return true;
}

export function buildNudgeText(level: PressureLevel): string {
  if (level === "high") {
    return "\n<dm-nudge level=\"high\">Context pressure is high. Consider summarizing old completed tasks and moving on. Use memory_store to persist important findings before they are compressed.</dm-nudge>";
  }
  return "";
}
