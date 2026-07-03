interface SessionMessage {
  info?: { role?: string };
  parts?: Array<{ type?: string; text?: string; tool?: string; state?: { output?: string } }>;
}

function extractText(msg: SessionMessage): string {
  if (!msg.parts) return "";
  const texts: string[] = [];
  for (const part of msg.parts) {
    if (part.type === "text" && part.text) {
      texts.push(part.text);
    } else if (part.type === "tool" && part.tool && part.state?.output) {
      const output = part.state.output.length > 500
        ? part.state.output.slice(0, 200) + "\n...[truncated]...\n" + part.state.output.slice(-200)
        : part.state.output;
      texts.push(`[${part.tool}]\n${output}`);
    }
  }
  return texts.join("\n");
}

export function buildCompressionPrompt(messages: SessionMessage[]): string {
  const conversation = messages
    .map((msg, i) => {
      const role = msg.info?.role ?? "unknown";
      const text = extractText(msg);
      if (!text.trim()) return "";
      return `[${i}] ${role}:\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  return `You are performing CONTEXT COMPRESSION. Create a handoff summary for another LLM that will continue the work.

Extract and condense the conversation below into a structured summary. Output ONLY the summary text, nothing else.

Include:
- Goal: What the user is trying to accomplish
- Key Decisions: Architecture choices, tradeoffs, and their rationale
- Constraints: User-stated rules, preferences, and limitations
- Progress: What has been completed, which files were modified
- Errors & Fixes: Problems encountered and how they were resolved
- Current State: What is happening right now, what is the next step

Be concise. Preserve file paths, function names, and error messages verbatim. Omit routine operations and failed attempts unless they contain lessons learned.

Conversation to compress:
---
${conversation}
---`;
}
