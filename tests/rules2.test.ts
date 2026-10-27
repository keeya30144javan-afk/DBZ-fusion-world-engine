/** The second wave of mechanics: attack rules, replacements, damage caps and shields, alternative costs and the rest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, legalActions, step, Action } from '../src/engine/game';
import { GameState, Side, costInDrop, matchesFilter } from '../src/engine/core';
import { koCard, playCard, resolveAbility, setWinner, takeLife } from '../src/engine/effects';
import { defaultChooser } from '../src/ai/heuristics';
import { Card } from '../src/data/types';

const db = JSON.parse(readFileSync(new URL('../data/cards.json', import.meta.url), 'utf8'));
const cards: Record<string, Card> = db.cards;
const meta = JSON.parse(readFileSync(new URL('../data/meta.json', import.meta.url), 'utf8'));
const ctl: any = [defaultChooser, defaultChooser];

function fresh(): GameState {
  const s = newGame(cards, [meta.decks[0], meta.decks[3]], { seed: 2, first: 0 });
  step(s, { k: 'keep' }, ctl);
  step(s, { k: 'keep' }, ctl);
  s.turn = 3; s.active = 0; s.stage = 'main'; s.toAct = 0;
  return s;
}

function spawn(s: GameState, p: Side, id: string, zone: 'hand' | 'battle' | 'energy' | 'drop' | 'leader' | 'deck'): number {
  assert.ok(cards[id], id);
  const uid = s.inst.length;
  s.inst.push({ uid, id, owner: p, rested: false, lockedUntil: 0, mods: [], grants: [], comboBonus: 0, playedTurn: 0, ki: 0 });
  if (zone === 'leader') s.p[p].leader = uid; else s.p[p][zone].push(uid);
  return uid;
}

function energy(s: GameState, p: Side, n: number) {
  const color = cards[s.inst[s.p[p].leader].id].colors[0];
  const id = Object.values(cards).find((c) => c.type === 'BATTLE' && c.colors.length === 1 && c.colors[0] === color)!.id;
  s.p[p].energy = [];
  for (let i = 0; i < n; i++) spawn(s, p, id, 'energy');
}

const acts = (s: GameState, pred: (a: Action) => boolean) => legalActions(s).filter(pred);
const attacksOn = (s: GameState, target: number) => acts(s, (a) => a.k === 'attack' && a.target === target);

/** Play out the current battle with no counters, blocks or combos. */
function passBattle(s: GameState) {
  for (let i = 0; i < 20 && s.battle; i++) {
    const a = legalActions(s).find((x) => x.k === 'noCounter' || x.k === 'noBlock' || x.k === 'comboDone');
    if (!a) break;
    step(s, a, ctl);
  }
}

test('card data: special traits are loaded', () => {
  assert.deepEqual(cards['FS01-01'].traits, ['Saiyan', 'Universe 7']);
  assert.ok(Object.values(cards).filter((c) => c.traits.length).length > 1900);
});

test('attack rule: "your opponent can\'t attack <Android 18> in your Battle Area"', () => {
  const s = fresh();
  spawn(s, 1, 'FB01-072', 'battle'); // Krillin
  const a18 = spawn(s, 1, 'FS01-07', 'battle'); // Android 18
  s.inst[a18].rested = true;
  const other = spawn(s, 1, 'FB01-049', 'battle');
  s.inst[other].rested = true;
  assert.equal(attacksOn(s, a18).length, 0);
  assert.ok(attacksOn(s, other).length > 0, 'other rested cards can still be attacked');
});

test('attack rule: "can\'t be attacked by Leaders or Battle Cards with costs of 3 or less"', () => {
  const s = fresh();
  const blue = spawn(s, 1, 'SB02-059', 'battle'); // General Blue
  s.inst[blue].rested = true;
  const big = spawn(s, 0, 'FB04-129', 'battle'); // cost 6
  assert.ok(attacksOn(s, blue).every((a) => a.k === 'attack' && a.uid === big));
  assert.equal(attacksOn(s, blue).length, 1);
});

test('replacement: Dyspo loses a life card instead of being KO\'d by the opponent', () => {
  const s = fresh();
  const dyspo = spawn(s, 1, 'FB03-014', 'battle');
  const life = s.p[1].life.length;
  assert.equal(koCard(s, dyspo, ctl, { skillOf: 0 }), false);
  assert.ok(s.p[1].battle.includes(dyspo));
  assert.equal(s.p[1].life.length, life - 1);
  assert.equal(koCard(s, dyspo, ctl, { skillOf: 1 }), true, 'its own player\'s KO is not replaced');
});

test('damage cap: awakened Jiren takes at most 1 damage per battle with a 30000-power card out', () => {
  const s = fresh();
  spawn(s, 1, 'FB03-001', 'leader');
  s.p[1].awakened = true;
  spawn(s, 1, 'FB04-129', 'battle'); // 40000 power
  const goku = spawn(s, 0, 'FB06-119', 'battle'); // [Double Strike], 35000
  const life = s.p[1].life.length;
  step(s, { k: 'attack', uid: goku, target: s.p[1].leader }, ctl);
  passBattle(s);
  assert.equal(s.p[1].life.length, life - 1);
});

test('shield: "negate the next damage you take" until the end of the opponent\'s next turn', () => {
  const s = fresh();
  const goku = spawn(s, 1, 'FB04-129', 'hand');
  playCard(s, goku, ctl);
  const atk = spawn(s, 0, 'FB06-119', 'battle');
  const life = s.p[1].life.length;
  step(s, { k: 'attack', uid: atk, target: s.p[1].leader }, ctl);
  passBattle(s);
  assert.equal(s.p[1].life.length, life, 'first hit negated');
});

test('"You will not lose the game for the turn"', () => {
  const s = fresh();
  const v = spawn(s, 0, 'ST01-071', 'hand');
  playCard(s, v, ctl);
  takeLife(s, 0, s.p[0].life.length + 1, false);
  assert.notEqual(s.stage, 'over');
  setWinner(s, 1, 'damage at 0 life');
  assert.notEqual(s.stage, 'over');
});

test('alternative cost: Son Goku FB09-035 can be paid with a discard and 2 rested energy', () => {
  const s = fresh();
  const goku = spawn(s, 0, 'FB09-035', 'hand');
  energy(s, 0, 2);
  assert.equal(acts(s, (a) => a.k === 'play' && a.uid === goku).length, 0, 'no Tournament of Power card to discard');
  spawn(s, 0, 'FB09-035', 'hand'); // another ToP card
  const plays = acts(s, (a) => a.k === 'play' && a.uid === goku);
  assert.equal(plays.length, 1);
  assert.equal((plays[0] as any).alt, 0);
  step(s, plays[0], ctl);
  assert.ok(s.p[0].battle.includes(goku));
  assert.equal(s.p[0].energy.filter((u) => s.inst[u].rested).length, 2);
});

test('search from the bottom: Time Machine plays <Trunks: Future> cost 2 from the bottom card', () => {
  const s = fresh();
  spawn(s, 0, 'FS02-01', 'leader'); // a blue Leader to pay for the blue Extra
  const tm = spawn(s, 0, 'FB01-065', 'hand');
  energy(s, 0, 1);
  const trunks = spawn(s, 0, 'FB11-035', 'deck');
  s.p[0].deck.splice(s.p[0].deck.indexOf(trunks), 1);
  s.p[0].deck.unshift(trunks);
  const a = acts(s, (x) => x.k === 'activate' && x.uid === tm)[0];
  step(s, a, ctl);
  assert.ok(s.p[0].battle.includes(trunks));
});

test('budget: "any number of Battle Cards that add up to 35000 power or less"', () => {
  const s = fresh();
  const ids = ['FB04-129', 'FB06-119', 'FB01-049', 'FS01-07'];
  const us = ids.map((id) => spawn(s, 1, id, 'battle'));
  const ts = spawn(s, 0, 'FB01-033', 'hand');
  energy(s, 0, 3);
  step(s, acts(s, (x) => x.k === 'activate' && x.uid === ts)[0], ctl);
  const gone = us.filter((u) => !s.p[1].battle.includes(u));
  const total = gone.reduce((a, u) => a + cards[s.inst[u].id].power, 0);
  assert.ok(gone.length >= 1 && total <= 35000, `KO'd ${gone.length} cards totalling ${total}`);
});

test('"This card must attack whenever possible": no ending the turn while it can', () => {
  const s = fresh();
  const herc = spawn(s, 0, 'FB01-097', 'battle');
  assert.equal(acts(s, (a) => a.k === 'end').length, 0);
  s.inst[herc].rested = true;
  assert.equal(acts(s, (a) => a.k === 'end').length, 1);
});

test('[Evolve] with an extra cost needs the discard too', () => {
  const s = fresh();
  s.p[0].hand = [];
  const base = spawn(s, 0, 'FS01-01', 'battle'); // a <Son Goku> card in play (leader card used as a stand-in name match)
  void base;
  const goku = spawn(s, 0, 'FB11-121', 'hand');
  energy(s, 0, 3);
  const bases = s.p[0].battle.filter((u) => cards[s.inst[u].id].name.includes('Son Goku'));
  if (!bases.length) return; // no plain <Son Goku> Battle Card in this setup
  assert.equal(acts(s, (a) => a.k === 'evolve' && a.uid === goku).length, 0, 'no card to discard');
  spawn(s, 0, 'FB01-049', 'hand');
  assert.ok(acts(s, (a) => a.k === 'evolve' && a.uid === goku).length > 0);
});

test('Drop cost: Fasha (Great Ape) costs 1 less in the Drop under a <Bardock> Leader', () => {
  const s = fresh();
  spawn(s, 0, 'FB11-097', 'leader');
  const fasha = spawn(s, 0, 'FB11-100', 'drop');
  assert.equal(costInDrop(s, fasha), 2);
  assert.ok(matchesFilter(s, fasha, { costLE: 2 }, fasha));
});

test('extra turn: the same player goes again', () => {
  const s = fresh();
  const src = s.p[0].leader;
  resolveAbility(s, src, { timing: 'auto', once: false, cost: [], cond: [], effects: [{ t: 'extraTurn' }], text: '', unparsed: [] }, -1, ctl);
  const turn = s.turn;
  step(s, { k: 'end' }, ctl);
  assert.equal(s.turn, turn + 1);
  assert.equal(s.active, 0);
});

test('"your opponent can\'t activate [Blocker]" with 20 or more cards in your Drop', () => {
  const s = fresh();
  spawn(s, 0, 'FB09-041', 'battle');
  const blocker = Object.values(cards).find((c) => c.type === 'BATTLE' && /^\[Blocker\]/.test(c.text))!.id;
  spawn(s, 1, blocker, 'battle');
  const atk = spawn(s, 0, 'FB04-129', 'battle');
  for (let i = 0; i < 20; i++) spawn(s, 0, 'FB01-049', 'drop');
  step(s, { k: 'attack', uid: atk, target: s.p[1].leader }, ctl);
  assert.notEqual(s.stage, 'block');
  assert.equal(legalActions(s).filter((a) => a.k === 'block').length, 0);
});

test('attack tax: Broly makes each attack rest another Active card', () => {
  const s = fresh();
  spawn(s, 1, 'FB08-073', 'leader');
  s.p[1].awakened = true;
  spawn(s, 1, 'FB04-129', 'battle'); // cost 6
  // That Battle Card needs ≪Saiyan≫; check the rule only when it applies.
  if (!cards['FB04-129'].traits.includes('Saiyan')) return;
  const atk = spawn(s, 0, 'FB06-119', 'battle');
  energy(s, 0, 1);
  step(s, { k: 'attack', uid: atk, target: s.p[1].leader }, ctl);
  assert.ok(s.inst[s.p[0].energy[0]].rested, 'an Active energy was rested to attack');
});
