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

/**
 * v2 setup ctx modelling the REAL 2.0.32 runtime faces.
 *
 * Deliberately richer than the published `PluginContext` type, which omits
 * `session`, `tool`, `event`, `storage` and `location` entirely. A mock built
 * from those published types is what let four silent v2 defects ship in 0.15.x:
 * no tool ever registered, `tool.hook("*")` never fired, `event.subscribe` was
 * handed a callback instead of being consumed as an AsyncIterable, and no
 * appended system part was ever checked for settling.
 *
 * Every registration here is drivable, tools added by the plugin land in
 * `toolRegistry`, and `subscribe` returns an AsyncIterable plus records the
 * AbortSignal so tests can assert abort-on-dispose.
 */
export interface MockV2Registered {
  face: string;
  event?: string;
  handler?: unknown;
  dispose: ReturnType<typeof vi.fn>;
}

export interface MockV2Host {
  ctx: Record<string, unknown>;
  registered: MockV2Registered[];
  /** Dispose spies for registrations that are torn down via Registration.dispose. */
  disposeSpies: Array<ReturnType<typeof vi.fn>>;
  /** AbortSignals handed to event.subscribe (assert aborted on dispose). */
  signals: AbortSignal[];
  /** Tools the plugin added, keyed by effective id `${namespace}_${name}`. */
  toolRegistry: Map<string, Record<string, unknown>>;
  handlerFor(face: string, event?: string): ((...args: any[]) => unknown) | undefined;
}

export function mockV2Ctx(
  opts: {
    directory?: string;
    session?: Record<string, unknown>;
    /** v2 events replayed to every event.subscribe consumer. */
    events?: Array<Record<string, unknown>>;
    /** Omit the agent face to model a reduced (TUI-embedded) host. */
    reducedHost?: boolean;
  } = {},
): MockV2Host {
  const registered: MockV2Registered[] = [];
  const disposeSpies: Array<ReturnType<typeof vi.fn>> = [];
  const signals: AbortSignal[] = [];
  const toolRegistry = new Map<string, Record<string, unknown>>();

  const track = (): { dispose: ReturnType<typeof vi.fn> } => {
    const dispose = vi.fn();
    disposeSpies.push(dispose);
    return { dispose };
  };
  /** Registration with a dispose spy the disposer is expected to call. */
  const record = (face: string, event: string | undefined, handler: unknown, dispose: ReturnType<typeof vi.fn>) => {
    registered.push({ face, event, handler, dispose });
    return dispose;
  };
  const hook = (face: string) => (event: string, handler: unknown) =>
    ({ dispose: record(face, event, handler, track().dispose) });

  const eventFeed = opts.events ?? [];
  const ctx: Record<string, unknown> = {
    app: { name: "cli", version: "2.0.32-mock", channel: "latest" },
    location: { directory: opts.directory ?? process.cwd(), project: { id: "global" } },
    options: {},
    session: { hook: hook("session"), ...(opts.session ?? {}) },
    tool: {
      hook: hook("tool"),
      async transform(callback: (editor: unknown) => void) {
        record("tool", "transform", callback, vi.fn());
        const editor = {
          list: () => [...toolRegistry.values()],
          get: (id: string) => toolRegistry.get(id),
          namespace: vi.fn(),
          add: (tool: Record<string, unknown>) => {
            // The real registry is keyed by effective name, so a re-add replaces.
            const namespace = (tool["options"] as { namespace?: string } | undefined)?.namespace;
            toolRegistry.set(`${namespace}_${String(tool["name"])}`, tool);
          },
          update: vi.fn(),
          remove: vi.fn(),
        };
        callback(editor);
        return { dispose: vi.fn() };
      },
    },
    event: {
      subscribe(o?: { signal?: AbortSignal }) {
        if (o?.signal) signals.push(o.signal);
        // The real face has no dispose(): teardown is the AbortSignal, so this
        // registration deliberately carries no dispose spy.
        record("event", "subscribe", undefined, vi.fn());
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of eventFeed) yield event;
          },
        };
      },
    },
  };
  if (!opts.reducedHost) ctx["agent"] = { transform: () => {} };

  const handlerFor = (face: string, event?: string) =>
    registered.find((r) => r.face === face && (event === undefined || r.event === event))?.handler as
      | ((...args: any[]) => unknown)
      | undefined;

  return { ctx, registered, disposeSpies, signals, toolRegistry, handlerFor };
}
