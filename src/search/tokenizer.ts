/**
 * CJK bigram + Latin word tokenizer.
 *
 * Algorithm (per DESIGN §4.1):
 * - Split input into CJK runs and non-CJK runs
 * - CJK run of length N → emit N unigrams + max(0, N-1) bigrams (sliding 2-char window)
 * - Non-CJK run → lowercase, split on [\s\p{P}]+, filter empties
 * - CJK ranges: U+4E00–9FFF, U+3400–4DBF, U+F900–FAFF, U+3040–309F, U+30A0–30FF
 */

/** CJK character detection regex. */
const CJK_RE =
  /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF]/;

/** Split on whitespace and/or Unicode punctuation. */
const TOKEN_SPLIT_RE = /[\s\p{P}]+/u;

/**
 * Tokenize text into search terms.
 *
 * CJK characters produce unigrams + bigrams (sliding 2-char window).
 * Non-CJK text is lowercased and split on whitespace/punctuation.
 *
 * @example tokenize("权限死锁 caused by mutex")
 *   → ["权","权限","限死","死锁","锁","caused","by","mutex"]
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];
  let cjkRun = "";
  let nonCjkRun = "";

  function flushCjk() {
    if (cjkRun.length === 0) return;
    // Unigrams
    for (let i = 0; i < cjkRun.length; i++) {
      tokens.push(cjkRun[i]!);
    }
    // Bigrams (sliding 2-char window)
    for (let i = 0; i < cjkRun.length - 1; i++) {
      tokens.push(cjkRun[i]! + cjkRun[i + 1]!);
    }
    cjkRun = "";
  }

  function flushNonCjk() {
    if (nonCjkRun.length === 0) return;
    const parts = nonCjkRun.toLowerCase().split(TOKEN_SPLIT_RE);
    for (const part of parts) {
      if (part.length > 0) tokens.push(part);
    }
    nonCjkRun = "";
  }

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushNonCjk();
      cjkRun += ch;
    } else {
      flushCjk();
      nonCjkRun += ch;
    }
  }
  flushCjk();
  flushNonCjk();

  return tokens;
}

/**
 * Tokenize a query string with OR-join support.
 *
 * Splits on `|` to get phrases, tokenizes each phrase independently.
 * Returns an array of token arrays (one per OR-phrase).
 *
 * @example tokenizeQuery("权限 | mutex")
 *   → [["权","权限","限"], ["mutex"]]
 */
export function tokenizeQuery(text: string): string[][] {
  if (!text) return [];
  const phrases = text.split("|");
  const result: string[][] = [];
  for (const phrase of phrases) {
    const tokens = tokenize(phrase.trim());
    if (tokens.length > 0) result.push(tokens);
  }
  return result;
}
