import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scout } from '../src/ai/scouter';

const db = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8'));
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));

test('card counting: seen copies leave the pool', () => {
  const base = { leader: 'FS01-01', archetypes: meta.decks, handSize: 6, lifeCount: 8, behaviour: [] };
  const a = scout(db.cards, { ...base, seen: [] });
  const b = scout(db.cards, { ...base, seen: [{ id: 'FS01-02', n: 3, where: 'public' }] });
  const pa = a.cards.find((c) => c.id === 'FS01-02')!.pInHand;
  const pb = b.cards.find((c) => c.id === 'FS01-02')!.pInHand;
  assert.ok(pb < pa / 2, `${pb} should be well below ${pa}`);
  // Hypergeometric check: 4 copies in 50, 6 drawn -> 1 - C(46,6)/C(50,6) ~ 0.418
  assert.ok(Math.abs(pa - 0.418) < 0.03, `pa=${pa}`);
});

test('behaviour: letting a cheap block go lowers the odds they held it', () => {
  // A list where only some cards carry 10000 combo power.
  const list = { name: 'test', leader: 'FS01-01', main: { 'FS01-08': 4, 'FS01-09': 4, 'FS01-10': 4, 'FS01-03': 4, 'FS01-12': 4, 'FS01-16': 4, 'FS01-15': 4 } };
  const base = { leader: 'FS01-01', archetypes: [list], handSize: 5, lifeCount: 3, seen: [] };
  const a = scout(db.cards, { ...base, behaviour: [] });
  const b = scout(db.cards, { ...base, behaviour: [{ t: 'tookHit', need: 10000, stakes: 'leader', life: 3 }] as any });
  const one = (r: any) => r.defense.find((d: any) => d.need === 10000).pOne;
  assert.ok(one(b) < one(a), `${one(b)} < ${one(a)}`);
});

test('archetype posterior follows the leader', () => {
  const r = scout(db.cards, { leader: 'FS04-01', archetypes: meta.decks, handSize: 6, lifeCount: 8, behaviour: [], seen: [] });
  assert.equal(r.archetypes.length, 1);
  assert.equal(r.archetypes[0].posterior, 1);
});
