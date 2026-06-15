import { describe, it, expect, beforeEach } from "vitest";
import { createSystemTransformHandler } from "../../src/hooks/system-transform.js";
import {
  createPluginState,
  type PluginState,
} from "../../src/hooks/shared-state.js";
import { scopeDir } from "../../src/shared/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Minimal Model type satisfying the fields system-transform actually reads
 * (it doesn't read any model fields today, but the hook signature requires it).
 */
function mockModel(): unknown {
  return { id: "test-model", providerID: "test" };
}

/**
 * Create a temp data root and a project path with optional MEMORY.md content.
 * Returns the projectPath to pass to the handler (DEEP_MEMORY_DATA env is set).
 */
function setupDataRoot(opts: { memoryContent?: string; checkpointContent?: string }): {
  projectPath: string;
  dataRoot: string;
  cleanup: () => void;
} {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-st-"));
  process.env["DEEP_MEMORY_DATA"] = dataRoot;
  const projectPath = path.join(os.tmpdir(), `dm-proj-${Math.random().toString(36).slice(2, 8)}`);

  // Mirror what memoryFilePath() will compute
  const projectDir = scopeDir("project", projectPath, undefined, dataRoot);
  fs.mkdirSync(projectDir, { recursive: true });
  if (opts.memoryContent !== undefined) {
    fs.writeFileSync(path.join(projectDir, "MEMORY.md"), opts.memoryContent, "utf8");
  }
  if (opts.checkpointContent !== undefined) {
    fs.writeFileSync(path.join(projectDir, "checkpoint.md"), opts.checkpointContent, "utf8");
  }

  return {
    projectPath,
    dataRoot,
    cleanup: () => {
      try {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

describe("createSystemTransformHandler", () => {
  let state: PluginState;

  beforeEach(() => {
    state = createPluginState();
  });

  it("skips when sessionID is undefined", async () => {
    const { projectPath, cleanup } = setupDataRoot({});
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID: undefined, model: mockModel() as never }, output);
      expect(output.system.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("uses post-resume mode and consumes flag when pendingResume set and agent is main", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const sessionID = "sess-resume-1";
      state.recordAgent(sessionID, "sisyphus"); // main tier
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      expect(state.hasPendingResume(sessionID)).toBe(true);

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      // Should have pushed a payload
      expect(output.system.length).toBe(1);
      // Payload should be larger than tool-subagent hint (3000t budget includes MEMORY.md)
      expect(output.system[0].length).toBeGreaterThan(150);
      // Flag should be consumed
      expect(state.hasPendingResume(sessionID)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("second call after consume uses normal mode (smaller payload or equal for empty memory)", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Decisions\n- decision 1\n".repeat(20),
    });
    try {
      const sessionID = "sess-resume-2";
      state.recordAgent(sessionID, "build"); // main tier
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      const handler = createSystemTransformHandler(state, projectPath);

      const output1 = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output1);

      const output2 = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output2);

      // First call had post-resume budget (3000t), second call has normal (800t)
      // Both should push payloads, but the first should be larger (more budget)
      expect(output1.system.length).toBe(1);
      expect(output2.system.length).toBe(1);
      expect(output1.system[0].length).toBeGreaterThanOrEqual(output2.system[0].length);
    } finally {
      cleanup();
    }
  });

  it("does NOT consume pendingResume when agent is non-main tier", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const sessionID = "sess-resume-3";
      state.recordAgent(sessionID, "explore"); // tool-subagent tier
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      // Tool-subagent still gets a small payload (tool hint)
      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("tool-hint");
      // Flag should remain (not consumed by non-main agent)
      expect(state.hasPendingResume(sessionID)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("pushes payload even without pendingResume (normal mode)", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const sessionID = "sess-normal-1";
      state.recordAgent(sessionID, "build"); // main tier, no pendingResume

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("<deep-memory>");
      expect(output.system[0]).toContain("tool-hint");
      expect(output.system[0]).toContain("persistent-memory");
    } finally {
      cleanup();
    }
  });

  it("produces tool-subagent-sized payload for explore agent", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- some rule\n",
    });
    try {
      const sessionID = "sess-subagent-1";
      state.recordAgent(sessionID, "librarian"); // tool-subagent tier

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0].length).toBeLessThan(600);
      expect(output.system[0]).not.toContain("persistent-memory");
    } finally {
      cleanup();
    }
  });

  it("handles unknown agent gracefully (defaults to main tier)", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule\n",
    });
    try {
      const sessionID = "sess-unknown-1";
      // No recordAgent call → agentOf returns undefined → defaults to main

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("persistent-memory");
    } finally {
      cleanup();
    }
  });
});
