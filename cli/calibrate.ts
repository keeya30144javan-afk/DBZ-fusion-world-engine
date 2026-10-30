// Round-robin of the real FB10 tournament lists (one per Leader), quick search AI, field-weighted.
// usage: calib.ts SHARD NSHARDS GAMES_PER_PAIR  -> JSON lines {i,j,wi,n}
import { readFileSync } from 'node:fs';
import { newGame } from '../src/engine/game';
import { playout } from '../src/ai/heuristics';
import { SearchPolicy, SEARCH_LEVELS } from '../src/ai/search';
const cards = JSON.parse(readFileSync('data/cards.json', 'utf8')).cards;
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
const leaders = ['FS11-01', 'FB10-025', 'FB09-049', 'FB09-001', 'FB09-097', 'ST01-053', 'FB05-025', 'FB08-073'];
const decks = leaders.map((l) => meta.decks.find((d: any) => d.leader === l && /\d(st|nd|rd|th)\)$/.test(d.name)));
const [shard, nsh, per] = process.argv.slice(2).map(Number);
let k = 0;
for (let i = 0; i < decks.length; i++) for (let j = i + 1; j < decks.length; j++) {
  if (k++ % nsh !== shard) continue;
  let wi = 0;
  for (let g = 0; g < per; g++) {
    const flip = g & 1;
    const s = newGame(cards, flip ? [decks[j], decks[i]] : [decks[i], decks[j]], { seed: 5000 + i * 100 + j * 7 + g, first: ((g >> 1) & 1) as any });
    playout(s, [new SearchPolicy(SEARCH_LEVELS.quick), new SearchPolicy(SEARCH_LEVELS.quick)] as any);
    if (s.winner === (flip ? 1 : 0)) wi++;
  }
  console.log(JSON.stringify({ i, j, a: decks[i].name, b: decks[j].name, wi, n: per }));
}
