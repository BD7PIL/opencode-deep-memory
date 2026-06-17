# opencode-deep-memory

> Persistent memory, checkpoint resilience, and deterministic context compression for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

## What it does

OpenCode sessions are stateless. Every restart is a cold start. Native compaction
destroys conversation content. **deep-memory** adds three layers:

| Layer | Hook | Purpose |
|-------|------|---------|
| **Remember** | `memory_search`, `memory_store`, `memory_forget`, `memory_expand` | Decisions, constraints, gotchas survive across sessions via BM25 + CJK search. Storage at `.deep-memory/` in your project root — visible, version-controllable. |
| **Recover** | `session.created`, `experimental.session.compacting` | Checkpoint captures conversation before compaction destroys it. Resume injection recalls everything on a new session (3000 token first-turn budget). |
| **Compress** | `experimental.chat.messages.transform` | Old reasoning, metadata, system injections, and thinking tags stripped deterministically — no LLM calls. Cache-stable sentinel replacements preserve prompt cache. |

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

OpenCode auto-installs on startup. Memory appears at `.deep-memory/` in your project root.

## How it works

```
                         ┌─────────────────────────────┐
                         │     system.transform         │
                         │   m[0] stable (cache hit)    │
                         │   m[1] volatile (per-turn)   │
                         │   repo map (code symbols)    │
                         └─────────────────────────────┘
                                     ▲
┌──────────────┐    ┌──────────────┐ │  ┌───────────────────────────┐
│ chat.message │    │  chat.params │ │  │      messages.transform   │
│ keyword→notes│    │ agent→budget │ │  │  ① Layer 1: strip reason. │
│  "记住"/"rem" │    │ main 800t    │ │  │  ② Layer 2: deep compress │
│              │    │ oracle 400t  │ │  │     dedup / error purge / │
└──────────────┘    └──────────────┘ │  │     tool compress / JSON / │
                                     │  │     message prune / CCR   │
                     ┌──────────────┘  └───────────────────────────┘
                     │
┌────────────────────┴────────────────────────┐
│                  event                      │
│  session.created → resume + dream schedule  │
│  session.idle    → enrichment + notify      │
│  session.compacted → checkpoint             │
└─────────────────────────────────────────────┘
```

## Context compression

Two compression layers run automatically, no LLM calls required.

### Layer 1: Deterministic stripping

Always active, strips disposable content from old messages:

| What gets stripped | How | Why safe |
|--------------------|-----|----------|
| `reasoning_details` metadata | Delete the JSON blob | Billing metadata, never reaches model |
| Old reasoning text | Replace with `[cleared]` | Conclusions are in assistant text |
| System injections | Replace with `[stripped]` | `<system-reminder>` stale after one turn |
| Tool errors >100 chars | Truncate | An old error only needs "it failed" |
| Inline `<thinking>` tags | Regex strip | Process, not product |

### Layer 2: Deep compression (pressure-triggered)

Activates when context pressure exceeds thresholds. Inspired by
[DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning),
[Headroom](https://github.com/chopratejas/headroom), and
[Edgee](https://github.com/edgee-ai/edgee).

| Pressure | Threshold | Actions |
|----------|-----------|---------|
| **low** | < 50% context | Layer 1 only |
| **medium** | 50–70% | + tool dedup + error purge + tool output compression |
| **high** | 70–85% | + JSON array crush + old message truncation + nudge |
| **critical** | > 85% | + aggressive nudge (model prompted to compress) |

What gets compressed at medium+:

| Target | Strategy | Source |
|--------|----------|--------|
| Duplicate tool calls | Signature matching (`toolName::sortedParams`) | DCP |
| Old error inputs | Purge inputs after 4 turns | DCP |
| File reads | Keep first 50 + key lines + last 20 | Edgee |
| Command outputs | Keep errors + last 30 lines | Edgee |
| Search results | Keep top-20, group by file | Edgee |
| JSON arrays | Keep first 30% + last 15% + dedup middle | Headroom SmartCrusher |
| Old assistant text | Extract key info (headings, code, errors) | DCP |

All compressed content is **reversible** via CCR (Compress-Cache-Retrieve):
originals are cached with SHA-256 hash and 5-minute TTL.
Models can retrieve them via the `deep_expand` tool.

**Never touched**: user messages, recent 8 messages, protected tools
(question, edit, write, todowrite, memory_store/search/forget).

## Toast notifications

After each LLM turn, deep-memory shows a toast notification (bottom-right corner) summarizing
what was compressed and injected. The notification level is chosen automatically:

| Scenario | Level | Content |
|----------|-------|---------|
| Injection only (no compression) | minimal | One-line summary: `-8.5K stripped` |
| Compression (short session) | detailed | Progress bar + per-category breakdown |
| Compression + rich context (repo-map, memory, checkpoint) | extended | Full panel with budget usage |

Example toast (detailed level):

```
deep-memory | compressed
─ Compression ─────────────────────────────
│████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│
  reasoning -6.2K | metadata -2.1K | tool_err -0.8K
─ Injection ───────────────────────────────
  m[0] stable 1055B ✓  m[1] volatile 574B
  tier=main | mode=normal
  repo-map: 12 symbols | memory: 8 entries
```

## Cache-stable injection

Each turn pushes two system prompt fragments:

- **Stable** (`<deep-memory-stable>`): constraints, rules, and the tool hint.
  These change only when MEMORY.md is updated — typically across sessions, not turns.
  Because they're byte-identical turn after turn, the provider's prompt cache hits on this prefix.

- **Volatile** (`<deep-memory-volatile>`): context-aware search results from the user's
  current query, tier-allocated by importance, plus repo map symbols for recently-read files.
  This is the only part that changes per turn.

The injection budget adapts to the agent: main orchestrator gets 800 tokens per turn
(3000 on session resume), deep-reasoning agents get 400, and tool subagents get 80.

## Memory search (BM25 + CJK bigram)

Instead of SQLite FTS5, we use a pure-JS BM25 engine with a CJK-aware tokenizer.
Chinese runs are split into sliding 2-character bigrams (`"权限死锁"` →
`["权","权限","限死","死锁","锁"]`), making multi-character CJK phrases searchable
without an embedding model. Latin text uses standard whitespace/punctuation splitting.
The index is rebuilt from Markdown files on startup (<250ms for 2000 entries) and
updated incrementally on writes.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEP_MEMORY_DEBUG` | off | `1` = debug log, `trace` = +hook I/O |
| `DEEP_MEMORY_PROJECT_SUBDIR` | `.deep-memory` | Memory directory name |
| `DEEP_MEMORY_GLOBAL_ROOT` | `~/.local/share/opencode/deep-memory` | Cross-project memory |

## Storage

```
<project>/.deep-memory/       ← version-controllable
├── MEMORY.md                   persistent decisions/constraints/gotchas
├── notes.md                    keyword captures
├── checkpoint.md               last compaction extraction
├── .schedule.json              dream/distill state
└── sessions/<sid>/              per-session archive
```

## Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Search persistent memory across sessions (BM25 + CJK) |
| `memory_store` | Store decisions, constraints, gotchas, facts, notes |
| `memory_forget` | Remove memory entries matching a query |
| `memory_expand` | Decompress a sentinel reference to its original content |
| `deep_expand` | Retrieve original content compressed by CCR (use `[ccr:HASH]` marker) |

## Commands

Copy `.opencode/command/*.md` to your project:

- `/checkpoint` — manually capture session state
- `/dream` — consolidate notes into persistent memory
- `/distill` — package recurring workflows into skills

## Design

**Memory entries** carry a type (`decision`, `constraint`, `gotcha`, `fact`, `note`) and
an importance score. Importance is heuristically derived from entry type, recency,
frequency across sessions, and keyword-match relevance to the current query —
no LLM calls required.

Entries are stored as Markdown sections (e.g. `## Decisions`, `## Constraints`) in
`MEMORY.md`, with `[date]` timestamps for time-based decay. The BM25 index is rebuilt
from these files on startup and updated incrementally on write.

Background consolidation runs on a 7-day cycle (auto-dream) plus an accumulation trigger
(when `notes.md` exceeds 20 lines). A separate 30-day cycle (auto-distill) packages
recurring workflows into skill candidates. Both use background sessions to avoid
consuming the main session's context budget.

## Acknowledgments

**[MiMo-Code][]** — a terminal-native AI coding assistant with persistent memory that keeps a
deep understanding of your project across sessions while continuously improving itself.

**[Magic Context][]** — unbounded context. Memory that manages itself. One session, for life.
The hippocampus for coding agents, part of CortexKit.

**[Aider][]** — AI pair programming in your terminal. Lets you pair program with LLMs to start
a new project or build on your existing codebase.

**[Roo Code][]** — a whole dev team of AI agents in your code editor.

**[Continue][]** — pioneering open-source coding agent, available as a CLI, VS Code extension,
and JetBrains plugin.

**[OpenHands][]** — Code Less, Make More. A community focused on AI-driven development.

**[Plandex][]** — an AI coding agent designed for large tasks and real world projects.

**[DCP][]** — Dynamic Context Pruning for OpenCode. Our tool deduplication, error purging,
and nudge system are inspired by DCP's architecture.

**[Headroom][]** — compress tool outputs, logs, files, RAG chunks for AI agents.
Our JSON array crush and CCR (Compress-Cache-Retrieve) are derived from Headroom's SmartCrusher.

**[Edgee][]** — agent gateway that compresses tokens before LLM providers.
Our per-tool compression strategies (read, bash, grep, glob) are inspired by Edgee's approach.

**[Contextomizer][]** — ultra-fast deterministic library for transforming bloated tool outputs.
Our content type detection pipeline is inspired by Contextomizer's approach.

[MiMo-Code]: https://github.com/XiaomiMiMo/MiMo-Code
[Magic Context]: https://github.com/cortexkit/magic-context
[Aider]: https://github.com/Aider-AI/aider
[Roo Code]: https://github.com/RooCodeInc/Roo-Code
[Continue]: https://github.com/continuedev/continue
[OpenHands]: https://github.com/All-Hands-AI/OpenHands
[Plandex]: https://github.com/plandex-ai/plandex
[DCP]: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
[Headroom]: https://github.com/chopratejas/headroom
[Edgee]: https://github.com/edgee-ai/edgee
[Contextomizer]: https://github.com/GandalFran/contextomizer

## Development

```bash
npm install
npm run verify   # typecheck + test (363) + build + smoke (49)
```

Stats: 54 source files, 27 test files (363 tests), 10 compress modules, 49 smoke checks.

## CI/CD (npm Trusted Publishing)

Releases use npm OIDC Trusted Publishing — no token needed. To set up for a fork:

1. **npmjs.com** → Package Settings → Trusted Publishers → Add:
   - Owner: your GitHub username
   - Repository: your fork name
   - Workflow filename: `publish.yml`
2. **package.json** → update `repository.url` to match your fork
3. **Push a tag** → GitHub Actions auto-publishes:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```

Requirements: npm CLI ≥ 11.5.1, Node.js ≥ 22, `id-token: write` permission, public repository.

## License

MIT
