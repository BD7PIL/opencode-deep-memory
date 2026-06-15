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
  /** Per-term document frequency (number of documents containing the term). */
  private readonly df = new Map<string, number>();
  /** Cached IDF values (invalidated when df changes). */
  private idfCache = new Map<string, number>();
  private idfDirty = true;
  private totalDocLen = 0;

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
  addDocument(docId: string, tokens: string[]): void {
    // Remove existing entry first (if replacing)
    this.removeDocument(docId);

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
  }

  /**
   * Remove a document from the index.
   */
  removeDocument(docId: string): void {
    const entry = this.documents.get(docId);
    if (!entry) return;

    this.documents.delete(docId);
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
  }

  /**
   * Search the index for matching documents.
   *
   * Scores are aggregated by SUM across query terms.
   */
  search(
    queryTokens: string[],
    opts?: { limit?: number; minScore?: number },
  ): BM25Result[] {
    const limit = opts?.limit ?? 10;
    const minScore = opts?.minScore ?? 0;

    if (this.documents.size === 0 || queryTokens.length === 0) return [];

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
    return results.slice(0, limit);
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
