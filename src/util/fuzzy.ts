// Fuzzy match score (higher is better), or null.
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    score += 1;
    if (ti === lastMatch + 1) score += 2; // consecutive
    if (ti === 0 || /[\s/_\-.]/.test(t[ti - 1])) score += 3; // word start
    lastMatch = ti;
    qi++;
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) score += 5;
  return score - t.length * 0.01;
}
