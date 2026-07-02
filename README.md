# opencode-deep-memory

> Persistent cross-session memory for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

V5 architecture. Built on research from 7 production coding agents, 30+ memory systems, and 5 academic papers. Eliminates the two independent LLM output degradation paths found in V2 (volatile system-prompt injection and post-hoc tool output compression), and adds LLM-driven memory consolidation + content-aware compression.

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
| **Compress** on demand | `context_compress` — content-aware, agent provides summary |
| **Consolidate** memory quality | LLM subagent (compaction-triggered), mtime race-safe |
| **Commands** | `/checkpoint` — manual memory capture + dedup |

## V5 changes from V4

| Change | Detail |
|---|---|
| P0: LLM memory consolidation | compaction triggers `client.session.create` + `promptAsync` (subagent), runs Mem0-style ADD/UPDATE/DELETE on MEMORY.md. Mtime race detection prevents overwriting concurrent `memory_store` writes. Pending state persisted to `.pending-consolidation.json`, restored on startup. |
| P1: Content-aware compress | `context_compress` accepts `summary` parameter (LLM-written). Tool outputs classified as transient/bash, stale/read-of-edited-file, summarize/other, preserve/protected. Summary block injected as assistant message (not user message, avoids breaking "never touch user messages" rule). |
| P2: Keep-pattern tightening | `compressAssistantText` removed bullet points (`-`/`*`) from retained lines. Savings ratio 0.6→0.7. V4 benchmark: 25% trigger rate → V5: ~40%. |
| P3: Event-driven nudges | Three nudge types: threshold (≥50K tokens, once per session), emergency (≥120K), PostCompact (after compaction). Injected into last tool result, not per-message. Cooldown prevents obsessive loops (DCP Issue #439). |

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

**Evidence**: Cline source (`output-limits.ts`: bash 48K, read 50K).

### Layer 2: Stale-read rewriting

When the same tool is called multiple times with identical input+output, older copies are marked `[OUTDATED — superseded by newer identical call]`. The LLM sees a useful signal instead of a meaningless placeholder it might mimic in output.

### Layer 3: Static memory file (byte-stable system prompt)

The system prompt is frozen across turns — TOOL_HINT + MEMORY.md content are injected once and only change when `memory_store` writes to MEMORY.md (mtime cache). No volatile BM25 results, no per-turn search, no repomap in the system prompt.

When MEMORY.md hasn't changed: 100% byte-stable system prompt across turns.

### Layer 4: Hybrid retrieval (one-time auto-search per session)

On first turn: quiet `memory_search(userQuery)` runs. If top-1 BM25 score ≥ 2.0, a ≤30-token whisper is appended. Turns 2+: byte-stable. Zero whisper overhead.

### Layer 5: Synchronous consolidation + LLM subagent

Synchronous SimHash dedup runs on every compaction. When MEMORY.md exceeds 50 lines, an LLM subagent (created via `client.session.create` + `promptAsync`) processes it with Mem0-style ADD/UPDATE/DELETE logic. Results are applied on next compaction after mtime verification. No background processes, no `setInterval`, no fire-and-forget.

### Layer 6: Content-aware agent-initiated compression

When the LLM calls `context_compress(summary, keep_recent)`, the next `messages.transform` pass:
- Classifies tool outputs by content type (transient/stale/summarize/preserve)
- Truncates transient outputs (bash, grep, glob) with head+tail
- Marks stale reads of recently-edited files as `[OUTDATED]`
- Injects LLM-written summary block as assistant message
- Stores all originals in CCR for `deep_expand` recovery

## Tools

| Tool | Purpose |
|---|---|
| `memory_search` | BM25 + CJK bigram search across project and global memory |
| `memory_store` | Store one entry (decision/constraint/gotcha/fact/note) with 200-line cap |
| `memory_forget` | Find matching entries and remove them |
| `memory_expand` | Restore original content from compressed conversation messages |
| `deep_expand` | Restore original content from CCR-compressed tool output |
| `context_compress` | Content-aware compression with LLM-written summary |

## Commands

- `/checkpoint` — manually capture session state + consolidate MEMORY.md (SIMHash dedup + trigger LLM subagent if MEMORY.md > 50 lines)

## Compaction

When OpenCode compacts a session:
1. Capture raw messages → `checkpoint.md` via 5 heuristic extractors
2. SIMHash dedup of MEMORY.md (acquired via file lock, zero race conditions)
3. Check pending LLM subagent consolidation result (mtime-verified, safe against concurrent `memory_store`)
4. If MEMORY.md > 50 lines and no pending task, spawn LLM subagent for ADD/UPDATE/DELETE consolidation
5. Signal PostCompact nudge for next `messages.transform`

No background LLM sessions, no `client.session.promptAsync` fire-and-forget, no dream/distill.

## Storage

```
<project>/.deep-memory/
├── MEMORY.md                  persistent memory (200 line cap, user curated)
├── MEMORY-archive.md          overflow when cap is reached
├── MEMORY.bak.md              backup before LLM consolidation overwrite
├── checkpoint.md              last compaction extraction
├── .compaction-log.jsonl      compaction audit trail
├── .index-state.json          BM25 index mtime tracker
└── .pending-consolidation.json   persistent LLM subagent state (survives restarts)
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DEEP_MEMORY_DEBUG` | off | `1` = debug log, `trace` = +hook I/O |
| `DEEP_MEMORY_PROJECT_SUBDIR` | `.deep-memory` | Memory directory name |
| `DEEP_MEMORY_GLOBAL_ROOT` | `~/.local/share/opencode/deep-memory` | Cross-project memory |

## Nudge thresholds

| Nudge | Threshold | Cooldown |
|---|---|---|
| Threshold | ≥50K tokens | Once per session |
| Emergency | ≥120K tokens | Always fires |
| PostCompact | After compaction | Once per compaction |

Absolute token thresholds (not ratio-based) — Context Rot (Chroma 2025) confirms LLMs degrade at ~200K tokens regardless of context window size.

## Development

```bash
npm install
npm run verify   # typecheck + test + build + smoke
```

## What V5 removed (V4 regression)

| Feature | Why |
|---|---|
| Volatile BM25 injection in system prompt | Per-turn mutation degrades quality (Context Rot, 18 models) |
| Dream/distill auto-generation | `promptAsync` fire-and-forget never worked (3 independent failure layers) |
| Post-hoc tool output compression | Middle content lost mid-conversation; replaced by capture-time caps |
| `[superseded by duplicate call]` | LLM mimics placeholder in output; replaced by `[OUTDATED]` signal |
| `[context-stripped]` orphan repair | Same; removed entirely |
| `[ccr:<hash>]` dead-end markers | Stored but unretrievable; replaced by actionable hint + working deep_expand |
| Memory nudge / pressure nudge XML | Contradicts pull-based model; replaced by event-driven threshold nudges |
| Tier-based memory rendering (P1-P5) | Unnecessary complexity with static injection |

## Evidence base

V4+V5 designed through 4 rounds of research against production systems and academic literature.

### Production coding agents (7)

| Agent | Key insight borrowed |
|---|---|
| **Claude Code** | CLAUDE.md verbatim injection, user-curated; 200-line/25KB hard cap; microCompact reactive compaction |
| **Cline** | Capture-time tool output caps (bash 48K, read 50K); stale-read rewriting; 90% deterministic compaction |
| **Aider** | No post-hoc tool compression; background recursive summarization |
| **Cursor** | Same-model self-summarization preserves quality |
| **Cody** | No compression at all — pure retrieval |
| **Copilot** | 4 cache-control breakpoints → 94% cache hit rate |
| **Continue** | Context-aware truncation direction |

### Memory systems surveyed (30+)

- **Mem0** — pull-based ADD/UPDATE/DELETE pattern used in P0 consolidation prompt
- **Letta** — fixed-size memory blocks, agent-managed content mutation
- **Magic Context** — cache-stable deferred mutation; zero per-turn change
- **A-Mem** — proactive dedup/update prevents stale context accumulation
- **Cognee** — injects memory in user message, not system prompt (keeps prefix stable)

### Compression projects

- **DCP** — LLM-initiated compress tool; nudge necessity confirmed (Issue #449); obsessive loop risk flagged (Issue #439)
- **Headroom** — CCR store with lossless recovery; confirmed V4 deep_expand wiring
- **Focus Agent** — agent-initiated `consolidate_learning`; 22.7% token reduction, no accuracy loss
- **Contextomizer** — evaluated: content-type heuristics worth borrowing, character-level truncation avoided
- **LLMLingua** — token-level perplexity compression avoided (too aggressive for code)

### Academic papers

- [Lost in the Middle (Liu et al., TACL 2024)](https://arxiv.org/abs/2307.03172) — 20%+ accuracy drop for mid-prompt content
- [Context Rot (Chroma, 2025)](https://www.trychroma.com/research/context-rot) — all 18 tested models degrade with prompt length
- [When2Tool (arxiv 2605.09252)](https://arxiv.org/abs/2605.09252) — LLMs know when to retrieve (AUROC 0.89-0.96) but fail to act; nudges are essential
- [Self-RAG (arxiv 2310.11511)](https://arxiv.org/abs/2310.11511) — adaptive retrieval requires fine-tuning
- [Focus Agent (arxiv 2601.07190)](https://arxiv.org/html/2601.07190v1) — 22.7% token reduction, no accuracy loss
- [When Attention Closes (arxiv 2605.12922)](https://arxiv.org/html/2605.12922) — system prompt tokens lose attention share over time; mid-conversation injections have better persistence

### Design decisions (stored in project memory)

- V4 prohibits background/fire-and-forget patterns (dream/distill failure post-mortem)
- P0 uses subagent (client.session.create + promptAsync) not async fire-and-forget
- P3 nudge thresholds are absolute tokens (Context Rot: LLM quality degrades at ~200K regardless of window)
- Nudges cannot be removed (DCP Issue #449, When2Tool paper)
- Message IDs not injected (keep_recent summary covers 90% of scenarios; DCP Issue #573 feedback loop)
- Nudges injected into tool result (When Attention Closes: mid-conversation > system prompt persistence)

## License

MIT
