import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMemoryStoreTool } from "../../src/tools/memory-store.js";

function mockService(projectPath: string) {
  const memPath = path.join(projectPath, ".deep-memory", "MEMORY.md");
  return {
    project: projectPath,
    async addEntry(_scope: string, _type: string, section: string, content: string) {
      fs.mkdirSync(path.dirname(memPath), { recursive: true });
      let existing = "";
      if (fs.existsSync(memPath)) existing = fs.readFileSync(memPath, "utf8");
      const heading = `## ${section}`;
      if (existing.includes(heading)) {
        existing = existing.replace(heading, `${heading}\n- ${content}`);
      } else {
        existing = existing + `\n${heading}\n- ${content}\n`;
      }
      fs.writeFileSync(memPath, existing, "utf8");
    },
    async search() { return []; },
  } as never;
}

function mockCtx() {
  return { sessionID: "s", messageID: "m", agent: "a", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as never;
}

describe("memory_store tool", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createMemoryStoreTool>;
  let incrementCallCount: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-store-"));
    incrementCallCount = 0;
    const service = mockService(tmpDir);
    const state = { incrementMemoryStoreCount: () => { incrementCallCount++; } };
    tool = createMemoryStoreTool(service, state);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("stores a decision entry", async () => {
    const result = await tool.execute(
      { content: "Use PostgreSQL for persistence", type: "decision", scope: "project" },
      mockCtx(),
    );
    expect(result).toContain("Stored");
    expect(result).toContain("Decisions");

    const memPath = path.join(tmpDir, ".deep-memory", "MEMORY.md");
    const content = fs.readFileSync(memPath, "utf8");
    expect(content).toContain("Use PostgreSQL");
    expect(content).toContain("## Decisions");
  });

  it("appends date tag [YYYY-MM-DD] to entry", async () => {
    await tool.execute(
      { content: "Test entry", type: "fact", scope: "project" },
      mockCtx(),
    );
    const memPath = path.join(tmpDir, ".deep-memory", "MEMORY.md");
    const content = fs.readFileSync(memPath, "utf8");
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}\]/);
  });

  it("increments memory store count", async () => {
    await tool.execute(
      { content: "test", type: "note", scope: "project" },
      mockCtx(),
    );
    expect(incrementCallCount).toBe(1);
  });

  it("maps type to correct section", async () => {
    const types: Array<[string, string]> = [
      ["decision", "Decisions"],
      ["constraint", "Constraints"],
      ["gotcha", "Gotchas"],
      ["fact", "Facts"],
      ["note", "Notes"],
    ];
    for (const [type, section] of types) {
      const result = await tool.execute(
        { content: `test ${type}`, type: type as never, scope: "project" },
        mockCtx(),
      );
      expect(result).toContain(section);
    }
  });
});
