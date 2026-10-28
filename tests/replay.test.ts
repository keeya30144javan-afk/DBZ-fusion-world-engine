import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findReplay, recordGame } from '../src/builder/replay';

const cards = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8')).cards;
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));

test('a recorded game has a frame per move, ends with the result, and is reproducible from its seed', () => {
  const o = { decks: [meta.decks[0], meta.decks[1]] as [any, any], levels: ['fast', 'fast'] as ['fast', 'fast'], seed: 7 };
  const r = recordGame(cards, o);
  assert.ok(r.frames.length > 20);
  assert.equal(r.frames[0].actor, -1);
  assert.ok(r.winner === 0 || r.winner === 1 || r.winner === -1);
  for (let k = 1; k < r.frames.length; k++) assert.ok(r.frames[k].turn >= r.frames[k - 1].turn, 'turns never go back');
  const last = r.frames[r.frames.length - 1].snap;
  if (r.reason === 'life reached 0') assert.equal(last.p[r.winner === 0 ? 1 : 0].life, 0);
  const again = recordGame(cards, o);
  assert.deepEqual(again.frames.map((f) => f.move), r.frames.map((f) => f.move));
});

test('findReplay looks for the asked-for outcome', () => {
  const r = findReplay(cards, { decks: [meta.decks[0], meta.decks[1]], levels: ['fast', 'fast'], seed: 1, want: 'loss', tries: 12 });
  assert.equal(r.winner, 1);
});

test('findReplay with mustPlay returns a game where deck A used that card', () => {
  const r = findReplay(cards, { decks: [meta.decks[1], meta.decks[0]], levels: ['fast', 'fast'], seed: 3, want: 'any', tries: 12, mustPlay: 'FS02-12' });
  assert.ok(r.played[0].includes('FS02-12'));
});
