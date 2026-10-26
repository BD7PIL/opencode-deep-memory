/**
 * v2-native entry — opencode 2.x plugin adapter.
 *
 * ## The v2 contract (pinned to @opencode/plugin 2.0.32)
 *
 *  - the module must export `{ id, setup }`, and `setup` must RETURN A DISPOSER
 *    — a returned hooks object is silently dropped;
 *  - the setup input is a 26-face ctx bag (app/location/session/tool/event/...)
 *    with NO `directory`, `serverUrl` or `client`;
 *  - the `context` hook IS awaited by the host, before the request is built, so
 *    mutations — including ones after an await — reach the outgoing request;
 *  - tools are registered through `ctx.tool.transform(editor => editor.add(...))`
 *    with a required `options.namespace`;
 *  - `ctx.event.subscribe` returns an AsyncIterable, and v2's event NAMES differ
 *    from v1's (`session.execution.succeeded`, not `session.idle`).
 *
 * All five points were re-measured against a live 2.0.32 engine; per-field
 * evidence is in docs/research/v2-032-respike.md. Note that 0.15.x assumed the
 * opposite of point 3 — see "What changed" below.
 *
 * ## What changed from the 0.15.x adapter
 *
 *  1. `context` is awaited, so the disk warm-cache handoff
 *     (`.deep-memory/.v2-warm-cache.json`, `warmBySession`, `applyMessages`) is
 *     gone. It existed only to work around mutations being lost across an
 *     await; it also overwrote message content wholesale from the previous
 *     turn's snapshot, and paid a cache-invalidating write every turn.
 *  2. The byte-stable memory payload rides a single appended SYSTEM part rather
 *     than the tail of the last user message. v2's `applyCachePolicy` places a
 *     breakpoint at the last distinct system part, so a byte-stable block there
 *     joins the cached prefix permanently instead of paying a boundary miss per
 *     turn. Volatile content (the nudge) still lands at the tail.
 *  3. All seven tools are registered via `tool.transform` with the namespace
 *     split that reproduces their v1 names (0.15.x registered none: it called
 *     the v1 `tool` map as if it were a function).
 *  4. `ctx.tool.hook("execute.after")` replaces the invalid `hook("*")`.
 *  5. `ctx.event.subscribe` is consumed as an AsyncIterable, and v2 event names
 *     are normalized back to the v1 vocabulary (see event-map.ts).
 *  6. `chat.params` is bridged onto `context`, which is the only v2 payload
 *     carrying agent/model; this restores `state.bestModel()` for the
 *     consolidation sub-session.
 *
 * The entire v1 implementation (src/index.ts) stays untouched: this adapter
 * builds the v1 hooks via `deepMemoryPlugin()` and re-registers each hook onto
 * the v2 faces. The export is dual-form — v1 hosts call the default function,
 * v2 hosts read `.setup` — which the official migration guide supports for
 * hosts at 1.18.29 and above.
 */
import { deepMemoryPlugin } from "../index.js";
import { appendDebugLine } from "./debug-channel.js";
import { normalizeV2Event } from "./event-map.js";
import { registerV2Tools, type V1ToolDefinition } from "./tool-bridge.js";
import type {
  V2CompactionEvent,
  V2ContextEvent,
  V2Ctx,
  V2Event,
  V2Message,
  V2PromptEvent,
  V2Registration,
  V2ToolAfterEvent,
} from "./v2-types.js";
import type { PluginInput, Hooks } from "@opencode-ai/plugin";

export const V2_PLUGIN_ID = "opencode-deep-memory";

/** Debug parity with the v1 file logger (DEEP_MEMORY_DEBUG gated). */
function note(msg: string): void {
  try {
    appendDebugLine(`[v2-entry] ${msg}`);
  } catch {
    /* best-effort */
  }
}

function errmsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Remembers which v2 message object a bridged v1 wrapper came from, so an
 * unmodified message can be handed back by identity. Byte identity matters:
 * the provider cache prefix is matched over the serialized messages.
 */
const v1WrapperOrigin = new WeakMap<object, V2Message>();

/** v2 message -> the `{info, parts}` shape every v1 hook expects. */
function toV1Message(message: V2Message): { info: Record<string, unknown>; parts: unknown[] } {
  const wrapper = {
    info: { ...(message.metadata ?? {}), id: message.id, role: message.role },
    // Deliberately the SAME array reference as `message.content`, so in-place
    // part removals/splices the v1 transforms perform are observable.
    parts: Array.isArray(message.content) ? message.content : [],
  };
  v1WrapperOrigin.set(wrapper, message);
  return wrapper;
}

/**
 * v1 messages -> v2 messages.
 *
 * Messages the v1 transforms left alone are returned BY IDENTITY, so an
 * unchanged history stays byte-identical for the cache prefix. Messages the
 * transforms inserted (the compression summary block) have no origin and are
 * rebuilt from the wrapper.
 */
function fromV1Messages(
  bridged: Array<{ info: Record<string, unknown>; parts: unknown[] }>,
): V2Message[] {
  return bridged.map((entry) => {
    const origin = v1WrapperOrigin.get(entry);
    if (origin) {
      origin.role = typeof entry.info["role"] === "string" ? (entry.info["role"] as string) : origin.role;
      origin.content = entry.parts;
      return origin;
    }
    const { id, role, ...rest } = entry.info;
    return {
      id: typeof id === "string" ? id : undefined,
      role: typeof role === "string" ? role : undefined,
      content: entry.parts,
      metadata: rest,
    };
  });
}

/** Text of a completed v2 tool result, for the v1 `output.output` field. */
function toolResultText(event: V2ToolAfterEvent): string {
  if (event.status !== "completed") return "";
  const result = event.result as { output?: unknown; content?: unknown } | undefined;
  if (!result || typeof result !== "object") return "";
  if (typeof result.output === "string") return result.output;
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

/** Auth headers for the loopback HTTP fallback (v2 serve uses engine Basic auth). */
function httpAuthHeaders(): Record<string, string> {
  const pw = process.env["OPENCODE_SERVER_PASSWORD"] ?? "";
  return { authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` };
}

export async function v2Setup(ctx: V2Ctx): Promise<() => void> {
  if (!ctx || typeof (ctx as { agent?: { transform?: unknown } }).agent?.transform !== "function") {
    // Reduced host (TUI-side embed): no agent domain, nothing to hook.
    note("reduced host context; setup skipped");
    return () => {};
  }

  const directory = ctx.location?.directory;
  const v1input = {
    directory: typeof directory === "string" && directory ? directory : process.cwd(),
    serverUrl: new URL("http://127.0.0.1:0/"),
    // v2-native client adapter — typed at the boundary exactly like the v1
    // codebase does for host-injected clients.
    client: buildV2Client(ctx) as never,
  } as unknown as PluginInput;

  const hooks: Hooks = await deepMemoryPlugin(v1input);
  note("v1 hooks built: " + Object.keys(hooks).join(","));

  const disposers: Array<() => void> = [];
  const track = (registration: V2Registration | void): void => {
    if (registration && typeof registration.dispose === "function") {
      disposers.push(() => {
        void Promise.resolve(registration.dispose()).catch(() => {
          /* disposal is best-effort */
        });
      });
    }
  };

  const systemTransform = hooks["experimental.chat.system.transform"];
  const messagesTransform = hooks["experimental.chat.messages.transform"];
  const chatParams = hooks["chat.params"];
  const chatMessage = hooks["chat.message"];
  const compacting = hooks["experimental.session.compacting"];
  const eventHook = hooks["event"];
  const toolDefinitions = hooks["tool"] as Record<string, V1ToolDefinition> | undefined;
  const toolAfter = hooks["tool.execute.after"];

  const sessionFaces = ctx.session;
  const toolFaces = ctx.tool;

  if (sessionFaces?.hook) {
    // ── "context": the one hook that must do the real work ────────────────────
    // 2.0.32 awaits this handler before assembling the request, so the v1
    // transforms run to completion here and their output is applied directly.
    const contextHandler = async (event: V2ContextEvent): Promise<void> => {
      const sessionID = event.sessionID;
      try {
        // agent/model only exist on this payload in v2 — restore the v1
        // chat.params record so bestModel() can select the consolidation model.
        if (chatParams && sessionID && typeof event.agent === "string") {
          try {
            await chatParams(
              {
                sessionID,
                agent: event.agent,
                model: { providerID: event.model?.providerID ?? "", id: event.model?.id ?? "" },
              } as never,
              {} as never,
            );
          } catch (e) {
            note("chat.params bridge failed: " + errmsg(e));
          }
        }

        if (systemTransform && Array.isArray(event.system)) {
          const systemStrings = event.system.map((part) =>
            typeof part === "string" ? part : (part?.text ?? ""),
          );
          const baseLength = systemStrings.length;
          await systemTransform({ sessionID, agent: event.agent } as never, {
            system: systemStrings,
          } as never);
          // Everything the v1 handler appended becomes one extra system part.
          // The payload is byte-stable while MEMORY.md is unchanged (mtime
          // cache), so it joins the cached prefix; no explicit cache hint is
          // set because auto-policy already breaks at the last system part.
          for (const appended of systemStrings.slice(baseLength)) {
            if (typeof appended === "string" && appended.length > 0) {
              event.system.push({ type: "text", text: appended });
            }
          }
          note(`context: system ${baseLength} -> ${event.system.length} parts`);
        }

        if (messagesTransform && Array.isArray(event.messages)) {
          const bridged = event.messages.map(toV1Message);
          await messagesTransform({ sessionID } as never, { messages: bridged } as never);
          event.messages = fromV1Messages(bridged);
          note(`context: messages bridged ${bridged.length}`);
        }
      } catch (e) {
        note("context handler failed: " + errmsg(e));
      }
    };
    try {
      track(await sessionFaces.hook("context", contextHandler));
      note("context hook registered");
    } catch (e) {
      note("context register failed: " + errmsg(e));
    }

    // ── "prompt": carries the user's text; v2 has no equivalent of v1
    // `chat.message`, so this is where the once-per-session auto-search
    // whisper gets its query.
    if (chatMessage) {
      try {
        track(
          await sessionFaces.hook("prompt", (event: V2PromptEvent) => {
            const text = event?.prompt?.text;
            const sessionID = event?.sessionID;
            if (typeof text !== "string" || text.length === 0 || typeof sessionID !== "string") return;
            try {
              void chatMessage({ sessionID } as never, {
                message: undefined,
                parts: [{ type: "text", text }],
              } as never);
            } catch (e) {
              note("chat.message bridge failed: " + errmsg(e));
            }
          }),
        );
        note("prompt hook registered (last-user-text)");
      } catch (e) {
        note("prompt register failed: " + errmsg(e));
      }
    }

    // ── "compaction": v2 hands over the full message list and the agent, so
    // the v1 handler needs no client fetch at all.
    if (compacting) {
      try {
        track(
          await sessionFaces.hook("compaction", async (event: V2CompactionEvent) => {
            try {
              const out = { context: [] as string[], prompt: undefined as string | undefined };
              await (compacting as unknown as (i: unknown, o: unknown) => Promise<void>)(
                { sessionID: event?.sessionID },
                out,
              );
              note(`compaction: context=${out.context.length} prompt=${out.prompt ? out.prompt.length + "B" : "none"}`);
              if (Array.isArray(event?.system) && out.context.length > 0) {
                // Appended, not prepended: v1 documents these as additional
                // context for the compaction prompt, and appending keeps the
                // harness template (and its cache prefix) in place.
                event.system.push({ type: "text", text: out.context.join("\n") });
              }
            } catch (e) {
              note("compaction handler failed: " + errmsg(e));
            }
          }),
        );
        note("compaction hook registered");
      } catch (e) {
        note("compaction register failed: " + errmsg(e));
      }
    }
  }

  // ── tools: the v1 map is registered on the v2 editor ─────────────────────────
  if (toolFaces?.transform && toolDefinitions) {
    try {
      track(
        await toolFaces.transform((editor) => {
          try {
            const added = registerV2Tools(editor, toolDefinitions);
            note(`tool.transform: registered ${added}`);
          } catch (e) {
            note("tool.transform callback failed: " + errmsg(e));
          }
        }),
      );
      note("tool.transform registered");
    } catch (e) {
      note("tool.transform register failed: " + errmsg(e));
    }
  }

  // ── tool hooks: v2 names them execute.before/execute.after ───────────────────
  if (toolAfter && toolFaces?.hook) {
    try {
      track(
        await toolFaces.hook("execute.after", async (event: V2ToolAfterEvent) => {
          try {
            await (toolAfter as unknown as (i: unknown, o: unknown) => Promise<void>)(
              {
                tool: event?.tool,
                sessionID: event?.sessionID,
                callID: event?.id,
                // v1 reads input.args.{path,filePath}; v2 carries the args as `input`.
                args: event?.input,
              },
              { title: "", output: toolResultText(event), metadata: undefined },
            );
          } catch (e) {
            note("execute.after bridge failed: " + errmsg(e));
          }
        }),
      );
      note("execute.after hook registered");
    } catch (e) {
      note("execute.after register failed: " + errmsg(e));
    }
  }

  // ── events: an AsyncIterable, with v2 names mapped back to the v1 vocabulary ─
  const eventController = new AbortController();
  if (eventHook && ctx.event?.subscribe) {
    try {
      const iterable = ctx.event.subscribe({ signal: eventController.signal });
      void (async () => {
        try {
          for await (const raw of iterable as AsyncIterable<V2Event>) {
            const normalized = normalizeV2Event(raw);
            if (!normalized) continue;
            try {
              await eventHook({ event: normalized } as never);
            } catch (e) {
              // The v1 handler must never break the host's event stream.
              note(`event handler failed (${normalized.type}): ` + errmsg(e));
            }
          }
        } catch (e) {
          note("event iterator ended: " + errmsg(e));
        }
      })();
      note("event subscription started");
    } catch (e) {
      note("event subscribe failed: " + errmsg(e));
    }
  }

  return () => {
    eventController.abort();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* disposal is best-effort */
      }
    }
  };
}

/**
 * v2-native client adapter covering the three surfaces the v1 code uses:
 * `session.messages` (checkpoint + sub-session capture), `session.create` +
 * `session.promptAsync` (idle consolidation and context_compress sub-sessions),
 * and `config.get` (model fallback).
 */
export function buildV2Client(ctx: V2Ctx): unknown {
  const session = ctx.session;
  return {
    config: {
      // v2 exposes no config face; return an empty config so the v1 fallback
      // chain (state.bestModel() -> undefined) proceeds as designed.
      async get() {
        return { data: undefined };
      },
    },
    session: {
      async messages(args: { path: { id: string } }) {
        // v2 has no `session.messages` (verified on 2.0.32). Prefer the
        // in-process context read face, then fall back to the loopback HTTP API.
        if (session && typeof session.context === "function") {
          try {
            return normalizeContextList(await session.context({ sessionID: args.path.id }));
          } catch (e) {
            note("messages via ctx face failed, trying http: " + errmsg(e));
          }
        }
        try {
          const response = await fetch(
            `http://127.0.0.1:${process.env["OPENCODE_SERVER_PORT"] ?? "4096"}/api/session/${args.path.id}/context`,
            { headers: httpAuthHeaders() },
          );
          if (!response.ok) {
            note(`messages http fallback: ${response.status}`);
            return { data: [] };
          }
          return normalizeContextList(await response.json());
        } catch (e) {
          note("messages http fallback failed: " + errmsg(e));
          return { data: [] };
        }
      },
      async create(args: {
        body?: {
          parentID?: string;
          title?: string;
          agent?: string;
          model?: { providerID: string; modelID: string; variant?: string };
        };
        query?: { directory?: string };
      }) {
        if (!session?.create) return { data: undefined };
        const m = args.body?.model;
        const result = await session.create({
          directory: args.query?.directory,
          title: args.body?.title,
          parentID: args.body?.parentID,
          // The whole point of the 0.16.6 fix: v2 prompt payloads have no
          // agent/model fields, so the sub-session persona and model MUST ride
          // on session.create (engine host accepts both unvalidated; older
          // engines that lack them simply ignore the extra keys).
          agent: args.body?.agent,
          model: m
            ? { providerID: m.providerID, id: m.modelID, ...(m.variant ? { variant: m.variant } : {}) }
            : undefined,
        });
        const id = (result as { id?: string })?.id ?? (result as { data?: { id?: string } })?.data?.id;
        return { data: { id } };
      },
      async promptAsync(args: {
        path: { id: string };
        body: { parts: Array<{ type: string; text: string }>; agent?: string };
      }) {
        if (!session?.prompt) return undefined;
        const text =
          args.body?.parts?.filter((part) => part?.type === "text").map((part) => part.text).join("\n") ?? "";
        // Fire-and-forget by contract (the v1 method is promptAsync).
        void session
          .prompt({ sessionID: args.path.id, text, agent: args.body?.agent })
          .catch(() => {
            /* a failed sub-session turn is non-fatal */
          });
        return { data: undefined };
      },
    },
    agent: {
      // Spawn-precheck face (probeAgent). Prefer the in-process engine face,
      // fall back to the loopback HTTP API; on total failure return an empty
      // list so the probe reports "cannot determine" and never disables
      // consolidation by accident.
      async list() {
        const ctxFace = (ctx.agent as { list?: unknown } | undefined)?.list;
        if (typeof ctxFace === "function") {
          try {
            return await (ctxFace as (input?: unknown) => Promise<unknown>)();
          } catch (e) {
            note("agent.list via ctx face failed, trying http: " + errmsg(e));
          }
        }
        try {
          const response = await fetch(
            `http://127.0.0.1:${process.env["OPENCODE_SERVER_PORT"] ?? "4096"}/api/agent`,
            { headers: httpAuthHeaders() },
          );
          if (!response.ok) {
            note(`agent.list http fallback: ${response.status}`);
            return { data: [] };
          }
          return await response.json();
        } catch (e) {
          note("agent.list http fallback failed: " + errmsg(e));
          return { data: [] };
        }
      },
    },
    tui: {
      // v2 surfaces toasts through a different face; every v1 call site already
      // null-guards (`client.tui?.showToast?.`).
      showToast: undefined,
    },
  };
}

/**
 * Map a v2 message-list response into the v1 `{data: [{info, parts}]}` shape.
 *
 * v2 tags each entry with a `type` (`user`, `assistant`, `idle`, `compaction`).
 * The non-conversational markers are DROPPED rather than forwarded: both v1
 * call sites read `msgs[msgs.length - 1]` and require it to be an assistant
 * message, and a v2 context list ends with an `idle` marker — forwarding it
 * would silently disable idle consolidation and subagent summary collection.
 */
export function normalizeContextList(response: unknown): {
  data: Array<{ info: Record<string, unknown>; parts: unknown[] }>;
} {
  const list = (response as { data?: unknown })?.data ?? (Array.isArray(response) ? response : []);
  const entries = Array.isArray(list) ? list : [];
  const data: Array<{ info: Record<string, unknown>; parts: unknown[] }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;

    // Already v1-shaped (the /message endpoint, or a test double).
    if (record["info"] || record["parts"]) {
      data.push({
        info: (record["info"] as Record<string, unknown>) ?? {},
        parts: Array.isArray(record["parts"]) ? (record["parts"] as unknown[]) : [],
      });
      continue;
    }

    // The `context` endpoint tags entries with `type`; the `/message` endpoint
    // and older hosts use `role`. Accept either.
    const rawRole = record["type"] ?? record["role"];
    const role = typeof rawRole === "string" ? rawRole : undefined;
    if (role !== "user" && role !== "assistant") continue;

    const content = record["content"];
    const parts = Array.isArray(content)
      ? content
      : typeof record["text"] === "string"
        ? [{ type: "text", text: record["text"] }]
        : [];
    data.push({
      info: {
        id: record["id"],
        role,
        agent: record["agent"],
        model: record["model"],
        time: record["time"],
        tokens: record["tokens"],
      },
      parts,
    });
  }

  return { data };
}