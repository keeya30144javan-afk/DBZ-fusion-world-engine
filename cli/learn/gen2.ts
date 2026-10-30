// Self-play positions for value net v2. usage: gen2.ts GAMES SHARD OUTFILE  [env NET=path to blend into both players' eval]
// rows = [...NET_INPUTS_V2, handLogit, won(0/1), gameSeed, turnsLeft]  (handLogit: the hand-set evaluation, in logits)
import { readFileSync, writeFileSync } from 'node:fs';
import { newGame, legalActions, step } from '../../src/engine/game';
import { defaultChooser, DEFAULT_EVAL, evaluate } from '../../src/ai/heuristics';
import { SearchPolicy, SEARCH_LEVELS } from '../../src/ai/search';
import { netInputV2 } from '../../src/ai/valuenet';
const cards = JSON.parse(readFileSync('data/cards.json', 'utf8')).cards;
const decks = JSON.parse(readFileSync('data/meta.json', 'utf8')).decks.filter((d: any) => !d.name.startsWith('Starter'));
const [games, shard, out] = [+process.argv[2], +process.argv[3], process.argv[4]];
const opts: any = { ...SEARCH_LEVELS.quick };
if (process.env.NET) opts.eval = { ...DEFAULT_EVAL, net: JSON.parse(readFileSync(process.env.NET, 'utf8')), netBlend: +(process.env.BLEND ?? 0.5) };
let r = 7919 * (shard + 11); const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const rows: number[][] = [];
const flush = () => writeFileSync(out, JSON.stringify(rows));
for (let g = 0; g < games; g++) {
  const seed = 2000000 + shard * 100000 + g;
  const i = Math.floor(rnd() * decks.length), j = Math.floor(rnd() * decks.length);
  const s = newGame(cards, [decks[i], decks[j]], { seed, first: (g & 1) as any });
  const pol = [new SearchPolicy(opts), new SearchPolicy(opts)];
  const pos: { x: number[]; h: number; me: number; turn: number }[] = [];
  let n = 0, lastTurn = -1;
  while (s.stage !== 'over' && n++ < 4000) {
    if (s.stage === 'main' && (s.turn !== lastTurn || rnd() < 0.12)) {
      lastTurn = s.turn;
      for (const me of [0, 1]) pos.push({ x: netInputV2(s, me as any), h: evaluate(s, me as any, DEFAULT_EVAL) / 3, me, turn: s.turn });
    }
    const a = legalActions(s); if (!a.length) break;
    step(s, pol[s.toAct].act(s, a), [defaultChooser, defaultChooser]);
  }
  if (s.winner === -1 || s.stage !== 'over') continue;
  for (const p of pos) rows.push([...p.x.map((v) => Math.round(v * 1000) / 1000), Math.round(p.h * 1000) / 1000, s.winner === p.me ? 1 : 0, seed, s.turn - p.turn]);
  if (g % 5 === 4) flush();
}
flush(); console.log('done', rows.length);
