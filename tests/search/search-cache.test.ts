import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SearchService } from "../../src/search/service.js";

describe("Search result cache (v0.13.0)", () => {
  let tmpProject: string;
  let tmpGlobal: string;
  let service: SearchService;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dm-cache-proj-"));
    tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "dm-cache-global-"));
    process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpGlobal;

    const memDir = path.join(tmpProject, ".deep-memory");
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, "MEMORY.md"),
      "## Decisions\n- [decision] Use vitest for testing framework [2026-08-12]\n",
      "utf8",
    );

    service = new SearchService({
      dataRoot: tmpGlobal,
      projectPath: tmpProject,
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmpGlobal, { recursive: true, force: true }); } catch {}
    delete process.env["DEEP_MEMORY_GLOBAL_ROOT"];
  });

  it("returns same results on repeated query (cache hit)", async () => {
    const results1 = await service.search("vitest", { scope: "project", limit: 5 });
    const results2 = await service.search("vitest", { scope: "project", limit: 5 });
    expect(results1).toEqual(results2);
  });

  it("cache invalidates when MEMORY.md changes", async () => {
    const results1 = await service.search("vitest", { scope: "project", limit: 5 });
    expect(results1.length).toBeGreaterThan(0);

    // Add a new entry via the service (triggers index update)
    await service.addEntry("project", "memory", "Decisions", "[decision] Use zod for runtime validation [2026-08-12]");

    // Search for the new entry — cache should be invalidated by addEntry's file change
    const results2 = await service.search("zod", { scope: "project", limit: 5 });
    expect(results2.length).toBeGreaterThan(0);
  });

  it("different queries return different results", async () => {
    await service.search("vitest", { scope: "project", limit: 5 });
    const r2 = await service.search("postgres", { scope: "project", limit: 5 });
    expect(r2.length).toBe(0); // "postgres" doesn't exist
  });
});
