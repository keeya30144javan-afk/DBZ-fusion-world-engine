import { Card, Decklist } from '../data/types';
import { legalActions, newGame, step } from '../engine/game';
import { DEFAULT_EVAL, defaultChooser, evaluate } from './heuristics';
import { SEARCH_LEVELS, SearchPolicy } from './search';
import { NET_INPUTS_V2, netInputV2 } from './valuenet';

/**
 * Self-play for training the learned evaluation: the searching AI plays both sides, and each turn's
 * start position (from both points of view) becomes a row labelled with who went on to win.
 * Row: [...NET_INPUTS_V2, handLogit, won, gameSeed, turnsLeft] (same as the offline generator).
 */
export interface SelfplayBatch { rows: number[][]; games: number; inputs: number }

export function selfplay(cards: Record<string, Card>, decks: Decklist[], seed: number, games: number): SelfplayBatch {
  let r = seed * 7919 + 13;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows: number[][] = [];
  let played = 0;
  for (let g = 0; g < games; g++) {
    const gameSeed = seed * 1000 + g;
    const a = decks[Math.floor(rnd() * decks.length)], b = decks[Math.floor(rnd() * decks.length)];
    const s = newGame(cards, [a, b], { seed: gameSeed, first: (g & 1) as 0 | 1 });
    const pol = [new SearchPolicy(SEARCH_LEVELS.quick), new SearchPolicy(SEARCH_LEVELS.quick)];
    const pos: { x: number[]; h: number; me: 0 | 1; turn: number }[] = [];
    let n = 0, lastTurn = -1;
    while (s.stage !== 'over' && n++ < 4000) {
      if (s.stage === 'main' && s.turn !== lastTurn) {
        lastTurn = s.turn;
        for (const me of [0, 1] as const) pos.push({ x: netInputV2(s, me), h: evaluate(s, me, DEFAULT_EVAL) / 3, me, turn: s.turn });
      }
      const acts = legalActions(s);
      if (!acts.length) break;
      step(s, pol[s.toAct].act(s, acts), [defaultChooser, defaultChooser]);
    }
    if (s.stage !== 'over' || s.winner === -1) continue;
    played++;
    const q = (v: number) => Math.round(v * 100) / 100;
    for (const p of pos) rows.push([...p.x.map(q), q(p.h), s.winner === p.me ? 1 : 0, gameSeed, s.turn - p.turn]);
  }
  return { rows, games: played, inputs: NET_INPUTS_V2.length };
}
