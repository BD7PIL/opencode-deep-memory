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

  it("persist writes JSON file", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1234 });
    state.persistPendingConsolidation(tmpDir);

    const filePath = path.join(tmpDir, ".pending-consolidation.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(parsed.sessionID).toBe("sess-1");
    expect(parsed.subSessionID).toBe("sub-1");
    expect(parsed.memMtime).toBe(1234);
  });

  it("consumed state does not persist", () => {
    const state = createPluginState();
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1234 });
    state.consumePendingConsolidation("sess-1");
    state.persistPendingConsolidation(tmpDir);

    const filePath = path.join(tmpDir, ".pending-consolidation.json");
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
