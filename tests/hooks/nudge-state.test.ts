import { describe, it, expect, beforeEach } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("P3: Nudge state management", () => {
  let state: ReturnType<typeof createPluginState>;

  beforeEach(() => {
    state = createPluginState();
  });

  describe("tryNudge", () => {
    it("returns true on first call for threshold type", () => {
      expect(state.tryNudge("threshold", "sess-1")).toBe(true);
    });

    it("returns false on second call for threshold (cooldown)", () => {
      state.tryNudge("threshold", "sess-1");
      expect(state.tryNudge("threshold", "sess-1")).toBe(false);
    });

    it("threshold and emergency are independent", () => {
      state.tryNudge("threshold", "sess-1");
      expect(state.tryNudge("emergency", "sess-1")).toBe(true);
    });

    it("different sessions have independent nudge state", () => {
      state.tryNudge("threshold", "sess-1");
      expect(state.tryNudge("threshold", "sess-2")).toBe(true);
    });

    it("emergency always fires (no cooldown) while threshold does not repeat", () => {
      expect(state.tryNudge("emergency", "sess-1")).toBe(true);
      expect(state.tryNudge("emergency", "sess-1")).toBe(true);
    });
  });

  describe("PostCompact flag", () => {
    it("setPendingPostCompactNudge + consumePendingPostCompactNudge round-trip", () => {
      state.setPendingPostCompactNudge("sess-1");
      expect(state.consumePendingPostCompactNudge("sess-1")).toBe(true);
    });

    it("consume returns false when not set", () => {
      expect(state.consumePendingPostCompactNudge("sess-1")).toBe(false);
    });

    it("consume is destructive (idempotent)", () => {
      state.setPendingPostCompactNudge("sess-1");
      state.consumePendingPostCompactNudge("sess-1");
      expect(state.consumePendingPostCompactNudge("sess-1")).toBe(false);
    });
  });

  describe("resetNudges (after compaction)", () => {
    it("reset allows threshold to fire again", () => {
      state.tryNudge("threshold", "sess-1");
      state.resetNudges("sess-1");
      expect(state.tryNudge("threshold", "sess-1")).toBe(true);
    });
  });
});
