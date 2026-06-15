---
agent: sisyphus
description: Package recurring workflows into reusable skill candidates
---

Run workflow distillation now:

1. Read `.deep-memory/MEMORY.md` and `.deep-memory/notes.md` to identify recurring workflows (patterns of tool calls that appear 3+ times across sessions).
2. Read recent checkpoint.md files under `.deep-memory/sessions/` (last 10).
3. For each recurring workflow, draft a skill candidate as Markdown:
   - **Trigger**: when to use this workflow
   - **Steps**: ordered list of actions
   - **Tools**: which tools are involved
   - **Example**: one concrete instance from history
4. Use memory_store (type="fact", scope="project") to record each distilled workflow.
5. Write the skill candidates to `.deep-memory/distill-<ISO>.md` for human review.

Distillation is about reusable patterns, not one-off actions. Skip anything that happened only once.
