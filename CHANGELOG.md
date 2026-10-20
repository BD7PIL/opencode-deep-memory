# 0.16.2 — the v2 gate now asserts the session.idle path

The real-engine gate claimed to cover the idle path but did not: v2 emits no
`session.idle`, and the v1 handler `return`s **silently** below the consolidation
threshold, so "no error" proved nothing. It is now asserted end to end.

## Added (test gate)

- **The idle path is directly asserted**, 11 checks: the simulated session starts
  from an accumulated MEMORY.md so the handler runs past its threshold, and the
  gate then asserts the spawn, the anti-cascade guard, cooldown-bounded
  re-spawns, the apply branch, the pending file, and that the child session the
  plugin created really exists on the engine under the recorded parent.
- **The apply branch proves the v2 read face works.** It reads the sub-session's
  last assistant message through the v2 client adapter (`ctx.session.context`),
  which is the replacement for the `session.messages` that v2 does not have.
- **A channel regression assertion**: the retired 0.15.x last-user-message
  channel (`<deep-memory-context>`) must not reappear anywhere in flight.
- **The injected block is measured as itself.** Earlier versions of the gate
  hashed the *whole* system prompt, which the harness legitimately moves as files
  appear during a session (the plugin writes MEMORY.md, checkpoints and the
  pending file). That made a passing property look like a failure and vice versa;
  the gate now extracts and hashes the `<deep-memory-stable>` block, and reports
  whole-prefix reuse as an observation instead of asserting on it.
- **Per-run log isolation.** The engine appends its debug log, so counts
  accumulated across runs — a two-run history once read as "two consolidation
  spawns", i.e. a cascade that never happened.

## Fixed (release pipeline — this blocked the 0.16.2 publish)

- **`npm test` could not pass on a clean checkout, so neither could
  `npm run verify`.** `tests/tools/memory-store.realshape.test.ts` loads the
  BUILT `dist/` on purpose (it validates the artifact a host actually loads),
  but `verify` and `ci.yml` both ran `test` BEFORE `build` — and `dist/` is
  gitignored, so on a clean checkout the import failed with
  `Failed to load url .../dist/index.js`. It passed locally only because a
  previous build had left `dist/` lying around.
  This is why CI has been **red on `main` since 0.15.1** and why the `v0.15.1`
  publish run failed: `publish.yml` runs `npm run verify`, i.e. the same broken
  order. Fixed from both directions: the test now declares its own dependency
  (it builds `dist` if missing, so `npm test` alone works on a clean clone), and
  `verify` / `ci.yml` build before testing, which is the convention the other
  artifact tests (`smoke`, `e2e`) already relied on.

## Fixed (documentation)

- The README storage tree placed `.pending-consolidation.json` inside
  `<project>/.deep-memory/`. It is written to the **project root**, which the
  gate now verifies.

# 0.16.1 — measured summary-block placement

Stage 4 asked for the mid-array summary splice to be replaced with
"append-then-cut". Measuring it first (`npm run measure:summary-placement`, added
here) showed the instruction's premise does not hold on this code path, so the
change shipped is conditional instead. Numbers and the full deviation record:
`docs/research/stage4-cache-work.md`.

## Changed

- **Summary-block placement is now chosen from the pass's own result.**
  When the compression pass rewrote history, splicing at `cutoff` was measured to
  cost **exactly nothing** — the cached prefix ends at the first rewrite, not at
  the insert — so the ordered placement is kept (all four candidate placements
  tie: 17 messages / 7202 chars re-prefilled). When the pass rewrote **nothing**,
  the insert is the only mutation and the splice re-prefilled the entire retained
  tail (**8 messages / 656 chars**); there the summary is appended instead
  (**0 / 0**). Marking the compressed zone's old assistant messages now runs
  before the insert so that decision can be made on the real result.
- A "no index shift" placement that anchors the summary to the compressed zone's
  last message was measured as well and is **worse** than the splice
  (9 messages / 738 chars), so it was not shipped.
- The summary is never dropped: in the no-compression case it is appended rather
  than discarded, so the agent's `context_compress(summary=...)` content survives.

## Added

- `scripts/measure-summary-placement.mts` — a reproducible, engine-free
  measurement of the four candidate placements plus the shipped policy, scored by
  cached-prefix length. Exposed as `npm run measure:summary-placement`.
- `tests/hooks/summary-placement.test.ts` — asserts the summary precedes the
  retained tail when the pass compressed something, that the retained tail keeps
  its bytes when it did not, and that exactly one summary block is inserted.
- `docs/research/stage4-cache-work.md` — the decision record for all three Stage 4
  items, including the deviation from the literal append-then-cut instruction.

# 0.16.0 — opencode v2 re-adaptation on 2.0.32 + prompt-cache work

Re-verified the whole v2 adapter against a real **opencode 2.0.32** engine and
rebuilt it around what the engine actually does. The 0.15.0 adapter was written
against a 2.0.27 spike whose central premise does not reproduce on 2.0.32.
Evidence for every change: `docs/research/v2-032-respike.md`.

## Fixed (v2 — each of these was silently broken on a real v2 host)

- **Memory tools never reached the model.** The adapter called the v1 `tool`
  map as if it were a function; the v2 registry takes `ctx.tool.transform(editor
  => editor.add(...))` with a **required** `options.namespace`, without which a
  tool lands in the registry but not the agent's tool list. All seven tools now
  register. The v1 key is split on its first underscore (`memory_search` →
  namespace `memory` + name `search`) so the model still sees the bare names the
  frozen TOOL_HINT refers to.
- **`tool.execute.after` never fired.** `ctx.tool.hook("*")` is not a valid v2
  hook name; the only names are `execute.before` / `execute.after`. Repomap
  read-tracking and stale-read edit-tracking work again.
- **Every event was dropped.** `ctx.event.subscribe` returns an AsyncIterable,
  not a callback registration — the returned iterable was never consumed. On top
  of that, v2 emits **no `session.idle` and no `session.compacted`**; those are
  now mapped from `session.execution.succeeded` and `session.compaction.started`.
  This restores idle-triggered memory consolidation (the primary consolidation
  path), compaction pressure calibration, the compaction audit log and
  `session.deleted` cleanup.
- **`bestModel()` was always undefined**, so the consolidation sub-session was
  spawned with no model: `chat.params` is bridged onto the `context` payload,
  which is the only place v2 exposes agent/model.
- **Compaction capture needed no fetch** — v2 hands the full message list to the
  `compaction` hook. The `client.session.messages` path is gone (that method does
  not exist on v2) and the read face is now `ctx.session.context`.
- **The read face is parsed correctly**: v2 tags entries `user` / `assistant` /
  `idle` / `compaction`. Non-conversational markers are dropped, because both v1
  call sites require the LAST entry to be an assistant message and a v2 list ends
  with an `idle` marker.

## Changed (v2 — cache profile)

- **The byte-stable memory block moved from the last user message back into a
  system part.** On 2.0.32 the host awaits `context` handlers and appended system
  parts do settle into the request, so the block joins the cached prefix instead
  of paying a boundary miss per turn. Appending also lands the auto cache
  breakpoint right after it, so no explicit `CacheHint` is set — manual hints
  count against the same four-breakpoint budget.
- **The disk warm-cache handoff is deleted** (`.deep-memory/.v2-warm-cache.json`,
  `warmBySession`, `applyMessages`). It existed only to work around mutations
  being lost across an `await`, which does not happen on 2.0.32; it also
  overwrote message content wholesale from the previous turn's snapshot.
- **Messages the bridge does not modify are returned by identity**, so an
  unchanged history stays byte-identical for the cache prefix.

## Fixed (v1 — pre-existing)

- **The once-per-session auto-search whisper was unreachable.**
  `state.consumeLastUserText()` was called by the system transform but nothing in
  `src/` ever called `recordLastUserText`. A new `chat.message` handler records
  the user's text; v2 feeds it from its `prompt` hook.
- **The proactive-expansion annotation was a cache bomb.** It appended up to
  3 KB of restored content to the compressed tool output it referred to — a part
  sitting mid-history, so the mutation invalidated every message after it. It now
  rides the last user message, bounding the cost to the bytes actually added, and
  is idempotent across the requests of one tool loop.
- **Nudge injection was not idempotent.** Without a stable marker the emergency
  nudge re-appended itself to the same tool output on every request, growing that
  output without bound and rewriting the tail each turn. Guarded by a per-kind
  marker prefix (the rendered text embeds a changing token count, so it cannot
  mark itself).

## Added

- `scripts/e2e-v2-lab.mjs` (`npm run e2e:v2`) — a real-engine gate that installs
  opencode v2, boots it in an isolated HOME against a stub LLM, and asserts tool
  visibility, tool execution, system-part settling, event-name mapping,
  compaction artifacts and prefix reuse. Wired into CI.
- `src/v2/v2-types.ts`, `src/v2/event-map.ts`, `src/v2/tool-bridge.ts` — the
  adapter split into the contract, the event vocabulary mapping and the tool
  conversion, with the v2 types vendored from `@opencode/plugin@2.0.32` (the
  published `PluginContext` omits 17 of the 26 faces the runtime hands over).
- `docs/research/v2-032-respike.md` — per-field evidence for every claim above.
- `docs/research/community-memory-plugins-2026-10.md` — survey of 20+ opencode
  memory/context plugins and the prompt-cache techniques they document.

## Removed

- `.deep-memory/.v2-warm-cache.json` from the documented storage layout.

## Tests

478 → 493 unit tests. New coverage: tool registration and naming, the JSON
Schema conversion, `execute.after` payload mapping, event-name normalization,
system-part byte stability across turns and across host reloads, tool-definition
ordering stability, the compaction mapping, `buildV2Client` over the real read
face, and nudge idempotency.

# 0.15.1 — tech-debt cleanup + test hardening

No API or behavior changes (except one real bug fix). Every gate re-verified:
typecheck + ~480 tests green twice in a row, smoke/e2e/e2e:real-bugs green,
dist shrank 602KB → 154KB.

## Fixed
- **Real ESM cache-invalidation bug** (`src/search/service.ts`): the
  `getSearchCacheMtime()` require chain threw under a pure-Node ESM host (the
  esbuild require shim is unavailable there), was silently swallowed by the
  surrounding try/catch, and left the search cache mtime at 0 — so
  `memory_store` followed by `memory_search` could serve a stale cache
  forever. It only ever worked because opencode happens to run on Bun.
  The three `require()` calls are now static imports; `src/` is require-free.
- **Search index never re-synced on mtime change** (`src/search/service.ts`):
  `search()` only built the index once (`ensureIndex`); the results-cache
  mtime check invalidated the *cache* but nothing re-diffed the *index*, so a
  content change whose post-write stat raced the kernel attribute cache (addEntry's
  own re-index skipped) left `memory_search` blind to the new entry until an
  unrelated file change. On a results-cache miss the reconciler now re-syncs
  (mtime-gated — unchanged files cost one stat each). Found by the new
  stability gate (the migrated cache test flaked ~1/15 runs before the fix).

## Removed
- **zod**: the repo's only zod use was one `z.string()` in memory-expand.
  Replaced with the `tool.schema` shape the other five tools already use —
  the "zero runtime dependencies" claim is now literally true and dist
  dropped from 602KB (74% zod, 47 locales) to 154KB.
- **Dead code**: `src/hooks/notify.ts` (0-call no-op), `src/repomap/index.ts`
  barrel, `hashProject`/`scheduleFilePath`/`sessionCheckpointDir`/
  `tryAcquireLock`/`dumpTrace` (all 0 src callers, supporting tests removed),
  `.npmignore` (files whitelist covers it, and its 7 DESIGN entries were all
  dangling).

## Changed
- `estimateTokens` unified on `src/shared/tokens.ts` (the pressure module's
  private CJK-aware variant is gone; the shared heuristic is the single
  implementation).
- Shared barrel (`src/shared/index.ts`) narrowed to the three symbols src/
  actually imports through it.
- Dangling `DESIGN*.md` references removed from 9 file headers; `PLAN_V5/V6`
  archived to `docs/plans/`; `CHANGELOG-V2.md` renamed `CHANGELOG.md`;
  README gained an opencode-v2 section (injection channel, warm-cache,
  storage tree) and the storage tree now lists `.v2-warm-cache.json` and
  `.tool-outputs/`.

## Tests (453 → 478, benchmark suite demoted to BENCH=1)
- **v2 bridge behaviors** (`tests/v2/entry.bridge.test.ts`, 19): disk warm-cache
  round-trip across setups, last-user-message injection, corrupt-cache
  rebuild, async refresh write-back, compaction mapping, HTTP fallback
  (non-2xx / reject / 2xx-normalize / auth-header shape), disposal (exactly
  once, single-fault tolerant), register-failure isolation, reduced-host
  no-op.
- **Compression-injection branch** (`tests/hooks/compression-inject.test.ts`,
  11): the `[compressed-block]` summary splice, deep_expand marker rewrite,
  keepRecent boundary, transient tool-output CCR path, plus direct
  maybeProactiveExpand tests (overlap threshold, throttle, size floor,
  ≤2 restores per turn).
- **Real-shape tool calls** (`tests/tools/memory-store.realshape.test.ts`,
  3): v0.14.1's Bug 1/2a/2b migrated from the dist script into vitest (loaded
  from `dist/` exactly like a real host); Bug 2c/3 stay in
  `scripts/e2e-real-bugs.mjs` (idle two-beat timing).
- **Assembly** (`tests/assembly.test.ts`, 5): smoke's hook-shape assertions
  + store → search → system-injection positive loop now run on every
  `npm test`; `src/index.ts` removed from coverage excludes.
- **Compacting spawn branches** (`tests/hooks/compacting-spawn.test.ts`, 4):
  cooldown suppression, session.create rejection swallowed, bestModel
  forwarded in promptAsync + pending persisted, spawned sub-session guard.
- **Stability**: the two mtime-granularity flaky tests now bump mtimes via
  `fs.utimes`; the benchmark suite (timing assertions) only runs with
  `BENCH=1`.
- **Shared fixtures**: `tests/helpers/mock-host.ts` consolidates the four
  verbatim mockClient copies + message factories + the v2 ctx bag.

## CI
- `npm run e2e:real-bugs` is now a required step in the push/PR workflow —
  the v0.14.1 gatekeeper no longer runs only before publish.

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

## 0.15.0 addendum — real-E2E bug regression script (batch D2 item 3)

`scripts/e2e-real-bugs.mjs` (also `npm run e2e:real-bugs`): the three v0.14.1
real-production bugs as scripted scenarios against the built dist —
1. memory_store with the exact real-call arg shape (no scope/type) stores
   successfully (zod .default() does not run outside the TUI);
2. write-time dedup catches exact duplicates of real '- content' entries and
   does NOT false-positive on short token-similar lines (the removed SimHash
   path);
3. the idle-apply path persists pending-consolidation consumption to disk
   (stale entries no longer resurrect across restarts) — asserted through the
   real spawn → consume → persist flow with the project-root pending file.
Driven through plugin hooks with mocked host clients (no opencode process
needed); complements the unit regressions already in tests/extract and
tests/hooks. 12 assertions, exit 1 on any failure.
