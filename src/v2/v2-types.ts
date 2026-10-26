/**
 * Structural opencode v2 plugin types, pinned to `@opencode/plugin` 2.0.32.
 *
 * Vendored rather than imported on purpose. v2 ships under a *different* npm
 * scope (`@opencode/plugin`) than this package's peer dependency
 * (`@opencode-ai/plugin`, the v1 scope), and the published v2 authoring types
 * describe only 9 of the 26 context faces the runtime actually hands over —
 * `session`, `tool`, `event`, `storage` and `location` are all missing from the
 * published `PluginContext`. A structural copy keeps the build dependency-free.
 *
 * Every shape below was read off `@opencode/plugin@2.0.32`
 * `dist/promise/*.d.ts` and then confirmed against a live 2.0.32 engine.
 * Per-field evidence is in docs/research/v2-032-respike.md.
 */

/** `SystemPart` from `@opencode/ai`: the unit of the v2 system prompt. */
export interface V2SystemPart {
  type: "text";
  text: string;
  /**
   * Explicit cache-breakpoint hint. Deliberately left unset by this plugin:
   * v2's `applyCachePolicy` already places a breakpoint at the last distinct
   * system part, and manual hints count against the same 4-breakpoint budget,
   * so adding one here would spend a slot to achieve what auto already does.
   */
  cache?: { type: "ephemeral" | "persistent"; ttlSeconds?: number };
  metadata?: Record<string, unknown>;
}

/** A v2 message: `{id, role, content, metadata}` — not v1's `{info, parts}`. */
export interface V2Message {
  id?: string;
  role?: string;
  content?: unknown[];
  metadata?: Record<string, unknown>;
}

/**
 * `SessionContext` payload for the `context` hook. The host awaits these
 * handlers, so awaits inside them reach the outgoing request (2.0.32; the
 * 2.0.27 behaviour recorded in the E5 spike does not reproduce).
 */
export interface V2ContextEvent {
  sessionID?: string;
  model?: { id?: string; providerID?: string };
  system?: V2SystemPart[];
  messages?: V2Message[];
  options?: Record<string, unknown>;
  agent?: string;
  tools?: Record<string, { description?: string; input?: unknown }>;
}

/** `SessionCompaction`: `SessionContext` plus a settable `result`. */
export interface V2CompactionEvent extends V2ContextEvent {
  result?: { summary?: string };
}

/** `SessionPrompt` payload. Carries no agent/model — only `context` does. */
export interface V2PromptEvent {
  sessionID?: string;
  messageID?: string;
  prompt?: { text?: string; files?: unknown[]; agents?: unknown[]; skills?: unknown[] };
  metadata?: Record<string, unknown>;
  delivery?: string;
}

export interface V2Registration {
  dispose: () => Promise<void> | void;
}

export interface V2ToolInfo {
  name: string;
  description: string;
  input?: unknown;
  output?: unknown;
  options?: { namespace?: string; codemode?: boolean; permission?: string };
  execute?: (input: unknown, context: unknown) => unknown;
}

/** `ToolEditor` — v2 re-runs the transform callback, so `add` must be stable. */
export interface V2ToolEditor {
  list(): Array<V2ToolInfo & { id?: string }>;
  get(id: string): (V2ToolInfo & { id?: string }) | undefined;
  namespace(namespace: { name: string; description: string }): void;
  add(tool: V2ToolInfo): void;
  update(id: string, update: (tool: V2ToolInfo) => void): void;
  remove(id: string): void;
}

/** `execute.before` / `execute.after` payload — one object, not v1's two args. */
export type V2ToolAfterEvent = {
  tool: string;
  sessionID?: string;
  agent?: string;
  messageID?: string;
  id?: string;
  input?: unknown;
} & ({ status: "completed"; result?: unknown } | { status: "error"; error?: unknown });

/** A v2 event from `ctx.event.subscribe`. */
export interface V2Event {
  id?: string;
  created?: number;
  type?: string;
  durable?: boolean;
  location?: { directory?: string };
  data?: Record<string, unknown>;
}

/**
 * The v2 setup context, narrowed to the faces this plugin touches. The runtime
 * hands over 26 faces; `client`, `directory` and `serverUrl` — all three v1
 * `PluginInput` fields — are absent, which is why the adapter synthesises a v1
 * input instead of passing the ctx through.
 */
export interface V2Ctx {
  app?: { name?: string; version?: string; channel?: string };
  location?: {
    directory?: string;
    workspaceID?: string;
    project?: { id?: string; directory?: string; canonical?: string };
  };
  options?: Record<string, unknown>;
  /** Present on full hosts; absent on reduced (TUI-embedded) hosts. */
  agent?: {
    transform?: unknown;
    reload?: unknown;
    /** Agent listing face (engine plugin host) — used by the spawn precheck. */
    list?: (input?: unknown) => Promise<unknown>;
  };
  session?: {
    hook(
      event:
        | "prompt"
        | "context"
        | "compaction"
        | "generate"
        | "title"
        | "model.request"
        | "http.request"
        | "http.response"
        | "retry",
      handler: (event: any) => unknown,
    ): Promise<V2Registration>;
    create?(args: {
      directory?: string;
      title?: string;
      parentID?: string;
      /** Session-level agent: v2 prompt payloads have no agent field. */
      agent?: string;
      /** v2 Model.Ref shape: { providerID, id, variant? }. */
      model?: { providerID: string; id: string; variant?: string };
    }): Promise<unknown>;
    prompt?(args: { sessionID: string; text?: string; agent?: string }): Promise<unknown>;
    /** In-process message read face; the replacement for v1 `session.messages`. */
    context?(args: { sessionID: string }): Promise<unknown>;
  };
  /** `subscribe` returns an AsyncIterable — not a callback registration. */
  event?: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<V2Event> };
  tool?: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<V2Registration>;
    hook(
      name: "execute.before" | "execute.after",
      handler: (event: V2ToolAfterEvent) => unknown,
    ): Promise<V2Registration>;
    list?(): Promise<Array<V2ToolInfo & { id?: string }>>;
  };
  /** Cross-call persistent storage; unused while the state layer is in-memory. */
  storage?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}