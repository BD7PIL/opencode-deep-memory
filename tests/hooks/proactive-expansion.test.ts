import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("ccrEntries() (G9 proactive expansion prerequisite)", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  it("returns empty array when no CCR entries exist", () => {
    expect(state.ccrEntries()).toEqual([]);
  });

  it("returns all stored entries", () => {
    state.ccStore("hash-a", {
      hash: "hash-a", original: "content A", compressed: "compressed A",
      createdAt: Date.now(), toolName: "bash",
    });
    state.ccStore("hash-b", {
      hash: "hash-b", original: "content B", compressed: "compressed B",
      createdAt: Date.now(), toolName: "read",
    });

    const entries = state.ccrEntries();
    expect(entries).toHaveLength(2);
    expect(entries.some(e => e.hash === "hash-a")).toBe(true);
    expect(entries.some(e => e.hash === "hash-b")).toBe(true);
  });

  it("sorts by createdAt descending (newest first)", () => {
    const old = Date.now() - 60_000;
    const now = Date.now();
    state.ccStore("old", { hash: "old", original: "old", compressed: "c", createdAt: old });
    state.ccStore("new", { hash: "new", original: "new", compressed: "c", createdAt: now });

    const entries = state.ccrEntries();
    expect(entries[0].hash).toBe("new");
    expect(entries[1].hash).toBe("old");
  });

  it("excludes expired entries (>5min TTL)", () => {
    state.ccStore("fresh", {
      hash: "fresh", original: "content", compressed: "c",
      createdAt: Date.now(),
    });
    state.ccStore("expired", {
      hash: "expired", original: "old content", compressed: "c",
      createdAt: Date.now() - 400_000, // 6.6 min ago — past 5min TTL
    });

    const entries = state.ccrEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("fresh");
  });
});

describe("Proactive expansion throttle", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  it("allows first check (no initial block)", () => {
    expect(state.canCheckProactiveExpansion()).toBe(true);
  });

  it("blocks second check within throttle window (3s)", () => {
    state.recordProactiveCheck();
    expect(state.canCheckProactiveExpansion()).toBe(false);
  });

  it("allows check after throttle window expires", () => {
    vi.useFakeTimers();
    state.recordProactiveCheck();
    expect(state.canCheckProactiveExpansion()).toBe(false);
    vi.advanceTimersByTime(3100);
    expect(state.canCheckProactiveExpansion()).toBe(true);
    vi.useRealTimers();
  });
});
