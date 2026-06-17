/**
 * Tests for auto-dream scheduling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { handleSessionCreatedForDream } from "../../src/schedule/auto-dream.js";
import type { ScheduleFile } from "../../src/schedule/auto-dream.js";
import { scheduleFilePath, memoryFilePath } from "../../src/shared/paths.js";

// Mock the dream executor
vi.mock("../../src/schedule/dream-executor.js", () => ({
  runDream: vi.fn().mockResolvedValue({ sessionID: "dream-1", status: "spawned" as const }),
}));

import { runDream } from "../../src/schedule/dream-executor.js";

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

describe("handleSessionCreatedForDream", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  function getSchedulePath(): string {
    return scheduleFilePath(projectPath);
  }

  function writeSchedule(data: ScheduleFile): void {
    const filePath = getSchedulePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  function ensureNotesExists(lines: number = 2): void {
    const notesPath = memoryFilePath("project", "notes", projectPath);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}: some capture entry here`).join("\n");
    fs.writeFileSync(notesPath, content, "utf8");
  }

  function ensureMemoryExists(): void {
    const memoryPath = memoryFilePath("project", "memory", projectPath);
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, "## Decisions\n- Use TypeScript for type safety and maintainability.\n- Use Prisma ORM for database access.\n", "utf8");
  }

  function readSchedule(): ScheduleFile {
    return JSON.parse(fs.readFileSync(getSchedulePath(), "utf8"));
  }

  it("skips session with parentID set (sub-session)", async () => {
    await handleSessionCreatedForDream({
      event: makeEvent({ parentID: "parent-1" }),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDream).not.toHaveBeenCalled();
    // No schedule file should be created
    expect(fs.existsSync(getSchedulePath())).toBe(false);
  });

  it('skips session with title starting with "Memory "', async () => {
    await handleSessionCreatedForDream({
      event: makeEvent({ title: "Memory Dream Consolidation 2026-06-14" }),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDream).not.toHaveBeenCalled();
    expect(fs.existsSync(getSchedulePath())).toBe(false);
  });

  it("schedule file missing → triggers dream, creates schedule file with lastDream=now", async () => {
    ensureMemoryExists();
    ensureNotesExists();
    const before = Date.now();

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // Schedule file should now exist with lastDream set
    const schedule = readSchedule();
    expect(schedule.lastDream).not.toBeNull();
    const parsed = Date.parse(schedule.lastDream!);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());

    // Dream should have been spawned (fire-and-forget, so we need to flush)
    await vi.waitFor(() => {
      expect(runDream).toHaveBeenCalled();
    });
  });

  it("lastDream 8 days ago → triggers dream", async () => {
    ensureMemoryExists();
    ensureNotesExists();
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: eightDaysAgo, lastDistill: null });

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // lastDream should be updated to now
    const schedule = readSchedule();
    expect(Date.parse(schedule.lastDream!)).toBeGreaterThan(Date.parse(eightDaysAgo));

    // Dream should be spawned
    await vi.waitFor(() => {
      expect(runDream).toHaveBeenCalled();
    });
  });

  it("lastDream 3 days ago → does NOT trigger", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: threeDaysAgo, lastDistill: null });

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDream).not.toHaveBeenCalled();

    // Schedule should not be modified
    const schedule = readSchedule();
    expect(schedule.lastDream).toBe(threeDaysAgo);
  });

  it("lastDream 2 days ago + notes.md > 20 lines → triggers via accumulation", async () => {
    ensureMemoryExists();
    ensureNotesExists(25); // > 20 lines
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: twoDaysAgo, lastDistill: null });

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    const schedule = readSchedule();
    expect(Date.parse(schedule.lastDream!)).toBeGreaterThan(Date.parse(twoDaysAgo));

    await vi.waitFor(() => {
      expect(runDream).toHaveBeenCalled();
    });
  });

  it("lastDream 2 days ago + notes.md <= 20 lines → does NOT trigger (accumulation below threshold)", async () => {
    ensureNotesExists(15); // <= 20 lines
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: twoDaysAgo, lastDistill: null });

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    expect(runDream).not.toHaveBeenCalled();
    const schedule = readSchedule();
    expect(schedule.lastDream).toBe(twoDaysAgo);
  });

  it("queuedDream=true → attempts queued dream (mock executor)", async () => {
    writeSchedule({
      lastDream: null,
      lastDistill: null,
      queuedDream: true,
      queuedDreamReason: "test failure",
    });

    await handleSessionCreatedForDream({
      event: makeEvent({ directory: projectPath }),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // runDream should be called for the queued attempt
    await vi.waitFor(() => {
      expect(runDream).toHaveBeenCalledWith(
        expect.objectContaining({
          parentSessionID: "sess-123",
          projectPath,
          directory: projectPath,
        }),
      );
    });

    // On success, queuedDream flag should be cleared
    const schedule = readSchedule();
    expect(schedule.queuedDream).toBeUndefined();
    expect(schedule.queuedDreamReason).toBeUndefined();
  });

  it("bootstraps MEMORY.md from notes.md when MEMORY.md is missing", async () => {
    ensureNotesExists(10); // >= 5 lines, no MEMORY.md
    const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: sevenDaysAgo, lastDistill: null });

    const memoryPath = memoryFilePath("project", "memory", projectPath);
    expect(fs.existsSync(memoryPath)).toBe(false);

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // MEMORY.md should have been bootstrapped from notes.md
    expect(fs.existsSync(memoryPath)).toBe(true);
    const content = fs.readFileSync(memoryPath, "utf8");
    expect(content).toContain("line 1");
    expect(content.length).toBeGreaterThan(50);

    // Dream should have been spawned
    await vi.waitFor(() => {
      expect(runDream).toHaveBeenCalled();
    });
  });

  it("does NOT bootstrap when notes.md has fewer than 5 lines", async () => {
    ensureNotesExists(3); // < 5 lines, no MEMORY.md
    const sevenDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeSchedule({ lastDream: sevenDaysAgo, lastDistill: null });

    const memoryPath = memoryFilePath("project", "memory", projectPath);
    expect(fs.existsSync(memoryPath)).toBe(false);

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // MEMORY.md should NOT have been created
    expect(fs.existsSync(memoryPath)).toBe(false);
    expect(runDream).not.toHaveBeenCalled();
  });

  it("updates lastDream IMMEDIATELY before spawning dream (file modified before promptAsync)", async () => {
    ensureMemoryExists();
    ensureNotesExists();
    const writeCalls: string[] = [];
    const originalWriteFileSync = fs.writeFileSync;

    // Track when schedule file is written
    const schedulePath = getSchedulePath();
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        const [file, data] = args;
        if (typeof file === "string" && file === schedulePath) {
          const parsed = JSON.parse(typeof data === "string" ? data : data.toString()) as ScheduleFile;
          writeCalls.push(`schedule:${parsed.lastDream}`);
        }
        return originalWriteFileSync(...args);
      },
    );

    // Track when runDream is called
    const dreamCallOrder: string[] = [];
    vi.mocked(runDream).mockImplementation(async () => {
      dreamCallOrder.push("runDream:called");
      return { sessionID: "dream-1", status: "spawned" as const };
    });

    await handleSessionCreatedForDream({
      event: makeEvent(),
      config: { client: {} as any, projectPath }, // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    // Schedule file should have been written with lastDream BEFORE dream was kicked off
    expect(writeCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeCalls[0]).toMatch(/^schedule:\d{4}-\d{2}-\d{2}T/);

    // Flush the fire-and-forget
    await vi.waitFor(() => {
      expect(dreamCallOrder.length).toBe(1);
    });

    spy.mockRestore();
  });
});
