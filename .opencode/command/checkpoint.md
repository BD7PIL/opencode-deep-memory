---
agent: build
description: Consolidate persistent memory — dedup + purge stale entries + enforce size cap
---

Run the memory consolidation now:

1. Read the current MEMORY.md at `.deep-memory/MEMORY.md`.
2. The plugin's `consolidateMemory` function will:
   - Remove exact and near-duplicate entries (SimHash similarity ≥ 0.92)
   - Purge stale entries whose `file:symbol:hash` binding no longer matches (use `read` to verify any entries referencing specific files)
3. After consolidation, confirm: how many entries were kept, how many removed.
4. If MEMORY.md exceeds 200 lines after consolidation, move overflow to `.deep-memory/MEMORY-archive.md`.

Then summarize the current memory state for the user: total entries by type (decisions, constraints, gotchas, facts, notes).
