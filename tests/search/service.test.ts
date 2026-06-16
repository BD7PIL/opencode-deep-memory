import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SearchService } from "../../src/search/service.js";

function createTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "service-test-"));
}

describe("SearchService", () => {
  let tmpDir: string;
  let projectPath: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpDir = createTmpDir();
    projectPath = tmpDir;
    prevEnv = process.env["DEEP_MEMORY_GLOBAL_ROOT"];
    process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpDir;
  });

  afterEach(async () => {
    if (prevEnv === undefined) {
      delete process.env["DEEP_MEMORY_GLOBAL_ROOT"];
    } else {
      process.env["DEEP_MEMORY_GLOBAL_ROOT"] = prevEnv;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function writeMd(relativePath: string, content: string): string {
    const fullPath = path.join(tmpDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  it("searches CJK content end-to-end", async () => {
    writeMd(
      ".deep-memory/MEMORY.md",
      "## Constraints\n- 禁止使用原生插件\n- 必须使用纯 JS 实现",
    );

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const results = await service.search("原生插件", { scope: "project" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.matchedTerms.length).toBeGreaterThan(0);
  });

  it("searches Latin content", async () => {
    writeMd(
      ".deep-memory/MEMORY.md",
      "## Decisions\n- Use BM25 for search\n- Use markdown for storage",
    );

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const results = await service.search("BM25 search", { scope: "project" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("scope filter excludes non-matching scopes", async () => {
    writeMd("global/MEMORY.md", "## Decisions\n- Global decision");
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Project decision");

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const globalResults = await service.search("decision", { scope: "global" });
    const projectResults = await service.search("decision", { scope: "project" });

    expect(globalResults.every((r) => r.scope === "global")).toBe(true);
    expect(projectResults.every((r) => r.scope === "project")).toBe(true);
  });

  it("addEntry creates file and heading if missing", async () => {
    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    await service.addEntry("project", "memory", "Decisions", "Use TypeScript");

    const filePath = path.join(tmpDir, ".deep-memory/MEMORY.md");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("## Decisions");
    expect(content).toContain("- Use TypeScript");
  });

  it("addEntry appends under existing heading", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- First decision");

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    await service.addEntry("project", "memory", "Decisions", "Second decision");

    const filePath = path.join(tmpDir, ".deep-memory/MEMORY.md");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("- First decision");
    expect(content).toContain("- Second decision");
  });

  it("addEntry is searchable after indexing", async () => {
    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    await service.addEntry("project", "memory", "Decisions", "Use BM25 for search");

    const results = await service.search("BM25", { scope: "project" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("removeEntry removes matching lines", async () => {
    writeMd(
      ".deep-memory/MEMORY.md",
      "## Decisions\n- Keep this\n- Remove this one",
    );

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const result = await service.removeEntry("project", "memory", "Remove");
    expect(result.removed).toBe(1);

    const filePath = path.join(tmpDir, ".deep-memory/MEMORY.md");
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("- Keep this");
    expect(content).not.toContain("- Remove this one");
  });

  it("removeEntry returns 0 for non-matching query", async () => {
    writeMd(".deep-memory/MEMORY.md", "## Decisions\n- Some content");

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const result = await service.removeEntry("project", "memory", "nonexistent");
    expect(result.removed).toBe(0);
  });

  it("handles empty data root gracefully", async () => {
    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const results = await service.search("anything");
    expect(results).toEqual([]);
  });

  it("returns snippet in search results", async () => {
    writeMd(
      ".deep-memory/MEMORY.md",
      "## Decisions\n- We decided to use BM25 for full-text search because it handles CJK well",
    );

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const results = await service.search("BM25", { scope: "project" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.snippet.length).toBeGreaterThan(0);
  });

  it("respects limit option", async () => {
    const sections = Array.from(
      { length: 10 },
      (_, i) => `## Section ${i}\n- Content about topic ${i} with keyword searchable`,
    ).join("\n");
    writeMd(".deep-memory/MEMORY.md", sections);

    const service = new SearchService({
      dataRoot: tmpDir,
      projectPath,
    });

    const results = await service.search("searchable", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
