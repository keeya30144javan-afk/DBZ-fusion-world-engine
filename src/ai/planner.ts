import { GameState, Side, cloneState } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, legalActions, step } from '../engine/game';
import { determinize } from './belief';
import { FastPolicy, defaultChooser, evaluate, winProb } from './heuristics';

/**
 * Turn planning: search whole lines of play for the current turn ("play Bulma,
 * search Trunks, play Trunks, evolve, attack with…"), not single actions.
 *
 * 1. Beam search over main-phase actions in an imagined world. Everything that
 *    isn't our main-phase choice (the opponent's blocks and combos, our own
 *    combo decisions) is answered by the fast policy. Partial lines are ranked
 *    by the static evaluation.
 * 2. The best complete lines are replayed in several fresh imagined worlds and
 *    played on through the opponent's reply turn, and scored by how likely we
 *    are to win from there. The line that holds up best is the plan.
 */

export interface PlanOpts {
  /** Lines kept at each step of the beam. */
  beam: number;
  /** Most actions in one line before the turn is ended. */
  depth: number;
  /** Complete lines re-scored through the opponent's reply. */
  finalists: number;
  /** Imagined worlds each finalist is re-scored in. */
  worlds: number;
  /** Also play on through our own next turn before judging (sees set-ups that pay off later). */
  deep?: boolean;
}

export const PLAN_DEFAULT: PlanOpts = { beam: 6, depth: 14, finalists: 6, worlds: 4 };

export interface PlannedLine {
  actions: Action[];
  /** Estimated chance to win after the line and the opponent's reply. */
  value: number;
}

const ctl: [Chooser, Chooser] = [defaultChooser, defaultChooser];
const key = (a: Action) => JSON.stringify(a);

/** Let everything that isn't `me` choosing in my main phase play out with the fast policy. */
function advance(w: GameState, me: Side, pol: FastPolicy, turn: number) {
  let n = 0;
  while (w.stage !== 'over' && n++ < 400) {
    if (w.turn !== turn) return; // our turn ended
    if (w.toAct === me && w.stage === 'main' && w.active === me) return;
    const acts = legalActions(w);
    if (!acts.length) return;
    step(w, pol.act(w, acts), ctl);
  }
}

/** Play on until our next main phase begins (or the game ends): the opponent's reply. */
function reply(w: GameState, me: Side, pol: FastPolicy, startTurn: number, deep = false) {
  let n = 0;
  while (w.stage !== 'over' && n++ < 2500) {
    if (!deep && w.turn > startTurn && w.active === me && w.stage === 'main') return;
    if (deep && w.turn > startTurn + 2) return;
    if (w.turn > startTurn + 2) return;
    const acts = legalActions(w);
    if (!acts.length) return;
    step(w, pol.act(w, acts), ctl);
  }
}

/** Mains actions worth branching on: drop duplicates and obviously pointless ones. */
function candidates(w: GameState): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (const a of legalActions(w)) {
    const k = key(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

interface Node { w: GameState; line: Action[]; h: number }

export function planTurn(s: GameState, me: Side, opts: PlanOpts = PLAN_DEFAULT): PlannedLine[] {
  const turn = s.turn;
  const pol = new FastPolicy(0.05);
  const root = determinize(s, me);
  advance(root, me, pol, turn);
  let frontier: Node[] = [{ w: root, line: [], h: evaluate(root, me) }];
  const done: Node[] = [];
  const doneKeys = new Set<string>();
  const finish = (n: Node) => {
    const k = n.line.map(key).join('|');
    if (doneKeys.has(k)) return;
    doneKeys.add(k);
    done.push(n);
  };

  for (let d = 0; d < opts.depth && frontier.length; d++) {
    const next: Node[] = [];
    const seenStates = new Set<string>();
    for (const node of frontier) {
      const w0 = node.w;
      if (w0.stage === 'over' || w0.turn !== turn || w0.active !== me || w0.stage !== 'main' || w0.toAct !== me) { finish(node); continue; }
      for (const a of candidates(w0)) {
        const w = cloneState(w0);
        step(w, a, ctl);
        advance(w, me, pol, turn);
        const line = [...node.line, a];
        const h = w.stage === 'over' ? (w.winner === me ? 1000 : -1000) : evaluate(w, me);
        const child = { w, line, h };
        if (a.k === 'end' || w.stage === 'over' || w.turn !== turn) { finish(child); continue; }
        // Different orders that reach the same position are one node.
        const sig = positionKey(w, me);
        if (seenStates.has(sig)) continue;
        seenStates.add(sig);
        next.push(child);
      }
    }
    next.sort((x, y) => y.h - x.h);
    frontier = next.slice(0, opts.beam);
  }
  // Lines still open at the depth limit end the turn there.
  for (const n of frontier) finish({ ...n, line: [...n.line, { k: 'end' }] });

  // Re-score the most promising complete lines through the opponent's reply.
  done.sort((x, y) => y.h - x.h);
  const finalists = done.slice(0, opts.finalists);
  const scored: PlannedLine[] = finalists.map((n) => {
    let total = 0;
    for (let i = 0; i < opts.worlds; i++) {
      const w = determinize(s, me);
      advance(w, me, pol, turn);
      for (const a of n.line) {
        if (w.stage === 'over' || w.turn !== turn || w.toAct !== me || w.stage !== 'main') break;
        const legal = legalActions(w).find((x) => key(x) === key(a));
        step(w, legal ?? { k: 'end' }, ctl);
        if (!legal) break;
        advance(w, me, pol, turn);
      }
      reply(w, me, pol, turn, opts.deep);
      total += winProb(w, me);
    }
    return { actions: n.line, value: total / opts.worlds };
  });
  scored.sort((x, y) => y.value - x.value);
  return scored;
}

/** Enough of a position to tell transpositions apart within one turn. */
function positionKey(w: GameState, me: Side): string {
  const p = w.p[me], o = w.p[1 - me];
  const ids = (a: number[]) => a.map((u) => `${w.inst[u].id}${w.inst[u].rested ? 'r' : ''}`).sort().join(',');
  return [ids(p.hand), ids(p.battle), ids(p.energy), p.drop.length, p.life.length, ids(o.battle), o.life.length, o.hand.length, p.awakened, w.inst[p.leader].rested, p.usedOnce.length].join(';');
}
