import { Card } from '../data/types';
import { compileCard } from '../effects/parse';
import { Cond, Effect } from '../effects/types';
import { Resource, rolesOf } from './synergy';
import { ValueNet, netLogit } from './valuenet';

const isSuperComboCard = (c: Card) => compileCard(c).keywords.has('superCombo');
import {
  GameState, Side, abilitiesOf, activeEnergy, condsHold, matchesFilter, nameHas, cardOf, comboPowerOf, costInHand, hasKeyword, isLeader, other, powerOf, rand,
} from '../engine/core';
import { ChoiceReq, Chooser } from '../engine/effects';
import { Action, battleTotals, legalActions, playCostPlan } from '../engine/game';

// ------------------------------------------------------------------ static card value

/** Rough Fusion World curve: what a vanilla card of this cost usually has. */
const curvePower = (cost: number) => 10000 + 5000 * cost;

function effectValue(e: Effect): number {
  switch (e.t) {
    case 'draw': return 1.0 * e.n;
    case 'lifeToHand': return 0.35 * e.n;
    case 'ko': return 2.2;
    case 'bottom': return 2.0;
    case 'bounce': return 1.5;
    case 'rest': return 0.6;
    case 'lockActive': return 0.6;
    case 'power': return e.target.side === 'opp' ? Math.abs(e.amount) / 10000 : e.amount / (e.dur === 'battle' ? 15000 : 12000);
    case 'comboPower': return e.amount / 15000;
    case 'search': return 0.8;
    case 'dropToHand': return 0.8 * e.each * e.options.length;
    case 'playFrom': return 1.2;
    case 'energyFromDeck': case 'energyFromDrop': case 'energyFromHand': return 1.1;
    case 'energyFromLife': return 0.6;
    case 'activateEnergy': return 0.6 * e.n;
    case 'oppDiscard': return 0.9 * e.n;
    case 'activate': return 0.8;
    case 'grant': return 0.5;
    case 'damageLeader': return 1.2 * e.n;
    case 'cantBlock': return 0.3;
    case 'discard': return -0.8 * e.n;
    case 'mill': return 0;
    case 'ki': return 0.4 * e.n;
    case 'toDrop': return 2.1;
    case 'toEnergy': return 2.0;
    case 'costMod': return 0.3;
    case 'placeMarker': return 0.7 * e.n;
    case 'lifeFromDeck': return 0.6 * e.n;
    case 'handToLife': return 0.1;
    case 'nextDiscount': return 0.6;
    case 'cantPlay': return -0.3;
    case 'oppTax': return 0.8;
    case 'oppPlayRested': return 0.6;
    case 'placeUnder': return 0.3;
    case 'choose': return Math.max(...e.options.map((l) => l.reduce((a, x) => a + effectValue(x), 0)));
    case 'comboFrom': return 0.8 * e.n;
    case 'noop': return 0;
    case 'negate': return 1.0;
    case 'redirect': return 1.0;
    case 'winGame': return 6;
    case 'atEndOfBattle': return e.effects.reduce((a, x) => a + effectValue(x), 0);
    case 'oppMarker': return -0.7 * e.n;
    case 'selfDamage': return -1.0 * e.n;
    case 'energyToDrop': return -1.0 * e.n;
    default: return 0.2;
  }
}

/** Card values by Leader id ('' for no Leader), then by card id. */
const valueByLeader = new Map<string, Map<string, number>>();

/**
 * Whether a condition about the Leader holds for `leader` (unknown leader: assume it can).
 * Only Leader name/trait conditions are decided here; anything else counts as "maybe".
 */
export function leaderCondOk(c: Cond, leader?: Card): boolean {
  if (!leader) return true;
  const low = (x: string) => x.toLowerCase();
  if (c.t === 'leaderIs') return c.names.some((n) => nameHas(leader, n));
  if (c.t === 'leaderTrait') {
    const tr = leader.traits.map(low);
    if (c.only) return tr.length > 0 && tr.every((t) => c.traits.some((x) => low(x) === t));
    return c.traits.some((x) => tr.includes(low(x)));
  }
  return true;
}

const leaderCond = (c: Cond) => c.t === 'leaderIs' || c.t === 'leaderTrait';

/**
 * How good a card is in a vacuum (about 0..6). Used for deckbuilding seeds and choices.
 * With a Leader, skills that need a different Leader are worth nothing, and skills built
 * around this Leader are worth a bit more than an ordinary conditional skill.
 */
export function cardValue(card: Card, leader?: Card): number {
  let byCard = valueByLeader.get(leader?.id ?? '');
  if (!byCard) valueByLeader.set(leader?.id ?? '', (byCard = new Map()));
  const hit = byCard.get(card.id);
  if (hit !== undefined) return hit;
  const cc = compileCard(card);
  let v = 0;
  if (card.type === 'BATTLE') v += 1 + (card.power - curvePower(card.cost)) / 5000;
  if (card.type === 'EXTRA') v += 0.5 - card.cost * 0.15;
  v += card.comboPower / 10000;
  for (const ab of cc.abilities) {
    if (!ab.cond.every((c) => leaderCondOk(c, leader))) { v += ab.unparsed.length * 0.5; continue; }
    let av = ab.effects.reduce((a, e) => a + (e.cond?.every((c) => leaderCondOk(c, leader)) === false ? 0 : effectValue(e)), 0);
    if (ab.timing === 'permanent') av *= ab.turn ? 0.6 : 1;
    if (ab.timing === 'whenAttacking' || ab.timing === 'activateMain') av *= 0.9;
    const other = ab.cond.filter((c) => !leaderCond(c));
    if (other.length) av *= 0.75;
    else if (ab.cond.length) av *= leader ? 1.1 : 0.75; // a skill keyed to this Leader always works
    if (ab.cost.length) av *= 0.7;
    v += av + ab.unparsed.length * 0.5;
  }
  for (const kw of cc.keywords) v += ({ blocker: 0.6, critical: 0.5, doubleStrike: 1.2, tripleStrike: 2, barrier: 0.5, superCombo: 0.3, indestructible: 0.8 } as any)[kw] ?? 0;
  byCard.set(card.id, v);
  return v;
}

export function clearValueCache() {
  valueByLeader.clear();
}

/** Value of an in-play card right now. */
/** A card's static value for the Leader its owner is playing. */
export const valueIn = (s: GameState, u: number) => cardValue(cardOf(s, u), cardOf(s, s.p[s.inst[u].owner].leader));

const boardValue = (s: GameState, u: number) => powerOf(s, u) / 10000 + valueIn(s, u) * 0.3;

/**
 * The opponent's removal: the target filter of every skill that KOs, bounces, bottoms or
 * drops one of our cards, with its copies. Cached per game: decks never change.
 */
const REMOVAL = new Set(['ko', 'bottom', 'bounce', 'toDrop', 'toEnergy']);
const removalMemo = new WeakMap<object, { key: string; by: [[any, number][], [any, number][]] }>();
function removalOf(s: GameState): [[any, number][], [any, number][]] {
  const key = s.deckKey ?? s.p[0].leader + '|' + s.p[1].leader + '|' + s.inst.length;
  const hit = removalMemo.get(s.cards);
  if (hit && hit.key === key) return hit.by;
  const per: [Map<string, [any, number]>, Map<string, [any, number]>] = [new Map(), new Map()];
  for (const i of s.inst) {
    const card = s.cards[i.id];
    if (card.type === 'LEADER') continue;
    const fs: any[] = [];
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (REMOVAL.has(x.t) && x.target && (x.target.side === 'opp' || x.target.side === 'any' || x.target.side === undefined) && x.target.ref === undefined) fs.push(x.target.filter ?? {});
      for (const v of Object.values(x)) if (typeof v === 'object') walk(v);
    };
    for (const ab of compileCard(card).abilities) walk(ab.effects);
    for (const [k, f] of fs.entries()) {
      const id = i.id + '#' + k, m = per[i.owner];
      m.set(id, [f, (m.get(id)?.[1] ?? 0) + 1]);
    }
  }
  const by: [[any, number][], [any, number][]] = [[...per[0].values()], [...per[1].values()]];
  removalMemo.set(s.cards, { key, by });
  return by;
}

/**
 * What a side's deck can use from its own energy: filters of "play ... from your energy",
 * "add ... from your energy to your hand" and "if you have X in your energy". Charging a card
 * that matches is not a loss but a set-up (Goku Black, Turles' Fruit of the Tree of Might).
 */
const energyUseMemo = new WeakMap<object, { key: string; by: [any[], any[]] }>();
function energyUses(s: GameState): [any[], any[]] {
  const key = s.deckKey ?? s.p[0].leader + '|' + s.p[1].leader + '|' + s.inst.length;
  const hit = energyUseMemo.get(s.cards);
  if (hit && hit.key === key) return hit.by;
  const by: [any[], any[]] = [[], []];
  const seen = new Set<string>();
  for (const i of s.inst) {
    if (seen.has(i.owner + i.id)) continue;
    seen.add(i.owner + i.id);
    const walk = (x: any) => {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      // Only skills that care which card is in energy: "3 or more Rest Mode energy" doesn't.
      const specific = (f: any) => f && ['names', 'traits', 'type', 'costLE', 'costEQ', 'powerEQ'].some((k) => f[k] !== undefined);
      if (((x.t === 'playFrom' && x.from === 'energy') || x.t === 'energyToHand') && specific(x.filter)) by[i.owner].push(x.filter);
      if (x.t === 'count' && x.what?.zone === 'energy' && x.what?.side !== 'opp' && specific(x.what.filter)) by[i.owner].push(x.what.filter);
      for (const v of Object.values(x)) if (typeof v === 'object') walk(v);
    };
    const cc = compileCard(s.cards[i.id]);
    for (const ab of [...cc.abilities, ...(cc.backAbilities ?? [])]) walk(ab);
  }
  energyUseMemo.set(s.cards, { key, by });
  return by;
}

/** Does the owner's deck have a use for this card once it is in energy? */
export function usefulInEnergy(s: GameState, u: number): boolean {
  const uses = energyUses(s)[s.inst[u].owner];
  if (!uses.length) return false;
  const c = cardOf(s, u);
  return uses.some((f) => (!f.names || f.names.some((n: string) => nameHas(c, n))) && (!f.type || c.type === f.type)
    && (f.costLE === undefined || c.cost <= f.costLE) && (f.costEQ === undefined || c.cost === f.costEQ)
    && (f.powerEQ === undefined || c.power === f.powerEQ) && (!f.traits || f.traits.some((t: string) => c.traits.some((ct) => ct.toLowerCase().includes(t.toLowerCase())))));
}

/** Card ids with a "you win the game" skill (Gogeta: BR's opponent-at-1-life win). */
const winMemo = new Map<string, boolean>();
function winsGame(card: Card): boolean {
  let hit = winMemo.get(card.id);
  if (hit === undefined) { hit = JSON.stringify(compileCard(card).abilities).includes('"winGame"'); winMemo.set(card.id, hit); }
  return hit;
}
/** Does this side still have an alternate-win card outside its Drop? */
export function altWinLive(s: GameState, p: Side): boolean {
  const pl = s.p[p];
  for (const u of [...pl.hand, ...pl.deck, ...pl.life, ...pl.battle]) if (winsGame(cardOf(s, u))) return true;
  return false;
}

/** 0..1: the share of the opponent's removal (by copies, at least 6) that can hit this body now. */
export function exposure(s: GameState, u: number): number {
  if (hasKeyword(s, u, 'removeImmune')) return 0;
  const opp = other(s.inst[u].owner);
  let n = 0, all = 0;
  for (const [f, copies] of removalOf(s)[opp]) {
    all += copies;
    if (f.costLEv || f.powerLEv || f.costEQv) { n += copies * 0.5; continue; }
    if (matchesFilter(s, u, { ...f, rested: undefined }, s.p[opp].leader)) n += copies;
  }
  return n / Math.max(6, all);
}

/** Value of keeping a card in hand: it is both a play and a combo shield. */
export function keepValue(s: GameState, u: number): number {
  const card = cardOf(s, u);
  const side = s.inst[u].owner;
  const energy = s.p[side].energy.length;
  const castable = card.cost <= energy + 1 ? 1 : 0.6;
  return comboPowerOf(s, u) / 10000 + valueIn(s, u) * 0.5 * castable;
}

// ------------------------------------------------------------------ state evaluation


/**
 * What a side's deck consumes (Ki, Drop size, markers, rested enemy cards...), from the
 * synergy map of every card it owns. Cached per game: the deck never changes.
 */
const needsMemo = new WeakMap<object, [Partial<Record<Resource, number>>, Partial<Record<Resource, number>>]>();
let frozenNeeds: ReturnType<typeof deckNeeds> | null = null;
function deckNeeds(s: GameState, legacy = false): [Partial<Record<Resource, number>>, Partial<Record<Resource, number>>] {
  if (legacy) return frozenNeeds ??= deckNeeds({ ...s, deckKey: 'frozen:' + s.deckKey });
  const hit = needsMemo.get(s.cards);
  const key = s.deckKey ?? s.p[0].leader + '|' + s.p[1].leader + '|' + s.inst.length;
  if (hit && (hit as any).key === key) return hit;
  const out: [Partial<Record<Resource, number>>, Partial<Record<Resource, number>>] = [{}, {}];
  for (const i of s.inst) {
    const r = rolesOf(s.cards[i.id]);
    for (const [res, w] of Object.entries(r.consumes) as [Resource, number][]) out[i.owner][res] = (out[i.owner][res] ?? 0) + w;
  }
  for (const o of out) for (const k of Object.keys(o) as Resource[]) o[k] = Math.min(1, o[k]! / 6);
  (out as any).key = key;
  needsMemo.set(s.cards, out);
  return out;
}

/** The life total at which this side's Leader awakens ("When your life is at 4 or less"), if it awakens on life. */
export function awakenLife(s: GameState, side: Side): number | null {
  const ab = compileCard(cardOf(s, s.p[side].leader)).abilities.find((a) => a.timing === 'awaken');
  const c = ab?.cond.find((x) => x.t === 'lifeLE') as { t: 'lifeLE'; n: number } | undefined;
  return c ? c.n : null;
}

/** How much an awakened Leader is worth: the flip itself plus what its back side does. */
const awakeMemo = new Map<string, number>();
export function awakenedWorth(card: Card): number {
  const hit = awakeMemo.get(card.id);
  if (hit !== undefined) return hit;
  const back = compileCard(card).backAbilities ?? [];
  const v = 0.6 + Math.min(1.6, 0.35 * back.reduce((t, ab) => t + ab.effects.reduce((q, e) => q + Math.max(0, effectValue(e)), 0), 0)) + ((card.back?.power ?? 0) > card.power ? 0.3 : 0);
  awakeMemo.set(card.id, v);
  return v;
}

/** Weights of the position evaluation, so they can be tuned by self-play. */
export interface EvalWeights {
  /** Scale of life's value (log-shaped: the last few life matter most). */
  life: number;
  /** Each card in hand. */
  hand: number;
  /** Each Battle Card in play, plus its power and value. */
  boardBase: number;
  board: number;
  /** Each energy, up to 8. */
  energy: number;
  /** Deck-specific resources (Ki, Drop, markers, rested enemies). */
  resources: number;
  /** Multiplier on how much an awakened Leader is worth (theirs and yours). */
  awaken: number;
  /** Extra worth of each card in hand when its owner is at 3 life or less (it's their defence). */
  handLow?: number;
  /**
   * Risk of leaving your own Battle Cards rested on the opponent's turn (they can be attacked
   * and KO'd): this share of each rested card's board worth is discounted. Only counted at the
   * end of your own turn, when nothing will untap them before the opponent attacks.
   */
  restedRisk?: number;
  /**
   * Learned weights per Leader id for sideFeatures(): when a side's Leader has an entry, its
   * half of the evaluation is the weighted sum of its own features (its deck's own judgement).
   */
  perLeader?: Record<string, Partial<Record<SideFeature, number>>>;
  /** Discount a body by how much of the opponent's removal can reach it (0 = off). */
  reach?: number;
  /** A learned evaluation, blended with the hand-set one by `netBlend` (0..1). */
  net?: ValueNet;
  netBlend?: number;
  /** Testing only: reproduce the old cache bug (every game reused the first game's deck needs). */
  legacyNeeds?: boolean;
  /** Cost of sitting at 1 life while the opponent still has an "opponent at 1 life: you win" card (0 = off). */
  altWin?: number;
}

/** What one side has, feature by feature: the ingredients of a per-Leader evaluation. */
export const SIDE_FEATURES = ['life', 'hand', 'bodies', 'board', 'energy', 'awaken', 'ki', 'drop', 'marker', 'restEnemy'] as const;
export type SideFeature = (typeof SIDE_FEATURES)[number];

export function sideFeatures(s: GameState, p: Side): Record<SideFeature, number> & { deck: number } {
  const pl = s.p[p];
  return {
    life: pl.life.length <= 0 ? -3 : Math.log(1 + pl.life.length),
    hand: pl.hand.length,
    bodies: pl.battle.length,
    board: pl.battle.reduce((t, u) => t + boardValue(s, u), 0),
    energy: Math.min(pl.energy.length, 8),
    awaken: pl.awakened ? awakenedWorth(cardOf(s, pl.leader)) : 0,
    ki: [pl.leader, ...pl.battle].reduce((t, u) => t + Math.min(s.inst[u].ki, 6), 0),
    drop: Math.min(pl.drop.length, 20) / 20,
    marker: Math.min(pl.markers, 2),
    restEnemy: s.p[other(p)].battle.filter((u) => s.inst[u].rested).length,
    deck: pl.deck.length < 6 ? -(6 - pl.deck.length) * 0.5 : 0,
  };
}
/**
 * Tuned by self-play (Oct 2026), in two steps:
 *  1. Weights fitted to 90k fast-AI positions' outcomes, blended 42% from the original
 *     hand-set ones (2.2, 0.45, 0.4, 0.6, 0.35, 1, 1): beat the originals ~59% (800+ games).
 *  2. Weights fitted to 8k strong-AI positions, blended halfway from the originals: beat
 *     step 1 by 57% over 800 strong-AI games. Strong play values hand, energy and the deck's
 *     own resources more, bodies on board less, and life more than the originals.
 * The full fits lost: they predict winners well but overvalue life when choosing moves.
 */
// 3. resources 1.51 -> 0.75 after fixing the deck-needs cache (it reused the first game's decks):
//    with the real needs, half weight beat the old behaviour 52.3% (full 46.3%, none 47.5%).
export const DEFAULT_EVAL: EvalWeights = { life: 4.63, hand: 0.795, boardBase: -0.02, board: 0.654, energy: 1.24, resources: 0.75, awaken: 0.65 };

/** Positive is good for `me`. Roughly in "cards" units. */
export function evaluate(s: GameState, me: Side, W: EvalWeights = DEFAULT_EVAL): number {
  if (s.stage === 'over') return s.winner === -1 ? 0 : s.winner === me ? 100 : -100;
  if (W.net && W.netBlend) {
    const learned = netLogit(W.net, s, me) * W.net.scale;
    if (W.netBlend >= 1) return learned;
    return (1 - W.netBlend) * handEvaluate(s, me, W) + W.netBlend * learned;
  }
  return handEvaluate(s, me, W);
}

function handEvaluate(s: GameState, me: Side, W: EvalWeights): number {
  const side = (p: Side) => {
    const pl = s.p[p];
    const lw = W.perLeader?.[s.inst[pl.leader].id];
    if (lw) {
      const f = sideFeatures(s, p);
      let v = f.deck;
      for (const k of SIDE_FEATURES) v += (lw[k] ?? 0) * f[k];
      return v;
    }
    let v = pl.life.length <= 0 ? -6 : W.life * Math.log(1 + pl.life.length);
    v += pl.hand.length * (W.hand + (pl.life.length <= 3 ? W.handLow ?? 0 : 0));
    const exposed = W.restedRisk && s.active === p && s.stage !== 'over';
    for (const u of pl.battle) v += W.boardBase + boardValue(s, u) * W.board * (exposed && s.inst[u].rested ? 1 - W.restedRisk! : 1) * (W.reach ? 1 - W.reach * exposure(s, u) : 1);
    v += Math.min(pl.energy.length, 8) * W.energy;
    if (W.altWin && pl.life.length === 1 && altWinLive(s, other(p))) v -= W.altWin * (pl.battle.length ? 0.6 : 1);
    // A stronger back side makes awakening worth more, to you and to delay for your opponent.
    v += pl.awakened ? awakenedWorth(cardOf(s, pl.leader)) * (W.awaken ?? 1) : 0;
    if (pl.deck.length < 6) v -= (6 - pl.deck.length) * 0.5;
    // Resources this deck's engine runs on.
    const need = deckNeeds(s, W.legacyNeeds)[p];
    let r = 0;
    if (need.ki) r += need.ki * 0.3 * [pl.leader, ...pl.battle].reduce((t, u) => t + Math.min(s.inst[u].ki, 6), 0);
    if (need.drop) r += need.drop * 1.6 * Math.min(pl.drop.length, 20) / 20;
    if (need.marker) r += need.marker * 0.5 * Math.min(pl.markers, 2);
    if (need.restEnemy) r += need.restEnemy * 0.3 * s.p[other(p)].battle.filter((u) => s.inst[u].rested).length;
    return v + r * W.resources;
  };
  return side(me) - side(other(me));
}

/**
 * The evaluation's ingredients, as (my side - their side) differences, so its weights can
 * be fitted to game outcomes: evaluate() = sum of weight x feature (plus the fixed deck-out term).
 */
export function evalFeatures(s: GameState, me: Side): Record<'life' | 'hand' | 'boardBase' | 'board' | 'energy' | 'awaken' | 'resources' | 'deck', number> {
  const side = (p: Side) => {
    const pl = s.p[p];
    const need = deckNeeds(s)[p];
    let r = 0;
    if (need.ki) r += need.ki * 0.3 * [pl.leader, ...pl.battle].reduce((t, u) => t + Math.min(s.inst[u].ki, 6), 0);
    if (need.drop) r += need.drop * 1.6 * Math.min(pl.drop.length, 20) / 20;
    if (need.marker) r += need.marker * 0.5 * Math.min(pl.markers, 2);
    if (need.restEnemy) r += need.restEnemy * 0.3 * s.p[other(p)].battle.filter((u) => s.inst[u].rested).length;
    return {
      life: pl.life.length <= 0 ? -3 : Math.log(1 + pl.life.length),
      hand: pl.hand.length,
      boardBase: pl.battle.length,
      board: pl.battle.reduce((t, u) => t + boardValue(s, u), 0),
      energy: Math.min(pl.energy.length, 8),
      awaken: pl.awakened ? awakenedWorth(cardOf(s, pl.leader)) : 0,
      resources: r,
      deck: pl.deck.length < 6 ? -(6 - pl.deck.length) * 0.5 : 0,
    };
  };
  const a = side(me), b = side(other(me));
  return Object.fromEntries(Object.keys(a).map((k) => [k, (a as any)[k] - (b as any)[k]])) as any;
}

/** Squash an evaluation into a win probability for `me`. */
export const winProb = (s: GameState, me: Side, W: EvalWeights = DEFAULT_EVAL) => (s.stage === 'over' ? (s.winner === -1 ? 0.5 : s.winner === me ? 1 : 0) : 1 / (1 + Math.exp(-evaluate(s, me, W) / 3)));

// ------------------------------------------------------------------ chooser

export class HeuristicChooser implements Chooser {
  /** Smarter picks when searching or recovering cards: what you can play next turn, Evolves with a base in play, combo cover. */
  constructor(public smartPick = true) {}

  /** How much a card is worth adding to hand right now, for its owner. */
  private gainValue(s: GameState, me: Side, u: number): number {
    const card = cardOf(s, u);
    let v = valueIn(s, u) + card.power / 20000;
    if (!this.smartPick) return v;
    const pl = s.p[me];
    const energy = pl.energy.length + pl.markers;
    if (card.cost <= energy + 1) v += 0.6; // playable next turn
    const ev = compileCard(card).evolve;
    if (ev && pl.battle.some((b) => ev.from.some((f) => matchesFilter(s, b, f, u)) || (ev.orFrom ?? []).some((f) => matchesFilter(s, b, f, u)))) v += 1.2;
    const cover = pl.hand.reduce((t, h) => t + comboPowerOf(s, h), 0);
    if (cover < 30000) v += card.comboPower / 10000 * 0.5;
    return v;
  }

  /**
   * Picks a search decided on for the move it is about to make in the real game: used only
   * for that exact game state (never for imagined copies), in order, and only if still legal.
   */
  public armed: { state: GameState; side: Side; turn: number; picks: number[][] } | null = null;

  choose(s: GameState, req: ChoiceReq): number[] {
    const a = this.armed;
    if (a && (a.state !== s || a.turn !== s.turn)) this.armed = null;
    else if (a && a.side === req.player && a.picks.length) {
      const p = a.picks.shift()!;
      if (!a.picks.length) this.armed = null;
      if (legalPick(req, p)) return p;
    }
    const me = req.player;
    const opts = req.options.slice();
    switch (req.kind) {
      case 'yesno': {
        if (req.effect?.t === 'lifeToHand') return s.p[me].life.length > 3 ? [1] : [];
        return [1];
      }
      case 'discard':
      case 'energyToDrop': {
        const key = (u: number) => (req.kind === 'energyToDrop' ? (s.inst[u].rested ? 0 : 1) * 10 : 0) + keepValue(s, u);
        return opts.sort((a, b) => key(a) - key(b)).slice(0, req.max);
      }
      case 'pick': {
        const key = (u: number) => (req.intent === 'lose' ? -keepValue(s, u) : this.gainValue(s, me, u));
        return opts.sort((a, b) => key(b) - key(a)).slice(0, req.max);
      }
      case 'target': return this.targets(s, req);
      case 'mode': {
        const e = req.effect;
        if (!e || e.t !== 'choose') return [0];
        let best = 0, bestV = -Infinity;
        e.options.forEach((list, i) => { const v = list.reduce((a, x) => a + effectValue(x), 0); if (v > bestV) { bestV = v; best = i; } });
        return [best];
      }
    }
  }

  private targets(s: GameState, req: ChoiceReq): number[] {
    const me = req.player;
    const e = req.effect!;
    let scored: [number, number][];
    if (req.intent === 'harm') {
      // Own cards only when the skill forces a pick ("return 1 of your Battle Cards"): the least valuable first.
      scored = req.options.map((u) => {
        if (s.inst[u].owner === me) return [u, -10 - boardValue(s, u)] as [number, number];
        let v = boardValue(s, u);
        if (e.t === 'power' && powerOf(s, u) + e.amount <= 0) v += 3; // it will drop
        if (e.t === 'rest' && s.inst[u].rested) v -= 5;
        if (s.battle && s.battle.target === u && e.t === 'power') v += 2; // weakens the defender now
        if (s.battle && s.battle.attacker === u && e.t === 'power') v += 2;
        return [u, v];
      });
    } else {
      scored = req.options.filter((u) => s.inst[u].owner === me).map((u) => {
        let v = powerOf(s, u) / 10000;
        const b = s.battle;
        if (b && (b.attacker === u || b.target === u)) v += 10;
        if (e.t === 'activate' && !s.inst[u].rested) v -= 10;
        if (!b && !s.inst[u].rested && e.t === 'power') v += 1; // will attack with it
        return [u, v];
      });
    }
    scored.sort((a, b) => b[1] - a[1]);
    const take = Math.min(scored.length, Math.max(req.min, Math.min(req.max, scored.filter(([, v]) => v > -5).length)));
    return scored.slice(0, take).map(([u]) => u);
  }
}

// ------------------------------------------------------------------ fast policy

export interface Policy {
  act(s: GameState, actions: Action[]): Action;
}

/**
 * A quick, rule-based player used for rollouts and as the baseline opponent.
 * `noise` adds randomness so rollouts explore different lines.
 */
export type Habits = FastPolicy['habits'];

export class FastPolicy implements Policy {
  /**
   * Play habits from experienced players' videos; each can be switched on or off to measure it.
   * Tested against the previous fast AI over 900 games across all meta decks (Oct 2026):
   * awakenHit (take the hit that awakens you) won 53.6%; charge (charge what you won't play
   * soon) and leaderFirst (swing with the Leader before playing) were neutral; delayAwaken
   * (don't push the opponent into awaken range) lost badly as a blanket rule (38%), as the
   * video itself says it depends on the matchup. Only awakenHit is on by default.
   */
  public habits = { charge: false, leaderFirst: false, delayAwaken: false, awakenHit: true, smartMulligan: false, smartBlock: false, holdRemoval: false, delayStrongAwaken: false, noFutileCombo: true };
  constructor(public noise = 0.1) {
    const env = (globalThis as any).process?.env;
    if (env?.HABITS_OFF) for (const k of String(env.HABITS_OFF).split(',')) (this.habits as any)[k] = false;
    if (env?.HABITS_ON) for (const k of String(env.HABITS_ON).split(',')) (this.habits as any)[k] = true;
  }

  act(s: GameState, actions: Action[]): Action {
    if (actions.length === 1) return actions[0];
    switch (s.stage) {
      case 'mulligan': return this.mulligan(s);
      case 'charge': return this.charge(s, actions);
      case 'main': return this.main(s, actions);
      case 'counter': return this.counter(s, actions);
      case 'block': return this.block(s, actions);
      case 'offCombo': return this.offCombo(s, actions);
      case 'defCombo': return this.defCombo(s, actions);
      default: return actions[0];
    }
  }

  private mulligan(s: GameState): Action {
    const me = s.p[s.toAct];
    const early = me.hand.filter((u) => { const c = cardOf(s, u); return c.type === 'BATTLE' && c.cost <= 2; }).length;
    if (this.habits.smartMulligan) {
      // Keep hands that start the engine: two cheap plays, or one cheap searcher/cantrip plus
      // another cheap play. Throw back hands stuck with three or more 5+ cost non-combo cards.
      const cards = me.hand.map((u) => cardOf(s, u));
      const starter = cards.some((c) => c.type === 'BATTLE' && c.cost <= 2 && compileCard(c).abilities.some((ab) => ab.timing === 'onPlay' && ab.effects.some((e) => e.t === 'search' || e.t === 'draw' || e.t === 'dropToHand')));
      const heavy = cards.filter((c) => c.cost >= 5 && !isSuperComboCard(c)).length;
      if (heavy >= 3) return { k: 'mulligan' };
      return early >= 2 || (starter && early >= 1 && cards.some((c) => c.cost <= 2 && c.type === 'EXTRA')) ? { k: 'keep' } : { k: 'mulligan' };
    }
    return early >= 2 ? { k: 'keep' } : { k: 'mulligan' };
  }

  private charge(s: GameState, actions: Action[]): Action {
    const me = s.p[s.toAct];
    const charges = actions.filter((a) => a.k === 'charge') as { k: 'charge'; uid: number }[];
    if (!charges.length) return { k: 'noCharge' };
    // Only charge up to what the cards you mean to play need: Super Combos are combo walls,
    // not plays, so their cost doesn't count. Once the plan is covered, keep cards in hand.
    const playable = me.hand.map((u) => cardOf(s, u)).filter((c) => !this.habits.charge || !isSuperComboCard(c));
    const maxCost = Math.max(0, ...playable.map((c) => c.cost));
    const want = me.energy.length < Math.min(7, Math.max(4, maxCost)) || me.energy.length < 3;
    if (!want || me.hand.length <= 2) return { k: 'noCharge' };
    // Charge the card you're least likely to play soon: spare copies and cards far above your
    // energy go first; cheap cards you'll play next turn and Super Combos (defence) stay.
    const ids = me.hand.map((u) => s.inst[u].id);
    const score = (u: number) => {
      const c = cardOf(s, u);
      const copies = ids.filter((x) => x === c.id).length;
      const soon = c.cost <= me.energy.length + 1 ? 0.5 : 0;
      const tooExpensive = c.cost > me.energy.length + 3 ? -0.6 : 0;
      const forEnergy = usefulInEnergy(s, u) ? -1 : 0;
      if (!this.habits.charge) return keepValue(s, u) + tooExpensive + forEnergy + rand(s) * this.noise;
      return keepValue(s, u) + soon + tooExpensive - (copies > 1 ? 0.4 : 0) + (isSuperComboCard(c) ? 2 : 0) + rand(s) * this.noise;
    };
    charges.sort((a, b) => score(a.uid) - score(b.uid));
    return charges[0];
  }

  private main(s: GameState, actions: Action[]): Action {
    const side = s.toAct;
    const opp = other(side);
    const me = s.p[side];
    if (actions.some((a) => a.k === 'awaken')) return { k: 'awaken' };
    // Activated skills that do something now.
    for (const a of actions) {
      if (a.k !== 'activate') continue;
      const inHand = me.hand.includes(a.uid);
      if (!inHand) return a; // leader / field skills are usually free value
      const ab = this.abOf(s, a.uid, a.ab);
      const hits = ab?.effects.some((e) => (e.t === 'ko' || e.t === 'bottom' || e.t === 'bounce') && s.p[opp].battle.length > 0);
      if (hits && rand(s) > this.noise) return a;
    }
    // Swing with the Leader first: its draw shows more options before you commit cards.
    const leaderFace = actions.find((a) => a.k === 'attack' && a.uid === me.leader && isLeader(s, a.target)) as { k: 'attack'; uid: number; target: number } | undefined;
    if (this.habits.leaderFirst && leaderFace && !this.awakensThem(s, leaderFace.uid) && !s.p[opp].battle.some((u) => s.inst[u].rested && powerOf(s, u) <= powerOf(s, me.leader) && boardValue(s, u) >= 2.2)) return leaderFace;
    // Play the best card we can afford. When new cards can't attack this turn (a rules
    // option), only cards that hit the opponent's board go before the attacks; the rest
    // wait, keeping the hand as combo cover meanwhile.
    const plays = actions.filter((a) => a.k === 'play') as { k: 'play'; uid: number }[];
    const attacksLeft = actions.some((a) => a.k === 'attack');
    const removal = (u: number) => s.p[opp].battle.length > 0 && compileCard(cardOf(s, u)).abilities.some((ab) => ab.timing === 'onPlay' && ab.effects.some((e) =>
      e.t === 'ko' || e.t === 'bottom' || e.t === 'bounce' || e.t === 'toDrop' || e.t === 'toEnergy' || e.t === 'rest' || (e.t === 'power' && e.amount < 0)));
    if (plays.length) {
      const score = (u: number) => valueIn(s, u) + costInHand(s, u) * 0.6 + rand(s) * this.noise * 2;
      let now = attacksLeft && !s.rules.attackOnPlayTurn ? plays.filter((p) => removal(p.uid)) : plays;
      // Hold removal that has nothing to hit: its value comes later, against a real target.
      if (this.habits.holdRemoval) {
        const pointless = (u: number) => s.p[opp].battle.length === 0 && compileCard(cardOf(s, u)).abilities.some((ab) => ab.timing === 'onPlay' && ab.effects.length > 0 && ab.effects.every((e) => ['ko', 'bottom', 'bounce', 'toDrop', 'rest', 'lockActive', 'power'].includes(e.t) && (!('target' in e) || (e as any).target?.side !== 'self')));
        const kept = now.filter((p) => !pointless(p.uid));
        if (kept.length) now = kept; else if (now.length) now = [];
      }
      now.sort((a, b) => score(b.uid) - score(a.uid));
      const best = now[0];
      // Keep at least one combo card in hand when life is low.
      if (best && !(me.life.length <= 2 && me.hand.length <= 1)) return best;
    }
    // Attacks.
    const attacks = actions.filter((a) => a.k === 'attack') as { k: 'attack'; uid: number; target: number }[];
    if (attacks.length) {
      const byAttacker = new Map<number, { k: 'attack'; uid: number; target: number }[]>();
      for (const a of attacks) byAttacker.set(a.uid, [...(byAttacker.get(a.uid) ?? []), a]);
      // Battle cards first, leader last (its draw is safe either way).
      const order = [...byAttacker.keys()].sort((a, b) => (isLeader(s, a) ? 1 : 0) - (isLeader(s, b) ? 1 : 0) || powerOf(s, b) - powerOf(s, a));
      for (const att of order) {
        const opts = byAttacker.get(att)!;
        const ap = powerOf(s, att);
        // A rested battle card we beat outright is a free KO.
        // Worth it for a card that matters; otherwise pressure on the Leader is better.
        const kos = opts.filter((o) => !isLeader(s, o.target) && powerOf(s, o.target) <= ap && boardValue(s, o.target) >= 2.2);
        if (kos.length && rand(s) > 0.25) {
          kos.sort((a, b) => boardValue(s, b.target) - boardValue(s, a.target));
          return kos[0];
        }
        const face = opts.find((o) => isLeader(s, o.target));
        if (!face) continue;
        // Don't knock the opponent into their awaken range unless the game is close to over.
        if (this.habits.delayAwaken && this.awakensThem(s, att)) continue;
        // Matchup-aware version: only hold back when their awakened side is clearly the bigger threat.
        if (this.habits.delayStrongAwaken && this.awakensThem(s, att) && awakenedWorth(cardOf(s, s.p[opp].leader)) >= 1.8) continue;
        const lp = powerOf(s, face.target);
        if (isLeader(s, att) || ap >= lp || rand(s) < this.noise) return face;
      }
    }
    // A card that must attack whenever possible removes the option to end the turn.
    return actions.some((a) => a.k === 'end') ? { k: 'end' } : attacks[0] ?? actions[0];
  }

  /** Would a hit from `attacker` push the opponent down to the life where their Leader awakens? */
  private awakensThem(s: GameState, attacker: number): boolean {
    const opp = other(s.toAct);
    const o = s.p[opp];
    if (o.awakened) return false;
    const at = awakenLife(s, opp);
    if (at === null) return false;
    const dmg = hasKeyword(s, attacker, 'tripleStrike') ? 3 : hasKeyword(s, attacker, 'doubleStrike') ? 2 : 1;
    return o.life.length > at && o.life.length - dmg <= at && o.life.length - dmg > 2;
  }

  private abOf(s: GameState, uid: number, i: number) {
    return compileCard(cardOf(s, uid)).abilities[i];
  }

  private counter(s: GameState, actions: Action[]): Action {
    const c = actions.find((a) => a.k === 'counter');
    return c && rand(s) > this.noise ? c : { k: 'noCounter' };
  }

  private block(s: GameState, actions: Action[]): Action {
    const b = s.battle!;
    const me = s.p[s.toAct];
    if (!isLeader(s, b.target)) return { k: 'noBlock' };
    const strike = hasKeyword(s, b.attacker, 'doubleStrike') || hasKeyword(s, b.attacker, 'tripleStrike');
    const blocks = actions.filter((a) => a.k === 'block') as { k: 'block'; uid: number }[];
    if (!blocks.length) return { k: 'noBlock' };
    blocks.sort((a, b2) => boardValue(s, a.uid) - boardValue(s, b2.uid));
    if (this.habits.smartBlock) {
      // Block when the hit is dangerous, or when a cheap blocker survives the fight for free.
      const crit = hasKeyword(s, b.attacker, 'critical');
      const ap = powerOf(s, b.attacker);
      const survives = blocks.find((x) => powerOf(s, x.uid) >= ap && boardValue(s, x.uid) < 3);
      if (me.life.length <= 3 || ((strike || crit) && me.life.length <= 5)) return blocks[0];
      if (survives) return survives;
      return { k: 'noBlock' };
    }
    if (me.life.length <= 2 || (strike && me.life.length <= 5) || rand(s) < 0.15) return blocks[0];
    return { k: 'noBlock' };
  }

  /** Pick the cheapest combo option that covers `need`, or the biggest if none does. */
  private comboPick(s: GameState, actions: Action[], need: number): Action | null {
    const combos = actions.filter((a) => a.k === 'combo' || a.k === 'battleSkill') as (Action & { uid: number })[];
    if (!combos.length) return null;
    const gain = (a: { k: string; uid: number }) => {
      if (a.k === 'battleSkill') return 15000;
      const c = cardOf(s, a.uid);
      const fromHand = s.p[s.toAct].hand.includes(a.uid);
      const bonus = fromHand && s.active !== s.toAct ? compileCard(c).abilities.filter((x) => x.timing === 'comboFromHand').reduce((t, x) => t + x.effects.reduce((q, e) => q + (e.t === 'comboPower' ? e.amount : 0), 0), 0) : 0;
      return comboPowerOf(s, a.uid) + bonus;
    };
    const cost = (a: { k: string; uid: number }) => (a.k === 'battleSkill' ? 0.4 : s.p[s.toAct].battle.includes(a.uid) ? boardValue(s, a.uid) + 0.5 : keepValue(s, a.uid) * 0.5);
    const covering = combos.filter((a) => gain(a) >= need).sort((a, b) => cost(a) - cost(b));
    if (covering.length) return covering[0];
    combos.sort((a, b) => gain(b) - gain(a));
    return combos[0];
  }

  /**
   * A battle skill on the field that adds no power but gives value (draws, life, removal),
   * like Jiren FB03-009's "take 1 damage: put the top card of your deck into your life".
   * Worth using whenever it's offered, as long as its cost can't lose the game.
   */
  private freeValueSkill(s: GameState, actions: Action[]): Action | null {
    const me = s.p[s.toAct];
    for (const a of actions) {
      if (a.k !== 'battleSkill' || me.hand.includes(a.uid)) continue;
      const ab = abilitiesOf(s, a.uid)[a.ab];
      if (!ab || ab.effects.some((e) => e.t === 'power' || e.t === 'comboPower')) continue;
      const risky = ab.cost.some((c) => (c.t === 'takeDamage' || c.t === 'lifeToDrop' || c.t === 'lifeToHand') && me.life.length <= ((c as { n?: number }).n ?? 1) + 1);
      if (risky) continue;
      // Taking damage or moving life to hand is a card gained, not a price.
      const v = ab.effects.reduce((t, e) => t + effectValue(e), 0) + ab.cost.reduce((t, c) => t + (c.t === 'takeDamage' || c.t === 'lifeToHand' ? 0.4 : -0.3), 0);
      if (v > 0.4) return a;
    }
    return null;
  }

  private offCombo(s: GameState, actions: Action[]): Action {
    if (this.habits.noFutileCombo && !comboCanWin(s, actions)) return { k: 'comboDone' };
    const free = this.freeValueSkill(s, actions);
    if (free) return free;
    const b = s.battle!;
    const { atk, def } = battleTotals(s);
    if (atk >= def) return { k: 'comboDone' };
    const need = def - atk;
    const opp = s.p[other(s.toAct)];
    const lethalish = isLeader(s, b.target) && opp.life.length <= 2;
    const worth = lethalish || (!isLeader(s, b.target) && boardValue(s, b.target) > 2.5);
    if (!worth || need > 20000) return { k: 'comboDone' };
    return this.comboPick(s, actions, need) ?? { k: 'comboDone' };
  }

  private defCombo(s: GameState, actions: Action[]): Action {
    const free = this.freeValueSkill(s, actions);
    if (free) return free;
    if (this.habits.noFutileCombo && !comboCanWin(s, actions)) return { k: 'comboDone' };
    const b = s.battle!;
    const me = s.p[s.toAct];
    const { atk, def } = battleTotals(s);
    if (def > atk) return { k: 'comboDone' };
    const need = atk - def + 1;
    let budget: number;
    if (isLeader(s, b.target)) {
      const dmg = hasKeyword(s, b.attacker, 'tripleStrike') ? 3 : hasKeyword(s, b.attacker, 'doubleStrike') ? 2 : 1;
      const after = me.life.length - dmg;
      // Taking a hit at high life just moves a life card to hand, so don't spend cards on it.
      budget = after <= 0 ? 99 : after <= 1 ? 40000 : after <= 2 ? 30000 : after <= 3 ? 15000 : after <= 4 ? (me.hand.length >= 7 ? 10000 : 0) : 0;
      // Take the hit that awakens your Leader (unless it leaves you too low), then defend the rest.
      const at = awakenLife(s, s.toAct);
      if (this.habits.awakenHit && !me.awakened && at !== null && me.life.length > at && after <= at && after >= 3) budget = 0;
      if (hasKeyword(s, b.attacker, 'critical')) budget += 5000;
    } else {
      budget = boardValue(s, b.target) > 3 ? 10000 : 0;
    }
    budget *= 1 + (rand(s) - 0.5) * this.noise;
    const already = s.p[s.toAct].combo.reduce((a, u) => a + comboPowerOf(s, u), 0);
    if (need + already > budget) return { k: 'comboDone' };
    return this.comboPick(s, actions, need) ?? { k: 'comboDone' };
  }
}

/** Skills that fire when the card is used in a combo (a Super Combo's +10000 on the opponent's turn...). */
const COMBO_TIMINGS = new Set(['comboFromHand', 'comboFromField', 'comboFromDrop']);
const hasComboSkill = (s: GameState, u: number) => abilitiesOf(s, u).some((ab) => COMBO_TIMINGS.has(ab.timing));

/**
 * Can the side to act still win this battle with the combo cards it has left? Ties go to the
 * attacker, so a defender needs more than the attack, an attacker at least the defence. Combo
 * cards that can't get there are thrown away for nothing (a 5000 Piccolo against a 5000 gap).
 * Battle skills and "when you combo" cards in the battle may add more than we can count: true.
 */
export function comboCanWin(s: GameState, actions: Action[]): boolean {
  if (!s.battle) return true;
  if (actions.some((a) => a.k === 'battleSkill' || a.k === 'counter')) return true;
  const me = s.toAct;
  const b = s.battle;
  const mine = me === b.atkSide ? b.attacker : b.target;
  if (abilitiesOf(s, mine).some((ab) => ab.timing === 'whenComboInBattle')) return true;
  const { atk, def } = battleTotals(s);
  let extra = 0;
  for (const a of actions) if (a.k === 'combo') extra += comboPowerOf(s, a.uid) + (hasComboSkill(s, a.uid) ? 10000 : 0);
  return me === b.atkSide ? atk + extra >= def : def + extra > atk;
}

export const defaultChooser = new HeuristicChooser();

/**
 * An Extra or skill used for its minor part while its main, conditional part can't happen
 * yet (Warrior Who Defeats the Evil Demon with no Evolve card in play: just "draw 1").
 * Holding it keeps the strong part for later.
 */
export function wastesMainEffect(s: GameState, a: Action): boolean {
  if (a.k !== 'activate') return false;
  const me = s.p[s.toAct];
  if (!me.hand.includes(a.uid)) return false;
  const ab = compileCard(cardOf(s, a.uid)).abilities[a.ab];
  if (!ab) return false;
  let live = 0, dead = 0;
  for (const e of ab.effects) {
    const v = Math.max(0, effectValue(e));
    if (e.cond?.length && !condsHold(s, s.toAct, a.uid, e.cond)) dead += v; else live += v;
  }
  return dead > 0 && dead > live;
}

/** Is `p` a legal answer to `req`? */
export const legalPick = (req: ChoiceReq, p: number[]) => p.length >= req.min && p.length <= req.max && p.every((u) => req.options.includes(u)) && new Set(p).size === p.length;

/** Answers `side`'s next choices with fixed picks (when legal), everything else like the default. */
export class ForcedChooser implements Chooser {
  constructor(public side: Side, public picks: number[][]) { this.picks = picks.slice(); }
  choose(s: GameState, req: ChoiceReq): number[] {
    if (req.player === this.side && this.picks.length) {
      const p = this.picks.shift()!;
      if (legalPick(req, p)) return p;
    }
    return defaultChooser.choose(s, req);
  }
}

/** Plays like the default, and remembers `side`'s first choice and the default's ranking of its options. */
export class RecordingChooser implements Chooser {
  first: { req: ChoiceReq; pick: number[]; ranked: number[] } | null = null;
  constructor(public side: Side) {}
  choose(s: GameState, req: ChoiceReq): number[] {
    const pick = defaultChooser.choose(s, req);
    if (!this.first && req.player === this.side) {
      const ranked = req.kind === 'mode' ? req.options.slice() : defaultChooser.choose(s, { ...req, min: 0, max: req.options.length });
      this.first = { req, pick, ranked: [...ranked, ...req.options.filter((u) => !ranked.includes(u))] };
    }
    return pick;
  }
}

/** Play a game to the end with a policy for each side. */
export function playout(s: GameState, policies: [Policy, Policy], maxSteps = 4000): GameState {
  const ctl: [Chooser, Chooser] = [defaultChooser, defaultChooser];
  let steps = 0;
  while (s.stage !== 'over' && steps++ < maxSteps) {
    const acts = legalActions(s);
    if (!acts.length) break;
    const a = policies[s.toAct].act(s, acts);
    stepWith(s, a, ctl);
  }
  return s;
}

import { step as stepWith } from '../engine/game';
export { activeEnergy, playCostPlan };
