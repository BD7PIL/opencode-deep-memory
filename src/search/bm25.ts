/**
 * Pure-JS BM25 search engine.
 *
 * Parameters: k1 = 1.5, b = 0.75 (standard Robertson-Sparck-Jones values).
 *
 * Pre-computed at index time (per document):
 *   - docLen[d] — total token count
 *   - termFreq[d][t] — term frequency map
 *   - docCount, avgDocLen
 *
 * Pre-computed per-term (lazily on search):
 *   - df[t] — document frequency
 *   - idf[t] = log((N - df + 0.5) / (df + 0.5) + 1)
 *
 * Score per (doc, queryTerm):
 *   idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
 *
 * Aggregate per doc by SUM across query terms.
 */

/** A single search result. */
export interface BM25Result {
  docId: string;
  score: number;
  matchedTerms: string[];
}

/** Options for constructing a BM25Index. */
export interface BM25Options {
  k1?: number;
  b?: number;
}

interface DocEntry {
  docLen: number;
  termFreq: Map<string, number>;
}

/** Serializable snapshot of a BM25 index. */
export interface BM25JSON {
  k1: number;
  b: number;
  documents: Array<{
    docId: string;
    docLen: number;
    termFreq: Record<string, number>;
  }>;
}

/**
 * BM25 index with incremental add/remove support.
 */
export class BM25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly documents = new Map<string, DocEntry>();
  private readonly df = new Map<string, number>();
  private readonly idfCache = new Map<string, number>();
  private readonly timestamps = new Map<string, number>();
  private idfDirty = true;
  private totalDocLen = 0;

  private readonly queryCache = new Map<string, BM25Result[]>();
  private static readonly CACHE_SIZE = 50;

  private static readonly DECAY_HALF_LIFE: Record<string, number> = {
    Constraints: Infinity,
    Rules: Infinity,
    Decisions: 180,
    Gotchas: 90,
    Facts: 60,
    Notes: 30,
  };

  constructor(opts?: BM25Options) {
    this.k1 = opts?.k1 ?? 1.5;
    this.b = opts?.b ?? 0.75;
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.documents.size;
  }

  /** Average document length. */
  private get avgDocLen(): number {
    if (this.documents.size === 0) return 0;
    return this.totalDocLen / this.documents.size;
  }

  /**
   * Add or replace a document.
   */
  addDocument(docId: string, tokens: string[], timestamp?: Date): void {
    this.removeDocument(docId);

    if (timestamp) {
      this.timestamps.set(docId, timestamp.getTime());
    }

    const termFreq = new Map<string, number>();
    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    }

    const docLen = tokens.length;
    this.documents.set(docId, { docLen, termFreq });
    this.totalDocLen += docLen;

    // Update document frequency
    for (const term of termFreq.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.idfDirty = true;
    this.queryCache.clear();
  }

  /**
   * Remove a document from the index.
   */
  removeDocument(docId: string): void {
    const entry = this.documents.get(docId);
    if (!entry) return;

    this.documents.delete(docId);
    this.timestamps.delete(docId);
    this.totalDocLen -= entry.docLen;

    // Update document frequency
    for (const term of entry.termFreq.keys()) {
      const current = this.df.get(term);
      if (current !== undefined) {
        if (current <= 1) {
          this.df.delete(term);
        } else {
          this.df.set(term, current - 1);
        }
      }
    }
    this.idfDirty = true;
    this.queryCache.clear();
  }

  /**
   * Search the index for matching documents.
   *
   * Scores are aggregated by SUM across query terms.
   */
  search(
    queryTokens: string[],
    opts?: { limit?: number; minScore?: number; applyDecay?: boolean; now?: number },
  ): BM25Result[] {
    const limit = opts?.limit ?? 10;
    const minScore = opts?.minScore ?? 0;

    if (this.documents.size === 0 || queryTokens.length === 0) return [];

    // O21: Check query cache (only for non-decay queries)
    const cacheKey = opts?.applyDecay ? undefined : [...queryTokens].sort().join("\u0001");
    if (cacheKey !== undefined) {
      const cached = this.queryCache.get(cacheKey);
      if (cached) return cached;
    }

    this.rebuildIdfCache();

    const avgDl = this.avgDocLen;

    // docId → { score, matchedTerms }
    const scores = new Map<string, { score: number; matchedTerms: Set<string> }>();

    for (const term of queryTokens) {
      const idf = this.idfCache.get(term);
      if (idf === undefined || idf === 0) continue;

      for (const [docId, entry] of this.documents) {
        const tf = entry.termFreq.get(term);
        if (tf === undefined || tf === 0) continue;

        const scorePart =
          (idf * (tf * (this.k1 + 1))) /
          (tf + this.k1 * (1 - this.b + (this.b * entry.docLen) / avgDl));

        const existing = scores.get(docId);
        if (existing) {
          existing.score += scorePart;
          existing.matchedTerms.add(term);
        } else {
          scores.set(docId, { score: scorePart, matchedTerms: new Set([term]) });
        }
      }
    }

    // Collect, filter, sort, limit
    const results: BM25Result[] = [];
    for (const [docId, { score, matchedTerms }] of scores) {
      if (score >= minScore) {
        results.push({
          docId,
          score,
          matchedTerms: [...matchedTerms],
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    const limited = results.slice(0, limit);

    if (opts?.applyDecay) {
      const now = opts.now ?? Date.now();
      for (const r of limited) {
        const ts = this.timestamps.get(r.docId);
        if (!ts) continue;
        const hashIdx = r.docId.indexOf("#");
        const heading = hashIdx !== -1 ? r.docId.slice(hashIdx + 1) : "";
        const halfLife = BM25Index.DECAY_HALF_LIFE[heading] ?? 90;
        if (isFinite(halfLife)) {
          const ageDays = (now - ts) / 86400000;
          r.score *= Math.pow(0.5, ageDays / halfLife);
        }
      }
      limited.sort((a, b) => b.score - a.score);
    }

    // O21: Store in LRU cache (non-decay only)
    if (cacheKey !== undefined) {
      if (this.queryCache.size >= BM25Index.CACHE_SIZE) {
        const firstKey = this.queryCache.keys().next().value;
        if (firstKey !== undefined) this.queryCache.delete(firstKey);
      }
      this.queryCache.set(cacheKey, limited);
    }

    return limited;
  }

  /**
   * Serialize to JSON for potential future persistence.
   */
  toJSON(): BM25JSON {
    const documents: BM25JSON["documents"] = [];
    for (const [docId, entry] of this.documents) {
      const termFreq: Record<string, number> = {};
      for (const [term, freq] of entry.termFreq) {
        termFreq[term] = freq;
      }
      documents.push({ docId, docLen: entry.docLen, termFreq });
    }
    return { k1: this.k1, b: this.b, documents };
  }

  /**
   * Restore a BM25Index from a serialized snapshot.
   */
  static fromJSON(data: BM25JSON): BM25Index {
    const index = new BM25Index({ k1: data.k1, b: data.b });
    for (const doc of data.documents) {
      const tokens: string[] = [];
      for (const [term, freq] of Object.entries(doc.termFreq)) {
        for (let i = 0; i < freq; i++) tokens.push(term);
      }
      index.addDocument(doc.docId, tokens);
    }
    return index;
  }

  /**
   * Rebuild the IDF cache when df changes.
   */
  private rebuildIdfCache(): void {
    if (!this.idfDirty) return;
    const N = this.documents.size;
    this.idfCache.clear();
    for (const [term, df] of this.df) {
      this.idfCache.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }
    this.idfDirty = false;
  }
}

/**
 * Convenience factory.
 */
export function createIndex(opts?: BM25Options): BM25Index {
  return new BM25Index(opts);
}
