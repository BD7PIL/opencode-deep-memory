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

## Context compression

Old messages (>8 turns) are compressed deterministically, without calling an LLM.
The key insight: **reasoning is a disposable process** — once the model reaches a conclusion
(in the text or tool output), the reasoning that got it there no longer affects future turns.
Similarly, API metadata, system notifications, and inline thinking tags carry no value
once the conversation moves past them. We strip these in-place, replacing removed parts
with sentinels so message structure stays intact and prompt caching is preserved.

| What gets stripped | How | Why safe |
|--------------------|-----|----------|
| `reasoning_details` metadata | Delete the JSON blob from the part | API billing metadata, never reaches the model |
| Old reasoning text | Set `thinking`/`text` to `"[cleared]"` | Conclusions are in the assistant's text output |
| System injections | Replace entire message with sentinel | `<system-reminder>` and OMO markers are stale after one turn |
| Tool errors >100 chars | Truncate to first 100 chars | An old error only needs "it failed", not the full trace |
| Inline `<thinking>` tags | Regex strip from old assistant text | Same as reasoning — process, not product |

**Never touched**: user messages (anchor turn boundaries), recent 8 messages (working context),
tool calls and their results (API pairing integrity).

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

[MiMo-Code]: https://github.com/XiaomiMiMo/MiMo-Code
[Magic Context]: https://github.com/cortexkit/magic-context
[Aider]: https://github.com/Aider-AI/aider
[Roo Code]: https://github.com/RooCodeInc/Roo-Code
[Continue]: https://github.com/continuedev/continue
[OpenHands]: https://github.com/All-Hands-AI/OpenHands
[Plandex]: https://github.com/plandex-ai/plandex

## Development

```bash
npm install
npm run verify   # typecheck + test (363) + build + smoke (49)
```

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
