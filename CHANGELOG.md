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
