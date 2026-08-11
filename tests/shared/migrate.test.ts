import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { migrateV3toV4 } from "../../src/shared/migrate.js";

describe("migrateV3toV4", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-migrate-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("creates .deep-memory directory if it doesn't exist", async () => {
    await migrateV3toV4(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".deep-memory"))).toBe(true);
  });

  it("writes migration marker (.migrated-v4)", async () => {
    await migrateV3toV4(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".deep-memory", ".migrated-v4"))).toBe(true);
  });

  it("is idempotent (second call is a no-op)", async () => {
    // First migration
    await migrateV3toV4(tmpDir);
    const markerTime1 = fs.statSync(path.join(tmpDir, ".deep-memory", ".migrated-v4")).mtimeMs;

    // Wait a bit
    await new Promise(r => setTimeout(r, 50));

    // Second migration — should not re-run
    await migrateV3toV4(tmpDir);
    const markerTime2 = fs.statSync(path.join(tmpDir, ".deep-memory", ".migrated-v4")).mtimeMs;

    expect(markerTime1).toBe(markerTime2);
  });

  it("deletes legacy V3 files (checkpoint.raw.json, notes.md, .schedule.json)", async () => {
    const dir = path.join(tmpDir, ".deep-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "checkpoint.raw.json"), "{}");
    fs.writeFileSync(path.join(dir, "notes.md"), "# notes");
    fs.writeFileSync(path.join(dir, ".schedule.json"), "{}");

    await migrateV3toV4(tmpDir);

    expect(fs.existsSync(path.join(dir, "checkpoint.raw.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "notes.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, ".schedule.json"))).toBe(false);
  });

  it("preserves MEMORY.md", async () => {
    const dir = path.join(tmpDir, ".deep-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [decision] Test\n");

    await migrateV3toV4(tmpDir);

    expect(fs.existsSync(path.join(dir, "MEMORY.md"))).toBe(true);
    const content = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    expect(content).toContain("[decision] Test");
  });

  it("archives distill-*.md files to archive/", async () => {
    const dir = path.join(tmpDir, ".deep-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "distill-2024-01-01.md"), "# distill");
    fs.writeFileSync(path.join(dir, "distill-summary.md"), "# summary");

    await migrateV3toV4(tmpDir);

    expect(fs.existsSync(path.join(dir, "distill-2024-01-01.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "distill-summary.md"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "archive", "distill-2024-01-01.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "archive", "distill-summary.md"))).toBe(true);
  });

  it("trims MEMORY.md to 200 lines and archives overflow", async () => {
    const dir = path.join(tmpDir, ".deep-memory");
    fs.mkdirSync(dir, { recursive: true });
    const lines = Array.from({ length: 250 }, (_, i) => `- [fact] fact ${i}`);
    fs.writeFileSync(path.join(dir, "MEMORY.md"), lines.join("\n"), "utf8");

    await migrateV3toV4(tmpDir);

    const memContent = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    const archiveContent = fs.readFileSync(path.join(dir, "MEMORY-archive.md"), "utf8");

    expect(memContent.split("\n").length).toBe(200);
    expect(archiveContent).toContain("fact 200"); // overflow starts at line 201
  });

  it("does not trim MEMORY.md under 200 lines", async () => {
    const dir = path.join(tmpDir, ".deep-memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [fact] short\n", "utf8");

    await migrateV3toV4(tmpDir);

    expect(fs.existsSync(path.join(dir, "MEMORY-archive.md"))).toBe(false);
  });
});
