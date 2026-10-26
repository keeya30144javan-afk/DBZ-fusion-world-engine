import { Card, Decklist } from '../data/types';
import { RulesConfig } from '../data/rules';
import { Side } from '../engine/core';
import { newGame } from '../engine/game';
import { FastPolicy, Policy, playout } from '../ai/heuristics';
import { SEARCH_LEVELS, SearchPolicy } from '../ai/search';

export type Level = 'fast' | 'quick' | 'strong' | 'deep';

/** A batch of games between two decks. Serializable so it can go to a worker. */
export interface MatchJob {
  a: Decklist;
  b: Decklist;
  seeds: number[];
  level: Level;
  /** Level used for deck B (defaults to `level`). */
  levelB?: Level;
  track?: boolean;
  rules?: RulesConfig;
}

export interface CardTally {
  played: number;
  wonWhenPlayed: number;
}

export interface MatchResult {
  wins: number;
  losses: number;
  draws: number;
  games: number;
  turns: number;
  firstWins: number;
  firstGames: number;
  reasons: Record<string, number>;
  /** Per card id of deck A: games where it was played/used and how many were won. */
  cards?: Record<string, CardTally>;
}

export const emptyResult = (): MatchResult => ({ wins: 0, losses: 0, draws: 0, games: 0, turns: 0, firstWins: 0, firstGames: 0, reasons: {}, cards: {} });

export function mergeResults(into: MatchResult, r: MatchResult): MatchResult {
  into.wins += r.wins; into.losses += r.losses; into.draws += r.draws; into.games += r.games; into.turns += r.turns;
  into.firstWins += r.firstWins; into.firstGames += r.firstGames;
  for (const [k, v] of Object.entries(r.reasons)) into.reasons[k] = (into.reasons[k] ?? 0) + v;
  if (r.cards) {
    into.cards ??= {};
    for (const [id, t] of Object.entries(r.cards)) {
      const c = (into.cards[id] ??= { played: 0, wonWhenPlayed: 0 });
      c.played += t.played; c.wonWhenPlayed += t.wonWhenPlayed;
    }
  }
  return into;
}

/** Draws count half. */
export const score = (r: MatchResult) => r.wins + r.draws * 0.5;

function policyFor(level: Level): Policy {
  return level === 'fast' ? new FastPolicy(0.1) : new SearchPolicy(SEARCH_LEVELS[level]);
}

export function runMatch(cards: Record<string, Card>, job: MatchJob): MatchResult {
  const res = emptyResult();
  const pa = policyFor(job.level);
  const pb = policyFor(job.levelB ?? job.level);
  const needEvents = job.track || job.level !== 'fast' || (job.levelB ?? job.level) !== 'fast';
  for (const seed of job.seeds) {
    const first = (seed & 1) as Side; // alternate who goes first
    const s = newGame(cards, [job.a, job.b], { seed, first, events: needEvents, rules: job.rules });
    playout(s, [pa, pb]);
    res.games++;
    res.turns += s.turn;
    if (first === 0) res.firstGames++;
    if (s.winner === 0) { res.wins++; if (first === 0) res.firstWins++; }
    else if (s.winner === 1) res.losses++;
    else res.draws++;
    const why = s.winner === -1 ? 'draw' : `${s.winner === 0 ? 'win' : 'loss'}: ${s.reason}`;
    res.reasons[why] = (res.reasons[why] ?? 0) + 1;
    if (job.track && s.events) {
      const seen = new Set<string>();
      for (const e of s.events) if ((e.t === 'play' || e.t === 'activate' || e.t === 'combo' || e.t === 'counter') && e.p === 0) seen.add(e.id);
      for (const id of seen) {
        const t = (res.cards![id] ??= { played: 0, wonWhenPlayed: 0 });
        t.played++;
        if (s.winner === 0) t.wonWhenPlayed++;
      }
    }
  }
  return res;
}
