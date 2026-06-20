# opencode-deep-memory

> Persistent memory, checkpoint resilience, and deterministic context compression for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

## What it does

| Layer | What survives | How |
|-------|--------------|-----|
| **Remember** | Decisions, constraints, gotchas | `memory_search` / `memory_store` — BM25 + CJK search |
| **Recover** | Full conversation context | Checkpoint before compaction; resume injection |
| **Compress** | Token budget | Deterministic stripping + pressure-triggered compression |

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

Memory appears at `.deep-memory/` in your project root.

## Context compression

Three layers, fully automatic, no LLM calls.

### Layer 1: Deterministic stripping (always active)

| Target | Action |
|--------|--------|
| Old reasoning/thinking parts | Physical removal |
| System injections (`<system-reminder>`, etc.) | Physical removal |
| Tool errors >100 chars (older than 4 turns) | Truncate |
| Inline `<thinking>` tags | Regex strip |

No marker pollution — old content is physically removed, not replaced with `[cleared]` or `[stripped]`.

### Layer 2: Deep compression (pressure-triggered)

| Pressure | Threshold | Actions |
|----------|-----------|---------|
| **always** | every turn | tool dedup + error purge + tool output compress + JSON crush |
| **medium** | ≥ 50K tokens | + memory nudge (prompts LLM to use `memory_store`) |
| **high** | ≥ 150K tokens | + pressure nudge (prompts LLM to summarize old tasks) |

Thresholds are absolute, not percentage-based — work consistently across 200K and 1M+ context windows.

| Target | Strategy |
|--------|----------|
| Duplicate tool calls | Signature matching |
| Old error inputs | Purge after 4 turns |
| File reads | Keep head + key lines + tail |
| Command outputs | Keep errors + tail |
| Search results | Keep top-20, group by file |
| JSON arrays | Head + dedup middle + tail |
| Subagent output | Headers + key lines + tail with [ccr:] preservation |
| Skill output | Frontmatter + MUST rules + structure headers |
| Nested JSON objects | Compress child arrays >30 items |

All compressed content is **reversible** via CCR — originals cached for 30 minutes with SHA-256 hash, retrievable via `deep_expand` tool.

**No compression** on protected tools: `question`, `edit`, `write`, `todowrite`, `memory_*`, `deep_expand`, `task`, `skill`.

## Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Search persistent memory (BM25 + CJK bigram) |
| `memory_store` | Store decisions, constraints, gotchas, facts, notes |
| `memory_forget` | Remove stale memory entries |
| `memory_expand` | Retrieve original content of a compressed message |
| `deep_expand` | Retrieve original content via CCR hash |

## Compaction

When OpenCode compacts a session:

1. **Capture** raw messages to `checkpoint.raw.json`
2. **Extract** knowledge via 5 heuristic extractors
3. **Write** structured `checkpoint.md`
4. **Inject** structured handoff prompt for LLM

## Memory consolidation

| Cycle | Trigger | Action |
|-------|---------|--------|
| **Auto-dream** | 7 days or notes.md >20 lines | Consolidate notes + checkpoints → MEMORY.md |
| **Auto-distill** | 30 days | Package recurring workflows → skill candidates |
| **Enrichment** | Session idle after compaction | LLM enriches checkpoint with cross-references |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEP_MEMORY_DEBUG` | off | `1` = debug log, `trace` = +hook I/O |
| `DEEP_MEMORY_PROJECT_SUBDIR` | `.deep-memory` | Memory directory name |
| `DEEP_MEMORY_GLOBAL_ROOT` | `~/.local/share/opencode/deep-memory` | Cross-project memory |

## Storage

```
<project>/.deep-memory/
├── MEMORY.md                   persistent decisions/constraints/gotchas
├── notes.md                    keyword captures
├── checkpoint.md               last compaction extraction
├── checkpoint.raw.json         raw messages dump
├── .schedule.json              dream/distill state
└── .compaction-log.jsonl       compaction audit trail
```

## Commands

- `/checkpoint` — manually capture session state
- `/dream` — consolidate notes into persistent memory
- `/distill` — package recurring workflows into skills

## Development

```bash
npm install
npm run verify   # typecheck + test + build + smoke
```

## Acknowledgments

[DCP](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning) · [Headroom](https://github.com/chopratejas/headroom) · [Edgee](https://github.com/edgee-ai/edgee) · [Contextomizer](https://github.com/GandalFran/contextomizer) · [Focus Agent](https://arxiv.org/html/2601.07190v1) · [LLMLingua](https://github.com/microsoft/LLMLingua) · [Codex CLI](https://github.com/openai/codex) · [Google ADK](https://github.com/google/adk-python) · [Hermes](https://github.com/NousResearch/hermes-agent)

## License

MIT
