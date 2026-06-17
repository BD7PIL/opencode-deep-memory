/**
 * Distill executor — spawns a background session for workflow distillation.
 *
 * Creates a child session, sends it the distill prompt, and returns status.
 * On any error, logs and returns "failed" status without rethrowing.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import { memoryFilePath, scopeDir } from "../shared/index.js";
import type { Logger } from "../shared/index.js";

export const DISTILL_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface DistillExecutorOptions {
  client: PluginInput["client"];
  parentSessionID: string;
  projectPath: string;
  directory: string;
  model?: { providerID: string; modelID: string };
  logger?: Logger;
}

export const DISTILL_PROMPT_TEMPLATE = `You are a workflow distillation agent. Your task is to identify recurring patterns in the project's memory and package them as reusable skill candidates.

Project context:
- Project path: {{projectPath}}
- Memory file: {{memoryFilePath}}
- Notes file: {{notesFilePath}}
- Sessions dir: {{sessionsDir}}
- Output file: {{outputFilePath}}

Steps:
1. Read the memory file at {{memoryFilePath}} and the notes file at {{notesFilePath}}. Identify recurring workflows — patterns of tool calls or multi-step procedures that appear 3+ times across sessions.
2. Use the \`list\` tool to find checkpoint.md files under {{sessionsDir}}. Read the 10 most recent ones to find additional recurring patterns.
3. For each recurring workflow you identify, draft a skill candidate as Markdown with these sections:
   - **Trigger**: when to use this workflow (natural language description)
   - **Steps**: ordered list of concrete actions
   - **Tools**: which tools are involved
   - **Example**: one concrete instance from session history
4. Before storing each finding, call memory_search with a relevant phrase to avoid duplicating existing entries. Skip if a near-identical entry already exists.
5. Use memory_store with type="fact" and scope="project" to record each distilled workflow. Each entry must be at most 300 characters — be concise, no code blocks.
6. Write all skill candidates to {{outputFilePath}} for human review.

IMPORTANT: Only distill workflows related to the PROJECT DOMAIN (e.g., code patterns, testing procedures, deployment steps). Do NOT distill meta-patterns about the memory plugin itself (e.g., "user says 记住 → call memory_store"). Those are plugin internals, not reusable project knowledge.

VERIFICATION STEP (before storing each finding):
For each memory that references a specific source file:
1. Use the read tool to check the file still exists and contains the referenced symbol
2. If the file no longer exists or the referenced function/class/variable was removed/renamed:
   - Call memory_forget to remove the stale entry
   - Do NOT store the new finding
3. Only store memories that reference files and symbols that STILL EXIST in the codebase
4. Limit verification to 5 files maximum (do not read more than 5 files during this distill cycle)

Distillation is about reusable patterns, not one-off actions. Skip anything that happened only once.

When done, output a brief summary: "Distilled N workflow candidates."`;

function buildPrompt(projectPath: string): string {
  const memoryFilePathStr = memoryFilePath("project", "memory", projectPath);
  const notesFilePath = memoryFilePath("project", "notes", projectPath);
  const sessionsDir = scopeDir("project", projectPath) + "/sessions";
  const timestamp = new Date().toISOString();
  const outputFilePath = scopeDir("project", projectPath) + `/distill-${timestamp.slice(0, 10)}.md`;

  return DISTILL_PROMPT_TEMPLATE.replaceAll("{{projectPath}}", projectPath)
    .replaceAll("{{memoryFilePath}}", memoryFilePathStr)
    .replaceAll("{{notesFilePath}}", notesFilePath)
    .replaceAll("{{sessionsDir}}", sessionsDir)
    .replaceAll("{{outputFilePath}}", outputFilePath)
    .replaceAll("{{ISO timestamp}}", timestamp);
}

export async function runDistill(
  opts: DistillExecutorOptions,
): Promise<{ sessionID: string; status: "spawned" | "failed" }> {
  const { client, parentSessionID, projectPath, directory, logger } = opts;

  let distillSessionID = "";
  try {
    const result = await client.session.create({
      body: {
        parentID: parentSessionID,
        title: `Memory Distill Workflow Packaging ${new Date().toISOString().slice(0, 10)}`,
      },
      query: { directory },
    });

    distillSessionID = result.data?.id ?? "";

    if (!distillSessionID) {
      logger?.error("distill-executor: session.create returned no ID", {
        parentSessionID,
      });
      return { sessionID: "", status: "failed" };
    }

    const prompt = buildPrompt(projectPath);

    await client.session.promptAsync({
      path: { id: distillSessionID },
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

    logger?.info("distill-executor: distill session spawned", {
      distillSessionID,
      parentSessionID,
    });

    return { sessionID: distillSessionID, status: "spawned" };
  } catch (err) {
    logger?.error("distill-executor: failed to run distill", {
      distillSessionID,
      parentSessionID,
      error: err instanceof Error ? err.message : String(err),
    });
    return { sessionID: distillSessionID || "", status: "failed" };
  }
}
