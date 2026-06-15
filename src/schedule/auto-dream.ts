/**
 * Auto-dream scheduling — triggers memory consolidation on a 7-day cadence.
 *
 * Listens for `session.created` events and, when enough time has passed since
 * the last dream, spawns a background consolidation session via the dream executor.
 *
 * Falls back to a queued-dream flag if session creation fails.
 */

import fs from "node:fs";
import path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { scheduleFilePath, memoryFilePath } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { runDream } from "./dream-executor.js";

export const DREAM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NOTES_ACCUMULATION_THRESHOLD = 20; // lines

export interface AutoDreamConfig {
  client: PluginInput["client"];
  projectPath: string;
  model?: { providerID: string; modelID: string };
  logger?: Logger;
}

export interface ScheduleFile {
  lastDream: string | null;
  lastDistill: string | null;
  queuedDream?: boolean;
  queuedDreamReason?: string;
}

const DEFAULT_SCHEDULE: ScheduleFile = {
  lastDream: null,
  lastDistill: null,
};

function readScheduleFile(projectPath: string, dataRoot?: string): ScheduleFile {
  const filePath = scheduleFilePath(projectPath, dataRoot);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ScheduleFile;
    return {
      lastDream: parsed.lastDream ?? null,
      lastDistill: parsed.lastDistill ?? null,
      queuedDream: parsed.queuedDream,
      queuedDreamReason: parsed.queuedDreamReason,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function writeScheduleFile(
  projectPath: string,
  data: ScheduleFile,
  dataRoot?: string,
): void {
  const filePath = scheduleFilePath(projectPath, dataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export interface HandleSessionCreatedArgs {
  event: {
    type: "session.created";
    properties: {
      info: {
        id: string;
        parentID?: string;
        title: string;
        directory: string;
      };
    };
  };
  config: AutoDreamConfig;
}

export async function handleSessionCreatedForDream(
  args: HandleSessionCreatedArgs,
): Promise<void> {
  const { event, config } = args;
  const { client, projectPath, logger } = config;
  const info = event.properties.info;

  // 1. Skip sub-sessions
  if (info.parentID) {
    logger?.debug("auto-dream: skipping sub-session", {
      sessionID: info.id,
      parentID: info.parentID,
    });
    return;
  }

  // 2. Skip our own dream sessions
  if (info.title.startsWith("Memory ")) {
    logger?.debug("auto-dream: skipping Memory session", {
      sessionID: info.id,
      title: info.title,
    });
    return;
  }

  // 3. Read schedule file
  const schedule = readScheduleFile(projectPath);
  logger?.debug("auto-dream: schedule state", {
    lastDream: schedule.lastDream,
    queuedDream: schedule.queuedDream,
  });

  // 4. Handle queued dream (fallback from previous failure)
  if (schedule.queuedDream) {
    logger?.info("auto-dream: attempting queued dream", {
      reason: schedule.queuedDreamReason,
    });
    try {
      const result = await runDream({
        client,
        parentSessionID: info.id,
        projectPath,
        directory: info.directory,
        logger,
      });
      if (result.status === "spawned") {
        schedule.queuedDream = undefined;
        schedule.queuedDreamReason = undefined;
        writeScheduleFile(projectPath, schedule);
        logger?.info("auto-dream: queued dream succeeded, flag cleared");
      } else {
        logger?.warn("auto-dream: queued dream still failing, leaving flag");
      }
    } catch (err) {
      logger?.warn("auto-dream: queued dream attempt threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 5. Read notes.md (used for accumulation trigger + empty check)
  const notesPath = memoryFilePath("project", "notes", projectPath);
  let notesLines = 0;
  try {
    const content = fs.readFileSync(notesPath, "utf8");
    if (content.trim().length === 0) {
      logger?.debug("auto-dream: notes.md is empty, skipping spawn");
      return;
    }
    notesLines = content.split("\n").filter((l) => l.trim()).length;
  } catch {
    logger?.debug("auto-dream: notes.md not found, skipping spawn");
    return;
  }

  // 6. Determine if dream is due
  const isSevenDayDue =
    schedule.lastDream === null ||
    Date.now() - Date.parse(schedule.lastDream) > DREAM_INTERVAL_MS;

  let isAccumulationDue = false;
  if (!isSevenDayDue && schedule.lastDream !== null) {
    const hoursSinceLastDream =
      (Date.now() - Date.parse(schedule.lastDream)) / ONE_DAY_MS;
    if (hoursSinceLastDream >= 1 && notesLines > NOTES_ACCUMULATION_THRESHOLD) {
      isAccumulationDue = true;
      logger?.info("auto-dream: accumulation trigger", {
        notesLines,
        hoursSinceLastDream: hoursSinceLastDream.toFixed(1),
      });
    }
  }

  if (!isSevenDayDue && !isAccumulationDue) {
    logger?.debug("auto-dream: not due, skipping");
    return;
  }

  // 7. Update lastDream IMMEDIATELY (prevents re-trigger on next session.created)
  schedule.lastDream = new Date().toISOString();
  try {
    writeScheduleFile(projectPath, schedule);
  } catch (err) {
    logger?.error("auto-dream: failed to write schedule file", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 8. Spawn dream (fire-and-forget)
  logger?.info("auto-dream: spawning dream session", {
    sessionID: info.id,
    directory: info.directory,
  });

  try {
    // Fire-and-forget: do NOT await
    runDream({
      client,
      parentSessionID: info.id,
      projectPath,
      directory: info.directory,
      logger,
    }).catch((err) => {
      // If runDream rejects unexpectedly, set queued flag
      logger?.error("auto-dream: dream spawn failed unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        const fallback = readScheduleFile(projectPath);
        fallback.queuedDream = true;
        fallback.queuedDreamReason = `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
        writeScheduleFile(projectPath, fallback);
      } catch {
        logger?.error("auto-dream: failed to set queuedDream flag after error");
      }
    });
  } catch (err) {
    // Synchronous error in starting the promise chain
    logger?.error("auto-dream: failed to kick off dream", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      schedule.queuedDream = true;
      schedule.queuedDreamReason = `Kickoff failure: ${err instanceof Error ? err.message : String(err)}`;
      writeScheduleFile(projectPath, schedule);
    } catch {
      logger?.error("auto-dream: failed to set queuedDream flag");
    }
  }
}
