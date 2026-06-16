# opencode-deep-memory

> Persistent context intelligence for [OpenCode](https://github.com/anomalyco/opencode) — cross-session memory, compaction-resilient checkpoints, context-aware injection, and deterministic content compression. Zero runtime dependencies.

## Why?

OpenCode sessions are stateless across restarts. Every new session starts cold — no memory of past decisions, constraints, or gotchas. Native compaction destroys conversation content irreversibly.

**opencode-deep-memory** fixes this:

- **Persistent memory** — decisions, constraints, gotchas survive across sessions
- **Cross-session resume** — new sessions automatically recall everything
- **Compaction resilience** — checkpoint captures conversation before compaction destroys it
- **Context compression** — strips reasoning metadata and old content without LLM calls
- **Code structure awareness** — regex-based repo map gives the agent awareness of your codebase

## Installation

### Via npm (recommended)

```jsonc
// opencode.json
{
  "plugin": [
    "oh-my-openagent",
    "opencode-deep-memory",
    "@ramtinj95/opencode-tokenscope"
  ]
}
```

OpenCode auto-installs on startup.

### Via local path (development)

```jsonc
{
  "plugin": [
    "/path/to/opencode-deep-memory/dist/index.js"
  ]
}
```

## Features

### Persistent Memory (BM25 + CJK)

- **Zero-dependency BM25 engine** with CJK bigram tokenizer (25× faster than SQLite FTS5)
- Four tools: `memory_search`, `memory_store`, `memory_forget`, `memory_expand`
- Project-local storage at `<project>/.deep-memory/` (version-controllable)

### Adaptive Injection (m[0]/m[1] Cache-Stable)

- **Stable prefix**: constraints + rules — never changes per turn → prompt cache hit
- **Volatile suffix**: context-aware search results + repo map
- Agent-type-aware budgets: main 800t / oracle 400t / explore 80t
- Post-resume expansion: 3000t on first turn of new session

### Deterministic Content Compression (Zero LLM)

Strips from old messages (>8 turns ago, first 3 protected):

| What | Savings | Why safe |
|------|---------|----------|
| `reasoning_details` metadata | ~18.5% | API metadata, not model input |
| Old reasoning text → "[cleared]" | ~24% | Conclusions already in output |
| System-injected notifications | ~5% | Internal plumbing, no future value |
| Tool errors >100 chars | ~2% | Old errors only need "it failed" |
| Inline `<thinking>` tags | ~2% | Same as reasoning — process not product |

**Never touches**: user messages, recent 8 messages, tool calls/results.

### Repo Map (Code Structure Awareness)

- Regex-based symbol extraction for TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, Ruby
- Tracks files read by the agent, injects compact symbol list into system prompt
- Ranked by recency + frequency + Aider-style multipliers (private 0.3×, long names 1.5×)

### Checkpoint System

- **Compacting hook** captures full conversation before native compaction
- **5-pattern heuristic extraction**: user intents, decisions, constraints, gotchas, file changes
- **Idle-layer LLM enrichment**: background session cross-references and refines
- **Folded file context**: post-compaction checkpoint includes code symbols

### Dream Consolidation

- **Auto-dream** (7-day cycle or accumulation trigger): consolidates notes.md into MEMORY.md
- **Key-files verification**: dream agent verifies memories against actual source files
- **Auto-distill** (30-day cycle): packages recurring workflows into skill candidates

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEEP_MEMORY_DEBUG` | (off) | `1` = debug logs, `trace` = +hook I/O dump |
| `DEEP_MEMORY_PROJECT_SUBDIR` | `.deep-memory` | Project-local memory directory name |
| `DEEP_MEMORY_GLOBAL_ROOT` | `~/.local/share/opencode/deep-memory` | Global memory root |

### Storage Layout

```
<project>/.deep-memory/              # Project-local (visible, VCS-friendly)
├── MEMORY.md                          # Persistent decisions/constraints/gotchas
├── notes.md                           # Keyword captures
├── checkpoint.md                      # Last compaction extraction
├── .schedule.json                     # Dream/distill scheduling
└── sessions/<sid>/checkpoint.md       # Per-session archives

<globalRoot>/global/MEMORY.md          # Cross-project memory
```

## How It Works

```
Session created → resume detection (3000t budget)
                → auto-dream check (7-day cycle)

Each LLM turn → chat.params (record agent)
              → chat.message (keyword capture)
              → system.transform (m[0] stable + m[1] volatile)
              → messages.transform (strip old reasoning/metadata)
              → tool.execute.after (track reads → repo map)

Compaction → capture → heuristic extraction → checkpoint.md
```

## Comparison

| Feature | DCP | Magic Context | MiMo-Code | **deep-memory** |
|---------|-----|--------------|-----------|-----------------|
| Search | — | SQLite + embedding | SQLite FTS5 | **BM25 + CJK** |
| Compression | LLM (lossy) | 7 strip functions | — | **5 strip functions** |
| LLM dependency | Required | Optional | Required | **None** |
| Storage | Memory | SQLite | ~/.mimo/ hash | **`.deep-memory/` local** |
| Cache stability | — | m[0]/m[1] | — | **m[0]/m[1]** |
| Code awareness | — | — | — | **Repo Map** |
| Runtime deps | 0 | SQLite | SQLite | **0** |

## Development

```bash
git clone https://github.com/YOUR_GITHUB/opencode-deep-memory.git
cd opencode-deep-memory
npm install
npm run verify  # typecheck + test + build + smoke
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | tsup ESM build + d.ts |
| `npm test` | vitest (363 tests) |
| `npm run smoke` | CLI smoke test (49 checks) |
| `npm run verify` | typecheck + test + build + smoke |

## License

MIT
