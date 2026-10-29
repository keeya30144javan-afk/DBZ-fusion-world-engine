import { Ability, Cost, Effect, Filter, Target } from '../effects/types';
import { compileCard } from '../effects/parse';
import { describeCost, describeEffect } from '../effects/describe';
import {
  EvalCtx, GameState, PlayerMod, Side, abilitiesOf, activeMods, cardOf, condsHold, costOf, countOf, emit, hasKeyword, inPlay, isLeader, log, matchesFilter, moveTo, nameOf,
  other, planPayment, payPlan, powerOf, rand, removeFrom, resetInst, shuffle, staticRules, turnMatches, valOf, withCtx, zoneOf,
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
  /** 'mode' questions that aren't a choose effect: one label per option. */
  labels?: string[];
  /** The card a 'mode' question is about (where to put it). */
  about?: number;
  /** The question to show a person for a yes/no (what the skill would do). */
  question?: string;
  /** Choosing how many Ki to remove (options are the amounts). */
  kiChoice?: boolean;
  /** Resting cards to pay an attack tax ("can't attack unless they switch 1 Active card to Rest Mode"). */
  tax?: boolean;
}

/** "At the top or bottom of the deck": true for the bottom. */
export function chooseBottom(s: GameState, owner: Side, src: number, u: number, ctl: Choosers): boolean {
  return ctl[owner].choose(s, { kind: 'mode', player: owner, src, options: [0, 1], min: 1, max: 1, intent: 'gain', labels: ['Top of the deck', 'Bottom of the deck'], about: u })[0] === 1;
}

export interface Chooser {
  choose(s: GameState, req: ChoiceReq): number[];
}
export type Choosers = [Chooser, Chooser];

// ------------------------------------------------------------------ win/lose

export function setWinner(s: GameState, winner: Side | -1, reason: string) {
  if (s.stage === 'over') return;
  if (winner !== -1 && reason !== 'turn limit') {
    const loser = other(winner);
    // "You will not lose the game for the turn."
    if (activeMods(s, loser).some((m) => m.kind === 'cantLose')) { log(s, () => `P${loser} can't lose this turn (${reason})`); return; }
    // "If you would lose the game due to your life becoming 0, you may add this card from your Battle Area to your life instead."
    if (reason === 'life reached 0' || reason === 'damage at 0 life') {
      const me = s.p[loser];
      for (const u of me.battle) {
        const ab = abilitiesOf(s, u).find((a) => a.timing === 'replace' && a.replace?.lose && condsHold(s, loser, u, a.cond));
        if (!ab) continue;
        removeFrom(s, u);
        resetInst(s.inst[u]);
        me.life.push(u);
        log(s, () => `${nameOf(s, u)} goes to P${loser}'s life instead of losing`);
        return;
      }
    }
  }
  s.stage = 'over';
  s.winner = winner;
  s.reason = reason;
  s.battle = null;
  log(s, () => `GAME OVER: ${winner === -1 ? 'draw' : `P${winner} wins`} (${reason})`);
  emit(s, { t: 'over', winner, reason });
}

/** Sorbet / Golden Frieza: "You will not lose the game even if you have 0 cards in your deck." */
const NO_DECK_OUT = /(will not|don't|do not) lose the game even if you have 0 cards in your deck/i;
function ignoresDeckOut(s: GameState, p: Side): boolean {
  const lc = cardOf(s, s.p[p].leader);
  const text = s.p[p].awakened && lc.back ? lc.back.text : lc.text;
  return NO_DECK_OUT.test(text) || s.p[p].battle.some((u) => NO_DECK_OUT.test(cardOf(s, u).text));
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
    me.lifeLeftTurn = s.turn;
    taken++;
    if (toDrop) { me.drop.push(top); emit(s, { t: 'toDrop', p, id: s.inst[top].id, uid: top }); }
    else me.hand.push(top);
    if (me.life.length === 0 && s.rules.loseAtZeroLife) { setWinner(s, other(p), 'life reached 0'); return; }
  }
  if (!toDrop && taken) emit(s, { t: 'lifeToHand', p, n: taken });
  if (ctl && taken) for (const u of fieldOf(s, p)) fireTriggers(s, u, 'whenDamaged', ctl);
}

/** Damage to a player (battle or skill): "negate the next damage you take" shields come first. */
export function dealDamage(s: GameState, p: Side, n: number, crit: boolean, ctl: Choosers) {
  const mods = s.p[p].mods;
  const i = mods ? mods.findIndex((m) => m.kind === 'shield' && m.until >= s.turn) : -1;
  if (i >= 0 && n > 0) { mods!.splice(i, 1); log(s, () => `P${p}'s damage is negated`); return; }
  takeLife(s, p, n, crit, ctl);
}

/** Flip the Leader: power changes and Ki carry over, granted keywords ([Critical]...) don't (official Q635). */
export function awakenLeader(s: GameState, p: Side) {
  s.p[p].awakened = true;
  s.inst[s.p[p].leader].grants = [];
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
        moveTo(s, u, 'drop', { quiet: true });
        log(s, () => `${nameOf(s, u)} drops at 0 power`);
        emit(s, { t: 'toDrop', p: side, id: s.inst[u].id, uid: u });
      }
    }
  }
  void ctl;
}

/** Who is trying to remove a card, for immunity checks. */
export interface ByWhom { skillOf?: Side; src?: number; battle?: boolean }

export function koCard(s: GameState, uid: number, ctl: Choosers, by: ByWhom = {}): boolean {
  const owner = s.inst[uid].owner;
  if (!s.p[owner].battle.includes(uid)) return false;
  if (hasKeyword(s, uid, 'indestructible') || hasKeyword(s, uid, 'koImmune')) return false;
  if (by.battle && hasKeyword(s, uid, 'koImmuneBattle')) return false;
  const oppSkill = by.skillOf !== undefined && by.skillOf !== owner;
  if (oppSkill && (hasKeyword(s, uid, 'koImmuneSkills') || hasKeyword(s, uid, 'removeImmune'))) return false;
  if (hasKeyword(s, uid, 'koImmuneOnce') && s.inst[uid].koShieldTurn !== s.turn) {
    s.inst[uid].koShieldTurn = s.turn;
    log(s, () => `${nameOf(s, uid)} survives (can't be KO'd once per turn)`);
    return false;
  }
  if (tryReplace(s, uid, true, by, ctl)) return false;
  if (by.src !== undefined && s.inst[by.src].owner !== owner) (s.p[s.inst[by.src].owner].koBy ??= []).push({ turn: s.turn, uid: by.src, ...(by.battle ? { battle: true } : {}) });
  moveTo(s, uid, 'drop', { quiet: true });
  log(s, () => `${nameOf(s, uid)} is KO'd`);
  emit(s, { t: 'ko', p: owner, id: s.inst[uid].id });
  emit(s, { t: 'toDrop', p: owner, id: s.inst[uid].id, uid });
  // A KO by a skill (or its cost) triggers [When KO'd] once that skill has finished resolving
  // (official Q587/Q591: Boujack switches to Active before the KO'd Zangya draws).
  if (s.skillBy !== undefined) (s.removals ??= []).push({ uid, owner, by: s.skillBy, kind: 'ko' });
  else firedKO(s, uid, owner, ctl);
  return true;
}

function firedKO(s: GameState, uid: number, owner: Side, ctl: Choosers) {
  fireTriggers(s, uid, 'whenKOd', ctl);
  for (const u of fieldOf(s, owner)) {
    if (s.stage === 'over') break;
    fireTriggers(s, u, 'whenAllyKOd', ctl, uid);
  }
}

/** Can an effect from `by` take this card out of the Battle Area? (A replacement effect may step in instead.) */
function removable(s: GameState, uid: number, by: ByWhom, ctl: Choosers): boolean {
  if (isLeader(s, uid)) return false;
  const owner = s.inst[uid].owner;
  if (by.skillOf !== undefined && by.skillOf !== owner && hasKeyword(s, uid, 'removeImmune')) return false;
  return !(s.p[owner].battle.includes(uid) && tryReplace(s, uid, false, by, ctl));
}

const replacing = new WeakMap<GameState, Set<number>>();

/**
 * "If <card> would be removed / KO'd by <who>, [you may] <do this> instead." Looks for a replacement on the
 * owner's cards in play; pays it and returns true when the removal is replaced.
 */
function tryReplace(s: GameState, uid: number, ko: boolean, by: ByWhom, ctl: Choosers): boolean {
  const owner = s.inst[uid].owner;
  const oppSkill = by.skillOf !== undefined && by.skillOf !== owner;
  const opp = oppSkill || (by.battle === true && by.src !== undefined && s.inst[by.src].owner !== owner);
  let busy = replacing.get(s);
  if (busy?.has(uid)) return false;
  for (const src of fieldOf(s, owner)) {
    const abs = abilitiesOf(s, src);
    for (let i = 0; i < abs.length; i++) {
      const ab = abs[i];
      const r = ab.replace;
      if (ab.timing !== 'replace' || !r) continue;
      if (r.what === 'this' ? src !== uid : src === uid || (r.filter !== undefined && !matchesFilter(s, uid, r.filter, src))) continue;
      if (r.ko && !ko) continue;
      if ((r.by === 'opp' && !opp) || (r.by === 'oppSkill' && !oppSkill)) continue;
      if (!turnMatches(s, owner, ab.turn) || !condsHold(s, owner, src, ab.cond) || !canPayCosts(s, src, ab.cost)) continue;
      if (ab.once && s.p[owner].usedOnce.includes(onceKey(s, src, i))) continue;
      const what = [ab.cost.map(describeCost).join(', '), ...ab.effects.map((e) => describeEffect(e))].filter(Boolean).join(': ');
      const question = `${nameOf(s, uid)} is about to be ${ko ? "KO'd" : 'removed'}. Use ${nameOf(s, src)}'s skill to save it? (${what} instead)`;
      const yes = ctl[owner].choose(s, { kind: 'yesno', player: owner, src, options: [1], min: 0, max: 1, intent: 'gain', question });
      if (!yes.length) continue;
      if (!busy) replacing.set(s, (busy = new Set()));
      busy.add(uid);
      try {
        log(s, () => `${nameOf(s, src)} replaces the removal of ${nameOf(s, uid)}`);
        resolveAbility(s, src, ab, i, ctl);
      } finally { busy.delete(uid); }
      return true;
    }
  }
  return false;
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
  log(s, () => `P${owner} places Field ${nameOf(s, uid)}`);
  emit(s, { t: 'play', p: owner, id: s.inst[uid].id, uid });
  fireTriggers(s, uid, 'onPlay', ctl);
}

export function playCard(s: GameState, uid: number, ctl: Choosers, opts: { rested?: boolean; byLeader?: boolean; negate?: 'all' | 'onPlay' } = {}) {
  const owner = s.inst[uid].owner;
  const forcedRest = activeModsOf(s, owner).some((m) => m.kind === 'playRested' && matchesFilter(s, uid, m.filter, uid))
    || staticRules(s, other(owner), 'oppPlayRested').some((h) => matchesFilter(s, uid, h.e.filter, h.src));
  const from = zoneOf(s, uid);
  moveTo(s, uid, 'battle', { rested: opts.rested || forcedRest });
  if (from === 'hand' || from === 'drop' || from === 'deck' || from === 'life' || from === 'energy') s.inst[uid].playedFrom = from;
  s.inst[uid].playedTurn = s.turn;
  s.inst[uid].playedByLeader = !!opts.byLeader;
  s.inst[uid].playedBySkill = s.skillBy !== undefined;
  s.inst[uid].playedByEvolve = false;
  if (s.skillBy !== undefined) s.inst[uid].markerPaid = false;
  if (opts.negate) { s.inst[uid].negatedUntil = s.turn; s.inst[uid].negateScope = opts.negate; s.zoneRev = (s.zoneRev ?? 0) + 1; }
  log(s, () => `P${owner} plays ${nameOf(s, uid)}`);
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
  if (cardOf(s, uid).type !== 'BATTLE') return;
  for (const u of fieldOf(s, other(owner))) {
    if (s.stage === 'over') return;
    fireTriggers(s, u, 'whenOppPlays', ctl, uid);
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
    if (SUBJECT_TIMINGS.has(timing) && (subject === undefined || (ab.trigger && !matchesFilter(s, subject, ab.trigger, uid)))) continue;
    // A triggered skill with a cost ("Discard 1 card from your hand: ...") is the player's choice:
    // not paying just means the effect doesn't happen.
    if (ab.cost.length && condsHold(s, owner, uid, ab.cond) && canPayCosts(s, uid, ab.cost)) {
      const what = `${ab.cost.map(describeCost).join(', ')}: ${ab.effects.map((e) => describeEffect(e)).join('. Then, ')}`;
      const yes = ctl[owner].choose(s, { kind: 'yesno', player: owner, src: uid, options: [1], min: 0, max: 1, intent: 'gain', question: `Use ${nameOf(s, uid)}'s skill? (${what})` });
      if (!yes.length) continue;
    }
    resolveAbility(s, uid, ab, i, ctl);
  }
}

/** Timings about another card (the subject), filtered by the ability's `trigger`. */
const SUBJECT_TIMINGS = new Set<Ability['timing']>([
  'whenAllyPlayed', 'whenAllyKOd', 'whenAllyAttacks', 'whenAllyRemovedBySelf', 'whenAllyRemovedByOpp', 'whenOppAttacks', 'whenOppPlays',
  'whenAllyActivated', 'whenDiscardBySkill', 'whenAllyDealsDamage', 'whenAllyKOsInBattle', 'whenOppBounced',
]);

/** Fire `timing` on every card of `side` in play, about `subject`. */
export function fireAll(s: GameState, side: Side, timing: Ability['timing'], ctl: Choosers, subject?: number, except?: number) {
  for (const u of fieldOf(s, side)) {
    if (s.stage === 'over') return;
    if (u !== except) fireTriggers(s, u, timing, ctl, subject);
  }
}

/** A costless activated skill without [Once Per Turn] would repeat forever; treat it as once per turn. */
export const isFreeRepeatable = (ab: Ability) => (ab.timing === 'activateMain' || ab.timing === 'activateBattle') && ab.cost.length === 0;

export const onceKey = (s: GameState, uid: number, idx: number) => `${uid}:${idx}:${isLeader(s, uid) && s.p[s.inst[uid].owner].awakened ? 'b' : 'f'}`;

// ------------------------------------------------------------------ costs

/** Your cards in the Battle Area matching f (a [Field] too, when the filter asks for one). */
const ownInPlay = (s: GameState, p: Side, f: Filter, src: number) => {
  const me = s.p[p];
  const pool = f.keyword === 'field' && me.field !== null ? [...me.battle, me.field] : me.battle;
  return pool.filter((u) => matchesFilter(s, u, f, src));
};

/** Cards a "switch N of your cards to Rest Mode" cost may use, and how many each counts as. */
function restPool(s: GameState, src: number, c: Extract<Cost, { t: 'restOwn' }>): number[] {
  const owner = s.inst[src].owner;
  const me = s.p[owner];
  const out = ownInPlay(s, owner, { ...c.filter, active: true }, src);
  if (c.orLeader && !s.inst[me.leader].rested && matchesFilter(s, me.leader, c.filter, src)) out.unshift(me.leader);
  return out;
}
const restWeight = (s: GameState, src: number, u: number) => (isLeader(s, src) && hasKeyword(s, u, 'doubleForRest') ? 2 : 1);

/** "Reduce the skill cost by N" for the next skill on this card. */
function skillDiscountOf(s: GameState, uid: number): number {
  const owner = s.inst[uid].owner;
  const m = activeMods(s, owner).find((x) => x.kind === 'skillDiscount' && matchesFilter(s, uid, x.filter, uid));
  return m ? (m.amount as number) : 0;
}
export function spendSkillDiscount(s: GameState, uid: number) {
  const p = s.p[s.inst[uid].owner];
  const i = (p.mods ?? []).findIndex((x) => x.kind === 'skillDiscount' && x.until >= s.turn && matchesFilter(s, uid, x.filter, uid));
  if (i >= 0) p.mods!.splice(i, 1);
}

export function canPayCosts(s: GameState, uid: number, costs: Cost[], excludeFromHand = -1): boolean {
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  let energyNeeded = 0;
  const hand = me.hand.filter((u) => u !== excludeFromHand && u !== uid);
  for (const c of costs) {
    switch (c.t) {
      case 'discard': if (hand.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid)).length < c.n) return false; break;
      case 'energyToDrop': if (me.energy.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid)).length < c.n) return false; break;
      case 'restSelf': if (s.inst[uid].rested) return false; break;
      case 'restEnergy': energyNeeded += Math.max(0, c.n - skillDiscountOf(s, uid)); break;
      case 'lifeToHand': if (!c.all && me.life.length < c.n) return false; break;
      case 'lifeToDrop': if (me.life.length < c.n) return false; break;
      // Q305: while "negate the next damage" is up, damage can't be taken to pay a cost.
      case 'takeDamage': if (me.life.length < c.n || (me.mods ?? []).some((m) => m.kind === 'shield' && m.until >= s.turn)) return false; break;
      case 'removeMarker': if (me.markers < c.n) return false; break;
      case 'energyToHand': if (me.energy.filter((u) => matchesFilter(s, u, c.filter, uid)).length < c.n) return false; break;
      case 'energyToDeckBottom': if (me.energy.length < c.n) return false; break;
      case 'handOrBattleToBottom': {
        const pool = [...hand, ...me.battle.filter((u) => u !== uid)];
        const used = new Set<number>();
        for (const f of c.filters) {
          const u = pool.find((x) => !used.has(x) && matchesFilter(s, x, f, uid));
          if (u === undefined) return false;
          used.add(u);
        }
        break;
      }
      case 'pickUnder': if (!underCands(s, owner, c, uid).length) return false; break;
      case 'toComboOwn': if (!s.battle || !ownInPlay(s, owner, c.filter, uid).some((u) => u !== s.battle!.attacker && u !== s.battle!.target)) return false; break;
      case 'selfToDrop': case 'selfToHand': case 'selfToDeckBottom': case 'koSelf': break;
      case 'reduceKi': if (kiPool(s, uid, c.scope).reduce((a, u) => a + s.inst[u].ki, 0) < c.n) return false; break;
      case 'koOwn': case 'dropOwn': case 'bounceOwn': case 'bottomOwn': if (ownInPlay(s, owner, c.filter, uid).length < c.n) return false; break;
      case 'restOwn': if (restPool(s, uid, c).reduce((a, u) => a + restWeight(s, uid, u), 0) < c.n) return false; break;
      case 'handToDeckTop': if (hand.length < c.n) return false; break;
      case 'anyOf': if (!c.options.some((o) => canPayCosts(s, uid, o, excludeFromHand))) return false; break;
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

/** Cards matching c.filter under your cards matching c.onto. */
function underCands(s: GameState, owner: Side, c: Extract<Cost, { t: 'pickUnder' }>, src: number): number[] {
  const out: number[] = [];
  for (const u of fieldOf(s, owner)) if (!isLeader(s, u) && matchesFilter(s, u, c.onto, src)) for (const x of s.inst[u].under ?? []) if (matchesFilter(s, x, c.filter, src)) out.push(x);
  return out;
}

function underPool(s: GameState, owner: Side, f: Filter | undefined, src: number): number[] {
  const out: number[] = [];
  for (const u of s.p[owner].battle) if (!f || matchesFilter(s, u, f, src)) out.push(...(s.inst[u].under ?? []));
  return out;
}

/** Pay the costs; returns how much Ki was removed (for "for each Ki removed by this skill") and the cards the costs chose. */
export function payCosts(s: GameState, uid: number, costs: Cost[], ctl: Choosers): { kiRemoved: number; paid: number[] } {
  let kiRemoved = 0;
  const paid: number[] = [];
  const owner = s.inst[uid].owner;
  const me = s.p[owner];
  const pickOwn = (cands: number[], n: number) => ctl[owner].choose(s, { kind: 'pick', player: owner, src: uid, options: cands, min: n, max: n, intent: 'lose' }).slice(0, n);
  for (const c of costs) {
    switch (c.t) {
      case 'discard': {
        const opts = me.hand.filter((u) => u !== uid && (!c.filter || matchesFilter(s, u, c.filter, uid)));
        const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src: uid, options: opts, min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'discard', p: owner, id: s.inst[u].id, uid: u }); }
        noteDiscards(s, owner, Math.min(c.n, pick.length));
        break;
      }
      case 'energyToDrop': {
        const pick = ctl[owner].choose(s, { kind: 'energyToDrop', player: owner, src: uid, options: me.energy.filter((u) => !c.filter || matchesFilter(s, u, c.filter, uid)), min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'toDrop', p: owner, id: s.inst[u].id, uid: u }); }
        break;
      }
      case 'restSelf': s.inst[uid].rested = true; fireTriggers(s, uid, 'whenRestedBySelf', ctl); break;
      case 'restEnergy': {
        const off = skillDiscountOf(s, uid);
        if (off) spendSkillDiscount(s, uid);
        const plan = planPayment(s, owner, Math.max(0, c.n - off), {});
        if (plan) { payPlan(s, owner, plan); s.inst[uid].markerPaid = plan.markers > 0; }
        break;
      }
      case 'lifeToHand': takeLife(s, owner, c.all ? me.life.length : c.n, false); break;
      case 'removeMarker': me.markers -= c.n; me.markerUsedTurn = s.turn; break;
      case 'energyToHand': for (const u of pickOwn(me.energy.filter((x) => matchesFilter(s, x, c.filter, uid)), c.n)) moveTo(s, u, 'hand'); break;
      case 'energyToDeckBottom': for (const u of pickOwn(me.energy.slice(), c.n)) moveTo(s, u, 'deck', { bottom: true }); break;
      case 'handOrBattleToBottom': {
        const taken: number[] = [];
        for (const f of c.filters) {
          const opts = [...me.hand, ...me.battle].filter((x) => x !== uid && !taken.includes(x) && matchesFilter(s, x, f, uid));
          taken.push(...pickOwn(opts, 1));
        }
        for (const u of taken) moveTo(s, u, 'deck', { bottom: true });
        paid.push(...taken);
        break;
      }
      case 'pickUnder': paid.push(...pickOwn(underCands(s, owner, c, uid), 1)); break;
      case 'toComboOwn': {
        if (!s.battle) break;
        const b = s.battle;
        const u = pickOwn(ownInPlay(s, owner, c.filter, uid).filter((x) => x !== b.attacker && x !== b.target), 1)[0];
        if (u === undefined) break;
        moveTo(s, u, 'combo');
        b.comboCount[owner]++;
        me.comboFieldTurn = s.turn;
        emit(s, { t: 'combo', p: owner, id: s.inst[u].id, uid: u, fromHand: false });
        fireTriggers(s, u, 'comboFromField', ctl);
        break;
      }
      case 'lifeToDrop': takeLife(s, owner, c.n, true); break;
      case 'takeDamage': takeLife(s, owner, c.n, false, ctl); break;
      case 'selfToDrop': if (me.field === uid) { removeFrom(s, uid); me.drop.push(uid); } else moveTo(s, uid, 'drop'); break;
      case 'selfToHand': moveTo(s, uid, 'hand'); break;
      case 'selfToDeckBottom': moveTo(s, uid, 'deck', { bottom: true }); break;
      case 'koSelf': koCard(s, uid, ctl); break;
      case 'reduceKi': {
        // Spend Ki from Battle Cards before the Leader: Leader Ki usually gates other skills.
        const pool = kiPool(s, uid, c.scope).sort((a, b) => (isLeader(s, a) ? 1 : 0) - (isLeader(s, b) ? 1 : 0));
        const have = pool.reduce((a, u) => a + s.inst[u].ki, 0);
        let left = c.max ? Math.min(have, c.max) : c.n;
        if (c.choose && left > c.n) {
          // "Remove 2 or more Ki": how many is the player's call (it can decide which card a skill plays).
          const amounts = Array.from({ length: left - c.n + 1 }, (_, i) => c.n + i);
          left = ctl[owner].choose(s, { kind: 'mode', player: owner, src: uid, options: amounts, min: 1, max: 1, intent: 'gain', labels: Object.fromEntries(amounts.map((k) => [k, `Remove ${k} Ki`])) as any, kiChoice: true })[0] ?? left;
        }
        const want = left;
        for (const u of pool) {
          const k = Math.min(left, s.inst[u].ki);
          s.inst[u].ki -= k;
          if (k && s.battle) s.inst[u].kiRemovedBattle = (s.inst[u].kiRemovedBattle ?? 0) + k;
          if (k) { if (isLeader(s, u)) me.kiRemovedLeaderTurn = s.turn; else me.kiRemovedBattleTurn = s.turn; }
          left -= k;
          if (!left) break;
        }
        kiRemoved += want - left;
        if (want - left > 0) me.kiRemovedTurn = s.turn;
        break;
      }
      case 'koOwn': { const ps = pickOwn(ownInPlay(s, owner, c.filter, uid), c.n); paid.push(...ps); for (const u of ps) koCard(s, u, ctl); break; }
      case 'dropOwn': {
        const ps = pickOwn(ownInPlay(s, owner, c.filter, uid), c.n);
        paid.push(...ps);
        for (const u of ps) { if (me.field === u) { removeFrom(s, u); resetInst(s.inst[u]); me.drop.push(u); } else moveTo(s, u, 'drop'); }
        break;
      }
      case 'bounceOwn': { const ps = pickOwn(ownInPlay(s, owner, c.filter, uid), c.n); paid.push(...ps); for (const u of ps) moveTo(s, u, 'hand'); break; }
      case 'bottomOwn': {
        const pool = ownInPlay(s, owner, c.filter, uid);
        const ps = c.all ? shuffle(s, pool.slice()) : pickOwn(pool, c.n);
        paid.push(...ps);
        for (const u of ps) moveTo(s, u, 'deck', { bottom: true });
        break;
      }
      case 'restOwn': {
        const pool = restPool(s, uid, c);
        const order = ctl[owner].choose(s, { kind: 'pick', player: owner, src: uid, options: pool, min: Math.min(c.n, pool.length), max: Math.min(c.n, pool.length), intent: 'lose' });
        let left = c.n;
        const rested: number[] = [];
        for (const u of [...order, ...pool.filter((x) => !order.includes(x))]) { if (left <= 0) break; s.inst[u].rested = true; rested.push(u); left -= restWeight(s, uid, u); }
        for (const u of rested) fireTriggers(s, u, 'whenRestedBySelf', ctl);
        break;
      }
      case 'handToDeckTop': {
        const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src: uid, options: me.hand.filter((u) => u !== uid), min: c.n, max: c.n, intent: 'lose' });
        for (const u of pick.slice(0, c.n)) moveTo(s, u, 'deck', { bottom: c.either && chooseBottom(s, owner, uid, u, ctl) });
        break;
      }
      case 'anyOf': {
        const ok = c.options.map((_, i) => i).filter((i) => canPayCosts(s, uid, c.options[i]));
        const i = ok.length > 1 ? ctl[owner].choose(s, { kind: 'mode', player: owner, src: uid, options: ok, min: 1, max: 1, intent: 'lose', labels: c.options.map((o) => o.map(describeCost).join(', ')) })[0] ?? ok[0] : ok[0];
        if (i !== undefined) { const r = payCosts(s, uid, c.options[i], ctl); kiRemoved += r.kiRemoved; paid.push(...r.paid); }
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
        if (u !== undefined && !activationBlocked(s, u)) { s.inst[u].rested = false; afterActivated(s, u, uid, ctl); }
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
  return { kiRemoved, paid };
}

/** "When you discard a card from your hand using the skill of ...": fire on the discarding player's cards. */
function noteDiscards(s: GameState, owner: Side, n: number) {
  if (n <= 0 || s.skillSrc === undefined || s.inst[s.skillSrc].owner !== owner) return;
  (s.discardEvents ??= []).push({ owner, src: s.skillSrc, n });
}

/** Your opponent's [Permanent] "your opponent's cards can't be switched to Active Mode by skills". */
export function activationBlocked(s: GameState, uid: number): boolean {
  return s.skillBy !== undefined && staticRules(s, other(s.inst[uid].owner), 'oppNoActivate').length > 0;
}

/** "When this card / your Battle Card is switched to Active Mode by a skill". */
function afterActivated(s: GameState, uid: number, by: number, ctl: Choosers) {
  const outer = s.causeSrc;
  s.causeSrc = by;
  try {
    fireTriggers(s, uid, 'whenActivated', ctl);
    fireAll(s, s.inst[uid].owner, 'whenAllyActivated', ctl, uid, uid);
  } finally { s.causeSrc = outer; }
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

type Ctx = EvalCtx;

/** Printed names of skill timings, for the game log. */
const TIMING_LABEL: Partial<Record<Ability['timing'], string>> = {
  onPlay: '[On Play]', whenAttacking: '[When Attacking]', whenAttacked: '[When Attacked]', whenKOd: "[When KO'd]", whenBlocking: '[Blocker]',
  activateMain: '[Activate:Main]', activateBattle: '[Activate:Battle]', counter: '[Counter]', endOfYourTurn: '[End of Your Turn]',
  startOfYourTurn: '[Start of Your Turn]', awaken: '[Awaken]', comboFromHand: '[Combo]', auto: '[Auto]',
};

export function resolveAbility(s: GameState, uid: number, ab: Ability, idx: number, ctl: Choosers, opts: { costsPaid?: boolean } = {}): boolean {
  const owner = s.inst[uid].owner;
  if (!condsHold(s, owner, uid, ab.cond)) return false;
  const outer = s.skillBy;
  const outerSrc = s.skillSrc;
  s.skillBy = owner;
  s.skillSrc = uid;
  let kiRemoved = 0;
  let paid: number[] = [];
  try {
    if (!opts.costsPaid) {
      if (!canPayCosts(s, uid, ab.cost)) return false;
      ({ kiRemoved, paid } = payCosts(s, uid, ab.cost, ctl));
    }
    if (ab.once || isFreeRepeatable(ab)) s.p[owner].usedOnce.push(onceKey(s, uid, idx));
    log(s, () => `${nameOf(s, uid)}: ${idx < 0 ? 'delayed effect' : `${TIMING_LABEL[ab.timing] ?? `[${ab.timing}]`} skill`} resolves`);
    const ctx: Ctx = { prev: [], kiRemoved, paid };
    runEffects(s, uid, owner, ab.effects, ctx, ctl);
  } finally {
    s.skillBy = outer;
    s.skillSrc = outerSrc;
  }
  checkZeroPower(s, ctl);
  checkDeckOut(s);
  if (outer === undefined) fireRemovals(s, ctl);
  return true;
}

/**
 * Triggers queued while a skill resolved: "when your X is removed from the Battle Area by one of your skills /
 * by your opponent", "when an opponent's Battle Card is returned to their hand by one of your skills",
 * "when a card is placed in your Drop from your energy", "when you discard using the skill of ...".
 */
export function fireRemovals(s: GameState, ctl: Choosers) {
  while ((s.removals?.length || s.discardEvents?.length) && (s.stage as string) !== 'over') {
    const d = s.discardEvents?.shift();
    if (d) {
      const outer = s.trigN;
      s.trigN = d.n;
      try { fireAll(s, d.owner, 'whenDiscardBySkill', ctl, d.src); } finally { s.trigN = outer; }
      continue;
    }
    const r = s.removals!.shift()!;
    if (r.kind === 'ko') { firedKO(s, r.uid, r.owner, ctl); continue; }
    if (r.kind === 'energyDrop') {
      const outer = s.causeSrc;
      s.causeSrc = r.bySrc;
      try { fireAll(s, r.owner, 'whenEnergyToDrop', ctl, r.uid); } finally { s.causeSrc = outer; }
      continue;
    }
    fireAll(s, r.owner, r.by === r.owner ? 'whenAllyRemovedBySelf' : 'whenAllyRemovedByOpp', ctl, r.uid);
    if (r.by !== r.owner && r.to === 'hand') fireAll(s, r.by, 'whenOppBounced', ctl, r.uid);
  }
}

function runEffects(s: GameState, src: number, owner: Side, effects: Effect[], ctx: Ctx, ctl: Choosers) {
  withCtx(ctx, () => {
    for (const e of effects) {
      if (s.stage === 'over') return;
      if (!condsHold(s, owner, src, e.cond, ctx.prev, ctx)) continue;
      runEffect(s, src, owner, e, ctx, ctl);
    }
  });
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
  let cands = targetCandidates(s, src, owner, t, ctx);
  if (t.ref || t.all) return cands;
  // "Battle Cards whose costs add up to N or less": only cards that fit at all, then keep picks while they fit.
  const measure = t.totalCostLE !== undefined ? (u: number) => costOf(s, u) : t.totalPowerLE !== undefined ? (u: number) => powerOf(s, u) : null;
  const cap = t.totalCostLE ?? t.totalPowerLE ?? 0;
  if (measure) cands = cands.filter((u) => measure(u) <= cap);
  if (cands.length === 0) return [];
  const min = t.upTo ? 0 : Math.min(t.count, cands.length);
  const max = Math.min(t.count, cands.length);
  // "Your opponent KO's 1 ...": they pick, and pick what hurts them least.
  const who = t.chooser === 'opp' ? other(owner) : owner;
  const intent = t.chooser === 'opp' ? 'lose' : intentOf(e);
  const pick = ctl[who].choose(s, { kind: 'target', player: who, src, options: cands, min: t.chooser === 'opp' ? max : min, max, effect: e, intent }).slice(0, max);
  if (!measure) return pick;
  let used = 0;
  const kept: number[] = [];
  for (const u of [...pick, ...cands.filter((x) => !pick.includes(x))]) {
    if (kept.length >= max) break;
    const v = measure(u);
    if (used + v > cap) continue;
    if (!pick.includes(u) && intent !== 'harm') continue; // only top up harmful picks ("KO them") greedily
    kept.push(u);
    used += v;
  }
  return kept;
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

/** "If you would add a card to its owner's energy during this turn, place it into its owner's Drop instead." */
export const energyRedirected = (s: GameState, p: Side) => activeMods(s, p).some((m) => m.kind === 'energyRedirect');

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
      for (const u of ts) { if (!removable(s, u, by, ctl)) continue; moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: s.inst[u].owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'bottom': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (removable(s, u, by, ctl)) moveTo(s, u, 'deck', { bottom: true });
      return;
    }
    case 'toDrop': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) {
        if (!removable(s, u, by, ctl)) continue;
        const p = s.p[s.inst[u].owner];
        if (p.field === u) { removeFrom(s, u); p.drop.push(u); } else moveTo(s, u, 'drop');
        emit(s, { t: 'toDrop', p: s.inst[u].owner, id: s.inst[u].id, uid: u });
      }
      return;
    }
    case 'toEnergy': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) if (removable(s, u, by, ctl)) { moveTo(s, u, 'energy', { rested: e.rested }); emit(s, { t: 'toEnergy', p: s.inst[u].owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'rest': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) {
        if (s.inst[u].owner !== owner && hasKeyword(s, u, 'cantBeRested')) continue;
        const was = s.inst[u].rested;
        s.inst[u].rested = true;
        if (!was && s.inst[u].owner === owner) fireTriggers(s, u, 'whenRestedBySelf', ctl);
      }
      return;
    }
    case 'activate': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) {
        if (s.inst[u].lockedUntil >= s.turn || activationBlocked(s, u)) continue;
        const was = s.inst[u].rested;
        s.inst[u].rested = false;
        if (was) afterActivated(s, u, src, ctl);
      }
      return;
    }
    case 'lockActive': { const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts; for (const u of ts) s.inst[u].lockedUntil = s.turn + 1; return; }
    case 'grant': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) s.inst[u].grants.push({ kw: e.kw, until: e.dur === 'static' ? s.turn : untilOf(s, e.dur), src: nameOf(s, src) });
      if (ts.length && e.dur !== 'static') log(s, () => `${ts.map((u) => nameOf(s, u)).join(', ')} gains ${e.kw} from ${nameOf(s, src)}`);
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
      if (e.withLife) {
        // "Look through your deck and life ... Then, shuffle your deck and life."
        const pool = [...me.deck, ...me.life];
        const match = pool.filter((u) => e.options.some((f) => matchesFilter(s, u, f, src)));
        const pick = pickFrom(s, owner, src, match, e.take, ctl);
        for (const u of pick) { removeFrom(s, u); emit(s, { t: 'reveal', p: owner, id: s.inst[u].id, uid: u }); me.hand.push(u); }
        me.deck = shuffle(s, me.deck); me.life = shuffle(s, me.life);
        ctx.prev = pick;
        checkDeckOut(s);
        return;
      }
      const top = e.fromBottom ? me.deck.splice(0, e.look) : me.deck.splice(Math.max(0, me.deck.length - e.look));
      let pick: number[];
      if (e.eachOption) {
        // "up to 1 <A> and up to 1 <B>": one pick per option.
        pick = [];
        for (const f of e.options) pick.push(...pickFrom(s, owner, src, top.filter((u) => !pick.includes(u) && matchesFilter(s, u, f, src)), 1, ctl));
      } else {
        const match = top.filter((u) => e.options.some((f) => matchesFilter(s, u, f, src)));
        pick = pickFrom(s, owner, src, match, e.take, ctl);
      }
      const dest = e.dest ?? (e.toHand ? 'hand' : 'hand');
      const rest = top.filter((u) => !pick.includes(u));
      // Return the rest first so a play from the look sees a consistent deck.
      if ((e.rest ?? 'bottom') === 'drop') { for (const u of rest) me.drop.push(u); }
      else if (e.rest === 'hand') me.hand.push(...rest);
      else if (e.rest === 'top') me.deck.push(...rest);
      else me.deck.unshift(...shuffle(s, rest));
      ctx.prev = pick;
      for (const u of pick) {
        emit(s, { t: 'reveal', p: owner, id: s.inst[u].id, uid: u });
        if (dest === 'hand') me.hand.push(u);
        else if (dest === 'drop') me.drop.push(u);
        else if (dest === 'life') me.life.push(u);
        else if (cardOf(s, u).type === 'EXTRA') { me.hand.push(u); placeField(s, u, ctl); if (e.rested) s.inst[u].rested = true; }
        else { me.hand.push(u); playCard(s, u, ctl, { rested: e.rested, negate: e.negate }); }
      }
      checkDeckOut(s);
      return;
    }
    case 'dropToHand': {
      const taken: number[] = [];
      const each = e.per ? e.each * countOf(s, owner, src, e.per, ctx) : e.each;
      if (e.distinctNames || e.totalCostLE !== undefined) {
        // One card at a time, so each pick respects the names and total cost already taken.
        for (let i = 0; i < each; i++) {
          const spent = taken.reduce((t, x) => t + cardOf(s, x).cost, 0);
          const cands = me.drop.filter((u) => !taken.includes(u) && e.options.some((f) => matchesFilter(s, u, f, src))
            && (!e.distinctNames || !taken.some((x) => cardOf(s, x).name === cardOf(s, u).name))
            && (e.totalCostLE === undefined || spent + cardOf(s, u).cost <= e.totalCostLE));
          const pick = pickFrom(s, owner, src, cands, 1, ctl);
          if (!pick.length) break;
          taken.push(pick[0]);
        }
        for (const u of taken) { moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: owner, id: s.inst[u].id, uid: u }); }
        return;
      }
      for (const f of e.options) {
        let cands = me.drop.filter((u) => !taken.includes(u) && matchesFilter(s, u, f, src));
        if (e.distinctCosts) cands = cands.filter((u) => !taken.some((x) => cardOf(s, x).cost === cardOf(s, u).cost));
        let pick = pickFrom(s, owner, src, cands, each, ctl);
        if (e.distinctCosts) pick = pick.filter((u, i) => pick.findIndex((x) => cardOf(s, x).cost === cardOf(s, u).cost) === i);
        taken.push(...pick);
      }
      for (const u of taken) { moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'playFrom': {
      const pool = e.from === 'drop' ? me.drop : e.from === 'hand' ? me.hand : e.from === 'energy' ? me.energy
        : e.from === 'life' ? me.life : e.from === 'lifeTop' ? me.life.slice(-1) : me.deck;
      const ok = (u: number) => u !== src && matchesFilter(s, u, e.filter, src) && (cardOf(s, u).type === 'BATTLE' || (e.extraType && cardOf(s, u).type === 'EXTRA'))
        && (e.totalCostLE === undefined || cardOf(s, u).cost <= e.totalCostLE);
      let played: number[] = [];
      if (e.each?.length) {
        for (const f of e.each) played.push(...pickFrom(s, owner, src, pool.filter((u) => ok(u) && !played.includes(u) && matchesFilter(s, u, f, src)), 1, ctl));
      } else played = pickFrom(s, owner, src, pool.filter(ok), e.n, ctl);
      if (e.distinctNames) played = played.filter((u, i) => played.findIndex((x) => cardOf(s, x).name === cardOf(s, u).name) === i);
      if (e.totalCostLE !== undefined) {
        let used = 0;
        played = played.filter((u) => { const c = cardOf(s, u).cost; if (used + c > e.totalCostLE!) return false; used += c; return true; });
      }
      ctx.prev = played;
      for (const u of played) {
        if (e.from === 'life' || e.from === 'lifeTop') me.lifeLeftTurn = s.turn;
        if (cardOf(s, u).type === 'EXTRA') placeField(s, u, ctl);
        else playCard(s, u, ctl, { rested: e.rested, byLeader: isLeader(s, src), negate: e.negate });
      }
      if (e.from === 'deck') shuffle(s, me.deck);
      if (e.from === 'life') shuffle(s, me.life);
      if ((e.from === 'life' || e.from === 'lifeTop') && played.length && me.life.length === 0 && s.rules.loseAtZeroLife) setWinner(s, other(owner), 'life reached 0');
      return;
    }
    case 'energyFromDeck': {
      for (let i = 0; i < e.n; i++) {
        const u = me.deck.pop();
        if (u === undefined) break;
        if (energyRedirected(s, owner)) { me.drop.push(u); continue; }
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
        if (u !== undefined) me.lifeLeftTurn = s.turn;
        if (u === undefined) break;
        if (energyRedirected(s, owner)) me.drop.push(u);
        else { me.energy.push(u); s.inst[u].rested = e.rested; emit(s, { t: 'toEnergy', p: owner, id: s.inst[u].id, uid: u }); }
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
      for (const u of me.energy) if (k > 0 && s.inst[u].rested && s.inst[u].lockedUntil < s.turn && !activationBlocked(s, u)) { s.inst[u].rested = false; k--; }
      return;
    }
    case 'discard': {
      const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src, options: me.hand.slice(), min: Math.min(e.n, me.hand.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) { moveTo(s, u, 'drop'); emit(s, { t: 'discard', p: owner, id: s.inst[u].id, uid: u }); }
      noteDiscards(s, owner, Math.min(e.n, pick.length));
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
    case 'damageLeader': dealDamage(s, other(owner), e.n, false, ctl); return;
    case 'flipLeader': {
      if (!me.awakened) { awakenLeader(s, owner); log(s, () => `P${owner} awakens ${nameOf(s, me.leader)}`); }
      return;
    }
    case 'ki': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      const n = e.per ? e.n * countOf(s, owner, src, e.per, ctx) : e.n;
      for (const u of ts) { s.inst[u].ki += n; if (n > 0) s.inst[u].kiUpTurn = s.turn; }
      if (ts.length) log(s, () => `${ts.map((u) => nameOf(s, u)).join(', ')} +${e.n} Ki`);
      return;
    }
    case 'placeMarker': me.markers += e.n; log(s, () => `P${owner} places ${e.n} energy marker`); return;
    case 'lifeFromDeck': {
      const n = e.until !== undefined ? Math.max(0, e.until - me.life.length) : e.n;
      for (let i = 0; i < n; i++) { const u = me.deck.pop(); if (u === undefined) break; me.life.push(u); }
      checkDeckOut(s);
      return;
    }
    case 'handToLife': {
      const pick = pickFrom(s, owner, src, me.hand.slice(), e.n, ctl, 'lose', e.upTo ? 0 : e.n);
      // Life is drawn from the end of the array, so the bottom is the front. Given the choice, the AI
      // puts it on top so it comes back to hand with the next hit.
      for (const u of pick) { removeFrom(s, u); resetInst(s.inst[u]); if (e.pos === 'bottom') me.life.unshift(u); else me.life.push(u); }
      return;
    }
    case 'handToDeck': {
      const pick = ctl[owner].choose(s, { kind: 'discard', player: owner, src, options: me.hand.slice(), min: Math.min(e.n, me.hand.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) moveTo(s, u, 'deck', { bottom: e.either ? chooseBottom(s, owner, src, u, ctl) : e.bottom });
      return;
    }
    case 'self': {
      if (e.to === 'play') {
        if (!inPlay(s, src) && cardOf(s, src).type === 'BATTLE') playCard(s, src, ctl, { rested: e.rested });
        return;
      }
      if (isLeader(s, src)) return;
      if (me.field === src) { removeFrom(s, src); me.field = null; }
      if (e.to === 'life') { removeFrom(s, src); resetInst(s.inst[src]); me.life.push(src); return; }
      if (e.to === 'hand') moveTo(s, src, 'hand');
      else if (e.to === 'drop') moveTo(s, src, 'drop');
      else if (e.to === 'energy') moveTo(s, src, 'energy', { rested: e.rested });
      else moveTo(s, src, 'deck', { bottom: true });
      return;
    }
    case 'nextDiscount': addMod(s, owner, { kind: 'discount', filter: e.filter, amount: e.amount, until: s.turn }); return;
    case 'cantPlay': addMod(s, e.opp ? other(owner) : owner, { kind: 'cantPlay', filter: e.filter, extras: e.extras, until: e.dur === 'game' ? 1e9 : e.dur === 'oppNextTurn' ? s.turn + 1 : s.turn }); return;
    case 'lockSkill': addMod(s, owner, { kind: 'skillLock', filter: { names: e.names }, timing: e.timing, until: e.dur === 'oppNextTurn' ? s.turn + 1 : s.turn }); return;
    case 'atEndOfTurn': (s.p[s.active].atEnd ??= []).push({ src, effects: e.effects }); return;
    case 'dropToDeck': {
      const cards = me.drop.splice(0);
      cards.forEach((u) => resetInst(s.inst[u]));
      if (e.bottom) { shuffle(s, cards); me.deck.unshift(...cards); return; } // the deck is drawn from the end
      me.deck.push(...cards); shuffle(s, me.deck); return;
    }
    case 'lifeToDeck': {
      const pick = pickFrom(s, owner, src, me.life.slice(), e.n, ctl, 'gain', Math.min(e.n, me.life.length));
      for (const u of pick) { me.life.splice(me.life.indexOf(u), 1); me.deck.push(u); me.lifeLeftTurn = s.turn; }
      if (me.life.length === 0 && s.rules.loseAtZeroLife) setWinner(s, other(owner), 'life reached 0');
      shuffle(s, me.life);
      return;
    }
    case 'oppTax': addMod(s, other(owner), { kind: 'tax', filter: e.filter ?? {}, amount: e.amount, until: e.dur === 'turn' ? s.turn : s.turn + 1 }); return;
    case 'oppPlayRested': addMod(s, other(owner), { kind: 'playRested', filter: e.filter, until: s.turn + 1 }); return;
    case 'placeUnder': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl);
      const top = ts[0];
      if (top === undefined) return;
      const pool = e.from === 'drop' ? me.drop : e.from === 'hand' ? me.hand : e.from === 'battle' ? me.battle : e.from === 'handOrBattle' ? [...me.hand, ...me.battle] : me.deck;
      const n = e.untilUnder !== undefined ? Math.max(0, e.untilUnder - (s.inst[top].under?.length ?? 0)) : e.n;
      const taken: number[] = [];
      for (const f of e.filters.length ? e.filters : [{}]) {
        const cands = pool.filter((u) => u !== top && u !== src && !taken.includes(u) && matchesFilter(s, u, f, src));
        taken.push(...pickFrom(s, owner, src, cands, n - (e.untilUnder !== undefined ? taken.length : 0), ctl));
      }
      for (const u of taken) {
        if (me.battle.includes(u)) moveTo(s, u, 'drop');
        removeFrom(s, u); resetInst(s.inst[u]); (s.inst[top].under ??= []).push(u);
      }
      ctx.prev = taken;
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
        const used = pickFrom(s, owner, src, cands, e.per ? e.n * countOf(s, owner, src, e.per, ctx) : e.n, ctl);
        for (const u of used) { moveTo(s, u, 'combo'); s.battle.comboCount[owner]++; me.comboDropTurn = s.turn; emit(s, { t: 'combo', p: owner, id: s.inst[u].id, uid: u, fromHand: false }); }
        for (const u of used) { if (s.stage === 'over') break; fireTriggers(s, u, 'comboFromDrop', ctl); }
      } else {
        // Look at the top card(s), use up to n matching Battle Cards, then the rest go back.
        const seen = me.deck.slice(-(e.look ?? 1)).reverse();
        const cands = seen.filter((u) => cardOf(s, u).type === 'BATTLE' && matchesFilter(s, u, e.filter, src));
        const used = (e.look ?? 1) > 1 ? pickFrom(s, owner, src, cands, e.n, ctl) : cands.slice(0, e.n);
        for (const u of used) { moveTo(s, u, 'combo'); s.battle.comboCount[owner]++; emit(s, { t: 'combo', p: owner, id: s.inst[u].id, uid: u, fromHand: false }); }
        if (e.rest === 'either') for (const u of seen) if (!used.includes(u) && me.deck.includes(u) && chooseBottom(s, owner, src, u, ctl)) { removeFrom(s, u); me.deck.unshift(u); }
        checkDeckOut(s);
      }
      if (s.battle && s.stage !== 'over') {
        const mine = s.battle.atkSide === owner ? s.battle.attacker : s.battle.target;
        if (s.inst[mine]?.owner === owner) fireTriggers(s, mine, 'whenComboInBattle', ctl);
      }
      return;
    }
    case 'negate': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      const until = e.dur === 'oppNextTurn' ? s.turn + 1 : e.dur === 'game' ? 1e9 : s.turn;
      for (const u of ts) { s.inst[u].negatedUntil = until; s.inst[u].negateScope = e.scope ?? 'all'; }
      s.zoneRev = (s.zoneRev ?? 0) + 1;
      return;
    }
    case 'atEndOfBattle': if (s.battle) (s.battleEnd ??= []).push({ src, owner, effects: e.effects }); return;
    case 'oppMarker': s.p[other(owner)].markers += e.n; return;
    case 'selfDamage': takeLife(s, owner, e.n, false, ctl); return;
    case 'energyToDrop': {
      const pick = ctl[owner].choose(s, { kind: 'energyToDrop', player: owner, src, options: me.energy.slice(), min: Math.min(e.n, me.energy.length), max: e.n, intent: 'lose' });
      for (const u of pick.slice(0, e.n)) moveTo(s, u, 'drop');
      return;
    }
    case 'winGame': s.stage = 'over'; s.winner = owner; s.reason = `${nameOf(s, src)}'s skill`; return;
    case 'reveal': {
      const opp = s.p[other(owner)];
      const u = e.from === 'deckTop' ? me.deck[me.deck.length - 1] : e.from === 'oppDeckTop' ? opp.deck[opp.deck.length - 1]
        : e.from === 'lifeTop' ? me.life[me.life.length - 1] : opp.hand.length ? opp.hand[Math.floor(rand(s) * opp.hand.length)] : undefined;
      ctx.revealed = u;
      if (u !== undefined) emit(s, { t: 'reveal', p: s.inst[u].owner, id: s.inst[u].id, uid: u });
      return;
    }
    case 'pick': ctx.prev = chooseTargets(s, src, owner, e, ctx, ctl); return;
    case 'attackRule': addMod(s, other(owner), { kind: 'attackRule', effect: e, src, filter: {}, until: e.dur === 'oppNextTurn' ? s.turn + 1 : e.dur === 'game' ? 1e9 : s.turn }); return;
    case 'shield': addMod(s, owner, { kind: 'shield', filter: {}, until: e.dur === 'oppNextTurn' ? s.turn + 1 : e.dur === 'game' ? 1e9 : s.turn }); return;
    case 'cantLose': addMod(s, owner, { kind: 'cantLose', filter: {}, until: e.dur === 'oppNextTurn' ? s.turn + 1 : s.turn }); return;
    case 'oppLife': {
      const op = other(owner);
      const opp = s.p[op];
      for (let i = 0; i < e.n; i++) {
        const u = opp.life.pop();
        if (u === undefined) break;
        opp.lifeLeftTurn = s.turn;
        if (e.to === 'energy' && !energyRedirected(s, op)) { opp.energy.push(u); s.inst[u].rested = !!e.rested; } else opp.drop.push(u);
      }
      if (opp.life.length === 0 && s.rules.loseAtZeroLife) setWinner(s, owner, 'life reached 0');
      return;
    }
    case 'oppMill': millCards(s, other(owner), e.n, ctl); return;
    case 'delayed': addMod(s, owner, { kind: 'delayed', effect: e, src, filter: e.filter ?? {}, until: s.turn }); return;
    case 'setBasePower': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl);
      const value = typeof e.value === 'number' ? e.value : valOf(s, owner, src, e.value);
      const until = e.dur === 'static' ? s.turn : untilOf(s, e.dur);
      if (value >= 0) for (const u of ts) s.inst[u].basePowerSet = { value, until };
      return;
    }
    case 'evolveDiscount': addMod(s, owner, { kind: 'evolveDiscount', filter: e.filter, amount: e.amount, until: s.turn }); return;
    case 'repeatExtra': addMod(s, owner, { kind: 'repeatExtra', filter: e.filter, until: s.turn }); return;
    case 'skillDiscount': addMod(s, owner, { kind: 'skillDiscount', filter: e.filter, amount: e.amount, until: s.turn }); return;
    case 'energyRedirect': addMod(s, owner, { kind: 'energyRedirect', filter: {}, until: s.turn }); return;
    case 'toCombo': {
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      for (const u of ts) {
        if (isLeader(s, u) || (s.battle && (u === s.battle.attacker || u === s.battle.target))) continue;
        const p = s.inst[u].owner;
        moveTo(s, u, 'combo');
        if (s.battle) s.battle.comboCount[p]++;
        emit(s, { t: 'combo', p, id: s.inst[u].id, uid: u, fromHand: false });
      }
      return;
    }
    case 'unflipLeader': if (me.awakened) { me.awakened = false; s.zoneRev = (s.zoneRev ?? 0) + 1; log(s, () => `P${owner}'s Leader flips back`); } return;
    case 'swapBattler': {
      const b = s.battle;
      if (!b) return;
      const ts = chooseTargets(s, src, owner, e, ctx, ctl).filter((u) => u !== b.attacker && u !== b.target && s.p[owner].battle.includes(u));
      if (!ts.length) return;
      if (b.atkSide === owner) b.attacker = ts[0]; else b.target = ts[0];
      log(s, () => `${nameOf(s, ts[0])} takes over the battle`);
      return;
    }
    case 'extraTurn': s.extraTurn = owner; return;
    case 'copyOnPlay': {
      const cands = (s.inst[src].under ?? []).filter((u) => matchesFilter(s, u, e.filter, src));
      for (const u of pickFrom(s, owner, src, cands, e.n, ctl)) {
        for (const ab of compileCard(cardOf(s, u)).abilities) {
          if (ab.timing !== 'onPlay' || ab.cost.length || s.stage === 'over') continue;
          resolveAbility(s, src, ab, -1, ctl);
        }
      }
      return;
    }
    case 'useDropSkill': {
      const u = pickFrom(s, owner, src, me.drop.filter((x) => matchesFilter(s, x, e.filter, src)), 1, ctl)[0];
      if (u === undefined) return;
      const abs = compileCard(cardOf(s, u)).abilities;
      abs.forEach((ab, i) => { if (ab.timing === e.timing && s.stage !== 'over') resolveAbility(s, u, ab, i, ctl); });
      if (me.drop.includes(u)) moveTo(s, u, 'deck', { bottom: true });
      return;
    }
    case 'energyToHand': {
      for (const u of pickFrom(s, owner, src, me.energy.filter((x) => matchesFilter(s, x, e.filter, src)), e.n, ctl)) { moveTo(s, u, 'hand'); emit(s, { t: 'toHandPublic', p: owner, id: s.inst[u].id, uid: u }); }
      return;
    }
    case 'lockEnergy': {
      const opp = s.p[other(owner)];
      for (const u of pickFrom(s, owner, src, opp.energy.filter((x) => s.inst[x].rested), e.n, ctl, 'harm')) s.inst[u].lockedUntil = s.turn + 1;
      return;
    }
    case 'restOppEnergy': {
      let left = e.n ?? Infinity;
      for (const u of s.p[other(owner)].energy) {
        if (left <= 0) break;
        if (s.inst[u].rested || !matchesFilter(s, u, e.filter, src)) continue;
        s.inst[u].rested = true;
        left--;
      }
      return;
    }
    case 'optionalCost': {
      if (!canPayCosts(s, src, e.costs)) return;
      const yes = ctl[owner].choose(s, { kind: 'yesno', player: owner, src, options: [1], min: 0, max: 1, effect: e, intent: 'gain' });
      if (!yes.length) return;
      const r = payCosts(s, src, e.costs, ctl);
      ctx.paid = [...(ctx.paid ?? []), ...r.paid];
      runEffects(s, src, owner, e.effects, ctx, ctl);
      return;
    }
    case 'group': runEffects(s, src, owner, e.effects, ctx, ctl); return;
    case 'evolveOnto': {
      const u = ctx.paid?.[0];
      const at = me.battle.indexOf(src);
      if (u === undefined || at < 0) return;
      const holder = [...me.battle, ...(me.field !== null ? [me.field] : [])].find((x) => s.inst[x].under?.includes(u));
      if (holder === undefined) return;
      s.inst[holder].under!.splice(s.inst[holder].under!.indexOf(u), 1);
      const rested = s.inst[src].rested;
      const under = [...(s.inst[src].under ?? []), src];
      s.inst[src].under = undefined;
      me.battle.splice(at, 1, u);
      resetInst(s.inst[src]);
      resetInst(s.inst[u]);
      Object.assign(s.inst[u], { under, rested, playedTurn: s.turn, playedByEvolve: true, playedBySkill: true });
      s.zoneRev = (s.zoneRev ?? 0) + 1;
      log(s, () => `${nameOf(s, u)} is played on top of ${nameOf(s, src)}`);
      emit(s, { t: 'play', p: owner, id: s.inst[u].id, uid: u });
      afterPlayed(s, u, ctl);
      return;
    }
    // [Permanent]-only rules, read where they apply (staticRules).
    case 'damageCap': case 'handCostMod': case 'altCost': case 'dropCost': case 'evolveFromUnder': case 'oppNoActivate': return;
    case 'redirect': {
      if (!s.battle) return;
      const ts = chooseTargets(s, src, owner, e, ctx, ctl); ctx.prev = ts;
      if (ts.length) { s.battle.target = ts[0]; log(s, () => `attack redirected to ${nameOf(s, ts[0])}`); }
      return;
    }
    case 'noop': return;
  }
}

export { removeFrom, cardOf };
