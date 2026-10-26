/**
 * Probe whether a given agent id exists on the host, BEFORE spawning a
 * sub-session for it.
 *
 * Why this exists: v2 engines drop the v1-style `agent` field from prompt
 * bodies (verified in engine source — the prompt payload schema has no agent
 * key). A session created without an agent runs the host's default-agent chain
 * instead, which on oh-my-openagent hosts resolves to an orchestrator persona
 * ("foreman") that fights the consolidation prompt. Asking first turns that
 * silent substitution into an explicit, logged skip.
 *
 * Never blocks on uncertainty: a missing list face, an unrecognized payload
 * shape, or a probe error all return `null` (cannot determine → allow the
 * spawn, legacy hosts keep working).
 */

type AgentListClient = {
  agent?: { list?: () => Promise<unknown> };
  app?: { agents?: () => Promise<unknown> };
};

function extractIds(payload: unknown): string[] {
  const list =
    (payload as { data?: unknown })?.data !== undefined
      ? (payload as { data?: unknown }).data
      : Array.isArray(payload)
        ? payload
        : undefined;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.push(entry);
    } else if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      ids.push((entry as { id: string }).id);
    }
  }
  return ids;
}

/**
 * @returns true (present), false (listable but absent), null (cannot determine).
 */
export async function probeAgent(client: unknown, agent: string): Promise<boolean | null> {
  const typed = client as AgentListClient | undefined;
  const faces = [typed?.agent?.list, typed?.app?.agents].filter(
    (fn): fn is () => Promise<unknown> => typeof fn === "function",
  );
  if (faces.length === 0) return null;
  for (const fetchList of faces) {
    try {
      const ids = extractIds(await fetchList());
      // Unrecognized/empty payload: no evidence either way.
      if (ids.length === 0) continue;
      return ids.includes(agent);
    } catch {
      // Try the next face; a broken probe must not disable consolidation.
    }
  }
  return null;
}
