/**
 * Tiny dependency-free fuzzy matcher for live list search (Adon Batch 6.2 —
 * shopping-out merchant search). Case-insensitive + typo-tolerant so
 * "remmington" still surfaces "Remington Builders".
 *
 * Score: lower = better.
 *   -1   = direct substring hit (best)
 *   -0.5 = a token starts with the query (prefix)
 *   0..1 = normalized Levenshtein ratio of the closest token (typo distance)
 * Callers threshold the score (default 0.45) to drop non-matches, then sort
 * ascending so the closest matches rank first.
 */

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Lower = better. Returns a large number when there's no reasonable match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const h = (target || "").toLowerCase();
  if (!h) return 99;
  if (h.includes(q)) return -1;
  const tokens = h.split(/[\s,@._\-/]+/).filter(Boolean);
  let best = 1;
  for (const t of tokens) {
    if (t.startsWith(q)) return -0.5;
    // Window the token to roughly the query length so a long token isn't
    // penalized for trailing characters the query never typed.
    const window = t.slice(0, q.length + 3);
    const ratio = levenshtein(q, window) / Math.max(q.length, 1);
    if (ratio < best) best = ratio;
  }
  return best;
}

/** Convenience boolean with a tolerant default threshold. */
export function fuzzyMatches(query: string, target: string, threshold = 0.45): boolean {
  return fuzzyScore(query, target) <= threshold;
}
