import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("P0: PendingConsolidation state", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  it("set/consume round-trip", () => {
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1000 });
    const r = state.consumePendingConsolidation("sess-1");
    expect(r).toBeDefined();
    expect(r!.subSessionID).toBe("sub-1");
    expect(r!.memMtime).toBe(1000);
  });

  it("consume returns undefined when not set", () => {
    expect(state.consumePendingConsolidation("sess-1")).toBeUndefined();
  });

  it("consume is idempotent", () => {
    state.setPendingConsolidation("sess-1", { subSessionID: "sub-1", memMtime: 1000 });
    state.consumePendingConsolidation("sess-1");
    expect(state.consumePendingConsolidation("sess-1")).toBeUndefined();
  });
});

describe("Consolidation cooldown (DCP #439 pattern)", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  it("allows first consolidation attempt (no initial block)", () => {
    expect(state.canStartConsolidation()).toBe(true);
  });

  it("blocks second attempt within cooldown window", () => {
    state.recordConsolidationAttempt();
    expect(state.canStartConsolidation()).toBe(false);
  });

  it("allows attempt after cooldown window expires (fake timers)", () => {
    vi.useFakeTimers();
    state.recordConsolidationAttempt();
    expect(state.canStartConsolidation()).toBe(false);
    // Advance 61 seconds — past the 60s cooldown
    vi.advanceTimersByTime(61_000);
    expect(state.canStartConsolidation()).toBe(true);
    vi.useRealTimers();
  });

  it("blocks at exactly 59 seconds (still within window)", () => {
    vi.useFakeTimers();
    state.recordConsolidationAttempt();
    vi.advanceTimersByTime(59_000);
    expect(state.canStartConsolidation()).toBe(false);
    vi.useRealTimers();
  });

  it("allows multiple cycles (attempt → cooldown → attempt)", () => {
    vi.useFakeTimers();
    // First attempt
    expect(state.canStartConsolidation()).toBe(true);
    state.recordConsolidationAttempt();
    expect(state.canStartConsolidation()).toBe(false);
    // After cooldown
    vi.advanceTimersByTime(61_000);
    expect(state.canStartConsolidation()).toBe(true);
    // Second attempt
    state.recordConsolidationAttempt();
    expect(state.canStartConsolidation()).toBe(false);
    // After another cooldown
    vi.advanceTimersByTime(61_000);
    expect(state.canStartConsolidation()).toBe(true);
    vi.useRealTimers();
  });

  it("recordConsolidationAttempt updates internal state", () => {
    const before = state.canStartConsolidation();
    expect(before).toBe(true);
    state.recordConsolidationAttempt();
    const after = state.canStartConsolidation();
    expect(after).toBe(false);
  });
});
