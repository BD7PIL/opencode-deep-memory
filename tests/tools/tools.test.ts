import { describe, it, expect, vi } from "vitest";
import type { SearchService, SearchResult } from "../../src/search/service.js";
import { createMemorySearchTool } from "../../src/tools/memory-search.js";
import { createMemoryStoreTool } from "../../src/tools/memory-store.js";
import { createMemoryForgetTool } from "../../src/tools/memory-forget.js";
import { createMemoryTools } from "../../src/tools/index.js";
import { createPluginState } from "../../src/hooks/shared-state.js";

function mockSearchService(): SearchService {
  return {
    ensureIndex: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    addEntry: vi.fn().mockResolvedValue(undefined),
    removeEntry: vi.fn().mockResolvedValue({ removed: 0 }),
    project: "/tmp/test-project",
  } as unknown as SearchService;
}

function mockContext() {
  return {
    sessionID: "test-session",
    messageID: "test-msg",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: vi.fn(),
    ask: vi.fn(),
  };
}

const SAMPLE_RESULTS: SearchResult[] = [
  {
    docId: "/tmp/MEMORY.md#Decisions",
    filePath: "/tmp/MEMORY.md",
    scope: "project",
    heading: "Decisions",
    snippet: "...use BM25 for search...",
    score: 2.45,
    matchedTerms: ["bm25", "search"],
  },
  {
    docId: "/tmp/MEMORY.md#Constraints",
    filePath: "/tmp/MEMORY.md",
    scope: "project",
    heading: "Constraints",
    snippet: "...no native addons allowed...",
    score: 1.82,
    matchedTerms: ["native"],
  },
];

describe("memory_search tool", () => {
  it("returns 'no matches' when search is empty", async () => {
    const service = mockSearchService();
    const tool = createMemorySearchTool(service);
    const result = await tool.execute(
      { query: "nothing", scope: "all", limit: 5 },
      mockContext(),
    );
    expect(result).toBe('No matches found for "nothing"');
  });

  it("formats search results with scores and snippets", async () => {
    const service = mockSearchService();
    (service.search as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_RESULTS);
    const tool = createMemorySearchTool(service);
    const result = await tool.execute(
      { query: "BM25", scope: "all", limit: 5 },
      mockContext(),
    );
    expect(result).toContain("Found 2 matches");
    expect(result).toContain("[score=2.45]");
    expect(result).toContain("[score=1.82]");
    expect(result).toContain("Decisions");
    expect(result).toContain("Constraints");
  });

  it("calls service.search with correct args", async () => {
    const service = mockSearchService();
    const tool = createMemorySearchTool(service);
    await tool.execute(
      { query: "test", scope: "project", limit: 10 },
      mockContext(),
    );
    expect(service.search).toHaveBeenCalledWith("test", {
      scope: "project",
      limit: 10,
    });
  });
});

describe("memory_store tool", () => {
  it("calls addEntry with correct section mapping", async () => {
    const service = mockSearchService();
    const tool = createMemoryStoreTool(service);
    await tool.execute(
      { content: "Use TypeScript", type: "decision", scope: "project" },
      mockContext(),
    );
    expect(service.addEntry).toHaveBeenCalledWith(
      "project",
      "memory",
      "Decisions",
      expect.stringContaining("Use TypeScript"),
    );
  });

  it("returns confirmation message", async () => {
    const service = mockSearchService();
    const tool = createMemoryStoreTool(service);
    const result = await tool.execute(
      { content: "test", type: "constraint", scope: "global" },
      mockContext(),
    );
    expect(result).toContain("constraint");
    expect(result).toContain("global");
    expect(result).toContain("Constraints");
  });

  it("defaults to note type and project scope", async () => {
    const service = mockSearchService();
    const tool = createMemoryStoreTool(service);
    await tool.execute(
      { content: "some note", type: "note", scope: "project" },
      mockContext(),
    );
    expect(service.addEntry).toHaveBeenCalledWith(
      "project",
      "memory",
      "Notes",
      expect.stringContaining("some note"),
    );
  });
});

describe("memory_forget tool", () => {
  it("shows matches without confirm", async () => {
    const service = mockSearchService();
    (service.search as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE_RESULTS);
    const tool = createMemoryForgetTool(service);
    const result = await tool.execute(
      { query: "BM25", scope: "project", confirm: false },
      mockContext(),
    );
    expect(result).toContain("Found 2 matches");
    expect(result).toContain("confirm=true");
    expect(service.removeEntry).not.toHaveBeenCalled();
  });

  it("removes entries with confirm=true", async () => {
    const service = mockSearchService();
    (service.removeEntry as ReturnType<typeof vi.fn>).mockResolvedValue({ removed: 2 });
    const tool = createMemoryForgetTool(service);
    const result = await tool.execute(
      { query: "BM25", scope: "project", confirm: true },
      mockContext(),
    );
    expect(result).toContain("Removed 2");
    expect(service.removeEntry).toHaveBeenCalled();
  });

  it("returns 'no matches' when search finds nothing", async () => {
    const service = mockSearchService();
    const tool = createMemoryForgetTool(service);
    const result = await tool.execute(
      { query: "nothing", scope: "project", confirm: false },
      mockContext(),
    );
    expect(result).toBe('No matches found for "nothing"');
  });

  it("returns message when remove finds nothing", async () => {
    const service = mockSearchService();
    const tool = createMemoryForgetTool(service);
    const result = await tool.execute(
      { query: "nothing", scope: "project", confirm: true },
      mockContext(),
    );
    expect(result).toBe('No matching entries found for "nothing"');
  });
});

describe("createMemoryTools", () => {
  it("returns all five tools including context_compress", () => {
    const service = mockSearchService();
    const state = createPluginState();
    const tools = createMemoryTools(service, state);
    expect(tools.memory_search).toBeDefined();
    expect(tools.memory_store).toBeDefined();
    expect(tools.memory_forget).toBeDefined();
    expect(tools.memory_expand).toBeDefined();
    expect(tools.context_compress).toBeDefined();
  });

  it("context_compress tool requests compression in state", async () => {
    const service = mockSearchService();
    const state = createPluginState();
    const tools = createMemoryTools(service, state, { projectPath: "/test" });
    const result = await tools.context_compress.execute({ keep_recent: 5 }, mockContext());
    expect(JSON.stringify(result)).toContain("Compression requested");
    const req = state.consumeCompressionRequest();
    expect(req).toBeDefined();
    expect(req!.keepRecent).toBe(5);
  });

  it("consumeCompressionRequest returns undefined after consumption", () => {
    const state = createPluginState();
    state.requestCompression(8);
    state.consumeCompressionRequest();
    expect(state.consumeCompressionRequest()).toBeUndefined();
  });

  it("includes memory_expand when projectPath is provided", () => {
    const service = mockSearchService();
    const state = createPluginState();
    const tools = createMemoryTools(service, state, {
      projectPath: "/test/project",
    });
    expect(tools).toHaveProperty("memory_expand");
  });
});
