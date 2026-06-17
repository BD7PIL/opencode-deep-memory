interface MessagePart {
  type?: string;
  text?: string;
  state?: {
    status?: string;
    output?: string;
    error?: string;
  };
}

interface Message {
  info: { role: string };
  parts: MessagePart[];
}

interface MemoryNudgeResult {
  injected: boolean;
  type: string | null;
}

const MEMORY_NUDGE_COOLDOWN = 3;

const DECISION_PATTERNS = [
  /\b(?:decided|decision|chose|chosen|picked|selected)\b/i,
  /\b(?:采用|选择|决定|确定|选用)\b/,
  /\b(?:use|using|go with|went with)\b.*\b(?:because|since|due to)\b/i,
];

const CONSTRAINT_PATTERNS = [
  /\b(?:must not|cannot|should not|do not|never|always)\b/i,
  /\b(?:constraint|restriction|limitation|requirement)\b/i,
  /\b(?:不能|必须|禁止|约束|限制|要求|务必)\b/,
];

const ERROR_FIX_PATTERNS = [
  /\b(?:fix|fixed|resolve|resolved|patch|corrected)\b/i,
  /\b(?:修复|修复了|解决|解决了)\b/,
  /\b(?:the (?:bug|error|issue) (?:was|is)|root cause)\b/i,
];

export function detectMemoryNudge(
  messages: Message[],
  messagesSinceLastNudge: number,
): MemoryNudgeResult {
  if (messagesSinceLastNudge < MEMORY_NUDGE_COOLDOWN) {
    return { injected: false, type: null };
  }

  const protectedTail = Math.max(0, messages.length - 3);
  const recentMessages = messages.slice(protectedTail);

  const recentAssistantText = recentMessages
    .filter(m => m.info.role === "assistant")
    .flatMap(m => m.parts.filter((p): p is MessagePart => p.type === "text").map(p => p.text || ""))
    .join("\n");

  const recentUserText = recentMessages
    .filter(m => m.info.role === "user")
    .flatMap(m => m.parts.filter((p): p is MessagePart => p.type === "text").map(p => p.text || ""))
    .join("\n");

  const hasRecentToolError = recentMessages.some(m =>
    m.parts.some(p => p.type === "tool" && p.state?.status === "error")
  );

  if (hasRecentToolError && ERROR_FIX_PATTERNS.some(p => p.test(recentAssistantText))) {
    return { injected: true, type: "gotcha" };
  }

  if (CONSTRAINT_PATTERNS.some(p => p.test(recentUserText))) {
    return { injected: true, type: "constraint" };
  }

  if (DECISION_PATTERNS.some(p => p.test(recentAssistantText))) {
    return { injected: true, type: "decision" };
  }

  return { injected: false, type: null };
}

export function buildMemoryNudge(type: string): string {
  switch (type) {
    case "gotcha":
      return "\n<memory-nudge type=\"gotcha\">You just fixed an error. Use memory_store(type=\"gotcha\") to save what went wrong and how you fixed it, so future sessions don't repeat this mistake.</memory-nudge>";
    case "constraint":
      return "\n<memory-nudge type=\"constraint\">The user expressed a constraint or rule. Use memory_store(type=\"constraint\") to persist it across sessions.</memory-nudge>";
    case "decision":
      return "\n<memory-nudge type=\"decision\">A technical decision was made. Use memory_store(type=\"decision\") to record what was decided and why, so future sessions don't re-decide.</memory-nudge>";
    default:
      return "";
  }
}
