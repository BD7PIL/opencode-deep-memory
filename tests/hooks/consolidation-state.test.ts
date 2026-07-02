import { describe, it, expect, beforeEach } from "vitest";
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
