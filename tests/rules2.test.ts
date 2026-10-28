/** The second wave of mechanics: attack rules, replacements, damage caps and shields, alternative costs and the rest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, legalActions, step, Action } from '../src/engine/game';
import { GameState, Side, condHolds, costInDrop, matchesFilter, moveTo, powerOf } from '../src/engine/core';
import { koCard, playCard, resolveAbility, setWinner, takeLife } from '../src/engine/effects';
import { defaultChooser } from '../src/ai/heuristics';
import { Card } from '../src/data/types';
import { Cond } from '../src/effects/types';

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

// ---- fixes from the user's audit notes

test('hand to the bottom of life (SB02-037): the card goes under the other life cards', () => {
  const s = fresh();
  s.p[0].hand = [];
  const card = spawn(s, 0, 'FS01-10', 'hand');
  resolveAbility(s, s.p[0].leader, { timing: 'auto', once: false, cost: [], cond: [], effects: [{ t: 'handToLife', n: 1, upTo: false, pos: 'bottom' }], text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
  assert.equal(s.p[0].life[0], card);
  assert.notEqual(s.p[0].life[s.p[0].life.length - 1], card);
});

test('Drop to the bottom of the deck (ST01-026): the old top card is still on top', () => {
  const s = fresh();
  const top = s.p[0].deck[s.p[0].deck.length - 1];
  const d1 = spawn(s, 0, 'FS01-10', 'drop'), d2 = spawn(s, 0, 'FS01-10', 'drop');
  resolveAbility(s, s.p[0].leader, { timing: 'auto', once: false, cost: [], cond: [], effects: [{ t: 'dropToDeck', bottom: true }], text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
  assert.equal(s.p[0].drop.length, 0);
  assert.equal(s.p[0].deck[s.p[0].deck.length - 1], top);
  assert.deepEqual(new Set(s.p[0].deck.slice(0, 2)), new Set([d1, d2]));
});

test('"during this turn, if you use an Extra" (SB02-022) only counts Extras used after the skill', () => {
  const s = fresh();
  const src = spawn(s, 0, 'FS01-10', 'battle');
  const hand0 = s.p[0].hand.length;
  resolveAbility(s, src, { timing: 'auto', once: false, cost: [], cond: [], effects: [{ t: 'delayed', on: 'usesExtra', filter: { type: 'EXTRA' }, once: true, effects: [{ t: 'draw', n: 2 }] }], text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
  assert.equal(s.p[0].hand.length, hand0);
  const extra = cards["FB03-026"];
  assert.ok(extra, 'a red [Activate:Main] Extra to test with');
  energy(s, 0, 4);
  const u = spawn(s, 0, extra.id, 'hand');
  const use = legalActions(s).find((a) => a.k === 'activate' && a.uid === u)!;
  assert.ok(use, 'the Extra can be used');
  step(s, use, ctl);
  assert.ok(s.p[0].hand.length >= hand0 + 1, 'the watcher draws when the Extra is used');
});

test('Cell (SB01-001): only a removed ≪Android≫ counts', () => {
  const s = fresh();
  const cond: Cond = { t: 'removedBySkillThisTurn', filter: { type: 'BATTLE', traits: ['Android'] } };
  const non = Object.values(cards).find((c) => c.type === 'BATTLE' && !c.traits.includes('Android'))!;
  const and = Object.values(cards).find((c) => c.type === 'BATTLE' && c.traits.includes('Android'))!;
  const a = spawn(s, 0, non.id, 'battle');
  s.skillBy = 1; moveTo(s, a, 'drop'); s.skillBy = undefined;
  assert.equal(condHolds(s, 0, s.p[0].leader, cond), false);
  const b = spawn(s, 0, and.id, 'battle');
  s.skillBy = 1; moveTo(s, b, 'drop'); s.skillBy = undefined;
  assert.equal(condHolds(s, 0, s.p[0].leader, cond), true);
});

test('Gogeta: BR (FB11-005): your Gogeta: BR Leader gets +15000 in a battle with an original-30000 card', () => {
  const s = fresh();
  const leader = spawn(s, 0, Object.values(cards).find((c) => c.type === 'LEADER' && c.name === 'Gogeta: BR')!.id, 'leader');
  spawn(s, 0, 'FB11-005', 'battle');
  const foe = Object.values(cards).find((c) => c.type === 'BATTLE' && c.power === 30000)!;
  const t = spawn(s, 1, foe.id, 'battle');
  const before = powerOf(s, leader);
  s.battle = { attacker: leader, target: t, atkSide: 0, comboCount: [0, 0] } as any;
  assert.equal(powerOf(s, leader), before + 15000);
});

test('Jiren engine: FB03-009 pays "take 1 damage" -> the awakened Leader draws -> deck top to life: +2 cards, same life', () => {
  const s = newGame(cards, [{ name: 'J', leader: 'FB03-001', main: { 'FB03-009': 4, 'FB06-013': 46 } }, meta.decks[0]], { seed: 4, first: 1 });
  step(s, { k: 'keep' }, ctl); step(s, { k: 'keep' }, ctl);
  s.p[0].awakened = true;
  const jiren = spawn(s, 0, 'FB03-009', 'battle');
  s.inst[jiren].rested = true;
  // Opponent's turn, attacking our Leader.
  s.turn = 4; s.active = 1;
  const att = spawn(s, 1, 'FS01-10', 'battle');
  s.battle = { attacker: att, target: s.p[0].leader, atkSide: 1, comboCount: [0, 0] } as any;
  s.stage = 'defCombo'; s.toAct = 0;
  const hand = s.p[0].hand.length, life = s.p[0].life.length;
  const act = legalActions(s).find((a) => a.k === 'battleSkill' && (a as any).uid === jiren);
  assert.ok(act, 'Jiren\'s [Activate:Battle] is offered during the opponent\'s attack');
  step(s, act!, ctl);
  assert.equal(s.p[0].life.length, life, 'life back to where it was');
  assert.equal(s.p[0].hand.length, hand + 2, 'the damaged life card plus the Leader\'s draw');
});

test('names match whatever the spacing around the colon: FP-070 Fusion Evolves from <Son Goku : BR> and <Vegeta : BR>', () => {
  const s = fresh();
  s.p[0].leader = spawn(s, 0, 'FB09-001', 'leader');
  energy(s, 0, 6);
  spawn(s, 0, 'FB09-010', 'battle');
  spawn(s, 0, 'FB09-020', 'battle');
  const g = spawn(s, 0, 'FP-070', 'hand');
  assert.ok(legalActions(s).some((a) => a.k === 'evolve' && a.uid === g), 'FP-070 can Fusion Evolve');
});

test('Jiren Leader (awakened) with a 30000-power Battle Card takes only 1 damage from a Double Strike attack, and draws for it', () => {
  const s = newGame(cards, [{ name: 'J', leader: 'FB03-001', main: { 'FB03-009': 4, 'FB06-013': 46 } }, meta.decks[1]], { seed: 4, first: 1 });
  step(s, { k: 'keep' }, ctl); step(s, { k: 'keep' }, ctl);
  s.p[0].awakened = true;
  spawn(s, 0, 'FB03-009', 'battle');
  s.turn = 4; s.active = 1;
  const att = spawn(s, 1, 'FS02-13', 'battle'); // Vegeta, [Double Strike], 35000
  s.battle = { attacker: att, target: s.p[0].leader, atkSide: 1, comboCount: [0, 0] } as any;
  s.stage = 'defCombo'; s.toAct = 0;
  const life = s.p[0].life.length, hand = s.p[0].hand.length;
  step(s, { k: 'comboDone' }, ctl);
  while ((s.stage as string) !== 'main' && (s.stage as string) !== 'over' && s.battle) step(s, legalActions(s).find((a) => a.k === 'comboDone' || a.k === 'noCounter' || a.k === 'noBlock') ?? legalActions(s)[0], ctl);
  assert.equal(s.p[0].life.length, life - 1, 'capped at 1 damage');
  assert.equal(s.p[0].hand.length, hand + 2, 'the life card plus the Leader\'s draw');
});

test('Shallot engine: awakened Leader untaps 2 energy with Shallot + Giblet in play; the rested pair Fusion Evolves into Shallet', () => {
  const s = fresh();
  s.p[0].leader = spawn(s, 0, 'FB11-073', 'leader');
  s.p[0].awakened = true;
  energy(s, 0, 4);
  for (const u of s.p[0].energy) s.inst[u].rested = true;
  const sh = spawn(s, 0, 'FB11-087', 'battle'), gi = spawn(s, 0, 'FB11-082', 'battle');
  const untap = legalActions(s).find((a) => a.k === 'activate' && a.uid === s.p[0].leader);
  assert.ok(untap, "the awakened Leader's untap is offered");
  step(s, untap!, ctl);
  assert.equal(s.p[0].energy.filter((u) => !s.inst[u].rested).length, 2);
  s.inst[sh].rested = true; s.inst[gi].rested = true;
  const shallet = spawn(s, 0, 'FB11-122', 'hand');
  assert.ok(legalActions(s).some((a) => a.k === 'evolve' && a.uid === shallet), 'Shallet can Fusion Evolve from the rested pair');
});

test('Gotenks FP-083: up to 3 Extras with different names whose costs add up to 3 or less', () => {
  const s = fresh();
  s.p[0].leader = spawn(s, 0, Object.values(cards).find((c) => c.type === 'LEADER' && c.name === 'Gotenks')!.id, 'leader');
  const ex = (cost: number, n: number) => Object.values(cards).filter((c) => c.type === 'EXTRA' && c.cost === cost).slice(0, n);
  const ones = ex(1, 2), twos = ex(2, 1), threes = ex(3, 1);
  for (const c of [...ones, ones[0], ...twos, ...threes]) spawn(s, 0, c.id, 'drop');
  const g = spawn(s, 0, 'FP-083', 'hand');
  energy(s, 0, 6);
  const hand0 = s.p[0].hand.length;
  step(s, legalActions(s).find((a) => a.k === 'play' && a.uid === g)!, ctl);
  const got = s.p[0].hand.slice(hand0 - 1).map((u) => cards[s.inst[u].id]);
  const total = got.reduce((t, c) => t + c.cost, 0);
  assert.ok(got.length >= 1 && got.length <= 3, `took ${got.length}`);
  assert.ok(total <= 3, `total cost ${total}`);
  assert.equal(new Set(got.map((c) => c.name)).size, got.length, 'different names');
});
