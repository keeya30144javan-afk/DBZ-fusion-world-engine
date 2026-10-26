import { readFileSync } from 'node:fs';
import { newGame } from '../src/engine/game';
import { FastPolicy, playout } from '../src/ai/heuristics';
import { SearchPolicy, SEARCH_LEVELS } from '../src/ai/search';
const db = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const decks = JSON.parse(readFileSync('data/meta.json', 'utf8')).decks;
const level = process.argv[2] ?? 'quick';
const N = +(process.argv[3] ?? 24);
const fast = new FastPolicy(0.1);
const search = new SearchPolicy(SEARCH_LEVELS[level]);
let w = 0; const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const a = i % 4, b = (i >> 2) % 4;
  const searchSide = i % 2;
  const pols: any = searchSide === 0 ? [search, fast] : [fast, search];
  const s = newGame(db.cards, [decks[a], decks[b]], { seed: 1000 + i, events: true });
  playout(s, pols);
  if (s.winner === searchSide) w++;
}
console.log(`${level}: search won ${w}/${N} (${(100*w/N).toFixed(0)}%) in ${((Date.now()-t0)/N/1000).toFixed(2)}s/game`);
