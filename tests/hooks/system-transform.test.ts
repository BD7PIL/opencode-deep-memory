import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSystemTransformHandler } from "../../src/hooks/system-transform.js";
import { createPluginState, type PluginState } from "../../src/hooks/shared-state.js";
import { scopeDir } from "../../src/shared/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function mockModel(): unknown {
  return { id: "test-model", providerID: "test" };
}

function setupDataRoot(opts: { memoryContent?: string }): {
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

describe("createSystemTransformHandler V4", () => {
  let state: PluginState;

  beforeEach(() => {
    state = createPluginState();
  });

  afterEach(() => {
    delete process.env["DEEP_MEMORY_DATA"];
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

  it("pushes single payload containing TOOL_HINT for any agent", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\n- rule 1\n",
    });
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID: "sess-1", model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("<deep-memory-stable>");
      expect(output.system[0]).toContain("memory_search");
      expect(output.system[0]).toContain("<constraints>");
      expect(output.system[0]).toContain("rule 1");
    } finally {
      cleanup();
    }
  });

  it("includes MEMORY.md content when file exists", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Decisions\nUse vitest.\n",
    });
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID: "sess-2", model: mockModel() as never }, output);

      expect(output.system[0]).toContain("Use vitest");
    } finally {
      cleanup();
    }
  });

  it("works without MEMORY.md (tool-hint only)", async () => {
    const { projectPath, cleanup } = setupDataRoot({});
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID: "sess-3", model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0]).toContain("memory_search");
      expect(output.system[0]).not.toContain("<constraints>");
    } finally {
      cleanup();
    }
  });

  it("produces byte-identical payload across calls when MEMORY.md unchanged", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\nStable rule.\n",
    });
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const out1 = { system: [] as string[] };
      const out2 = { system: [] as string[] };
      await handler({ sessionID: "s1", model: mockModel() as never }, out1);
      await handler({ sessionID: "s2", model: mockModel() as never }, out2);

      expect(out2.system[0]).toBe(out1.system[0]);
    } finally {
      cleanup();
    }
  });

  it("does NOT push any volatile block", async () => {
    const { projectPath, cleanup } = setupDataRoot({
      memoryContent: "## Rules\nrule\n",
    });
    try {
      const handler = createSystemTransformHandler(state, projectPath);
      const output = { system: [] as string[] };
      await handler({ sessionID: "sess-v", model: mockModel() as never }, output);

      expect(output.system.length).toBe(1);
      expect(output.system[0]).not.toContain("<deep-memory-volatile>");
      expect(output.system[0]).not.toContain("<relevant>");
    } finally {
      cleanup();
    }
  });
});
