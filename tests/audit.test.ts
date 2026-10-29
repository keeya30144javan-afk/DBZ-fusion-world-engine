/** Cards fixed from the user's audit notes: the engine does what the printed card says. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, step } from '../src/engine/game';
import { GameState, Side, cloneState, condsHold, costInHand, costOf, moveTo } from '../src/engine/core';
import { koCard, payCosts, resolveAbility } from '../src/engine/effects';
import { defaultChooser } from '../src/ai/heuristics';
import { compileCard } from '../src/effects/parse';
import { Card } from '../src/data/types';

const cards: Record<string, Card> = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8')).cards;
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
const ctl: any = [defaultChooser, defaultChooser];

function fresh(): GameState {
  const s = newGame(cards, [meta.decks[0], meta.decks[3]], { seed: 2, first: 0 });
  step(s, { k: 'keep' }, ctl);
  step(s, { k: 'keep' }, ctl);
  s.turn = 3; s.active = 0; s.stage = 'main'; s.toAct = 0;
  return s;
}

function spawn(s: GameState, p: Side, id: string, zone: 'hand' | 'battle' | 'energy' | 'drop' | 'deck' | 'life'): number {
  assert.ok(cards[id], id);
  const uid = s.inst.length;
  s.inst.push({ uid, id, owner: p, rested: false, lockedUntil: 0, mods: [], grants: [], comboBonus: 0, playedTurn: 0, ki: 0 });
  s.p[p][zone].push(uid);
  return uid;
}

test('Dragon Radar (FB07-120) also finds a Dragon Ball card in the life', () => {
  const s = fresh();
  s.p[0].deck = s.p[0].deck.filter((u) => !(cards[s.inst[u].id].traits ?? []).includes('Dragon Ball'));
  const ball = spawn(s, 0, 'FB07-119', 'life');
  const radar = spawn(s, 0, 'FB07-120', 'hand');
  const life = s.p[0].life.length;
  resolveAbility(s, radar, compileCard(cards['FB07-120']).abilities[0], 0, ctl, { costsPaid: true });
  assert.ok(s.p[0].hand.includes(ball));
  assert.equal(s.p[0].life.length, life - 1);
});

test('Vegito (FS09-16) costs 4 more in the deck, not in hand', () => {
  const s = fresh();
  const inDeck = spawn(s, 0, 'FS09-16', 'deck');
  const inHand = spawn(s, 0, 'FS09-16', 'hand');
  assert.equal(costOf(s, inDeck), cards['FS09-16'].cost + 4);
  assert.equal(costInHand(s, inHand), cards['FS09-16'].cost);
});

test('Son Goku (FS13-15) can pay by placing a card on top of the deck instead of discarding', () => {
  const s = fresh();
  const goku = spawn(s, 0, 'FS13-15', 'battle');
  const drop = s.p[0].drop.length, deck = s.p[0].deck.length, hand = s.p[0].hand.length;
  payCosts(s, goku, compileCard(cards['FS13-15']).abilities[0].cost!, ctl);
  assert.equal(s.p[0].drop.length, drop, 'nothing discarded');
  assert.equal(s.p[0].deck.length, deck + 1);
  assert.equal(s.p[0].hand.length, hand - 1);
});

test('Android 17 (FP-042) counts only KOs in battle', () => {
  const s = fresh();
  const a17 = spawn(s, 0, 'FP-042', 'battle');
  const cond = compileCard(cards['FP-042']).abilities[1].cond;
  const v1 = spawn(s, 1, 'FS01-02', 'battle');
  koCard(s, v1, ctl, { src: a17, skillOf: 0 });
  assert.equal(condsHold(s, 0, a17, cond), false, 'a KO by a skill does not count');
  const v2 = spawn(s, 1, 'FS01-02', 'battle');
  koCard(s, v2, ctl, { src: a17, battle: true });
  assert.equal(condsHold(s, 0, a17, cond), true);
});

test('Son Goku (FP-027) draws only if energy went to the Drop this turn', () => {
  const s = fresh();
  const goku = spawn(s, 0, 'FP-027', 'battle');
  const cond = compileCard(cards['FP-027']).abilities[0].cond;
  const e1 = spawn(s, 0, 'FS01-02', 'energy');
  moveTo(s, e1, 'hand');
  assert.equal(condsHold(s, 0, goku, cond), false, 'energy to hand does not count');
  const e2 = spawn(s, 0, 'FS01-02', 'energy');
  moveTo(s, e2, 'drop');
  assert.equal(condsHold(s, 0, goku, cond), true);
});

test('Kakarot (FS05-03): the AI puts the card from hand at the bottom of the deck', () => {
  const s = fresh();
  const k = spawn(s, 0, 'FS05-03', 'battle');
  const handBefore = s.p[0].hand.slice();
  payCosts(s, k, compileCard(cards['FS05-03']).abilities[0].cost!, ctl);
  const gone = handBefore.find((u) => !s.p[0].hand.includes(u))!;
  assert.equal(s.p[0].deck[0], gone, 'bottom of the deck is the front of the array');
});

test("Broly's awakened tax (FB08-073): a Leader's attack is free; a Battle Card's attack asks what to rest", () => {
  const s = fresh();
  // The opponent: awakened Broly with a cost-5 Saiyan Battle Card in play.
  const broly = s.p[1].leader;
  s.inst[broly] = { ...s.inst[broly], id: 'FB08-073' };
  s.p[1].awakened = true;
  spawn(s, 1, 'ST01-051', 'battle');
  const mine = spawn(s, 0, 'FB09-122', 'battle');
  spawn(s, 0, 'FS01-02', 'battle');
  for (const u of s.p[0].energy) s.inst[u].rested = true;
  const asked: number[][] = [];
  const spy: any = { choose: (st: GameState, req: any) => { if (req.tax) asked.push(req.options); return defaultChooser.choose(st, req); } };
  const leaderAttack = cloneState(s);
  step(leaderAttack, { k: 'attack', uid: leaderAttack.p[0].leader, target: broly }, [spy, ctl[1]]);
  assert.equal(asked.length, 0, "no tax on the Leader's attack");
  assert.equal(leaderAttack.inst[mine].rested, false);
  step(s, { k: 'attack', uid: mine, target: broly }, [spy, ctl[1]]);
  assert.equal(asked.length, 1, 'the attacker is asked what to rest');
  assert.equal(s.inst[s.p[0].leader].rested, false, 'the AI chooser rests a Battle Card before the Leader');
});

test('Trunks: Future (FB11-035): "remove 2 or more Ki" lets the AI remove just enough for the Trunks it holds', () => {
  const s = fresh();
  s.inst[s.p[0].leader] = { ...s.inst[s.p[0].leader], id: 'FB11-025' };
  const t2 = spawn(s, 0, 'FB11-035', 'battle');
  s.inst[t2].ki = 3;
  s.p[0].hand = [];
  const t3 = spawn(s, 0, 'FB07-039', 'hand');
  const ab = compileCard(cards['FB11-035']).abilities[1];
  resolveAbility(s, t2, ab, 1, ctl);
  assert.ok(s.p[0].battle.includes(t3), 'the 3-cost Trunks was played (2 Ki removed)');
  assert.equal(s.p[0].deck[0], t2, 'the 2-drop went to the bottom of the deck');
});

test('the ban list: banned cards and extra copies of restricted ones make a deck illegal; the deck builder avoids them', async () => {
  const { validateDeck } = await import('../src/data/decks');
  const { seedDeck, mulberry } = await import('../src/builder/deckgen');
  const { DEFAULT_RULES } = await import('../src/data/rules');
  const base = meta.decks.find((d: any) => d.name === 'Jiren (Red)');
  assert.deepEqual(validateDeck(base, cards, DEFAULT_RULES), []);
  const leaderOf = (id: string) => Object.values(cards).find((c) => c.type === 'LEADER' && c.colors.some((x) => cards[id].colors.includes(x)))!.id;
  const roshi = { name: 't', leader: leaderOf('FB01-005'), main: { 'FB01-005': 1 } };
  assert.ok(validateDeck(roshi, cards, DEFAULT_RULES).some((e) => /banned/.test(e)));
  const cell = { name: 't', leader: 'SB01-001', main: { 'SB01-011': 2 } };
  assert.ok(validateDeck(cell, cards, DEFAULT_RULES).some((e) => /restricted/.test(e)));
  const rng = mulberry(7);
  for (let i = 0; i < 20; i++) {
    const d = seedDeck(cards, 'SB01-001', rng, DEFAULT_RULES);
    assert.ok((d.main['SB01-011'] ?? 0) <= 1 && (d.main['SB01-015'] ?? 0) <= 1, 'seeded Cell deck respects the restricted list');
  }
});
