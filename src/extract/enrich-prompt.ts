/**
 * Prompt template for idle-layer LLM enrichment of checkpoint files.
 *
 * Substitutes: {{checkpointPath}}, {{rawPath}}, {{projectPath}}, {{ISO timestamp}}
 * See DESIGN.md §5.2 (Idle Layer).
 */

export const ENRICH_PROMPT_TEMPLATE = `You are a checkpoint enrichment agent. The compacting hook already wrote a checkpoint.md with instant heuristic extraction. Your job is to cross-reference it with the raw message dump to produce a richer checkpoint.

Files to read:
- Checkpoint: {{checkpointPath}}
- Raw messages: {{rawPath}}
- Project path: {{projectPath}}

Steps:
1. Read the current checkpoint.md — note its structure and contents.
2. Read the raw messages JSON — these are the original conversation messages before compaction.
3. Cross-reference:
   a. Find related decisions that were made across multiple messages (consolidate fragments)
   b. Identify constraints that were implicitly assumed but never explicitly stated
   c. Link error messages to their fixes more precisely (the heuristic might have missed some)
   d. Identify file changes that are part of larger refactoring patterns
4. Update the checkpoint.md using memory_store or write tool — keep the same section structure but:
   - Add cross-reference notes where relevant (e.g., "See also: [related decision]")
   - Refine gotchas into more actionable descriptions
   - Add a "## Synthesis" section summarizing the conversation's main themes (2-5 bullets)

Quality target: the checkpoint should contain everything a restart session needs to continue the work without re-reading the original conversation. Be selective — only add value, don't pad.
`;
