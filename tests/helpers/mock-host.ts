/**
 * Shared mock host fixtures — one place for the host-client shape that
 * hooks/tools expect, plus temp-project and global-root scaffolding.
 *
 * The v1 host client surface used by this codebase is intentionally narrow:
 * session.{messages,create,promptAsync}, tui.showToast, and (in real hosts)
 * $ / config. Individual tests override the vi.fn()s they assert on.
 */
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A message in the v1 host shape ({info, parts}). */
export interface MockHostMessage {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}

/** Build a deterministic v1-shaped message list. */
export function makeMessages(
  count: number,
  opts: { sessionID?: string; prefix?: string } = {},
): MockHostMessage[] {
  const sessionID = opts.sessionID ?? "s1";
  const prefix = opts.prefix ?? "Message";
  const msgs: MockHostMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", sessionID },
      parts: [{ type: "text", text: `${prefix} ${i} content with enough text to be captured` }],
    });
  }
  return msgs;
}

export interface MockHostClientOptions {
  messages?: MockHostMessage[];
  /** Spy for tui.showToast; defaults to a fresh vi.fn(). */
  toastSpy?: ReturnType<typeof vi.fn>;
  /** session.create resolved id (defaults "mock-sub"). */
  subSessionId?: string;
}

/** Host client mock covering the faces hooks touch. All vi.fn() — assert away. */
export function mockHostClient(opts: MockHostClientOptions = {}) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: opts.messages ?? [] }),
      create: vi.fn().mockResolvedValue({ data: { id: opts.subSessionId ?? "mock-sub" } }),
      promptAsync: vi.fn().mockResolvedValue(undefined),
    },
    tui: { showToast: opts.toastSpy ?? vi.fn().mockResolvedValue(undefined) },
    $: { unsafe: vi.fn() },
    config: { get: vi.fn().mockResolvedValue({ data: undefined }) },
  };
}

/** mkdtemp project dir; caller cleans up (or use withTempProject). */
export function tempProject(prefix = "dm-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Isolate the global memory root for the duration of the test:
 * saves/restores DEEP_MEMORY_GLOBAL_ROOT around the callback.
 */
export async function withGlobalRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env["DEEP_MEMORY_GLOBAL_ROOT"];
  process.env["DEEP_MEMORY_GLOBAL_ROOT"] = root;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["DEEP_MEMORY_GLOBAL_ROOT"];
    else process.env["DEEP_MEMORY_GLOBAL_ROOT"] = prev;
  }
}

/** Temp project + isolated global root, cleaned up after the callback. */
export async function withTempProject<T>(
  fn: (projectPath: string, globalRoot: string) => Promise<T>,
): Promise<T> {
  const projectPath = tempProject();
  const globalRoot = tempProject("dm-global-");
  try {
    return await withGlobalRoot(globalRoot, () => fn(projectPath, globalRoot));
  } finally {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* already gone */ }
    try { rmSync(globalRoot, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** Minimal v2 setup ctx — only the faces v2Setup touches. Records every
 *  registration (with the hook event name for session faces) and hands each
 *  registration its own dispose spy, so tests can assert registration and
 *  disposal without hand-rolling the bag. */
export function mockV2Ctx(opts: { directory?: string; session?: Record<string, unknown> } = {}) {
  const registered: Array<{ face: string; event?: string; handler: unknown }> = [];
  const disposeSpies: Array<ReturnType<typeof vi.fn>> = [];
  const tracked = () => {
    const d = vi.fn();
    disposeSpies.push(d);
    return { dispose: d };
  };
  const hook = (face: string) => (event: string, handler: unknown) => {
    registered.push({ face, event, handler });
    return tracked();
  };
  const ctx: Record<string, unknown> = {
    app: { version: "0.0.0-mock" },
    location: { directory: opts.directory ?? process.cwd() },
    agent: { transform: () => {} },
    session: { hook: hook("session"), ...(opts.session ?? {}) },
    tool: { hook: hook("tool") },
    event: {
      subscribe: (handler: unknown) => {
        registered.push({ face: "event", handler });
        return tracked();
      },
    },
  };
  return { ctx, registered, disposeSpies };
}
