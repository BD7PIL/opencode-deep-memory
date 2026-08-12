import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMemoryTopicTool } from "../../src/tools/memory-topic.js";

describe("memory_topic tool (G1 Claude Code pattern)", () => {
  let tmpDir: string;
  let tool: ReturnType<typeof createMemoryTopicTool>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-topic-"));
    tool = createMemoryTopicTool(tmpDir);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function mockCtx() {
    return { sessionID: "s", messageID: "m", agent: "a", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as never;
  }

  it("writes and reads a topic file round-trip", async () => {
    const content = "# Granian Migration\n\nDetails about the migration from Uvicorn to Granian.";
    await tool.execute({ name: "granian-migration", action: "write", content }, mockCtx());

    const result = await tool.execute({ name: "granian-migration", action: "read" }, mockCtx());
    expect(result).toContain("Granian Migration");
    expect(result).toContain("Uvicorn");
  });

  it("returns helpful message when reading non-existent topic", async () => {
    const result = await tool.execute({ name: "nonexistent", action: "read" }, mockCtx());
    expect(result).toContain("not found");
  });

  it("lists topic files", async () => {
    await tool.execute({ name: "topic-a", action: "write", content: "A" }, mockCtx());
    await tool.execute({ name: "topic-b", action: "write", content: "B" }, mockCtx());

    const result = await tool.execute({ name: "", action: "list" }, mockCtx());
    expect(result).toContain("2");
    expect(result).toContain("topic-a");
    expect(result).toContain("topic-b");
  });

  it("returns 'No topic files' when topics dir doesn't exist", async () => {
    const result = await tool.execute({ name: "", action: "list" }, mockCtx());
    expect(result).toContain("No topics");
  });

  it("returns error when write is missing content", async () => {
    const result = await tool.execute({ name: "test", action: "write", content: undefined }, mockCtx());
    expect(result).toContain("content is required");
  });

  it("creates topics/ directory if it doesn't exist", async () => {
    const topicsDir = path.join(tmpDir, ".deep-memory", "topics");
    expect(fs.existsSync(topicsDir)).toBe(false);

    await tool.execute({ name: "first-topic", action: "write", content: "test" }, mockCtx());

    expect(fs.existsSync(topicsDir)).toBe(true);
    expect(fs.existsSync(path.join(topicsDir, "first-topic.md"))).toBe(true);
  });

  it("overwrites existing topic on re-write", async () => {
    await tool.execute({ name: "test", action: "write", content: "v1" }, mockCtx());
    await tool.execute({ name: "test", action: "write", content: "v2 updated" }, mockCtx());

    const result = await tool.execute({ name: "test", action: "read" }, mockCtx());
    expect(result).toBe("v2 updated");
  });

  it("includes char count in write confirmation", async () => {
    const result = await tool.execute({ name: "sized", action: "write", content: "1234567890" }, mockCtx());
    expect(result).toContain("10 chars");
  });
});
