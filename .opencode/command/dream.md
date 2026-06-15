---
agent: sisyphus
description: Consolidate notes and checkpoints into persistent memory
---

Run memory consolidation now:

1. Read the notes.md file at `.deep-memory/notes.md` in the current project.
2. Read recent checkpoint.md files under `.deep-memory/sessions/` (last 5).
3. Identify themes worth persisting (decisions confirmed multiple times, hard constraints, recurring gotchas).
4. For each finding, call memory_search first to avoid duplicates, then memory_store with appropriate type.
5. After processing, append a `## Consolidated <ISO>` header to notes.md above the processed entries.

Be selective: only store findings that will matter in future sessions. Aim for 5-15 high-quality entries per dream cycle.
