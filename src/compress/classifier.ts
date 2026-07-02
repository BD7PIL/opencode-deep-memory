/**
 * P1: Content-type classifier for context_compress decisions.
 *
 * Decides whether a tool output should be:
 * - preserve: keep as-is (protected tools like edit, memory_store)
 * - transient: head+tail truncation (bash, grep, glob)
 * - stale: mark as outdated (read of edited files)
 * - summarize: let LLM summary capture the essence (read, webfetch)
 */

const PRESERVE_TOOLS = new Set([
  "edit", "write", "todowrite", "question",
  "memory_store", "memory_search", "memory_forget", "memory_expand", "deep_expand",
  "skill", "context_compress",
]);

const TRANSIENT_TOOLS = new Set(["bash", "grep", "glob", "find", "search"]);

export type CompressionDecision = "preserve" | "transient" | "stale" | "summarize";

/**
 * Extract file path from a read tool output.
 * Read output typically starts with the file path on the first line.
 */
function extractFilePath(output: string): string | null {
  const firstLine = output.split("\n")[0]?.trim();
  if (!firstLine || firstLine.length > 200) return null;
  return firstLine;
}

export function classifyForCompression(
  toolName: string | undefined,
  output: string,
  recentEdits: Set<string> | undefined,
): CompressionDecision {
  if (!toolName) return "summarize";
  if (PRESERVE_TOOLS.has(toolName)) return "preserve";
  if (TRANSIENT_TOOLS.has(toolName)) return "transient";

  // Stale read detection: read tool on a file that was edited since
  if (toolName === "read" && recentEdits && recentEdits.size > 0) {
    const filePath = extractFilePath(output);
    if (filePath && recentEdits.has(filePath)) return "stale";
  }

  return "summarize";
}
