import { describe, it, expect } from "vitest";
import { createPluginState } from "../../src/hooks/shared-state.js";

describe("PluginState memory cache (D5 mtime caching)", () => {
  it("returns undefined when cache is empty", () => {
    const state = createPluginState();
    expect(state.getMemoryCache()).toBeUndefined();
  });

  it("stores and returns cached memory content + mtime", () => {
    const state = createPluginState();
    state.setMemoryCache("## Rules\n", 1700000000000);
    const cached = state.getMemoryCache();
    expect(cached).toBeDefined();
    expect(cached!.content).toBe("## Rules\n");
    expect(cached!.mtime).toBe(1700000000000);
  });

  it("isMemoryCacheFresh returns true when mtime matches", () => {
    const state = createPluginState();
    state.setMemoryCache("content", 1700000000000);
    expect(state.isMemoryCacheFresh(1700000000000)).toBe(true);
  });

  it("isMemoryCacheFresh returns false when mtime differs", () => {
    const state = createPluginState();
    state.setMemoryCache("content", 1700000000000);
    expect(state.isMemoryCacheFresh(1700000000001)).toBe(false);
  });

  it("isMemoryCacheFresh returns false when cache is empty", () => {
    const state = createPluginState();
    expect(state.isMemoryCacheFresh(1700000000000)).toBe(false);
  });

  it("clearMemoryCache resets the cache", () => {
    const state = createPluginState();
    state.setMemoryCache("content", 123);
    state.clearMemoryCache();
    expect(state.getMemoryCache()).toBeUndefined();
  });
});
