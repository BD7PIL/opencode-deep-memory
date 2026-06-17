/**
 * Dream executor — spawns a background session for memory consolidation.
 *
 * Creates a child session, sends it the dream prompt, and returns status.
 * On any error, logs and returns "failed" status without rethrowing.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { memoryFilePath, scopeDir } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

export interface DreamExecutorOptions {
  client: PluginInput["client"];
  parentSessionID: string;
  projectPath: string;
  directory: string;
  model?: { providerID: string; modelID: string };
  logger?: Logger;
}

export const DREAM_PROMPT_TEMPLATE = `You are a memory consolidation agent. Your task is to refine the project's persistent memory by reviewing raw notes and checkpoints, then storing durable findings.

Project context:
- Project path: {{projectPath}}
- Notes file: {{notesFilePath}}
- Sessions dir: {{sessionsDir}}

Steps:
1. Read the notes file at {{notesFilePath}}. These are raw captures from recent sessions (user messages with trigger keywords like "记住", "remember", "decided").
2. Use the \`list\` tool to find checkpoint.md files under {{sessionsDir}}. Read the 5 most recent ones.
3. Identify recurring themes across notes + checkpoints:
   - Decisions that have been confirmed or acted upon (call memory_store with type="decision")
   - Hard constraints or rules the user explicitly stated (call memory_store with type="constraint")
   - Gotchas, errors, and their fixes (call memory_store with type="gotcha")
   - Important facts about the codebase or domain (call memory_store with type="fact")
4. Before storing each finding, call memory_search with a relevant phrase to avoid duplicating existing entries. Skip if a near-identical entry already exists.
5. After storing all findings, append a section to {{notesFilePath}}:
   ## Consolidated {{ISO timestamp}}
   (Move processed entries under this header — do NOT delete them, preserve audit trail.)

VERIFICATION STEP (before storing each finding):
For each memory that references a specific source file:
1. Use the read tool to check the file still exists and contains the referenced symbol
2. If the file no longer exists or the referenced function/class/variable was removed/renamed:
   - Call memory_forget to remove the stale entry
   - Do NOT store the new finding
3. Only store memories that reference files and symbols that STILL EXIST in the codebase
4. Limit verification to 5 files maximum (do not read more than 5 files during this dream cycle)

Be selective: only store findings that will matter in future sessions. Skip transient details, tool output noise, and one-off questions. Aim for 5-15 high-quality entries per dream cycle.

IMPORTANT: Only consolidate findings about the PROJECT DOMAIN. Do NOT store meta-patterns about the memory plugin itself (e.g., "user says 记住 → call memory_store"). Those are plugin internals, not project knowledge.

When done, output a brief summary: "Consolidated N findings (D decisions, C constraints, G gotchas, F facts)."`;

function buildPrompt(projectPath: string): string {
  const notesFilePath = memoryFilePath("project", "notes", projectPath);
  const sessionsDir = scopeDir("project", projectPath) + "/sessions";
  const timestamp = new Date().toISOString();

  return DREAM_PROMPT_TEMPLATE.replaceAll("{{projectPath}}", projectPath)
    .replaceAll("{{notesFilePath}}", notesFilePath)
    .replaceAll("{{sessionsDir}}", sessionsDir)
    .replaceAll("{{ISO timestamp}}", timestamp);
}

export async function runDream(
  opts: DreamExecutorOptions,
): Promise<{ sessionID: string; status: "spawned" | "failed" }> {
  const { client, parentSessionID, projectPath, directory, logger } = opts;

  let dreamSessionID = "";
  try {
    const result = await client.session.create({
      body: {
        parentID: parentSessionID,
        title: `Memory Dream Consolidation ${new Date().toISOString().slice(0, 10)}`,
      },
      query: { directory },
    });

    dreamSessionID = result.data?.id ?? "";

    if (!dreamSessionID) {
      logger?.error("dream-executor: session.create returned no ID", {
        parentSessionID,
      });
      return { sessionID: "", status: "failed" };
    }

    const prompt = buildPrompt(projectPath);

    await client.session.promptAsync({
      path: { id: dreamSessionID },
      body: {
        parts: [{ type: "text", text: prompt }],
        agent: "general",
        ...(opts.model ? { model: opts.model } : {}),
        tools: {
          memory_search: true,
          memory_store: true,
          memory_forget: true,
          read: true,
          list: true,
        },
      },
    });

    logger?.info("dream-executor: dream session spawned", {
      dreamSessionID,
      parentSessionID,
    });

    return { sessionID: dreamSessionID, status: "spawned" };
  } catch (err) {
    logger?.error("dream-executor: failed to run dream", {
      dreamSessionID,
      parentSessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sessionID: dreamSessionID || "", status: "failed" };
  }
}
