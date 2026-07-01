import { createHash } from "node:crypto";
import type { PluginState } from "../hooks/shared-state.js";

const CCR_TTL_MS = 30 * 60 * 1000;

export function ccrStore(
  state: PluginState,
  original: string,
  compressed: string,
  toolName?: string,
  callID?: string,
): string {
  const hash = sha256(original).slice(0, 24);
  state.ccStore(hash, {
    hash,
    original,
    compressed,
    createdAt: Date.now(),
    toolName,
    callID,
  });
  return hash;
}

export function ccrRetrieve(state: PluginState, hash: string): string | undefined {
  const entry = state.ccrGet(hash);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CCR_TTL_MS) return undefined;
  return entry.original;
}

export function ccrInjectMarker(compressed: string, hash: string): string {
  return `${compressed}\n[compressed — call deep_expand("${hash}") to restore original]`;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
