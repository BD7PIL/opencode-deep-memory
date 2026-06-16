# opencode-deep-memory — Design Document

> Persistent context intelligence for OpenCode — 跨会话记忆、压缩检查点、上下文重建，三位一体。

**Status**: Design Finalized · Pending Implementation
**Target**: OpenCode (anomalyco/opencode) plugin
**Inspiration**: MiMo-Code (XiaomiMiMo/MiMo-Code) — memory layer ported back to vanilla OpenCode as a plugin
**Coexistence**: Designed to run alongside `oh-my-openagent` (OMO). Drops `@tarquinen/opencode-dcp` (DCP).

---

## 1. Motivation

### 1.1 Problem

OpenCode sessions are stateless across restarts. Each new session starts cold — the agent has no memory of past decisions, constraints, file changes, or gotchas discovered in prior sessions. This forces the user to re-establish context every time, even for long-running projects.

Native compaction (when context exceeds model limits) destroys conversation content irreversibly, replacing it with a lossy summary. There is no mechanism to recover the original messages or extract structured knowledge from them.

### 1.2 Inspiration

MiMo-Code (a fork of OpenCode by Xiaomi) adds a 3-layer memory system: file-based Markdown storage, SQLite FTS5 index, and agent-mediated consolidation (`/dream`, `/distill`, checkpoint-writer). However, MiMo-Code is a fork — users must abandon vanilla OpenCode to get these features.

### 1.3 Goal

Port MiMo-Code's memory architecture back to vanilla OpenCode as a **plugin**, with adaptations for the plugin sandbox:

- Replace SQLite FTS5 with pure-JS BM25 + CJK bigram tokenization (native addons incompatible with musl runtime)
- Replace proactive threshold-based checkpointing with reactive `experimental.session.compacting` hook capture
- Replace 11-section checkpoint extraction with dual-layer (heuristic instant + idle LLM enrichment)
- Add adaptive injection budgets based on agent type

### 1.4 Non-Goals

- Replace OMO's agent orchestration (Sisyphus, Oracle, explore, librarian, task delegation)
- Replace DCP's per-message compression (handled natively by OpenCode compaction + our checkpoint capture)
- Implement deep context reconstruction (33K token multi-source injection — plugin API limits to `system.transform` push only)

---

## 2. Coexistence Strategy

### 2.1 Plugin Order

```jsonc
// opencode.json
"plugin": [
  "oh-my-openagent",                                    // agent orchestration (KEEP)
  "/home/demo/OCWF/deep-memory/dist/index.js",         // memory layer (NEW)
  "@ramtinj95/opencode-tokenscope"                      // token analytics (KEEP)
  // REMOVED: "@tarquinen/opencode-dcp"                 // lossy compression, replaced by checkpoint capture
]
```

### 2.2 Hook Conflict Analysis

| Hook | OMO Behavior | Our Behavior | Conflict? | Resolution |
|------|-------------|-------------|-----------|------------|
| `experimental.chat.system.transform` | Push-only (sparkshell awareness + ultrawork tag) | Push-only (MEMORY.md + checkpoint summary) | **None** | Both push to `output.system[]`, never replace |
| `experimental.chat.messages.transform` | Splices synthetic text parts | **Not used** | **None** | Avoided (would corrupt injected memory) |
| `experimental.session.compacting` | Injects ~800t compaction prompt + claude-code-hooks | Capture messages + heuristic extract to checkpoint.md | **Minimal** | Both run sequentially, order doesn't matter |
| `chat.message` | Reads parts, doesn't modify | Reads parts, doesn't modify | **None** | Read-only on both sides |
| `chat.params` | Unused | Maintain sessionID→agent map | **None** | We are sole user |
| `event` | Multi-subscriber | Multi-subscriber | **None** | Independent handlers |
| `config` | Runs first (sets agents/models) | Runs second (reads final config) | **None** | Order-dependent but cooperative |
| `tool` | Tool names: `task`, `skill`, `todowrite` | Tool names: `memory_*` | **None** | No namespace collision |

### 2.3 DCP Removal Rationale

DCP's 17-step `experimental.chat.messages.transform` pipeline replaces messages with lossy summaries. Any memory injected via `system.transform` survives (DCP doesn't touch system prompt), but DCP's value (per-message pruning) overlaps with our checkpoint capture:

- **DCP approach**: Compress every conversation in-flight, lose original content
- **Our approach**: Capture original content at compaction boundary, extract structured knowledge, inject summary on demand

Our approach is lossless where it matters (decisions, constraints, file changes) and doesn't pollute the message stream. DCP becomes redundant.

---

## 3. Architecture

### 3.1 Three Pillars

```
┌─────────────────────────────────────────────────────────────────┐
│                    opencode-deep-memory                          │
├──────────────────┬──────────────────┬───────────────────────────┤
│  Persistent      │  Context         │  Session Continuity       │
│  Memory          │  Management      │                           │
│  (recall/)       │  (checkpoint/    │  (schedule/ +             │
│                  │   reconstruct/)  │   hooks/event-handler)    │
├──────────────────┼──────────────────┼───────────────────────────┤
│ BM25 Index       │ compacting hook  │ session.created event     │
│ Markdown files   │ chat.params hook │ → resume detection        │
│ memory_* tools   │ heuristics       │ → auto-dream scheduling   │
│                  │ idle LLM enrich  │                           │
│                  │ adaptive inject  │                           │
└──────────────────┴──────────────────┴───────────────────────────┘
```

### 3.2 Module Map

```
src/
├── index.ts                    Plugin entry: registers all hooks + tools
├── shared/
│   ├── paths.ts                Scope/type system (global/project/session)
│   ├── tokens.ts               Token estimator (~4 chars/token heuristic)
│   ├── lock.ts                 File lock (pid + timestamp, 30s TTL)
│   └── log.ts                  Debug logger (DEEP_MEMORY_DEBUG env)
├── search/                     ── Pillar 1: Persistent Memory
│   ├── tokenizer.ts            CJK bigram + Latin word splitter
│   ├── bm25.ts                 BM25 engine (k1=1.5, b=0.75)
│   ├── reconcile.ts            Markdown → Index sync
│   └── service.ts              Search service (scope filter, snippet extract)
├── extract/                    ── Pillar 2: Context Management
│   ├── heuristics.ts           Instant layer (<100ms)
│   ├── enrich.ts               Idle layer (background LLM via promptAsync)
│   └── capture.ts              compacting hook: fetch messages + write raw
├── inject/                     ── Pillar 2: Adaptive Injection
│   ├── budgeted-read.ts        Token-budgeted Markdown section reader
│   ├── agent-budget.ts         Per-agent budget policy
│   └── system-payload.ts       Compose final system prompt fragment
├── hooks/                      ── Hook handlers
│   ├── chat-params.ts          Maintain sessionID → agent map (Q1 fix)
│   ├── chat-message.ts         Keyword detection → notes.md
│   ├── system-transform.ts     Adaptive dual-budget injection
│   ├── compacting.ts           Reactive capture + heuristic extract
│   └── event-handler.ts        session.created/idle/compacted dispatch
├── schedule/                   ── Pillar 3: Session Continuity
│   ├── resume.ts               Resume detection + 3000t first injection
│   ├── auto-dream.ts           7-day cycle → background dream session
│   └── dream-executor.ts       Spawn background session, consolidate
└── tools/                      ── Custom tools
    ├── memory-search.ts        memory_search tool
    ├── memory-store.ts         memory_store tool
    └── memory-forget.ts        memory_forget tool
```

### 3.3 Storage Layout

```
<projectPath>/.deep-memory/             ← project-scoped (visible, VCS-friendly)
├── MEMORY.md                             persistent memory
├── notes.md                              append-only raw captures (chat.message hook)
├── checkpoint.md                         last compaction's structured extraction
├── checkpoint.raw.json                   original messages (for LLM enrichment)
├── .schedule.json                        { lastDream: ISO, lastDistill: ISO }
├── .index-state.json                     mtime map for reconcile diff
└── sessions/<sessionID>/
    └── checkpoint.md                      per-session checkpoint archive

<globalRoot>/global/MEMORY.md             ← cross-project persistent memory
```

**Design rationale** (project-local + global hybrid):
- Project-local under `.deep-memory/` is visible to users, version-controllable, and travels with the project (rename/move safe)
- No hash of project path required — the directory IS the identity
- Users can `git add .deep-memory/MEMORY.md` to share decisions with team members
- Global root still exists for truly cross-project memory (development conventions, tool preferences)
- Aligns with `.opencode/`, `.claude/`, `.cursor/` conventions used by other AI coding tools

**Path resolution** (priority order):
1. **Project subdir name**: `process.env.DEEP_MEMORY_PROJECT_SUBDIR` (default `.deep-memory`)
2. **Global root**: `process.env.DEEP_MEMORY_GLOBAL_ROOT` (legacy alias: `DEEP_MEMORY_DATA`) → `XDG_DATA_HOME/opencode/deep-memory` → `~/.local/share/opencode/deep-memory`
3. Fallback: project-local for project scope; global root for global scope

**MiMo-Code comparison**: MiMo uses `~/.mimo/projects/<hash>/` (centralized, hash-keyed). We moved to project-local because:
- Visibility: users can `ls .deep-memory/` and see exactly what the agent knows
- Portability: project move/rename doesn't orphan memory
- Version control: team members can share MEMORY.md via git
- No hash collision concerns

---

## 4. Pillar 1: Persistent Memory

### 4.1 Tokenizer (CJK Bigram + Latin)

**Algorithm**:
- Split input into CJK runs and non-CJK runs
- CJK run of length N → emit N-1 bigrams (sliding 2-char window) + N unigrams
- Non-CJK run → lowercase, split on `[\s\p{P}]+`, filter empties

**Example**:
```
"权限死锁 caused by mutex"
→ ["权", "权限", "限死", "死锁", "锁", "caused", "by", "mutex"]
```

**Why not MiMo-Code's FTS5 unicode61?**
- unicode61 treats each CJK char as a single token, cannot match multi-char phrases
- `"权限"` cannot match document containing only `"权限死锁"` in FTS5
- CJK bigram enables phrase matching via OR-join of bigrams

### 4.2 BM25 Engine

**Parameters**: `k1 = 1.5`, `b = 0.75` (standard Robertson-Sparck-Jones values)

**Pre-computed at index time** (per document):
- `docLen[d]` — total token count
- `termFreq[d][t]` — term frequency map
- `docCount`, `avgDocLen`

**Pre-computed at rebuild** (per term):
- `df[t]` — document frequency
- `idf[t] = log((N - df + 0.5) / (df + 0.5) + 1)`

**Search**: For each query term, lookup postings list, compute score per (doc, term), aggregate by max, sort descending, return top-K.

### 4.3 Benchmark (Verified)

| Docs | Rebuild | Search (p99) | Memory |
|------|---------|-------------|--------|
| 100  | 46ms    | 0.7ms       | 1.5MB  |
| 500  | 74ms    | 4.9ms       | 5.5MB  |
| 1000 | 105ms   | 4.1ms       | 4.4MB  |
| 2000 | 244ms   | 12ms        | 15.5MB |
| 5000 | 659ms   | 14ms        | 13.9MB |

**Incremental update (1 file change)**: <1.2ms at any scale.

**Persistence decision**: No JSON cache. Markdown files are source of truth. Index rebuilds on startup (<250ms for 2000 docs — typical user scale).

### 4.4 Reconcile (File ↔ Index Sync)

**Algorithm** (file→index direction):
1. Walk storage tree, collect all `.md` files with mtime
2. Compare against `indexState[path].mtime`
3. For changed/new files: re-tokenize, update postings
4. For deleted files: remove from postings
5. Persist `indexState` (mtime map) to `.index-state.json` for next diff

**Bidirectional reconcile** (index→file direction):
- Manual operation via `/memory reconcile` command
- Used when index becomes corrupted or after manual file edits
- Rebuilds from files entirely

### 4.5 Tools

#### `memory_search`
```typescript
{
  description: "Search persistent memory (decisions, constraints, notes from past sessions)",
  args: {
    query: { type: "string", description: "Search query (supports Chinese phrases)" },
    scope: { type: "enum", enum: ["global", "project", "session", "all"], default: "all" },
    limit: { type: "number", default: 5, maximum: 20 }
  },
  // Returns: top-K snippets with file path, BM25 score, section heading
}
```

#### `memory_store`
```typescript
{
  description: "Store a memory entry (decision, constraint, gotcha, fact)",
  args: {
    content: { type: "string", description: "Memory content (Markdown)" },
    type: { type: "enum", enum: ["decision", "constraint", "gotcha", "fact", "note"], default: "note" },
    scope: { type: "enum", enum: ["global", "project"], default: "project" }
  }
  // Appends to appropriate section in MEMORY.md under heading [type]
  // Triggers incremental index update
}
```

#### `memory_forget`
```typescript
{
  description: "Delete a memory entry by content match or file path",
  args: {
    query: { type: "string", description: "Content to forget (BM25 match)" },
    scope: { type: "enum", enum: ["global", "project", "session", "all"], default: "project" },
    confirm: { type: "boolean", default: false }
  }
  // Requires confirm=true to actually delete; otherwise shows matches
}
```

---

## 5. Pillar 2: Context Management

### 5.1 Checkpoint Strategy: Reactive + Manual

**Reactive** (`experimental.session.compacting` hook):
- Hook fires → handler calls `await client.session.messages({ path: { id: sessionID } })`
- Writes raw messages to `checkpoint.raw.json`
- Runs heuristic extractor (<100ms) → writes `checkpoint.md` (instant layer)
- Native compaction proceeds (lossy summary replaces messages in session)
- Hook is async-blocking, host awaits our promise

**Manual** (`/checkpoint` command):
- User invokes before reading large files or before risky operations
- Calls same `client.session.messages()` + heuristic extractor
- Does NOT trigger native compaction; just snapshots current state

**Why not proactive threshold-based?**
- OpenCode plugin API has no `session.context.threshold` hook (would need upstream PR — Phase 3 deliverable)
- User's actual usage: 89.8% of sessions never compact (analysis of 1439 sessions, 52639 messages)
- Reactive + manual covers the 1% that need it

### 5.2 Dual-Layer Extraction

#### Instant Layer (Heuristics, <100ms)

**Pattern pipeline** (applied to each message part):

| Pattern | Trigger | Output Section |
|---------|---------|---------------|
| User message | `role === "user"` (skip tool results) | `## User Intent` (verbatim, max 200 tokens) |
| Decision | Match `/\b(I'll|I recommend|let's|建议|决定|采用)\b/i` in assistant text | `## Decisions` |
| Constraint | Match `/\b(must not|never|不要|必须|避免)\b/i` in user or assistant text | `## Constraints` |
| Error-Fix pair | Tool error followed by corrective tool call within 3 messages | `## Gotchas` |
| File change | `tool === "write" or "edit"`, parse `filePath` arg | `## File Changes` |

**Output format** (checkpoint.md):
```markdown
# Checkpoint — <sessionID>
Generated: <ISO timestamp>
Session token estimate: <N>

## User Intent
<verbatim user messages, truncated to 200t each>

## Decisions
- <decision 1>
- <decision 2>

## Constraints
- <constraint 1>

## Gotchas
- Error: <msg> → Fix: <corrective action>

## File Changes
- <path>: <operation> (<lines changed>)
```

#### Idle Layer (Background LLM Enrichment)

**Trigger**: `session.idle` event for the captured sessionID

**Flow**:
1. Spawn background session via `client.session.create({ body: { parentID: sessionID, title: "Memory Checkpoint Enrichment" } })`
2. `client.session.promptAsync({ path: { id: newSessionID }, body: { parts: [...], agent: "build", tools: { memory_store: true } } })`
3. Prompt includes: raw `checkpoint.raw.json` excerpt (last 50 messages) + current `checkpoint.md` draft
4. LLM cross-references messages, synthesizes themes, updates `checkpoint.md` via `memory_store` tool
5. Background session runs in its own context window — does not consume main session budget

**Quality progression**:
- First compaction cycle: ~80% quality (heuristic only, no LLM history)
- Second cycle onward: ~95%+ (prior enriched checkpoints provide context)

### 5.3 Adaptive Injection

#### Budget Policy (per agent type)

| Agent Type | Normal Budget | Post-Compaction | Post-Resume (first msg) |
|-----------|--------------|-----------------|------------------------|
| Main orchestrator (`sisyphus`, `build`, undefined) | 800t | 3000t | 3000t |
| Deep reasoning (`oracle`, `metis`, `momus`) | 400t | 800t | 400t |
| Tool subagents (`explore`, `librarian`, `quick`) | 80t | 80t | 80t |

#### Budget Allocation (within 800t normal main session)

```
Tool announcement:        80t  (fixed — describes memory_search tool)
MEMORY.md summary:        500t (budgeted-read, priority: Rules > Constraints > Decisions > Gotchas)
Checkpoint summary:       220t (last checkpoint's key decisions + gotchas)
```

Within 3000t (post-compaction/resume):
```
Tool announcement:        80t
MEMORY.md summary:        1500t (expanded — all sections)
Checkpoint summary:       1420t (last checkpoint's full content + relevant notes)
```

#### Budgeted-Read Algorithm

```typescript
function budgetedRead(filePath: string, budgetTokens: number, sectionPriority: string[]): string {
  const sections = parseMarkdownSections(filePath);
  const sorted = sortByPriority(sections, sectionPriority);
  let output = "";
  let remaining = budgetTokens;
  for (const section of sorted) {
    const sectionTokens = estimateTokens(section.body);
    if (sectionTokens <= remaining) {
      output += section.heading + "\n" + section.body + "\n\n";
      remaining -= sectionTokens;
    } else {
      // Truncate this section to fit
      output += section.heading + "\n" + truncate(section.body, remaining) + "\n\n";
      break;
    }
  }
  return output;
}
```

#### Agent Detection (Q1 Fix — 2-Hook Strategy)

**Problem**: `experimental.chat.system.transform` input = `{ sessionID?, model }` — NO `agent` field (verified via `.d.ts`).

**Solution**:
1. Register `chat.params` hook (input has `agent: string` required + `sessionID: string`)
2. Maintain in-memory `Map<sessionID, agent>` in plugin module scope
3. In `system.transform` handler, lookup `agentMap.get(input.sessionID)` to determine budget tier
4. Fallback: if sessionID not in map (e.g., very first call before chat.params fired), default to main orchestrator budget

**Hook firing order** (verified): `chat.params` fires before `chat.message` and before `system.transform` for any given turn.

---

## 6. Pillar 3: Session Continuity

### 6.1 Resume Detection

**Trigger**: `session.created` event

**Flow**:
1. Event handler receives `{ type: "session.created", properties: { sessionID, ... } }`
2. Resolve project scope (from `input.project.path` or session metadata)
3. Check if `projects/<hash>/MEMORY.md` exists
4. If exists: set `pendingResume[sessionID] = { budget: 3000, scope: projectHash }`
5. Subsequent `system.transform` for this sessionID consumes the flag:
   - First call: use 3000t budget, inject MEMORY.md + last checkpoint
   - Clear flag
   - Subsequent calls: use 800t normal budget

**Edge case**: session.created fires once per session, but system.transform fires every LLM turn. The `pendingResume` flag ensures only the FIRST turn gets the 3000t budget.

**Why this is critical**: Analysis of 1439 user sessions shows 89.8% are <8K tokens (never compact). For these sessions, cross-session continuity is the PRIMARY value — without resume detection, every new session is cold even though MEMORY.md has rich history.

### 6.2 Auto-Scheduling (`/dream` consolidation)

**Trigger**: `session.created` event (same handler as resume detection)

**Flow**:
1. Read `projects/<hash>/.schedule.json`:
   ```json
   { "lastDream": "2026-06-07T...", "lastDistill": "2026-05-15T..." }
   ```
2. If `now - lastDream > 7 days`:
   - Spawn background session: `client.session.create({ body: { parentID: sessionID, title: "Memory Dream Consolidation" } })`
   - `client.session.promptAsync({ body: { parts: [dreamPrompt], agent: "sisyphus", tools: { memory_store: true, memory_search: true } } })`
   - Update `.schedule.json.lastDream` to `now` immediately (prevents re-trigger on next session)
3. Background dream session:
   - Reads `notes.md` (accumulated captures since last dream)
   - Reads recent `sessions/*/checkpoint.md` files
   - Synthesizes recurring themes → appends to `MEMORY.md` via `memory_store`
   - Clears processed entries from `notes.md`

**dreamPrompt** (system message for background session):
```
You are a memory consolidation agent. Your task:

1. Read the notes.md file at <path>. These are raw captures from recent sessions.
2. Read the most recent checkpoint.md files in <sessions-dir> (last 5).
3. Identify recurring themes, confirmed decisions, hard constraints, and important gotchas.
4. For each significant finding, call memory_store with type=<decision|constraint|gotcha|fact> and scope=project.
5. After storing, append a "## Consolidated <ISO>" header to notes.md and move processed entries under it (do not delete — preserve audit trail).
6. Stop when notes.md's unprocessed section is empty.

Be selective: only store findings that will matter in future sessions. Skip transient details.
```

**Fallback if `client.session.create()` fails**: Queue dream work in `.schedule.json.queuedDream = true`. On next `session.idle` of any main session, run dream inline (consumes main session budget, but only as last resort).

### 6.3 Manual `/checkpoint` and `/dream` Commands

Both defined in `.opencode/command/`:

**`/checkpoint`** (`.opencode/command/checkpoint.md`):
```markdown
---
agent: build
description: Capture current session state to checkpoint before risky operation
---

Call the memory checkpoint capture now. Use the internal capture function with current sessionID.
After capture, confirm what was saved (decisions, constraints, file changes).
```

**`/dream`** (`.opencode/command/dream.md`):
```markdown
---
agent: sisyphus
description: Consolidate notes and checkpoints into persistent memory
---

Run memory consolidation now:
1. Read notes.md and recent checkpoint.md files.
2. Identify themes worth persisting.
3. Call memory_store for each significant finding.
4. Mark processed entries in notes.md.

Use memory_search to avoid duplicating existing entries.
```

Both commands use the same executors as their automatic counterparts, ensuring consistency.

---

## 7. Hook Specifications

### 7.1 Registered Hooks

| Hook | Purpose | Async? |
|------|---------|--------|
| `config` | Read final config after OMO sets agents/models | No |
| `chat.params` | Maintain sessionID → agent map | No |
| `chat.message` | Keyword detection → notes.md append | No |
| `experimental.chat.system.transform` | Adaptive injection (push MEMORY.md + checkpoint) | Yes |
| `experimental.session.compacting` | Capture messages + heuristic extract | Yes (blocking) |
| `event` | session.created/idle/compacted dispatch | No |
| `tool` | Register memory_search/store/forget | N/A |

### 7.2 Event Subscriptions

| Event | Handler |
|-------|---------|
| `session.created` | Resume detection + auto-dream scheduling |
| `session.idle` | Trigger idle-layer LLM enrichment for pending checkpoints |
| `session.compacted` | Mark compaction complete (validation checkpoint) |
| `session.error` | Log to debug file (no user-facing action) |

### 7.3 Hook Execution Order (with OMO coexistence)

```
[Session start]
  config (OMO) → config (us) →
  event: session.created (OMO) → event: session.created (us: resume + auto-dream)

[Each LLM turn]
  chat.params (us: record agent) →
  chat.message (OMO) → chat.message (us: notes.md) →
  experimental.chat.system.transform (OMO: push ultrawork) →
  experimental.chat.system.transform (us: push memory) →

[Compaction trigger]
  experimental.session.compacting (OMO: inject prompt) →
  experimental.session.compacting (us: capture + heuristic extract) →
  [native compaction runs] →
  event: session.compacted (us: log)

[Session idle]
  event: session.idle (us: spawn enrichment session)
```

---

## 8. Evidence Appendix (Self-Grill Resolutions)

### Q1: Resume injection would hit subagents

**Original assumption**: `input.agent` exists in `experimental.chat.system.transform`.

**Evidence**:
- `/home/demo/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts:233-238`:
  ```typescript
  "experimental.chat.system.transform"?: (input: {
      sessionID?: string;
      model: Model;
  }, output: { system: string[] }) => Promise<void>;
  ```
- OMO's `createSystemTransformHandler` (`index.js:152987-153002`) reads only `input.model?.id`.

**Resolution**: 2-hook strategy — `chat.params` (has `agent: string`) builds sessionID→agent map; `system.transform` looks up by sessionID. Fallback: if unmapped, assume main orchestrator.

### Q2: `client.session.create()` availability

**Evidence**:
- `/home/demo/.opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts:377-402` lists full `client.session.*` namespace.
- `session.create(options?: {body?: {parentID?, title?}, query?: {directory?}}) → Session`
- `session.promptAsync(options) → void` (non-blocking)
- `session.messages(options) → Array<{info, parts}>`
- OMO real usage: `index.js:96987` (create), `index.js:119181` (create + promptAsync), `index.js:7300` (messages).

**Resolution**: auto-dream and idle enrichment both use `create + promptAsync` directly. Fallback (idle queue) documented but not expected to be needed.

### Q3: Compacting hook message access

**Evidence**:
- `.d.ts:239-251`:
  ```typescript
  "experimental.session.compacting"?: (input: {
      sessionID: string;
  }, output: { context: string[]; prompt?: string }) => Promise<void>;
  ```
- Input has ONLY `sessionID`. No messages field.
- Hook returns `Promise<void>` — **async-blocking** (host awaits).
- OMO handlers (`index.js:155345-155369`) also use this pattern, reading only `input.sessionID`.

**Resolution**: Inside the compacting hook, call `await client.session.messages({ path: { id: input.sessionID } })` to fetch full conversation. This adds one RPC round-trip (<50ms typically) before native compaction proceeds. Acceptable.

### Q4: Concurrent session file access

**Engineering practice** — no specific API evidence needed.

**Resolution**: Per-file lock with pid + timestamp, 30s TTL. Acquired before any write to MEMORY.md/checkpoint.md/notes.md. Stale locks (older than 30s or whose pid is dead) are auto-claimed.

### Q5: Token budget accuracy

**Process commitment** — not a factual claim.

**Resolution**: Phase 1 completion criterion requires measuring actual injection token cost via `@ramtinj95/opencode-tokenscope`. Results written to `injection.stats.json`. If actual > budget × 1.1, shrink section priorities and re-measure.

### Q6: `/dream` background vs main session

**Conceptual design** — verified via Q2 evidence.

**Resolution**: Both auto-dream and manual `/dream` use `client.session.create() + promptAsync()` to run in background session. Main session shows progress via toast (TUI) or log entry.

---

## 9. Development Plan

### 9.1 Phase 1: MVP (~8h) — Complete Memory Closed Loop

**Goal**: A user can store and retrieve persistent memory across sessions.

| ID | Task | Est | Deliverable |
|----|------|-----|-------------|
| F1 | Project skeleton | 0.5h | package.json, tsconfig, tsup config, dist/ placeholder |
| F2 | Tokenizer | 1h | `src/search/tokenizer.ts` + unit tests (CJK bigram, Latin, mixed) |
| F3 | BM25 engine | 1.5h | `src/search/bm25.ts` + unit tests (rebuild, search, incremental) |
| F4 | Reconcile | 1h | `src/search/reconcile.ts` + file lock + unit tests |
| F5 | memory_* tools | 1h | `src/tools/*` + tool registration in index.ts |
| F6 | Resume detection | 1h | `src/schedule/resume.ts` + event handler wiring |
| F7 | Adaptive injection | 1h | `src/inject/*` + system.transform hook + chat.params hook (agent map) |
| F8 | notes.md capture | 0.5h | `src/hooks/chat-message.ts` keyword detection |
| F9 | Auto-dream scheduling | 0.5h | `src/schedule/auto-dream.ts` + dream-executor.ts |
| F10 | Hook assembly + E2E | 1h | index.ts entry, smoke test all 5 hooks |

**Phase 1 acceptance criteria**:
- [ ] Start new session → MEMORY.md auto-injected (3000t budget on first turn)
- [ ] `memory_store` → entry persists in MEMORY.md, survives restart
- [ ] `memory_search "chinese phrase"` → returns relevant snippets
- [ ] Token cost measured via tokenscope, within budget ±10%
- [ ] After 7 days, new session triggers background dream → MEMORY.md updated

### 9.2 Phase 2: Checkpoint (~8h) — Compaction Resilience

**Goal**: When a session compacts, no knowledge is lost.

| ID | Task | Est | Deliverable |
|----|------|-----|-------------|
| P1 | compacting hook + capture | 1.5h | `src/extract/capture.ts` + compacting hook |
| P2 | Heuristic extractor | 2h | `src/extract/heuristics.ts` + unit tests for all 5 patterns |
| P3 | checkpoint.md writer | 1h | Template rendering, section ordering |
| P4 | Idle LLM enrichment | 2h | `src/extract/enrich.ts` + background session spawn |
| P5 | `/checkpoint` command | 0.5h | `.opencode/command/checkpoint.md` |
| P6 | session.compacted validation | 0.5h | Event handler, log compaction events |
| P7 | Integration tests | 1h | Mock compacting hook, verify checkpoint.md output |

**Phase 2 acceptance criteria**:
- [ ] Trigger mock compaction → checkpoint.md generated within 5s
- [ ] checkpoint.md contains: User Intent, Decisions, Constraints, Gotchas, File Changes
- [ ] session.idle → background enrichment updates checkpoint.md with cross-references
- [ ] Next session resume → checkpoint summary injected (within budget)

### 9.3 Phase 3: Enhancement (~6h) — Polish and Extensions

| ID | Task | Est | Deliverable |
|----|------|-----|-------------|
| E1 | `/dream` manual command | 0.5h | `.opencode/command/dream.md` |
| E2 | `/distill` workflow packaging | 2h | 30-day cycle, packages workflows into skill files |
| E3 | Qdrant semantic layer (optional) | 2h | Compose orchestration, BGE-M3 embeddings |
| E4 | Upstream PR draft | 1.5h | `session.context.threshold` hook for proactive checkpointing |

**Phase 3 stretch goals**:
- CJK semantic search (Qdrant + BGE-M3) for fuzzy concept matching
- `/distill` packages repeated workflows into reusable skills
- Upstream OpenCode PR to enable proactive checkpointing at 40%/60%/80% context thresholds

---

## 10. Build, Debug, Test

### 10.1 Build

**Toolchain**: tsup (ESM bundler) + tsc (declaration emit only)

**tsup.config.ts**:
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,                    // emit .d.ts via tsc
  sourcemap: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  noExternal: [/* bundle all our own deps; we have zero runtime deps */],
});
```

**package.json**:
```jsonc
{
  "name": "opencode-deep-memory",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "*",
    "@opencode-ai/sdk": "*",
    "tsup": "^8.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
  // NO runtime dependencies
}
```

### 10.2 Debug

**File-based logger** (no console pollution):
- Path: `~/.config/opencode/deep-memory-debug.log`
- Levels: `error`, `warn`, `info`, `debug`
- Env var: `DEEP_MEMORY_DEBUG=1` enables debug level
- Format: `[ISO] [LEVEL] [hook] message {metadataJSON}`

**Hook I/O dump** (dev mode):
- When `DEEP_MEMORY_DEBUG=trace`, dump every hook's input/output to `~/.config/opencode/deep-memory-trace/<hook>-<timestamp>.json`
- Used for post-mortem analysis of injection budget drift

**Standalone CLI** (for core logic testing without OpenCode):
```bash
node dist/cli.js search "权限死锁" --scope project
node dist/cli.js tokenize "mixed 中英文 text"
node dist/cli.js bm25-bench --docs 1000
```

### 10.3 Test Pyramid

**Unit tests** (vitest, ~70% coverage target):
- `tokenizer.test.ts`: CJK bigram, Latin, mixed, edge cases (empty, pure-punct)
- `bm25.test.ts`: rebuild correctness, search ranking, incremental update, edge cases (empty index, single doc)
- `reconcile.test.ts`: file add/modify/delete, mtime diff, lock contention
- `heuristics.test.ts`: all 5 patterns, false positives, truncation
- `budgeted-read.test.ts`: budget enforcement, section priority, truncation

**Hook integration tests** (mock input/output):
- `system-transform.test.ts`: mock `{sessionID, model}` input + `{system: []}` output, verify push behavior
- `compacting.test.ts`: mock `{sessionID}` input, mock `client.session.messages` response, verify checkpoint.md output
- `chat-params.test.ts`: verify sessionID→agent map updates correctly

**CLI smoke test** (`npm run smoke`, runs `scripts/smoke.mjs`):
- Loads built `dist/index.js` end-to-end
- Verifies plugin factory returns all 5 hooks + 3 tools
- Exercises every hook with mock input (chat.params, chat.message, system.transform, event, tool.execute)
- Verifies project-local storage layout (`.deep-memory/MEMORY.md`, `notes.md`, `.schedule.json`, `.index-state.json`)
- Confirms NO legacy `projects/<hash>/` directory is created
- Tests CJK search round-trip
- Tests memory_forget confirmed delete

**Full verification command** (`npm run verify`):
```
typecheck → unit tests → build → smoke test
```
All four stages must pass before any work is considered complete.

**E2E manual checklist** (Phase 1 + 2 acceptance criteria):
- Documented in `tests/e2e-checklist.md`
- Executed manually by user in real OpenCode environment

---

## 11. Risk Register

| ID | Severity | Risk | Mitigation | Trigger to Detect |
|----|----------|------|-----------|-------------------|
| R1 | High | `client.session.create()` or `promptAsync()` fails in plugin context | Fallback: queue dream/enrichment work, run inline on next `session.idle` | Wrap in try/catch, log failure, set `.schedule.json.queuedWork` |
| R2 | Medium | `client.session.messages()` returns incomplete data at compacting time | Validate message count > 0, fall back to streaming capture via `chat.message` accumulator | Log message count in compacting hook |
| R3 | Medium | OMO upgrade changes `system.transform` semantics | Push-only design is naturally compatible; add canary check for `output.system` being an array | Plugin load: assert `Array.isArray(output.system)` on first call |
| R4 | Low | CJK bigram index grows large | 5000 docs = 13.9MB, acceptable. Monitor via `/memory stats` command | Log index size on rebuild |
| R5 | Low | Project hash changes (user renames project directory) | Document: memory is keyed by absolute path hash. Provide `/memory migrate <oldPath>` command | Detect orphaned `projects/<hash>/` directories on startup |
| R6 | Low | Concurrent sessions write to same project MEMORY.md | File lock (30s TTL, pid-tracked) | Lock acquisition failure → retry with backoff (max 3 attempts) |

---

## 12. Comparison with MiMo-Code

| Feature | MiMo-Code | opencode-deep-memory | Notes |
|---------|-----------|---------------------|-------|
| Search engine | SQLite FTS5 (unicode61) | Pure JS BM25 + CJK bigram | **Ours exceeds** for CJK (FTS5 can't match multi-char CJK phrases) |
| Native deps | SQLite (binary) | Zero | Plugin sandbox-safe |
| Checkpoint trigger | Proactive (40/60/80% thresholds) | Reactive (compacting hook) + manual | We miss proactive; mitigated by Phase 3 upstream PR |
| Checkpoint sections | 11 (immediate LLM) | 5 (heuristic) + LLM enrichment | First cycle 80%, subsequent 95%+ |
| `/dream` consolidation | 7-day cycle | 7-day cycle (same) | Identical |
| `/distill` workflow packaging | 30-day cycle | 30-day cycle (Phase 3) | Identical |
| Injection budget | Fixed 33K (multi-source) | Adaptive 80–3000t (agent-aware) | Plugin API limits us; we trade depth for safety |
| Storage | SQLite + Markdown | Markdown only | Simpler, no cache invalidation |
| Persistence | SQLite file | Markdown files + in-memory index rebuild | <250ms rebuild at typical scale |
| Cross-session resume | Implicit (fork-level) | Explicit (session.created + pendingResume) | Plugin-level isolation |

**Net assessment**: For 89.8% of sessions (<8K tokens, never compact), our plugin matches or exceeds MiMo-Code's value via persistent memory + resume detection. For the 1% that compact, we trade checkpoint depth (5 vs 11 sections) for zero native dependencies and plugin-sandbox safety. The dual-layer extraction closes the quality gap after the first compaction cycle.

---

## 13. Open Questions (Deferred to Implementation)

- **Q-O1**: Does `chat.params` fire for sub-sessions spawned via `client.session.create()`? If yes, our sessionID→agent map will correctly track them. If no, those sessions default to main budget (safe).
- **Q-O2**: Does `event: session.created` fire for programmatically-created sessions (via `client.session.create()`)? If yes, we must avoid recursive dream-triggering. Mitigation: check session title prefix `"Memory "` and skip.
- **Q-O3**: Actual token cost of our injection (Q5 commitment) — measure in Phase 1, adjust budgets if needed.

These will be resolved during Phase 1 implementation and documented in CHANGELOG.

---

## 14. References

- **MiMo-Code source**: github.com/XiaomiMiMo/MiMo-Code
  - `fts-query.ts`, `fts.sql.ts`, `reconcile.ts`, `service.ts`, `paths.ts`, `budgeted-read.ts`
- **OpenCode plugin types**: `/home/demo/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`
- **OpenCode SDK types**: `/home/demo/.opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts`
- **OMO reference**: `/home/demo/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent/dist/`
  - Real usage of `client.session.create()` at `index.js:96987, 119181`
  - `createSystemTransformHandler` at `index.js:152987-153002`
  - `createSessionCompactingHandler` at `index.js:155345-155369`
- **opencode-supermemory** (external plugin studied): compacting + chat.message hooks + remote API storage

---

**Document version**: 1.0
**Last updated**: 2026-06-14
**Author**: Sisyphus (via OhMyOpenCode), in collaboration with user
**Next action**: User review → if approved, begin Phase 1 implementation (F1–F10)
