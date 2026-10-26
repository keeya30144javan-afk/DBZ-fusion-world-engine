import { hitFactor } from './scouter';
import { GameState, GameEvent, Side, cardOf, cloneState, comboPowerOf, other, rand } from '../engine/core';

/**
 * Hidden-information handling for the searching AI.
 *
 * The AI never reads the identities of cards it cannot see. Instead, for each
 * imagined "world" it re-deals the hidden cards:
 *   - the opponent's hand, life and deck are re-dealt from the cards of their
 *     list that have not been seen in public zones;
 *   - its own life and deck are re-shuffled together (it knows what is left,
 *     not the order).
 * Hands are dealt with importance weights from the opponent's behaviour
 * (declining to combo when it could have, see `handLikelihood`).
 */

const HIDDEN_ZONES = ['hand', 'life', 'deck'] as const;

/** Multiset of card ids the viewer cannot see for `side`. */
export function hiddenIds(s: GameState, side: Side, viewer: Side): string[] {
  const p = s.p[side];
  const zones = side === viewer ? (['life', 'deck'] as const) : HIDDEN_ZONES;
  const out: string[] = [];
  for (const z of zones) for (const u of p[z]) out.push(s.inst[u].id);
  return out;
}

/**
 * Probability of the opponent's observed choices given a candidate hand.
 * When they let an attack through while holding enough combo power to stop
 * it cheaply, that hand becomes less likely (they probably did not hold it).
 */
export function handLikelihood(s: GameState, handIds: string[], events: GameEvent[], side: Side): number {
  let like = 1;
  const combos = handIds.map((id) => s.cards[id]?.comboPower ?? 0).sort((a, b) => b - a);
  for (const e of events) {
    if (e.t !== 'declined' || e.p !== side || e.what !== 'combo' || e.need <= 0) continue;
    // Cards needed to cover the gap with the best combo cards in this hand.
    let need = e.need;
    let used = 0;
    for (const c of combos) { if (need <= 0) break; need -= c; used++; }
    const couldCheaply = need <= 0 && used <= (e.stakes === 'leader' ? 1 : 0);
    if (couldCheaply) like *= hitFactor(e.stakes, e.life);
  }
  return like;
}

function shuffleInPlace<T>(s: GameState, a: T[]) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
}

export interface DeterminizeOpts {
  /** Override the opponent's hidden pool (e.g. from an archetype mixture). */
  oppPool?: string[];
  /** Events used for behavioural weighting; omitted = uniform. */
  events?: GameEvent[] | null;
  /** Candidate hands to weigh against each other. */
  candidates?: number;
}

/** A copy of `s` where everything `viewer` cannot see has been re-dealt. */
export function determinize(s: GameState, viewer: Side, opts: DeterminizeOpts = {}): GameState {
  const w = cloneState(s);
  w.seed = (s.seed ^ Math.floor(rand(s) * 2 ** 31)) | 0;
  const opp = other(viewer);

  // Own life + deck: same cards, unknown order.
  {
    const me = w.p[viewer];
    const uids = [...me.life, ...me.deck];
    const ids = uids.map((u) => w.inst[u].id);
    shuffleInPlace(w, ids);
    uids.forEach((u, i) => (w.inst[u].id = ids[i]));
  }

  // Opponent hand + life + deck.
  const op = w.p[opp];
  const pool = (opts.oppPool ?? hiddenIds(s, opp, viewer)).slice();
  const handN = op.hand.length;
  const events = opts.events ?? s.events;
  const k = events && events.some((e) => e.t === 'declined' && e.p === opp) ? opts.candidates ?? 6 : 1;
  let best: string[] | null = null;
  if (k === 1) {
    shuffleInPlace(w, pool);
    best = pool;
  } else {
    // Importance resampling: draw k deals, keep one in proportion to its likelihood.
    const deals: string[][] = [];
    const weights: number[] = [];
    for (let i = 0; i < k; i++) {
      const d = pool.slice();
      shuffleInPlace(w, d);
      deals.push(d);
      weights.push(handLikelihood(w, d.slice(0, handN), events!, opp));
    }
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rand(w) * total;
    for (let i = 0; i < k; i++) { r -= weights[i]; if (r <= 0) { best = deals[i]; break; } }
    best ??= deals[k - 1];
  }
  const uids = [...op.hand, ...op.life, ...op.deck];
  for (let i = 0; i < uids.length; i++) if (best[i] !== undefined) w.inst[uids[i]].id = best[i];
  return w;
}

/** Combo power the viewer can expect the opponent to hold, from a pool. */
export function expectedHandCombo(s: GameState, pool: string[], handSize: number): number {
  if (!pool.length) return 0;
  const avg = pool.reduce((a, id) => a + (s.cards[id]?.comboPower ?? 0), 0) / pool.length;
  return avg * handSize;
}

export { comboPowerOf, cardOf };
