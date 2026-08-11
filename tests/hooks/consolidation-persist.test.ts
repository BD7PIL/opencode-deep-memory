import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("P0: pendingConsolidation persistence (Grill #5)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-persist-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("persists and restores pending consolidation", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1234 });
    state.persistPendingConsolidation(tmpDir);

    const state2 = createPluginState();
    const restored = state2.restorePendingConsolidation(tmpDir);
    expect(restored).toBe(true);

    const r = state2.consumePendingConsolidation("sess-1");
    expect(r).toBeDefined();
    expect(r!.subSessionID).toBe("sub-1");
  });

  it("restore returns false when no file exists", () => {
    const state = createPluginState();
    expect(state.restorePendingConsolidation(tmpDir)).toBe(false);
  });

  it("persist writes v2 multi-entry JSON file", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1234 });
    state.persistPendingConsolidation(tmpDir);

    const filePath = path.join(tmpDir, ".pending-consolidation.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(parsed.version).toBe(2);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].sessionID).toBe("sess-1");
    expect(parsed.entries[0].subSessionID).toBe("sub-1");
    expect(parsed.entries[0].memMtime).toBe(1234);
  });

  it("consumed state does not persist", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1234 });
    state.consumePendingConsolidation("sess-1");
    state.persistPendingConsolidation(tmpDir);

    const filePath = path.join(tmpDir, ".pending-consolidation.json");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  // ============================================================
  // Regression: multiple concurrent pending consolidations
  // Old code wrote only keys[0], silently losing the rest.
  // ============================================================
  it("persists MULTIPLE pending consolidations (v2 format)", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-A", { subSessionID: "sub-A", memMtime: 100 });
    state.setPendingConsolidation("sess-B", { subSessionID: "sub-B", memMtime: 200 });
    state.setPendingConsolidation("sess-C", { subSessionID: "sub-C", memMtime: 300 });
    state.persistPendingConsolidation(tmpDir);

    const state2 = createPluginState();
    expect(state2.restorePendingConsolidation(tmpDir)).toBe(true);

    expect(state2.consumePendingConsolidation("sess-A")?.subSessionID).toBe("sub-A");
    expect(state2.consumePendingConsolidation("sess-B")?.subSessionID).toBe("sub-B");
    expect(state2.consumePendingConsolidation("sess-C")?.subSessionID).toBe("sub-C");
  });

  // ============================================================
  // Backward compat: read legacy single-entry format
  // (written by older plugin versions, must still restore)
  // ============================================================
  it("restore reads LEGACY single-entry format (backward compat)", () => {
    const legacyJson = JSON.stringify({
      sessionID: "legacy-sess",
      subSessionID: "legacy-sub",
      memMtime: 9999,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".pending-consolidation.json"),
      legacyJson,
      "utf8",
    );

    const state = createPluginState();
    expect(state.restorePendingConsolidation(tmpDir)).toBe(true);

    const r = state.consumePendingConsolidation("legacy-sess");
    expect(r).toBeDefined();
    expect(r!.subSessionID).toBe("legacy-sub");
    expect(r!.memMtime).toBe(9999);
  });

  // ============================================================
  // CRITICAL: restored sub-session IDs must populate the spawned
  // guard Set, otherwise a post-restart idle from a still-running
  // consolidation sub-session would re-cascade.
  // ============================================================
  it("restore populates spawned-sub-session guard (prevents post-restart cascade)", () => {
    const state = createPluginState();
    state.setPendingConsolidation("parent-1", { subSessionID: "sub-xyz", memMtime: 42 });
    state.persistPendingConsolidation(tmpDir);

    const state2 = createPluginState();
    state2.restorePendingConsolidation(tmpDir);

    // The restored sub-session must be recognized as plugin-spawned,
    // so the idle handler short-circuits when it emits session.idle.
    expect(state2.isSpawnedSubSession("sub-xyz")).toBe(true);
    expect(state2.isSpawnedSubSession("parent-1")).toBe(false);
  });

  it("restore populates spawned guard for all entries in v2 format", () => {
    const state = createPluginState();
    state.setPendingConsolidation("p-A", { subSessionID: "s-A", memMtime: 1 });
    state.setPendingConsolidation("p-B", { subSessionID: "s-B", memMtime: 2 });
    state.persistPendingConsolidation(tmpDir);

    const state2 = createPluginState();
    state2.restorePendingConsolidation(tmpDir);

    expect(state2.isSpawnedSubSession("s-A")).toBe(true);
    expect(state2.isSpawnedSubSession("s-B")).toBe(true);
    expect(state2.isSpawnedSubSession("p-A")).toBe(false);
    expect(state2.isSpawnedSubSession("p-B")).toBe(false);
  });
});
