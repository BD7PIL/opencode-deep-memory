const ERROR_PURGE_TURN_THRESHOLD = 4;

export function purgeOldErrors(
  messages: Array<{ info: { role: string }; parts: unknown[] }>,
): number {
  let purged = 0;
  const totalMessages = messages.length;

  for (let i = 0; i < totalMessages; i++) {
    const msg = messages[i];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p["type"] !== "tool") continue;

      const toolState = p["state"] as Record<string, unknown> | undefined;
      if (toolState?.["status"] !== "error") continue;

      const age = totalMessages - i;
      if (age < ERROR_PURGE_TURN_THRESHOLD) continue;

      if (typeof toolState["input"] === "object" && toolState["input"] !== null) {
        const input = toolState["input"] as Record<string, unknown>;
        for (const key of Object.keys(input)) {
          if (key === "command" || key === "query" || key === "path" || key === "filePath") continue;
          input[key] = "[purged]";
        }
      }
      purged++;
    }
  }

  return purged;
}
