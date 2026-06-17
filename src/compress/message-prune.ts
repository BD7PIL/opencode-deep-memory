const PRUNE_THRESHOLD = 8;

export function pruneOldMessages(
  messages: Array<{ info: { role: string }; parts: unknown[] }>,
): number {
  let pruned = 0;
  const protectedTail = messages.length - PRUNE_THRESHOLD;

  for (let i = 3; i < protectedTail; i++) {
    const msg = messages[i];
    if (msg.info.role !== "assistant") continue;

    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "text" || typeof p["text"] !== "string") continue;

      const text = p["text"] as string;
      if (text.length < 500) continue;
      if (text === "[cleared]" || text === "[stripped]" || text.startsWith("[compressed")) continue;

      const keyInfo = extractKeyInfo(text);
      if (keyInfo.length < text.length * 0.6) {
        p["text"] = keyInfo + "\n[compressed from " + text.length + " chars]";
        pruned++;
      }
    }
  }

  return pruned;
}

function extractKeyInfo(text: string): string {
  const lines = text.split("\n");
  const keyLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) keyLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      if (keyLines.length < 30 && line.trim()) keyLines.push(line);
      continue;
    }

    if (/^#{1,3}\s/.test(line) ||
        /error|fail|warning|important|critical|decision|constraint/i.test(line) ||
        /^\s*[-*]\s/.test(line) ||
        /^\s*\d+\.\s/.test(line)) {
      keyLines.push(line);
    }
  }

  if (keyLines.length < 3) {
    return lines.slice(0, 5).join("\n");
  }

  return keyLines.join("\n");
}
