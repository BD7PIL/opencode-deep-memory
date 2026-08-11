import { describe, it, expect } from "vitest";
import { createMemorySearchTool } from "../../src/tools/memory-search.js";

function mockService(results: Array<{ score: number; scope: string; filePath: string; heading: string; snippet: string }>) {
  return {
    async search() { return results; },
  } as never;
}

function mockCtx() {
  return { sessionID: "s", messageID: "m", agent: "a", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as never;
}

describe("memory_search tool (additional coverage)", () => {
  it("includes snippet in output when present", async () => {
    const results = [
      { score: 1.5, scope: "project", filePath: "/proj/.deep-memory/MEMORY.md", heading: "Gotchas", snippet: "npm install fails on RHEL7" },
    ];
    const tool = createMemorySearchTool(mockService(results));

    const output = await tool.execute(
      { query: "npm", scope: "all", limit: 5 },
      mockCtx(),
    );

    expect(output).toContain("npm install fails");
  });

  it("displays score with 2 decimal places", async () => {
    const results = [
      { score: 1.23456, scope: "project", filePath: "/proj/MEMORY.md", heading: "", snippet: "x" },
    ];
    const tool = createMemorySearchTool(mockService(results));

    const output = await tool.execute(
      { query: "x", scope: "all", limit: 5 },
      mockCtx(),
    );

    expect(output).toContain("score=1.23");
  });

  it("shows file path in short form (basename only)", async () => {
    const results = [
      { score: 1.0, scope: "global", filePath: "/home/user/.local/share/opencode/deep-memory/global/MEMORY.md", heading: "Facts", snippet: "test" },
    ];
    const tool = createMemorySearchTool(mockService(results));

    const output = await tool.execute(
      { query: "test", scope: "all", limit: 5 },
      mockCtx(),
    );

    expect(output).toContain("global/MEMORY.md");
    expect(output).not.toContain("/home/user/.local");
  });
});
