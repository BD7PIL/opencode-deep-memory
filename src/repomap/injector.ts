/**
 * Format repo map entries for injection into the system prompt.
 */

export function formatRepoMap(
  entries: Array<{ file: string; symbols: string[] }>,
): string {
  if (entries.length === 0) return "";

  const lines = entries.map(
    (e) => `${e.file}: ${e.symbols.join(", ")}`,
  );

  return `<deep-memory-repomap>\n${lines.join("\n")}\n</deep-memory-repomap>`;
}
