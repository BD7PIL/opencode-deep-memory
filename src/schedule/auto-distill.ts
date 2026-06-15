/**
 * Auto-distill scheduling — triggers workflow distillation on a 30-day cadence.
 *
 * Listens for `session.created` events and, when enough time has passed since
 * the last distill, spawns a background distillation session via the distill executor.
 *
 * Falls back to a queued-distill flag if session creation fails.
 */

import fs from "node:fs";
import path from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import { scheduleFilePath } from "../shared/index.js";
import type { Logger } from "../shared/index.js";
import { runDistill, DISTILL_INTERVAL_MS } from "./distill-executor.js";

export { DISTILL_INTERVAL_MS };

export interface AutoDistillConfig {
  client: PluginInput["client"];
  projectPath: string;
  model?: { providerID: string; modelID: string };
  logger?: Logger;
}

interface ScheduleData {
  lastDream?: string | null;
  lastDistill?: string | null;
  queuedDream?: boolean;
  queuedDreamReason?: string;
  queuedDistill?: boolean;
  queuedDistillReason?: string;
  [key: string]: unknown;
}

const DEFAULT_SCHEDULE: ScheduleData = {
  lastDream: null,
  lastDistill: null,
};

function readScheduleFile(projectPath: string): ScheduleData {
  const filePath = scheduleFilePath(projectPath);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      lastDream: (parsed["lastDream"] as string | null) ?? null,
      lastDistill: (parsed["lastDistill"] as string | null) ?? null,
      queuedDream: parsed["queuedDream"] as boolean | undefined,
      queuedDreamReason: parsed["queuedDreamReason"] as string | undefined,
      queuedDistill: parsed["queuedDistill"] as boolean | undefined,
      queuedDistillReason: parsed["queuedDistillReason"] as string | undefined,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

function writeScheduleFile(projectPath: string, data: ScheduleData): void {
  const filePath = scheduleFilePath(projectPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export interface HandleSessionCreatedForDistillArgs {
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
  config: AutoDistillConfig;
}

export async function handleSessionCreatedForDistill(
  args: HandleSessionCreatedForDistillArgs,
): Promise<void> {
  const { event, config } = args;
  const { client, projectPath, logger } = config;
  const info = event.properties.info;

  // 1. Skip sub-sessions
  if (info.parentID) {
    logger?.debug("auto-distill: skipping sub-session", {
      sessionID: info.id,
      parentID: info.parentID,
    });
    return;
  }

  // 2. Skip our own distill/dream sessions
  if (info.title.startsWith("Memory ")) {
    logger?.debug("auto-distill: skipping Memory session", {
      sessionID: info.id,
      title: info.title,
    });
    return;
  }

  // 3. Read schedule file
  const schedule = readScheduleFile(projectPath);
  logger?.debug("auto-distill: schedule state", {
    lastDistill: schedule.lastDistill,
    queuedDistill: schedule.queuedDistill,
  });

  // 4. Handle queued distill (fallback from previous failure)
  if (schedule.queuedDistill) {
    logger?.info("auto-distill: attempting queued distill", {
      reason: schedule.queuedDistillReason,
    });
    try {
      const result = await runDistill({
        client,
        parentSessionID: info.id,
        projectPath,
        directory: info.directory,
        logger,
      });
      if (result.status === "spawned") {
        schedule.queuedDistill = undefined;
        schedule.queuedDistillReason = undefined;
        writeScheduleFile(projectPath, schedule);
        logger?.info("auto-distill: queued distill succeeded, flag cleared");
      } else {
        logger?.warn("auto-distill: queued distill still failing, leaving flag");
      }
    } catch (err) {
      logger?.warn("auto-distill: queued distill attempt threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // 5. Check if distill is due
  const isDue =
    schedule.lastDistill == null ||
    Date.now() - Date.parse(schedule.lastDistill) > DISTILL_INTERVAL_MS;

  if (!isDue) {
    logger?.debug("auto-distill: not due, skipping");
    return;
  }

  // 6. Update lastDistill IMMEDIATELY (prevents re-trigger on next session.created)
  schedule.lastDistill = new Date().toISOString();
  try {
    writeScheduleFile(projectPath, schedule);
  } catch (err) {
    logger?.error("auto-distill: failed to write schedule file", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 7. Spawn distill (fire-and-forget)
  logger?.info("auto-distill: spawning distill session", {
    sessionID: info.id,
    directory: info.directory,
  });

  try {
    // Fire-and-forget: do NOT await
    runDistill({
      client,
      parentSessionID: info.id,
      projectPath,
      directory: info.directory,
      logger,
    }).catch((err) => {
      // If runDistill rejects unexpectedly, set queued flag
      logger?.error("auto-distill: distill spawn failed unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        const fallback = readScheduleFile(projectPath);
        fallback.queuedDistill = true;
        fallback.queuedDistillReason = `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
        writeScheduleFile(projectPath, fallback);
      } catch {
        logger?.error("auto-distill: failed to set queuedDistill flag after error");
      }
    });
  } catch (err) {
    // Synchronous error in starting the promise chain
    logger?.error("auto-distill: failed to kick off distill", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      schedule.queuedDistill = true;
      schedule.queuedDistillReason = `Kickoff failure: ${err instanceof Error ? err.message : String(err)}`;
      writeScheduleFile(projectPath, schedule);
    } catch {
      logger?.error("auto-distill: failed to set queuedDistill flag");
    }
  }
}
