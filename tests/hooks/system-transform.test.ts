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

function mockModel(): unknown {
  return { id: "test-model", providerID: "test" };
}

function setupDataRoot(opts: { memoryContent?: string; checkpointContent?: string }): {
  projectPath: string;
  dataRoot: string;
  cleanup: () => void;
} {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dm-st-"));
  process.env["DEEP_MEMORY_DATA"] = dataRoot;
  const projectPath = path.join(os.tmpdir(), `dm-proj-${Math.random().toString(36).slice(2, 8)}`);

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

  it("pushes m[0]+m[1] for main tier with pendingResume", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const sessionID = "sess-resume-1";
      state.recordAgent(sessionID, "sisyphus");
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(2);
      expect(output.system[0]).toContain("<deep-memory-stable>");
      expect(output.system[1]).toContain("<deep-memory-volatile>");
      expect(state.hasPendingResume(sessionID)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("second call after consume uses normal mode", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Decisions\n- decision 1\n".repeat(20),
    });
    try {
      const sessionID = "sess-resume-2";
      state.recordAgent(sessionID, "build");
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      const handler = createSystemTransformHandler(state, projectPath);

      const output1 = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output1);

      const output2 = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output2);

      expect(output1.system.length).toBe(2);
      expect(output2.system.length).toBe(2);
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
      state.recordAgent(sessionID, "explore");
      state.setPendingResume(sessionID, { budgetTokens: 3000, projectHash: "abc" });

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system[0]).toContain("tool-hint");
      expect(state.hasPendingResume(sessionID)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("pushes m[0]+m[1] in normal mode for main tier", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const sessionID = "sess-normal-1";
      state.recordAgent(sessionID, "build");

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(2);
      expect(output.system[0]).toContain("<deep-memory-stable>");
      expect(output.system[0]).toContain("tool-hint");
      expect(output.system[0]).toContain("<constraints>");
      expect(output.system[1]).toContain("<deep-memory-volatile>");
    } finally {
      cleanup();
    }
  });

  it("produces stable-only for explore agent (subagent tier)", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- some rule\n",
    });
    try {
      const sessionID = "sess-subagent-1";
      state.recordAgent(sessionID, "librarian");

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system[0]).toContain("<deep-memory-stable>");
      expect(output.system[0]).toContain("tool-hint");
      expect(output.system[0]).not.toContain("<constraints>");
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

      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID, model: mockModel() as never }, output);

      expect(output.system.length).toBe(2);
      expect(output.system[0]).toContain("<constraints>");
    } finally {
      cleanup();
    }
  });
});
