import { synergyBonus } from '../ai/synergy';
import { nameHas } from '../engine/core';
import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig, copyLimit } from '../data/rules';
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
  return Object.values(cards).filter((c) => c.type !== 'LEADER' && cardFitsLeader(c, leader, rules) && copyLimit(rules, c.id) > 0);
}

/**
 * Cards the Leader's own start-of-game skill fetches from the deck ("When this card is placed
 * in your Leader Area, play up to 1 <Wicked Soul Discovered> from your deck"): without one in
 * the deck that skill, often the deck's whole engine, does nothing. Every built deck runs one.
 */
export function requiredFor(cards: Record<string, Card>, leaderId: string, rules: RulesConfig = DEFAULT_RULES): string[] {
  const leader = cards[leaderId];
  if (!leader) return [];
  const names = compileCard(leader).abilities.filter((ab) => ab.timing === 'gameStart')
    .flatMap((ab) => ab.effects.flatMap((e) => (e.t === 'playFrom' && e.from === 'deck' ? e.filter.names ?? [] : [])));
  return poolFor(cards, leaderId, rules).filter((c) => names.includes(c.name)).map((c) => c.id);
}

/**
 * The Leader's name tags: what follows the colon in each name ("Gogeta: BR" -> BR,
 * "Trunks: Future/Son Gohan: Future" -> Future). Cards sharing a tag form an archetype the
 * Leader's text doesn't spell out (a real BR list is ~48 BR cards; their traits differ).
 */
const nameTags = (name: string) => name.split('/').map((p) => p.split(':')[1]?.trim().toLowerCase()).filter((t): t is string => !!t);
export const sharesTag = (card: Card, leader: Card) => { const tags = nameTags(leader.name); return tags.length > 0 && nameTags(card.name).some((t) => tags.includes(t)); };

/** Copies in the deck after a change must respect copy and [Super Combo] limits. */
export function legalCount(deck: Decklist, cards: Record<string, Card>, id: string, n: number, rules: RulesConfig = DEFAULT_RULES): boolean {
  if (n > copyLimit(rules, id)) return false;
  if (isSuperCombo(cards[id])) {
    let sc = 0;
    for (const [k, v] of Object.entries(deck.main)) if (k !== id && isSuperCombo(cards[k])) sc += v;
    if (sc + n > rules.superComboMax) return false;
  }
  return true;
}

/**
 * Slot targets by cost bucket for the Battle Cards of a 50-card deck, besides the
 * Super Combo cards and Extras. Taken from strong players' lists (Oct 2026): every one
 * runs 4 Super Combo cards, a big base of 1-costs (cantrips, searchers, evolve bases),
 * few 3-costs, and its finishers at 4+.
 */
const CURVE: [number, number, number][] = [
  // [minCost, maxCost, cards]
  [0, 1, 15],
  [2, 2, 10],
  [3, 3, 4],
  [4, 4, 5],
  [5, 99, 6],
];
/** Every strong list runs exactly this many Super Combo cards. */
const SUPER_COMBOS = 4;
/** Extras: up to this many, and only ones that earn their slot. */
const EXTRA_MAX = 6;

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

const has = nameHas;
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
  const required = requiredFor(cards, leaderId, rules);
  const noise = new Map(pool.map((c) => [c.id, jitter ? (rng() - 0.5) * jitter : 0]));
  // Cards of the Leader's own archetype (same name tag) start ahead.
  const tagged = (c: Card) => (sharesTag(c, leader) ? 1.5 : 0);
  let deck = build((c) => cardValue(c, leader) + tagged(c));
  // Two more passes: score each card's synergy with the list so far (named searches,
  // and resource links: rest -> KO rested, Ki makers -> Ki spenders, Drop fillers ->
  // Drop payoffs...), then build again around it.
  for (let pass = 0; pass < 2; pass++) {
    const named = synergyValue(pool, leader, Object.keys(deck.main).map((k) => cards[k]));
    const current = deck;
    const links = new Map(pool.map((c) => [c.id, synergyBonus(cards, current, c)]));
    deck = build((c) => named(c) + 1.4 * (links.get(c.id) ?? 0) + tagged(c));
  }
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
    for (const id of required) add(cards[id], 1);
    // The combo wall first: the best Super Combo card for this Leader, 4 copies.
    const supers = pool.filter((c) => c.type === 'BATTLE' && isSuperCombo(c)).sort((a, b) => b.comboPower - a.comboPower || val(b) - val(a));
    let scLeft = Math.min(SUPER_COMBOS, rules.superComboMax);
    for (const c of supers) { if (scLeft <= 0) break; scLeft -= add(c, Math.min(copyLimit(rules, c.id), scLeft)); }
    // Extras only when they're worth more than an average Battle Card for this Leader.
    const battleVals = pool.filter((c) => c.type === 'BATTLE' && !isSuperCombo(c)).map(val).sort((a, b) => b - a);
    const bar = battleVals[Math.min(battleVals.length - 1, 30)] ?? 0;
    const extras = pool.filter((c) => c.type === 'EXTRA' && val(c) >= bar).sort((a, b) => val(b) - val(a));
    let extraSlots = EXTRA_MAX;
    for (const c of extras) { if (extraSlots <= 0) break; extraSlots -= add(c, Math.min(copyLimit(rules, c.id), extraSlots)); }
    for (const [lo, hi, slots] of CURVE) {
      let left = slots;
      const bucket = pool.filter((c) => c.type === 'BATTLE' && !isSuperCombo(c) && c.cost >= lo && c.cost <= hi).sort((a, b) => val(b) - val(a));
      for (const c of bucket) { if (left <= 0) break; left -= add(c, Math.min(copyLimit(rules, c.id) - (deck.main[c.id] ?? 0), left)); }
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
    const worst = Object.keys(deck.main).filter((k) => deck.main[k] > 0 && !isSuperCombo(cards[k])).sort((a, b) => cardValue(cards[a], cards[deck.leader]) - cardValue(cards[b], cards[deck.leader]))[0];
    if (!worst) break;
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
  const required = requiredFor(cards, d.leader, rules);
  for (let i = 0; i < k; i++) {
    // The 4 Super Combo cards are fixed: every strong list runs exactly 4. The last copy of a
    // card the Leader's start-of-game skill needs stays too.
    const ids = Object.keys(d.main).filter((x) => d.main[x] > 0 && !isSuperCombo(cards[x]) && !(d.main[x] === 1 && required.includes(x)));
    // Remove: weighted toward weak cards.
    const removeW = ids.map((id) => Math.max(0.05, 1 + weak(id) * 2 - cardValue(cards[id], cards[d.leader]) * 0.1));
    const out = ids[weightedPick(removeW, rng)];
    // Add: weighted toward valuable cards not yet at 4.
    if (!ids.length) continue;
    const addable = pool.filter((c) => c.id !== out && !isSuperCombo(c) && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules) && evolveBacked(c, d, cards));
    if (!addable.length) continue;
    const addW = addable.map((c) => Math.max(0.05, 0.5 + cardValue(c, cards[d.leader]) * 0.5 - weak(c.id) * 2));
    const inn = addable[weightedPick(addW, rng)];
    d.main[out]--;
    if (d.main[out] === 0) delete d.main[out];
    d.main[inn.id] = (d.main[inn.id] ?? 0) + 1;
    // Packages: an [Evolve] / [Fusion Evolve] card needs its bases in numbers, which swapping one
    // card at a time almost never builds up (Gogeta: BR needs both BR halves). Half the time,
    // bring each base it needs up to 2 copies, paying with the weakest other cards.
    const ev = compileCard(inn).evolve;
    if (ev && rng() < 0.5) {
      for (const f of ev.from) {
        const bases = pool.filter((c) => c.type === 'BATTLE' && c.id !== inn.id && fits(c, f) && copyLimit(rules, c.id) >= 2);
        if (!bases.length) continue;
        const base = bases.slice().sort((x, y) => (d.main[y.id] ?? 0) - (d.main[x.id] ?? 0) || cardValue(y, cards[d.leader]) - cardValue(x, cards[d.leader]))[0];
        while ((d.main[base.id] ?? 0) < 2 && legalCount(d, cards, base.id, (d.main[base.id] ?? 0) + 1, rules)) {
          const spare = Object.keys(d.main).filter((x) => x !== base.id && x !== inn.id && d.main[x] > 0 && !isSuperCombo(cards[x]) && !(d.main[x] === 1 && required.includes(x)));
          if (!spare.length) break;
          const w = spare.map((id) => Math.max(0.05, 1 + weak(id) * 2 - cardValue(cards[id], cards[d.leader]) * 0.1));
          const drop = spare[weightedPick(w, rng)];
          d.main[drop]--;
          if (d.main[drop] === 0) delete d.main[drop];
          d.main[base.id] = (d.main[base.id] ?? 0) + 1;
        }
      }
    }
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
  for (const id of requiredFor(cards, d.leader, rules)) if (!d.main[id]) d.main[id] = 1;
  const pool = poolFor(cards, d.leader, rules).sort((x, y) => cardValue(y, cards[d.leader]) - cardValue(x, cards[d.leader]));
  for (const c of pool) {
    if (deckSize(d) >= rules.deckMin) break;
    while (deckSize(d) < rules.deckMin && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules)) d.main[c.id] = (d.main[c.id] ?? 0) + 1;
  }
  ensureSuperCombos(d, cards, rules);
  trimTo(d, cards, rules.deckMin);
  return d;
}

/** Top a deck up to 4 Super Combo cards (the best one for its Leader), trimming the weakest others. */
export function ensureSuperCombos(d: Decklist, cards: Record<string, Card>, rules: RulesConfig = DEFAULT_RULES) {
  const want = Math.min(4, rules.superComboMax);
  const have = Object.entries(d.main).reduce((t, [k, n]) => t + (isSuperCombo(cards[k]) ? n : 0), 0);
  if (have >= want) return;
  const best = poolFor(cards, d.leader, rules).filter((c) => c.type === 'BATTLE' && isSuperCombo(c)).sort((a, b) => b.comboPower - a.comboPower || (d.main[b.id] ?? 0) - (d.main[a.id] ?? 0));
  let need = want - have;
  for (const c of best) {
    while (need > 0 && legalCount(d, cards, c.id, (d.main[c.id] ?? 0) + 1, rules)) { d.main[c.id] = (d.main[c.id] ?? 0) + 1; need--; }
    if (need <= 0) break;
  }
}
