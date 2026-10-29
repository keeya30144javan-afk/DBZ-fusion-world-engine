import { GameState, Side, cloneState } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, legalActions, step } from '../engine/game';
import { determinize } from './belief';
import { EvalWeights, FastPolicy, ForcedChooser, Habits, RecordingChooser, defaultChooser, evaluate, winProb } from './heuristics';

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
  /** How many turns past this one to play out before judging (overrides `deep`: 1 = their reply, 2 = through our next turn...). */
  ahead?: number;
  /** Evaluation weights (defaults otherwise). */
  eval?: EvalWeights;
  /** Habits of the fast AI that plays out imagined games (both sides). */
  habits?: Partial<Habits>;
  /** Keep attacks that change nothing but resting the attacker (off by default: they only expose it). */
  keepFutile?: boolean;
  /**
   * Also search our own choices inside skills: for an action whose skill asks us to choose
   * (a KO target, a card to take from a search...), try this many of the best-ranked options
   * as separate lines, not just the default pick.
   */
  choices?: number;
}

export const PLAN_DEFAULT: PlanOpts = { beam: 6, depth: 14, finalists: 6, worlds: 4 };

export interface PlannedLine {
  actions: Action[];
  /** Our pick for the first choice each action's skill asks for (undefined: the default). */
  picks?: (number[] | undefined)[];
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
function reply(w: GameState, me: Side, pol: FastPolicy, startTurn: number, deep = false, ahead?: number) {
  let n = 0;
  const last = startTurn + (ahead ?? (deep ? 2 : 1));
  while (w.stage !== 'over' && n++ < 4000) {
    if (ahead === undefined && !deep && w.turn > startTurn && w.active === me && w.stage === 'main') return;
    if (w.turn > last) return;
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

interface Node { w: GameState; line: Action[]; picks: (number[] | undefined)[]; h: number }

const lineKey = (n: { line: Action[]; picks: (number[] | undefined)[] }) => n.line.map((a, i) => key(a) + (n.picks[i] ? `#${n.picks[i]!.join('.')}` : '')).join('|');

export function planTurn(s: GameState, me: Side, opts: PlanOpts = PLAN_DEFAULT): PlannedLine[] {
  const turn = s.turn;
  const pol = new FastPolicy(0.05);
  if (opts.habits) Object.assign(pol.habits, opts.habits);
  const root = determinize(s, me);
  advance(root, me, pol, turn);
  let frontier: Node[] = [{ w: root, line: [], picks: [], h: evaluate(root, me, opts.eval) }];
  const done: Node[] = [];
  const doneKeys = new Set<string>();
  const finish = (n: Node) => {
    const k = lineKey(n);
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
        // The default way to play this action, recording the first choice its skill asks of us.
        const rec = new RecordingChooser(me);
        const variants: { w: GameState; pick?: number[] }[] = [];
        {
          const w = cloneState(w0);
          step(w, a, me === 0 ? [rec, defaultChooser] : [defaultChooser, rec]);
          advance(w, me, pol, turn);
          variants.push({ w });
        }
        // Other ways: the next-best options for that choice, each as its own line.
        const f = rec.first;
        if (opts.choices && f && f.req.kind !== 'yesno' && f.req.options.length > 1) {
          const size = Math.max(1, f.pick.length);
          const tried = new Set([f.pick.slice().sort().join('.')]);
          for (const u of f.ranked) {
            if (variants.length > opts.choices) break;
            const alt = size === 1 ? [u] : [u, ...f.pick.filter((x) => x !== u)].slice(0, size);
            const k = alt.slice().sort().join('.');
            if (tried.has(k)) continue;
            tried.add(k);
            const w = cloneState(w0);
            const forced = new ForcedChooser(me, [alt]);
            step(w, a, me === 0 ? [forced, defaultChooser] : [defaultChooser, forced]);
            advance(w, me, pol, turn);
            variants.push({ w, pick: alt });
          }
        }
        for (const { w, pick } of variants) {
          // An attack that changed nothing but resting the attacker (no damage, no KO, no card
          // drawn or spent by either side, no Ki) only exposes it: the 10k Pan: GT swinging into
          // a 20k Leader. Its line ties with not attacking, and noise picked it half the time.
          if (a.k === 'attack' && !opts.keepFutile && futile(w0, w, a.uid)) continue;
          const line = [...node.line, a];
          const picks = [...node.picks, pick];
          const h = w.stage === 'over' ? (w.winner === me ? 1000 : -1000) : evaluate(w, me, opts.eval);
          const child = { w, line, picks, h };
          if (a.k === 'end' || w.stage === 'over' || w.turn !== turn) { finish(child); continue; }
          // Different orders that reach the same position are one node.
          const sig = positionKey(w, me);
          if (seenStates.has(sig)) continue;
          seenStates.add(sig);
          next.push(child);
        }
      }
    }
    next.sort((x, y) => y.h - x.h);
    frontier = next.slice(0, opts.beam);
  }
  // Lines still open at the depth limit end the turn there.
  for (const n of frontier) finish({ ...n, line: [...n.line, { k: 'end' }], picks: [...n.picks, undefined] });

  // Re-score the most promising complete lines through the opponent's reply.
  done.sort((x, y) => y.h - x.h);
  const finalists = done.slice(0, opts.finalists);
  const scored: PlannedLine[] = finalists.map((n) => {
    let total = 0;
    for (let i = 0; i < opts.worlds; i++) {
      const w = determinize(s, me);
      advance(w, me, pol, turn);
      for (let k = 0; k < n.line.length; k++) {
        const a = n.line[k];
        if (w.stage === 'over' || w.turn !== turn || w.toAct !== me || w.stage !== 'main') break;
        const legal = legalActions(w).find((x) => key(x) === key(a));
        const pick = n.picks[k];
        const ch: [Chooser, Chooser] = pick ? (me === 0 ? [new ForcedChooser(me, [pick]), defaultChooser] : [defaultChooser, new ForcedChooser(me, [pick])]) : ctl;
        step(w, legal ?? { k: 'end' }, ch);
        if (!legal) break;
        advance(w, me, pol, turn);
      }
      reply(w, me, pol, turn, opts.deep, opts.ahead);
      total += winProb(w, me, opts.eval);
    }
    return { actions: n.line, picks: n.picks, value: total / opts.worlds };
  });
  scored.sort((x, y) => y.value - x.value);
  return scored;
}

/** Everything an attack could change, except the attacker going to Rest Mode. */
function attackSig(w: GameState, attacker: number): string {
  const side = (p: GameState['p'][0]) => [p.life.length, p.hand.length, p.deck.length, p.drop.length, p.energy.length,
    p.energy.filter((u) => w.inst[u].rested).length, p.markers, p.awakened, p.battle.map((u) => `${u}${u !== attacker && w.inst[u].rested ? 'r' : ''}`).join(','),
    [p.leader, ...p.battle].reduce((n, u) => n + w.inst[u].ki, 0), p.leader === attacker ? '' : w.inst[p.leader].rested].join('/');
  return `${side(w.p[0])}|${side(w.p[1])}`;
}
const futile = (before: GameState, after: GameState, attacker: number) =>
  after.stage !== 'over' && after.inst[attacker].rested && attackSig(before, attacker) === attackSig(after, attacker);

/** Enough of a position to tell transpositions apart within one turn. */
function positionKey(w: GameState, me: Side): string {
  const p = w.p[me], o = w.p[1 - me];
  const ids = (a: number[]) => a.map((u) => `${w.inst[u].id}${w.inst[u].rested ? 'r' : ''}`).sort().join(',');
  return [ids(p.hand), ids(p.battle), ids(p.energy), p.drop.length, p.life.length, ids(o.battle), o.life.length, o.hand.length, p.awakened, w.inst[p.leader].rested, p.usedOnce.length].join(';');
}
