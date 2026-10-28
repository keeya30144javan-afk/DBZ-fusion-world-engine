import { Card, Decklist } from '../data/types';
import { RulesConfig } from '../data/rules';
import { GameState, Side, cardOf, isLeader, nameOf, powerOf } from '../engine/core';
import { Chooser } from '../engine/effects';
import { Action, legalActions, newGame, step } from '../engine/game';
import { FastPolicy, Policy, defaultChooser } from '../ai/heuristics';
import { SEARCH_LEVELS, SearchPolicy } from '../ai/search';
import { Level } from './evaluate';

/**
 * Recorded games for the game viewer: a snapshot of both boards after every
 * move, the log lines that move produced, and what the searching AI weighed.
 */

export interface CardSnap {
  id: string;
  name: string;
  power: number;
  rested: boolean;
  ki?: number;
  /** Cards stacked under it (Evolve, Potara…). */
  under?: number;
}

export interface SideSnap {
  leader: CardSnap;
  awakened: boolean;
  battle: CardSnap[];
  hand: string[];
  energy: { active: number; rested: number };
  /** Energy markers (the player going second starts with one). */
  markers: number;
  life: number;
  deck: number;
  drop: string[];
  combo: string[];
  field?: string;
}

export interface Snap {
  turn: number;
  active: Side;
  stage: string;
  p: [SideSnap, SideSnap];
  /** Current battle: attacker and target card ids with their sides. */
  battle?: { atk: Side; attacker: string; target: string; atkPower: number; defPower: number };
}

export interface Option {
  label: string;
  /** Estimated chance to win after this move (0..1). */
  value: number;
  visits: number;
  chosen: boolean;
  /** A whole planned turn rather than a single move. */
  line?: boolean;
}

export interface Frame {
  /** Turn the move was made on. */
  turn: number;
  /** Who acted (-1 for the start position). */
  actor: Side | -1;
  /** The move in plain words. */
  move: string;
  /** Engine log lines this move produced. */
  lines: string[];
  snap: Snap;
  /** The searching AI's candidates for this move, best first. */
  options?: Option[];
}

export interface Replay {
  names: [string, string];
  levels: [Level, Level];
  seed: number;
  first: Side;
  winner: Side | -1;
  reason: string;
  turns: number;
  /** Card ids each side played, used, or comboed. */
  played: [string[], string[]];
  frames: Frame[];
}

const cardSnap = (s: GameState, u: number): CardSnap => {
  const i = s.inst[u];
  return { id: i.id, name: nameOf(s, u), power: powerOf(s, u), rested: i.rested, ...(i.ki ? { ki: i.ki } : {}), ...(i.under?.length ? { under: i.under.length } : {}) };
};

export function snapshot(s: GameState): Snap {
  const side = (p: Side): SideSnap => {
    const pl = s.p[p];
    const rested = pl.energy.filter((u) => s.inst[u].rested).length;
    return {
      leader: cardSnap(s, pl.leader),
      awakened: pl.awakened,
      battle: pl.battle.map((u) => cardSnap(s, u)),
      hand: pl.hand.map((u) => s.inst[u].id),
      energy: { active: pl.energy.length - rested, rested },
      markers: pl.markers,
      life: pl.life.length,
      deck: pl.deck.length,
      drop: pl.drop.map((u) => s.inst[u].id),
      combo: pl.combo.map((u) => s.inst[u].id),
      ...(pl.field !== undefined && pl.field !== null && s.inst[pl.field as number] ? { field: s.inst[pl.field as number].id } : {}),
    };
  };
  const b = s.battle;
  return {
    turn: s.turn,
    active: s.active,
    stage: s.stage,
    p: [side(0), side(1)],
    ...(b ? { battle: { atk: b.atkSide, attacker: s.inst[b.attacker].id, target: s.inst[b.target].id, atkPower: powerOf(s, b.attacker), defPower: powerOf(s, b.target) } } : {}),
  };
}

/** A move in plain words, from the acting player's point of view. */
export function describeAction(s: GameState, a: Action): string {
  const n = (u: number) => nameOf(s, u);
  switch (a.k) {
    case 'keep': return 'keeps the opening hand';
    case 'mulligan': return 'redraws the opening hand';
    case 'charge': return `charges ${n(a.uid)} as energy`;
    case 'noCharge': return 'charges nothing';
    case 'play': return `plays ${n(a.uid)} (cost ${cardOf(s, a.uid).cost})`;
    case 'evolve': return `evolves into ${n(a.uid)}`;
    case 'activate': return `uses ${n(a.uid)}'s skill`;
    case 'awaken': return 'awakens the Leader';
    case 'attack': return `attacks ${isLeader(s, a.target) ? 'the Leader' : n(a.target)} with ${n(a.uid)}`;
    case 'end': return 'ends the turn';
    case 'counter': return `counters with ${n(a.uid)}`;
    case 'noCounter': return 'does not counter';
    case 'block': return `blocks with ${n(a.uid)}`;
    case 'noBlock': return 'does not block';
    case 'combo': return `combos ${n(a.uid)}`;
    case 'battleSkill': return `uses ${n(a.uid)}'s battle skill`;
    case 'comboDone': return 'stops adding combo cards';
    default: return (a as Action).k;
  }
}

const policyFor = (level: Level): Policy => (level === 'fast' ? new FastPolicy(0.1) : new SearchPolicy(SEARCH_LEVELS[level]));

/** Quiet moves that only make the viewer longer when nothing happened. */
const QUIET = new Set(['noCounter', 'noBlock', 'comboDone', 'noCharge']);

export interface RecordOpts {
  decks: [Decklist, Decklist];
  levels: [Level, Level];
  seed: number;
  first?: Side;
  rules?: RulesConfig;
}

/** Play one game and record it. */
export function recordGame(cards: Record<string, Card>, o: RecordOpts): Replay {
  const first = o.first ?? ((o.seed & 1) as Side);
  const s = newGame(cards, o.decks, { seed: o.seed, first, events: true, log: true, rules: o.rules });
  const pols: [Policy, Policy] = [policyFor(o.levels[0]), policyFor(o.levels[1])];
  const ctl: [Chooser, Chooser] = [defaultChooser, defaultChooser];
  const frames: Frame[] = [{ turn: 0, actor: -1, move: 'opening hands are dealt', lines: s.log!.splice(0), snap: snapshot(s) }];
  let steps = 0;
  while (s.stage !== 'over' && steps++ < 4000) {
    const acts = legalActions(s);
    if (!acts.length) break;
    const actor = s.toAct;
    const turn = s.turn;
    const pol = pols[actor];
    if (pol instanceof SearchPolicy) { pol.lastStats = []; pol.lastLines = []; }
    const a = pol.act(s, acts);
    const move = describeAction(s, a);
    let options: Option[] | undefined;
    if (pol instanceof SearchPolicy && pol.lastStats.length > 1) {
      const key = JSON.stringify(a);
      options = pol.lastStats
        .map((x) => ({ label: describeAction(s, x.action), value: x.value, visits: x.visits, chosen: JSON.stringify(x.action) === key }))
        .sort((x, y) => y.value - x.value)
        .slice(0, 5);
    }
    if (pol instanceof SearchPolicy && pol.lastLines.length) {
      // Whole planned turns: each line in words, the chosen one first.
      options = pol.lastLines.slice(0, 5).map((l, k) => ({
        label: l.actions.filter((x) => x.k !== 'end').map((x) => describeAction(s, x)).join(' → ') || 'end the turn',
        value: l.value, visits: 0, chosen: k === 0, line: true,
      }));
    }
    const before = s.log!.length;
    step(s, a, ctl);
    const lines = s.log!.slice(before);
    if (QUIET.has(a.k) && !lines.length && !options) continue;
    frames.push({ turn, actor, move, lines, snap: snapshot(s), ...(options ? { options } : {}) });
  }
  return {
    names: [o.decks[0].name, o.decks[1].name],
    levels: o.levels,
    seed: o.seed,
    first,
    winner: s.winner,
    reason: s.reason,
    turns: s.turn,
    played: [0, 1].map((p) => [...new Set((s.events ?? []).filter((e) => (e.t === 'play' || e.t === 'activate' || e.t === 'combo' || e.t === 'counter') && e.p === p).map((e) => (e as { id: string }).id))]) as [string[], string[]],
    frames,
  };
}

/**
 * Play games from `seed` on until one ends the way `want` asks (deck A's win or
 * loss) and, with `mustPlay`, deck A played that card; up to `tries` games.
 * Returns the last game if none matched.
 */
export function findReplay(cards: Record<string, Card>, o: RecordOpts & { want: 'any' | 'win' | 'loss'; tries?: number; mustPlay?: string }): Replay {
  const tries = o.want === 'any' && !o.mustPlay ? 1 : o.tries ?? 6;
  let r: Replay | null = null;
  for (let i = 0; i < tries; i++) {
    r = recordGame(cards, { ...o, seed: o.seed + i, first: undefined });
    const outcome = o.want === 'any' || (o.want === 'win' ? r.winner === 0 : r.winner === 1);
    if (outcome && (!o.mustPlay || r.played[0].includes(o.mustPlay))) return r;
  }
  return r!;
}
