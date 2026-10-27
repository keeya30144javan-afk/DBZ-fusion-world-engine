import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CardDB } from '../src/data/types';
import { translateBatch, Sampler } from '../src/ui/translate';
import { textHash } from '../src/effects/script';

const db: CardDB = JSON.parse(readFileSync('data/cards.json', 'utf8'));

test('in-app pipeline: validates, repairs once, checks the reading, never exceeds three calls', async () => {
  const [a, b] = [db.cards['FB01-030'], db.cards['FB01-032']];
  const prompts: string[] = [];
  const answers = [
    { [a.id]: { abilities: [{ timing: 'onPlay', effects: [{ t: 'draw', n: 1 }] }] }, [b.id]: { abilities: [{ timing: 'onPlay', effects: [{ t: 'explode' }] }] } },
    { [b.id]: { abilities: [{ timing: 'onPlay', effects: [{ t: 'draw', n: 2 }] }] } },
    { [a.id]: { ok: true, issues: '' }, [b.id]: { ok: false, issues: 'draws 2 instead of 1' } },
  ];
  const sample = Object.assign(async () => ({ text: '' }), { json: async (input: string) => { prompts.push(input); return answers[prompts.length - 1]; } }) as Sampler;
  const res = await translateBatch(sample, [a, b], () => {});
  assert.equal(prompts.length, 3);
  assert.match(prompts[1], /explode|unknown/i);
  assert.equal(res[0].doc?.status, 'unreviewed');
  assert.equal(res[0].doc?.textHash, textHash(a));
  assert.equal(res[0].doc?.check?.ok, true);
  assert.equal(res[1].doc?.check?.ok, false);
  assert.equal(res[1].doc?.script?.abilities[0].effects[0].t, 'draw');
});

test('in-app pipeline: a translation still invalid after the repair is refused, not stored', async () => {
  const a = db.cards['FB01-030'];
  let calls = 0;
  const sample = Object.assign(async () => ({ text: '' }), { json: async () => { calls++; return { [a.id]: { abilities: [{ timing: 'never', effects: [] }] } }; } }) as Sampler;
  const res = await translateBatch(sample, [a], () => {});
  assert.equal(calls, 2);
  assert.equal(res[0].doc, undefined);
  assert.ok(res[0].errors?.length);
});
