/**
 * v2 -> v1 event normalization.
 *
 * opencode v2 does not emit the v1 event names this plugin's `event` hook
 * switches on. `session.idle` and `session.compacted` **do not exist** on
 * 2.0.32 — the lifecycle is reported as `session.execution.*` and
 * `session.compaction.*` instead (verified against a live engine:
 * docs/research/v2-032-respike.md §4).
 *
 * Without this mapping the v2 bridge silently drops idle-triggered memory
 * consolidation (the primary consolidation path), compaction pressure
 * calibration, the compaction audit log, and `session.deleted` cleanup.
 */
import type { V2Event } from "./v2-types.js";

/** v2 event type -> the v1 event type the existing handler understands. */
const V2_TO_V1_TYPE: Record<string, string> = {
  "session.created": "session.created",
  // v2 replaced the single idle notification with an execution lifecycle.
  "session.execution.succeeded": "session.idle",
  "session.execution.failed": "session.error",
  // v2 replaced session.compacted with a compaction lifecycle. Only `started`
  // is mapped: it fires exactly once per compaction, whereas
  // `session.compaction.delta` streams (and would re-fire the audit log and
  // the pressure calibration once per delta).
  "session.compaction.started": "session.compacted",
  "session.deleted": "session.deleted",
};

/** The `{type, properties}` shape the v1 event handler reads. */
export interface V1EventShape {
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Translate a v2 event into the shape the v1 handler consumes.
 *
 * Returns undefined for events this plugin has no interest in, so the caller
 * can skip them without building a payload.
 */
export function normalizeV2Event(event: V2Event): V1EventShape | undefined {
  const type = typeof event?.type === "string" ? event.type : "";
  const v1Type = V2_TO_V1_TYPE[type];
  if (!v1Type) return undefined;

  const data = (event.data ?? {}) as Record<string, unknown>;
  const rawSessionID = data["sessionID"];
  const sessionID = typeof rawSessionID === "string" ? rawSessionID : undefined;
  // v2 events are broadcast to every plugin instance with the owning location
  // attached. The v1 handler needs it to stay out of other projects' sessions.
  const locationDirectory =
    typeof event.location?.directory === "string" ? event.location.directory : undefined;

  switch (v1Type) {
    case "session.error":
      return { type: v1Type, properties: { sessionID, locationDirectory, error: data["error"] ?? event.data } };
    case "session.deleted":
      // The v1 handler reads properties.info.id to forget the session's agent.
      return { type: v1Type, properties: { sessionID, locationDirectory, info: { id: sessionID } } };
    case "session.created":
      return { type: v1Type, properties: { sessionID, locationDirectory, info: event.data } };
    default:
      // session.idle / session.compacted both read properties.sessionID.
      return { type: v1Type, properties: { sessionID, locationDirectory } };
  }
}