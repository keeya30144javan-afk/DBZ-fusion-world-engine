import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { cardFitsLeader, deckSize } from '../data/decks';
import { compileCard } from '../effects/parse';
import { cardValue } from '../ai/heuristics';

export type Rng = () => number;

export function mulberry(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const isSuperCombo = (c: Card) => compileCard(c).keywords.has('superCombo');

/** Legal main-deck cards for a leader. */
export function poolFor(cards: Record<string, Card>, leaderId: string, rules: RulesConfig = DEFAULT_RULES): Card[] {
  const leader = cards[leaderId];
  if (!leader) return [];
  return Object.values(cards).filter((c) => c.type !== 'LEADER' && cardFitsLeader(c, leader, rules));
}

/** Copies in the deck after a change must respect copy and [Super Combo] limits. */
export function legalCount(deck: Decklist, cards: Record<string, Card>, id: string, n: number, rules: RulesConfig = DEFAULT_RULES): boolean {
  if (n > rules.maxCopies) return false;
  if (isSuperCombo(cards[id])) {
    let sc = 0;
    for (const [k, v] of Object.entries(deck.main)) if (k !== id && isSuperCombo(cards[k])) sc += v;
    if (sc + n > rules.superComboMax) return false;
  }
  return true;
}

/** Slot targets by cost bucket for a 50-card deck. */
const CURVE: [number, number, number][] = [
  // [minCost, maxCost, cards]
  [0, 1, 12],
  [2, 2, 14],
  [3, 3, 10],
  [4, 4, 6],
  [5, 99, 4],
];

/**
 * A sensible starting list for a leader: the best cards by static value,
 * spread over a Fusion World curve, 4-ofs where possible.
 */
export function seedDeck(cards: Record<string, Card>, leaderId: string, rng: Rng, rules: RulesConfig = DEFAULT_RULES, jitter = 0): Decklist {
  const pool = poolFor(cards, leaderId, rules);
  const val = (c: Card) => cardValue(c) + (jitter ? (rng() - 0.5) * jitter : 0);
  const deck: Decklist = { name: `${cards[leaderId].name} (${leaderId})`, leader: leaderId, main: {} };
  const add = (c: Card, max: number) => {
    let added = 0;
    while (added < max && legalCount(deck, cards, c.id, (deck.main[c.id] ?? 0) + 1, rules)) {
      deck.main[c.id] = (deck.main[c.id] ?? 0) + 1;
      added++;
    }
    return added;
  };
  const extras = pool.filter((c) => c.type === 'EXTRA').sort((a, b) => val(b) - val(a));
  let extraSlots = 4;
  for (const c of extras) { if (extraSlots <= 0) break; extraSlots -= add(c, Math.min(rules.maxCopies, extraSlots)); }
  for (const [lo, hi, slots] of CURVE) {
    let left = slots;
    const bucket = pool.filter((c) => c.type === 'BATTLE' && c.cost >= lo && c.cost <= hi).sort((a, b) => val(b) - val(a));
    for (const c of bucket) { if (left <= 0) break; left -= add(c, Math.min(rules.maxCopies - (deck.main[c.id] ?? 0), left)); }
  }
  // Top up (or trim) to the minimum size with the best remaining cards.
  const all = pool.slice().sort((a, b) => val(b) - val(a));
  for (const c of all) { if (deckSize(deck) >= rules.deckMin) break; add(c, rules.deckMin - deckSize(deck)); }
  trimTo(deck, cards, rules.deckMin);
  return deck;
}

export function trimTo(deck: Decklist, cards: Record<string, Card>, size: number) {
  while (deckSize(deck) > size) {
    const worst = Object.keys(deck.main).filter((k) => deck.main[k] > 0).sort((a, b) => cardValue(cards[a]) - cardValue(cards[b]))[0];
    deck.main[worst]--;
    if (deck.main[worst] === 0) delete deck.main[worst];
  }
}

export const cloneDeck = (d: Decklist): Decklist => ({ ...d, main: { ...d.main } });

/**
 * Swap `k` copies: remove from cards the deck does not need (guided by
 * `weak`, a per-card badness score from game stats), add from the pool.
 */
export function mutate(deck: Decklist, cards: Record<string, Card>, rng: Rng, k: number, weak: (id: string) => number = () => 0, rules: RulesConfig = DEFAULT_RULES): Decklist {
  const d = cloneDeck(deck);
  const pool = poolFor(cards, d.leader, rules);
  if (!pool.length) return d;
  for (let i = 0; i < k; i++) {
    const ids = Object.keys(d.main).filter((x) => d.main[x] > 0);
    // Remove: weighted toward weak cards.
    const removeW = ids.map((id) => Math.max(0.05, 1 + weak(id) * 2 - cardValue(cards[id]) * 0.1));
    const out = ids[weightedPick(removeW, rng)];
    // Add: weighted toward valuable cards not yet at 4.
    const addable = pool.filter((c) => c.id !== out && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules));
    if (!addable.length) continue;
    const addW = addable.map((c) => Math.max(0.05, 0.5 + cardValue(c) * 0.5 - weak(c.id) * 2));
    const inn = addable[weightedPick(addW, rng)];
    d.main[out]--;
    if (d.main[out] === 0) delete d.main[out];
    d.main[inn.id] = (d.main[inn.id] ?? 0) + 1;
  }
  return d;
}

function weightedPick(w: number[], rng: Rng): number {
  const t = w.reduce((a, b) => a + b, 0);
  let r = rng() * t;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}

/** Cross two decks with the same leader: take each card's count from one parent. */
export function crossover(a: Decklist, b: Decklist, cards: Record<string, Card>, rng: Rng, rules: RulesConfig = DEFAULT_RULES): Decklist {
  const d: Decklist = { ...a, main: {} };
  const ids = new Set([...Object.keys(a.main), ...Object.keys(b.main)]);
  for (const id of ids) {
    const n = rng() < 0.5 ? a.main[id] ?? 0 : b.main[id] ?? 0;
    if (n > 0 && legalCount(d, cards, id, n, rules)) d.main[id] = n;
  }
  const pool = poolFor(cards, d.leader, rules).sort((x, y) => cardValue(y) - cardValue(x));
  for (const c of pool) {
    if (deckSize(d) >= rules.deckMin) break;
    while (deckSize(d) < rules.deckMin && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules)) d.main[c.id] = (d.main[c.id] ?? 0) + 1;
  }
  trimTo(d, cards, rules.deckMin);
  return d;
}
