import { GameState, Side, cardOf, comboPowerOf, isLeader, other, powerOf } from '../engine/core';
import { compileCard } from '../effects/parse';
import { awakenLife, awakenedWorth, valueIn } from './heuristics';

/**
 * A learned position evaluation: a small neural network that reads ~50 numbers about a
 * position and predicts who wins. Trained on self-play (and people's games) outcomes, so it
 * can learn trade-offs the hand-set weights can't (a big hand matters more at low life, a
 * Super Combo in hand is worth more when the opponent is in Double Strike range...).
 */

const SIDE = [
  'life', 'logLife', 'hand', 'deck', 'drop', 'energy', 'activeEnergy', 'markers', 'awakened', 'awakenWorth', 'toAwaken',
  'leaderPower', 'bodies', 'activeBodies', 'boardPower', 'maxPower', 'boardValue', 'ki',
  'handCombo', 'superCombos', 'extras', 'castable', 'handValue',
] as const;
export const NET_INPUTS = [...SIDE.map((k) => `me.${k}`), ...SIDE.map((k) => `op.${k}`), 'turn', 'myTurn', 'wentFirst'];

const isSuper = (s: GameState, u: number) => compileCard(cardOf(s, u)).keywords.has('superCombo');

function sideVec(s: GameState, p: Side): number[] {
  const pl = s.p[p];
  const life = pl.life.length;
  const activeEnergy = pl.energy.filter((u) => !s.inst[u].rested).length;
  const at = awakenLife(s, p);
  const powers = pl.battle.map((u) => powerOf(s, u));
  let handCombo = 0, supers = 0, extras = 0, castable = 0, handValue = 0;
  for (const u of pl.hand) {
    const c = cardOf(s, u);
    handCombo += comboPowerOf(s, u) / 10000 + (isSuper(s, u) ? 1 : 0);
    if (isSuper(s, u)) supers++;
    if (c.type === 'EXTRA') extras++;
    if (c.cost <= pl.energy.length + 1) castable++;
    handValue += valueIn(s, u);
  }
  return [
    life, Math.log(1 + life), pl.hand.length, Math.min(pl.deck.length, 30) / 10, Math.min(pl.drop.length, 30) / 10,
    Math.min(pl.energy.length, 10), activeEnergy, Math.min(pl.markers, 2), pl.awakened ? 1 : 0,
    pl.awakened ? awakenedWorth(cardOf(s, pl.leader)) : 0, at === null || pl.awakened ? 0 : Math.max(0, life - at),
    powerOf(s, pl.leader) / 10000, pl.battle.length, pl.battle.filter((u) => !s.inst[u].rested).length,
    powers.reduce((a, b) => a + b, 0) / 10000, (powers.length ? Math.max(...powers) : 0) / 10000,
    pl.battle.reduce((a, u) => a + valueIn(s, u), 0), [pl.leader, ...pl.battle].reduce((a, u) => a + Math.min(s.inst[u].ki, 6), 0),
    handCombo, supers, extras, castable, handValue,
  ];
}

/** The network's input for `me`'s point of view. */
export function netInput(s: GameState, me: Side): number[] {
  return [...sideVec(s, me), ...sideVec(s, other(me)), Math.min(s.turn, 20) / 10, s.active === me ? 1 : 0, s.first === me ? 1 : 0];
}

export interface ValueNet {
  inputs: string[];
  mean: number[];
  std: number[];
  /** hidden x inputs */
  w1: number[][];
  b1: number[];
  w2: number[];
  b2: number;
  /** How many "cards" one unit of logit is worth, to blend with the hand-set evaluation. */
  scale: number;
}

/** The network's logit that `me` wins (0 = even). */
export function netLogit(net: ValueNet, s: GameState, me: Side): number {
  const x = netInput(s, me);
  let out = net.b2;
  for (let h = 0; h < net.w1.length; h++) {
    const row = net.w1[h];
    let z = net.b1[h];
    for (let i = 0; i < row.length; i++) z += row[i] * ((x[i] - net.mean[i]) / net.std[i]);
    out += net.w2[h] * Math.tanh(z);
  }
  return out;
}

export { isLeader };
