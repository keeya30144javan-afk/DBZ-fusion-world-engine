import { Ability, Cost, Effect, Target } from '../effects/types';
import {
  GameState, Side, abilitiesOf, cardOf, condsHold, emit, hasKeyword, isLeader, log, matchesFilter, moveTo, nameOf,
  other, planPayment, payPlan, powerOf, removeFrom, shuffle,
} from './core';

export interface ChoiceReq {
  kind: 'target' | 'discard' | 'pick' | 'energyToDrop' | 'yesno';
  player: Side;
  src: number;
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

export function drawCards(s: GameState, p: Side, n: number) {
  for (let i = 0; i < n; i++) {
    const top = s.p[p].deck.pop();
    if (top === undefined) {
      if (s.rules.loseOnEmptyDraw) setWinner(s, other(p), 'deck out');
      return;
    }
    s.p[p].hand.push(top);
  }
  if (n > 0) emit(s, { t: 'draw', p, n });
}

/** Take n life. toDrop for [Critical]. */
export function takeLife(s: GameState, p: Side, n: number, toDrop: boolean) {
  const me = s.p[p];
  for (let i = 0; i < n; i++) {
    if (me.life.length === 0) {
      if (!s.rules.loseAtZeroLife) setWinner(s, other(p), 'damage at 0 life');
      return;
    }
    const top = me.life.pop()!;
    if (toDrop) { me.drop.push(top); emit(s, { t: 'toDrop', p, id: s.inst[top].id, uid: top }); }
    else me.hand.push(top);
    if (me.life.length === 0 && s.rules.loseAtZeroLife) { setWinner(s, other(p), 'life reached 0'); return; }
  }
  if (!toDrop) emit(s, { t: 'lifeToHand', p, n });
}

// ------------------------------------------------------------------ zero power, KO

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

export function koCard(s: GameState, uid: number, ctl: Choosers) {
  const owner = s.inst[uid].owner;
  if (!s.p[owner].battle.includes(uid)) return;
  if (hasKeyword(s, uid, 'indestructible')) return;
  moveTo(s, uid, 'drop');
  log(s, `${nameOf(s, uid)} is KO'd`);
  emit(s, { t: 'ko', p: owner, id: s.inst[uid].id });
  emit(s, { t: 'toDrop', p: owner, id: s.inst[uid].id, uid });
  fireTriggers(s, uid, 'whenKOd', ctl);
}

export function playCard(s: GameState, uid: number, ctl: Choosers) {
  const owner = s.inst[uid].owner;
  moveTo(s, uid, 'battle');
  s.inst[uid].playedTurn = s.turn;
  log(s, `P${owner} plays ${nameOf(s, uid)}`);
  emit(s, { t: 'play', p: owner, id: s.inst[uid].id, uid });
  fireTriggers(s, uid, 'onPlay', ctl);
}

// ------------------------------------------------------------------ triggers

export function fireTriggers(s: GameState, uid: number, timing: Ability['timing'], ctl: Choosers) {
  const abs = abilitiesOf(s, uid);
  for (let i = 0; i < abs.length; i++) {
    const ab = abs[i];
    if (ab.timing !== timing) continue;
    if (s.stage === 'over') return;
    const owner = s.inst[uid].owner;
    if (ab.turn === 'your' && s.active !== owner) continue;
    if (ab.turn === 'opp' && s.active === owner) continue;
    if (ab.once && s.p[owner].usedOnce.includes(onceKey(s, uid, i))) continue;
    resolveAbility(s, uid, ab, i, ctl);
  }
}

/** A costless activated skill without [Once Per Turn] would repeat forever; treat it as once per turn. */
export const isFreeRepeatable = (ab: Ability) => (ab.timing === 'activateMain' || ab.timing === 'activateBattle') && ab.cost.length === 0;

export const onceKey = (s: GameState, uid: number, idx: number) => `${uid}:${idx}:${isLeader(s, uid) && s.p[s.inst[uid].owner].awakened ? 'b' : 'f'}`;

// ------------------------------------------------------------------ costs

export function canPayCosts(s: GameState, uid: number, costs: Cost[], excludeFromHand = -1): boolean {
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  let energyNeeded = 0;
  for (const c of costs) {
    switch (c.t) {
      case 'discard': if (me.hand.filter((u) => u !== excludeFromHand).length < c.n) return false; break;
      case 'energyToDrop': if (me.energy.length < c.n) return false; break;
      case 'restSelf': if (s.inst[uid].rested) return false; break;
      case 'restEnergy': energyNeeded += c.n; break;
      case 'lifeToHand': if (me.life.length < c.n) return false; break;
      case 'selfToDrop': break;
    }
  }
  if (energyNeeded && !planPayment(s, owner, energyNeeded, {})) return false;
  return true;
}

function payCosts(s: GameState, uid: number, costs: Cost[], ctl: Choosers) {
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  for (const c of costs) {
    switch (c.t) {
      case 'discard': {
        const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src: uid, options: me.hand.filter((u) => u !== uid), min: c.n, max: c.n, intent: 'lose' });
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
      case 'selfToDrop': moveTo(s, uid, 'drop'); break;
    }
  }
}

// ------------------------------------------------------------------ resolving

interface Ctx { prev: number[] }

export function resolveAbility(s: GameState, uid: number, ab: Ability, idx: number, ctl: Choosers, opts: { costsPaid?: boolean } = {}): boolean {
  const owner = s.inst[uid].owner;
  if (!condsHold(s, owner, uid, ab.cond)) return false;
  if (!opts.costsPaid) {
    if (!canPayCosts(s, uid, ab.cost)) return false;
    payCosts(s, uid, ab.cost, ctl);
  }
  if (ab.once || isFreeRepeatable(ab)) s.p[owner].usedOnce.push(onceKey(s, uid, idx));
  const ctx: Ctx = { prev: [] };
  for (const e of ab.effects) {
    if (s.stage === 'over') return true;
    if (!condsHold(s, owner, uid, (e as any).cond)) continue;
    runEffect(s, uid, owner, e, ctx, ctl);
  }
  checkZeroPower(s, ctl);
  return true;
}

export function targetCandidates(s: GameState, src: number, owner: Side, t: Target, ctx: { prev: number[] }): number[] {
  if (t.ref === 'this') return isLeader(s, src) || s.p[s.inst[src].owner].battle.includes(src) ? [src] : [];
  if (t.ref === 'prev') return ctx.prev.filter((u) => isLeader(s, u) || s.p[s.inst[u].owner].battle.includes(u));
  if (t.ref === 'leader') return [s.p[owner].leader];
  const sides: Side[] = t.side === 'self' ? [owner] : t.side === 'opp' ? [other(owner)] : [owner, other(owner)];
  const out: number[] = [];
  for (const side of sides) {
    const pl = s.p[side];
    if (t.zones.includes('leader') && matchesFilter(s, pl.leader, t.filter, src)) out.push(pl.leader);
    if (t.zones.includes('battle'))
      for (const u of pl.battle) {
        if (!matchesFilter(s, u, t.filter, src)) continue;
        if (side !== owner && hasKeyword(s, u, 'barrier')) continue;
        out.push(u);
      }
  }
  return out;
}

const INTENT: Partial<Record<Effect['t'], ChoiceReq['intent']>> = {
  ko: 'harm', bounce: 'harm', bottom: 'harm', rest: 'harm', lockActive: 'harm',
  activate: 'buff', grant: 'buff', comboPower: 'buff',
};

function chooseTargets(s: GameState, src: number, owner: Side, e: Effect & { target: Target }, ctx: Ctx, ctl: Choosers): number[] {
  const t = e.target;
  const cands = targetCandidates(s, src, owner, t, ctx);
  if (t.ref) return cands;
  if (cands.length === 0) return [];
  const intent = e.t === 'power' ? (e.amount >= 0 ? 'buff' : 'harm') : INTENT[e.t] ?? 'buff';
  const min = t.upTo ? 0 : Math.min(t.count, cands.length);
  const max = Math.min(t.count, cands.length);
  const pick = ctl[owner].choose(s, { kind: 'target', player: owner, src, options: cands, min, max, effect: e, intent });
  return pick.slice(0, max);
}

function untilOf(s: GameState, dur: string): 'battle' | number {
  if (dur === 'battle') return s.battle ? 'battle' : s.turn;
  if (dur === 'oppNextTurn') return s.turn + 1;
  return s.turn;
}

function pickFrom(s: GameState, owner: Side, src: number, options: number[], max: number, ctl: Choosers, intent: ChoiceReq['intent'] = 'gain', min = 0): number[] {
  if (options.length === 0 || max <= 0) return [];
  return ctl[owner].choose(s, { kind: 'pick', player: owner, src, options, min: Math.min(min, options.length), max: Math.min(max, options.length), intent }).slice(0, max);
}

function runEffect(s: GameState, src: number, owner: Side, e: Effect, ctx: Ctx, ctl: Choosers) {
  const me = s.p[owner];
  switch (e.t) {
    case 'draw': drawCards(s, owner, e.n); return;
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
      for (const u of ts) s.inst[u].mods.push({ amount: e.amount, until });
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
    case 'ko': { const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts; for (const u of ts) koCard(s, u, ctl); return; }
    case 'bounce': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) { if (isLeader(s, u)) continue; moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: s.inst[u].owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'bottom': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (!isLeader(s, u)) moveTo(s, u, 'deck', { bottom: true });
      return;
    }
    case 'rest': { const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts; for (const u of ts) s.inst[u].rested = true; return; }
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
    case 'search': {
      const top = me.deck.splice(Math.max(0, me.deck.length - e.look));
      const match = top.filter((u) => e.options.some((f) => matchesFilter(s, u, f, src)));
      const pick = pickFrom(s, owner, src, match, e.take, ctl);
      for (const u of pick) { me.hand.push(u); emit(s, { t: 'reveal', p: owner, id: s.inst[u].id, uid: u }); }
      const rest = shuffle(s, top.filter((u) => !pick.includes(u)));
      me.deck.unshift(...rest);
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
      const pool = e.from === 'drop' ? me.drop : e.from === 'hand' ? me.hand : me.deck;
      const cands = pool.filter((u) => matchesFilter(s, u, e.filter, src));
      for (const u of pickFrom(s, owner, src, cands, e.n, ctl)) playCard(s, u, ctl);
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
      for (const u of pickFrom(s, owner, src, me.hand.slice(), e.n, ctl, 'lose')) { moveTo(s, u, 'energy', { rested: e.rested }); emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u }); }
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
    case 'mill': {
      for (let i = 0; i < e.n; i++) { const u = me.deck.pop(); if (u === undefined) break; me.drop.push(u); emit(s, { t: 'toDrop', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'costReduce': return; // read by costInHand
    case 'cantBlock': if (s.battle) s.battle.cantBlock = true; return;
    case 'damageLeader': takeLife(s, other(owner), e.n, false); return;
    case 'flipLeader': {
      if (!me.awakened) { me.awakened = true; log(s, `P${owner} awakens ${nameOf(s, me.leader)}`); }
      return;
    }
  }
}

export { removeFrom, cardOf };
