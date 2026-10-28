import { GameState, Side } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, battleTotals, legalActions, step } from '../engine/game';
import { determinize } from './belief';
import { EvalWeights, FastPolicy, Habits, Policy, defaultChooser, keepValue, wastesMainEffect, winProb } from './heuristics';
import { Card } from '../data/types';
import { compileCard } from '../effects/parse';
import { cardOf, hasKeyword, isLeader, other } from '../engine/core';
import { PlanOpts, PlannedLine, planTurn } from './planner';

export interface SearchOpts {
  /** Simulations per decision. */
  iterations: number;
  /** How many turns past the current one each simulation looks before judging the position. */
  horizon: number;
  /** UCB exploration constant. */
  c: number;
  /** Plan whole turns (lines of play) for main-phase decisions instead of judging one action at a time. */
  plan?: PlanOpts;
  /** Evaluation weights for judging positions (defaults otherwise). */
  eval?: EvalWeights;
  /** Habits of the fast AI used in imagined games. */
  habits?: Partial<Habits>;
  /** Mulligan by rollouts ('search', default) or by whether the hand can start the deck's plan ('plan'). */
  mulligan?: 'search' | 'plan';
  /** When the chosen line swings with the Leader later, swing with it first (its draw may change the plan). */
  leaderFirst?: boolean;
  /** Don't consider wasteful moves: see prune(). */
  prune?: { offCombo?: boolean; earlyDefense?: boolean | number; weakExtras?: boolean; chargeSpares?: boolean };
}

/**
 * Main-phase decisions are made by the turn planner (whole lines of play, judged
 * through the opponent's reply and our next turn); the rest (combos, blocks,
 * counters, charging) by the per-move search. Planning beat per-move search 68% of
 * the time over 96 games (starters and player lists), at about the same speed.
 */
export const SEARCH_LEVELS: Record<string, SearchOpts> = {
  quick: { iterations: 48, horizon: 2, c: 0.7, plan: { beam: 6, depth: 14, finalists: 6, worlds: 8, deep: true } },
  strong: { iterations: 160, horizon: 3, c: 0.7, plan: { beam: 8, depth: 16, finalists: 8, worlds: 12, deep: true } },
  deep: { iterations: 500, horizon: 4, c: 0.6, plan: { beam: 10, depth: 18, finalists: 10, worlds: 20, deep: true } },
};

const ctl: [Chooser, Chooser] = [defaultChooser, defaultChooser];

/** Simulations run vs. budgeted, for benchmarking (cli). */
export const searchStats = { decisions: 0, sims: 0, budget: 0 };

/** Run a world forward with the fast policy until `untilTurn` or the end. */
function rollout(w: GameState, pol: Policy, untilTurn: number) {
  let n = 0;
  while (w.stage !== 'over' && w.turn <= untilTurn && n++ < 3000) {
    const acts = legalActions(w);
    if (!acts.length) break;
    step(w, pol.act(w, acts), ctl);
  }
}

/**
 * Perfect-information Monte Carlo search over imagined worlds.
 * Each simulation: re-deal what this player cannot see, try one candidate
 * action (chosen by UCB1), play on with the fast policy for a few turns, score
 * the position. The candidate with the best average wins.
 */
export class SearchPolicy implements Policy {
  private roll = new FastPolicy(0.15);
  public lastStats: { action: Action; visits: number; value: number }[] = [];
  /** The lines the turn planner compared for the last main-phase decision, best first. */
  public lastLines: PlannedLine[] = [];

  constructor(public opts: SearchOpts = SEARCH_LEVELS.quick) {
    if (opts.habits) Object.assign(this.roll.habits, opts.habits);
  }

  act(s: GameState, actions: Action[]): Action {
    const me = s.toAct as Side;
    if (defaultChooser.armed?.side === me) defaultChooser.armed = null; // a pick planned for an earlier move never applies to this one
    if (s.stage === 'mulligan' && this.opts.mulligan === 'plan') return planMulligan(s) ? { k: 'keep' } : { k: 'mulligan' };
    const cands = this.prune(s, actions);
    if (cands.length === 1) return cands[0];
    if (this.opts.plan && s.stage === 'main' && s.active === me) {
      const po = { ...this.opts.plan, ...(this.opts.eval ? { eval: this.opts.eval } : {}), ...(this.opts.prune?.weakExtras ? { skipWeakExtras: true } : {}) };
      const lines = planTurn(s, me, po);
      let first = lines[0]?.actions[0];
      let pick = lines[0]?.picks?.[0];
      // Information first: if the best line swings with the Leader later and nothing before
      // that swing changes the fight, swing now and see the drawn card before committing.
      if (this.opts.leaderFirst && lines[0] && first?.k !== 'attack') {
        const li = lines[0].actions.findIndex((a) => a.k === 'attack' && isLeader(s, a.uid));
        const before = li > 0 ? lines[0].actions.slice(0, li) : [];
        const harmless = before.every((a) => a.k === 'play' && !compileCard(cardOf(s, a.uid)).abilities.some((ab) => ab.timing === 'onPlay' && ab.effects.some((e) => ['ko', 'bottom', 'bounce', 'toDrop', 'rest', 'power', 'lockActive', 'grant'].includes(e.t))));
        if (li > 0 && harmless) { first = lines[0].actions[li]; pick = lines[0].picks?.[li]; }
      }
      const legal = first && cands.find((a) => JSON.stringify(a) === JSON.stringify(first));
      if (legal) {
        this.lastLines = lines;
        this.lastStats = [];
        // Make the real move with the choice the line was planned with (KO target, card searched...).
        defaultChooser.armed = pick ? { state: s, side: me, turn: s.turn, picks: [pick] } : null;
        return legal;
      }
    }
    this.lastLines = [];
    const n = cands.length;
    const visits = new Array(n).fill(0);
    const total = new Array(n).fill(0);
    const iters = Math.max(this.opts.iterations, n * 4);
    searchStats.decisions++; searchStats.budget += iters;
    for (let it = 0; it < iters; it++) {
      searchStats.sims++;
      let pick = -1;
      if (it < n) pick = it;
      else {
        let best = -Infinity;
        const logN = Math.log(it);
        for (let i = 0; i < n; i++) {
          const ucb = total[i] / visits[i] + this.opts.c * Math.sqrt(logN / visits[i]);
          if (ucb > best) { best = ucb; pick = i; }
        }
      }
      const w = determinize(s, me);
      step(w, cands[pick], ctl);
      rollout(w, this.roll, s.turn + this.opts.horizon);
      visits[pick]++;
      total[pick] += winProb(w, me, this.opts.eval);
      // Stop early once one option is clearly ahead: every option has been tried a few
      // times and the leader beats the runner-up by a wide margin on both mean and visits.
      if (it >= n * 6 && it % 8 === 7) {
        let a = -1, b = -1;
        for (let i = 0; i < n; i++) {
          const m = total[i] / visits[i];
          if (a < 0 || m > total[a] / visits[a]) { b = a; a = i; } else if (b < 0 || m > total[b] / visits[b]) b = i;
        }
        if (b >= 0 && visits[a] >= 12 && total[a] / visits[a] - total[b] / visits[b] > 0.12 && visits[a] >= 2 * visits[b]) break;
      }
    }
    let bestI = 0;
    for (let i = 1; i < n; i++) if (total[i] / visits[i] > total[bestI] / visits[bestI]) bestI = i;
    this.lastStats = cands.map((a, i) => ({ action: a, visits: visits[i], value: total[i] / visits[i] }));
    return cands[bestI];
  }

  /** Cut obviously equivalent or pointless options so the budget goes further. */
  private prune(s: GameState, actions: Action[]): Action[] {
    if (actions.length <= 1) return actions;
    const P = this.opts.prune ?? {};
    if (s.stage === 'offCombo' && s.battle) {
      const { atk, def } = battleTotals(s);
      if (atk >= def) return [{ k: 'comboDone' }];
      // Combo cards on offence only when it matters: lethal range, or a target worth a card.
      if (P.offCombo) {
        const b = s.battle, opp = s.p[other(s.toAct)];
        const worth = isLeader(s, b.target) ? opp.life.length <= 2 || hasKeyword(s, b.attacker, 'doubleStrike') || hasKeyword(s, b.attacker, 'tripleStrike') : cardOf(s, b.target).cost >= 4;
        if (!worth) return [{ k: 'comboDone' }, ...actions.filter((a) => a.k === 'battleSkill' && !s.p[s.toAct].hand.includes(a.uid))];
      }
    }
    if (s.stage === 'defCombo' && s.battle) {
      const { atk, def } = battleTotals(s);
      if (def > atk) return [{ k: 'comboDone' }];
      // A hit that leaves you at 5+ life just moves a life card to hand: don't spend cards on it.
      if (P.earlyDefense && isLeader(s, s.battle.target)) {
        const b = s.battle, me = s.p[s.toAct];
        const dmg = hasKeyword(s, b.attacker, 'tripleStrike') ? 3 : hasKeyword(s, b.attacker, 'doubleStrike') ? 2 : 1;
        if (me.life.length - dmg >= (typeof P.earlyDefense === 'number' ? P.earlyDefense : 5) && !hasKeyword(s, b.attacker, 'critical')) return [{ k: 'comboDone' }, ...actions.filter((a) => a.k === 'battleSkill' && !me.hand.includes(a.uid))];
      }
    }
    if (P.weakExtras && s.stage === 'main') {
      const kept = actions.filter((a) => !wastesMainEffect(s, a));
      if (kept.length) actions = kept;
    }
    if (s.stage === 'charge') {
      const charges = actions.filter((a) => a.k === 'charge') as { k: 'charge'; uid: number }[];
      // chargeSpares: spare copies and cards far above your energy are the ones to charge
      // ("I'll see another one, it's a 4-of").
      const me = s.p[s.toAct], ids = me.hand.map((u) => s.inst[u].id);
      const rank = (u: number) => {
        if (!P.chargeSpares) return keepValue(s, u);
        const c = cardOf(s, u);
        return keepValue(s, u) - (ids.filter((x) => x === c.id).length > 1 ? 0.4 : 0) - (c.cost > me.energy.length + 3 ? 0.6 : 0);
      };
      charges.sort((a, b) => rank(a.uid) - rank(b.uid));
      return [{ k: 'noCharge' }, ...charges.slice(0, 3)];
    }
    return actions;
  }
}

/**
 * Keep a hand that can start the deck's plan: plays for the first turns (1-2 cost Battle
 * Cards), ideally a searcher or cantrip, something to do at 3-4 cost, and not clogged
 * with expensive non-combo cards. Super Combos are fine to hold (defence).
 */
export function planMulligan(s: GameState): boolean {
  const me = s.p[s.toAct];
  const cards: Card[] = me.hand.map((u) => cardOf(s, u));
  const sc = (c: Card) => compileCard(c).keywords.has('superCombo');
  const cheap = cards.filter((c) => c.type === 'BATTLE' && c.cost <= 2 && !sc(c));
  const starter = cheap.some((c) => compileCard(c).abilities.some((ab) => ab.timing === 'onPlay' && ab.effects.some((e) => e.t === 'search' || e.t === 'draw' || e.t === 'dropToHand' || e.t === 'lifeToHand')));
  const mid = cards.filter((c) => c.cost >= 3 && c.cost <= 4 && !sc(c)).length;
  const heavy = cards.filter((c) => c.cost >= 5 && !sc(c)).length;
  const score = Math.min(cheap.length, 3) + (starter ? 1 : 0) + (mid ? 0.5 : 0) - Math.max(0, heavy - 1) * 0.8;
  return score >= 2.5;
}
