/**
 * Proactive expansion (G9 Headroom pattern).
 *
 * When the user's latest message relates to previously compressed tool output,
 * auto-restore that content BEFORE the agent asks for it. This prevents the
 * "I know this was compressed but I don't remember the hash" failure mode.
 *
 * Uses entity extraction (v0.12.1) + Jaccard overlap for relevance matching.
 * Throttled to once per 3 seconds to amortize cost.
 */

import type { PluginState } from "../hooks/shared-state.js";
import { extractEntities, entityOverlap } from "../shared/entity-extract.js";

/** Entity overlap threshold for auto-restore (0.4 = 40% shared entities). */
const PROACTIVE_THRESHOLD = 0.4;

/** Minimum CCR entry original size to bother restoring (skip tiny entries). */
const MIN_RESTORE_SIZE = 200;

/** Max entries to restore per turn (prevent context flood). */
const MAX_RESTORES_PER_TURN = 2;

interface MessageLike {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

/**
 * Check if the user's latest message relates to any compressed content.
 * If so, annotate the compressed tool output with the original content.
 *
 * @returns number of entries auto-restored (0 if none matched or throttled)
 */
export async function maybeProactiveExpand(
  state: PluginState,
  messages: MessageLike[],
): Promise<number> {
  // Throttle: skip if checked within last 3 seconds
  if (!state.canCheckProactiveExpansion()) return 0;
  state.recordProactiveCheck();

  // Extract the latest user message text
  const userText = extractLatestUserText(messages);
  if (!userText || userText.length < 5) return 0;

  // Extract entities from the user's query
  const queryEntities = extractEntities(userText);
  if (queryEntities.length === 0) return 0;

  // Get non-expired CCR entries
  const entries = state.ccrEntries();
  if (entries.length === 0) return 0;

  // Find matching entries
  const matches: Array<{ entry: typeof entries[0]; overlap: number }> = [];
  for (const entry of entries) {
    if (entry.original.length < MIN_RESTORE_SIZE) continue;
    const docEntities = extractEntities(entry.original);
    if (docEntities.length === 0) continue;
    const overlap = entityOverlap(queryEntities, docEntities);
    if (overlap >= PROACTIVE_THRESHOLD) {
      matches.push({ entry, overlap });
    }
  }

  if (matches.length === 0) return 0;

  // Sort by overlap descending, take top N
  matches.sort((a, b) => b.overlap - a.overlap);
  const toRestore = matches.slice(0, MAX_RESTORES_PER_TURN);

  // Annotate the compressed tool output messages with restored content
  let restored = 0;
  for (const { entry, overlap } of toRestore) {
    const annotation = formatRestoration(entry, overlap);
    if (annotateToolOutput(messages, entry.hash, annotation)) {
      restored++;
    }
  }

  return restored;
}

function extractLatestUserText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.info?.role !== "user") continue;
    if (!msg.parts) continue;
    const texts: string[] = [];
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        texts.push(part.text);
      }
    }
    if (texts.length > 0) return texts.join(" ");
  }
  return "";
}

function formatRestoration(
  entry: { hash: string; original: string; toolName?: string },
  overlap: number,
): string {
  const preview = entry.original.slice(0, 3000);
  return `\n[auto-restored — ${(overlap * 100).toFixed(0)}% entity overlap with your query${entry.toolName ? ` (${entry.toolName})` : ""}]\n${preview}${entry.original.length > 3000 ? "\n[... truncated at 3K chars]" : ""}`;
}

/**
 * Find the tool output message containing the given CCR hash
 * and append the restoration annotation.
 */
function annotateToolOutput(
  messages: MessageLike[],
  hash: string,
  annotation: string,
): boolean {
  const marker = `deep_expand("${hash}")`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      // The tool output may be in a 'state' sub-object
      const stateObj = (part as Record<string, unknown>)["state"] as Record<string, unknown> | undefined;
      if (stateObj && typeof stateObj["output"] === "string") {
        const output = stateObj["output"] as string;
        if (output.includes(hash) || output.includes(marker)) {
          // Found the compressed output — append restoration
          stateObj["output"] = output + annotation;
          return true;
        }
      }
      // Or the text part itself might contain the hash
      if (typeof part.text === "string" && part.text.includes(hash)) {
        part.text += annotation;
        return true;
      }
    }
  }
  return false;
}
