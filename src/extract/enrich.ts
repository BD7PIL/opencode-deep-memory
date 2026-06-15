/**
 * Idle-layer LLM enrichment for checkpoint files.
 *
 * Cross-references checkpoint.md with the raw message dump to produce
 * a richer checkpoint via a background LLM session.
 *
 * See DESIGN.md §5.2 (Idle Layer under Dual-Layer Extraction).
 */

import { stat } from "node:fs/promises";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Logger } from "../shared/log.js";
import { checkpointRawPath, memoryFilePath } from "../shared/paths.js";
import { ENRICH_PROMPT_TEMPLATE } from "./enrich-prompt.js";

export interface EnrichmentOptions {
  client: PluginInput["client"];
  projectPath: string;
  sessionID: string;
  logger?: Logger;
}

export interface EnrichmentResult {
  sessionID: string;
  status: "spawned" | "failed" | "skipped";
}

/** Max age (ms) for checkpoint.raw.json — older files are stale, skip enrichment. */
const MAX_RAW_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Run idle-layer enrichment for a session that just finished compacting.
 *
 * Creates a background LLM session that cross-references checkpoint.md
 * with the raw message dump to produce a richer checkpoint.
 *
 * Returns "skipped" if preconditions are not met (files missing or stale),
 * "spawned" if the enrichment session was created, or "failed" on error.
 */
export async function runEnrichment(opts: EnrichmentOptions): Promise<EnrichmentResult> {
  const { client, projectPath, sessionID, logger } = opts;
  const emptyResult: EnrichmentResult = { sessionID: "", status: "skipped" };

  // 1. Check that checkpoint.raw.json exists and is fresh
  const rawPath = checkpointRawPath(projectPath, sessionID);
  let rawStat;
  try {
    rawStat = await stat(rawPath);
  } catch {
    logger?.debug("enrichment: checkpoint.raw.json missing, skipping", { sessionID, rawPath });
    return emptyResult;
  }

  // 3. Staleness check: if raw.json is older than 10 minutes, skip
  const rawAge = Date.now() - rawStat.mtimeMs;
  if (rawAge > MAX_RAW_AGE_MS) {
    logger?.debug("enrichment: checkpoint.raw.json is stale, skipping", {
      sessionID,
      rawPath,
      ageMinutes: Math.round(rawAge / 60_000),
    });
    return emptyResult;
  }

  // 2. Check that checkpoint.md exists
  const checkpointPath = memoryFilePath("project", "checkpoint", projectPath);
  try {
    await stat(checkpointPath);
  } catch {
    logger?.debug("enrichment: checkpoint.md missing, skipping", { sessionID, checkpointPath });
    return emptyResult;
  }

  // 4. Create background enrichment session
  try {
    const now = new Date().toISOString();
    const title = `Memory Checkpoint Enrichment ${now}`;

    const resp = await client.session.create({
      body: { title },
    });
    const enrichSessionID = resp.data?.id;
    if (!enrichSessionID) {
      logger?.warn("enrichment: session.create returned no ID", { sessionID });
      return { sessionID: "", status: "failed" };
    }

    // 5. Build prompt from template
    const prompt = ENRICH_PROMPT_TEMPLATE
      .replaceAll("{{checkpointPath}}", checkpointPath)
      .replaceAll("{{rawPath}}", rawPath)
      .replaceAll("{{projectPath}}", projectPath)
      .replaceAll("{{ISO timestamp}}", now);

    // 6. Fire enrichment prompt asynchronously
    await client.session.promptAsync({
      path: { id: enrichSessionID },
      body: {
        parts: [{ type: "text" as const, text: prompt }],
        agent: "sisyphus",
        tools: {
          memory_search: true,
          memory_store: true,
          read: true,
          list: true,
        },
      },
    });

    logger?.info("enrichment: spawned background session", {
      sessionID,
      enrichSessionID,
    });

    // 7. Return success
    return { sessionID: enrichSessionID, status: "spawned" };
  } catch (err) {
    // 8. Catch all errors — log and return failed, never rethrow
    logger?.warn("enrichment: failed to spawn background session", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sessionID: "", status: "failed" };
  }
}
