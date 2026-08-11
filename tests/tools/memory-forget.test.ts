import { describe, it, expect } from "vitest";
import { createMemoryForgetTool } from "../../src/tools/memory-forget.js";

function mockService(opts: {
  searchResults?: Array<{ score: number; scope: string; filePath: string; heading: string; snippet: string }>;
  removeResult?: { removed: number };
}) {
  return {
    async search() { return opts.searchResults ?? []; },
    async removeEntry() { return opts.removeResult ?? { removed: 0 }; },
  } as never;
}

function mockCtx() {
  return { sessionID: "s", messageID: "m", agent: "a", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as never;
}

describe("memory_forget tool (additional coverage)", () => {
  it("shows multiple matches with pluralization", async () => {
    const service = mockService({
      searchResults: [
        { score: 2.0, scope: "project", filePath: "/proj/MEMORY.md", heading: "Decisions", snippet: "entry 1" },
        { score: 1.5, scope: "project", filePath: "/proj/MEMORY.md", heading: "Facts", snippet: "entry 2" },
      ],
    });
    const tool = createMemoryForgetTool(service);

    const result = await tool.execute(
      { query: "test", scope: "project", confirm: false },
      mockCtx(),
    );

    expect(result).toContain("Found 2 matches");
  });

  it("uses singular 'entry' when removed=1", async () => {
    const service = mockService({ removeResult: { removed: 1 } });
    const tool = createMemoryForgetTool(service);

    const result = await tool.execute(
      { query: "one", scope: "project", confirm: true },
      mockCtx(),
    );

    expect(result).toContain("1 matching entry");
    expect(result).not.toContain("entries");
  });

  it("includes score in match display", async () => {
    const service = mockService({
      searchResults: [
        { score: 3.14, scope: "project", filePath: "/proj/MEMORY.md", heading: "Decisions", snippet: "test" },
      ],
    });
    const tool = createMemoryForgetTool(service);

    const result = await tool.execute(
      { query: "test", scope: "project", confirm: false },
      mockCtx(),
    );

    expect(result).toContain("score=3.14");
  });

  it("returns 'No matching' when confirm=true but nothing matched", async () => {
    const service = mockService({ removeResult: { removed: 0 } });
    const tool = createMemoryForgetTool(service);

    const result = await tool.execute(
      { query: "nothing", scope: "project", confirm: true },
      mockCtx(),
    );

    expect(result).toContain("No matching");
  });
});
