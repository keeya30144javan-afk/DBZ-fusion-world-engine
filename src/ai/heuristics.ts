import { Card } from '../data/types';
import { compileCard } from '../effects/parse';
import { Effect } from '../effects/types';
import {
  GameState, Side, activeEnergy, cardOf, comboPowerOf, costInHand, hasKeyword, isLeader, other, powerOf, rand,
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
    case 'winGame': return 50;
    case 'atEndOfBattle': return e.effects.reduce((a, x) => a + effectValue(x), 0);
    case 'oppMarker': return -0.7 * e.n;
    case 'selfDamage': return -1.0 * e.n;
    case 'energyToDrop': return -1.0 * e.n;
    default: return 0.2;
  }
}

const valueCache = new Map<string, number>();

/** How good a card is in a vacuum (about 0..6). Used for deckbuilding seeds and choices. */
export function cardValue(card: Card): number {
  const hit = valueCache.get(card.id);
  if (hit !== undefined) return hit;
  const cc = compileCard(card);
  let v = 0;
  if (card.type === 'BATTLE') v += 1 + (card.power - curvePower(card.cost)) / 5000;
  if (card.type === 'EXTRA') v += 0.5 - card.cost * 0.15;
  v += card.comboPower / 10000;
  for (const ab of cc.abilities) {
    let av = ab.effects.reduce((a, e) => a + effectValue(e), 0);
    if (ab.timing === 'permanent') av *= ab.turn ? 0.6 : 1;
    if (ab.timing === 'whenAttacking' || ab.timing === 'activateMain') av *= 0.9;
    if (ab.cond.length) av *= 0.75;
    if (ab.cost.length) av *= 0.7;
    v += av + ab.unparsed.length * 0.5;
  }
  for (const kw of cc.keywords) v += ({ blocker: 0.6, critical: 0.5, doubleStrike: 1.2, tripleStrike: 2, barrier: 0.5, superCombo: 0.3, indestructible: 0.8 } as any)[kw] ?? 0;
  valueCache.set(card.id, v);
  return v;
}

export function clearValueCache() {
  valueCache.clear();
}

/** Value of an in-play card right now. */
const boardValue = (s: GameState, u: number) => powerOf(s, u) / 10000 + cardValue(cardOf(s, u)) * 0.3;

/** Value of keeping a card in hand: it is both a play and a combo shield. */
export function keepValue(s: GameState, u: number): number {
  const card = cardOf(s, u);
  const side = s.inst[u].owner;
  const energy = s.p[side].energy.length;
  const castable = card.cost <= energy + 1 ? 1 : 0.6;
  return comboPowerOf(s, u) / 10000 + cardValue(card) * 0.5 * castable;
}

// ------------------------------------------------------------------ state evaluation

const lifeWorth = (l: number) => (l <= 0 ? -6 : 2.2 * Math.log(1 + l));

/** Positive is good for `me`. Roughly in "cards" units. */
export function evaluate(s: GameState, me: Side): number {
  if (s.stage === 'over') return s.winner === -1 ? 0 : s.winner === me ? 100 : -100;
  const side = (p: Side) => {
    const pl = s.p[p];
    let v = lifeWorth(pl.life.length);
    v += pl.hand.length * 0.45;
    for (const u of pl.battle) v += 0.4 + boardValue(s, u) * 0.6;
    v += Math.min(pl.energy.length, 8) * 0.35;
    v += pl.awakened ? 0.6 : 0;
    if (pl.deck.length < 6) v -= (6 - pl.deck.length) * 0.5;
    return v;
  };
  return side(me) - side(other(me));
}

/** Squash an evaluation into a win probability for `me`. */
export const winProb = (s: GameState, me: Side) => (s.stage === 'over' ? (s.winner === -1 ? 0.5 : s.winner === me ? 1 : 0) : 1 / (1 + Math.exp(-evaluate(s, me) / 3)));

// ------------------------------------------------------------------ chooser

export class HeuristicChooser implements Chooser {
  choose(s: GameState, req: ChoiceReq): number[] {
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
        const key = (u: number) => (req.intent === 'lose' ? -keepValue(s, u) : cardValue(cardOf(s, u)) + cardOf(s, u).power / 20000);
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
export class FastPolicy implements Policy {
  constructor(public noise = 0.1) {}

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
    return early >= 2 ? { k: 'keep' } : { k: 'mulligan' };
  }

  private charge(s: GameState, actions: Action[]): Action {
    const me = s.p[s.toAct];
    const charges = actions.filter((a) => a.k === 'charge') as { k: 'charge'; uid: number }[];
    if (!charges.length) return { k: 'noCharge' };
    const maxCost = Math.max(0, ...me.hand.map((u) => cardOf(s, u).cost));
    const want = me.energy.length < Math.min(7, Math.max(4, maxCost)) || me.energy.length < 3;
    if (!want || me.hand.length <= 2) return { k: 'noCharge' };
    // Charge the card least worth keeping; uncastable high costs early are good fodder.
    const score = (u: number) => {
      const c = cardOf(s, u);
      const tooExpensive = c.cost > me.energy.length + 3 ? -0.6 : 0;
      return keepValue(s, u) + tooExpensive + rand(s) * this.noise;
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
    // Play the best card we can afford.
    const plays = actions.filter((a) => a.k === 'play') as { k: 'play'; uid: number }[];
    if (plays.length) {
      const score = (u: number) => cardValue(cardOf(s, u)) + costInHand(s, u) * 0.6 + rand(s) * this.noise * 2;
      plays.sort((a, b) => score(b.uid) - score(a.uid));
      const best = plays[0];
      // Keep at least one combo card in hand when life is low.
      if (!(me.life.length <= 2 && me.hand.length <= 1)) return best;
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
        const kos = opts.filter((o) => !isLeader(s, o.target) && powerOf(s, o.target) <= ap);
        if (kos.length && rand(s) > 0.35) {
          kos.sort((a, b) => boardValue(s, b.target) - boardValue(s, a.target));
          return kos[0];
        }
        const face = opts.find((o) => isLeader(s, o.target));
        if (!face) continue;
        const lp = powerOf(s, face.target);
        if (isLeader(s, att) || ap >= lp || rand(s) < this.noise) return face;
      }
    }
    // A card that must attack whenever possible removes the option to end the turn.
    return actions.some((a) => a.k === 'end') ? { k: 'end' } : attacks[0] ?? actions[0];
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
    if (me.life.length <= 2 || (strike && me.life.length <= 5) || rand(s) < 0.15) {
      blocks.sort((a, b2) => boardValue(s, a.uid) - boardValue(s, b2.uid));
      return blocks[0];
    }
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

  private offCombo(s: GameState, actions: Action[]): Action {
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
    const b = s.battle!;
    const me = s.p[s.toAct];
    const { atk, def } = battleTotals(s);
    if (def > atk) return { k: 'comboDone' };
    const need = atk - def + 1;
    let budget: number;
    if (isLeader(s, b.target)) {
      const dmg = hasKeyword(s, b.attacker, 'tripleStrike') ? 3 : hasKeyword(s, b.attacker, 'doubleStrike') ? 2 : 1;
      const after = me.life.length - dmg;
      budget = after <= 0 ? 99 : after <= 2 ? 40000 : after <= 4 ? 25000 : me.hand.length >= 6 ? 20000 : 10000;
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

export const defaultChooser = new HeuristicChooser();

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
