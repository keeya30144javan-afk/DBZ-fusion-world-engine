/**
 * One test per rule in the Official Rule Manual v1.20 (Fusion World).
 * Each test names the manual page it checks, so a failing test points at the rule it breaks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, legalActions, step, Action } from '../src/engine/game';
import { GameState, Side, moveTo, powerOf } from '../src/engine/core';
import { koCard } from '../src/engine/effects';
import { validateDeck } from '../src/data/decks';
import { defaultChooser } from '../src/ai/heuristics';
import { Card, Decklist } from '../src/data/types';

const db = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8'));
const cards: Record<string, Card> = db.cards;
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
const ctl: any = [defaultChooser, defaultChooser];
const RED = 0, GREEN = 2, YELLOW = 3;

function fresh(a = RED, b = YELLOW, seed = 1): GameState {
  const s = newGame(cards, [meta.decks[a], meta.decks[b]], { seed, first: 0 });
  step(s, { k: 'keep' }, ctl);
  step(s, { k: 'keep' }, ctl);
  return s;
}

/** Jump to player p's main phase on a turn where attacking is allowed. */
function mainOf(s: GameState, p: Side) {
  s.turn = 3 + p; s.active = p; s.stage = 'main'; s.toAct = p; s.battle = null;
}

/** Create a new copy of any card in a zone (or as the Field / Leader). */
function spawn(s: GameState, p: Side, id: string, zone: 'hand' | 'battle' | 'energy' | 'drop' | 'deck' | 'field' | 'leader'): number {
  assert.ok(cards[id], `unknown card ${id}`);
  const uid = s.inst.length;
  s.inst.push({ uid, id, owner: p, rested: false, lockedUntil: 0, mods: [], grants: [], comboBonus: 0, playedTurn: 0, ki: 0 });
  if (zone === 'field') s.p[p].field = uid;
  else if (zone === 'leader') s.p[p].leader = uid;
  else s.p[p][zone].push(uid);
  return uid;
}

/** n untapped energy of the leader's colour. */
function energy(s: GameState, p: Side, n: number) {
  const color = cards[s.inst[s.p[p].leader].id].colors[0];
  const id = Object.values(cards).find((c) => c.type === 'BATTLE' && c.colors.length === 1 && c.colors[0] === color)!.id;
  s.p[p].energy = [];
  for (let i = 0; i < n; i++) spawn(s, p, id, 'energy');
}

const has = (s: GameState, pred: (a: Action) => boolean) => legalActions(s).some(pred);
function act(s: GameState, pred: (a: Action) => boolean) {
  const a = legalActions(s).find(pred);
  assert.ok(a, `not legal; legal: ${JSON.stringify(legalActions(s))}`);
  step(s, a!, ctl);
}
/** Pass every choice until the battle reaches the given stage (or ends). */
function passTo(s: GameState, stage: string) {
  for (let i = 0; i < 20 && s.battle && s.stage !== stage; i++) {
    const k = s.stage === 'counter' ? 'noCounter' : s.stage === 'block' ? 'noBlock' : 'comboDone';
    step(s, { k } as Action, ctl);
  }
}
const finish = (s: GameState) => passTo(s, '__end__');

// ------------------------------------------------------------------ p.4 Deck Building

test('p.4: 50-60 cards, leader colours only, max 4 per card number, max 4 [Super Combo]', () => {
  const base: Decklist = meta.decks[RED];
  assert.deepEqual(validateDeck(base, cards), []);
  const offColour = Object.values(cards).find((c) => c.type === 'BATTLE' && !c.colors.includes('Red'))!;
  const id0 = Object.keys(base.main)[0];
  const swapped = { ...base, main: { ...base.main, [id0]: base.main[id0] - 1, [offColour.id]: 1 } };
  assert.ok(validateDeck(swapped, cards).some((e) => /off-colour/.test(e)));
  const five = { ...base, main: { ...base.main, [id0]: 5 } };
  assert.ok(validateDeck(five, cards).some((e) => /copies/.test(e)));
  const supers = Object.values(cards).filter((c) => c.colors.includes('Red') && /\[Super Combo\]/i.test(c.text)).slice(0, 2);
  const tooMany = { ...base, main: { ...base.main, [supers[0].id]: 4, [supers[1].id]: 1 } };
  assert.ok(validateDeck(tooMany, cards).some((e) => /Super Combo/.test(e)));
});

test('p.12: up to 7 [Dragon Ball] cards, even with the same card number', () => {
  const black = Object.values(cards).filter((c) => c.type === 'BATTLE' && c.colors.length === 1 && c.colors[0] === 'Black' && !/\[Super Combo\]/i.test(c.text));
  const main: Record<string, number> = { 'FB12-119': 7 };
  for (const c of black.slice(0, 11)) main[c.id] = 4;
  const deck: Decklist = { name: 'Sorbet test', leader: 'FB12-097', main };
  assert.deepEqual(validateDeck(deck, cards), []);
  assert.ok(validateDeck({ ...deck, main: { ...main, 'FB12-119': 8 } }, cards).some((e) => /Dragon Ball/.test(e)));
});

// ------------------------------------------------------------------ p.6 Setup and victory

test('p.6: 6-card hand, 8 life with the deck top at the life bottom, marker for the second player', () => {
  const s = newGame(cards, [meta.decks[RED], meta.decks[YELLOW]], { seed: 4, first: 0 });
  assert.equal(s.p[0].hand.length, 6);
  const deckTop = s.p[1].deck[s.p[1].deck.length - 1];
  step(s, { k: 'keep' }, ctl);
  step(s, { k: 'keep' }, ctl);
  assert.equal(s.p[1].life.length, 8);
  assert.equal(s.p[1].life[0], deckTop, 'top deck card becomes the bottom life card');
  assert.equal(s.p[1].markers, 1);
  assert.equal(s.p[0].markers, 0);
});

test('p.6: a mulligan returns all 6, reshuffles and draws 6, once', () => {
  const s = newGame(cards, [meta.decks[RED], meta.decks[YELLOW]], { seed: 9, first: 0 });
  step(s, { k: 'mulligan' }, ctl);
  assert.equal(s.p[0].hand.length, 6);
  assert.equal(s.p[0].mulliganed, true);
  assert.equal(s.toAct, 1, 'then the other player decides');
});

test('p.6: a player whose deck reaches 0 loses at once', () => {
  const s = fresh();
  s.p[1].deck = s.p[1].deck.slice(-1);
  step(s, { k: 'noCharge' }, ctl);
  step(s, { k: 'end' }, ctl); // P1 draws its last card
  assert.equal(s.stage, 'over');
  assert.equal(s.winner, 0);
  assert.equal(s.reason, 'deck out');
});

test('p.6 + FB12-097: Sorbet does not lose at 0 cards in deck', () => {
  const s = fresh();
  spawn(s, 1, 'FB12-097', 'leader');
  s.p[1].deck = s.p[1].deck.slice(-1);
  step(s, { k: 'noCharge' }, ctl);
  step(s, { k: 'end' }, ctl);
  assert.notEqual(s.stage, 'over');
  assert.equal(s.p[1].deck.length, 0);
});

// ------------------------------------------------------------------ p.7-9 Turn structure

test('p.7: the first player draws 1 in their first Charge Phase', () => {
  const s = fresh();
  assert.equal(s.p[0].hand.length, 7);
});

test('p.7-8: charge 1 card into energy in Active Mode', () => {
  const s = fresh();
  const u = s.p[0].hand[0];
  step(s, { k: 'charge', uid: u }, ctl);
  assert.ok(s.p[0].energy.includes(u));
  assert.equal(s.inst[u].rested, false);
  assert.equal(s.stage, 'main');
});

test('p.9: attack the Leader or a Rest Mode Battle Card, never an Active one; new cards may attack', () => {
  const s = fresh();
  mainOf(s, 0);
  const awake = spawn(s, 1, 'FS04-06', 'battle');
  const tired = spawn(s, 1, 'FS04-06', 'battle');
  s.inst[tired].rested = true;
  const mine = spawn(s, 0, 'FS01-07', 'battle');
  s.inst[mine].playedTurn = s.turn;
  assert.ok(has(s, (a) => a.k === 'attack' && a.uid === mine && a.target === tired));
  assert.ok(has(s, (a) => a.k === 'attack' && a.uid === mine && a.target === s.p[1].leader));
  assert.ok(!has(s, (a) => a.k === 'attack' && a.target === awake));
});

test('p.9: the first player cannot attack on turn 1', () => {
  const s = fresh();
  step(s, { k: 'noCharge' }, ctl);
  assert.ok(!has(s, (a) => a.k === 'attack'));
});

// ------------------------------------------------------------------ p.10 Battle

test('p.10: equal power — the attacker wins', () => {
  const s = fresh();
  mainOf(s, 0);
  s.p[1].hand = [];
  const life = s.p[1].life.length;
  act(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader && a.target === s.p[1].leader);
  finish(s);
  assert.equal(s.p[1].life.length, life - 1);
});

test('p.10: a Battle Card that loses a battle is KO\'d into the Drop', () => {
  const s = fresh();
  mainOf(s, 0);
  s.p[1].hand = [];
  const t = spawn(s, 1, 'FS04-10', 'battle'); // 10000
  s.inst[t].rested = true;
  act(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader && a.target === t);
  finish(s);
  assert.ok(s.p[1].drop.includes(t));
});

test('p.12: [When Blocking] skills trigger when [Blocker] is used', () => {
  const s = fresh();
  mainOf(s, 0);
  s.p[1].hand = [];
  const cooler = spawn(s, 1, 'FB01-113', 'battle'); // Blocker; When Blocking: rest an opponent's Battle Card
  const mine = spawn(s, 0, 'FS01-08', 'battle');
  act(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader);
  passTo(s, 'block');
  step(s, { k: 'block', uid: cooler }, ctl);
  assert.equal(s.inst[mine].rested, true, 'Cooler\'s When Blocking rested it');
});

test('p.9, p.12: [Awaken] can be used in the Defense Step and changes the defender\'s power', () => {
  const s = fresh(RED, YELLOW);
  mainOf(s, 0);
  s.p[1].hand = [];
  s.p[1].life = s.p[1].life.slice(0, 4); // Frieza awakens at 4 or less
  act(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader && a.target === s.p[1].leader);
  passTo(s, 'defCombo');
  assert.equal(s.stage, 'defCombo');
  assert.ok(has(s, (a) => a.k === 'awaken'));
  step(s, { k: 'awaken' }, ctl);
  assert.equal(powerOf(s, s.p[1].leader), 20000);
  finish(s);
  assert.equal(s.p[1].life.length, 4, 'no damage: 15000 < 20000');
});

test('p.13: an [Activate: Battle][Your Turn] Extra cannot be used on the opponent\'s turn', () => {
  const s = fresh();
  mainOf(s, 1);
  s.p[0].hand = [];
  const assemble = spawn(s, 0, 'FB01-030', 'hand'); // [Activate Battle][Your Turn] +15000
  spawn(s, 0, 'FS01-07', 'hand'); // a combo card, so the Defense Step offers a choice
  energy(s, 0, 3);
  act(s, (a) => a.k === 'attack' && a.uid === s.p[1].leader && a.target === s.p[0].leader);
  passTo(s, 'defCombo');
  assert.equal(s.stage, 'defCombo');
  assert.ok(!has(s, (a) => a.k === 'battleSkill' && a.uid === assemble));
});

// ------------------------------------------------------------------ p.11-13 Other

test('p.11: when power is reduced to 0 the card is placed in the Drop, not KO\'d', () => {
  const s = fresh();
  mainOf(s, 0);
  const u = spawn(s, 1, 'FS04-02', 'battle'); // When KO'd: draw
  s.inst[u].mods.push({ amount: -100000, until: s.turn + 5 });
  const hand = s.p[1].hand.length;
  step(s, { k: 'end' }, ctl); // end of turn checks power
  assert.ok(s.p[1].drop.includes(u));
  assert.equal(s.p[1].hand.length, hand + 1, 'only the normal turn draw, no When KO\'d draw');
});

test('p.13: a [Field] stays in the Battle Area until another Field replaces it', () => {
  const s = fresh();
  mainOf(s, 0);
  const arena1 = spawn(s, 0, 'FB01-032', 'hand');
  const arena2 = spawn(s, 0, 'FB01-032', 'hand');
  energy(s, 0, 4);
  act(s, (a) => a.k === 'play' && a.uid === arena1);
  assert.equal(s.p[0].field, arena1);
  assert.ok(!s.p[0].drop.includes(arena1));
  act(s, (a) => a.k === 'play' && s.inst[a.uid].id === 'FB01-032' && a.uid !== arena1);
  assert.equal(s.p[0].field, arena2);
  assert.ok(s.p[0].drop.includes(arena1));
});

test('p.13: a [Field]\'s [Activate: Battle] skill is used from the Battle Area', () => {
  const s = fresh();
  mainOf(s, 0);
  s.p[1].hand = [];
  const arena = spawn(s, 0, 'FB01-032', 'field');
  act(s, (a) => a.k === 'attack' && a.uid === s.p[0].leader && a.target === s.p[1].leader);
  passTo(s, 'offCombo');
  const before = powerOf(s, s.p[0].leader);
  act(s, (a) => a.k === 'battleSkill' && a.uid === arena);
  assert.equal(s.inst[arena].rested, true);
  assert.equal(powerOf(s, s.p[0].leader), before + 5000);
});

test('p.12: Ki — "+1 Ki" places Ki on the Leader; "reduce Ki" pays a cost', () => {
  const s = fresh(GREEN, YELLOW);
  mainOf(s, 0);
  s.p[1].hand = [];
  const gp = spawn(s, 0, 'FB10-057', 'hand'); // On Play: Leader +1 Ki. When Attacking: reduce Ki 1 -> KO cost<=1
  energy(s, 0, 2);
  act(s, (a) => a.k === 'play' && a.uid === gp);
  assert.equal(s.inst[s.p[0].leader].ki, 1);
  const small = spawn(s, 1, 'FS04-10', 'battle'); // cost 1
  act(s, (a) => a.k === 'attack' && a.uid === gp && a.target === s.p[1].leader);
  assert.ok(s.p[1].drop.includes(small), 'KO\'d by the When Attacking skill');
  assert.equal(s.inst[s.p[0].leader].ki, 0, 'Ki was spent');
});

test('p.12: Ki on a Battle Card is lost when it leaves; Leader Ki survives Awaken', () => {
  const s = fresh();
  const u = spawn(s, 0, 'FS01-07', 'battle');
  s.inst[u].ki = 2;
  koCard(s, u, ctl);
  assert.equal(s.inst[u].ki, 0);
  s.inst[s.p[0].leader].ki = 3;
  s.p[0].awakened = true;
  assert.equal(s.inst[s.p[0].leader].ki, 3);
  moveTo(s, s.p[0].hand[0], 'drop');
});
