import { GameState, Side } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, battleTotals, legalActions, step } from '../engine/game';
import { determinize } from './belief';
import { FastPolicy, Policy, defaultChooser, keepValue, winProb } from './heuristics';
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

  constructor(public opts: SearchOpts = SEARCH_LEVELS.quick) {}

  act(s: GameState, actions: Action[]): Action {
    const me = s.toAct as Side;
    const cands = this.prune(s, actions);
    if (cands.length === 1) return cands[0];
    if (this.opts.plan && s.stage === 'main' && s.active === me) {
      const lines = planTurn(s, me, this.opts.plan);
      const first = lines[0]?.actions[0];
      const legal = first && cands.find((a) => JSON.stringify(a) === JSON.stringify(first));
      if (legal) {
        this.lastLines = lines;
        this.lastStats = [];
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
      total[pick] += winProb(w, me);
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
    if (s.stage === 'offCombo' && s.battle) {
      const { atk, def } = battleTotals(s);
      if (atk >= def) return [{ k: 'comboDone' }];
    }
    if (s.stage === 'defCombo' && s.battle) {
      const { atk, def } = battleTotals(s);
      if (def > atk) return [{ k: 'comboDone' }];
    }
    if (s.stage === 'charge') {
      const charges = actions.filter((a) => a.k === 'charge') as { k: 'charge'; uid: number }[];
      charges.sort((a, b) => keepValue(s, a.uid) - keepValue(s, b.uid));
      return [{ k: 'noCharge' }, ...charges.slice(0, 3)];
    }
    return actions;
  }
}
