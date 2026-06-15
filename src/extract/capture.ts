/**
 * Checkpoint capture — fetch messages from SDK and write checkpoint.raw.json.
 *
 * Called by the compacting hook before the host destroys the conversation.
 * Writes a raw JSON dump that can be re-read for heuristic extraction.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../shared/log.js";
import { checkpointRawPath } from "../shared/paths.js";
import { acquireLock } from "../shared/lock.js";

/** Minimal client shape needed — avoids importing full PluginInput type. */
interface SessionClient {
  session: {
    messages(opts: {
      path: { id: string };
      query?: { directory?: string; limit?: number };
    }): Promise<{ data: Array<{ info: unknown; parts: unknown[] }> | undefined }>;
  };
}

export interface CaptureArgs {
  client: SessionClient;
  sessionID: string;
  projectPath: string;
  logger?: Logger;
}

export interface CaptureResult {
  messageCount: number;
  rawFilePath: string;
}

/**
 * Fetch all messages for a session and write them to checkpoint.raw.json.
 *
 * Defensive: returns empty result instead of throwing when no data.
 */
export async function captureMessages(args: CaptureArgs): Promise<CaptureResult> {
  const { client, sessionID, projectPath, logger } = args;

  let result: { data: Array<{ info: unknown; parts: unknown[] }> | undefined };
  try {
    result = await client.session.messages({ path: { id: sessionID } });
  } catch (err) {
    logger?.warn("captureMessages: SDK call failed", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { messageCount: 0, rawFilePath: "" };
  }

  if (!result.data || result.data.length === 0) {
    logger?.warn("captureMessages: no messages returned", { sessionID });
    return { messageCount: 0, rawFilePath: "" };
  }

  const rawFilePath = checkpointRawPath(projectPath, sessionID);
  const payload = JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      sessionID,
      messageCount: result.data.length,
      messages: result.data,
    },
    null,
    2,
  );

  // Ensure directory exists before locking
  await mkdir(path.dirname(rawFilePath), { recursive: true });

  const release = await acquireLock(rawFilePath);
  try {
    await writeFile(rawFilePath, payload, "utf-8");
  } finally {
    release();
  }

  logger?.debug("captureMessages: wrote raw checkpoint", {
    sessionID,
    messageCount: result.data.length,
    rawFilePath,
  });

  return { messageCount: result.data.length, rawFilePath };
}
