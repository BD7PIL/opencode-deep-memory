import { describe, it, expect, beforeEach } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";

/**
 * Regression: opencode-deep-memory infinite toast cascade.
 *
 * Root cause: handleIdleConsolidation (src/index.ts) fires on every session.idle,
 * including the consolidation sub-sessions the plugin spawns itself. When a
 * sub-session idles:
 *   - consumePendingConsolidation(subID) returns undefined (pending keyed by parent)
 *   - shouldConsolidate() returns true (counters / MEMORY.md unchanged)
 *   - spawn a grand-sub-session + emit "memory consolidation spawned (general)" toast
 *   - grand-child idles → repeat → infinite cascade of toast notifications
 *
 * Fix: PluginState tracks plugin-spawned sub-session IDs via markSubSessionSpawned();
 * idle/compaction handlers short-circuit via isSpawnedSubSession() at the top.
 */
describe("Spawned sub-session tracking (anti-cascade guard)", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  it("isSpawnedSubSession returns false for unknown sessions", () => {
    expect(state.isSpawnedSubSession("never-spawned")).toBe(false);
  });

  it("markSubSessionSpawned + isSpawnedSubSession round-trip", () => {
    state.markSubSessionSpawned("sub-1");
    expect(state.isSpawnedSubSession("sub-1")).toBe(true);
    expect(state.isSpawnedSubSession("sub-2")).toBe(false);
  });

  it("markSubSessionSpawned is idempotent", () => {
    state.markSubSessionSpawned("sub-1");
    state.markSubSessionSpawned("sub-1");
    state.markSubSessionSpawned("sub-1");
    expect(state.isSpawnedSubSession("sub-1")).toBe(true);
  });

  it("markSubSessionSpawned ignores empty/null IDs (defensive)", () => {
    state.markSubSessionSpawned("");
    expect(state.isSpawnedSubSession("")).toBe(false);
  });

  it("forgets multiple spawned sub-sessions independently", () => {
    state.markSubSessionSpawned("sub-A");
    state.markSubSessionSpawned("sub-B");
    state.markSubSessionSpawned("sub-C");

    expect(state.isSpawnedSubSession("sub-A")).toBe(true);
    expect(state.isSpawnedSubSession("sub-B")).toBe(true);
    expect(state.isSpawnedSubSession("sub-C")).toBe(true);

    state.forgetAgent("sub-B");
    expect(state.isSpawnedSubSession("sub-B")).toBe(false);
    // Others unaffected
    expect(state.isSpawnedSubSession("sub-A")).toBe(true);
    expect(state.isSpawnedSubSession("sub-C")).toBe(true);
  });

  it("forgetAgent on a non-spawned ID is a no-op", () => {
    state.forgetAgent("not-spawned");
    expect(state.isSpawnedSubSession("not-spawned")).toBe(false);
  });

  /**
   * Critical scenario: parent session idles → spawn sub-session → sub-session
   * itself idles. Without the guard, the second idle would trigger another spawn.
   * The guard must return early when it sees the spawned sub-session ID.
   */
  it("simulates the idle cascade scenario (guard prevents recursion)", () => {
    const spawnedIDs: string[] = [];

    const mockIdleHandler = (idleSessionID: string): void => {
      // Mirror of src/index.ts guard:
      if (state.isSpawnedSubSession(idleSessionID)) return;
      // Would spawn here:
      const newSubID = `sub-${spawnedIDs.length + 1}`;
      state.markSubSessionSpawned(newSubID);
      spawnedIDs.push(newSubID);
    };

    // Parent idle → spawn sub-1
    mockIdleHandler("parent");
    expect(spawnedIDs).toEqual(["sub-1"]);

    // Sub-1 idle → MUST NOT spawn (this was the bug)
    mockIdleHandler("sub-1");
    expect(spawnedIDs).toEqual(["sub-1"]);

    // Sub-1 idle again → still must not spawn
    mockIdleHandler("sub-1");
    expect(spawnedIDs).toEqual(["sub-1"]);

    // A different parent idles → can spawn
    mockIdleHandler("parent-2");
    expect(spawnedIDs).toEqual(["sub-1", "sub-2"]);
  });
});
