/** Wilson score interval for a win rate. z = 1.96 for 95%. */
export function wilson(wins: number, games: number, z = 1.96): { mean: number; lo: number; hi: number } {
  if (games === 0) return { mean: 0, lo: 0, hi: 1 };
  const p = wins / games;
  const z2 = z * z;
  const denom = 1 + z2 / games;
  const centre = (p + z2 / (2 * games)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / games + z2 / (4 * games * games))) / denom;
  return { mean: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export const Z: Record<string, number> = { '0.8': 1.2816, '0.9': 1.6449, '0.95': 1.96, '0.99': 2.5758 };

/** Games needed so the interval half-width is about `margin` at p ~ 0.5. */
export const gamesForMargin = (margin: number, z = 1.96) => Math.ceil((z * z * 0.25) / (margin * margin));

/** One-sided test: is a's rate above b's? Returns a z-score (independent samples). */
export function diffZ(winsA: number, nA: number, winsB: number, nB: number): number {
  if (!nA || !nB) return 0;
  const pa = winsA / nA, pb = winsB / nB;
  const p = (winsA + winsB) / (nA + nB);
  const se = Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
  return se === 0 ? 0 : (pa - pb) / se;
}
