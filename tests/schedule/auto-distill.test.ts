/**
 * Tests for auto-distill scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleSessionCreatedForDistill } from "../../src/schedule/auto-distill.js";
import { scheduleFilePath } from "../../src/shared/paths.js";

// Mock the distill executor
vi.mock("../../src/schedule/distill-executor.js", () => ({
  runDistill: vi.fn().mockResolvedValue({ sessionID: "distill-1", status: "spawned" as const }),
  DISTILL_INTERVAL_MS: 30 * 24 * 60 * 60 * 1000,
}));

import { runDistill } from "../../src/schedule/distill-executor.js";

function makeEvent(overrides: {
  id?: string;
  parentID?: string;
  title?: string;
  directory?: string;
} = {}) {
  return {
    type: "session.created" as const,
    properties: {
      info: {
        id: overrides.id ?? "sess-123",
        parentID: overrides.parentID,
        title: overrides.title ?? "Test Session",
        directory: overrides.directory ?? "/test/project",
      },
    },
  };
}

describe("handleSessionCreatedForDistill", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "dm-distill-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  function getSchedulePath(): string {
    return scheduleFilePath(projectPath);
  }

  function writeSchedule(data: Record<string, unknown>): void {
    const filePath = getSchedulePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  function readSchedule(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(getSchedulePath(), "utf8"));
  }

  it("skips session with parentID set (sub-session)", async () => {
    await handleSessionCreatedForDistill({
      event: makeEvent({ parentID: "parent-1" }),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDistill).not.toHaveBeenCalled();
    // No schedule file should be created
    expect(fs.existsSync(getSchedulePath())).toBe(false);
  });

  it('skips session with title starting with "Memory "', async () => {
    await handleSessionCreatedForDistill({
      event: makeEvent({ title: "Memory Distill Workflow Packaging 2026-06-14" }),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDistill).not.toHaveBeenCalled();
    expect(fs.existsSync(getSchedulePath())).toBe(false);
  });

  it("schedule file missing → triggers distill, creates schedule with lastDistill=now", async () => {
    const before = Date.now();

    await handleSessionCreatedForDistill({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // Schedule file should now exist with lastDistill set
    const schedule = readSchedule();
    expect(schedule["lastDistill"]).not.toBeNull();
    const parsed = Date.parse(schedule["lastDistill"] as string);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());

    // Distill should have been spawned (fire-and-forget, so we need to flush)
    await vi.waitFor(() => {
      expect(runDistill).toHaveBeenCalled();
    });
  });

  it("lastDistill 31 days ago → triggers distill", async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: null, lastDistill: thirtyOneDaysAgo });

    await handleSessionCreatedForDistill({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // lastDistill should be updated to now
    const schedule = readSchedule();
    expect(Date.parse(schedule["lastDistill"] as string)).toBeGreaterThan(
      Date.parse(thirtyOneDaysAgo),
    );

    // Distill should be spawned
    await vi.waitFor(() => {
      expect(runDistill).toHaveBeenCalled();
    });
  });

  it("lastDistill 10 days ago → does NOT trigger", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: null, lastDistill: tenDaysAgo });

    await handleSessionCreatedForDistill({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDistill).not.toHaveBeenCalled();

    // Schedule should not be modified
    const schedule = readSchedule();
    expect(schedule["lastDistill"]).toBe(tenDaysAgo);
  });
});
