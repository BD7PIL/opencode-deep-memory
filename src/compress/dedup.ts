import type { PluginState } from "../hooks/shared-state.js";

const PROTECTED_TOOLS = new Set([
  "question", "edit", "write", "todowrite", "todoread",
  "memory_store", "memory_search", "memory_forget", "memory_expand",
  "deep_expand",
]);

const NEVER_DEDUP = new Set(["read", "bash", "grep", "glob", "find", "search"]);

const KEEP_RECENT = 5;
const PROTECTED_HEAD = 2;

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
  const totalMessages = messages.length;
  if (totalMessages <= KEEP_RECENT + PROTECTED_HEAD) return 0;

  const protectedTailStart = totalMessages - KEEP_RECENT;
  const seen = new Map<string, { msgIdx: number; outputHash: string }>();

  for (let i = PROTECTED_HEAD; i < protectedTailStart; i++) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool") continue;

      const toolName = p["tool"] as string | undefined;
      const callID = p["callID"] as string | undefined;
      if (!toolName || !callID) continue;
      if (PROTECTED_TOOLS.has(toolName)) continue;
      if (NEVER_DEDUP.has(toolName)) continue;

      const status = (p["state"] as Record<string, unknown>)?.["status"];
      if (status !== "completed") continue;

      const toolState = p["state"] as Record<string, unknown>;
      const output = toolState["output"];
      if (typeof output !== "string") continue;
      if (output === "[superseded by duplicate call]") continue;
      if (output.includes("[ccr:")) continue;

      const input = toolState["input"] as Record<string, unknown> | undefined;
      const signature = createToolSignature(toolName, input);
      const outputHash = simpleHash(output);

      const existing = seen.get(signature);
      if (existing) {
        if (existing.outputHash === outputHash) {
          const prevMsg = messages[existing.msgIdx];
          for (const prevPart of prevMsg.parts) {
            if (typeof prevPart !== "object" || prevPart === null) continue;
            const pp = prevPart as Record<string, unknown>;
            if (pp["type"] !== "tool") continue;
            const ppState = pp["state"] as Record<string, unknown> | undefined;
            if (ppState?.["output"] === "[superseded by duplicate call]") continue;
            if (typeof ppState?.["output"] === "string" && simpleHash(ppState["output"]) === outputHash) {
              ppState["output"] = "[superseded by duplicate call]";
              deduped++;
            }
          }
        }
        seen.set(signature, { msgIdx: i, outputHash });
      } else {
        seen.set(signature, { msgIdx: i, outputHash });
      }
    }
  }

  return deduped;
}

function simpleHash(s: string): string {
  const len = s.length;
  const sampleSize = 500;
  let h = len;
  for (let i = 0; i < Math.min(len, sampleSize); i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  const tailStart = Math.max(sampleSize, len - sampleSize);
  for (let i = tailStart; i < len; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `${len}:${h.toString(36)}`;
}
