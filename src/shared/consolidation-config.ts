/**
 * Consolidation feature config — the first config surface this plugin reads.
 *
 * Sources, lowest priority first: built-in defaults → plugin options tuple
 * (`plugin: ["@bd7pil/opencode-deep-memory", { consolidation: {...} }]` in the
 * host config, v1 hosts only) → env vars (works on v2 hosts too, where the
 * setup ctx carries no options).
 *
 * Born from the 2026-10-26 EL7 incident: a hardcoded `agent: "general"` in the
 * prompt body that v2 engines silently drop, four silent failure exits, and no
 * way to turn the feature off — 9 doomed sub-sessions in 40 minutes.
 */

export interface ConsolidationConfig {
  /** Master switch. Default true. */
  enabled: boolean;
  /** Agent id the consolidation sub-session runs as. Must exist on the host. */
  agent: string;
  /** Consecutive failed consolidations before giving up until process restart. */
  maxFailures: number;
  /** Give up waiting for a spawned sub-session after this long. */
  pendingTimeoutMs: number;
}

export const CONSOLIDATION_DEFAULTS: ConsolidationConfig = {
  enabled: true,
  agent: "general",
  maxFailures: 3,
  pendingTimeoutMs: 15 * 60_000,
};

export type ConsolidationOptions = { consolidation?: Partial<ConsolidationConfig> };

const FALSEY_STRINGS = new Set(["0", "false", "off", "no"]);

function asNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function asAgent(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const trimmed = v.trim();
  return trimmed !== "" ? trimmed : fallback;
}

export function resolveConsolidationConfig(
  options?: ConsolidationOptions,
  env: NodeJS.ProcessEnv = process.env,
): ConsolidationConfig {
  const raw = options?.consolidation ?? {};
  const enabledRaw = raw.enabled ?? env["DEEP_MEMORY_CONSOLIDATION"];
  const enabled =
    typeof enabledRaw === "boolean"
      ? enabledRaw
      : typeof enabledRaw === "string"
        ? !FALSEY_STRINGS.has(enabledRaw.trim().toLowerCase())
        : CONSOLIDATION_DEFAULTS.enabled;
  return {
    enabled,
    agent: asAgent(raw.agent ?? env["DEEP_MEMORY_CONSOLIDATION_AGENT"], CONSOLIDATION_DEFAULTS.agent),
    maxFailures: asNumber(
      raw.maxFailures ?? env["DEEP_MEMORY_CONSOLIDATION_MAX_FAILURES"],
      1,
      100,
      CONSOLIDATION_DEFAULTS.maxFailures,
    ),
    pendingTimeoutMs: asNumber(
      raw.pendingTimeoutMs ?? env["DEEP_MEMORY_CONSOLIDATION_PENDING_TIMEOUT_MS"],
      30_000,
      6 * 3_600_000,
      CONSOLIDATION_DEFAULTS.pendingTimeoutMs,
    ),
  };
}
