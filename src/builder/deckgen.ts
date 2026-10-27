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

/** Names and traits a card's skills ask for (cards to search, play, evolve from…), ignoring Leader conditions. */
export function wants(card: Card): { names: string[]; traits: string[] } {
  const cc = compileCard(card);
  const names = new Set<string>(), traits = new Set<string>();
  const walk = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const o = x as Record<string, unknown>;
    if (o.t === 'leaderIs' || o.t === 'leaderTrait') return;
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'names') && Array.isArray(v)) v.forEach((n) => typeof n === 'string' && n.trim() && names.add(n));
      else if ((k === 'traits' || k === 'traitsAll' || k === 'onlyTraits') && Array.isArray(v)) v.forEach((t) => typeof t === 'string' && traits.add(t));
      else walk(v);
    }
  };
  walk([cc.abilities, cc.backAbilities, cc.evolve]);
  return { names: [...names], traits: [...traits] };
}

const has = (card: Card, n: string) => card.name.includes(n) || card.characters.some((ch) => ch.includes(n));
const hasTrait = (card: Card, t: string) => card.traits.some((x) => x.toLowerCase() === t.toLowerCase());

/** Rough static check of a filter's name/trait/cost parts. */
function fits(card: Card, f: { names?: string[]; traits?: string[]; costEQ?: number; costLE?: number; costGE?: number; type?: string }) {
  if (f.type && card.type !== f.type) return false;
  if (f.names?.length && !f.names.some((n) => has(card, n))) return false;
  if (f.traits?.length && !f.traits.some((t) => hasTrait(card, t))) return false;
  if (f.costEQ !== undefined && card.cost !== f.costEQ) return false;
  if (f.costLE !== undefined && card.cost > f.costLE) return false;
  if (f.costGE !== undefined && card.cost < f.costGE) return false;
  return true;
}

/** Evolve cards need something in the deck to evolve from. */
export function evolveBacked(card: Card, deck: Decklist, cards: Record<string, Card>): boolean {
  const ev = compileCard(card).evolve;
  if (!ev) return true;
  const inDeck = Object.keys(deck.main).filter((k) => k !== card.id && deck.main[k] > 0).map((k) => cards[k]);
  const ok = (f: Parameters<typeof fits>[1]) => inDeck.some((c) => c.type === 'BATTLE' && fits(c, f));
  return ev.from.every(ok) || (!!ev.orFrom?.length && ev.orFrom.some(ok));
}

/**
 * Value of each card for a leader, plus synergy: cards the Leader's skills (and
 * the other chosen cards' skills) ask for by name or trait are worth more.
 */
function synergyValue(pool: Card[], leader: Card, chosen: Card[]) {
  const nameW = new Map<string, number>(), traitW = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);
  const lw = wants(leader);
  lw.names.forEach((n) => bump(nameW, n, 1.5));
  lw.traits.forEach((t) => bump(traitW, t, 1.0));
  for (const c of chosen) {
    const w = wants(c);
    w.names.forEach((n) => bump(nameW, n, 0.25));
    w.traits.forEach((t) => bump(traitW, t, 0.12));
  }
  const bonus = new Map<string, number>();
  for (const c of pool) {
    let b = 0;
    for (const [n, w] of nameW) if (has(c, n) || (c.name === leader.name && n === leader.name)) b += w;
    for (const [t, w] of traitW) if (hasTrait(c, t)) b += w;
    // A card named like the Leader usually belongs with it.
    if (has(c, leader.name)) b += 0.5;
    bonus.set(c.id, Math.min(b, 3));
  }
  return (c: Card) => cardValue(c, leader) + (bonus.get(c.id) ?? 0);
}

/**
 * A sensible starting list for a leader: the best cards for that Leader (its own
 * conditions met, synergy with what it and the other picks ask for), spread over a
 * Fusion World curve, 4-ofs where possible. Evolve cards only go in with a base.
 */
export function seedDeck(cards: Record<string, Card>, leaderId: string, rng: Rng, rules: RulesConfig = DEFAULT_RULES, jitter = 0): Decklist {
  const pool = poolFor(cards, leaderId, rules);
  const leader = cards[leaderId];
  const noise = new Map(pool.map((c) => [c.id, jitter ? (rng() - 0.5) * jitter : 0]));
  let deck = build((c) => cardValue(c, leader));
  // Second pass: score synergy against the first list, then build again.
  const syn = synergyValue(pool, leader, Object.keys(deck.main).map((k) => cards[k]));
  deck = build(syn);
  return deck;

  function build(base: (c: Card) => number): Decklist {
    const val = (c: Card) => base(c) + (noise.get(c.id) ?? 0);
    const deck: Decklist = { name: `${leader.name} (${leaderId})`, leader: leaderId, main: {} };
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
    dropUnbacked(deck, cards);
    // Top up (or trim) to the minimum size with the best remaining cards.
    const all = pool.slice().sort((a, b) => val(b) - val(a));
    for (const c of all) {
      if (deckSize(deck) >= rules.deckMin) break;
      if (!evolveBacked(c, deck, cards)) continue;
      add(c, rules.deckMin - deckSize(deck));
    }
    trimTo(deck, cards, rules.deckMin);
    return deck;
  }
}

/** Remove Evolve cards with nothing to evolve from. */
export function dropUnbacked(deck: Decklist, cards: Record<string, Card>) {
  for (const k of Object.keys(deck.main)) if (!evolveBacked(cards[k], deck, cards)) delete deck.main[k];
}

export function trimTo(deck: Decklist, cards: Record<string, Card>, size: number) {
  while (deckSize(deck) > size) {
    const worst = Object.keys(deck.main).filter((k) => deck.main[k] > 0).sort((a, b) => cardValue(cards[a], cards[deck.leader]) - cardValue(cards[b], cards[deck.leader]))[0];
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
    const removeW = ids.map((id) => Math.max(0.05, 1 + weak(id) * 2 - cardValue(cards[id], cards[d.leader]) * 0.1));
    const out = ids[weightedPick(removeW, rng)];
    // Add: weighted toward valuable cards not yet at 4.
    const addable = pool.filter((c) => c.id !== out && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules) && evolveBacked(c, d, cards));
    if (!addable.length) continue;
    const addW = addable.map((c) => Math.max(0.05, 0.5 + cardValue(c, cards[d.leader]) * 0.5 - weak(c.id) * 2));
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
  const pool = poolFor(cards, d.leader, rules).sort((x, y) => cardValue(y, cards[d.leader]) - cardValue(x, cards[d.leader]));
  for (const c of pool) {
    if (deckSize(d) >= rules.deckMin) break;
    while (deckSize(d) < rules.deckMin && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules)) d.main[c.id] = (d.main[c.id] ?? 0) + 1;
  }
  trimTo(d, cards, rules.deckMin);
  return d;
}
