import { GameState, Side } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, battleTotals, legalActions, step } from '../engine/game';
import { determinize } from './belief';
import { FastPolicy, Policy, defaultChooser, keepValue, winProb } from './heuristics';

export interface SearchOpts {
  /** Simulations per decision. */
  iterations: number;
  /** How many turns past the current one each simulation looks before judging the position. */
  horizon: number;
  /** UCB exploration constant. */
  c: number;
}

export const SEARCH_LEVELS: Record<string, SearchOpts> = {
  quick: { iterations: 48, horizon: 2, c: 0.7 },
  strong: { iterations: 160, horizon: 3, c: 0.7 },
  deep: { iterations: 500, horizon: 4, c: 0.6 },
};

const ctl: [Chooser, Chooser] = [defaultChooser, defaultChooser];

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

  constructor(public opts: SearchOpts = SEARCH_LEVELS.quick) {}

  act(s: GameState, actions: Action[]): Action {
    const me = s.toAct as Side;
    const cands = this.prune(s, actions);
    if (cands.length === 1) return cands[0];
    const n = cands.length;
    const visits = new Array(n).fill(0);
    const total = new Array(n).fill(0);
    const iters = Math.max(this.opts.iterations, n * 4);
    for (let it = 0; it < iters; it++) {
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
