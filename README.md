# opencode-deep-memory

> Persistent cross-session memory for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

V4 architecture. Built on research from 7 production coding agents, 30+ memory systems, and 5 academic papers. Eliminates the two independent LLM output degradation paths found in V2: volatile system-prompt injection and post-hoc tool output compression.

## Quick start

```jsonc
// opencode.json
{
  "plugin": [
    "oh-my-openagent",
    "@bd7pil/opencode-deep-memory"
  ]
}
```

Memory lives at `.deep-memory/` in your project root.

## What it does

| Capability | How |
|---|---|
| **Remember** decisions, constraints, gotchas, facts | `memory_store` → BM25-indexed `MEMORY.md` (200 line cap) |
| **Retrieve** across sessions | `memory_search` — BM25 + CJK bigram |
| **Forget** stale entries | `memory_forget` — by query + confirmation |
| **Recover** compressed content | `deep_expand` / `memory_expand` — SHA-256 CCR, 30min cache |
| **Compress** on demand | `context_compress` — agent-initiated, originals recoverable |
| **Deduplicate** on compaction | SIMHash dedup of MEMORY.md (synchronous, no LLM) |

## 6-Layer architecture

All six layers are backed by production evidence — not theory.

### Layer 1: Capture-time tool output limiting

Tool outputs are capped once at capture time, not post-hoc mid-conversation.

| Tool | Default cap | Strategy |
|---|---|---|
| `bash` | 48K chars | Head + error lines + tail 200 + recovery hint |
| `read` | 50K chars | Head + tail + key lines + re-read hint |
| `grep`/`search` | 20 files × 5 matches | Group by file, top matches |
| `task`/`background_output` | 30K chars | Headers + code fences + key lines |
| `webfetch` | 20K chars | Head + headings + tail |

Recovery hint tells the LLM how to get more detail (re-read with offset, grep with pattern), not a dead-end marker.

**Evidence**: Cline source (`output-limits.ts`: bash 48K, read 50K). Aider and Cody: no post-hoc compression at all.

### Layer 2: Stale-read rewriting

When the same tool is called multiple times with identical input+output, older copies are marked `[OUTDATED — superseded by newer identical call]`. The LLM sees a useful signal instead of a meaningless placeholder that it may mimic in output.

**Replaces**: `[superseded by duplicate call]` placeholder (V2) and `[context-stripped]` orphan repair — both known to cause the LLM to produce placeholder-style output.

### Layer 3: Static memory file (byte-stable system prompt)

The system prompt is frozen across turns — TOOL_HINT + MEMORY.md content are injected once and only change when `memory_store` writes to MEMORY.md (mtime cache). No volatile BM25 results, no per-turn search, no repomap in the system prompt.

```
Position 0 (frozen): TOOL_HINT — ~150 tokens, byte-identical every turn
Position 0 (cached): MEMORY.md — up to 200 lines / 25KB, cached by mtime
```

When MEMORY.md hasn't changed: 100% byte-stable system prompt across turns.

**Key difference from V2**: V2 injected BM25 search results (560–2720 tokens) into `system[1]` every turn, changing content per-turn. This violated the consensus that system prompts should be byte-stable (Cognee, Aider, Copilot all inject dynamic content in user message, not system prompt). Context Rot research (Chroma 2025) confirmed all 18 tested models degrade with per-turn mutation.

### Layer 4: Hybrid retrieval (one-time auto-search)

Pure pull-based retrieval doesn't work reliably — When2Tool (arxiv 2605.09252) shows LLMs know when to retrieve (hidden-state AUROC 0.89) but fail to act during generation. V4 uses a hybrid:

- **First turn only**: quiet `memory_search(userQuery)` runs. If top-1 BM25 score ≥ 2.0, a ≤30-token whisper is appended: `[memory hint: N relevant entries ...]`
- **Turns 2+**: system prompt is byte-stable. Zero whisper overhead.
- **On demand**: `memory_search` tool is always available.

### Layer 5: Synchronous consolidation (no background)

V2's dream/distill used `client.session.promptAsync` fire-and-forget — it never worked because the main process doesn't persist for 7-day cycles. V4 consolidation is strictly synchronous, runs inside hooks:

| Trigger | Action | Duration |
|---|---|---|
| `session.compacting` hook | SIMHash dedup of MEMORY.md (≥0.92 similarity threshold) | <100ms |
| `/checkpoint` command | Manual memory capture + dedup | <200ms |
| `memory_store` after 200 lines | Overflow to MEMORY-archive.md | <10ms |

No `promptAsync`, no `setInterval`, no child sessions, no LLM calls in consolidation.

### Layer 6: Agent-initiated compression

When the LLM feels context is bloated, it calls `context_compress(keep_recent=8)`. This sets a flag consumed by the next `messages.transform`, which replaces old tool outputs with head/tail summaries. Originals stored in CCR — `deep_expand` retrieves them.

CCR markers are actionable: `[compressed — call deep_expand("hash") to restore original]` instead of V2's dead-end `[ccr:hash]`.

## Tools

| Tool | Purpose |
|---|---|
| `memory_search` | BM25 + CJK bigram search across project and global memory |
| `memory_store` | Store one entry (decision/constraint/gotcha/fact/note) |
| `memory_forget` | Find matching entries and remove them |
| `memory_expand` | Restore original content from compressed conversation messages |
| `deep_expand` | Restore original content from CCR-compressed tool output |
| `context_compress` | Request compression of old tool outputs on next turn |

## Commands

- `/checkpoint` — capture session state + consolidate MEMORY.md (SIMHash dedup)

## Compaction

When OpenCode compacts a session:
1. Capture raw messages to `checkpoint.md` via 5 heuristic extractors
2. Deduplicate MEMORY.md via SIMHash (acquired via file lock, zero race conditions)
3. Inject structured handoff prompt for LLM

No background LLM sessions, no `client.session.promptAsync`, no dream/distill.

## Storage

```
<project>/.deep-memory/
├── MEMORY.md                  persistent memory (200 line cap, user curated)
├── MEMORY-archive.md          overflow when cap is reached
├── checkpoint.md              last compaction extraction
├── .compaction-log.jsonl      compaction audit trail
└── .index-state.json          BM25 index mtime tracker
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEEP_MEMORY_DEBUG` | off | `1` = debug log, `trace` = +hook I/O |
| `DEEP_MEMORY_PROJECT_SUBDIR` | `.deep-memory` | Memory directory name |
| `DEEP_MEMORY_GLOBAL_ROOT` | `~/.local/share/opencode/deep-memory` | Cross-project memory |

## Development

```bash
npm install
npm run verify   # typecheck + test + build + smoke
```

## What V4 removed (and why)

| Feature | Failure mode | Replacement |
|---|---|---|
| Volatile BM25 injection in system prompt | Per-turn mutation degrades quality (Context Rot, 18 models) | Frozen TOOL_HINT + mtime-cached MEMORY.md |
| Dream/distill auto-generation | `promptAsync` fire-and-forget never worked (3 independent failure layers) | User-curated MEMORY.md + sync consolidation |
| Post-hoc tool output compression | Middle content lost mid-conversation | Capture-time caps (Cline pattern) |
| `[superseded by duplicate call]` | LLM mimics placeholder in output | `[OUTDATED]` signal |
| `[context-stripped]` orphan repair | Same | Removed entirely |
| `[ccr:<hash>]` dead-end markers | Stored but unretrievable | Actionable hint + working deep_expand |
| Memory nudge / pressure nudge XML | Contradicts pull-based model | Agent-initiated `context_compress` |
| Tier-based memory rendering (P1-P5) | Unnecessary complexity | Full MEMORY.md injected verbatim |

## Evidence base

V4 was designed through 3 rounds of research against production systems and academic literature.

### Production coding agents (7)

| Agent | Key insight borrowed |
|---|---|
| **Claude Code** | CLAUDE.md verbatim injection, user-curated, never auto-generated; 200-line/25KB hard cap |
| **Cline** | Capture-time tool output caps (bash 48K, read 50K); stale-read rewriting; 90% compaction trigger |
| **Aider** | No post-hoc tool compression; background recursive summarization |
| **Cursor** | Same-model self-summarization preserves quality |
| **Cody** | No compression at all — pure retrieval |
| **Copilot** | 4 cache-control breakpoints → 94% cache hit rate |
| **Continue** | Context-aware truncation direction |

### Memory systems surveyed (30+)

- **Mem0** — pull-based search, no auto-injection
- **Letta** — fixed-size memory blocks, agent-managed content mutation
- **Magic Context** — cache-stable deferred mutation; zero per-turn change
- **A-Mem** — proactive dedup/update prevents stale context accumulation
- **Cognee** — injects memory in user message, not system prompt (keeps prefix stable)
- **DCP** — LLM-initiated compress tool (model decides what to compress)
- **Headroom** — CCR store with lossless recovery
- **LLMLingua** — token-level perplexity compression (avoided: too aggressive for code)
- **Focus Agent** — agent-initiated `consolidate_learning` + persistent Knowledge block
- **Edgee** — protected-content patterns

### Academic papers

- [Lost in the Middle](https://arxiv.org/abs/2307.03172) — 20%+ accuracy drop for mid-prompt content (Liu et al., TACL 2024)
- [Context Rot](https://www.trychroma.com/research/context-rot) — all 18 tested models degrade with prompt length (Chroma 2025)
- [When2Tool](https://arxiv.org/abs/2605.09252) — LLMs know when to retrieve (AUROC 0.89-0.96) but fail to act; pure pull not viable (arxiv 2605.09252)
- [Self-RAG](https://arxiv.org/abs/2310.11511) — adaptive retrieval requires fine-tuning (arxiv 2310.11511)
- [Focus Agent](https://arxiv.org/html/2601.07190v1) — 22.7% token reduction, no accuracy loss (arxiv 2601.07190)

### Design decisions (stored in project memory)

- [V4 prohibits background/fire-and-forget patterns — dream/distill failure post-mortem]
- [6-layer architecture — all layers have production evidence]
- [D1: MEMORY.md 200 lines / 25KB — Claude Code source-enforced]
- [D3: capture-time caps, Cline defaults, configurable]
- [D5: MEMORY.md in system.transform with mtime caching — SDK constraint: messages.transform has no sessionID]

## License

MIT
