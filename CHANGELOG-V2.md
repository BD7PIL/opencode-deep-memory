# 0.15.0 — opencode v2 support (batch D2)

First release that runs natively on **opencode 2.x** while keeping the 1.x
plugin entry working (dual-form export: v1 hosts call `default(input)`, v2
hosts read `default.setup`).

## Added
- **v2-native adapter** (`src/v2/entry.ts`): `{id, setup}` contract returning a
  disposer; `location.directory` mapping; re-registers all seven v1 hooks onto
  the v2 faces (`session.hook("context"/"prompt"/"compaction")`,
  `event.subscribe`, `tool.hook`).
- **v2 client adapter**: v1-shaped `client.session.messages/create/promptAsync`
  over the v2 ctx session face with a loopback HTTP fallback (Basic auth via
  `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_PORT`), message-shape
  normalization (v2 flat `{role, content}` → v1 `{info, parts}`), and a
  no-op TUI face (v1 call sites already null-guard).
- **Cache regression suite** (`tests/v2/entry.test.ts`): pins the three
  cache-friendly invariants — messages.transform idempotency (second pass is
  byte-identical), context-hook sync safety (no awaits before mutation), and
  the golden hash of the injection payload (byte-stable across invocations
  with unchanged MEMORY.md).

## Changed
- **Injection channel on v2**: the memory payload rides on the last user
  message as a `<deep-memory-context>` block instead of the system array —
  on opencode v2 the session "context" hook does not await handler promises
  and system[] mutations were not reliably serialized into the LLM request,
  while user-message content mutations demonstrably land. The payload itself
  is byte-stable (mtime-cached), so this costs one cache miss per turn boundary
  and nothing otherwise.
- Warm-cache handoff lives in the project `.deep-memory/.v2-warm-cache.json`
  (cross-turn, disk-backed): the prompt hook (awaited by the host) seeds it,
  the context hook applies it synchronously.

## Removed
- Dead V4 repomap injector (`formatRepoMap`) — no production callers since
  the V4→V5 volatile-injection removal; `extractor` and `tracker` stay
  (checkpoint re-injection and tool-read tracking still use them).

## Verification (e5-lab isolated stack, opencode v2.0.27)
- Plugin loads natively (no wrapper), all faces register.
- Injection lands in the real LLM request (stub-captured bodies show the
  `<deep-memory-context>` block on every content turn).
- Forced compaction writes `checkpoint.md` + `checkpoint.raw.json` and
  returns 2-item post-compact context.
- 456 → 453 tests green (6 new cache invariants, 3 removed with the dead
  injector).
