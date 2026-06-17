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

Two layers, fully automatic, no LLM calls.

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
| Old assistant text | Preserve structure, compress prose | [LLMLingua][] |

All compressed content is **reversible** via CCR (Compress-Cache-Retrieve) — originals cached with SHA-256 hash, retrievable via `deep_expand` tool.

**Never touched**: user messages, recent 4K tokens, protected tools (question, edit, write, todowrite, memory_*).

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

**[Focus Agent][]** — autonomous memory management for coding agents.
Our absolute token thresholds and assistant text compression strategy are based on Focus Agent's research.

**[LLMLingua][]** — prompt compression for LLMs.
Our selective assistant text compression (preserve structure, compress prose) is inspired by LLMLingua's approach.

**[Codex CLI][]** — OpenAI's coding agent.
Our handoff prefix pattern (telling the LLM it's resuming a prior task) is based on Codex CLI's compaction protocol.

**[Google ADK][]** — Agent Development Kit with append-only event compaction.
Our structured compaction prompt (Hermes-8 sections) is inspired by ADK's compaction architecture.

**[Hermes][]** — production-grade compaction prompt design.
Our 8-section checkpoint template follows Hermes's structured summary format.

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
[Focus Agent]: https://arxiv.org/html/2601.07190v1
[LLMLingua]: https://github.com/microsoft/LLMLingua
[Codex CLI]: https://github.com/openai/codex
[Google ADK]: https://github.com/google/adk-python
[Hermes]: https://github.com/NousResearch/hermes-agent

## License

MIT
