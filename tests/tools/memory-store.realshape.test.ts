/**
 * Real-shape tool-call regression — v0.14.1's Bug 1 / 2a / 2b migrated into
 * vitest (batch 0.15.1, plan item P3-17).
 *
 * These bugs shipped through 450 green unit tests because every test mocked
 * the args the way the author's own callsite did. They only surfaced when the
 * plugin ran inside a real opencode, where tool calls carry ONLY the args the
 * model provided. Bug 2c (idle two-beat timing) and Bug 3 (consume persistence)
 * stay in scripts/e2e-real-bugs.mjs — they need the built dist + idle-event
 * sequencing that vitest should not own.
 *
 * Loaded from the BUILT dist (like the real host does), not src/.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpProject: string;
let tmpGlobal: string;
// eslint-disable-next-line no-var
var pluginFn: (input: unknown) => Promise<Record<string, unknown>>;

function toolCtx(sessionID?: string) {
  return {
    sessionID: sessionID ?? "vitest-realshape",
    messageID: "msg-1",
    agent: "general",
    directory: tmpProject,
    worktree: tmpProject,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function makeClient() {
  return {
    session: {
      create: async () => ({ data: { id: "mock-sub" } }),
      promptAsync: async () => undefined,
      messages: async () => ({ data: [] }),
    },
    tui: { showToast: async () => undefined },
    $: { unsafe: () => {} },
    config: { get: async () => ({ data: undefined }) },
  };
}

function memPath() {
  return path.join(tmpProject, ".deep-memory", "MEMORY.md");
}
function readMemory(): string {
  try { return fs.readFileSync(memPath(), "utf8"); } catch { return ""; }
}

async function loadHooks(): Promise<Record<string, unknown>> {
  const mod = await import(`file://${path.resolve("dist/index.js")}`);
  const fn = ((mod as { default?: { server?: unknown } }).default?.server ?? (mod as { default?: unknown }).default) as typeof pluginFn;
  delete (globalThis as Record<string, unknown>)["__deepMemoryCachedHooks"];
  return fn({
    directory: tmpProject,
    serverUrl: new URL("http://localhost:0"),
    client: makeClient(),
    $: { unsafe: () => {} },
  }) as unknown as Promise<Record<string, unknown>>;
}

interface StoreTool { execute(args: Record<string, unknown>, ctx: unknown): Promise<unknown> }
const storeTool = (hooks: Record<string, unknown>) => (hooks as { tool: { memory_store: StoreTool } }).tool.memory_store;

beforeAll(async () => {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dm-realshape-"));
  tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), "dm-realshape-global-"));
  process.env["DEEP_MEMORY_GLOBAL_ROOT"] = tmpGlobal;
});

afterAll(() => {
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* gone */ }
  try { fs.rmSync(tmpGlobal, { recursive: true, force: true }); } catch { /* gone */ }
  delete process.env["DEEP_MEMORY_GLOBAL_ROOT"];
});

describe("Bug 1 — memory_store without scope/type (real call shape)", () => {
  it("stores successfully instead of crashing on paths[0]", async () => {
    const hooks = await loadHooks();
    // REAL opencode tool calls pass only the args the model provided — no
    // scope, no type. Pre-0.14.1 crashed: 'paths[0] must be of type string'.
    const result = await storeTool(hooks).execute(
      { content: "EL7 glibc 2.17 is the hard floor for native binaries" },
      toolCtx("vitest-b1"),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain("paths[0]");
    expect(text).toMatch(/Stored|stored/i);
    expect(readMemory()).toContain("EL7 glibc 2.17");
  });
});

describe("Bug 2a — exact duplicate of a real-format entry is caught", () => {
  it("second identical store is rejected and MEMORY.md unchanged", async () => {
    const hooks = await loadHooks();
    await storeTool(hooks).execute(
      { content: "watch for the SimHash false positive on short entries" },
      toolCtx("vitest-b2a"),
    );
    const before = readMemory();
    const result = await storeTool(hooks).execute(
      { content: "watch for the SimHash false positive on short entries" },
      toolCtx("vitest-b2a"),
    );
    expect(JSON.stringify(result)).toMatch(/Near-duplicate/i);
    expect(readMemory()).toBe(before);
  });
});

describe("Bug 2b — short-line false-positive must NOT fire", () => {
  it("'test gotcha' stores despite sharing a token with 'test decision'", async () => {
    const hooks = await loadHooks();
    await storeTool(hooks).execute({ content: "test decision" }, toolCtx("vitest-b2b"));
    // 'test gotcha' shares 1 of 2 tokens with 'test decision' — the removed
    // SimHash path flagged this as a duplicate; exact-match-only must store it.
    const result = await storeTool(hooks).execute({ content: "test gotcha" }, toolCtx("vitest-b2b"));
    expect(JSON.stringify(result)).not.toMatch(/Near-duplicate/i);
    expect(readMemory()).toContain("test decision");
    expect(readMemory()).toContain("test gotcha");
  });
});
