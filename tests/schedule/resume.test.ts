import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleSessionCreated } from "../../src/schedule/resume.js";
import {
  createPluginState,
  type PluginState,
} from "../../src/hooks/shared-state.js";
import { memoryFilePath } from "../../src/shared/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeEvent(opts: {
  id: string;
  parentID?: string;
  title?: string;
  directory?: string;
}) {
  return {
    type: "session.created" as const,
    properties: {
      info: {
        id: opts.id,
        parentID: opts.parentID,
        title: opts.title ?? "Test Session",
        directory: opts.directory ?? "/tmp/test",
      },
    },
  };
}

describe("handleSessionCreated (resume detection)", () => {
  let state: PluginState;
  let projectPath: string;

  beforeEach(() => {
    state = createPluginState();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "dm-resume-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(projectPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function writeProjectMemory(content: string): void {
    const memoryPath = memoryFilePath("project", "memory", projectPath);
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    fs.writeFileSync(memoryPath, content, "utf8");
  }

  it("skips when parentID is set (sub-session)", async () => {
    writeProjectMemory("## Rules\n- rule 1\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-sub-1", parentID: "parent-1" }),
    });
    expect(state.hasPendingResume("sess-sub-1")).toBe(false);
  });

  it("skips when title starts with 'Memory ' (background session)", async () => {
    writeProjectMemory("## Rules\n- rule 1\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-bg-1", title: "Memory Dream Consolidation 2026-06-14" }),
    });
    expect(state.hasPendingResume("sess-bg-1")).toBe(false);
  });

  it("skips when MEMORY.md does not exist for project", async () => {
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-cold-1" }),
    });
    expect(state.hasPendingResume("sess-cold-1")).toBe(false);
  });

  it("sets pendingResume when MEMORY.md exists", async () => {
    writeProjectMemory("## Rules\n- rule 1\n- rule 2\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-resume-1" }),
    });
    expect(state.hasPendingResume("sess-resume-1")).toBe(true);
  });

  it("pendingResume has budget=3000 and matching projectHash", async () => {
    writeProjectMemory("## Rules\n- rule 1\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-resume-2" }),
    });
    const info = state.consumePendingResume("sess-resume-2");
    expect(info).toBeDefined();
    expect(info?.budgetTokens).toBe(3000);
    expect(typeof info?.projectHash).toBe("string");
    expect(info?.projectHash.length).toBe(16);
  });

  it("consumePendingResume is idempotent (second call returns undefined)", async () => {
    writeProjectMemory("## Rules\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-resume-3" }),
    });
    expect(state.consumePendingResume("sess-resume-3")).toBeDefined();
    expect(state.consumePendingResume("sess-resume-3")).toBeUndefined();
  });

  it("different sessions get independent resume flags", async () => {
    writeProjectMemory("## Rules\n");
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-a" }),
    });
    await handleSessionCreated({
      state,
      projectPath,
      event: makeEvent({ id: "sess-b" }),
    });
    expect(state.hasPendingResume("sess-a")).toBe(true);
    expect(state.hasPendingResume("sess-b")).toBe(true);
    state.consumePendingResume("sess-a");
    expect(state.hasPendingResume("sess-a")).toBe(false);
    expect(state.hasPendingResume("sess-b")).toBe(true);
  });

  it("does not throw on filesystem errors (best-effort stat)", async () => {
    await expect(
      handleSessionCreated({
        state,
        projectPath,
        event: makeEvent({ id: "sess-nosize" }),
      }),
    ).resolves.toBeUndefined();
    expect(state.hasPendingResume("sess-nosize")).toBe(false);
  });
});
