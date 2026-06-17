import { createHash } from "node:crypto";

export function crushJsonArray(content: string, maxItems: number = 15): string {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return content;
    if (parsed.length <= maxItems) return content;

    const firstFraction = 0.3;
    const lastFraction = 0.15;
    const firstCount = Math.max(1, Math.floor(maxItems * firstFraction));
    const lastCount = Math.max(1, Math.floor(maxItems * lastFraction));
    const midCount = maxItems - firstCount - lastCount;

    const first = parsed.slice(0, firstCount);
    const last = parsed.slice(-lastCount);
    const mid = deduplicateMiddle(parsed.slice(firstCount, -lastCount), midCount);

    const result = [...first, ...mid, ...last];
    const dropped = parsed.length - result.length;

    if (dropped > 0) {
      const hash = sha256(content).slice(0, 12);
      result.push({ _ccr_dropped: `[${dropped} items offloaded, hash=${hash}]` });
    }

    return JSON.stringify(result, null, 2);
  } catch {
    return content;
  }
}

function deduplicateMiddle(items: unknown[], maxCount: number): unknown[] {
  if (items.length <= maxCount) return items;

  const seen = new Set<string>();
  const unique: unknown[] = [];

  for (const item of items) {
    const key = typeof item === "object" ? JSON.stringify(item) : String(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
      if (unique.length >= maxCount) break;
    }
  }

  return unique;
}

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
