# opencode-deep-memory

> Persistent memory, checkpoint resilience, and deterministic context compression for [OpenCode](https://github.com/anomalyco/opencode) — zero runtime dependencies.

## What it does

OpenCode sessions are stateless. Every restart is a cold start. Native compaction destroys conversation content.

**deep-memory** adds three layers:

- **Remember** — decisions, constraints, gotchas survive across sessions via BM25 + CJK search
- **Recover** — checkpoint captures conversation before compaction destroys it; resume injection recalls everything
- **Compress** — strips reasoning metadata and old content deterministically, without LLM calls

## Quick start

```jsonc
// opencode.json
{
  "plugin": [
    "oh-my-openagent",
    "opencode-deep-memory"
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
┌──────────────┐    ┌──────────────┐ │  ┌──────────────┐
│ chat.message │    │  chat.params │ │  │messages.tfm  │
│ keyword→notes│    │ agent→budget │ │  │ strip old     │
│  "记住"/"rem" │    │ main 800t    │ │  │ reasoning +   │
│              │    │ oracle 400t  │ │  │ metadata +    │
└──────────────┘    └──────────────┘ │  │ errors        │
                                     │  └──────────────┘
                      ┌──────────────┘
                      │
┌─────────────────────┴───────────────────────┐
│                  event                      │
│  session.created → resume + dream schedule  │
│  session.idle    → enrichment               │
│  session.compacted → checkpoint             │
└─────────────────────────────────────────────┘
```

## Context compression (zero LLM)

Unlike DCP (LLM summarization), we strip deterministically:

| What gets stripped | Savings | Why safe |
|--------------------|---------|----------|
| `reasoning_details` metadata | ~18.5% | API metadata, not model input |
| Old reasoning → `[cleared]` | ~24% | Conclusions already in text output |
| System injections (`<system-reminder>`) | ~5% | Internal plumbing |
| Tool errors >100 chars | ~2% | Old errors only need "it failed" |
| Inline `<thinking>` tags | ~2% | Process, not product |

**Never touches**: user messages, recent 8 messages, tool calls, tool results.

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

## Commands

Copy `.opencode/command/*.md` to your project:

- `/checkpoint` — manually capture session state
- `/dream` — consolidate notes into persistent memory
- `/distill` — package recurring workflows into skills

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for full architecture.
See [docs/OPTIMIZATION-PLAN-v0.3.md](docs/OPTIMIZATION-PLAN-v0.3.md) for optimization history.

## Development

```bash
npm install
npm run verify   # typecheck + test (363) + build + smoke (49)
```

## License

MIT
