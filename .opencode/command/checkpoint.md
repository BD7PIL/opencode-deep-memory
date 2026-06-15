---
agent: build
description: Capture current session state to checkpoint before risky operation
---

Run the memory checkpoint capture now:

1. Call memory_search to recall any prior decisions about the current task (avoids re-deciding).
2. Summarize the current session state: what we've decided, what we're working on, any constraints discovered.
3. Use memory_store (type="decision", scope="project") for each confirmed decision.
4. Use memory_store (type="constraint", scope="project") for each hard constraint.
5. Use memory_store (type="gotcha", scope="project") for any error→fix pair discovered.

After capture, confirm what was saved. Be selective — only store findings that will matter in future sessions.
