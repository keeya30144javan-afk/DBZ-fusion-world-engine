/** Play vs AI: a person's game must replay exactly from its saved record (choices, undo, stored decks). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PlayHost, PlayView, replayRecord } from '../src/play/host';
import { cloneState } from '../src/engine/core';

const cards = JSON.parse(readFileSync('data/cards.json', 'utf8')).cards;
const decks = JSON.parse(readFileSync('data/meta.json', 'utf8')).decks;

/** A stand-in person: random legal moves and random valid answers, sometimes undoing. */
function playRandomly(h: PlayHost, moves: number, undoEvery = 0) {
  let r = 4242;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let v: PlayView = h.advance(3);
  for (let n = 0; n < moves && !v.over; n++) {
    const d = v.decision;
    if (!d) { v = h.advance(3); continue; }
    if (undoEvery && n % undoEvery === undoEvery - 1 && v.canUndo) v = h.undo();
    else if (d.kind === 'action') v = h.act(d.options[Math.floor(rnd() * d.options.length)].i);
    else v = h.answer(d.options.map((o) => o.v).sort(() => rnd() - 0.5).slice(0, Math.max(d.min, 0)));
    if (!v.over && !v.decision) v = h.advance(3);
  }
  return v;
}

const same = (a: ReturnType<PlayHost['record']>, h: PlayHost) => {
  const st = replayRecord(cards, a);
  const end = st[st.length - 1], real = h.real;
  return end.turn === real.turn && end.winner === real.winner && end.p[0].life.length === real.p[0].life.length
    && end.p[1].hand.length === real.p[1].hand.length && end.p[0].battle.length === real.p[0].battle.length;
};

test('a game replays exactly from its record, with undos', { timeout: 120000 }, () => {
  const h = new PlayHost(cards, { you: decks[4], ai: decks[5], level: 'quick', seed: 77, youFirst: true });
  playRandomly(h, 45, 7);
  const rec = h.record();
  assert.ok(rec.trace.length > 10);
  assert.ok(same(rec, h));
});

test('the replay does not depend on how the deck lists were stored (key order)', { timeout: 120000 }, () => {
  const h = new PlayHost(cards, { you: decks[6], ai: decks[7], level: 'quick', seed: 91, youFirst: false });
  playRandomly(h, 25);
  const rec = h.record();
  const flip = (d: any) => ({ ...d, main: Object.fromEntries(Object.entries(d.main).reverse()) });
  assert.ok(same({ ...rec, you: flip(rec.you), ai: flip(rec.ai) }, h));
});

test('the AI thinking does not change the real game', { timeout: 120000 }, () => {
  const h = new PlayHost(cards, { you: decks[4], ai: decks[9], level: 'quick', seed: 5, youFirst: false });
  const before = cloneState(h.real);
  h.advise('quick');
  assert.equal(h.real.seed, before.seed);
  assert.deepEqual(h.real.p[0].deck, before.p[0].deck);
});
