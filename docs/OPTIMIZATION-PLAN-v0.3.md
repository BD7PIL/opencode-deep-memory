# opencode-deep-memory v0.3 Optimization Plan

> 12 optimizations across 3 batches, building on v0.2 (292 tests, 48 smoke, 17 E2E).

## Design Principles
- **Zero runtime dependencies** (no tree-sitter, no web-tree-sitter, no native addons)
- **Regex-based symbol extraction** (~80% accuracy, <1ms/file, covers 8+ languages)
- **Never break existing functionality** (all 292 tests must still pass)
- **Every optimization has unit tests + smoke checks + benchmark verification**

---

## Batch H: Safety + Defensive Performance (C1, A3, O21-O23)

### C1: Keep-first-N Preservation
**Source**: OpenHands LLMSummarizingCondenser pattern
**Problem**: Content stripping might neutralize system prompt or first user message
**Solution**: Add `PROTECTED_HEAD` guard in `messages-transform.ts`

```
const PROTECTED_HEAD = 3; // system prompt + first user + first assistant
if (messages.length <= KEEP_RECENT + PROTECTED_HEAD) return;
for (i = 0; i < PROTECTED_HEAD; i++) continue; // never touch first 3 messages
```

**Files**: `src/hooks/messages-transform.ts` (add guard)
**Tests**: unit (messages with <5 items → no stripping), unit (first 3 messages preserved)
**Time**: 1h

### A3: Synthetic Tool Result Injection
**Source**: Roo Code `injectSyntheticToolResults()`
**Problem**: When we strip old tool parts, `tool_use` blocks lose their `tool_result` pairs → API error "tool_use without tool_result"
**Solution**: After stripping, scan for orphaned tool_use parts and inject synthetic results

```
for each message:
  if message has tool_use but no matching tool_result:
    inject synthetic tool_result: "[context-stripped]"
```

**Files**: `src/hooks/messages-transform.ts` (add `repairOrphanedToolCalls()`)
**Tests**: unit (create messages with tool_use, strip the result, verify repair)
**Time**: 3h

### O21: BM25 LRU Query Cache
**Problem**: 5000 docs search p99=27.58ms
**Solution**: Cache search results by query token hash

```typescript
private queryCache = new Map<string, SearchResult[]>();
private static CACHE_SIZE = 50;

search(queryTokens): SearchResult[] {
  const key = queryTokens.sort().join("|");
  const cached = this.queryCache.get(key);
  if (cached) return cached;
  const results = this._search(queryTokens);
  if (this.queryCache.size >= CACHE_SIZE) {
    // Evict oldest (first entry)
    const firstKey = this.queryCache.keys().next().value;
    this.queryCache.delete(firstKey);
  }
  this.queryCache.set(key, results);
  return results;
}

// Invalidate on any doc change
addDocument() { this.queryCache.clear(); }
removeDocument() { this.queryCache.clear(); }
```

**Files**: `src/search/bm25.ts`
**Tests**: unit (cache hit/miss, eviction, invalidation)
**Time**: 1h

### O22: Two-Phase Tier-First Allocation
**Problem**: Greedy P1-first allocation wastes budget on few entries
**Solution**: Render ALL entries at minimum tier first, then upgrade

```
Phase 1: Render all entries at P4 (15t each)
  if totalP4 > budget: select top-N by importance, drop rest
Phase 2: With remaining budget, upgrade highest-importance entries
  P4→P3 (+10t), P3→P2 (+35t), P2→P1 (+140t)
  Greedily upgrade highest importance first
```

**Files**: `src/inject/tier-allocator.ts` (rewrite allocation loop)
**Tests**: unit (200 entries 200t budget → >9 shown, multiple tiers), benchmark
**Time**: 3h

### O23: Dedup Inverted Index
**Problem**: O(n²) Jaccard comparison
**Solution**: Build token→entryIndex map, only compare overlapping entries

```typescript
function dedupInverted(entries: Entry[]): Entry[] {
  const inverted = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const token of tokenize(e.content)) {
      if (!inverted.has(token)) inverted.set(token, []);
      inverted.get(token)!.push(i);
    }
  });
  // Only compare entries sharing tokens
  const compared = new Set<string>();
  for (const [_, indices] of inverted) {
    for (i, j in indices × indices) {
      if (i >= j) continue;
      const key = `${i}-${j}`;
      if (compared.has(key)) continue;
      compared.add(key);
      if (jaccard(entries[i], entries[j]) > 0.85) markDuplicate(j);
    }
  }
}
```

**Files**: `src/inject/dedup.ts`
**Tests**: unit (500 items → <100 comparisons instead of 125K), benchmark
**Time**: 2h

### Batch H Total: 10h
**Deliverable**: All safety guards + performance optimizations
**Verification**: 292+ existing tests + ~15 new tests + smoke updates + benchmark

---

## Batch I: Code Structure Awareness (A1 + A2)

### A1: Repo Map (Regex-Based Symbol Extraction + Ranking)

**Problem**: Agent has zero awareness of codebase structure. Can't answer "what functions exist in this project?"

**Solution**: Track files read by agent, extract symbols via regex, rank by recency+frequency, inject top-N into system prompt

**Architecture**:
```
src/repomap/
├── extractor.ts        # Regex patterns per language
├── tracker.ts          # Track files read (via tool.execute.after hook)
├── ranker.ts           # Rank symbols (recency × frequency × references)
└── injector.ts         # Budgeted symbol list → system prompt
```

**extractor.ts** — Symbol extraction for 8 languages:
```typescript
const PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,        // function foo
    /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g,         // class Foo
    /(?:export\s+)?const\s+(\w+)\s*=/g,                      // const foo =
    /(?:export\s+)?type\s+(\w+)\s*=/g,                       // type Foo =
    /(?:export\s+)?interface\s+(\w+)/g,                      // interface Foo
    /(?:export\s+)?enum\s+(\w+)/g,                            // enum Foo
  ],
  python: [
    /def\s+(\w+)/g,                    // def foo
    /class\s+(\w+)/g,                  // class Foo
    /(\w+)\s*=\s*(?!.*def\b)/g,        // FOO = ... (constants)
  ],
  go: [
    /func\s+(?:\([^)]+\)\s+)?(\w+)/g,  // func foo or func (r) foo
    /type\s+(\w+)\s+(?:struct|interface)/g,
    /var\s+(\w+)/g,
  ],
  rust: [
    /(?:pub\s+)?fn\s+(\w+)/g,
    /(?:pub\s+)?struct\s+(\w+)/g,
    /(?:pub\s+)?enum\s+(\w+)/g,
    /(?:pub\s+)?trait\s+(\w+)/g,
  ],
  java: [
    /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?class\s+(\w+)/g,
    /(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:void|\w+)\s+(\w+)\s*\(/g,
    /interface\s+(\w+)/g,
  ],
  // c, cpp, ruby, etc.
};
```

**tracker.ts** — Uses `tool.execute.after` hook:
```typescript
// On read tool completion:
tool.execute.after = (input, output) => {
  if (input.tool !== "read") return;
  const filePath = input.args.path;
  if (!filePath || !filePath.endsWith(supportedExtension)) return;
  const symbols = extractSymbols(filePath, output.output);
  tracker.add(filePath, symbols);
};
```

**ranker.ts** — Symbol importance scoring:
```typescript
function rankSymbol(sym: Symbol, tracker: Tracker): number {
  let score = 0;
  score += RECENCY_WEIGHT * recencyDecay(sym.lastSeen);  // 0-1
  score += FREQUENCY_WEIGHT * Math.log(1 + sym.readCount); // 0-5
  score += REFERENCE_WEIGHT * sym.referencedBy;           // 0-10
  // C2: Aider-style multipliers
  if (sym.name.startsWith("_")) score *= 0.1;             // private
  if (sym.name.length >= 8) score *= 1.5;                 // business logic
  if (tracker.isCommon(sym.name)) score *= 0.3;           // generic utility
  return score;
}
```

**injector.ts** — Budgeted injection (uses existing tier-allocator):
```
budget = 300 tokens (from main budget allocation)
symbols = ranker.topN(budget / avgTokensPerSymbol)
format = "src/auth.ts: login(), logout(), validateToken()\nsrc/db.ts: connect(), query()"
inject as <deep-memory-repomap> in volatile suffix
```

**Files**: 4 new files in `src/repomap/`, modify `src/index.ts` (add tool.execute.after), modify `src/inject/system-payload.ts`
**Tests**: unit (extraction per language), unit (ranking), smoke (file read → symbol tracked), benchmark
**Time**: 10h (reduced from 12h due to regex approach)

### A2: Folded File Context (Post-Compaction Symbol Recovery)

**Problem**: When session compacts, agent loses all awareness of code it was working on

**Solution**: In compacting hook, extract symbols from files read during session, include in checkpoint.md

**Architecture**:
```
// In compacting hook, AFTER captureMessages + extractHeuristics:
const recentlyReadFiles = tracker.getRecentlyRead(10); // last 10 files
const foldedContext = recentlyReadFiles.map(f => 
  `${f.path}:\n  ${f.symbols.map(s => s.name).join(", ")}`
).join("\n");

// Append to checkpoint.md:
appendSection(checkpoint.md, "## Folded File Context", foldedContext);
```

**Files**: `src/extract/checkpoint-writer.ts` (add section), `src/hooks/compacting.ts` (call repomap tracker)
**Tests**: unit (checkpoint includes folded context), smoke
**Time**: 4h (builds on A1's tracker)

### Batch I Total: 14h
**Deliverable**: Code structure awareness + post-compaction recovery
**Verification**: unit tests per language + E2E (read file → symbol in injection → compact → checkpoint has symbols)

---

## Batch J: Quality Improvements (B2, B3, C2)

### B2: ctx-expand Decompression Tool
**Source**: Magic Context `ctx-expand`
**Problem**: Agent can't "zoom in" on compressed content. Once stripped, it's gone.
**Solution**: New tool `memory_expand` that retrieves original content from checkpoint.raw.json

```typescript
tool({
  description: "Expand compressed context — retrieve original content of a message that was stripped by the memory plugin",
  args: {
    sessionID: { type: "string", description: "Current session ID" },
    messageID: { type: "string", description: "Message ID to expand (from checkpoint or context)" },
  },
  execute: async (args) => {
    // 1. Read checkpoint.raw.json
    // 2. Find message by ID
    // 3. Return full original content (text, reasoning, tool output)
  }
})
```

**Files**: `src/tools/memory-expand.ts`, modify `src/tools/index.ts`
**Tests**: unit (expand returns original content), smoke
**Time**: 4h

### B3: Dream Key-Files Verification
**Source**: Magic Context Dreamer agent
**Problem**: Dream may store memories about code that has since changed
**Solution**: Dream prompt includes instruction to verify memories against actual files

```typescript
// In DREAM_PROMPT_TEMPLATE, add:
`
VERIFICATION STEP (before storing):
For each memory that references a specific file:
1. Use the read tool to check the file still exists
2. If the referenced function/class/variable no longer exists, mark it as STALE
3. Call memory_forget for stale entries
4. Only store verified memories
`
```

**Files**: `src/schedule/dream-executor.ts` (update prompt), `src/schedule/distill-executor.ts` (same)
**Tests**: unit (prompt contains verification instructions), E2E
**Time**: 4h

### C2: Aider-Style Weighted Ranking Multipliers
**Source**: Aider repomap.py edge weights
**Problem**: Our importance scoring treats all symbols equally
**Solution**: Apply multipliers based on symbol characteristics

Already partially implemented in A1 ranker.ts. Separate task for MEMORY.md entries:

```typescript
// In importance scoring:
if (entry.content.includes("private") || entry.content.startsWith("_")) {
  score *= 0.5;  // demote private/internal
}
if (entry.content.length > 50) {
  score *= 1.3;  // promote detailed entries (like Aider's long identifier boost)
}
if (isCommonWord(entry.heading)) {
  score *= 0.3;  // demote generic entries
}
```

**Files**: `src/inject/importance.ts`
**Tests**: unit (multipliers applied correctly), benchmark
**Time**: 2h

### Batch J Total: 10h
**Deliverable**: Decompression tool + dream verification + ranking refinement
**Verification**: unit + E2E (store memory → modify file → dream → stale memory removed)

---

## Implementation Order

```
Phase 1: Batch H (Safety + Performance)     [10h]
  ├── H1: C1 + A3 (messages-transform guards)  [4h]  — parallel
  ├── H2: O21 (BM25 cache)                     [1h]  — parallel
  └── H3: O22 + O23 (tier + dedup)             [5h]  — parallel
  → verify: 292+ tests + new tests + smoke + benchmark

Phase 2: Batch I (Code Structure)            [14h]
  ├── I1: extractor.ts (regex patterns)        [3h]
  ├── I2: tracker.ts (tool.execute.after)      [2h]
  ├── I3: ranker.ts + injector.ts              [3h]
  ├── I4: A2 folded context                    [4h]
  └── I5: integration + tests                  [2h]
  → verify: unit per language + E2E (read → inject → compact → checkpoint)

Phase 3: Batch J (Quality)                   [10h]
  ├── J1: B2 ctx-expand tool                   [4h]  — parallel
  ├── J2: B3 dream verification                [4h]  — parallel
  └── J3: C2 ranking multipliers               [2h]  — parallel
  → verify: unit + E2E (store → modify → dream → forget stale)

Total: 34h → 3 batches, each independently deployable
```

## Test Strategy Per Batch

| Batch | Unit Tests | Smoke | Benchmark | E2E |
|-------|-----------|-------|-----------|-----|
| H | ~15 new (guards, cache, tier, dedup) | +5 checks (orphaned tool repair, cache stats) | O21 p99 < 15ms @ 5000 docs, O22 >20 entries @ 200t | 30-round conversation, verify no API errors |
| I | ~20 new (8 languages × extraction, ranking, injection) | +5 checks (read file → symbol tracked, compact → folded context) | Extraction <1ms/file, 100 files <100ms | Read 5 files → symbols in injection → compact → checkpoint has symbols |
| J | ~10 new (expand tool, dream prompt, multipliers) | +3 checks (expand tool registered, dream has verification) | — | Store memory → modify file → dream → stale removed |

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| Regex extraction misses symbols | Medium | Low (ranking still works with partial data) | Conservative patterns, log misses |
| tool.execute.after hook not available | Low | High (A1+A2 blocked) | Verify hook exists in plugin SDK |
| Orphaned tool repair breaks valid chains | Low | High (API errors) | Only repair when stripping actually happened |
| LRU cache stale after addDocument | Low | Low (slightly wrong search results) | Clear cache on every write |
| Tier-first allocation overshoots budget | Medium | Low (slightly over budget) | Binary search fine-tune |
| Dream verification reads too many files | Medium | Medium (slow dream) | Limit to 5 files per verification cycle |
