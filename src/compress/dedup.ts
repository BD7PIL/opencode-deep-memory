import type { PluginState } from "../hooks/shared-state.js";

const PROTECTED_TOOLS = new Set(["question", "edit", "write", "todowrite", "todoread", "memory_store", "memory_search", "memory_forget"]);

export function createToolSignature(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return tool;
  const sorted = Object.keys(args).sort().map(k => `${k}:${JSON.stringify(args[k])}`).join(",");
  return `${tool}::${sorted}`;
}

export function deduplicateToolOutputs(
  messages: Array<{ info: { role: string }; parts: unknown[] }>,
  state: PluginState,
): number {
  let deduped = 0;
  const seen = new Map<string, string>();

  for (const msg of messages) {
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool") continue;

      const toolName = p["tool"] as string | undefined;
      const callID = p["callID"] as string | undefined;
      if (!toolName || !callID) continue;
      if (PROTECTED_TOOLS.has(toolName)) continue;

      const status = (p["state"] as Record<string, unknown>)?.["status"];
      if (status !== "completed") continue;

      const toolState = p["state"] as Record<string, unknown>;
      const input = toolState["input"] as Record<string, unknown> | undefined;
      const signature = createToolSignature(toolName, input);

      const existing = seen.get(signature);
      if (existing && existing !== callID) {
        toolState["output"] = "[superseded by duplicate call]";
        state.recordToolSignature(callID, signature);
        deduped++;
      } else {
        seen.set(signature, callID);
        state.recordToolSignature(callID, signature);
      }
    }
  }

  return deduped;
}
