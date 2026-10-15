/**
 * v2-native entry — opencode 2.x plugin adapter (batch D2, 0.15.0).
 *
 * opencode v2 changed the plugin contract completely (E5 spike evidence,
 * docs/research/dm-v2-compat-verdict.md in the ocrc repo):
 *  - the module must export { id, setup }; setup RETURNS A DISPOSER — a
 *    returned hooks object is silently dropped;
 *  - the setup input is a ctx face bag (app/location/session/tool/event/...)
 *    with NO directory/serverUrl/client;
 *  - the session "context" hook does NOT await handler promises: only
 *    synchronous mutations before the handler's first await reach the LLM
 *    request. Heavily-async v1 handlers must therefore be pre-run in the
 *    "prompt" hook (which the host awaits) and applied synchronously from
 *    cache in the context hook.
 *
 * This adapter keeps the entire v1 implementation (src/index.ts) untouched:
 * it builds the v1 Hooks via deepMemoryPlugin(), then re-exports each hook
 * onto the v2 faces. It is v2-ONLY by design (ocrc-style pin discipline) —
 * the v1 entry remains available for opencode 1.x users at the same package
 * entry (host picks the shape it understands: v1 hosts call default (input),
 * v2 hosts read .setup).
 */
import { deepMemoryPlugin } from "../index.js";
import { appendDebugLine } from "./debug-channel.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

/** v2 setup ctx — structural (the v2 SDK types lag the runtime; E5 verdict). */
export interface V2Ctx {
  location?: { directory?: string; workspaceID?: string; project?: { directory?: string } };
  session?: {
    hook(event: "context" | "prompt" | "compaction" | "model.request" | "retry", handler: (event: any) => any): Promise<{ dispose(): void } | void>;
    create(args: { directory?: string; title?: string; parentID?: string }): Promise<{ id?: string } | { data?: { id?: string } }>;
    prompt(args: { sessionID: string; text?: string; agent?: string }): Promise<unknown>;
    messages?(args: { sessionID: string }): Promise<{ data?: unknown }>;
  };
  event?: { subscribe(handler: (event: any) => any): { dispose(): void } | void };
  tool?: { hook(name: string, fn: (event: any, output: any) => any): Promise<{ dispose(): void } | void> };
}

export const V2_PLUGIN_ID = "opencode-deep-memory";

/** Debug parity with the v1 file logger (DEEP_MEMORY_DEBUG gated). */
function note(msg: string): void {
  try { appendDebugLine(`[v2-entry] ${msg}`); } catch { /* best-effort */ }
}

export async function v2Setup(ctx: V2Ctx): Promise<() => void> {
  if (!ctx || typeof (ctx as unknown as { agent?: { transform?: unknown } }).agent?.transform !== "function") {
    // Reduced host (TUI-side embed) — nothing to hook. Same guard as omo-slim.
    note("reduced host context; setup skipped");
    return () => {};
  }

  const directory = ctx.location?.directory;
  const v1input: PluginInput = {
    directory: typeof directory === "string" && directory ? directory : process.cwd(),
    serverUrl: new URL("http://127.0.0.1:0/"),
    // v2-native client adapter (see buildV2Client below) — typed as never at the
    // boundary exactly like the v1 codebase does for host-injected clients.
    client: buildV2Client(ctx) as never,
  } as unknown as PluginInput;

  const hooks: Hooks = await deepMemoryPlugin(v1input);
  note("v1 hooks built: " + Object.keys(hooks).join(","));

  const disposers: Array<() => void> = [];
  const track = (d: { dispose(): void } | void): void => { if (d && typeof d.dispose === "function") disposers.push(() => d.dispose()); };

  // ── warm/apply engine for the async-loss semantics ─────────────────────────
  // The "prompt" hook IS awaited by the host (omo-slim relies on the same), so
  // we run both transforms there against a shadow payload and cache their
  // outputs; the "context" hook then applies the cache synchronously.
  type Warm = { system: string[] | null; messages: unknown[] | null };
  // The v2 host may isolate each hook invocation in a fresh module realm (E5/D2
  // live evidence: in-memory cross-call maps never carry over). The warm cache
  // therefore lives on DISK in the project's .deep-memory dir.
  const warmFile = join(v1input.directory, ".deep-memory", ".v2-warm-cache.json");
  const warmBySession = {
    get(sid: string): Warm | undefined {
      try {
        const all = JSON.parse(readFileSync(warmFile, "utf8")) as Record<string, Warm>;
        return all[sid];
      } catch { return undefined; }
    },
    set(sid: string, w: Warm): void {
      try {
        let all: Record<string, Warm> = {};
        try { all = JSON.parse(readFileSync(warmFile, "utf8")) as Record<string, Warm>; } catch { /* first write */ }
        all[sid] = w;
        mkdirSync(dirname(warmFile), { recursive: true });
        writeFileSync(warmFile, JSON.stringify(all));
      } catch { /* best-effort */ }
    },
  };
  const systemTransform = hooks["experimental.chat.system.transform"];
  const messagesTransform = hooks["experimental.chat.messages.transform"];
  const compacting = hooks["experimental.session.compacting"];
  const eventHook = hooks["event"];
  const toolHook = hooks["tool"];
  const toolAfter = hooks["tool.execute.after"];

  // Best-effort warm cache refresh when the host lets us await (prompt hook).
  // The entry must PERSIST across turns — it is the cross-turn handoff from the
  // previous turn's async refresh to this turn's synchronous context apply.
  // (Never re-initialize: a null entry here would erase the previous turn.)
  async function warm(sessionID: string): Promise<void> {
    if (!warmBySession.get(sessionID || "*")) {
      warmBySession.set(sessionID || "*", { system: null, messages: null });
    }
  }

  if (ctx.session?.hook) {
    // "prompt" hook: the host awaits it (omo-proven), so it is the safe place
    // for async prep. chat.params is NOT bridged here — the v1 handler expects
    // input.model.providerID which the v2 prompt event lacks, and its data is
    // diagnostic-only (agent/model recording for fallback_model selection).
    try {
      const reg = await ctx.session.hook("prompt", (event: { sessionID?: string }) => { void warm(event?.sessionID || "*"); });
      track(reg);
      note("prompt hook registered (warm prep)");
    } catch (e) { note("prompt hook register failed: " + errmsg(e)); }

    // The one hook that must stay SYNCHRONOUS (E5: host does not await).
    const contextHandler = (event: { sessionID?: string; system?: Array<{ type: string; text: string }>; messages?: Array<{ info?: unknown; parts?: unknown[]; content?: unknown[]; role?: string }> }) => {
      try {
        const sid = event.sessionID || "*";
        if (systemTransform && Array.isArray(event.system)) {
          // Warm from the PREVIOUS turn's compute (sync apply); refresh below
          // computes from a PRE-MUTATION snapshot so deltas never compound.
          const original = event.system.slice();
          const warm = warmBySession.get(sid) || warmBySession.get("*");
          if (warm?.system && warm.system.length && Array.isArray(event.messages) && event.messages.length) {
            // Inject through the MESSAGE channel (last user message tail). The
            // system[] channel proved unreliable under the v2 host request
            // assembly (mutation confirmed in-handler but not serialized into
            // the LLM request), while user-message content mutations
            // demonstrably land (E5 marker control experiment).
            const lastUser = [...event.messages].reverse().find((m) => (m as { role?: string }).role === "user");
            if (lastUser) {
              const parts = ((lastUser as { content?: unknown[] }).content ??= []) as unknown[];
              parts.push({ type: "text", text: `<deep-memory-context>\n${warm.system.join("\n")}\n</deep-memory-context>` });
              note(`ctx sync: injected ${warm.system.join("").length}B into last user message`);
            }
          }
          const sysStrings = original.map((s) => (typeof s === "string" ? s : s.text ?? ""));
          const baseLen = sysStrings.length;
          // Async refresh for the NEXT turn (state tracking; never awaited).
          void Promise.resolve(systemTransform({ sessionID: event.sessionID, agent: (event as { agent?: string }).agent } as never, { system: sysStrings }) as unknown as Promise<void>)
            .then(() => {
              const delta = sysStrings.slice(baseLen).join("\n");
              if (delta) {
                const prev = warmBySession.get(sid);
                if (!prev || (prev.system?.join("").length ?? 0) < delta.length) {
                  warmBySession.set(sid, { system: [delta], messages: prev?.messages ?? null });
                }
              }
            })
            .catch(() => { /* state-only */ });
        }
        if (messagesTransform && Array.isArray(event.messages)) {
          const v1messages = event.messages.map((m) => ({ info: (m as { info?: unknown }).info ?? m, parts: (m as { parts?: unknown[] }).parts ?? (m as { content?: unknown[] }).content ?? [] }));
          // Denoise is IDEMPOTENT (E5-verified) and its fast path (guards +
          // prefix skipping) is synchronous up to its first await in the common
          // case; run it fire-and-forget and apply the previous pass's result
          // synchronously when present (warm cache), else apply on completion —
          // the missed turn is the first turn only, and first turns carry the
          // smallest history (nothing to denoise yet).
          const warmM = warmBySession.get(sid)?.messages;
          if (warmM) {
            applyMessages(event, warmM);
          }
          void Promise.resolve((messagesTransform as unknown as (i: unknown, o: unknown) => Promise<void>)({}, { messages: v1messages }))
            .then(() => {
              const prev = warmBySession.get(sid);
              warmBySession.set(sid, { system: prev?.system ?? null, messages: v1messages });
            })
            .catch(() => { /* state-only */ });
        }
      } catch (e) { note("context handler failed: " + errmsg(e)); }
      return event;
    };
    try {
      const reg = await ctx.session.hook("context", contextHandler);
      track(reg);
      note("context hook registered (sync-apply)");
    } catch (e) { note("context register failed: " + errmsg(e)); }

    if (compacting) {
      try {
        const reg = await ctx.session.hook("compaction", async (event: { sessionID?: string; system?: unknown; messages?: unknown }) => {
          try {
            const out = { context: [] as string[], prompt: undefined as string | undefined };
            await (compacting as unknown as (i: unknown, o: unknown) => Promise<void>)({ sessionID: event?.sessionID }, out);
            note(`compaction: context=${out.context.length} prompt=${out.prompt ? out.prompt.length + "B" : "none"}`);
            if (Array.isArray(event.system) && out.context.length) {
              event.system = [{ type: "text", text: out.context.join("\n") }, ...event.system];
            }
          } catch (e) { note("compaction handler failed: " + errmsg(e)); }
          return event;
        });
        track(reg);
        note("compaction hook registered");
      } catch (e) { note("compaction register failed: " + errmsg(e)); }
    }
  }

  if (eventHook && ctx.event?.subscribe) {
    try {
      const reg = ctx.event.subscribe((event: unknown) => {
        return Promise.resolve((eventHook as unknown as (i: unknown) => Promise<void>)({ event })).catch((e) => note("event handler failed: " + errmsg(e)));
      });
      track(reg);
      note("event subscribe registered");
    } catch (e) { note("event register failed: " + errmsg(e)); }
  }

  if ((toolHook || toolAfter) && ctx.tool?.hook) {
    try {
      const reg = await ctx.tool.hook("*", async (event: { tool?: string; sessionID?: string; args?: unknown; input?: unknown }, output: unknown) => {
        if (toolHook && event?.tool) {
          try { await (toolHook as unknown as (i: unknown, o: unknown) => Promise<void>)({ tool: event.tool, sessionID: event.sessionID }, output); } catch { /* diagnostic only */ }
        }
        if (toolAfter && event?.tool) {
          try { await (toolAfter as (i: unknown, o: unknown) => Promise<void>)({ tool: event.tool, sessionID: event.sessionID, args: event.args ?? event.input }, output); } catch { /* diagnostic only */ }
        }
      });
      track(reg);
      note("tool hook registered");
    } catch (e) { note("tool register failed: " + errmsg(e)); }
  }

  return () => { for (const d of disposers) { try { d(); } catch { /* disposal is best-effort */ } } };
}

function applyMessages(event: { messages?: Array<Record<string, unknown>> }, warm: unknown[]): void {
  const arr = event.messages as Array<Record<string, unknown>>;
  for (let i = 0; i < arr.length && i < warm.length; i++) {
    const w = warm[i] as { info?: unknown; parts?: unknown[] };
    if (!w || typeof w !== "object") continue;
    arr[i] = { ...arr[i], content: w.parts };
  }
}

function errmsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Auth headers for the loopback HTTP fallback (v2 serve uses Basic auth with
 *  the server password; the env var is the documented non-interactive channel). */
function httpAuthHeaders(): Record<string, string> {
  const pw = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
  return { authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` };
}

/** v2-native client adapter covering the three surfaces the v1 code uses:
 *  session.messages (capture), session.create + session.promptAsync (idle
 *  consolidation + context_compress sub-sessions), config.get (model
 *  fallback), tui.showToast (notification; optional in v2). */
export function buildV2Client(ctx: V2Ctx): unknown {
  const session = ctx.session;
  return {
    config: {
      // v2 ctx has no config face in the E5 dump; the v1 call is best-effort
      // with a non-blocking catch — return an empty config so the fallback
      // chain (state.bestModel() → undefined) proceeds as designed.
      async get() { return { data: undefined }; },
    },
    session: {
      async messages(args: { path: { id: string } }) {
        // Prefer the in-process ctx face when the host exposes one; otherwise
        // fall back to the loopback HTTP API (E5-proven: GET /api/session/{id}/message
        // with engine Basic auth; the server password lives in serve.log next to
        // OPENCODE_SERVER_PASSWORD, or in OPENCODE_SERVER_PASSWORD when set).
        if (session && typeof (session as { messages?: unknown }).messages === "function") {
          const r = await (session as { messages(a: { sessionID: string }): Promise<unknown> }).messages({ sessionID: args.path.id });
          return normalizeMessageList(r);
        }
        try {
          const r = await fetch(`http://127.0.0.1:${process.env["OPENCODE_SERVER_PORT"] ?? "4096"}/api/session/${args.path.id}/message`, {
            headers: httpAuthHeaders(),
          });
          if (!r.ok) {
            note(`messages http fallback: ${r.status}`);
            return { data: [] };
          }
          const j = (await r.json()) as { data?: unknown };
          return normalizeMessageList(j);
        } catch (e) {
          note("messages http fallback failed: " + errmsg(e));
          return { data: [] };
        }
      },
      async create(args: { body?: { parentID?: string; title?: string }; query?: { directory?: string } }) {
        if (!session?.create) return { data: undefined };
        const r = await session.create({
          directory: args.query?.directory,
          title: args.body?.title,
          parentID: args.body?.parentID,
        });
        const id = (r as { id?: string })?.id ?? (r as { data?: { id?: string } })?.data?.id;
        return { data: { id } };
      },
      async promptAsync(args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }>; agent?: string } }) {
        if (!session?.prompt) return undefined;
        const text = args.body?.parts?.filter((p) => p?.type === "text").map((p) => p.text).join("\n") ?? "";
        // Fire-and-forget by contract (v1 promptAsync); do not await the turn.
        void session.prompt({ sessionID: args.path.id, text, agent: args.body?.agent }).catch(() => { /* sub-session turn failure is non-fatal */ });
        return { data: undefined };
      },
    },
    tui: {
      // v2 hosts surface toasts through a different face; keep it optional —
      // every v1 call site already null-guards (`client.tui?.showToast?.`).
      showToast: undefined,
    },
  };
}

/** Map a v2 message-list response into the v1 {data: [{info, parts}]} shape. */
function normalizeMessageList(r: unknown): { data: Array<{ info: Record<string, unknown>; parts: unknown[] }> } {
  const list = (r as { data?: unknown[] })?.data ?? (Array.isArray(r) ? r : []);
  const data = (Array.isArray(list) ? list : []).map((m) => {
    const rec = m as { id?: string; role?: string; sessionID?: string; time?: unknown; agent?: string; content?: unknown[]; parts?: unknown[] };
    return {
      info: { id: rec.id, role: rec.role, sessionID: rec.sessionID, time: rec.time, agent: rec.agent },
      parts: (rec.content ?? rec.parts ?? []).map((p) => (typeof p === "string" ? { type: "text", text: p } : p)),
    };
  });
  return { data };
}
