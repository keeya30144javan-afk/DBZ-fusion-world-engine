import { Ability, Cost, Effect, Filter, Target } from '../effects/types';
import {
  GameState, PlayerMod, Side, abilitiesOf, cardOf, condsHold, countOf, emit, hasKeyword, inPlay, isLeader, log, matchesFilter, moveTo, nameOf,
  other, planPayment, payPlan, powerOf, removeFrom, resetInst, shuffle, turnMatches,
} from './core';

export interface ChoiceReq {
  kind: 'target' | 'discard' | 'pick' | 'energyToDrop' | 'yesno' | 'mode';
  player: Side;
  src: number;
  /** Card uids, or option indices for 'mode'. */
  options: number[];
  min: number;
  max: number;
  effect?: Effect;
  /** 'good' when the chosen cards benefit the chooser, 'bad' when they are hurt. */
  intent: 'buff' | 'harm' | 'gain' | 'lose';
}

export interface Chooser {
  choose(s: GameState, req: ChoiceReq): number[];
}
export type Choosers = [Chooser, Chooser];

// ------------------------------------------------------------------ win/lose

export function setWinner(s: GameState, winner: Side | -1, reason: string) {
  if (s.stage === 'over') return;
  s.stage = 'over';
  s.winner = winner;
  s.reason = reason;
  s.battle = null;
  log(s, `GAME OVER: ${winner === -1 ? 'draw' : `P${winner} wins`} (${reason})`);
  emit(s, { t: 'over', winner, reason });
}

/** Sorbet / Golden Frieza: "You will not lose the game even if you have 0 cards in your deck." */
function ignoresDeckOut(s: GameState, p: Side): boolean {
  const lc = cardOf(s, s.p[p].leader);
  const text = s.p[p].awakened && lc.back ? lc.back.text : lc.text;
  return /will not lose the game even if you have 0 cards in your deck/i.test(text);
}

/** Manual p.6: a player whose deck is reduced to zero cards loses at once. */
export function checkDeckOut(s: GameState) {
  if (!s.rules.deckOutAtZero || s.stage === 'over' || s.stage === 'mulligan') return;
  for (const p of [s.active, other(s.active)] as Side[]) {
    if (s.p[p].deck.length === 0 && !ignoresDeckOut(s, p)) { setWinner(s, other(p), 'deck out'); return; }
  }
}

export function drawCards(s: GameState, p: Side, n: number) {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const top = s.p[p].deck.pop();
    if (top === undefined) {
      if (!ignoresDeckOut(s, p) && s.stage !== 'mulligan') setWinner(s, other(p), 'deck out');
      break;
    }
    s.p[p].hand.push(top);
    drawn++;
  }
  if (drawn > 0) emit(s, { t: 'draw', p, n: drawn });
  checkDeckOut(s);
}

/** Take n life. toDrop for [Critical]. Fires "when you take damage" skills when ctl is given. */
export function takeLife(s: GameState, p: Side, n: number, toDrop: boolean, ctl?: Choosers) {
  const me = s.p[p];
  let taken = 0;
  for (let i = 0; i < n; i++) {
    if (me.life.length === 0) {
      if (!s.rules.loseAtZeroLife) setWinner(s, other(p), 'damage at 0 life');
      return;
    }
    const top = me.life.pop()!;
    taken++;
    if (toDrop) { me.drop.push(top); emit(s, { t: 'toDrop', p, id: s.inst[top].id, uid: top }); }
    else me.hand.push(top);
    if (me.life.length === 0 && s.rules.loseAtZeroLife) { setWinner(s, other(p), 'life reached 0'); return; }
  }
  if (!toDrop && taken) emit(s, { t: 'lifeToHand', p, n: taken });
  if (ctl && taken) for (const u of fieldOf(s, p)) fireTriggers(s, u, 'whenDamaged', ctl);
}

/** Cards on a player's field whose skills are live: Leader, Battle Cards, Field. */
export function fieldOf(s: GameState, p: Side): number[] {
  const me = s.p[p];
  return [me.leader, ...me.battle, ...(me.field !== null ? [me.field] : [])];
}

// ------------------------------------------------------------------ zero power, KO, removal

export function checkZeroPower(s: GameState, ctl: Choosers) {
  for (const side of [0, 1] as Side[]) {
    for (const u of s.p[side].battle.slice()) {
      if (powerOf(s, u) <= 0) {
        // Not a KO: "When KO'd" does not trigger (FW manual p. 11).
        moveTo(s, u, 'drop');
        log(s, `${nameOf(s, u)} drops at 0 power`);
        emit(s, { t: 'toDrop', p: side, id: s.inst[u].id, uid: u });
      }
    }
  }
  void ctl;
}

/** Who is trying to remove a card, for immunity checks. */
export interface ByWhom { skillOf?: Side; src?: number }

export function koCard(s: GameState, uid: number, ctl: Choosers, by: ByWhom = {}): boolean {
  const owner = s.inst[uid].owner;
  if (!s.p[owner].battle.includes(uid)) return false;
  if (hasKeyword(s, uid, 'indestructible') || hasKeyword(s, uid, 'koImmune')) return false;
  const oppSkill = by.skillOf !== undefined && by.skillOf !== owner;
  if (oppSkill && (hasKeyword(s, uid, 'koImmuneSkills') || hasKeyword(s, uid, 'removeImmune'))) return false;
  if (hasKeyword(s, uid, 'koImmuneOnce') && s.inst[uid].koShieldTurn !== s.turn) {
    s.inst[uid].koShieldTurn = s.turn;
    log(s, `${nameOf(s, uid)} survives (can't be KO'd once per turn)`);
    return false;
  }
  if (by.src !== undefined && s.inst[by.src].owner !== owner) (s.p[s.inst[by.src].owner].koBy ??= []).push({ turn: s.turn, uid: by.src });
  moveTo(s, uid, 'drop');
  log(s, `${nameOf(s, uid)} is KO'd`);
  emit(s, { t: 'ko', p: owner, id: s.inst[uid].id });
  emit(s, { t: 'toDrop', p: owner, id: s.inst[uid].id, uid });
  fireTriggers(s, uid, 'whenKOd', ctl);
  return true;
}

/** Can an effect from `by` take this card out of the Battle Area? */
function removable(s: GameState, uid: number, by: ByWhom): boolean {
  if (isLeader(s, uid)) return false;
  const owner = s.inst[uid].owner;
  return !(by.skillOf !== undefined && by.skillOf !== owner && hasKeyword(s, uid, 'removeImmune'));
}

/** Manual p.13: a [Field] stays in the Battle Area until another of your [Field]s replaces it. */
export function placeField(s: GameState, uid: number, ctl: Choosers) {
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  if (me.field !== null) moveTo(s, me.field, 'drop');
  removeFrom(s, uid);
  resetInst(s.inst[uid]);
  s.inst[uid].playedTurn = s.turn;
  me.field = uid;
  log(s, `P${owner} places Field ${nameOf(s, uid)}`);
  emit(s, { t: 'play', p: owner, id: s.inst[uid].id, uid });
  fireTriggers(s, uid, 'onPlay', ctl);
}

export function playCard(s: GameState, uid: number, ctl: Choosers, opts: { rested?: boolean; byLeader?: boolean; negate?: 'all' | 'onPlay' } = {}) {
  const owner = s.inst[uid].owner;
  const forcedRest = activeModsOf(s, owner).some((m) => m.kind === 'playRested' && matchesFilter(s, uid, m.filter, uid));
  moveTo(s, uid, 'battle', { rested: opts.rested || forcedRest });
  s.inst[uid].playedTurn = s.turn;
  s.inst[uid].playedByLeader = !!opts.byLeader;
  if (opts.negate) { s.inst[uid].negatedUntil = s.turn; s.inst[uid].negateScope = opts.negate; }
  log(s, `P${owner} plays ${nameOf(s, uid)}`);
  emit(s, { t: 'play', p: owner, id: s.inst[uid].id, uid });
  afterPlayed(s, uid, ctl);
}

/** On Play of the card, then "when your X is played" on the owner's other cards. */
export function afterPlayed(s: GameState, uid: number, ctl: Choosers) {
  const owner = s.inst[uid].owner;
  fireTriggers(s, uid, 'onPlay', ctl);
  for (const u of fieldOf(s, owner)) {
    if (s.stage === 'over') return;
    if (u === uid) continue;
    fireTriggers(s, u, 'whenAllyPlayed', ctl, uid);
  }
}

const activeModsOf = (s: GameState, p: Side) => (s.p[p].mods ?? []).filter((m) => m.until >= s.turn);

// ------------------------------------------------------------------ triggers

/** Fire every skill of `uid` with this timing. `subject` is the card a "when X" trigger is about. */
export function fireTriggers(s: GameState, uid: number, timing: Ability['timing'], ctl: Choosers, subject?: number) {
  const abs = abilitiesOf(s, uid);
  for (let i = 0; i < abs.length; i++) {
    const ab = abs[i];
    if (ab.timing !== timing) continue;
    if (s.stage === 'over') return;
    const owner = s.inst[uid].owner;
    if (!turnMatches(s, owner, ab.turn)) continue;
    if (ab.once && s.p[owner].usedOnce.includes(onceKey(s, uid, i))) continue;
    if ((timing === 'whenAllyPlayed' || timing === 'whenAllyRemovedBySelf' || timing === 'whenAllyRemovedByOpp') && (subject === undefined || (ab.trigger && !matchesFilter(s, subject, ab.trigger, uid)))) continue;
    resolveAbility(s, uid, ab, i, ctl);
  }
}

/** A costless activated skill without [Once Per Turn] would repeat forever; treat it as once per turn. */
export const isFreeRepeatable = (ab: Ability) => (ab.timing === 'activateMain' || ab.timing === 'activateBattle') && ab.cost.length === 0;

export const onceKey = (s: GameState, uid: number, idx: number) => `${uid}:${idx}:${isLeader(s, uid) && s.p[s.inst[uid].owner].awakened ? 'b' : 'f'}`;

// ------------------------------------------------------------------ costs

const ownInPlay = (s: GameState, p: Side, f: Filter, src: number) => s.p[p].battle.filter((u) => matchesFilter(s, u, f, src));

export function canPayCosts(s: GameState, uid: number, costs: Cost[], excludeFromHand = -1): boolean {
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  let energyNeeded = 0;
  const hand = me.hand.filter((u) => u !== excludeFromHand && u !== uid);
  for (const c of costs) {
    switch (c.t) {
      case 'discard': if (hand.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid)).length < c.n) return false; break;
      case 'energyToDrop': if (me.energy.length < c.n) return false; break;
      case 'restSelf': if (s.inst[uid].rested) return false; break;
      case 'restEnergy': energyNeeded += c.n; break;
      case 'lifeToHand': case 'lifeToDrop': if (me.life.length < c.n) return false; break;
      case 'selfToDrop': case 'selfToHand': case 'selfToDeckBottom': case 'koSelf': break;
      case 'reduceKi': if (kiPool(s, uid, c.scope).reduce((a, u) => a + s.inst[u].ki, 0) < c.n) return false; break;
      case 'koOwn': case 'dropOwn': case 'bounceOwn': if (ownInPlay(s, owner, c.filter, uid).length < c.n) return false; break;
      case 'restOwn': if (ownInPlay(s, owner, { ...c.filter, active: true }, uid).length < c.n) return false; break;
      case 'handToDeckTop': if (hand.length < c.n) return false; break;
      case 'mill': if (me.deck.length < c.n) return false; break;
      case 'reveal': if (!hand.some((u) => matchesFilter(s, u, c.filter, uid))) return false; break;
      case 'underToDrop': if (underPool(s, owner, c.filter, uid).length < c.n) return false; break;
      case 'dropToDeck': if (me.drop.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid)).length < c.n) return false; break;
      case 'handToUnder':
        if (!hand.some((u) => matchesFilter(s, u, c.filter, uid))) return false;
        if (!fieldOf(s, owner).some((u) => !isLeader(s, u) && matchesFilter(s, u, c.onto, uid))) return false;
        break;
      case 'activateOwn': if (!fieldOf(s, owner).some((u) => s.inst[u].rested && matchesFilter(s, u, c.filter, uid))) return false; break;
    }
  }
  if (energyNeeded && !planPayment(s, owner, energyNeeded, {})) return false;
  return true;
}

function underPool(s: GameState, owner: Side, f: Filter | undefined, src: number): number[] {
  const out: number[] = [];
  for (const u of s.p[owner].battle) if (!f || matchesFilter(s, u, f, src)) out.push(...(s.inst[u].under ?? []));
  return out;
}

/** Pay the costs; returns how much Ki was removed (for "for each Ki removed by this skill"). */
function payCosts(s: GameState, uid: number, costs: Cost[], ctl: Choosers): number {
  let kiRemoved = 0;
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  const pickOwn = (cands: number[], n: number) => ctl[owner].choose(s, { kind: 'pick', player: owner, src: uid, options: cands, min: n, max: n, intent: 'lose' }).slice(0, n);
  for (const c of costs) {
    switch (c.t) {
      case 'discard': {
        const opts = me.hand.filter((u) => u !== uid && (!c.filter || matchesFilter(s, u, c.filter, uid)));
        const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src: uid, options: opts, min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'discard', p: owner, id: s.inst[u].id, uid: u }); }
        break;
      }
      case 'energyToDrop': {
        const pick = ctl[owner].choose(s, { kind: 'energyToDrop', player: owner, src: uid, options: me.energy.slice(), min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'toDrop', p: owner, id: s.inst[u].id, uid: u }); }
        break;
      }
      case 'restSelf': s.inst[uid].rested = true; break;
      case 'restEnergy': { const plan = planPayment(s, owner, c.n, {}); if (plan) payPlan(s, owner, plan); break; }
      case 'lifeToHand': takeLife(s, owner, c.n, false); break;
      case 'lifeToDrop': takeLife(s, owner, c.n, true); break;
      case 'selfToDrop': if (me.field === uid) { removeFrom(s, uid); me.drop.push(uid); } else moveTo(s, uid, 'drop'); break;
      case 'selfToHand': moveTo(s, uid, 'hand'); break;
      case 'selfToDeckBottom': moveTo(s, uid, 'deck', { bottom: true }); break;
      case 'koSelf': koCard(s, uid, ctl); break;
      case 'reduceKi': {
        // Spend Ki from Battle Cards before the Leader: Leader Ki usually gates other skills.
        const pool = kiPool(s, uid, c.scope).sort((a, b) => (isLeader(s, a) ? 1 : 0) - (isLeader(s, b) ? 1 : 0));
        const have = pool.reduce((a, u) => a + s.inst[u].ki, 0);
        let left = c.max ? Math.min(have, c.max) : c.n;
        const want = left;
        for (const u of pool) { const k = Math.min(left, s.inst[u].ki); s.inst[u].ki -= k; left -= k; if (!left) break; }
        kiRemoved += want - left;
        if (want - left > 0) me.kiRemovedTurn = s.turn;
        break;
      }
      case 'koOwn': for (const u of pickOwn(ownInPlay(s, owner, c.filter, uid), c.n)) koCard(s, u, ctl); break;
      case 'dropOwn': for (const u of pickOwn(ownInPlay(s, owner, c.filter, uid), c.n)) moveTo(s, u, 'drop'); break;
      case 'bounceOwn': for (const u of pickOwn(ownInPlay(s, owner, c.filter, uid), c.n)) moveTo(s, u, 'hand'); break;
      case 'restOwn': for (const u of pickOwn(ownInPlay(s, owner, { ...c.filter, active: true }, uid), c.n)) s.inst[u].rested = true; break;
      case 'handToDeckTop': {
        const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src: uid, options: me.hand.filter((u) => u !== uid), min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) moveTo(s, u, 'deck');
        break;
      }
      case 'mill': millCards(s, owner, c.n, ctl); break;
      case 'reveal': {
        const u = me.hand.find((x) => matchesFilter(s, x, c.filter, uid));
        if (u !== undefined) emit(s, { t: 'reveal', p: owner, id: s.inst[u].id, uid: u });
        break;
      }
      case 'dropToDeck': {
        const opts = me.drop.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid));
        for (const u of pickOwn(opts, c.n)) moveTo(s, u, 'deck', { bottom: true });
        break;
      }
      case 'handToUnder': {
        const card = pickOwn(me.hand.filter((u) => u !== uid && matchesFilter(s, u, c.filter, uid)), 1)[0];
        const onto = fieldOf(s, owner).find((u) => !isLeader(s, u) && matchesFilter(s, u, c.onto, uid));
        if (card !== undefined && onto !== undefined) { removeFrom(s, card); resetInst(s.inst[card]); (s.inst[onto].under ??= []).push(card); }
        break;
      }
      case 'activateOwn': {
        const u = fieldOf(s, owner).find((x) => s.inst[x].rested && matchesFilter(s, x, c.filter, uid));
        if (u !== undefined) s.inst[u].rested = false;
        break;
      }
      case 'underToDrop': {
        let left = c.n;
        for (const top of s.p[owner].battle) {
          if (c.filter && !matchesFilter(s, top, c.filter, uid)) continue;
          const under = s.inst[top].under ?? [];
          while (left > 0 && under.length) { const u = under.pop()!; resetInst(s.inst[u]); me.drop.push(u); left--; }
          if (!left) break;
        }
        break;
      }
    }
  }
  return kiRemoved;
}

/** Cards whose Ki a "reduce Ki" cost may take from. */
function kiPool(s: GameState, uid: number, scope: 'this' | 'leader' | 'your' | 'battle'): number[] {
  const me = s.p[s.inst[uid].owner];
  if (scope === 'this') return [uid];
  if (scope === 'leader') return [me.leader];
  return scope === 'your' ? [me.leader, ...me.battle] : me.battle.slice();
}

function millCards(s: GameState, p: Side, n: number, ctl: Choosers) {
  const me = s.p[p];
  const moved: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = me.deck.pop();
    if (u === undefined) break;
    me.drop.push(u);
    moved.push(u);
    emit(s, { t: 'toDrop', p, id: s.inst[u].id, uid: u });
  }
  for (const u of moved) fireTriggers(s, u, 'whenMilled', ctl);
  checkDeckOut(s);
}

// ------------------------------------------------------------------ resolving

interface Ctx { prev: number[]; kiRemoved?: number }

export function resolveAbility(s: GameState, uid: number, ab: Ability, idx: number, ctl: Choosers, opts: { costsPaid?: boolean } = {}): boolean {
  const owner = s.inst[uid].owner;
  if (!condsHold(s, owner, uid, ab.cond)) return false;
  const outer = s.skillBy;
  s.skillBy = owner;
  let kiRemoved = 0;
  try {
    if (!opts.costsPaid) {
      if (!canPayCosts(s, uid, ab.cost)) return false;
      kiRemoved = payCosts(s, uid, ab.cost, ctl);
    }
    if (ab.once || isFreeRepeatable(ab)) s.p[owner].usedOnce.push(onceKey(s, uid, idx));
    const ctx: Ctx = { prev: [], kiRemoved };
    runEffects(s, uid, owner, ab.effects, ctx, ctl);
  } finally {
    s.skillBy = outer;
  }
  checkZeroPower(s, ctl);
  checkDeckOut(s);
  if (outer === undefined) fireRemovals(s, ctl);
  return true;
}

/** "When your X is removed from the Battle Area by one of your skills / by your opponent". */
function fireRemovals(s: GameState, ctl: Choosers) {
  while (s.removals?.length && (s.stage as string) !== 'over') {
    const r = s.removals.shift()!;
    const timing = r.by === r.owner ? 'whenAllyRemovedBySelf' : 'whenAllyRemovedByOpp';
    for (const u of fieldOf(s, r.owner)) {
      if (s.stage === 'over') break;
      fireTriggers(s, u, timing, ctl, r.uid);
    }
  }
}

function runEffects(s: GameState, src: number, owner: Side, effects: Effect[], ctx: Ctx, ctl: Choosers) {
  for (const e of effects) {
    if (s.stage === 'over') return;
    if (!condsHold(s, owner, src, e.cond, ctx.prev)) continue;
    runEffect(s, src, owner, e, ctx, ctl);
  }
}

/** Your / the opponent's card in the current battle. */
function battlerOf(s: GameState, side: Side): number | undefined {
  const b = s.battle;
  if (!b) return undefined;
  return b.atkSide === side ? b.attacker : b.target;
}

export function targetCandidates(s: GameState, src: number, owner: Side, t: Target, ctx: { prev: number[] }): number[] {
  if (t.ref === 'this') return inPlay(s, src) ? [src] : [];
  if (t.ref === 'prev') return ctx.prev.filter((u) => inPlay(s, u));
  if (t.ref === 'leader') return [s.p[owner].leader];
  if (t.ref === 'oppLeader') return [s.p[other(owner)].leader];
  if (t.ref === 'battler' || t.ref === 'oppBattler') {
    const u = battlerOf(s, t.ref === 'battler' ? owner : other(owner));
    return u !== undefined && matchesFilter(s, u, t.filter, src) ? [u] : [];
  }
  const sides: Side[] = t.side === 'self' ? [owner] : t.side === 'opp' ? [other(owner)] : [owner, other(owner)];
  const out: number[] = [];
  for (const side of sides) {
    const pl = s.p[side];
    if (t.zones.includes('leader') && matchesFilter(s, pl.leader, t.filter, src)) out.push(pl.leader);
    if (t.zones.includes('field') && pl.field !== null && matchesFilter(s, pl.field, t.filter, src)) out.push(pl.field);
    if (t.zones.includes('battle'))
      for (const u of pl.battle) {
        if (!matchesFilter(s, u, t.filter, src)) continue;
        if (side !== owner && hasKeyword(s, u, 'barrier')) continue;
        out.push(u);
      }
  }
  return out;
}

const INTENT: Partial<Record<Effect['t'], ChoiceReq['intent']>> = { negate: 'harm', redirect: 'buff',
  ko: 'harm', bounce: 'harm', bottom: 'harm', rest: 'harm', lockActive: 'harm', toDrop: 'harm', toEnergy: 'harm',
  activate: 'buff', grant: 'buff', comboPower: 'buff', ki: 'buff', placeUnder: 'buff',
};

function intentOf(e: Effect): ChoiceReq['intent'] {
  if (e.t === 'power') return e.amount >= 0 ? 'buff' : 'harm';
  if (e.t === 'costMod') return e.amount <= 0 ? (e.target.side === 'self' ? 'buff' : 'harm') : 'buff';
  if (e.t === 'grant') return /^cant|^cantBe/.test(e.kw) ? 'harm' : 'buff';
  return INTENT[e.t] ?? 'buff';
}

function chooseTargets(s: GameState, src: number, owner: Side, e: Effect & { target: Target }, ctx: Ctx, ctl: Choosers): number[] {
  const t = e.target;
  const cands = targetCandidates(s, src, owner, t, ctx);
  if (t.ref || t.all) return cands;
  if (cands.length === 0) return [];
  const min = t.upTo ? 0 : Math.min(t.count, cands.length);
  const max = Math.min(t.count, cands.length);
  // "Your opponent KO's 1 ...": they pick, and pick what hurts them least.
  const who = t.chooser === 'opp' ? other(owner) : owner;
  const intent = t.chooser === 'opp' ? 'lose' : intentOf(e);
  const pick = ctl[who].choose(s, { kind: 'target', player: who, src, options: cands, min: t.chooser === 'opp' ? max : min, max, effect: e, intent });
  return pick.slice(0, max);
}

function untilOf(s: GameState, dur: string): 'battle' | number {
  if (dur === 'game') return 1e9;
  if (dur === 'battle') return s.battle ? 'battle' : s.turn;
  if (dur === 'oppNextTurn') return s.turn + 1;
  return s.turn;
}

function pickFrom(s: GameState, owner: Side, src: number, options: number[], max: number, ctl: Choosers, intent: ChoiceReq['intent'] = 'gain', min = 0): number[] {
  if (options.length === 0 || max <= 0) return [];
  return ctl[owner].choose(s, { kind: 'pick', player: owner, src, options, min: Math.min(min, options.length), max: Math.min(max, options.length), intent }).slice(0, max);
}

function addMod(s: GameState, p: Side, m: PlayerMod) {
  (s.p[p].mods ??= []).push(m);
}

function runEffect(s: GameState, src: number, owner: Side, e: Effect, ctx: Ctx, ctl: Choosers) {
  const me = s.p[owner];
  const by: ByWhom = { skillOf: owner };
  switch (e.t) {
    case 'draw': drawCards(s, owner, e.per ? e.n * countOf(s, owner, src, e.per, ctx) : e.n); return;
    case 'lifeToHand': {
      let n = Math.min(e.n, me.life.length);
      if (e.upTo && n > 0) {
        const yes = ctl[owner].choose(s, { kind: 'yesno', player: owner, src, options: [1], min: 0, max: 1, effect: e, intent: 'gain' });
        if (!yes.length) n = 0;
      }
      if (n > 0) takeLife(s, owner, n, false);
      return;
    }
    case 'power': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl);
      const until = e.dur === 'static' ? s.turn : untilOf(s, e.dur);
      const amount = e.per ? e.amount * countOf(s, owner, src, e.per, ctx) : e.amount;
      for (const u of ts) s.inst[u].mods.push({ amount, until });
      ctx.prev = ts;
      return;
    }
    case 'comboPower': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl);
      // The card is in the Combo Area by now; "this card" means it.
      const list = ts.length ? ts : [src];
      for (const u of list) s.inst[u].comboBonus += e.amount;
      return;
    }
    case 'ko': { const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts; for (const u of ts) koCard(s, u, ctl, { ...by, src }); return; }
    case 'bounce': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) { if (!removable(s, u, by)) continue; moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: s.inst[u].owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'bottom': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (removable(s, u, by)) moveTo(s, u, 'deck', { bottom: true });
      return;
    }
    case 'toDrop': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) {
        if (!removable(s, u, by)) continue;
        const p = s.p[s.inst[u].owner];
        if (p.field === u) { removeFrom(s, u); p.drop.push(u); } else moveTo(s, u, 'drop');
        emit(s, { t: 'toDrop', p: s.inst[u].owner, id: s.inst[u].id, uid: u });
      }
      return;
    }
    case 'toEnergy': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (removable(s, u, by)) { moveTo(s, u, 'energy', { rested: e.rested }); emit(s, { t: 'toEnergy', p: s.inst[u].owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'rest': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (!(s.inst[u].owner !== owner && hasKeyword(s, u, 'cantBeRested'))) s.inst[u].rested = true;
      return;
    }
    case 'activate': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (s.inst[u].lockedUntil < s.turn) s.inst[u].rested = false;
      return;
    }
    case 'lockActive': { const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts; for (const u of ts) s.inst[u].lockedUntil = s.turn + 1; return; }
    case 'grant': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) s.inst[u].grants.push({ kw: e.kw, until: e.dur === 'static' ? s.turn : untilOf(s, e.dur) });
      return;
    }
    case 'costMod': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      const until = e.dur === 'static' ? s.turn : untilOf(s, e.dur);
      const amount = e.per ? e.amount * countOf(s, owner, src, e.per, ctx) : e.amount;
      for (const u of ts) (s.inst[u].costMods ??= []).push({ amount, until });
      return;
    }
    case 'search': {
      const top = me.deck.splice(Math.max(0, me.deck.length - e.look));
      const match = top.filter((u) => e.options.some((f) => matchesFilter(s, u, f, src)));
      const pick = pickFrom(s, owner, src, match, e.take, ctl);
      const dest = e.dest ?? (e.toHand ? 'hand' : 'hand');
      const rest = top.filter((u) => !pick.includes(u));
      // Return the rest first so a play from the look sees a consistent deck.
      if ((e.rest ?? 'bottom') === 'drop') { for (const u of rest) me.drop.push(u); }
      else if (e.rest === 'top') me.deck.push(...rest);
      else me.deck.unshift(...shuffle(s, rest));
      ctx.prev = pick;
      for (const u of pick) {
        emit(s, { t: 'reveal', p: owner, id: s.inst[u].id, uid: u });
        if (dest === 'hand') me.hand.push(u);
        else if (dest === 'drop') me.drop.push(u);
        else if (dest === 'life') me.life.push(u);
        else { me.hand.push(u); playCard(s, u, ctl); }
      }
      checkDeckOut(s);
      return;
    }
    case 'dropToHand': {
      const taken: number[] = [];
      for (const f of e.options) {
        const cands = me.drop.filter((u) => !taken.includes(u) && matchesFilter(s, u, f, src));
        taken.push(...pickFrom(s, owner, src, cands, e.each, ctl));
      }
      for (const u of taken) { moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'playFrom': {
      const pool = e.from === 'drop' ? me.drop : e.from === 'hand' ? me.hand : e.from === 'energy' ? me.energy : me.deck;
      const cands = pool.filter((u) => u !== src && matchesFilter(s, u, e.filter, src) && (cardOf(s, u).type === 'BATTLE' || (e.extraType && cardOf(s, u).type === 'EXTRA')));
      for (const u of pickFrom(s, owner, src, cands, e.n, ctl)) {
        if (cardOf(s, u).type === 'EXTRA') placeField(s, u, ctl);
        else playCard(s, u, ctl, { rested: e.rested, byLeader: isLeader(s, src), negate: e.negate });
      }
      if (e.from === 'deck') shuffle(s, me.deck);
      return;
    }
    case 'energyFromDeck': {
      for (let i = 0; i < e.n; i++) {
        const u = me.deck.pop();
        if (u === undefined) break;
        me.energy.push(u);
        s.inst[u].rested = e.rested;
        emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u });
      }
      checkDeckOut(s);
      return;
    }
    case 'energyFromDrop': {
      const cands = me.drop.filter((u) => matchesFilter(s, u, e.filter, src));
      for (const u of pickFrom(s, owner, src, cands, e.n, ctl)) { moveTo(s, u, 'energy', { rested: e.rested }); emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'energyFromLife': {
      for (let i = 0; i < e.n; i++) {
        const u = me.life.pop();
        if (u === undefined) break;
        me.energy.push(u);
        s.inst[u].rested = e.rested;
        emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u });
        if (me.life.length === 0 && s.rules.loseAtZeroLife) { setWinner(s, other(owner), 'life reached 0'); return; }
      }
      return;
    }
    case 'energyFromHand': {
      const opts = me.hand.filter((u) => !e.filter || matchesFilter(s, u, e.filter, src));
      for (const u of pickFrom(s, owner, src, opts, e.n, ctl, 'lose')) { moveTo(s, u, 'energy', { rested: e.rested }); emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'activateEnergy': {
      let k = e.n;
      for (const u of me.energy) if (k > 0 && s.inst[u].rested) { s.inst[u].rested = false; k--; }
      return;
    }
    case 'discard': {
      const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src, options: me.hand.slice(), min: Math.min(e.n, me.hand.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'discard', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'oppDiscard': {
      const opp = other(owner);
      const hand = s.p[opp].hand;
      const pick = ctl[opp].choose(s, { kind: 'discard', player: opp, src, options: hand.slice(), min: Math.min(e.n, hand.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'discard', p: opp, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'mill': millCards(s, owner, e.n, ctl); return;
    case 'costReduce': return; // read by costInHand
    case 'cantBlock': if (s.battle) s.battle.cantBlock = true; return;
    case 'damageLeader': takeLife(s, other(owner), e.n, false, ctl); return;
    case 'flipLeader': {
      if (!me.awakened) { me.awakened = true; log(s, `P${owner} awakens ${nameOf(s, me.leader)}`); }
      return;
    }
    case 'ki': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      const n = e.per ? e.n * countOf(s, owner, src, e.per, ctx) : e.n;
      for (const u of ts) s.inst[u].ki += n;
      if (ts.length) log(s, `${ts.map((u) => nameOf(s, u)).join(', ')} +${e.n} Ki`);
      return;
    }
    case 'placeMarker': me.markers += e.n; log(s, `P${owner} places ${e.n} energy marker`); return;
    case 'lifeFromDeck': {
      for (let i = 0; i < e.n; i++) { const u = me.deck.pop(); if (u === undefined) break; me.life.push(u); }
      checkDeckOut(s);
      return;
    }
    case 'handToLife': {
      const pick = pickFrom(s, owner, src, me.hand.slice(), e.n, ctl, 'lose', e.upTo ? 0 : e.n);
      for (const u of pick) { removeFrom(s, u); resetInst(s.inst[u]); me.life.push(u); }
      return;
    }
    case 'handToDeck': {
      const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src, options: me.hand.slice(), min: Math.min(e.n, me.hand.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) moveTo(s, u, 'deck', { bottom: e.bottom });
      return;
    }
    case 'self': {
      if (e.to === 'play') {
        if (!inPlay(s, src) && cardOf(s, src).type === 'BATTLE') playCard(s, src, ctl, { rested: e.rested });
        return;
      }
      if (isLeader(s, src)) return;
      if (me.field === src) { removeFrom(s, src); me.field = null; }
      if (e.to === 'hand') moveTo(s, src, 'hand');
      else if (e.to === 'drop') moveTo(s, src, 'drop');
      else if (e.to === 'energy') moveTo(s, src, 'energy', { rested: e.rested });
      else moveTo(s, src, 'deck', { bottom: true });
      return;
    }
    case 'nextDiscount': addMod(s, owner, { kind: 'discount', filter: e.filter, amount: e.amount, until: s.turn }); return;
    case 'cantPlay': addMod(s, owner, { kind: 'cantPlay', filter: e.filter, extras: e.extras, until: e.dur === 'game' ? 1e9 : e.dur === 'oppNextTurn' ? s.turn + 1 : s.turn }); return;
    case 'lockSkill': addMod(s, owner, { kind: 'skillLock', filter: { names: e.names }, timing: e.timing, until: e.dur === 'oppNextTurn' ? s.turn + 1 : s.turn }); return;
    case 'atEndOfTurn': (s.p[s.active].atEnd ??= []).push({ src, effects: e.effects }); return;
    case 'dropToDeck': { for (const u of me.drop.splice(0)) { resetInst(s.inst[u]); me.deck.push(u); } shuffle(s, me.deck); return; }
    case 'lifeToDeck': {
      const pick = pickFrom(s, owner, src, me.life.slice(), e.n, ctl, 'gain', Math.min(e.n, me.life.length));
      for (const u of pick) { me.life.splice(me.life.indexOf(u), 1); me.deck.push(u); }
      if (me.life.length === 0 && s.rules.loseAtZeroLife) setWinner(s, other(owner), 'life reached 0');
      shuffle(s, me.life);
      return;
    }
    case 'oppTax': addMod(s, other(owner), { kind: 'tax', filter: e.filter ?? {}, amount: e.amount, until: s.turn + 1 }); return;
    case 'oppPlayRested': addMod(s, other(owner), { kind: 'playRested', filter: e.filter, until: s.turn + 1 }); return;
    case 'placeUnder': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl);
      const top = ts[0];
      if (top === undefined) return;
      const pool = e.from === 'drop' ? me.drop : e.from === 'hand' ? me.hand : e.from === 'battle' ? me.battle : me.deck;
      const taken: number[] = [];
      for (const f of e.filters.length ? e.filters : [{}]) {
        const cands = pool.filter((u) => u !== top && !taken.includes(u) && matchesFilter(s, u, f, src));
        taken.push(...pickFrom(s, owner, src, cands, e.n, ctl));
      }
      for (const u of taken) { removeFrom(s, u); resetInst(s.inst[u]); (s.inst[top].under ??= []).push(u); }
      return;
    }
    case 'choose': {
      const idx = ctl[owner].choose(s, { kind: 'mode', player: owner, src, options: e.options.map((_, i) => i), min: 1, max: 1, intent: 'gain', effect: e })[0] ?? 0;
      runEffects(s, src, owner, e.options[idx] ?? [], ctx, ctl);
      return;
    }
    case 'comboFrom': {
      if (!s.battle) return;
      if (e.from === 'drop') {
        const cands = me.drop.filter((u) => cardOf(s, u).type === 'BATTLE' && matchesFilter(s, u, e.filter, src));
        for (const u of pickFrom(s, owner, src, cands, e.n, ctl)) { moveTo(s, u, 'combo'); s.battle.comboCount[owner]++; emit(s, { t: 'combo', p: owner, id: s.inst[u].id, uid: u, fromHand: false }); }
      } else {
        const u = me.deck[me.deck.length - 1];
        if (u !== undefined && cardOf(s, u).type === 'BATTLE' && matchesFilter(s, u, e.filter, src)) { moveTo(s, u, 'combo'); s.battle.comboCount[owner]++; }
        checkDeckOut(s);
      }
      return;
    }
    case 'negate': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      const until = e.dur === 'oppNextTurn' ? s.turn + 1 : e.dur === 'game' ? 1e9 : s.turn;
      for (const u of ts) { s.inst[u].negatedUntil = until; s.inst[u].negateScope = e.scope ?? 'all'; }
      return;
    }
    case 'redirect': {
      if (!s.battle) return;
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      if (ts.length) { s.battle.target = ts[0]; log(s, `attack redirected to ${nameOf(s, ts[0])}`); }
      return;
    }
    case 'noop': return;
  }
}

export { removeFrom, cardOf };
