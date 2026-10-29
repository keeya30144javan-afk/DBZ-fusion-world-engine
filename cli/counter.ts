/**
 * Find a counter to a deck from the command line.
 *   npx tsx cli/counter.ts --target "Starter: Vegeta (Blue)" [--effort quick|standard|thorough]
 *        [--threshold 0.55] [--confidence 0.95] [--level fast|quick|strong] [--deck file.txt]
 *        [--blind] (build from scratch; known lists are only the bar) [--leaders ID,ID] [--json out.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CardDB, Meta } from '../src/data/types';
import { deckToText, parseDecklist } from '../src/data/decks';
import { findCounter, localRunner } from '../src/builder/counter';
import { runMatch } from '../src/builder/evaluate';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const db: CardDB = JSON.parse(readFileSync(arg('cards', 'data/cards.json')!, 'utf8'));
const meta: Meta = JSON.parse(readFileSync(arg('meta', 'data/meta.json')!, 'utf8'));

let target = meta.decks.find((d) => d.name === arg('target'));
if (arg('deck')) {
  const { deck, errors } = parseDecklist(readFileSync(arg('deck')!, 'utf8'), db.cards, arg('deck')!);
  if (errors.length) console.warn(errors.join('\n'));
  target = deck;
}
if (!target) {
  console.error(`Pick a target with --target <name> or --deck <file>. Meta decks:\n${meta.decks.map((d) => '  ' + d.name).join('\n')}`);
  process.exit(1);
}

const report = await findCounter(
  db.cards,
  {
    targets: [{ deck: target, weight: 1 }],
    known: meta.decks,
    blind: process.argv.includes('--blind'),
    leaders: arg('leaders')?.split(','),
    threshold: +arg('threshold', '0.55')!,
    confidence: +arg('confidence', '0.95')!,
    effort: (arg('effort', 'quick') as any),
    validateLevel: (arg('level', 'quick') as any),
    seed: +arg('seed', '1')!,
  },
  localRunner(db.cards, runMatch),
  (p) => console.log(`[${p.phase}] ${p.message} (${p.gamesPlayed} games)`),
);

console.log('\n' + report.headline);
for (const r of report.reasons) console.log(' - ' + r);
if (report.best) {
  console.log(`\nBest deck (${report.best.origin}):\n${deckToText(report.best.deck, db.cards)}`);
  for (const t of report.best.perTarget) console.log(`  vs ${t.name}: ${(t.rate * 100).toFixed(1)}% [${(t.lo * 100).toFixed(1)}-${(t.hi * 100).toFixed(1)}] over ${t.games}`);
  console.log('How games ended:', report.best.result.reasons);
  console.log('Key cards:', report.keyCards.slice(0, 6).map((k) => `${k.name} (+${(k.lift * 100).toFixed(0)}%)`).join(', '));
}
if (report.nearestKnown) console.log(`Nearest known list: ${report.nearestKnown.name}, ${(report.nearestKnown.overlap * 100).toFixed(0)}% of cards in common`);
if (report.baseline) console.log(`Baseline "${report.baseline.deck.name}": ${(report.baseline.rate * 100).toFixed(1)}% [${(report.baseline.lo * 100).toFixed(1)}-${(report.baseline.hi * 100).toFixed(1)}]`);
for (const a of report.alternatives) console.log(`Alternative ${a.deck.name}: ${(a.rate * 100).toFixed(1)}% [${(a.lo * 100).toFixed(1)}-${(a.hi * 100).toFixed(1)}]`);
if (report.knownBetter) console.log(`KNOWN BETTER: ${report.knownBetter.deck.name} ${(report.knownBetter.rate * 100).toFixed(1)}%`);
console.log(`\n${report.gamesPlayed} games in ${(report.ms / 1000).toFixed(1)}s`);
if (arg('json')) {
  const v = (x: any) => x && { name: x.deck.name, leader: x.deck.leader, origin: x.origin, rate: x.rate, lo: x.lo, hi: x.hi, games: x.games, deck: deckToText(x.deck, db.cards) };
  writeFileSync(arg('json')!, JSON.stringify({ target: target.name, verdict: report.verdict, headline: report.headline, reasons: report.reasons, best: v(report.best), baseline: v(report.baseline), knownBetter: v(report.knownBetter), alternatives: report.alternatives.map(v), nearestKnown: report.nearestKnown, gamesPlayed: report.gamesPlayed, ms: report.ms }, null, 1));
}
