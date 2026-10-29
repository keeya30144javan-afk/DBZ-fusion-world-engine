/** Cards fixed from the user's audit notes: the engine does what the printed card says. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, step } from '../src/engine/game';
import { GameState, Side, condsHold, costInHand, costOf, moveTo } from '../src/engine/core';
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
