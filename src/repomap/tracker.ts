/**
 * Tracks files read by the agent and ranks symbols for injection.
 */

import { extractSymbols, getLanguage, type ExtractedSymbol } from "./extractor.js";

export interface TrackedFile {
  path: string;
  symbols: ExtractedSymbol[];
  readCount: number;
  lastRead: number; // Date.now()
  language: string;
}

/** Recency decay with ~1h half-life: 1 / (1 + hours_elapsed). */
function recencyDecay(lastRead: number): number {
  const hoursElapsed = (Date.now() - lastRead) / (1000 * 60 * 60);
  return 1 / (1 + hoursElapsed);
}

export class RepoMapTracker {
  private files = new Map<string, TrackedFile>();

  recordRead(path: string, content: string): void {
    const lang = getLanguage(path);
    if (!lang) return;

    const symbols = extractSymbols(path, content);
    const existing = this.files.get(path);
    if (existing) {
      existing.symbols = symbols;
      existing.readCount += 1;
      existing.lastRead = Date.now();
    } else {
      this.files.set(path, {
        path,
        symbols,
        readCount: 1,
        lastRead: Date.now(),
        language: lang,
      });
    }
  }

  getRecentlyRead(limit: number): TrackedFile[] {
    const sorted = [...this.files.values()].sort(
      (a, b) => b.lastRead - a.lastRead,
    );
    return sorted.slice(0, limit);
  }

  getTopSymbols(budgetTokens: number): Array<{ file: string; symbols: string[] }> {
    if (this.files.size === 0) return [];

    // Score each file: readCount * 2 + recencyDecay(lastRead) * 3
    const scored = [...this.files.values()].map((f) => ({
      file: f,
      score: f.readCount * 2 + recencyDecay(f.lastRead) * 3,
    }));
    scored.sort((a, b) => b.score - a.score);

    const result: Array<{ file: string; symbols: string[] }> = [];
    let remaining = budgetTokens;

    for (const { file } of scored) {
      // ~10 tokens per file path header
      const headerCost = 10;
      if (remaining < headerCost) break;
      remaining -= headerCost;

      const picked: string[] = [];
      // Apply C2 multipliers and sort symbols by adjusted score
      const symbolScores = file.symbols.map((s) => {
        let adjusted = 1;
        if (s.name.startsWith("_")) adjusted *= 0.1;
        if (s.name.length >= 8) adjusted *= 1.5;
        return { name: s.name, score: adjusted };
      });
      symbolScores.sort((a, b) => b.score - a.score);

      for (const { name } of symbolScores) {
        // ~4 tokens per symbol name
        const symCost = 4;
        if (remaining < symCost) break;
        remaining -= symCost;
        picked.push(name);
      }

      if (picked.length > 0) {
        result.push({ file: file.path, symbols: picked });
      }
    }

    return result;
  }

  clear(): void {
    this.files.clear();
  }
}
