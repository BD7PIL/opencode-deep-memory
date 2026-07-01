/**
 * Layer 5: Synchronous consolidation. No background, no LLM.
 * SimHash dedup + stale-entry purge. Runs in-hook.
 * See DESIGN_V4.md Layer 5.
 */

interface ConsolidateOpts {
  staleFilePaths?: string[];
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[\s\-,.\[\](){}:]+/).filter((w) => w.length > 2);
}

function simHash(s: string, bits = 64): number {
  const tokens = tokenize(s);
  if (tokens.length === 0) return 0;
  const v = new Int8Array(bits);
  for (const token of tokens) {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = ((h << 5) - h + token.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < bits; i++) {
      if ((h >> i) & 1) v[i]++; else v[i]--;
    }
  }
  let hash = 0;
  for (let i = 0; i < bits; i++) {
    if (v[i] > 0) hash |= (1 << i);
  }
  return hash;
}

function hammingDistance(a: number, b: number): number {
  let xor = a ^ b;
  let dist = 0;
  while (xor) { dist += xor & 1; xor >>>= 1; }
  return dist;
}

function similarity(a: number, b: number, bits = 64): number {
  return 1 - hammingDistance(a, b) / bits;
}

const SIMILARITY_THRESHOLD = 0.92;
const STALE_BINDING_RE = /^(- \[[^\]]+\] )(src\/[^\s:]+:[^\s:]+)(?::[a-f0-9]+)?\s/;

export function consolidateMemory(content: string, opts: ConsolidateOpts = {}): string {
  if (!content.trim()) return content;

  const lines = content.split("\n");
  const staleSet = new Set(opts.staleFilePaths ?? []);
  const seen: { hash: number; line: string }[] = [];
  const result: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("- [")) {
      result.push(line);
      continue;
    }

    if (staleSet.size > 0) {
      const m = line.match(STALE_BINDING_RE);
      if (m && staleSet.has(m[2])) continue;
    }

    const hash = simHash(line);
    const isDup = seen.some((s) => similarity(hash, s.hash) >= SIMILARITY_THRESHOLD);
    if (isDup) continue;

    seen.push({ hash, line });
    result.push(line);
  }

  return result.join("\n");
}
