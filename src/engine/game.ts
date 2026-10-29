import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { expandDeck } from '../data/decks';
import { Cost } from '../effects/types';
import {
  GameState, Inst, PlayerState, Side, abilitiesOf, activeEnergy, activeMods, cardOf, compiledOf, comboPowerOf, condsHold, costInHand, consumeDiscount, playBanned,
  emit, hasKeyword, isLeader, log, matchesFilter, moveTo, resetInst, nameOf, other, payPlan, planPayment, powerOf, shuffle, specFor, spendHandCostMods,
  staticRules, turnMatches, valOf, costOf,
} from './core';
import {
  Choosers, afterPlayed, isFreeRepeatable, canPayCosts, checkZeroPower, dealDamage, drawCards, fireAll, fireRemovals, placeField, fireTriggers, koCard, onceKey,
  payCosts, playCard, resolveAbility, setWinner, spendSkillDiscount, takeLife, awakenLeader,
} from './effects';

export type Action =
  | { k: 'keep' }
  | { k: 'mulligan' }
  | { k: 'charge'; uid: number }
  | { k: 'noCharge' }
  /** alt: index into altCostsFor(uid) — pay that alternative cost instead of energy. */
  | { k: 'play'; uid: number; alt?: number }
  | { k: 'evolve'; uid: number; bases: number[] }
  | { k: 'activate'; uid: number; ab: number; alt?: number }
  | { k: 'awaken' }
  | { k: 'attack'; uid: number; target: number }
  | { k: 'end' }
  | { k: 'counter'; uid: number; ab: number; alt?: number }
  | { k: 'noCounter' }
  | { k: 'block'; uid: number }
  | { k: 'noBlock' }
  | { k: 'combo'; uid: number }
  | { k: 'battleSkill'; uid: number; ab: number; alt?: number }
  | { k: 'comboDone' };

export interface NewGameOpts {
  seed?: number;
  rules?: RulesConfig;
  first?: Side;
  log?: boolean;
  events?: boolean;
  /** Deal in the order the list was written (games saved before decks were sorted). */
  listedOrder?: boolean;
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
      deck: expandDeck(d, opts.listedOrder).map((id) => mk(id, side)),
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
    deckKey: decks.map((d) => d.leader + ':' + Object.entries(d.main).sort().map(([id, n]) => id + 'x' + n).join(',')).join('|'),
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
  log(s, () => `P${other(s.first)} goes second and gets 1 energy marker`);
  // "When this card is placed in your Leader Area" skills.
  for (const side of [s.first, other(s.first)] as Side[]) fireTriggers(s, s.p[side].leader, 'gameStart', NO_CHOICE);
  s.active = other(s.first);
  startTurn(s);
}

// ------------------------------------------------------------------ turn flow

function startTurn(s: GameState) {
  s.turn += 1;
  s.active = s.turn === 1 ? s.first : s.extraTurn ?? other(s.active);
  s.extraTurn = undefined;
  if (s.turn > s.rules.maxTurns) { setWinner(s, -1, 'turn limit'); return; }
  // A player kept alive at 0 life by "you will not lose the game for the turn" loses once that ends.
  if (s.rules.loseAtZeroLife) for (const side of [0, 1] as Side[]) if (s.p[side].life.length === 0) { setWinner(s, other(side), 'life reached 0'); if (s.stage === 'over') return; }
  const p = s.p[s.active];
  s.p[0].usedOnce = [];
  s.p[1].usedOnce = [];
  s.charged = false;
  emit(s, { t: 'turn', turn: s.turn, active: s.active });
  log(s, () => `--- Turn ${s.turn}: P${s.active} (${nameOf(s, p.leader)})`);
  for (const u of [p.leader, ...p.battle, ...p.energy, ...(p.field !== null ? [p.field] : [])]) {
    if (s.inst[u].lockedUntil >= s.turn) continue;
    if (s.inst[u].rested && p.battle.includes(u) && hasKeyword(s, u, 'noUntap')) continue;
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
    if (i.basePowerSet && (i.basePowerSet.until === 'battle' || i.basePowerSet.until <= s.turn)) i.basePowerSet = undefined;
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

// ------------------------------------------------------------------ alternative costs

export interface AltCost { src: number; costs: Cost[]; key?: string }

/**
 * "When you would pay the cost of <card> from your hand, you may <X> instead": on the card itself, or given by
 * one of your cards in play. Only the ones you can pay right now.
 */
export function altCostsFor(s: GameState, uid: number): AltCost[] {
  const side = s.inst[uid].owner;
  const card = cardOf(s, uid);
  const out: AltCost[] = [];
  const scale = (costs: Cost[], on: boolean): Cost[] => (on ? costs.map((c) => ('n' in c ? { ...c, n: c.n * card.cost } : c)) as Cost[] : costs);
  compiledOf(s, uid).abilities.forEach((ab) => {
    if (ab.timing !== 'permanent' || !turnMatches(s, side, ab.turn) || !condsHold(s, side, uid, ab.cond)) return;
    for (const e of ab.effects) if (e.t === 'altCost' && !e.filter && (!e.inBattle || s.battle) && canPayCosts(s, uid, scale(e.costs, !!e.scaleN), uid)) out.push({ src: uid, costs: scale(e.costs, !!e.scaleN) });
  });
  for (const h of staticRules(s, side, 'altCost')) {
    const e = h.e;
    if (!e.filter || !matchesFilter(s, uid, e.filter, h.src) || (e.inBattle && !s.battle)) continue;
    if (e.costLEv && card.cost > valOf(s, side, h.src, e.costLEv)) continue;
    const key = `alt:${h.src}:${h.idx}`;
    if (e.once && s.p[side].usedOnce.includes(key)) continue;
    const costs = scale(e.costs, !!e.scaleN);
    if (canPayCosts(s, h.src, costs, uid)) out.push({ src: h.src, costs, key: e.once ? key : undefined });
  }
  return out;
}

/** Pay a card's cost from hand: energy, or the chosen alternative. False if it can't be paid. */
function payCardCost(s: GameState, uid: number, alt: number | undefined, ctl: Choosers): boolean {
  const side = s.inst[uid].owner;
  if (alt !== undefined) {
    const a = altCostsFor(s, uid)[alt];
    if (!a) return false;
    payCosts(s, a.src, a.costs, ctl);
    if (a.key) s.p[side].usedOnce.push(a.key);
    s.inst[uid].markerPaid = false;
    return true;
  }
  const plan = playCostPlan(s, uid);
  if (!plan) return false;
  payPlan(s, side, plan);
  spendHandCostMods(s, uid);
  spendSkillDiscount(s, uid);
  s.inst[uid].markerPaid = plan.markers > 0;
  return true;
}

/** Ways to pay for a card in hand: [undefined] for energy, plus alternative cost indices. */
function payWays(s: GameState, uid: number, abCosts: Cost[] = []): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  if (playCostPlan(s, uid) && canPayCosts(s, uid, abCosts, uid)) out.push(undefined);
  altCostsFor(s, uid).forEach((_, i) => { if (canPayCosts(s, uid, abCosts, uid)) out.push(i); });
  return out;
}

// ------------------------------------------------------------------ evolve

/** Energy cost of an [Evolve] after "reduce the cost of the next [Evolve] skill" discounts. */
function evolveCost(s: GameState, uid: number, base: number): number {
  const m = activeMods(s, s.inst[uid].owner).find((x) => x.kind === 'evolveDiscount' && matchesFilter(s, uid, x.filter, uid));
  return Math.max(0, base - ((m?.amount as number) ?? 0));
}

/** Cards under your [Field] that an [Evolve] of this card may use ("you can choose a card from under this card"). */
function underFieldBases(s: GameState, uid: number): number[] {
  const side = s.inst[uid].owner;
  const f = s.p[side].field;
  if (f === null) return [];
  return staticRules(s, side, 'evolveFromUnder').some((h) => h.src === f && matchesFilter(s, uid, h.e.filter, h.src)) ? (s.inst[f].under ?? []).slice() : [];
}

/** [Evolve] / [Fusion Evolve]: pay the skill cost and play on top of the specified card(s). */
export function evolveOptions(s: GameState, uid: number): Action[] {
  const ev = compiledOf(s, uid).evolve;
  if (!ev) return [];
  const side = s.inst[uid].owner;
  const me = s.p[side];
  const color = cardOf(s, uid).colors[0];
  const cost = evolveCost(s, uid, ev.cost);
  if (!planPayment(s, side, cost, cost > 0 && color ? { [color]: cost } : {})) return [];
  if (ev.extraCost?.length && !canPayCosts(s, uid, ev.extraCost, uid)) return [];
  const out: Action[] = [];
  const fits = (u: number, i: number) => matchesFilter(s, u, ev.from[i], uid) || (i === 0 && ev.from.length === 1 && (ev.orFrom ?? []).some((f) => matchesFilter(s, u, f, uid)));
  // Fusion Evolve plays on cards in Active Mode unless the card says otherwise (FB09-006 reminder text).
  const modeOk = (u: number) => (ev.baseMode ?? 'active') === 'rested' ? s.inst[u].rested : !s.inst[u].rested;
  if (ev.from.length === 1) {
    for (const b of me.battle) if (b !== uid && fits(b, 0)) out.push({ k: 'evolve', uid, bases: [b] });
    for (const b of underFieldBases(s, uid)) if (fits(b, 0)) out.push({ k: 'evolve', uid, bases: [b] });
  } else {
    for (const a of me.battle) {
      if (!modeOk(a) || !fits(a, 0)) continue;
      for (const b of me.battle) {
        if (b === a || !modeOk(b) || !fits(b, 1)) continue;
        const pa = powerOf(s, a), pb = powerOf(s, b);
        if ((ev.equal ?? 'power') === 'power' && pa !== pb) continue;
        if (ev.equal === 'cost' && costOf(s, a) !== costOf(s, b)) continue;
        if (ev.equalPowerGE !== undefined && (pa !== pb || pa < ev.equalPowerGE)) continue;
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
  const cost = evolveCost(s, uid, ev.cost);
  const plan = planPayment(s, side, cost, cost > 0 && color ? { [color]: cost } : {});
  const fromField = underFieldBases(s, uid);
  if (!plan || bases.some((b) => !me.battle.includes(b) && !fromField.includes(b))) return;
  payPlan(s, side, plan);
  const di = (me.mods ?? []).findIndex((x) => x.kind === 'evolveDiscount' && x.until >= s.turn && matchesFilter(s, uid, x.filter, uid));
  if (di >= 0) me.mods!.splice(di, 1);
  if (ev.extraCost?.length) payCosts(s, uid, ev.extraCost, ctl);
  const rested = s.rules.evolveKeepsMode && bases.some((b) => me.battle.includes(b) && s.inst[b].rested);
  const at = bases.some((b) => me.battle.includes(b)) ? me.battle.indexOf(bases.find((b) => me.battle.includes(b))!) : me.battle.length;
  // Rule 14-5-2: power changes, Ki and being in battle carry over to the card placed on top; other continuous effects don't.
  const live = bases.filter((b) => me.battle.includes(b));
  const ki = live.reduce((n, b) => n + s.inst[b].ki, 0);
  const mods = live.flatMap((b) => s.inst[b].mods);
  const basePowerSet = live.map((b) => s.inst[b].basePowerSet).find(Boolean);
  const kiRemovedBattle = live.reduce((n, b) => n + (s.inst[b].kiRemovedBattle ?? 0), 0) || undefined;
  const under: number[] = [];
  for (const b of bases) {
    under.push(...(s.inst[b].under ?? []), b);
    s.inst[b].under = undefined;
    if (me.battle.includes(b)) me.battle.splice(me.battle.indexOf(b), 1);
    else if (me.field !== null) { const fu = s.inst[me.field].under ?? []; if (fu.includes(b)) fu.splice(fu.indexOf(b), 1); }
    resetInst(s.inst[b]);
  }
  me.hand.splice(me.hand.indexOf(uid), 1);
  resetInst(s.inst[uid]);
  s.inst[uid].rested = rested;
  Object.assign(s.inst[uid], { ki, mods, basePowerSet, kiRemovedBattle });
  if (s.battle) {
    if (live.includes(s.battle.attacker)) s.battle.attacker = uid;
    if (live.includes(s.battle.target)) s.battle.target = uid;
  }
  s.inst[uid].under = under;
  s.inst[uid].playedTurn = s.turn;
  s.inst[uid].playedByEvolve = true;
  me.battle.splice(Math.min(at, me.battle.length), 0, uid);
  s.zoneRev = (s.zoneRev ?? 0) + 1;
  log(s, () => `P${side} evolves ${bases.map((b) => nameOf(s, b)).join(' + ')} into ${nameOf(s, uid)}`);
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
    if (card.type !== 'EXTRA' || seen.has(card.id) || isField(s, u) || playBanned(s, u)) continue;
    compiledOf(s, u).abilities.forEach((ab, i) => {
      if (ab.timing !== 'activateBattle' || !turnOk(s, side, ab.turn)) return;
      if (!condsHold(s, side, u, ab.cond)) return;
      for (const alt of payWays(s, u, ab.cost)) { seen.add(card.id); out.push({ k: 'battleSkill', uid: u, ab: i, ...(alt !== undefined ? { alt } : {}) }); }
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
    if ((s.inst[u].rested && !hasKeyword(s, u, 'comboRested')) || u === b.attacker || u === b.target) continue;
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
    if (seen.has(card.id) || playBanned(s, u)) continue;
    compiledOf(s, u).abilities.forEach((ab, i) => {
      if (ab.timing !== 'counter') return;
      if (!condsHold(s, side, u, ab.cond)) return;
      for (const alt of payWays(s, u, ab.cost)) { seen.add(card.id); out.push({ k: 'counter', uid: u, ab: i, ...(alt !== undefined ? { alt } : {}) }); }
    });
  }
  return out;
}

/** Attack rules in force on `side`: the opponent's [Permanent] ones and temporary ones placed on this player. */
function attackRules(s: GameState, side: Side) {
  const out = staticRules(s, other(side), 'attackRule').map((h) => ({ e: h.e, src: h.src }));
  for (const m of activeMods(s, side)) if (m.kind === 'attackRule' && m.effect?.t === 'attackRule') out.push({ e: m.effect, src: m.src ?? s.p[other(side)].leader });
  return out;
}

/** Other Active Mode cards of `side` that could be rested to pay an attack tax. */
const taxPool = (s: GameState, side: Side, attacker: number) => {
  const me = s.p[side];
  return [me.leader, ...me.battle, ...me.energy].filter((u) => u !== attacker && !s.inst[u].rested);
};

function attackAllowed(s: GameState, side: Side, attacker: number, target: number, rules = attackRules(s, side)): boolean {
  for (const { e, src } of rules) {
    if (e.attacker && (isLeader(s, attacker) ? e.attacker.type === 'BATTLE' : false)) continue;
    if (e.attacker && !matchesFilter(s, attacker, e.attacker, src)) continue;
    if (e.onlyAgainst && !matchesFilter(s, target, e.onlyAgainst, src)) return false;
    if (e.againstThis) { if (target === src) return false; continue; }
    if (e.against || e.againstZone) {
      const zoneOk = !e.againstZone || (e.againstZone === 'leader') === isLeader(s, target);
      if (zoneOk && (!e.against || matchesFilter(s, target, e.against, src))) return false;
      continue;
    }
    if (e.restTax) { if (taxPool(s, side, attacker).length < e.restTax) return false; continue; }
    if (!e.noBlock && !e.onlyAgainst) return false; // "can't attack using ..."
  }
  return true;
}

function blockerOptions(s: GameState, side: Side): Action[] {
  const b = s.battle!;
  if (b.cantBlock || b.blocked) return [];
  if (attackRules(s, side).some((r) => r.e.noBlock)) return []; // the attacker's "your opponent can't activate [Blocker]"
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
        if (card.type === 'BATTLE' || (card.type === 'EXTRA' && isField(s, u))) for (const alt of payWays(s, u)) out.push({ k: 'play', uid: u, ...(alt !== undefined ? { alt } : {}) });
        if (card.type === 'BATTLE') out.push(...evolveOptions(s, u));
        else if (card.type === 'EXTRA' && !isField(s, u)) {
          compiledOf(s, u).abilities.forEach((ab, i) => {
            if (ab.timing !== 'activateMain' || !turnOk(s, side, ab.turn)) return;
            if (!condsHold(s, side, u, ab.cond)) return;
            for (const alt of payWays(s, u, ab.cost)) out.push({ k: 'activate', uid: u, ab: i, ...(alt !== undefined ? { alt } : {}) });
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
      const rules = attackRules(s, side);
      let forced = false;
      for (const a of [me.leader, ...me.battle]) {
        if (!canAttack(s, a)) continue;
        const anyMode = hasKeyword(s, a, 'attackActive');
        const before = out.length;
        if (!hasKeyword(s, a, 'cantAttackLeader') && attackAllowed(s, side, a, opp.leader, rules)) out.push({ k: 'attack', uid: a, target: opp.leader });
        for (const t of opp.battle) if ((s.inst[t].rested || anyMode) && attackAllowed(s, side, a, t, rules)) out.push({ k: 'attack', uid: a, target: t });
        if (out.length > before && hasKeyword(s, a, 'mustAttack')) forced = true;
      }
      // "This card must attack whenever possible": the turn can't end while it still can.
      if (!forced) out.push({ k: 'end' });
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
  // "Can't attack with a Battle Card unless they switch 1 of their Active Mode cards to Rest Mode."
  for (const r of attackRules(s, side)) {
    if (!r.e.restTax) continue;
    // A Leader is never a Battle Card (the filter matcher lets Leaders through on type).
    if (r.e.attacker && (isLeader(s, attacker) ? r.e.attacker.type === 'BATTLE' : !matchesFilter(s, attacker, r.e.attacker, r.src))) continue;
    const pool = taxPool(s, side, attacker);
    const n = Math.min(r.e.restTax, pool.length);
    const pick = ctl[side].choose(s, { kind: 'pick', player: side, src: r.src, options: pool, min: n, max: n, intent: 'lose', tax: true });
    for (const u of pick.slice(0, n)) s.inst[u].rested = true;
    log(s, () => `P${side} rests ${pick.slice(0, n).map((u) => nameOf(s, u)).join(', ')} to attack (${nameOf(s, r.src)})`);
  }
  s.inst[attacker].rested = true;
  s.inst[attacker].attackedTurn = s.turn;
  s.battle = { attacker, atkSide: side, target, blocked: false, cantBlock: false, comboCount: [0, 0] };
  log(s, () => `P${side} attacks with ${nameOf(s, attacker)} (${powerOf(s, attacker)}) -> ${nameOf(s, target)} (${powerOf(s, target)})`);
  emit(s, { t: 'attack', p: side, attacker, target });
  runDelayed(s, side, 'attacks', ctl, attacker, target);
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  fireTriggers(s, attacker, 'whenAttacking', ctl);
  if (s.stage === 'over') return;
  for (const u of [s.p[side].leader, ...s.p[side].battle]) {
    if (u === attacker || (s.stage as string) === 'over' || !battleStillValid(s)) continue;
    fireTriggers(s, u, 'whenAllyAttacks', ctl, attacker);
  }
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  const def = other(side);
  for (const u of [s.p[def].leader, ...s.p[def].battle]) {
    if ((s.stage as string) === 'over' || !battleStillValid(s)) break;
    fireTriggers(s, u, 'whenOppAttacks', ctl, attacker);
  }
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  fireTriggers(s, s.battle!.target, 'whenAttacked', ctl);
  if ((s.stage as string) === 'over') return;
  if (!battleStillValid(s)) return endBattle(s, ctl);
  advanceBattle(s, 'counter', ctl);
}

/** "During this turn, when your card ... attacks / inflicts damage / KO's in battle" or "if you use <Extra>": run the delayed effects that match. */
function runDelayed(s: GameState, side: Side, on: 'attacks' | 'dealsDamage' | 'koInBattle' | 'usesExtra', ctl: Choosers, attacker: number, target?: number) {
  const me = s.p[side];
  if (!me.mods?.length) return;
  for (const m of me.mods.slice()) {
    const e = m.effect;
    if (m.kind !== 'delayed' || m.until < s.turn || e?.t !== 'delayed' || e.on !== on) continue;
    const src = m.src ?? me.leader;
    if (e.filter && !matchesFilter(s, attacker, e.filter, src)) continue;
    if (on === 'attacks' && e.targetFilter && (target === undefined || isLeader(s, target) || !matchesFilter(s, target, e.targetFilter, src))) continue;
    if (e.once) me.mods.splice(me.mods.indexOf(m), 1);
    resolveAbility(s, src, { timing: 'auto', once: false, cost: [], cond: [], effects: e.effects, text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
    if (s.stage === 'over') return;
  }
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
      let n = hasKeyword(s, b.attacker, 'tripleStrike') ? 3 : hasKeyword(s, b.attacker, 'doubleStrike') ? 2 : 1;
      // "You only take up to N damage in each battle."
      for (const h of staticRules(s, defSide, 'damageCap')) n = Math.min(n, h.e.n);
      const crit = hasKeyword(s, b.attacker, 'critical');
      log(s, () => `hit: ${atk} vs ${def}, P${defSide} takes ${n}${crit ? ' (critical)' : ''}`);
      emit(s, { t: 'damage', p: defSide, n });
      const before = s.p[defSide].life.length;
      dealDamage(s, defSide, n, crit, ctl);
      if (s.stage !== 'over' && s.p[defSide].life.length < before) {
        fireTriggers(s, b.attacker, 'whenDealsDamage', ctl);
        fireAll(s, b.atkSide, 'whenAllyDealsDamage', ctl, b.attacker);
        runDelayed(s, b.atkSide, 'dealsDamage', ctl, b.attacker);
      }
    } else {
      log(s, () => `hit: ${atk} vs ${def}`);
      if (koCard(s, b.target, ctl, { src: b.attacker, battle: true }) && s.stage !== 'over') {
        if (s.p[b.atkSide].battle.includes(b.attacker) || isLeader(s, b.attacker)) fireTriggers(s, b.attacker, 'whenKOsInBattle', ctl);
        fireAll(s, b.atkSide, 'whenAllyKOsInBattle', ctl, b.attacker);
        runDelayed(s, b.atkSide, 'koInBattle', ctl, b.attacker);
      }
    }
    fireRemovals(s, ctl);
  } else log(s, () => `blocked out: ${atk} vs ${def}`);
  // "When this card wins a battle": the attacker on a hit, the defender otherwise.
  const winner = atk >= def ? b.attacker : b.target;
  const stillThere = isLeader(s, winner) || s.p[s.inst[winner].owner].battle.includes(winner);
  if (stillThere && s.stage !== 'over') fireTriggers(s, winner, 'whenWinsBattle', ctl);
  endBattle(s, ctl);
}

function endBattle(s: GameState, ctl: Choosers) {
  const queued = s.battleEnd ?? [];
  s.battleEnd = undefined;
  for (const q of queued) {
    if (s.stage === 'over') break;
    resolveAbility(s, q.src, { timing: 'auto', once: false, cost: [], cond: [], effects: q.effects, text: '', unparsed: [] }, -1, ctl, { costsPaid: true });
  }
  for (const side of [0, 1] as Side[]) {
    for (const u of s.p[side].combo.slice()) moveTo(s, u, 'drop');
  }
  for (const i of s.inst) {
    if (i.mods.length) i.mods = i.mods.filter((m) => m.until !== 'battle');
    if (i.grants.length) i.grants = i.grants.filter((g) => g.until !== 'battle');
    if (i.basePowerSet?.until === 'battle') i.basePowerSet = undefined;
    if (i.kiRemovedBattle) i.kiRemovedBattle = undefined;
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
  log(s, () => `P${side} combos ${nameOf(s, uid)}${fromHand ? '' : ' from the field'}`);
  fireTriggers(s, uid, fromHand ? 'comboFromHand' : 'comboFromField', ctl);
  fireComboWatchers(s, side, ctl);
  if (!fromHand && s.battle && s.stage !== 'over') {
    const mine = s.battle.atkSide === side ? s.battle.attacker : s.battle.target;
    if (s.inst[mine]?.owner === side) fireTriggers(s, mine, 'whenFieldComboInBattle', ctl);
  }
}

/** "When you use a card in a combo while this card is in a battle." */
export function fireComboWatchers(s: GameState, side: Side, ctl: Choosers) {
  const b = s.battle;
  if (!b || s.stage === 'over') return;
  const mine = b.atkSide === side ? b.attacker : b.target;
  if (s.inst[mine]?.owner === side) fireTriggers(s, mine, 'whenComboInBattle', ctl);
}

function useExtra(s: GameState, uid: number, abIdx: number, ctl: Choosers, alt?: number) {
  const side = s.inst[uid].owner;
  const me = s.p[side];
  if (!payCardCost(s, uid, alt, ctl)) return;
  if (cardOf(s, uid).cost >= 1) me.extraUsedTurn = s.turn;
  (me.usedExtras ??= []).push({ turn: s.turn, uid });
  const ab = compiledOf(s, uid).abilities[abIdx];
  // "The next time you use <X> Extra this turn, activate its skill again."
  const ri = (me.mods ?? []).findIndex((m) => m.kind === 'repeatExtra' && m.until >= s.turn && matchesFilter(s, uid, m.filter, uid));
  const again = ri >= 0;
  if (again) me.mods!.splice(ri, 1);
  moveTo(s, uid, 'drop');
  emit(s, { t: 'activate', p: side, id: s.inst[uid].id, uid, fromHand: true });
  log(s, () => `P${side} uses ${nameOf(s, uid)}`);
  resolveAbility(s, uid, ab, abIdx, ctl);
  if (again && s.stage !== 'over') resolveAbility(s, uid, ab, abIdx, ctl);
  if (s.stage !== 'over') runDelayed(s, side, 'usesExtra', ctl, uid);
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
      log(s, () => `P${side} charges ${nameOf(s, a.uid)}`);
    // fallthrough
    case 'noCharge':
      s.charged = true;
      s.stage = 'main';
      return;
    case 'play': {
      if (!payCardCost(s, a.uid, a.alt, ctl)) return;
      consumeDiscount(s, a.uid);
      if (cardOf(s, a.uid).type === 'EXTRA') { if (cardOf(s, a.uid).cost >= 1) me.extraUsedTurn = s.turn; (me.usedExtras ??= []).push({ turn: s.turn, uid: a.uid }); placeField(s, a.uid, ctl); if (s.stage !== 'over') runDelayed(s, side, 'usesExtra', ctl, a.uid); }
      else playCard(s, a.uid, ctl);
      return;
    }
    case 'evolve': return doEvolve(s, a.uid, a.bases, ctl);
    case 'activate': {
      if (me.hand.includes(a.uid)) return useExtra(s, a.uid, a.ab, ctl, a.alt);
      const ab = abilitiesOf(s, a.uid)[a.ab];
      emit(s, { t: 'activate', p: side, id: s.inst[a.uid].id, uid: a.uid });
      resolveAbility(s, a.uid, ab, a.ab, ctl);
      return;
    }
    case 'awaken': {
      const abs = abilitiesOf(s, me.leader);
      const i = abs.findIndex((x) => x.timing === 'awaken');
      if (i >= 0) resolveAbility(s, me.leader, abs[i], i, ctl);
      if (!me.awakened) awakenLeader(s, side);
      return;
    }
    case 'attack': return declareAttack(s, a.uid, a.target, ctl);
    case 'end': return endTurn(s, ctl);
    case 'counter': {
      useExtra(s, a.uid, a.ab, ctl, a.alt);
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
      log(s, () => `P${side} blocks with ${nameOf(s, a.uid)}`);
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
      if (me.hand.includes(a.uid)) useExtra(s, a.uid, a.ab, ctl, a.alt);
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

export { takeLife };
