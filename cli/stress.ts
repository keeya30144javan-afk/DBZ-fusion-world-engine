/**
 * Engine smoke test over the whole card pool: every Leader gets a random legal deck and
 * plays a few games against other Leaders. Reports crashes and games that never finish.
 *   npx tsx cli/stress.ts            K=opponents per leader (default 3), LEVEL=fast|quick
 */
import { readFileSync } from 'node:fs';
import { CardDB } from '../src/data/types';
import { seedDeck, mulberry } from '../src/builder/deckgen';
import { runMatch } from '../src/builder/evaluate';
const db: CardDB = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const cards = db.cards;
const rng = mulberry(7);
const leaders = Object.values(cards).filter((c) => c.type === 'LEADER' && !/only be used in specified events/.test(c.text)).map((c) => c.id);
const decks = leaders.map((l) => seedDeck(cards, l, rng));
let games = 0, crashes = 0, draws = 0, turns = 0;
const bad: string[] = [];
const t0 = Date.now();
for (let i = 0; i < decks.length; i++) {
  for (let k = 1; k <= Number(process.env.K ?? 3); k++) {
    const j = (i + k * 17) % decks.length;
    try {
      const r = runMatch(cards, { a: decks[i], b: decks[j], seeds: [i * 100 + k, i * 100 + k + 1], level: (process.env.LEVEL as any) ?? "fast" });
      games += r.games; draws += r.draws; turns += r.turns;
      if (r.draws) bad.push(`draw/stall ${leaders[i]} vs ${leaders[j]}: ${JSON.stringify(r.reasons)}`);
    } catch (e: any) {
      crashes++; bad.push(`CRASH ${leaders[i]} vs ${leaders[j]}: ${String(e?.stack ?? e).split('\n').slice(0, 4).join(' | ')}`);
    }
  }
}
console.log(`${games} games, ${crashes} crashes, ${draws} draws, avg ${(turns / Math.max(1, games)).toFixed(1)} turns, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const b of bad.slice(0, 25)) console.log(b);
process.exit(crashes ? 1 : 0);
