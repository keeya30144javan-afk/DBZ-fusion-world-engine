import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runMatch } from '../src/builder/evaluate';
import { cardEvidence, explainPrompt } from '../src/builder/explain';
import { diffDecks } from '../src/builder/counter';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8')).cards;
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));

test('card evidence: stats from tracked games, history of when it entered, and a noise verdict', () => {
  const deck = meta.decks[1], target = meta.decks[0];
  const result = runMatch(cards, { a: deck, b: target, seeds: Array.from({ length: 40 }, (_, i) => i + 1), level: 'fast', track: true });
  const v: any = { deck, origin: 'known', history: [{ gen: 0, how: 'known' }, { gen: 1, how: 'swapped cards', added: { 'FS02-12': 1 }, removed: {} }], rate: 0.5, lo: 0.4, hi: 0.6, games: 40, perTarget: [], result };
  const e = cardEvidence(cards, v, 'FS02-12', target);
  assert.equal(e.stats.validationGames, 40);
  assert.ok(e.stats.gamesWhereItWasPlayedOrComboed <= 40);
  assert.ok(e.history.some((h) => h.includes('+1 of this card')));
  assert.ok(e.stats.verdict.length > 10);
  assert.ok(explainPrompt(e, '').includes('EVIDENCE'));
});

test('diffDecks lists what changed between two lists', () => {
  const d = diffDecks({ name: 'a', leader: 'x', main: { A: 2, B: 1 } }, { name: 'b', leader: 'x', main: { A: 3, C: 1 } });
  assert.deepEqual(d, { added: { A: 1, C: 1 }, removed: { B: 1 } });
});
