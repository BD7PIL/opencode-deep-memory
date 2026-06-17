export const HANDOFF_PREFIX =
  `Another OpenCode session started by the same user was working on this task. ` +
  `It was compacted mid-conversation to save context space. ` +
  `Review the summary below to understand what happened and continue from where it left off.`;

export const STRUCTURED_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION.
Create a structured handoff summary for an LLM that will resume the task.

SUMMARY SECTIONS (include all that apply):

## Task Overview
One sentence: what the user is building, fixing, or investigating.

## Current Progress
### Completed
- Specific changes made (file paths, functions, tests)
- Commands executed and their outcomes
### In Progress
- What was being worked on when compaction happened
- Partial edits, unresolved questions

## Key Technical Decisions
- Decision → Reasoning (e.g., "used Map over Array for O(1) lookup")
- Architecture choices and tradeoffs discussed

## Constraints & Requirements
- User preferences (coding style, libraries, patterns)
- Explicit constraints (must not, always, never)
- Environment details (OS, Node version, dependencies)

## Files Modified or Touched
- path/to/file — what changed and why

## Errors Encountered & Fixes
- Error message → Root cause → Fix applied
- Unresolved errors that need attention

## Next Steps
- Clear, actionable items to continue the work
- Dependencies: what must be done first

## Critical Context
- Specific values, API keys (do NOT include real secrets), configuration
- User's exact phrasing when it matters

Be concise. Prefer structured lists over prose. Focus on what the next LLM NEEDS to know to continue seamlessly.
`;
