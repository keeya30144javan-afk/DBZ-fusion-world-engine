import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { expandDeck } from '../data/decks';
import {
  GameState, Inst, PlayerState, Side, abilitiesOf, activeEnergy, cardOf, compiledOf, comboPowerOf, condsHold, costInHand, consumeDiscount, playBanned,
  emit, hasKeyword, isLeader, log, matchesFilter, moveTo, resetInst, nameOf, other, payPlan, planPayment, powerOf, shuffle, specFor,
} from './core';
import { Choosers, afterPlayed, isFreeRepeatable, canPayCosts, checkZeroPower, drawCards, placeField, fireTriggers, koCard, onceKey, playCard, resolveAbility, setWinner, takeLife } from './effects';

export type Action =
  | { k: 'keep' }
  | { k: 'mulligan' }
  | { k: 'charge'; uid: number }
  | { k: 'noCharge' }
  | { k: 'play'; uid: number }
  | { k: 'evolve'; uid: number; bases: number[] }
  | { k: 'activate'; uid: number; ab: number }
  | { k: 'awaken' }
  | { k: 'attack'; uid: number; target: number }
  | { k: 'end' }
  | { k: 'counter'; uid: number; ab: number }
  | { k: 'noCounter' }
  | { k: 'block'; uid: number }
  | { k: 'noBlock' }
  | { k: 'combo'; uid: number }
  | { k: 'battleSkill'; uid: number; ab: number }
  | { k: 'comboDone' };

export interface NewGameOpts {
  seed?: number;
  rules?: RulesConfig;
  first?: Side;
  log?: boolean;
  events?: boolean;
}

// ------------------------------------------------------------------ setup

export function newGame(cards: Record<string, Card>, decks: [Decklist, Decklist], opts: NewGameOpts = {}): GameState {
  const inst: Inst[] = [];
  const mk = (id: string, owner: Side): number => {
    const uid = inst.length;
    inst.push({ uid, id, owner, rested: false, lockedUntil: 0, mods: [], grants: [], comboBonus: 0, playedTurn: 0, ki: 0 });
    return uid;
  };
  const players = ([0, 1] as Side[]).map((side): PlayerState => {
    const d = decks[side];
    const leader = mk(d.leader, side);
    return {
      leader, awakened: false,
      deck: expandDeck(d).map((id) => mk(id, side)),
      hand: [], battle: [], energy: [], drop: [], life: [], combo: [], field: null,
      markers: 0, usedOnce: [], mulliganed: false,
    };
  }) as [PlayerState, PlayerState];
  const s: GameState = {
    rules: opts.rules ?? DEFAULT_RULES,
    cards,
    inst,
    p: players,
    turn: 0,
    active: 0,
    first: 0,
    stage: 'mulligan',
    toAct: 0,
    battle: null,
    winner: -1,
    reason: '',
    seed: (opts.seed ?? (Math.random() * 2 ** 31)) | 0,
    charged: false,
    mulliganTurn: 0,
    log: opts.log ? [] : null,
    events: opts.events ? [] : null,
  };
  s.first = opts.first ?? (Math.floor(Math.random() * 2) as Side);
  if (opts.first === undefined && opts.seed !== undefined) s.first = (Math.abs(opts.seed) % 2) as Side;
  for (const side of [0, 1] as Side[]) {
    shuffle(s, s.p[side].deck);
    drawCards(s, side, s.rules.handSize);
  }
  s.stage = 'mulligan';
  s.mulliganTurn = s.first;
  s.toAct = s.first;
  return s;
}

function finishSetup(s: GameState) {
  for (const side of [0, 1] as Side[]) {
    const p = s.p[side];
    for (let i = 0; i < s.rules.lifeCount; i++) {
      const u = p.deck.pop();
      if (u !== undefined) p.life.push(u);
    }
  }
  s.p[other(s.first)].markers = 1;
  // "When this card is placed in your Leader Area" skills.
  for (const side of [s.first, other(s.first)] as Side[]) fireTriggers(s, s.p[side].leader, 'gameStart', NO_CHOICE);
  s.active = other(s.first);
  startTurn(s);
}

// ------------------------------------------------------------------ turn flow

function startTurn(s: GameState) {
  s.turn += 1;
  s.active = s.turn === 1 ? s.first : other(s.active);
  if (s.turn > s.rules.maxTurns) { setWinner(s, -1, 'turn limit'); return; }
  const p = s.p[s.active];
  s.p[0].usedOnce = [];
  s.p[1].usedOnce = [];
  s.charged = false;
  emit(s, { t: 'turn', turn: s.turn, active: s.active });
  log(s, `--- Turn ${s.turn}: P${s.active} (${nameOf(s, p.leader)})`);
  for (const u of [p.leader, ...p.battle, ...p.energy, ...(p.field !== null ? [p.field] : [])]) {
    if (s.inst[u].lockedUntil >= s.turn) continue;
    s.inst[u].rested = false;
  }
  if (s.turn !== 1 || s.rules.firstPlayerDraws) drawCards(s, s.active, 1);
  if (s.stage === 'over') return;
  s.stage = 'charge';
  s.toAct = s.active;
}

function endTurn(s: GameState, ctl: Choosers) {
  const p = s.p[s.active];
  emit(s, { t: 'end', p: s.active, unspent: activeEnergy(s, s.active).length, handSize: p.hand.length });
  for (const u of skillSources(p)) {
    if (s.stage === 'over') return;
    fireTriggers(s, u, 'endOfYourTurn', ctl);
  }
  // "At the end of the turn" effects queued this turn.
  for (const side of [s.active, other(s.active)] as Side[]) {
    const pend = s.p[side].atEnd ?? [];
    s.p[side].atEnd = undefined;
    for (const job of pend) {
      if (s.stage === 'over') return;
      resolveAbility(s, job.src, { timing: 'auto', once: false, cost: [], cond: [], effects: job.effects, text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
    }
  }
  // Expire "for the turn" effects that end now.
  for (const i of s.inst) {
    if (i.mods.length) i.mods = i.mods.filter((m) => m.until !== 'battle' && m.until > s.turn);
    if (i.grants.length) i.grants = i.grants.filter((g) => g.until !== 'battle' && g.until > s.turn);
  }
  checkZeroPower(s, ctl);
  if (s.stage === 'over') return;
  startTurn(s);
}

// ------------------------------------------------------------------ legality helpers

export function playCostPlan(s: GameState, uid: number) {
  const total = costInHand(s, uid);
  return planPayment(s, s.inst[uid].owner, total, specFor(s, uid, total));
}

const isField = (s: GameState, uid: number) => compiledOf(s, uid).keywords.has('field');

/** [Your Turn] / [Opponent's Turn] restrict when a skill may be used (manual p.13). */
const turnOk = (s: GameState, side: Side, turn: 'your' | 'opp' | undefined) =>
  !turn || (turn === 'your') === (s.active === side);

/** Cards on the field whose skills can be activated: Leader, Battle Cards and a [Field]. */
const skillSources = (me: PlayerState) => [me.leader, ...me.battle, ...(me.field !== null ? [me.field] : [])];

/** "You can't activate the [Activate:Main] of <X> for the turn." */
function skillLocked(s: GameState, side: Side, uid: number, timing: 'activateMain' | 'activateBattle'): boolean {
  return (s.p[side].mods ?? []).some((m) => m.kind === 'skillLock' && m.timing === timing && m.until >= s.turn && matchesFilter(s, uid, m.filter, uid));
}

/** Awaken can be used at Activate: Main and Activate: Battle timings (manual p.9, p.12). */
function awakenOption(s: GameState, side: Side): Action[] {
  const me = s.p[side];
  if (me.awakened) return [];
  const aw = abilitiesOf(s, me.leader).find((a) => a.timing === 'awaken');
  return aw && condsHold(s, side, me.leader, aw.cond) ? [{ k: 'awaken' }] : [];
}

/** Game-start skills run before anyone acts; they take the first legal options. */
const firstPick = { choose: (_s: GameState, req: { options: number[]; max: number; min: number }) => req.options.slice(0, req.max) };
const NO_CHOICE: Choosers = [firstPick, firstPick];

/** [Evolve] / [Fusion Evolve]: pay the skill cost and play on top of the specified card(s). */
export function evolveOptions(s: GameState, uid: number): Action[] {
  const ev = compiledOf(s, uid).evolve;
  if (!ev) return [];
  const side = s.inst[uid].owner;
  const me = s.p[side];
  const color = cardOf(s, uid).colors[0];
  if (!planPayment(s, side, ev.cost, ev.cost > 0 && color ? { [color]: ev.cost } : {})) return [];
  const out: Action[] = [];
  const fits = (u: number, i: number) => matchesFilter(s, u, ev.from[i], uid) || (i === 0 && ev.from.length === 1 && (ev.orFrom ?? []).some((f) => matchesFilter(s, u, f, uid)));
  // Fusion Evolve plays on cards in Active Mode unless the card says otherwise (FB09-006 reminder text).
  const modeOk = (u: number) => (ev.baseMode ?? 'active') === 'rested' ? s.inst[u].rested : !s.inst[u].rested;
  if (ev.from.length === 1) {
    for (const b of me.battle) if (b !== uid && fits(b, 0)) out.push({ k: 'evolve', uid, bases: [b] });
  } else {
    for (const a of me.battle) {
      if (!modeOk(a) || !fits(a, 0)) continue;
      for (const b of me.battle) {
        if (b === a || !modeOk(b) || !fits(b, 1)) continue;
        const pa = powerOf(s, a), pb = powerOf(s, b);
        if (pa !== pb || (ev.equalPowerGE !== undefined && pa < ev.equalPowerGE)) continue;
        out.push({ k: 'evolve', uid, bases: [a, b] });
      }
    }
  }
  return out.slice(0, 4);
}

function doEvolve(s: GameState, uid: number, bases: number[], ctl: Choosers) {
  const ev = compiledOf(s, uid).evolve!;
  const side = s.inst[uid].owner;
  const me = s.p[side];
  const color = cardOf(s, uid).colors[0];
  const plan = planPayment(s, side, ev.cost, ev.cost > 0 && color ? { [color]: ev.cost } : {});
  if (!plan || bases.some((b) => !me.battle.includes(b))) return;
  payPlan(s, side, plan);
  const rested = s.rules.evolveKeepsMode && bases.some((b) => s.inst[b].rested);
  const at = me.battle.indexOf(bases[0]);
  const under: number[] = [];
  for (const b of bases) {
    under.push(...(s.inst[b].under ?? []), b);
    s.inst[b].under = undefined;
    me.battle.splice(me.battle.indexOf(b), 1);
    resetInst(s.inst[b]);
  }
  me.hand.splice(me.hand.indexOf(uid), 1);
  resetInst(s.inst[uid]);
  s.inst[uid].rested = rested;
  s.inst[uid].under = under;
  s.inst[uid].playedTurn = s.turn;
  me.battle.splice(Math.min(at, me.battle.length), 0, uid);
  log(s, `P${side} evolves ${bases.map((b) => nameOf(s, b)).join(' + ')} into ${nameOf(s, uid)}`);
  emit(s, { t: 'play', p: side, id: s.inst[uid].id, uid });
  afterPlayed(s, uid, ctl);
}

function canAttack(s: GameState, uid: number): boolean {
  if (s.turn === 1) return false;
  const inst = s.inst[uid];
  if (inst.rested) return false;
  if (hasKeyword(s, uid, 'cantAttack')) return false;
  if (!isLeader(s, uid) && !s.rules.attackOnPlayTurn && inst.playedTurn === s.turn) return false;
  return true;
}

function battleSkillOptions(s: GameState, side: Side): Action[] {
  const out: Action[] = [];
  const me = s.p[side];
  for (const u of skillSources(me)) {
    abilitiesOf(s, u).forEach((ab, i) => {
      if (ab.timing !== 'activateBattle' || !turnOk(s, side, ab.turn)) return;
      if ((ab.once || isFreeRepeatable(ab)) && me.usedOnce.includes(onceKey(s, u, i))) return;
      if (!condsHold(s, side, u, ab.cond) || !canPayCosts(s, u, ab.cost)) return;
      out.push({ k: 'battleSkill', uid: u, ab: i });
    });
  }
  const seen = new Set<string>();
  for (const u of me.hand) {
    const card = cardOf(s, u);
    if (card.type !== 'EXTRA' || seen.has(card.id) || isField(s, u)) continue;
    compiledOf(s, u).abilities.forEach((ab, i) => {
      if (ab.timing !== 'activateBattle' || !turnOk(s, side, ab.turn)) return;
      if (!condsHold(s, side, u, ab.cond) || !playCostPlan(s, u) || !canPayCosts(s, u, ab.cost, u)) return;
      seen.add(card.id);
      out.push({ k: 'battleSkill', uid: u, ab: i });
    });
  }
  return out;
}

function comboOptions(s: GameState, side: Side): Action[] {
  const b = s.battle!;
  const limit = s.rules.comboLimit;
  if (limit > 0 && b.comboCount[side] >= limit) return [];
  const out: Action[] = [];
  const me = s.p[side];
  const seen = new Set<string>();
  for (const u of me.hand) {
    const card = cardOf(s, u);
    if (seen.has(card.id)) continue;
    const boosts = compiledOf(s, u).abilities.some((a) => a.timing === 'comboFromHand');
    if (card.comboPower <= 0 && !boosts) continue;
    seen.add(card.id);
    out.push({ k: 'combo', uid: u });
  }
  for (const u of me.battle) {
    if (s.inst[u].rested || u === b.attacker || u === b.target) continue;
    if (comboPowerOf(s, u) <= 0) continue;
    out.push({ k: 'combo', uid: u });
  }
  return out;
}

function counterOptions(s: GameState, side: Side): Action[] {
  const out: Action[] = [];
  const seen = new Set<string>();
  for (const u of s.p[side].hand) {
    const card = cardOf(s, u);
    if (seen.has(card.id)) continue;
    compiledOf(s, u).abilities.forEach((ab, i) => {
      if (ab.timing !== 'counter') return;
      if (!condsHold(s, side, u, ab.cond) || !playCostPlan(s, u) || !canPayCosts(s, u, ab.cost, u)) return;
      seen.add(card.id);
      out.push({ k: 'counter', uid: u, ab: i });
    });
  }
  return out;
}

function blockerOptions(s: GameState, side: Side): Action[] {
  const b = s.battle!;
  if (b.cantBlock || b.blocked) return [];
  return s.p[side].battle
    .filter((u) => u !== b.target && !s.inst[u].rested && hasKeyword(s, u, 'blocker') && !hasKeyword(s, u, 'cantBlock'))
    .map((u) => ({ k: 'block', uid: u }) as Action);
}

// ------------------------------------------------------------------ legal actions

export function legalActions(s: GameState): Action[] {
  const side = s.toAct;
  const me = s.p[side];
  switch (s.stage) {
    case 'over': return [];
    case 'mulligan': return [{ k: 'keep' }, { k: 'mulligan' }];
    case 'charge': {
      const out: Action[] = [{ k: 'noCharge' }];
      const seen = new Set<string>();
      for (const u of me.hand) {
        const id = s.inst[u].id;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ k: 'charge', uid: u });
      }
      return out;
    }
    case 'main': {
      const out: Action[] = [];
      const seen = new Set<string>();
      for (const u of me.hand) {
        const card = cardOf(s, u);
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        if (playBanned(s, u)) continue;
        if (card.type === 'BATTLE' && playCostPlan(s, u)) out.push({ k: 'play', uid: u });
        if (card.type === 'BATTLE') out.push(...evolveOptions(s, u));
        if (card.type === 'EXTRA' && isField(s, u)) { if (!playBanned(s, u) && playCostPlan(s, u)) out.push({ k: 'play', uid: u }); }
        else if (card.type === 'EXTRA') {
          compiledOf(s, u).abilities.forEach((ab, i) => {
            if (ab.timing !== 'activateMain' || !turnOk(s, side, ab.turn)) return;
            if (condsHold(s, side, u, ab.cond) && playCostPlan(s, u) && canPayCosts(s, u, ab.cost, u)) out.push({ k: 'activate', uid: u, ab: i });
          });
        }
      }
      for (const u of skillSources(me)) {
        if (skillLocked(s, side, u, 'activateMain')) continue;
        abilitiesOf(s, u).forEach((ab, i) => {
          if (ab.timing !== 'activateMain' || !turnOk(s, side, ab.turn)) return;
          if ((ab.once || isFreeRepeatable(ab)) && me.usedOnce.includes(onceKey(s, u, i))) return;
          if (ab.effects.length === 0) return;
          if (condsHold(s, side, u, ab.cond) && canPayCosts(s, u, ab.cost)) out.push({ k: 'activate', uid: u, ab: i });
        });
      }
      out.push(...awakenOption(s, side));
      const opp = s.p[other(side)];
      for (const a of [me.leader, ...me.battle]) {
        if (!canAttack(s, a)) continue;
        const anyMode = hasKeyword(s, a, 'attackActive');
        if (!hasKeyword(s, a, 'cantAttackLeader')) out.push({ k: 'attack', uid: a, target: opp.leader });
        for (const t of opp.battle) if (s.inst[t].rested || anyMode) out.push({ k: 'attack', uid: a, target: t });
      }
      out.push({ k: 'end' });
      return out;
    }
    case 'counter': return [{ k: 'noCounter' }, ...counterOptions(s, side)];
    case 'block': return [{ k: 'noBlock' }, ...blockerOptions(s, side)];
    case 'offCombo':
    case 'defCombo':
      return [{ k: 'comboDone' }, ...comboOptions(s, side), ...battleSkillOptions(s, side), ...awakenOption(s, side)];
  }
}

// ------------------------------------------------------------------ battle

function declareAttack(s: GameState, attacker: number, target: number, ctl: Choosers) {
  const side = s.active;
  s.inst[attacker].rested = true;
  s.inst[attacker].attackedTurn = s.turn;
  s.battle = { attacker, atkSide: side, target, blocked: false, cantBlock: false, comboCount: [0, 0] };
  log(s, `P${side} attacks with ${nameOf(s, attacker)} (${powerOf(s, attacker)}) -> ${nameOf(s, target)} (${powerOf(s, target)})`);
  emit(s, { t: 'attack', p: side, attacker, target });
  fireTriggers(s, attacker, 'whenAttacking', ctl);
  if (s.stage === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  const def = other(side);
  for (const u of [s.p[def].leader, ...s.p[def].battle]) {
    if ((s.stage as string) === 'over' || !battleStillValid(s)) break;
    fireTriggers(s, u, 'whenOppAttacks', ctl);
  }
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  fireTriggers(s, s.battle!.target, 'whenAttacked', ctl);
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  advanceBattle(s, 'counter', ctl);
}

function battleStillValid(s: GameState): boolean {
  const b = s.battle;
  if (!b) return false;
  const inPlay = (u: number) => isLeader(s, u) || s.p[s.inst[u].owner].battle.includes(u);
  return inPlay(b.attacker) && inPlay(b.target);
}

/** Move to the next battle step that actually offers a choice. */
function advanceBattle(s: GameState, from: 'counter' | 'block' | 'offCombo' | 'defCombo' | 'damage', ctl: Choosers) {
  const b = s.battle!;
  const def = other(b.atkSide);
  const order = ['counter', 'block', 'offCombo', 'defCombo', 'damage'] as const;
  for (let i = order.indexOf(from); i < order.length; i++) {
    const step = order[i];
    if (step === 'damage') return resolveDamage(s, ctl);
    if (step === 'counter' && counterOptions(s, def).length === 0) continue;
    if (step === 'block' && blockerOptions(s, def).length === 0) continue;
    s.stage = step;
    s.toAct = step === 'offCombo' ? b.atkSide : def;
    if ((step === 'offCombo' || step === 'defCombo') && legalActions(s).length === 1) continue;
    return;
  }
}

export function battleTotals(s: GameState): { atk: number; def: number } {
  const b = s.battle!;
  const def = other(b.atkSide);
  const sum = (side: Side) => s.p[side].combo.reduce((a, u) => a + comboPowerOf(s, u), 0);
  return { atk: powerOf(s, b.attacker) + sum(b.atkSide), def: powerOf(s, b.target) + sum(def) };
}

function resolveDamage(s: GameState, ctl: Choosers) {
  const b = s.battle!;
  const { atk, def } = battleTotals(s);
  const defSide = other(b.atkSide);
  if (atk >= def) {
    if (isLeader(s, b.target)) {
      const n = hasKeyword(s, b.attacker, 'tripleStrike') ? 3 : hasKeyword(s, b.attacker, 'doubleStrike') ? 2 : 1;
      const crit = hasKeyword(s, b.attacker, 'critical');
      log(s, `hit: ${atk} vs ${def}, P${defSide} takes ${n}${crit ? ' (critical)' : ''}`);
      emit(s, { t: 'damage', p: defSide, n });
      takeLife(s, defSide, n, crit, ctl);
      if (s.stage !== 'over') fireTriggers(s, b.attacker, 'whenDealsDamage', ctl);
    } else {
      log(s, `hit: ${atk} vs ${def}`);
      if (koCard(s, b.target, ctl, { src: b.attacker }) && s.stage !== 'over' && s.p[b.atkSide].battle.includes(b.attacker)) fireTriggers(s, b.attacker, 'whenKOsInBattle', ctl);
    }
  } else log(s, `blocked out: ${atk} vs ${def}`);
  // "When this card wins a battle": the attacker on a hit, the defender otherwise.
  const winner = atk >= def ? b.attacker : b.target;
  const stillThere = isLeader(s, winner) || s.p[s.inst[winner].owner].battle.includes(winner);
  if (stillThere && s.stage !== 'over') fireTriggers(s, winner, 'whenWinsBattle', ctl);
  endBattle(s, ctl);
}

function endBattle(s: GameState, ctl: Choosers) {
  for (const side of [0, 1] as Side[]) {
    for (const u of s.p[side].combo.slice()) moveTo(s, u, 'drop');
  }
  for (const i of s.inst) {
    if (i.mods.length) i.mods = i.mods.filter((m) => m.until !== 'battle');
    if (i.grants.length) i.grants = i.grants.filter((g) => g.until !== 'battle');
  }
  s.battle = null;
  if (s.stage === 'over') return;
  checkZeroPower(s, ctl);
  s.stage = 'main';
  s.toAct = s.active;
}

function addCombo(s: GameState, uid: number, side: Side, ctl: Choosers) {
  const fromHand = s.p[side].hand.includes(uid);
  if (!fromHand) s.p[side].comboFieldTurn = s.turn;
  moveTo(s, uid, 'combo');
  s.battle!.comboCount[side]++;
  emit(s, { t: 'combo', p: side, id: s.inst[uid].id, uid, fromHand });
  log(s, `P${side} combos ${nameOf(s, uid)}${fromHand ? '' : ' from the field'}`);
  fireTriggers(s, uid, fromHand ? 'comboFromHand' : 'comboFromField', ctl);
}

function useExtra(s: GameState, uid: number, abIdx: number, ctl: Choosers) {
  const side = s.inst[uid].owner;
  const plan = playCostPlan(s, uid);
  if (!plan) return;
  payPlan(s, side, plan);
  if (cardOf(s, uid).cost >= 1) s.p[side].extraUsedTurn = s.turn;
  const ab = compiledOf(s, uid).abilities[abIdx];
  moveTo(s, uid, 'drop');
  emit(s, { t: 'activate', p: side, id: s.inst[uid].id, uid, fromHand: true });
  log(s, `P${side} uses ${nameOf(s, uid)}`);
  resolveAbility(s, uid, ab, abIdx, ctl);
}

// ------------------------------------------------------------------ step

export function step(s: GameState, a: Action, ctl: Choosers): void {
  const side = s.toAct;
  const me = s.p[side];
  switch (a.k) {
    case 'keep':
    case 'mulligan': {
      if (a.k === 'mulligan') {
        for (const u of me.hand.splice(0)) me.deck.push(u);
        shuffle(s, me.deck);
        drawCards(s, side, s.rules.handSize);
        me.mulliganed = true;
      }
      emit(s, { t: 'mulligan', p: side, did: a.k === 'mulligan' });
      if (side === s.first) { s.toAct = other(side); return; }
      finishSetup(s);
      return;
    }
    case 'charge':
      moveTo(s, a.uid, 'energy');
      emit(s, { t: 'charge', p: side, id: s.inst[a.uid].id, uid: a.uid });
      log(s, `P${side} charges ${nameOf(s, a.uid)}`);
    // fallthrough
    case 'noCharge':
      s.charged = true;
      s.stage = 'main';
      return;
    case 'play': {
      const plan = playCostPlan(s, a.uid);
      if (!plan) return;
      payPlan(s, side, plan);
      consumeDiscount(s, a.uid);
      if (cardOf(s, a.uid).type === 'EXTRA') { if (cardOf(s, a.uid).cost >= 1) me.extraUsedTurn = s.turn; placeField(s, a.uid, ctl); }
      else playCard(s, a.uid, ctl);
      return;
    }
    case 'evolve': return doEvolve(s, a.uid, a.bases, ctl);
    case 'activate': {
      if (me.hand.includes(a.uid)) return useExtra(s, a.uid, a.ab, ctl);
      const ab = abilitiesOf(s, a.uid)[a.ab];
      emit(s, { t: 'activate', p: side, id: s.inst[a.uid].id, uid: a.uid });
      resolveAbility(s, a.uid, ab, a.ab, ctl);
      return;
    }
    case 'awaken': {
      const abs = abilitiesOf(s, me.leader);
      const i = abs.findIndex((x) => x.timing === 'awaken');
      if (i >= 0) resolveAbility(s, me.leader, abs[i], i, ctl);
      me.awakened = true;
      return;
    }
    case 'attack': return declareAttack(s, a.uid, a.target, ctl);
    case 'end': return endTurn(s, ctl);
    case 'counter': {
      useExtra(s, a.uid, a.ab, ctl);
      if ((s.stage as string) === 'over') return;
      if (!battleStillValid(s)) return endBattle(s, ctl);
      return advanceBattle(s, 'counter', ctl);
    }
    case 'noCounter': return advanceBattle(s, 'block', ctl);
    case 'block': {
      const b = s.battle!;
      s.inst[a.uid].rested = true;
      b.target = a.uid;
      b.blocked = true;
      log(s, `P${side} blocks with ${nameOf(s, a.uid)}`);
      fireTriggers(s, a.uid, 'whenBlocking', ctl);
      if ((s.stage as string) === 'over') return;
      if (!battleStillValid(s)) return endBattle(s, ctl);
      return advanceBattle(s, 'offCombo', ctl);
    }
    case 'noBlock': {
      const b = s.battle!;
      if (isLeader(s, b.target)) emit(s, { t: 'declined', p: side, what: 'block', need: 0, handSize: me.hand.length, stakes: 'leader' });
      return advanceBattle(s, 'offCombo', ctl);
    }
    case 'combo': {
      addCombo(s, a.uid, side, ctl);
      checkZeroPower(s, ctl);
      if (!battleStillValid(s)) return endBattle(s, ctl);
      if (legalActions(s).length === 1) return advanceBattle(s, s.stage === 'offCombo' ? 'defCombo' : 'damage', ctl);
      return;
    }
    case 'battleSkill': {
      if (me.hand.includes(a.uid)) useExtra(s, a.uid, a.ab, ctl);
      else resolveAbility(s, a.uid, abilitiesOf(s, a.uid)[a.ab], a.ab, ctl);
      if (s.stage === 'over') return;
      if (!battleStillValid(s)) return endBattle(s, ctl);
      return;
    }
    case 'comboDone': {
      const b = s.battle!;
      if (s.stage === 'defCombo') {
        const { atk, def } = battleTotals(s);
        if (atk >= def) emit(s, { t: 'declined', p: side, what: 'combo', need: atk - def + 1, handSize: me.hand.length, stakes: isLeader(s, b.target) ? 'leader' : 'battle', life: me.life.length });
        return advanceBattle(s, 'damage', ctl);
      }
      return advanceBattle(s, 'defCombo', ctl);
    }
  }
}

export const isOver = (s: GameState) => s.stage === 'over';
export { takeLife };
