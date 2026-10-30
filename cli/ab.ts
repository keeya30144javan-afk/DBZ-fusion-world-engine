// Strong-AI A/B: SearchPolicy(quick + VARIANT opts) vs SearchPolicy(quick), random player-list pairs.
import { readFileSync } from 'node:fs';
import { newGame } from '../src/engine/game';
import { DEFAULT_EVAL, playout } from '../src/ai/heuristics';
import { SearchPolicy, SEARCH_LEVELS } from '../src/ai/search';
import { mulberry } from '../src/builder/deckgen';
const cards = JSON.parse(readFileSync('data/cards.json', 'utf8')).cards;
const decks = JSON.parse(readFileSync('data/meta.json', 'utf8')).decks.filter((d: any) => !d.name.startsWith('Starter'));
if (process.env.EXTRA) decks.push(JSON.parse(readFileSync(process.env.EXTRA, 'utf8')));
const V = JSON.parse(process.env.VARIANT ?? '{}');
const B = JSON.parse(process.env.BASE ?? '{}');
const merge = (x: any) => ({ ...SEARCH_LEVELS.quick, ...x, plan: { ...SEARCH_LEVELS.quick.plan!, ...(x.plan ?? {}) }, ...(x.eval ? { eval: { ...DEFAULT_EVAL, ...x.eval } } : {}) });
const [n, shard] = [+(process.argv[2] ?? 25), +(process.argv[3] ?? 0)];
const rng = mulberry(4242 + shard * 1000 + (+(process.env.SALT ?? 0)));
let w = 0, d = 0;
for (let g = 0; g < n; g++) {
  let i = Math.floor(rng() * decks.length), j = Math.floor(rng() * decks.length);
  if (process.env.WITH) { if (g % 4 < 2) i = +process.env.WITH; else j = +process.env.WITH; }
  if (process.env.PAIR) { const [x, y] = process.env.PAIR.split(',').map(Number); [i, j] = g % 4 < 2 ? [x, y] : [y, x]; }
  const seat = (g & 1) as 0 | 1;
  const a = new SearchPolicy(merge(V)), b = new SearchPolicy(merge(B));
  const s = newGame(cards, [decks[i], decks[j]], { seed: 90000 + shard * 1000 + g + (+(process.env.SALT ?? 0)), first: ((g >> 1) & 1) as any, events: true });
  playout(s, (seat === 0 ? [a, b] : [b, a]) as any);
  if (s.winner === seat) w++; else if (s.winner === -1) d++;
}
console.log(JSON.stringify({ w, n, d }));
