# opencode-deep-memory

> Persistent memory, checkpoint resilience, and deterministic context compression for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

## What it does

OpenCode sessions are stateless. Every restart is a cold start. Native compaction
destroys conversation content. **deep-memory** adds three layers:

| Layer | What survives | How |
|-------|--------------|-----|
| **Remember** | Decisions, constraints, gotchas | `memory_search` / `memory_store` — BM25 + CJK search across sessions |
| **Recover** | Full conversation context | Checkpoint captures before compaction; resume injection on new session |
| **Compress** | Token budget | Deterministic stripping + pressure-triggered deep compression — no LLM calls |

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
┌─────────────────────────────────────────────────────────────────┐
│  messages.transform (every turn)                                │
│  ├─ Strip reasoning/thinking parts (physical removal)           │
│  ├─ Remove system-injected messages (physical removal)          │
│  ├─ Truncate old tool errors                                    │
│  └─ Deep compress: dedup / tool output / JSON / assistant text  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  system.transform (every turn)                                  │
│  ├─ Inject stable: MEMORY.md constraints + tool hint (cache hit)│
│  └─ Inject volatile: BM25 search results + repo map symbols     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  compacting (before OpenCode destroys messages)                 │
│  ├─ Capture raw messages → checkpoint.raw.json                  │
│  ├─ Extract knowledge → checkpoint.md                           │
│  └─ Inject structured handoff prompt for LLM                    │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  events                                                         │
│  ├─ session.created → resume + dream schedule                   │
│  ├─ session.idle    → enrichment                                │
│  └─ session.compacted → pressure calibration                    │
└─────────────────────────────────────────────────────────────────┘
```

## Context compression

Three layers, fully automatic, no LLM calls.

### Layer 1: Deterministic stripping (always active)

| Target | Action |
|--------|--------|
| Old reasoning/thinking parts | Physical removal |
| System injections (`<system-reminder>`, etc.) | Physical removal |
| Tool errors >100 chars (older than 4 turns) | Truncate |
| Inline `<thinking>` tags | Regex strip |

No marker pollution — old content is physically removed, not replaced with `[cleared]` or `[stripped]`. This prevents [context confusion](https://www.philschmid.de/context-engineering-part-2).

### Layer 2: Deep compression (pressure-triggered)

| Pressure | Threshold | Actions |
|----------|-----------|---------|
| **always** | every turn | tool dedup + error purge + tool output compress + JSON crush + assistant text compress |
| **medium** | ≥ 50K tokens | + memory nudge (prompts LLM to use `memory_store`) |
| **high** | ≥ 150K tokens | + pressure nudge (prompts LLM to summarize old tasks) |

Thresholds are absolute, not percentage-based — they work consistently across 200K and 1M+ context windows. Based on [Focus Agent](https://arxiv.org/html/2601.07190v1) research.

| Target | Strategy | Source |
|--------|----------|--------|
| Duplicate tool calls | Signature matching | [DCP][] |
| Old error inputs | Purge after 4 turns | [DCP][] |
| File reads | Keep head + key lines + tail | [Edgee][] |
| Command outputs | Keep errors + tail | [Edgee][] |
| Search results | Keep top-20, group by file | [Edgee][] |
| JSON arrays | Head + dedup middle + tail | [Headroom][] |
| Subagent output | Headers + key lines + tail with [ccr:] preservation | [Claude Code][] |
| Skill output | Frontmatter + MUST rules + structure headers | [Claude Code][] |
| Nested JSON objects | Compress child arrays >30 items | This project |
| Old assistant text | Preserve structure, compress prose | [LLMLingua][] |

All compressed content is **reversible** via CCR (Compress-Cache-Retrieve) — originals cached for 30 minutes with SHA-256 hash, retrievable via `deep_expand` tool. 

**No compression** on protected tools: `question`, `edit`, `write`, `todowrite`, `memory_*`, `deep_expand`, `task`, `skill`. These tools' outputs contain verification data (LSP diagnostics, subagent decisions) essential for the agent to function correctly.

**Post-compression re-read**: after compression modifies content, recent modified files are listed in a `<dm-nudge>` so the agent can re-verify if needed — inspired by Claude Code's `onCompact` callback.

## Memory nudge

Detects decisions, constraints, and fixes in conversation — nudges the LLM to persist them.

| Pattern | Example | Nudge |
|---------|---------|-------|
| Decision | "我决定用 PostgreSQL" / "I'll use PostgreSQL" | `memory_store(type="decision")` |
| Constraint | "不能用 eval()" / "must not use eval()" | `memory_store(type="constraint")` |
| Error fix | "修复了权限问题" / "fixed the permission error" | `memory_store(type="gotcha")` |

English + Chinese. Pressure nudge and memory nudge have independent cooldowns.

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
4. **Inject** Hermes-8 structured prompt + Codex-style handoff prefix

The LLM produces: Task Overview → Progress → Key Decisions → Constraints → Files Modified → Errors → Next Steps → Critical Context

## Memory consolidation

| Cycle | Trigger | Action |
|-------|---------|--------|
| **Auto-dream** | 7 days or notes.md >20 lines | Consolidate notes + checkpoints → MEMORY.md |
| **Auto-distill** | 30 days | Package recurring workflows → skill candidates |
| **Enrichment** | Session idle after compaction | LLM enriches checkpoint with cross-references |

New projects: MEMORY.md auto-bootstraps from notes.md. Both agents have `memory_forget` enabled.

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
├── .compaction-log.jsonl       compaction audit trail
└── sessions/<sid>/             per-session archive
```

## Commands

- `/checkpoint` — manually capture session state
- `/dream` — consolidate notes into persistent memory
- `/distill` — package recurring workflows into skills

## Development

```bash
npm install
npm run verify   # typecheck + test (363) + build + smoke (49)
```

## Acknowledgments

**[DCP][]** — Dynamic Context Pruning for OpenCode. Tool dedup, error purge, and nudge system.

**[Headroom][]** — JSON array crush and CCR (Compress-Cache-Retrieve).

**[Edgee][]** — Per-tool compression strategies (read, bash, grep, glob).

**[Contextomizer][]** — Content type detection pipeline.

**[Focus Agent][]** — Absolute token thresholds and assistant text compression research.

**[LLMLingua][]** — Selective compression: preserve structure, compress prose.

**[Codex CLI][]** — Handoff prefix pattern for compaction continuity.

**[Google ADK][]** — Append-only event compaction architecture.

**[Hermes][]** — 8-section structured compaction prompt design.

**[MiMo-Code][]** — Terminal-native AI coding assistant with persistent memory.

**[Magic Context][]** — Unbounded context for coding agents.

**[Aider][]** — AI pair programming in your terminal.

**[Roo Code][]** — A whole dev team of AI agents in your code editor.

**[Continue][]** — Pioneering open-source coding agent.

**[OpenHands][]** — Code Less, Make More.

**[Plandex][]** — AI coding agent for large tasks and real world projects.

[DCP]: https://github.com/Opencode-DCP/opencode-dynamic-context-pruning
[Headroom]: https://github.com/chopratejas/headroom
[Edgee]: https://github.com/edgee-ai/edgee
[Contextomizer]: https://github.com/GandalFran/contextomizer
[Focus Agent]: https://arxiv.org/html/2601.07190v1
[LLMLingua]: https://github.com/microsoft/LLMLingua
[Codex CLI]: https://github.com/openai/codex
[Google ADK]: https://github.com/google/adk-python
[Hermes]: https://github.com/NousResearch/hermes-agent
[MiMo-Code]: https://github.com/XiaomiMiMo/MiMo-Code
[Magic Context]: https://github.com/cortexkit/magic-context
[Aider]: https://github.com/Aider-AI/aider
[Roo Code]: https://github.com/RooCodeInc/Roo-Code
[Continue]: https://github.com/continuedev/continue
[OpenHands]: https://github.com/All-Hands-AI/OpenHands
[Plandex]: https://github.com/plandex-ai/plandex

## License

MIT
