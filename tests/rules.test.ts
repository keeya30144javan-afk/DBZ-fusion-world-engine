import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, legalActions, step, Action } from '../src/engine/game';
import { GameState, Side, moveTo, powerOf, planPayment, costInHand } from '../src/engine/core';
import { defaultChooser } from '../src/ai/heuristics';
import { Decklist } from '../src/data/types';

const db = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8'));
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
const deck = (i: number): Decklist => meta.decks[i];
const ctl: any = [defaultChooser, defaultChooser];

/** A game past setup: first player 0, on turn 2 (player 1 active) unless told otherwise. */
function fresh(a = 0, b = 3, seed = 1): GameState {
  const s = newGame(db.cards, [deck(a), deck(b)], { seed, first: 0 });
  step(s, { k: 'keep' }, ctl);
  step(s, { k: 'keep' }, ctl);
  return s;
}

/** Put a specific card id from a player's deck into a zone. */
function fetch(s: GameState, p: Side, id: string, zone: 'hand' | 'battle' | 'energy' | 'drop'): number {
  const all = [...s.p[p].deck, ...s.p[p].hand, ...s.p[p].life, ...s.p[p].drop];
  const u = all.find((x) => s.inst[x].id === id && !s.p[p].battle.includes(x));
  assert.ok(u !== undefined, `no ${id} available`);
  moveTo(s, u!, zone);
  return u!;
}

/** Let nobody respond until the battle resolves. */
function finishBattle(s: GameState) {
  let n = 0;
  while (s.battle && n++ < 20) {
    const k = s.stage === 'counter' ? 'noCounter' : s.stage === 'block' ? 'noBlock' : 'comboDone';
    step(s, { k } as Action, ctl);
  }
}

function findAct(s: GameState, pred: (a: Action) => boolean): Action {
  const a = legalActions(s).find(pred);
  assert.ok(a, `action not legal; legal: ${JSON.stringify(legalActions(s))}`);
  return a!;
}

test('setup: 6 cards in hand, 8 life, second player gets an energy marker', () => {
  const s = fresh();
  assert.equal(s.p[0].life.length, 8);
  assert.equal(s.p[1].life.length, 8);
  assert.equal(s.p[0].hand.length, 6); // first player does not draw on turn 1
  assert.equal(s.p[1].markers, 1);
  assert.equal(s.p[0].markers, 0);
  assert.equal(s.turn, 1);
  assert.equal(s.active, 0);
});

test('first player cannot attack on turn 1', () => {
  const s = fresh();
  step(s, { k: 'noCharge' }, ctl);
  assert.ok(!legalActions(s).some((a) => a.k === 'attack'));
});

test('second player draws on their first turn', () => {
  const s = fresh();
  step(s, { k: 'noCharge' }, ctl);
  step(s, { k: 'end' }, ctl);
  assert.equal(s.turn, 2);
  assert.equal(s.p[1].hand.length, 7);
});

test('attacker wins ties and the defending leader puts 1 life into hand', () => {
  const s = fresh();
  step(s, { k: 'noCharge' }, ctl);
  step(s, { k: 'end' }, ctl);
  step(s, { k: 'noCharge' }, ctl);
  s.p[0].hand = []; // no combo options
  const life = s.p[0].life.length;
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === s.p[1].leader), ctl);
  // 15000 vs 15000 resolves straight to damage when nobody can respond
  finishBattle(s);
  assert.equal(s.p[0].life.length, life - 1);
  assert.equal(s.p[0].hand.length, 1);
});

test('[Double Strike] deals 2, [Critical] sends life to the Drop', () => {
  const s = fresh(0, 3);
  s.turn = 2; s.active = 0; s.stage = 'main'; s.toAct = 0;
  const goku = fetch(s, 0, 'FS01-08', 'battle'); // 35000 Double Strike
  const gohan = fetch(s, 0, 'FS01-09', 'battle'); // Critical
  s.p[1].hand = [];
  s.p[1].battle = [];
  const life = s.p[1].life.length;
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === goku), ctl);
  finishBattle(s);
  assert.equal(s.p[1].life.length, life - 2);
  assert.equal(s.p[1].hand.length, 2);
  const drop = s.p[1].drop.length;
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === gohan), ctl);
  finishBattle(s);
  assert.equal(s.p[1].life.length, life - 3);
  assert.equal(s.p[1].drop.length, drop + 1);
});

test('life reaching 0 ends the game', () => {
  const s = fresh();
  s.turn = 2; s.active = 0; s.stage = 'main'; s.toAct = 0;
  s.p[1].life = s.p[1].life.slice(0, 1);
  s.p[1].hand = [];
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader), ctl);
  finishBattle(s);
  assert.equal(s.stage, 'over');
  assert.equal(s.winner, 0);
});

test('[Blocker] redirects the attack', () => {
  const s = fresh(0, 3);
  s.turn = 2; s.active = 0; s.stage = 'main'; s.toAct = 0;
  const dodoria = fetch(s, 1, 'FS04-10', 'battle'); // 10000 Blocker
  s.p[1].hand = [];
  const life = s.p[1].life.length;
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader), ctl);
  assert.equal(s.stage, 'block');
  step(s, { k: 'block', uid: dodoria }, ctl);
  finishBattle(s);
  assert.equal(s.p[1].life.length, life);
  assert.ok(s.p[1].drop.includes(dodoria), 'blocker is KO\'d');
});

test('combo: free, from hand or an active battle card; [Super Combo] bonus only on opponent\'s turn', () => {
  const s = fresh(0, 3);
  s.turn = 2; s.active = 0; s.stage = 'main'; s.toAct = 0;
  s.p[1].hand = [];
  const cheelai = fetch(s, 1, 'FS04-09', 'hand'); // combo 10000 (+10000 on opp turn)
  const tagoma = fetch(s, 1, 'FS04-08', 'battle'); // combo 10000 from the field
  step(s, findAct(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader), ctl);
  if ((s.stage as string) === 'offCombo') step(s, { k: 'comboDone' }, ctl);
  assert.equal(s.stage, 'defCombo');
  step(s, { k: 'combo', uid: cheelai }, ctl);
  assert.equal(s.inst[cheelai].comboBonus, 10000);
  if (s.stage === 'defCombo') step(s, { k: 'combo', uid: tagoma }, ctl);
  if (s.stage === 'defCombo') step(s, { k: 'comboDone' }, ctl);
  assert.equal(s.p[1].life.length, 8, '15000 vs 15000+30000 is blocked out');
  assert.ok(s.p[1].drop.includes(cheelai) && s.p[1].drop.includes(tagoma), 'combo cards go to the Drop');
  assert.equal(s.p[1].energy.length, 0, 'combo costs no energy');
});

test('power reduced to 0 sends a card to the Drop without a KO trigger', () => {
  const s = fresh(0, 3);
  s.turn = 2; s.active = 0; s.stage = 'main'; s.toAct = 0;
  const cui = fetch(s, 1, 'FS04-02', 'battle'); // 20000, [When KO'd] Draw 1
  for (const id of ['FS01-01']) void id;
  const goku = fetch(s, 0, 'FS01-08', 'hand'); // On Play -20000
  for (let i = 0; i < 5; i++) fetch(s, 0, ['FS01-02', 'FS01-03', 'FS01-10', 'FS01-07', 'FS01-11'][i], 'energy');
  const hand = s.p[1].hand.length;
  step(s, findAct(s, (a) => a.k === 'play' && s.inst[a.uid].id === s.inst[goku].id), ctl);
  assert.ok(s.p[1].drop.includes(cui));
  assert.equal(s.p[1].hand.length, hand, 'no When KO\'d draw');
});

test('cost reduction: God Kamehameha costs 1 with no Battle Cards', () => {
  const s = fresh(0, 3);
  const gk = fetch(s, 0, 'FS01-16', 'hand');
  s.p[0].battle = [];
  assert.equal(costInHand(s, gk), 1);
  fetch(s, 0, 'FS01-07', 'battle');
  assert.equal(costInHand(s, gk), 2);
});

test('payment needs coloured orbs; an energy marker pays the leader colour', () => {
  const s = fresh(0, 3);
  s.p[0].energy = [];
  fetch(s, 0, 'FS01-07', 'energy');
  assert.ok(planPayment(s, 0, 1, { Red: 1 }));
  assert.equal(planPayment(s, 0, 2, { Red: 1 }), null);
  s.p[0].markers = 1;
  assert.ok(planPayment(s, 0, 2, { Red: 2 }));
});

test('[Permanent][Your Turn] power applies only on your turn', () => {
  const s = fresh(0, 3);
  const krillin = fetch(s, 0, 'FS01-04', 'battle'); // 15000, +5000 your turn
  s.active = 0;
  assert.equal(powerOf(s, krillin), 20000);
  s.active = 1;
  assert.equal(powerOf(s, krillin), 15000);
});

test('once per turn skills are offered once', () => {
  const s = fresh(2, 3); // Broly
  s.turn = 3; s.active = 0; s.stage = 'main'; s.toAct = 0;
  s.p[0].awakened = true;
  for (let i = 0; i < 3; i++) fetch(s, 0, 'FS03-05', 'energy');
  const act = findAct(s, (a) => a.k === 'activate' && a.uid === s.p[0].leader);
  step(s, act, ctl);
  assert.ok(!legalActions(s).some((a) => a.k === 'activate' && a.uid === s.p[0].leader));
  assert.equal(s.p[0].energy.length, 2);
});

test('random games always finish', () => {
  for (let seed = 0; seed < 60; seed++) {
    const s = newGame(db.cards, [deck(seed % 4), deck((seed + 1) % 4)], { seed });
    let n = 0;
    while (s.stage !== 'over' && n++ < 5000) {
      const acts = legalActions(s);
      step(s, acts[(seed * 7 + n) % acts.length], ctl);
    }
    assert.equal(s.stage, 'over', `seed ${seed} stuck at ${s.stage}`);
  }
});
