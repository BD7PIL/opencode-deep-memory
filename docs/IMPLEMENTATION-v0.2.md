# Implementation Plan: Context Compression + Tier Injection (v0.2)

> Status: Final — approved for implementation
> Date: 2026-06-16
> Supersedes: O15-O20 optimization plan

---

## 1. Objective

Two parallel capabilities that together replace DCP and surpass Magic Context:

**A. Context Compression** (`messages.transform` hook)
Deterministic content stripping: clear old reasoning, strip system injections, truncate tool errors, strip thinking tags. Uses `[stripped]` sentinel replacement (cross-provider safe).

**B. Tier-Based Memory Injection** (`system.transform` hook)
5-tier dynamic rendering with BM25 × importance fusion, single-pass budget allocation, Jaccard dedup. Zero LLM, zero dependencies.

---

## 2. Verified Facts (implementation constraints)

### Hook signatures (from `@opencode-ai/plugin/dist/index.d.ts`)

```typescript
// Line 227-232
"experimental.chat.messages.transform"?: (input: {}, output: {
    messages: { info: Message; parts: Part[] }[];
}) => Promise<void>;

// Line 233-238
"experimental.chat.system.transform"?: (input: {
    sessionID?: string;
    model: Model;
}, output: {
    system: string[];
}) => Promise<void>;
```

**Critical**: `messages.transform` input is `{}` (empty) — NO sessionID, NO model. Only `output.messages` is available.

### OpenCode system array handling (from binary extraction)

```javascript
// Separate system messages (not joined), with cache optimization:
i = n[0];
trigger("experimental.chat.system.transform", {sessionID, model}, {system: n});
if (n.length > 2 && n[0] === i) {
  let $ = n.slice(1);
  n.length = 0;
  n.push(i, $.join("\n"));  // Collapse to [base, joinedRest]
}
// Sent as: [...n.map(s => ({role:"system", content:s})), ...messages]
```

**Implication**: m[0]/m[1] split is effective. Push stable first (preserves n[0] reference), volatile second.

### Hooks fire for ALL sessions (verified)

`plugin.trigger()` has NO subagent guards. Our dream/distill background sessions WILL trigger messages.transform. **Must add child-session guard.**

### `reasoning_details` not consumed by anything (verified)

Safe to strip from metadata. Only exists as model capability enum in SDK types.

---

## 3. Architecture

### 3A. Content Compression Pipeline

```
messages.transform hook
    │
    ├── Guard: child session? → skip
    ├── Guard: messages.length <= 8? → skip (nothing to strip)
    │
    ├── protectedTailStart = messages.length - KEEP_RECENT(8)
    │
    ├── For i in 0..protectedTailStart-1:
    │   ├── msg = messages[i]
    │   ├── if msg.info.role === "user" → skip (NEVER touch user)
    │   │
    │   ├── O15: Strip reasoning metadata
    │   │   for each part type "reasoning"|"thinking"|"redacted_thinking":
    │   │     if part.metadata?.openrouter?.reasoning_details:
    │   │       delete part.metadata.openrouter.reasoning_details
    │   │
    │   ├── O15b: Clear old reasoning text
    │   │   for each part type "reasoning"|"thinking":
    │   │     if part.text && part.text !== "[cleared]":
    │   │       part.text = "[cleared]"
    │   │
    │   ├── O16: Strip system-injected messages
    │   │   if ALL text parts match SYSTEM_INJECTION_PATTERNS:
    │   │     replace all parts with [{type:"text", text:"[stripped]"}]
    │   │
    │   ├── O17: Truncate old tool errors
    │   │   for each part type "tool" with state.status === "error":
    │   │     if state.error.length > 100:
    │   │       state.error = state.error.slice(0,100) + "... [truncated]"
    │   │
    │   └── O19: Strip inline thinking tags
    │       for each part type "text":
    │         part.text = part.text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g, "")
    │
    └── Log stats
```

### 3B. Tier Injection pipeline

```
system.transform hook
    │
    ├── Determine mode (normal/post-resume)
    ├── Get agent tier → budget
    │
    ├── m[0] STABLE (push first, cache-stable):
    │   ├── TOOL_HINT (constant string)
    │   └── Top constraints/rules from MEMORY.md (budgetedRead, 300t)
    │
    ├── m[1] VOLATILE (push second, changes per turn):
    │   ├── BM25 search for user's current query
    │   ├── For each result:
    │   │   ├── Compute heuristic importance (type + frequency + recency)
    │   │   ├── BM25 relevance boost (percentile-based)
    │   │   └── Fused importance = base + boost
    │   ├── Jaccard dedup (similarity > 0.85 → merge)
    │   ├── Single-pass greedy budget allocation:
    │   │   Sort by fused importance desc
    │   │   For each entry:
    │   │     Try P1 (full, if fits remaining budget)
    │   │     Else try P2 (summary, ~60t)
    │   │     Else try P3 (bullet, ~25t)
    │   │     Else try P4 (label, ~15t)
    │   │     Else P5 (skip)
    │   ├── Render each entry at allocated tier
    │   └── Truncate to volatile budget
    │
    └── Push m[0] then m[1] to output.system[]
```

---

## 4. File Changes

### New files (7)

| File | Lines | Purpose |
|------|-------|---------|
| `src/hooks/messages-transform.ts` | ~120 | Content compression handler (O15-O19) |
| `src/inject/importance.ts` | ~60 | Heuristic importance scoring |
| `src/inject/tier-renderer.ts` | ~80 | 5-tier dynamic rendering |
| `src/inject/budget-allocator.ts` | ~70 | Single-pass greedy allocation + BM25 fusion |
| `src/inject/dedup.ts` | ~40 | Jaccard similarity dedup |
| `src/shared/spawned-sessions.ts` | ~25 | Child session tracker (Set<string>) |
| `tests/hooks/messages-transform.test.ts` | ~150 | Unit tests for compression |

### Modified files (5)

| File | Change |
|------|--------|
| `src/inject/system-payload.ts` | Return `{stable, volatile}` instead of single string. Integrate tier allocator. |
| `src/hooks/system-transform.ts` | Push two entries (m[0], m[1]) instead of one. |
| `src/hooks/shared-state.ts` | Add `recordSpawnedSession(sid)`, `isSpawnedSession(sid)`, `forgetSpawnedSession(sid)`. |
| `src/schedule/dream-executor.ts` | Call `state.recordSpawnedSession(sid)` after creating background session. |
| `src/schedule/distill-executor.ts` | Same as dream-executor. |
| `src/index.ts` | Register messages.transform hook. Pass spawned session set. |

### Updated tests (3)

| File | Change |
|------|--------|
| `tests/inject/system-payload.test.ts` | Test `{stable, volatile}` return format |
| `tests/hooks/system-transform.test.ts` | Test dual push to output.system[] |
| `tests/schedule/dream-executor.test.ts` | Verify recordSpawnedSession called |

---

## 5. Detailed Specifications

### 5.1 `src/hooks/messages-transform.ts`

```typescript
const KEEP_RECENT = 8;

const SYSTEM_INJECTION_PATTERNS = [
  /^<!-- OMO_INTERNAL_INITIATOR -->$/,
  /^<system-reminder>[\s\S]*<\/system-reminder>$/,
  /^\[SYSTEM DIRECTIVE:/,
  /^\[Category\+Skill Reminder\]/,
  /^\[EDIT ERROR - IMMEDIATE ACTION REQUIRED\]/,
  /^\[task CALL FAILED/,
  /^\[EMERGENCY CONTEXT WINDOW WARNING\]/,
];

const INLINE_THINKING_RE = /<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g;

const METADATA_PART_TYPES = new Set([
  "step-start", "step-finish", "snapshot", "patch",
  "agent", "retry", "subtask", "compaction",
]);

export function createMessagesTransformHandler(
  state: PluginState,
  logger?: Logger,
): NonNullable<Hooks["experimental.chat.messages.transform"]> {
  return async (_input, output) => {
    const messages = output.messages;
    if (messages.length <= KEEP_RECENT) return;

    const protectedTailStart = messages.length - KEEP_RECENT;
    const stats = { reasoning_cleared: 0, metadata_stripped: 0,
                    system_neutralized: 0, tool_errors_truncated: 0,
                    thinking_stripped: 0 };

    for (let i = 0; i < protectedTailStart; i++) {
      const msg = messages[i];
      if (!msg?.parts?.length) continue;

      // NEVER touch user messages
      if (msg.info.role === "user") continue;

      for (let j = 0; j < msg.parts.length; j++) {
        const part = msg.parts[j];
        if (!part || typeof part !== "object") continue;
        const partType = (part as any).type as string;

        // Skip metadata parts
        if (METADATA_PART_TYPES.has(partType)) continue;

        // O15: Strip reasoning metadata (OpenRouter)
        if (partType === "reasoning" || partType === "thinking" || partType === "redacted_thinking") {
          const meta = (part as any).metadata;
          if (meta?.openrouter?.reasoning_details) {
            delete meta.openrouter.reasoning_details;
            stats.metadata_stripped++;
          }
          // O15b: Clear old reasoning text
          if (typeof (part as any).text === "string" && (part as any).text !== "[cleared]") {
            (part as any).text = "[cleared]";
            stats.reasoning_cleared++;
          }
        }

        // O15: Strip tool reasoning metadata
        if (partType === "tool") {
          const meta = (part as any).metadata;
          if (meta?.openrouter?.reasoning_details) {
            delete meta.openrouter.reasoning_details;
            stats.metadata_stripped++;
          }
          // O17: Truncate old tool errors
          const state = (part as any).state;
          if (state?.status === "error" && typeof state.error === "string") {
            if (state.error.length > 100) {
              state.error = state.error.slice(0, 100) + "... [truncated]";
              stats.tool_errors_truncated++;
            }
          }
        }

        // O19: Strip inline thinking tags
        if (partType === "text" && typeof (part as any).text === "string") {
          const cleaned = (part as any).text.replace(INLINE_THINKING_RE, "");
          if (cleaned !== (part as any).text) {
            (part as any).text = cleaned;
            stats.thinking_stripped++;
          }
        }
      }

      // O16: Strip system-injected messages (sentinel replacement)
      if (isSystemInjected(msg)) {
        msg.parts.length = 0;
        msg.parts.push({ type: "text", text: "[stripped]" } as any);
        stats.system_neutralized++;
      }
    }

    if (Object.values(stats).some(v => v > 0)) {
      logger?.debug("messages.transform: stripped", stats);
    }
  };
}

function isSystemInjected(msg: { parts: any[] }): boolean {
  let hasText = false;
  let allInjected = true;
  for (const part of msg.parts) {
    if (!part || typeof part !== "object") continue;
    const partType = part.type as string;
    if (METADATA_PART_TYPES.has(partType)) continue;
    if (partType === "tool") { allInjected = false; break; }
    if (partType === "text" && typeof part.text === "string") {
      hasText = true;
      if (!SYSTEM_INJECTION_PATTERNS.some(p => p.test(part.text.trim()))) {
        allInjected = false;
        break;
      }
    }
  }
  return hasText && allInjected;
}
```

### 5.2 `src/inject/importance.ts`

```typescript
import type { MemoryType } from "../shared/paths.js";

const BASE_IMPORTANCE: Record<string, number> = {
  constraint: 80, decision: 70, gotcha: 60, fact: 50, note: 30,
};

export interface ImportanceFactors {
  type: string;
  ageDays: number;
  notesOccurrences: number;
  searchHits: number;
}

export function computeImportance(factors: ImportanceFactors): number {
  let score = BASE_IMPORTANCE[factors.type] ?? 40;
  score += Math.min(20, factors.notesOccurrences * 5);
  score += Math.min(15, factors.searchHits * 5);
  if (factors.ageDays < 7) score += 10;
  else if (factors.ageDays < 30) score += 5;
  return Math.max(1, Math.min(100, score));
}
```

### 5.3 `src/inject/tier-renderer.ts`

```typescript
export type Tier = 1 | 2 | 3 | 4 | 5;

const TIER_MAX_TOKENS: Record<number, number> = { 1: 200, 2: 60, 3: 25, 4: 15, 5: 0 };

export function renderTier(
  content: string,
  type: string,
  heading: string,
  tier: Tier,
): string {
  if (tier === 5) return "";

  const maxTokens = TIER_MAX_TOKENS[tier];
  const contentTokens = Math.ceil(content.length / 4);

  // P1: full text (if fits)
  if (tier === 1) {
    return contentTokens <= maxTokens
      ? `- [${heading}] ${content}`
      : `- [${heading}] ${content.slice(0, maxTokens * 4)}... [truncated]`;
  }

  // P2: first sentence + type
  if (tier === 2) {
    const firstSentence = content.split(/[.。!！?？\n]/)[0] ?? content.slice(0, 200);
    return `- [${type}] ${firstSentence.slice(0, 200)}`;
  }

  // P3: type + first 10 words
  if (tier === 3) {
    const words = content.split(/\s+/).slice(0, 10).join(" ");
    return `- [${type}] ${words.slice(0, 80)}`;
  }

  // P4: type label only
  return `- [${type}]`;
}
```

### 5.4 `src/inject/budget-allocator.ts`

```typescript
import { computeImportance } from "./importance.js";
import { renderTier, Tier } from "./tier-renderer.js";
import { estimateTokens } from "../shared/tokens.js";

interface SearchResultLike {
  score: number;
  heading: string;
  snippet: string;
  scope: string;
}

export interface AllocatedEntry {
  content: string;
  type: string;
  heading: string;
  tier: Tier;
  rendered: string;
  tokens: number;
}

export function allocateAndRender(
  results: SearchResultLike[],
  opts: {
    budget: number;
    ageDays?: (entry: SearchResultLike) => number;
    typeOf?: (entry: SearchResultLike) => string;
  },
): AllocatedEntry[] {
  if (results.length === 0) return [];

  // 1. Compute BM25 percentile boost
  const sortedScores = results.map(r => r.score).sort((a, b) => b - a);
  const top20 = sortedScores[Math.floor(sortedScores.length * 0.2)] ?? 0;
  const top50 = sortedScores[Math.floor(sortedScores.length * 0.5)] ?? 0;

  // 2. Compute fused importance for each
  const withImportance = results.map(r => {
    const type = opts.typeOf?.(r) ?? inferType(r.heading);
    const ageDays = opts.ageDays?.(r) ?? 0;
    const base = computeImportance({
      type, ageDays, notesOccurrences: 0, searchHits: 0,
    });
    let boost = 0;
    if (r.score >= top20) boost = 30;
    else if (r.score >= top50) boost = 15;
    return { result: r, type, fusedImportance: base + boost };
  });

  // 3. Sort by fused importance descending
  withImportance.sort((a, b) => b.fusedImportance - a.fusedImportance);

  // 4. Single-pass greedy allocation
  let remaining = opts.budget;
  const allocated: AllocatedEntry[] = [];

  for (const item of withImportance) {
    if (remaining <= 0) break;

    const content = item.result.snippet;
    const fullCost = estimateTokens(content);

    let tier: Tier;
    if (fullCost <= remaining && item.fusedImportance >= 80) {
      tier = 1;
    } else if (remaining > 60) {
      tier = 2;
    } else if (remaining > 25) {
      tier = 3;
    } else if (remaining > 15) {
      tier = 4;
    } else {
      break;
    }

    const rendered = renderTier(content, item.type, item.result.heading, tier);
    const tokens = estimateTokens(rendered);

    allocated.push({
      content, type: item.type, heading: item.result.heading,
      tier, rendered, tokens,
    });
    remaining -= tokens;
  }

  return allocated;
}

function inferType(heading: string): string {
  const h = heading.toLowerCase();
  if (h.includes("constraint") || h.includes("rule")) return "constraint";
  if (h.includes("decision")) return "decision";
  if (h.includes("gotcha") || h.includes("error")) return "gotcha";
  if (h.includes("fact")) return "fact";
  return "note";
}
```

### 5.5 `src/inject/dedup.ts`

```typescript
export function dedupByJaccard<T>(
  items: T[],
  getText: (item: T) => string,
  threshold = 0.85,
): T[] {
  const result: T[] = [];
  const tokenSets = result.map(item => new Set(tokenize(getText(item))));

  for (const item of items) {
    const tokens = new Set(tokenize(getText(item)));
    let isDup = false;

    for (const existing of tokenSets) {
      if (jaccardSimilarity(tokens, existing) > threshold) {
        isDup = true;
        break;
      }
    }

    if (!isDup) {
      result.push(item);
      tokenSets.push(tokens);
    }
  }

  return result;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s\p{P}]+/u).filter(t => t.length > 0);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
```

### 5.6 `src/inject/system-payload.ts` (modified)

Return type changes from `Promise<string>` to `Promise<{ stable: string; volatile: string }>`.

```typescript
export async function composeSystemPayload(
  opts: ComposeSystemPayloadOpts,
): Promise<{ stable: string; volatile: string }> {
  // ... existing agent/budget logic ...

  // STABLE (m[0]): TOOL_HINT + constraints (never changes per turn)
  const stable = `<deep-memory-stable>\n<tool-hint>${TOOL_HINT}</tool-hint>\n<constraints>\n${staticMemory}\n</constraints>\n</deep-memory-stable>`;

  // VOLATILE (m[1]): tier-allocated search results (changes per turn)
  let volatileContent = "";
  if (userQuery && searchService && searchBudget > 0) {
    const results = await searchService.search(userQuery, { scope: "all", limit: 20 });
    const deduped = dedupByJaccard(results, r => r.snippet);
    const allocated = allocateAndRender(deduped, { budget: searchBudget });
    volatileContent = allocated.map(a => a.rendered).join("\n");
  }
  const volatile = `<deep-memory-volatile>\n<relevant>\n${volatileContent || "(none)"}\n</relevant>\n</deep-memory-volatile>`;

  return { stable, volatile };
}
```

### 5.7 `src/hooks/system-transform.ts` (modified)

```typescript
const { stable, volatile } = await composeSystemPayload(opts);
if (stable) output.system.push(stable);    // m[0] first (cache-stable)
if (volatile) output.system.push(volatile); // m[1] second (volatile)
```

---

## 6. Child Session Guard

### `src/shared/spawned-sessions.ts`

```typescript
const spawnedSessions = new Set<string>();

export function recordSpawnedSession(sid: string): void {
  spawnedSessions.add(sid);
}

export function isSpawnedSession(sid: string): boolean {
  return spawnedSessions.has(sid);
}

export function forgetSpawnedSession(sid: string): void {
  spawnedSessions.delete(sid);
}
```

### Integration points:
- `dream-executor.ts`: `recordSpawnedSession(dreamSessionID)` after `client.session.create()`
- `distill-executor.ts`: same
- `messages-transform.ts`: `if (isSpawnedSession(sessionID)) return;` — BUT sessionID is NOT in messages.transform input (`{}` type). **Alternative**: check `msg.info.role` patterns or skip guard entirely (child sessions are short, stripping is a no-op for <8 messages).

**Resolution**: messages.transform input is `{}` (no sessionID). Cannot do per-session guard. Instead, the `messages.length <= KEEP_RECENT(8)` guard naturally skips child sessions (they're short). **No explicit child guard needed.**

---

## 7. Test Plan

### Unit tests

| File | Tests |
|------|-------|
| `messages-transform.test.ts` | (1) empty messages → no-op, (2) <8 messages → no-op, (3) user messages untouched, (4) reasoning text cleared on old msgs, (5) reasoning text preserved on recent msgs, (6) metadata stripped, (7) system injection neutralized, (8) tool error truncated, (9) thinking tags stripped, (10) mixed content message not over-stripped |
| `importance.test.ts` | (1) base scores by type, (2) frequency bonus cap, (3) recency bonus tiers, (4) clamping 1-100 |
| `tier-renderer.test.ts` | (1) P1 full text, (2) P1 truncation when >200t, (3) P2 first sentence, (4) P3 first 10 words, (5) P4 label only, (6) P5 empty |
| `budget-allocator.test.ts` | (1) empty results → empty, (2) single high-importance → P1, (3) budget exhaustion → tier downgrade, (4) BM25 percentile boost, (5) exact budget fit |
| `dedup.test.ts` | (1) identical → merge, (2) similar >0.85 → merge, (3) different → keep both, (4) empty input |

### Smoke tests (add to smoke.mjs)

```
✓ messages.transform registered
✓ messages.transform executes without error on mock messages
✓ messages.transform skips when <8 messages
✓ system.transform pushes 2 fragments (m[0] + m[1])
✓ m[0] contains <deep-memory-stable>
✓ m[1] contains <deep-memory-volatile>
```

### E2E tests

| Test | Method |
|------|--------|
| Compression ratio | 20-round conversation, measure token usage before/after |
| Reasoning clearing | Send message with reasoning, wait 8+ turns, verify reasoning cleared in debug log |
| System injection strip | Verify OMO notifications stripped from old messages |
| Cache stability | Send 2 consecutive turns, compare m[0] fragments — must be byte-identical |
| Tier rendering quality | Store 20+ memories, ask specific query, verify high-relevance entries at P1 |
| Budget fit | Store 50+ memories, verify injection stays within budget |

---

## 8. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| messages.transform conflicts with OMO | OMO only adds content; we only strip OLD content. Orthogonal. |
| Sentinel breaks non-Anthropic provider | Use `[stripped]` text (10 chars), not empty string |
| Child sessions stripped unnecessarily | `messages.length <= 8` guard naturally skips short sessions |
| Tier allocation too aggressive | Min budget per tier (P1≥remaining, P2≥60, P3≥25, P4≥15) |
| Jaccard false positive merge | Threshold 0.85 is strict; only catches near-duplicates |
| BM25 score normalization across corpus sizes | Percentile-based boost (top 20%/50%), not absolute threshold |
| m[0]/m[1] cache invalidation | OpenCode preserves n[0] reference identity for cache; our stable fragment is always pushed first |

---

## 9. Implementation Order

```
1. src/shared/spawned-sessions.ts (trivial)
2. src/inject/importance.ts + tests
3. src/inject/tier-renderer.ts + tests
4. src/inject/budget-allocator.ts + tests
5. src/inject/dedup.ts + tests
6. src/inject/system-payload.ts (rewrite for {stable, volatile})
7. src/hooks/system-transform.ts (dual push)
8. src/hooks/messages-transform.ts + tests
9. src/index.ts (register messages.transform)
10. Update existing tests for new signatures
11. npm run verify (typecheck + test + build + smoke)
12. Deploy to dm-test
13. E2E benchmark
```
