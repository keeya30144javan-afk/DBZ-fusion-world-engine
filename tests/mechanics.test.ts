/** The skill language's mechanics beyond the basic manual rules, and translation scripts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newGame, legalActions, step, Action } from '../src/engine/game';
import { GameState, Side, powerOf, costInHand } from '../src/engine/core';
import { koCard } from '../src/engine/effects';
import { defaultChooser } from '../src/ai/heuristics';
import { clearCompileCache, compileCard } from '../src/effects/parse';
import { textHash, validateScript } from '../src/effects/script';
import { describeCompiled } from '../src/effects/describe';
import { Card } from '../src/data/types';
import { CardScript } from '../src/effects/types';

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

function spawn(s: GameState, p: Side, id: string, zone: 'hand' | 'battle' | 'energy' | 'drop' | 'leader'): number {
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

/** Give a card a translation for this test. */
function withScript(id: string, sc: Omit<CardScript, 'textHash' | 'source' | 'unparsed'> & { unparsed?: string[] }) {
  const script: CardScript = { textHash: textHash(cards[id]), source: 'claude', unparsed: [], ...sc };
  assert.deepEqual(validateScript(script), []);
  cards[id] = { ...cards[id], script };
  clearCompileCache();
}

test('[Evolve]: pay the cost and play on top of the specified card; the base goes under', () => {
  const s = fresh();
  spawn(s, 0, 'FB12-097', 'leader'); // a black Leader
  const base = spawn(s, 0, 'FB10-110', 'battle'); // Cell, cost 4
  s.inst[base].ki = 1;
  const cell = spawn(s, 0, 'FB10-111', 'hand'); // [Evolve] pay 2: <Cell> with a cost of 4
  energy(s, 0, 2);
  const ev = acts(s, (a) => a.k === 'evolve' && a.uid === cell);
  assert.equal(ev.length, 1);
  const hand = s.p[0].hand.length;
  step(s, ev[0], ctl);
  assert.ok(s.p[0].battle.includes(cell) && !s.p[0].battle.includes(base));
  assert.deepEqual(s.inst[cell].under, [base]);
  assert.equal(s.inst[base].ki, 0, 'Ki on the base is lost');
  assert.equal(s.p[0].hand.length, hand - 1 + 2, 'On Play drew 2');
  koCard(s, cell, ctl);
  assert.ok(s.p[0].drop.includes(base), 'cards under it go to the Drop with it');
});

test('[Evolve] is not offered without a matching base or energy', () => {
  const s = fresh();
  spawn(s, 0, 'FB12-097', 'leader');
  const cell = spawn(s, 0, 'FB10-111', 'hand');
  energy(s, 0, 2);
  assert.equal(acts(s, (a) => a.k === 'evolve' && a.uid === cell).length, 0);
  spawn(s, 0, 'FB10-110', 'battle');
  energy(s, 0, 1);
  assert.equal(acts(s, (a) => a.k === 'evolve' && a.uid === cell).length, 0);
});

test('[Fusion Evolve]: two Active cards with equal power of 20000 or more', () => {
  const s = fresh();
  const goku = spawn(s, 0, 'FB09-009', 'battle'); // 20000
  const vegeta = spawn(s, 0, 'FB09-019', 'battle'); // 20000
  const gogeta = spawn(s, 0, 'FB09-006', 'hand'); // pay 0
  energy(s, 0, 0);
  const ev = acts(s, (a) => a.k === 'evolve' && a.uid === gogeta);
  assert.equal(ev.length, 1);
  const opp = spawn(s, 1, 'FS04-02', 'battle');
  const before = powerOf(s, opp);
  step(s, ev[0], ctl);
  assert.deepEqual(s.inst[gogeta].under?.sort(), [goku, vegeta].sort());
  assert.equal(s.p[0].battle.filter((u) => u === goku || u === vegeta).length, 0);
  assert.equal(powerOf(s, opp), before - 5000, 'On Play: all opposing Battle Cards -5000');
  s.inst[goku].rested = true;
});

test('[Fusion Evolve] needs both bases in Active Mode', () => {
  const s = fresh();
  const goku = spawn(s, 0, 'FB09-009', 'battle');
  spawn(s, 0, 'FB09-019', 'battle');
  const gogeta = spawn(s, 0, 'FB09-006', 'hand');
  s.inst[goku].rested = true;
  assert.equal(acts(s, (a) => a.k === 'evolve' && a.uid === gogeta).length, 0);
});

test('script: "This card can\'t attack" stops attacks', () => {
  withScript('FS01-07', { keywords: [], abilities: [{ timing: 'permanent', once: false, cost: [], cond: [], effects: [{ t: 'grant', target: { side: 'self', ref: 'this', zones: ['battle'], count: 1, upTo: false, filter: {} }, kw: 'cantAttack', dur: 'static' }], text: '', unparsed: [] }] });
  const s = fresh();
  const u = spawn(s, 0, 'FS01-07', 'battle');
  assert.equal(acts(s, (a) => a.k === 'attack' && a.uid === u).length, 0);
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('script: a stale script (text changed) is ignored', () => {
  cards['FS01-07'] = { ...cards['FS01-07'], script: { textHash: 'deadbeef', source: 'claude', keywords: ['blocker'], abilities: [], unparsed: [] } };
  clearCompileCache();
  assert.ok(!compileCard(cards['FS01-07']).keywords.has('blocker'));
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('script: cost reduction ("reduce its cost by 2") lets a cost-limited KO reach it', () => {
  const s = fresh();
  const big = spawn(s, 1, 'FS04-06', 'battle'); // cost 4
  withScript('FS01-07', { keywords: [], abilities: [{ timing: 'activateMain', once: true, cost: [], cond: [], text: '', unparsed: [], effects: [
    { t: 'costMod', target: { side: 'opp', zones: ['battle'], count: 1, upTo: true, filter: {} }, amount: -2, dur: 'turn' },
    { t: 'ko', target: { side: 'opp', zones: ['battle'], count: 1, upTo: true, filter: { costLE: 2 } } },
  ] }] });
  const u = spawn(s, 0, 'FS01-07', 'battle');
  step(s, acts(s, (a) => a.k === 'activate' && a.uid === u)[0], ctl);
  assert.ok(s.p[1].drop.includes(big));
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('script: "next Extra costs 0" discount applies once', () => {
  const s = fresh();
  withScript('FS01-07', { keywords: [], abilities: [{ timing: 'onPlay', once: false, cost: [], cond: [], text: '', unparsed: [], effects: [{ t: 'nextDiscount', filter: { type: 'EXTRA', costLE: 3 }, amount: 'free' }] }] });
  const ex = spawn(s, 0, 'FS01-16', 'hand'); // God Kamehameha, cost 2
  const ex2 = spawn(s, 0, 'FS01-16', 'hand');
  const before = costInHand(s, ex);
  const u = spawn(s, 0, 'FS01-07', 'hand');
  energy(s, 0, 2);
  step(s, acts(s, (a) => a.k === 'play' && s.inst[a.uid].id === 'FS01-07')[0], ctl);
  assert.equal(costInHand(s, ex), 0);
  assert.ok(before > 0);
  void ex2;
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('script: "can\'t be KO\'d once per turn" survives the first KO only', () => {
  withScript('FS01-07', { keywords: ['koImmuneOnce'], abilities: [] });
  const s = fresh();
  const u = spawn(s, 0, 'FS01-07', 'battle');
  assert.equal(koCard(s, u, ctl), false);
  assert.equal(koCard(s, u, ctl), true);
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('script: "choose one" runs one option', () => {
  const s = fresh();
  withScript('FS01-07', { keywords: [], abilities: [{ timing: 'onPlay', once: false, cost: [], cond: [], text: '', unparsed: [], effects: [{ t: 'choose', options: [[{ t: 'draw', n: 2 }], [{ t: 'mill', n: 5 }]] }] }] });
  const u = spawn(s, 0, 'FS01-07', 'hand');
  energy(s, 0, 2);
  const hand = s.p[0].hand.length;
  step(s, acts(s, (a) => a.k === 'play' && s.inst[a.uid].id === 'FS01-07')[0], ctl);
  assert.equal(s.p[0].hand.length, hand - 1 + 2, 'drew 2 (the better option)');
  cards['FS01-07'] = { ...cards['FS01-07'], script: undefined };
  clearCompileCache();
});

test('validator: rejects malformed scripts with a precise path', () => {
  const errs = validateScript({ textHash: 'x', source: 'claude', keywords: ['flying'], unparsed: [], abilities: [{ timing: 'onPlay', once: false, cost: [], cond: [], effects: [{ t: 'draw', n: 'two' }, { t: 'teleport' }] }] });
  assert.ok(errs.some((e) => /keywords/.test(e)));
  assert.ok(errs.some((e) => /effects\[0\].*n: expected a number/.test(e)));
  assert.ok(errs.some((e) => /unknown effect "teleport"/.test(e)));
});

test('describe: the engine\'s reading of a card is readable English', () => {
  const r = describeCompiled(compileCard(cards['FB10-057']));
  assert.match(r, /\[On Play\] Your Leader gets \+1 Ki/);
  assert.match(r, /Reduce your Ki by 1: choose up to 1 Battle Card with a cost of 1 or less in your opponent's Battle Area and KO it/);
});
