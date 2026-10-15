# V6 Optimization Plan — Community-Driven Feature Adoption

> Generated: 2026-08-12. Based on competitive research across 14 projects/papers.
> Architecture: V5 intact (zero-deps, markdown storage, BM25 search). V6 adds community-proven patterns on top.
> Review: 5 rounds (correctness, feasibility, completeness, value, risk) — all findings incorporated below.

## Research Base

| Project | Key Pattern | Our Gap |
|---------|-------------|---------|
| Claude Code (Anthropic) | Topic file architecture; write-time cap enforcement; CoT-then-strip; post-compact file re-injection | G1, G3, G4 |
| Mem0 (4K★) | Entity extraction + boosted retrieval; 4-op consolidation prompt (ADD/UPDATE/DELETE/NONE with IDs) | G2, G6 |
| Cursor (dynamic-context-discovery) | Output-to-file instead of hard truncation; history-as-files for recovery | G5 |
| DCP (4K★, our direct competitor) | Summary-size guard (#573); compress cooldown (#439); per-model nudge config | G11 |
| A-Mem (NeurIPS 2025) | Write-time neighbor check (k=5 dedup at store time, not idle); importance metadata | G8 |
| claudeclaw | Contradiction detection with timestamp direction correction | G7 |
| Focus Agent (arxiv 2601.07190) | Cadence prompting ("compress after closed subtasks"); structured summary schema | G10 |
| Headroom (headroomlabs-ai) | Proactive expansion (Context Tracker auto-restores relevant compressed content) | G9 |
| Claude-Code-Workflow | Quality criteria ("actionable", "no platitudes"); ruthless conciseness | Prompt design |
| OpenViking | No-op tolerance ("if nothing changes, return unchanged") | Prompt design |

**Not adopted (with reasons):**
- Cognee graph DB — requires database dependency, violates zero-deps
- Letta memory_apply_patch — unified diff editing overkill for 200-line files
- A-Mem importance_score — requires per-entry index granularity change (we're section-level)
- LLMLingua perplexity compression — arxiv 2604.02985 confirms no benefit for code
- Aider background thread — our sub-session + promptAsync is already async

---

## Release Plan

| Version | Theme | Community Patterns | Risk |
|---------|-------|-------------------|------|
| **v0.11.4** | Consolidation quality + anti-loop | G4, G6, G7, G11 + prompt design | Low |
| **v0.12.0** | Write-time dedup + cap enforcement + compression prompt | G8, G10 + Claude Code cap | Low |
| **v0.12.1** | Topic file architecture + entity search | G1, G2 | Medium |
| **v0.13.0** | Context compression: post-compact re-inject + output-to-file + search cache | G3, G5 | Low-Medium |

> **Note on proactive expansion (G9/Headroom):** Deferred to v0.14.0. Round 4 (value) ranked it lowest ROI (30 lines for uncertain gain), and Round 5 (risk) flagged high false-positive risk from keyword overlap. Will revisit after v0.13.0 ships.

---

## v0.11.4 — Consolidation Quality + Anti-Loop

### Patterns adopted: G4 (CoT-then-strip), G6 (structured per-entry decisions), G7 (contradiction detection), G10 (cadence hint), G11 (guard + cooldown)

### Problem
glm-5.2 consolidation made MEMORY.md longer, kept self-described placeholders, didn't merge anything. DCP's #573 issue documents the exact same failure at scale: 738K tokens burned because summary output was unbounded.

### #1 Prompt rewrite — `src/extract/consolidate.ts`

**Signature change:** `buildConsolidationPrompt(content: string)` → `buildConsolidationPrompt(content: string, stats: { lines: number; bytes: number })`

Update 2 call sites: `src/index.ts` L329, `src/hooks/compacting.ts` L228.

New prompt (community pattern sources in comments):
```typescript
export function buildConsolidationPrompt(
  content: string,
  stats: { lines: number; bytes: number },
): string {
  const targetLines = Math.round(stats.lines * 0.8);
  return `You are a memory consolidation agent. Below is the current MEMORY.md
(${stats.lines} lines, ${stats.bytes} bytes).

## YOUR JOB
Produce a LEANER, SHARPER version. If the memory is already well-organized,
return it UNCHANGED.                              ← OpenViking no-op tolerance

## CRITICAL RULES

1. ACTIONABLE: Every surviving entry must name a specific future scenario
   where it prevents a mistake or speeds up a decision. If you can't, DELETE it.
                                                   ← Claude-Code-Workflow Quality Criteria
2. NO PLATITUDES: Delete generic advice ("communicate clearly", "test
   thoroughly", "冥想 improves focus"). Keep only entries with specific
   technical details — file paths, function names, config values, errors.
                                                   ← Claude-Code-Workflow Quality Criteria
3. MERGE: Combine entries about the same topic. Two entries about HiDPI
   scaling → one. Two about Python version limits → one.
4. DELETE STALE: Remove entries that are:
   - Superseded by a newer entry (compare [YYYY-MM-DD] date tags — the
     LATER date is authoritative).               ← claudeclaw contradiction detection
   - Self-described as placeholder/dummy/sample/虚构/占位/example
   - About a resolved problem that will never recur
5. NEVER ADD: You are an editor, not a writer.   ← Mem0 "editor not writer"
   Zero new facts. Zero new decisions. Zero hallucination.
6. SHRINK: Target ${targetLines} lines (70-90% of current). Under 200 hard cap.
   If already under 150 lines and well-organized, return unchanged.
                                                   ← DCP #573 lesson: unbounded = disaster
7. WHEN UNCERTAIN between keeping and deleting, KEEP.
   False retention is cheap; false deletion is irreversible.
                                                   ← Balance: prevents over-aggressive pruning
8. FORMAT: ## Heading + bullets. Sections: Decisions, Constraints, Gotchas,
   Facts. Move superseded entries to ## Archive with a note.

## PROCESS                                        ← Claude Code CoT-then-strip
Step 1: For each entry, silently decide KEEP / MERGE / DELETE.
Step 2: Output ONLY the consolidated MEMORY.md content. Do NOT output
        your reasoning or decisions list.

Current MEMORY.md:
---
${content}
---`;
}
```

### #2 Output validation — new `validateConsolidation()` in `src/extract/consolidate.ts`

**Pattern:** DCP #573 summary-size guard + Round 5 risk #1 (over-deletion guard)

```typescript
export function validateConsolidation(
  original: string,
  result: string,
  originalStats: { lines: number },
): { ok: true } | { ok: false; reason: string } {
  if (result.trim().length === 0)
    return { ok: false, reason: "empty output" };
  if (result.length > original.length * 1.05)
    return { ok: false, reason: `output grew: ${result.length} > ${original.length} * 1.05` };
  const resultLines = result.split("\n").length;
  if (resultLines > 200)
    return { ok: false, reason: `${resultLines} lines exceeds 200-line cap` };
  // Over-deletion guard (Round 5 risk #1): reject if <30% of original survived.
  // A valid consolidation shrinks to 70-90%; anything below 30% is suspicious.
  const minExpectedLines = Math.round(originalStats.lines * 0.3);
  if (originalStats.lines > 20 && resultLines < minExpectedLines)
    return { ok: false, reason: `over-deleted: ${resultLines} < ${minExpectedLines} (30% of ${originalStats.lines})` };
  return { ok: true };
}
```

Called in **both** consume paths (`src/index.ts` L298-325, `src/hooks/compacting.ts` L162-200)
after getting LLM text part, before `writeFile(memPath, ...)`:

```typescript
const validation = validateConsolidation(content, part.text, { lines: memLines });
if (!validation.ok) {
  logger.warn("consolidation rejected", { reason: validation.reason });
  await showToast(client, `▣ deep-memory | consolidation rejected (${validation.reason})`, "warning");
  return; // pending already consumed; next idle will re-spawn with cooldown gate
}
```

> **Note:** `memLines` (line count of original MEMORY.md) is already computed at
> `src/index.ts` L275 (`const memLines = content.split("\n").length`) and at
> `src/hooks/compacting.ts` L218 (`const lineCount = content.split("\n").length`).
> No new computation needed.

### #3 Consolidation cooldown — `src/hooks/shared-state.ts`

**Pattern:** DCP #439 compress cooldown (prevents 20x re-compress loop)

```typescript
// Add to PluginState
private _lastConsolidationAttempt = 0;
private static readonly CONSOLIDATION_COOLDOWN_MS = 60_000;

canStartConsolidation(): boolean {
  return Date.now() - this._lastConsolidationAttempt > PluginState.CONSOLIDATION_COOLDOWN_MS;
}
recordConsolidationAttempt(): void {
  this._lastConsolidationAttempt = Date.now();
}
```

Guard in **both** spawn paths (`src/index.ts` before L331 spawn block, `src/hooks/compacting.ts` before L221 spawn block):

```typescript
if (!state.canStartConsolidation()) {
  logger.debug("consolidation: cooldown active, skipping");
  return;
}
state.recordConsolidationAttempt();
```

> **Cooldown scope note:** This cooldown gates *both* idle consolidation and
> compaction-triggered consolidation. The `/checkpoint` command is a separate
> path (agent-run, not LLM consolidation) and is NOT gated — confirmed by
> reading `.opencode/command/checkpoint.md` (uses SimHash dedup only, no
> `buildConsolidationPrompt` call).

### #4 Tests

| File | Tests to add |
|------|-------------|
| `tests/extract/consolidate.test.ts` | +5: validateConsolidation accepts valid shrink; rejects growth >1.05x; rejects empty; rejects >200 lines; rejects over-deletion (<30%) |
| `tests/hooks/consolidation-state.test.ts` | +2: cooldown blocks within 60s window; allows after window expires |
| `tests/hooks/model-override.test.ts` | Update: `buildConsolidationPrompt(content, stats)` new signature |

### v0.11.4 files touched

```
src/extract/consolidate.ts        — prompt rewrite + validateConsolidation export
src/hooks/shared-state.ts         — cooldown fields + methods (6 lines)
src/index.ts                      — validation call + cooldown guard + prompt call signature
src/hooks/compacting.ts           — validation call + cooldown guard + prompt call signature
tests/extract/consolidate.test.ts — 5 new tests
tests/hooks/consolidation-state.test.ts — 2 new tests
package.json                      — 0.11.4
```

---

## v0.12.0 — Write-Time Dedup + Cap Enforcement + Compression Prompt

### Patterns adopted: G8 (A-Mem write-time dedup), G10 (Focus Agent cadence), Claude Code write-time cap

> **Split from original v0.12.0 (Round 4 value review):** High-ROI features (#7 dedup, #8 cap, #9 prompt)
> ship first as v0.12.0. Higher-complexity features (#5 topic files, #6 entity) move to v0.12.1.

### #5 Write-time dedup — G8 (A-Mem) — `src/tools/memory-store.ts`

**Core idea:** When `memory_store` is called, compare the new entry against existing entries using SimHash. If similarity ≥ threshold, reject — don't let duplicates enter MEMORY.md.

**Prerequisite — export SimHash utilities** (Round 1 #4):
`src/extract/consolidate.ts` currently has `simHash`, `similarity`, `tokenize` as module-private.
Export them and add a `findNearDuplicate` helper:

```typescript
// Add to src/extract/consolidate.ts

export function findNearDuplicate(
  newLine: string,
  existingContent: string,
): { existingLine: string; similarity: number } | null {
  const newHash = simHash(newLine);
  const lines = existingContent.split("\n");
  for (const line of lines) {
    if (!line.startsWith("- [")) continue;
    const existingHash = simHash(line);
    const sim = similarity(newHash, existingHash);
    // Short-line guard (Round 5 risk #4): short lines need higher threshold
    const threshold = newLine.length < 50 ? 0.98 : SIMILARITY_THRESHOLD;
    if (sim >= threshold) {
      return { existingLine: line, similarity: sim };
    }
  }
  return null;
}
```

**Integration in `src/tools/memory-store.ts`** before `service.addEntry()`:

```typescript
// Read existing content for dedup check
const existingContent = existsSync(memoryPath) ? await readFile(memoryPath, "utf8") : "";
const newLine = `- [${args.type}] ${args.content} [${today}]`;
const dup = findNearDuplicate(newLine, existingContent);
if (dup) {
  return `Near-duplicate detected (similarity ${(dup.similarity * 100).toFixed(0)}%).
Existing: "${dup.existingLine.slice(0, 100)}..."
Not stored. Use memory_forget to remove the old entry first if it should be replaced.`;
}
```

> **Note:** `memoryPath` is already computed at L60. `today` is already computed at L56.
> Only new import: `findNearDuplicate` from consolidate.ts.

### #6 Write-time cap enforcement — Claude Code pattern — `src/tools/memory-store.ts`

**Current:** L59-65, if at cap → archive. Too soft.

**New:** Warn at 90% (preserving both `||` conditions — Round 1 #3):

```typescript
// Existing: const { lines, bytes } = await checkOverflow(memoryPath);

if (lines >= MEMORY_MAX_LINES || bytes >= MEMORY_MAX_BYTES) {
  await archiveEntry(memoryPath, `- ${contentWithDate}`);
  return `HARD CAP reached (${lines}/${MEMORY_MAX_LINES} lines, ${bytes}/${MEMORY_MAX_BYTES} bytes).
Entry archived to MEMORY-archive.md. Consolidation needed.`;
}

// NEW: 90% warning (still stores the entry)
if (lines >= MEMORY_MAX_LINES * 0.9 || bytes >= MEMORY_MAX_BYTES * 0.9) {
  await service.addEntry(args.scope, "memory", section, contentWithDate);
  state?.incrementMemoryStoreCount();
  return `WARNING: MEMORY.md at 90% cap (${lines}/${MEMORY_MAX_LINES} lines, ${bytes}/${MEMORY_MAX_BYTES} bytes).
Stored, but consolidation recommended soon. Run /checkpoint or wait for idle consolidation.`;
}

// Normal path (existing L67-70 continues here)
```

### #7 Compression prompt CoT-then-strip + cadence — G4 + G10 — `src/compress/compression-prompt.ts`

**Current state:** Already has a good structured schema (Goal / Decisions / Constraints / Progress / Errors / Current State). **Not replacing it** (Round 1 #6).

**Add two sections** to the existing prompt (before "Conversation to compress:"):

```typescript
// Append before the closing ---
`
## CADENCE GUIDANCE                          ← Focus Agent G10
Compress most aggressively after closed subtasks (completed work blocks).
Preserve detail for active/in-progress work — mid-iteration compression hurts.

## PROCESS                                   ← Claude Code CoT-then-strip G4
Think through what's important (your reasoning helps you produce a better summary),
but output ONLY the summary itself. Do not include your reasoning in the output.
`
```

### v0.12.0 tests

| File | Tests |
|------|-------|
| `tests/extract/consolidate.test.ts` | +3: findNearDuplicate detects exact dup, detects near-dup (≥0.92), rejects short-line false positive (threshold 0.98) |
| `tests/tools/memory-store-dedup.test.ts` | NEW: store exact duplicate → rejected; store unique → accepted; 90% cap → warning returned |

### v0.12.0 files touched

```
src/extract/consolidate.ts          — export findNearDuplicate + helpers
src/tools/memory-store.ts           — dedup check + 90% cap warning
src/compress/compression-prompt.ts  — CoT-then-strip + cadence guidance
tests/extract/consolidate.test.ts   — 3 new dedup tests
tests/tools/memory-store-dedup.test.ts — NEW
package.json                        — 0.12.0
```

---

## v0.12.1 — Topic File Architecture + Entity Search

### Patterns adopted: G1 (Claude Code topic files), G2 (Mem0 entity extraction)

### #8 Topic file architecture — G1 (Claude Code)

**Core idea:** MEMORY.md becomes an index (one line per entry). Detailed content lives in `topics/<name>.md`, loaded on demand. The 200-line cap becomes sustainable because detailed content isn't in MEMORY.md at all.

**New tool: `memory_topic`**
```typescript
// src/tools/memory-topic.ts
export function createMemoryTopicTool(projectPath: string) {
  return tool({
    description:
      "Read or write a topic detail file. Use when MEMORY.md has an entry " +
      "referencing [topic:name] and you need the full detail. " +
      "Also use to create new topic files when storing detailed knowledge.",
    args: {
      name: tool.schema.string().describe("Topic name (kebab-case, e.g. 'granian-migration')"),
      action: tool.schema.enum(["read", "write", "list"]).default("read"),
      content: tool.schema.string().optional().describe("Content to write (required for 'write')"),
    },
    async execute(args) {
      const topicsDir = path.join(projectPath, ".deep-memory", "topics");
      const filePath = path.join(topicsDir, `${args.name}.md`);

      if (args.action === "list") {
        try {
          const files = await readdir(topicsDir);
          const topics = files.filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, ""));
          return topics.length > 0 ? topics.join("\n") : "No topic files found.";
        } catch { return "No topics directory yet."; }
      }

      if (args.action === "read") {
        try {
          return await readFile(filePath, "utf8");
        } catch { return `Topic "${args.name}" not found.`; }
      }

      if (args.action === "write" && args.content) {
        await mkdir(topicsDir, { recursive: true });
        await writeFile(filePath, args.content, "utf8");
        return `Topic "${args.name}" saved. Reference in MEMORY.md as: [topic:${args.name}]`;
      }

      return `Invalid action or missing content.`;
    },
  });
}
```

**Tool hint registration** (Round 3 #10): Add `memory_topic` to the tool hint in
`src/inject/system-payload.ts` so the agent discovers it:
```
- memory_topic(name, action, content?): Read/write topic detail files. Use when MEMORY.md has [topic:name] references.
```

**Indexing topic files — BLOCKING FIX (Round 1 #1):**

The Reconciler's `walkMarkdown` (`src/search/reconcile.ts` L216-239) only scans
**direct children** of `.deep-memory/`. Topic files live in `.deep-memory/topics/`
—a subdirectory. They will NOT be indexed without a code change.

**Fix:** Add `topics/` to `enumerateAllMarkdown()` in `src/search/reconcile.ts`:

```typescript
// In enumerateAllMarkdown(), after the "project" case (L191-192):
case "project": {
  dir = projectMemoryDir(this.projectPath);
  const files = await this.walkMarkdown(dir, scope);
  // Also scan topics/ subdirectory
  const topicsDir = path.join(dir, "topics");
  if (existsSync(topicsDir)) {
    const topicFiles = await this.walkMarkdown(topicsDir, scope);
    files.push(...topicFiles);
  }
  return files;
}
```

> **Note:** The `walkMarkdown` function itself does NOT need to become recursive.
> We add one explicit subdirectory scan. This keeps the change minimal and avoids
> accidentally scanning `sessions/` or other directories.

**Consolidation prompt updated** to suggest offloading (add to v0.12.1 since
topic files land here):
```
When an entry is too detailed (more than 3 lines), extract the detail to a
topic file (topics/<descriptive-name>.md) and replace the entry with:
  - [brief summary] [topic:<descriptive-name>]
The agent can read the full detail via memory_topic("<descriptive-name>", "read").
```

### #9 Entity extraction + boosted retrieval — G2 (Mem0)

**Core idea:** When storing a new memory entry, extract entity tokens (file paths, function names, project names, version numbers). At search time, boost results matching entity tokens.

**Zero new dependencies** — uses regex + the existing BM25 index.

```typescript
// src/shared/entity-extract.ts
const ENTITY_PATTERNS = [
  /\b[A-Za-z][a-zA-Z0-9_]*\.(?:ts|js|py|go|rs|java|md)\b/g,  // File names: consolidate.ts
  /\b[a-z_][a-zA-Z0-9_]*\(\)/g,                                // Function calls: buildPrompt()
  /\b\d+\.\d+\.\d+\b/g,                                        // Version numbers: 3.6.8
  /\b[A-Z][a-zA-Z0-9_-]{2,}\b/g,                              // PascalCase: WLG5144, OpenShort
];

export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const pattern of ENTITY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // Filter stopwords (Round 5 risk #3)
      if (match[0].length < 3) continue;
      entities.add(match[0].toLowerCase());
    }
  }
  return [...entities];
}
```

**Integration at the TOOL level** (Round 1 #3 — NOT in `addEntry`):

```typescript
// src/tools/memory-store.ts — after successful addEntry, before return:
const entities = extractEntities(args.content);
if (entities.length > 0) {
  await appendEntitySidecar(projectPath, { section, entities });
}
```

Sidecar format: `.deep-memory/.entities.json`:
```json
[
  { "section": "Decisions", "entities": ["wlg5144", "consolidate.ts", "3.6.8"] }
]
```

**Search boost in `src/search/service.ts`** — after BM25 returns raw results:

```typescript
// After rawResults, before building final results:
const queryEntities = new Set(extractEntities(query.toLowerCase()));
if (queryEntities.size > 0) {
  const entityMap = await loadEntitySidecar(this.projectPath); // cached
  for (const raw of rawResults) {
    const parsed = this.parseDocId(raw.docId);
    if (parsed && entityMap[parsed.heading]?.some(e => queryEntities.has(e))) {
      raw.score *= 1.5; // Mem0 ENTITY_BOOST_WEIGHT pattern
    }
  }
  // Re-sort after boost
  rawResults.sort((a, b) => b.score - a.score);
}
```

### v0.12.1 tests

| File | Tests |
|------|-------|
| `tests/shared/entity-extract.test.ts` | NEW: file names extracted, function names extracted, versions extracted, stopwords filtered |
| `tests/tools/memory-topic.test.ts` | NEW: write + read round-trip; list returns topics; read missing topic returns message |
| `tests/search/entity-boost.test.ts` | NEW: entity-matching result scores higher than non-matching |

### v0.12.1 files touched

```
src/tools/memory-topic.ts           — NEW: topic file tool (G1)
src/shared/entity-extract.ts        — NEW: entity extraction (G2)
src/shared/entity-store.ts          — NEW: entity sidecar read/write
src/search/reconcile.ts             — add topics/ subdirectory scan (BLOCKING FIX)
src/search/service.ts               — entity-boosted search re-rank
src/tools/memory-store.ts           — entity extraction on store
src/extract/consolidate.ts          — prompt: topic offload suggestion
src/inject/system-payload.ts        — register memory_topic in tool hint
src/tools/index.ts                  — register memory_topic tool
tests/shared/entity-extract.test.ts — NEW
tests/tools/memory-topic.test.ts    — NEW
tests/search/entity-boost.test.ts   — NEW
package.json                        — 0.12.1
```

---

## v0.13.0 — Context Compression Upgrades

### Patterns adopted: G3 (post-compact file re-injection), G5 (Cursor output-to-file)

### #10 Post-compact file re-injection — G3 (Claude Code)

**Core idea:** After compaction, re-inject the last 5 read code files (≤5K each) so the agent doesn't "forget" what it was working on.

**Existing infrastructure:** `RepoMapTracker` (`src/repomap/tracker.ts` L45) already has `getRecentlyRead(limit)`.

**Integration point:** `src/hooks/compacting.ts` — after `output.context.push(HANDOFF_PREFIX)` (L258):

```typescript
// Post-compact: re-inject recently read code files (Claude Code G3 pattern)
const recentFiles = tracker?.getRecentlyRead(5) ?? [];
for (const tracked of recentFiles) {
  try {
    const content = await readFile(tracked.path, "utf8");
    const capped = content.length > 5000
      ? content.slice(0, 5000) + `\n[... file truncated at 5K, full size ${content.length}]`
      : content;
    output.context.push(`[post-compact context: ${tracked.path}]\n${capped}`);
  } catch {
    // File may have been deleted — skip silently
  }
}
```

> **Constraint:** `RepoMapTracker.recordRead()` filters by `getLanguage()` (L25-26),
> so only code files are tracked. Non-code files (logs, configs) won't be re-injected.
> This is intentional — code context matters more post-compact.

### #11 Long output → file — G5 (Cursor dynamic-context-discovery)

**Core idea:** Instead of hard-truncating long tool outputs (current: head 10 + tail 10 lines), write the FULL output to a file AND leave a searchable pointer inline. Dual recovery: `deep_expand(hash)` (in-memory CCR) or `read(filepath)` (persistent file).

**Implementation location confirmed** (Round 1 correctness check):
`src/hooks/messages-transform.ts` L216-224 (`decision === "transient"` block) sees
the FULL output before truncation — correct insertion point.

**Prerequisite — pass `projectPath` to messages-transform** (Round 2 #5):

Current handler signature: `createMessagesTransformHandler(state, client, logger)`.
Needs `projectPath` for the `.tool-outputs/` path.

```typescript
// src/index.ts L228 — update registration:
"experimental.chat.messages.transform": createMessagesTransformHandler(
  state,
  input.client,
  projectPath,  // ← ADD THIS
  logger.for("messages-transform"),
),

// src/hooks/messages-transform.ts — update signature:
export function createMessagesTransformHandler(
  state: PluginState,
  client: unknown,
  projectPath: string,  // ← ADD THIS
  logger?: Logger,
) { ... }
```

**Replace transient block** (L216-224):

```typescript
if (decision === "transient") {
  const lines = output.split("\n");
  if (lines.length < 20) continue;

  // Cursor G5: write full output to file, leave searchable pointer inline
  const outputDir = path.join(projectMemoryDir(projectPath), ".tool-outputs");
  await mkdir(outputDir, { recursive: true });
  const outputHash = createHash("sha256").update(output).digest("hex").slice(0, 12);
  const outputFilePath = path.join(outputDir, `${toolName}-${outputHash}.txt`);
  await writeFile(outputFilePath, output, "utf8");

  const capped = lines.slice(0, 10).join("\n") +
    `\n[... ${lines.length - 20} lines omitted. Full output: ${outputFilePath}\n` +
    `Use read or grep on that path to access. deep_expand("${hash}") also works.]\n` +
    lines.slice(-10).join("\n");

  const { ccrStore, ccrInjectMarker } = await import("../compress/ccr.js");
  const hash = ccrStore(state, output, capped, toolName);
  toolState["output"] = ccrInjectMarker(capped, hash);
  compressed++;
}
```

**Disk cleanup** (Round 5 risk #2): `.tool-outputs/*.txt` files accumulate.
Add cleanup to the idle consolidation handler — after consolidation completes:

```typescript
// src/index.ts — at end of handleIdleConsolidation, after all consolidation logic:
try {
  const outputDir = path.join(projectMemoryDir(projectPath), ".tool-outputs");
  if (existsSyncSync(outputDir)) {
    const files = await readdir(outputDir);
    const now = Date.now();
    for (const f of files) {
      const filePath = path.join(outputDir, f);
      const stat = await stat(filePath);
      if (now - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000) { // 7 days
        await unlink(filePath);
      }
    }
  }
} catch {
  // Cleanup is best-effort — don't fail consolidation over it
}
```

### #12 Search result cache — performance

**Pattern:** Standard result caching keyed by `(query, scope, limit, applyDecay, memoryMtime)`.

**Global mtime fix** (Round 3 #11): cache must invalidate when EITHER project
or global MEMORY.md changes:

```typescript
// src/search/service.ts
private _searchCache = new Map<string, { results: SearchResult[]; mtime: number }>();
private static readonly SEARCH_CACHE_MAX = 50;

private getSearchCacheMtime(): number {
  // Take max of project and global MEMORY.md mtimes (Round 3 #11)
  let mtime = 0;
  try {
    const projStat = statSync(this.projectMemoryPath);
    mtime = Math.max(mtime, projStat.mtimeMs);
  } catch {}
  try {
    const globalStat = statSync(this.globalMemoryPath);
    mtime = Math.max(mtime, globalStat.mtimeMs);
  } catch {}
  return mtime;
}

async search(query, opts) {
  const scope = opts?.scope ?? "all";
  const limit = opts?.limit ?? 5;
  const applyDecay = opts?.applyDecay ?? false;
  const memMtime = this.getSearchCacheMtime();
  const cacheKey = `${query}::${scope}::${limit}::${applyDecay}`; // applyDecay in key (Round 1 #4)

  const cached = this._searchCache.get(cacheKey);
  if (cached && cached.mtime === memMtime) return cached.results;

  // ... existing search logic ...

  // LRU eviction
  if (this._searchCache.size >= SearchService.SEARCH_CACHE_MAX) {
    const oldestKey = this._searchCache.keys().next().value;
    if (oldestKey) this._searchCache.delete(oldestKey);
  }
  this._searchCache.set(cacheKey, { results, mtime: memMtime });
  return results;
}
```

### v0.13.0 tests

| File | Tests |
|------|-------|
| `tests/hooks/compacting.test.ts` | +1: post-compact context contains recently read file content |
| `tests/hooks/messages-transform.test.ts` | +2: long output → file created + inline pointer; file content matches original |
| `tests/search/search-cache.test.ts` | NEW: repeated query returns cached; MEMORY.md change invalidates cache |

### v0.13.0 files touched

```
src/hooks/compacting.ts            — post-compact file re-injection (G3)
src/hooks/messages-transform.ts    — output-to-file (G5) + signature change
src/index.ts                       — pass projectPath to messages-transform + .tool-outputs cleanup
src/search/service.ts              — search result cache with global mtime
src/shared/paths.ts                — toolOutputDir() helper
tests/hooks/compacting.test.ts     — +1 test
tests/hooks/messages-transform.test.ts — +2 tests
tests/search/search-cache.test.ts  — NEW
package.json                       — 0.13.0
```

---

## Deferred to v0.14.0

### Proactive expansion — G9 (Headroom)

**Why deferred:** Round 4 (value) ranked it lowest ROI. Round 5 (risk) flagged
high false-positive risk from keyword overlap on common words.

**Prerequisites when revisiting:**
- Add `ccrEntries(): IterableIterator<CCRCacheEntry>` to PluginState (Round 1 #2)
- Implement stopword-filtered Jaccard similarity (not raw keyword overlap)
- Add throttle: `_lastProactiveCheck` timestamp, ≥3s between checks (Round 3 #8)
- Threshold: 0.4+ (not 0.3) to reduce false positives (Round 5 risk #3)
- Log all auto-restorations for tuning

---

## Dependency Graph (revised)

```
v0.11.4 (standalone)         v0.12.0 (standalone)         v0.12.1 (standalone)
┌──────────────────┐         ┌──────────────────┐         ┌────────────────────┐
│ #1 Prompt rewrite│         │ #5 Write-time    │         │ #8 Topic files(G1) │
│ #2 Validation    │         │    dedup (G8)    │         │ #9 Entity (G2)     │
│ #3 Cooldown      │         │ #6 Cap enforce   │         │    + walkMarkdown  │
│ #4 Tests         │         │ #7 Compress prompt│        │      fix           │
└──────────────────┘         │ Tests            │         │ Tests              │
                              └──────────────────┘         └────────────────────┘

v0.13.0 (standalone)
┌────────────────────────────────────┐
│ #10 Post-compact re-inject (G3)    │
│ #11 Output-to-file (G5)            │
│ #12 Search cache                   │
│ Tests                              │
└────────────────────────────────────┘

v0.14.0 (deferred)
┌────────────────────────────────────┐
│ Proactive expansion (G9/Headroom)  │
│   requires: ccrEntries() iterator  │
│   requires: stopword Jaccard       │
└────────────────────────────────────┘
```

**All four releases are independently shippable. No cross-version dependencies.**

---

## Review Findings Tracker

All findings from the 5-round review, their status, and where they're addressed:

| Round | Finding | Severity | Status | Addressed in |
|-------|---------|----------|--------|-------------|
| R1 #1 | walkMarkdown not recursive — topic files not indexed | BLOCKING | ✅ Fixed | v0.12.1 #8: add `topics/` scan to `enumerateAllMarkdown` |
| R1 #2 | CCR cache no iterator — proactive expansion blocked | BLOCKING | ✅ Deferred | v0.14.0 prerequisites |
| R1 #3 | Entity extraction at wrong layer (service not tool) | FIX | ✅ Fixed | v0.12.1 #9: extraction in `memory-store.ts` |
| R1 #4 | SimHash functions not exported | FIX | ✅ Fixed | v0.12.0 #5: export from consolidate.ts |
| R1 #5 | messages-transform missing projectPath | FIX | ✅ Fixed | v0.13.0 #11: signature change |
| R1 #6 | #9 structured summary replaces existing good schema | FIX | ✅ Fixed | v0.12.0 #7: additive, not replacement |
| R2 #1 | Zero-deps constraint check | PASS | ✅ | All features use node: builtins only |
| R2 #2 | Architecture match | PASS | ✅ | All new tools follow existing pattern() |
| R3 #1 | Topic file cleanup when LLM doesn't create | NICE | ✅ Noted | Soft convention — agent creates on demand |
| R3 #2 | SimHash short-line false positive | FIX | ✅ Fixed | v0.12.0 #5: 0.98 threshold for <50 chars |
| R3 #3 | Proactive expansion throttle | FIX | ✅ Deferred | v0.14.0 prerequisites |
| R3 #4 | Cap enforcement return value change | PASS | ✅ | "Stored" in return = backward compatible |
| R3 #5 | memory_topic tool hint registration | NICE | ✅ Fixed | v0.12.1 #8: system-payload.ts update |
| R3 #6 | Search cache missing global mtime | FIX | ✅ Fixed | v0.13.0 #12: max(projectMtime, globalMtime) |
| R4 #1 | v0.12.0 should split (ROI ranking) | FIX | ✅ Fixed | Split into v0.12.0 + v0.12.1 |
| R4 #2 | Proactive expansion lowest ROI | FIX | ✅ Deferred | Moved to v0.14.0 |
| R5 #1 | Prompt over-deletion risk (weak models) | FIX | ✅ Fixed | v0.11.4 #2: over-deletion guard (<30% reject) |
| R5 #2 | .tool-outputs/ disk growth | FIX | ✅ Fixed | v0.13.0 #11: 7-day cleanup in idle handler |
| R5 #3 | Proactive expansion false positives | FIX | ✅ Deferred | v0.14.0: stopword filter + 0.4 threshold |
| R5 #4 | Write-time dedup short-line false positive | FIX | ✅ Fixed | v0.12.0 #5: 0.98 threshold for short lines |

---

## Performance Impact (revised)

| Feature | Token savings | Latency impact | Complexity |
|---------|--------------|----------------|------------|
| #2 Validation + over-deletion guard | ~2K tokens/bad consolidation | saves ~5s/avoided spawn | 15 lines |
| #3 Cooldown | ~2K tokens/avoided re-spawn | saves ~5s | 8 lines |
| #5 Write-time dedup | prevents unbounded MEMORY.md growth | +0.5ms/store (SimHash) | 20 lines |
| #6 90% cap warning | prevents cap overflow | 0 | 8 lines |
| #8 Topic files | MEMORY.md shrinks 50-70% | ~0 (on-demand read) | new tool + 5 lines reconcile |
| #9 Entity boost | 0 (same tokens, better ranking) | +0.1ms/search (re-rank) | new module + sidecar |
| #10 Post-compact | saves ~5K tokens (no re-read) | +~200ms (file reads) | 10 lines |
| #11 Output-to-file | 0 token loss vs truncation | ~0 (async write) | 12 lines |
| #12 Search cache | 0 | ~5ms saved on cache hit | 15 lines |

---

## Verification Per Release

### v0.11.4
- [ ] `npm run verify` passes (typecheck + test + build + smoke + e2e)
- [ ] validateConsolidation tests: accepts valid shrink; rejects >1.05x growth; rejects empty; rejects >200 lines; rejects over-deletion (<30%)
- [ ] Cooldown tests: blocks within 60s, allows after expiry
- [ ] Manual: run consolidation on real MEMORY.md, verify output ≤ input × 1.05
- [ ] Acceptance: output retains all entries with [YYYY-MM-DD] dates from last 7 days

### v0.12.0
- [ ] `npm run verify` passes
- [ ] findNearDuplicate: exact dup detected; near-dup (≥0.92) detected; short-line false positive avoided (0.98)
- [ ] Write-time dedup: exact duplicate → rejected; unique entry → accepted
- [ ] 90% cap: warning returned, entry still stored
- [ ] Compression prompt: CoT-then-strip instruction present

### v0.12.1
- [ ] `npm run verify` passes
- [ ] Entity extraction: file names, function names, versions extracted; stopwords filtered
- [ ] Topic files: memory_topic write + read + list works
- [ ] **Topic files indexed by BM25** (BLOCKING FIX verification): create `topics/test.md`, `memory_search("test topic")` finds it
- [ ] Entity boost: entity-matching result scores higher than non-matching

### v0.13.0
- [ ] `npm run verify` passes
- [ ] Post-compact: 5 most recent code files re-injected (≤5K each)
- [ ] Output-to-file: long output → file created in `.tool-outputs/`, inline pointer present, file content matches original
- [ ] Search cache: repeated query returns cached; invalidates on MEMORY.md change (project AND global)
- [ ] `.tool-outputs/` cleanup: 8-day-old files removed during idle consolidation
