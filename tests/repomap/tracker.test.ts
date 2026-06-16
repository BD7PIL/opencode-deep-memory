import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RepoMapTracker } from "../../src/repomap/tracker.js";

describe("RepoMapTracker", () => {
  let tracker: RepoMapTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new RepoMapTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recordRead creates entry with extracted symbols", () => {
    tracker.recordRead("src/auth.ts", `export function login() { }\nexport function logout() { }`);
    const recent = tracker.getRecentlyRead(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].path).toBe("src/auth.ts");
    expect(recent[0].readCount).toBe(1);
    expect(recent[0].language).toBe("typescript");
    expect(recent[0].symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "login", type: "function" }),
        expect.objectContaining({ name: "logout", type: "function" }),
      ]),
    );
  });

  it("recordRead same file twice increments readCount", () => {
    tracker.recordRead("src/auth.ts", `export function login() { }`);
    tracker.recordRead("src/auth.ts", `export function login() { }\nexport function signup() { }`);
    const recent = tracker.getRecentlyRead(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].readCount).toBe(2);
    expect(recent[0].symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "login", type: "function" }),
        expect.objectContaining({ name: "signup", type: "function" }),
      ]),
    );
  });

  it("getRecentlyRead sorts by lastRead descending", () => {
    tracker.recordRead("src/a.ts", `export function foo() { }`);
    vi.advanceTimersByTime(100);
    tracker.recordRead("src/b.ts", `export function bar() { }`);
    vi.advanceTimersByTime(100);
    tracker.recordRead("src/c.ts", `export function baz() { }`);
    const recent = tracker.getRecentlyRead(10);
    expect(recent).toHaveLength(3);
    // Most recently read first
    expect(recent[0].path).toBe("src/c.ts");
    expect(recent[1].path).toBe("src/b.ts");
    expect(recent[2].path).toBe("src/a.ts");
  });

  it("getRecentlyRead respects limit", () => {
    tracker.recordRead("src/a.ts", `export function foo() { }`);
    vi.advanceTimersByTime(100);
    tracker.recordRead("src/b.ts", `export function bar() { }`);
    const recent = tracker.getRecentlyRead(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].path).toBe("src/b.ts");
  });

  it("getTopSymbols respects budget", () => {
    tracker.recordRead("src/auth.ts", [
      `export function login() { }`,
      `export function logout() { }`,
      `export function validateToken() { }`,
      `export function refreshSession() { }`,
    ].join("\n"));

    // With a very small budget, not all symbols should be included
    const entries = tracker.getTopSymbols(20);
    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/auth.ts");
    // 20 tokens - 10 header = 10 remaining → ~2 symbols (4 tokens each)
    expect(entries[0].symbols.length).toBeLessThanOrEqual(3);
  });

  it("private symbols get lower priority via C2 multiplier", () => {
    tracker.recordRead("src/internal.ts", [
      `export function publicApi() { }`,
      `export function _privateHelper() { }`,
    ].join("\n"));

    // With enough budget for both, both should appear
    const entries = tracker.getTopSymbols(100);
    expect(entries).toHaveLength(1);
    expect(entries[0].symbols).toContain("publicApi");
    expect(entries[0].symbols).toContain("_privateHelper");
    // publicApi should come before _privateHelper (higher adjusted score)
    const pubIdx = entries[0].symbols.indexOf("publicApi");
    const privIdx = entries[0].symbols.indexOf("_privateHelper");
    expect(pubIdx).toBeLessThan(privIdx);
  });

  it("clear removes all tracked files", () => {
    tracker.recordRead("src/a.ts", `export function foo() { }`);
    tracker.recordRead("src/b.ts", `export function bar() { }`);
    expect(tracker.getRecentlyRead(10)).toHaveLength(2);

    tracker.clear();
    expect(tracker.getRecentlyRead(10)).toHaveLength(0);
  });

  it("ignores files with unknown extensions", () => {
    tracker.recordRead("README.md", "# Hello");
    expect(tracker.getRecentlyRead(10)).toHaveLength(0);
  });
});
