import { Card, Color } from '../data/types';
import { RulesConfig } from '../data/rules';
import { compileCard, compileGeneration } from '../effects/parse';
import { Ability, CompiledCard, Cond, Count, Effect, Filter, Keyword, Val } from '../effects/types';

export type Side = 0 | 1;

export interface Mod {
  amount: number;
  /** 'battle' clears after the battle, a number clears at the end of that turn. */
  until: 'battle' | number;
}

export interface Inst {
  uid: number;
  id: string;
  owner: Side;
  rested: boolean;
  /** Can't switch to Active during turns <= this number. */
  lockedUntil: number;
  mods: Mod[];
  grants: { kw: Keyword; until: 'battle' | number }[];
  comboBonus: number;
  playedTurn: number;
  /** Ki under this card (manual p.12). Lost when a Battle Card leaves the Battle Area; kept on a Leader. */
  ki: number;
  /** Cost changes on a card in play ("reduce its cost by 1 for the turn"). */
  costMods?: Mod[];
  /** Cards placed under this card (Evolve stacks, Potara, absorption). */
  under?: number[];
  /** Turn on which a "can't be KO'd once per turn" shield was used. */
  koShieldTurn?: number;
  /** This card was played by its owner's Leader's skill (FB12-117). */
  playedByLeader?: boolean;
  /** Its skills are negated through this turn number ('onPlay': only its [On Play]). */
  negatedUntil?: number;
  /** An energy marker was removed to pay for this card when it was last used. */
  markerPaid?: boolean;
  /** Played on top of another card by [Evolve] / [Fusion Evolve]. */
  playedByEvolve?: boolean;
  /** Played by a skill (not from hand by paying its cost). */
  playedBySkill?: boolean;
  /** Last turn this card attacked. */
  attackedTurn?: number;
  negateScope?: 'all' | 'onPlay';
  /** Zone it was last played from. */
  playedFrom?: 'hand' | 'drop' | 'deck' | 'life' | 'energy';
  /** Last turn its Ki went up. */
  kiUpTurn?: number;
  /** Ki removed from it during the current battle. */
  kiRemovedBattle?: number;
  /** "Its original power becomes N" until then. */
  basePowerSet?: { value: number; until: 'battle' | number };
}

/** A lasting rule change on one player: discounts, play bans, taxes. */
export interface PlayerMod {
  kind: 'discount' | 'cantPlay' | 'tax' | 'playRested' | 'skillLock'
    | 'attackRule' | 'shield' | 'cantLose' | 'delayed' | 'evolveDiscount' | 'repeatExtra' | 'skillDiscount' | 'energyRedirect';
  /** The effect behind an attackRule / delayed mod. */
  effect?: Effect;
  /** Source card of a delayed effect. */
  src?: number;
  timing?: 'activateMain' | 'activateBattle';
  filter: Filter;
  amount?: number | 'free';
  extras?: boolean;
  /** Last turn number this applies on. */
  until: number;
}

export type Zone = 'deck' | 'hand' | 'battle' | 'field' | 'energy' | 'drop' | 'life' | 'combo' | 'leader' | 'removed';

export interface PlayerState {
  leader: number;
  awakened: boolean;
  /** Top of deck is the END of the array. */
  deck: number[];
  hand: number[];
  battle: number[];
  energy: number[];
  drop: number[];
  life: number[];
  combo: number[];
  /** The [Field] Extra in this player's Battle Area (manual p.13), if any. */
  field: number | null;
  markers: number;
  usedOnce: string[];
  mulliganed: boolean;
  mods?: PlayerMod[];
  /** Cards (uids) of this player that KO'd an opponent's Battle Card, by turn. */
  koBy?: { turn: number; uid: number }[];
  /** Effects to run at the end of this turn: [source card, effects]. */
  atEnd?: { src: number; effects: import('../effects/types').Effect[] }[];
  /** Last turn one of this player's Battle Cards left a Battle Area through this player's own skill. */
  removedOwnTurn?: number;
  /** Last turn Ki was removed from this player's cards. */
  kiRemovedTurn?: number;
  /** Last turn a card left this player's life. */
  lifeLeftTurn?: number;
  /** Extras this player used, by turn (for "if you use an Extra with ... during this turn"). */
  usedExtras?: { turn: number; uid: number }[];
  /** Last turn this player used a card from their Drop in a combo. */
  comboDropTurn?: number;
  /** Last turn one of this player's Battle Cards left a Battle Area through any skill. */
  removedBySkillTurn?: number;
  /** Battle Cards removed from this player's Battle Area by a skill, by turn. */
  removedBySkill?: { turn: number; uid: number }[];
  /** Last turn one of this player's energy markers was removed. */
  markerUsedTurn?: number;
  /** Last turn this player used an Extra with an original cost of 1 or more. */
  extraUsedTurn?: number;
  /** Last turn a card left this player's energy. */
  energyLeftTurn?: number;
  /** Last turn one of this player's Battle Cards was returned from the Battle Area to the hand. */
  bouncedTurn?: number;
  /** Last turn this player used a card from their Battle Area in a combo. */
  comboFieldTurn?: number;
}

export type Stage = 'mulligan' | 'charge' | 'main' | 'counter' | 'block' | 'offCombo' | 'defCombo' | 'over';

export interface Battle {
  attacker: number;
  atkSide: Side;
  target: number;
  blocked: boolean;
  cantBlock: boolean;
  comboCount: [number, number];
}

/** Public facts other code (the opponent model, the UI log) may observe. */
export type GameEvent =
  | { t: 'play' | 'charge' | 'reveal' | 'toDrop' | 'combo' | 'counter' | 'activate' | 'toEnergy' | 'toHandPublic' | 'discard'; p: Side; id: string; uid: number; fromHand?: boolean }
  | { t: 'draw' | 'lifeToHand' | 'searchToHand'; p: Side; n: number }
  | { t: 'mulligan'; p: Side; did: boolean }
  | { t: 'attack'; p: Side; attacker: number; target: number }
  | { t: 'declined'; p: Side; what: 'combo' | 'block' | 'counter'; need: number; handSize: number; stakes: 'leader' | 'battle'; life?: number }
  | { t: 'damage'; p: Side; n: number }
  | { t: 'ko'; p: Side; id: string }
  | { t: 'turn'; turn: number; active: Side }
  | { t: 'end'; p: Side; unspent: number; handSize: number }
  | { t: 'over'; winner: Side | -1; reason: string };

export interface GameState {
  rules: RulesConfig;
  cards: Record<string, Card>;
  inst: Inst[];
  p: [PlayerState, PlayerState];
  turn: number;
  active: Side;
  first: Side;
  stage: Stage;
  /** Who must answer the current question. */
  toAct: Side;
  battle: Battle | null;
  winner: Side | -1;
  reason: string;
  seed: number;
  charged: boolean;
  /** Mulligan queue during setup. */
  mulliganTurn: Side;
  log: string[] | null;
  events: GameEvent[] | null;
  /** The player whose skill is resolving right now (for "removed by your/your opponent's skill"). */
  skillBy?: Side;
  /** Effects to run when the current battle ends ("At the end of the battle, KO this card"). */
  battleEnd?: { src: number; owner: Side; effects: Effect[] }[];
  /** Bumped whenever cards in play or their active abilities change (cache key for auras). */
  zoneRev?: number;
  /** Battle Cards that left a Battle Area during the current skill, for removal triggers. */
  removals?: { uid: number; owner: Side; by: Side; to?: Zone; kind?: 'battle' | 'energyDrop'; bySrc?: number }[];
  /** The card whose skill is resolving right now. */
  skillSrc?: number;
  /** The card whose skill caused the trigger now firing (for "by your Leader's skill"). */
  causeSrc?: number;
  /** How many cards the event now triggering moved (Count zone 'event'). */
  trigN?: number;
  /** This player takes the next turn again. */
  extraTurn?: Side;
  /** Discards made by skills during the current skill, for "when you discard using the skill of ..." triggers. */
  discardEvents?: { owner: Side; src: number; n: number }[];
}

// ------------------------------------------------------------------ rng

export function rand(s: GameState): number {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function shuffle<T>(s: GameState, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(s) * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// ------------------------------------------------------------------ cloning

export function cloneState(s: GameState): GameState {
  // Spread first so every scalar field (including per-turn tracking added later) is copied;
  // then give every array its own copy so imagined games can't write into the real one.
  const clonePlayer = (p: PlayerState): PlayerState => ({
    ...p,
    deck: p.deck.slice(),
    hand: p.hand.slice(),
    battle: p.battle.slice(),
    energy: p.energy.slice(),
    drop: p.drop.slice(),
    life: p.life.slice(),
    combo: p.combo.slice(),
    field: p.field,
    markers: p.markers,
    usedOnce: p.usedOnce.slice(),
    mods: p.mods ? p.mods.slice() : undefined,
    koBy: p.koBy ? p.koBy.slice() : undefined,
    atEnd: p.atEnd ? p.atEnd.slice() : undefined,
    usedExtras: p.usedExtras ? p.usedExtras.slice() : undefined,
    removedBySkill: p.removedBySkill ? p.removedBySkill.slice() : undefined,
  });
  return {
    ...s,
    inst: s.inst.map((i) => ({
      ...i,
      mods: i.mods.length ? i.mods.slice() : [],
      grants: i.grants.length ? i.grants.slice() : [],
      costMods: i.costMods?.length ? i.costMods.slice() : undefined,
      under: i.under?.length ? i.under.slice() : undefined,
    })),
    p: [clonePlayer(s.p[0]), clonePlayer(s.p[1])],
    battle: s.battle ? { ...s.battle, comboCount: [s.battle.comboCount[0], s.battle.comboCount[1]] } : null,
    battleEnd: s.battleEnd ? s.battleEnd.slice() : undefined,
    removals: s.removals ? s.removals.slice() : undefined,
    discardEvents: s.discardEvents ? s.discardEvents.slice() : undefined,
    log: null,
    events: null,
  };
}

// ------------------------------------------------------------------ lookups

export const cardOf = (s: GameState, uid: number): Card => s.cards[s.inst[uid].id];
export const compiledOf = (s: GameState, uid: number): CompiledCard => compileCard(cardOf(s, uid));
export const other = (p: Side): Side => (1 - p) as Side;

export function isLeader(s: GameState, uid: number) {
  return s.p[s.inst[uid].owner].leader === uid;
}

/** Abilities on the face currently showing. */
export function abilitiesOf(s: GameState, uid: number): Ability[] {
  const c = compiledOf(s, uid);
  const list = isLeader(s, uid) && s.p[s.inst[uid].owner].awakened && c.backAbilities ? c.backAbilities : c.abilities;
  const inst = s.inst[uid];
  if (inst.negatedUntil === undefined || inst.negatedUntil < s.turn) return list;
  return inst.negateScope === 'onPlay' ? list.filter((a) => a.timing !== 'onPlay') : [];
}

const negatedAll = (s: GameState, uid: number) => {
  const i = s.inst[uid];
  return i.negatedUntil !== undefined && i.negatedUntil >= s.turn && i.negateScope !== 'onPlay';
};

// ------------------------------------------------------------------ auras
// [Permanent] effects a card gives to other cards ("your Battle Cards with a cost of 3 can't be
// removed...", "all your <X> get +5000 power"): a permanent grant/power with target.all.

/**
 * What an ability list can do continuously, worked out once per list. Power, cost and
 * keyword lookups run thousands of times per AI decision, so they skip cards whose
 * abilities can't affect the answer without looking at them.
 */
interface StaticSummary {
  /** Gives power, keywords or cost changes to other cards (or to your Leader from a Battle Card). */
  aura: boolean;
  /** Keywords it can grant to itself through a [Permanent]. */
  selfGrants: Set<Keyword>;
  selfPower: boolean;
  /** Rule-changing effect types it has in a [Permanent] (see staticRules). */
  rules: Set<string>;
}
const summaries = new WeakMap<Ability[], StaticSummary>();
function summaryOf(abs: Ability[]): StaticSummary {
  let v = summaries.get(abs);
  if (!v) {
    v = { aura: false, selfGrants: new Set(), selfPower: false, rules: new Set() };
    for (const a of abs) {
      if (a.timing !== 'permanent') continue;
      for (const e of a.effects) {
        v.rules.add(e.t);
        if ((e.t === 'grant' || e.t === 'power' || e.t === 'costMod') && (e.target.all || e.target.ref === 'leader')) v.aura = true;
        if (e.t === 'grant' && e.target.ref === 'this') v.selfGrants.add(e.kw);
        if (e.t === 'power') v.selfPower = true;
      }
    }
    summaries.set(abs, v);
  }
  return v;
}
const NO_EFFECTS: Effect[] = [];

/** Is any card in play an aura source? Cached until cards in play (or the turn) change. */
const auraMemo = new WeakMap<GameState, number[]>();
function anyAura(s: GameState): boolean {
  const p0 = s.p[0], p1 = s.p[1];
  const m = auraMemo.get(s);
  if (m && m[0] === (s.zoneRev ?? 0) && m[1] === s.turn && m[2] === compileGeneration && m[3] === +p0.awakened + 2 * +p1.awakened
    && m[4] === p0.battle.length && m[5] === p1.battle.length && m[6] === (p0.field ?? -1) && m[7] === (p1.field ?? -1)) return m[8] === 1;
  let any = false;
  for (let side = 0; side < 2 && !any; side++) {
    const p = s.p[side];
    if (summaryOf(abilitiesOf(s, p.leader)).aura) any = true;
    for (let i = 0; i < p.battle.length && !any; i++) if (summaryOf(abilitiesOf(s, p.battle[i])).aura) any = true;
    if (!any && p.field !== null && summaryOf(abilitiesOf(s, p.field)).aura) any = true;
  }
  auraMemo.set(s, [s.zoneRev ?? 0, s.turn, compileGeneration, +p0.awakened + 2 * +p1.awakened, p0.battle.length, p1.battle.length, p0.field ?? -1, p1.field ?? -1, any ? 1 : 0]);
  return any;
}
let auraDepth = 0;

/** Permanent grant/power effects other cards give to `uid`. */
export function auraEffects(s: GameState, uid: number): Effect[] {
  if (auraDepth > 0) return NO_EFFECTS; // an aura's own condition doesn't see auras: no loops
  if (!anyAura(s)) return NO_EFFECTS; // most boards have none
  const out: Effect[] = [];
  const where = isLeader(s, uid) ? 'leader' : 'battle';
  auraDepth++;
  try {
    for (const side of [0, 1] as Side[]) {
      const p = s.p[side];
      const srcs = p.field !== null ? [p.leader, ...p.battle, p.field] : [p.leader, ...p.battle];
      for (const src of srcs) {
        const abs = abilitiesOf(s, src);
        if (!summaryOf(abs).aura) continue;
        for (const ab of abs) {
          if (ab.timing !== 'permanent' || !turnMatches(s, side, ab.turn)) continue;
          for (const e of ab.effects) {
            if (e.t !== 'grant' && e.t !== 'power' && e.t !== 'costMod') continue;
            const t = e.target;
            // "Your Leader gets +X" written on a Battle Card or Field.
            if (t.ref === 'leader' && src !== p.leader) {
              if (uid === p.leader && condsHold(s, side, src, ab.cond) && condsHold(s, side, src, e.cond)) out.push(e);
              continue;
            }
            if (!t.all) continue;
            const owner = s.inst[uid].owner;
            if (t.side === 'self' ? owner !== side : t.side === 'opp' ? owner === side : false) continue;
            if (!t.zones.includes(where as 'leader' | 'battle')) continue;
            if (!matchesFilter(s, uid, t.filter, src)) continue;
            if (!condsHold(s, side, src, ab.cond) || !condsHold(s, side, src, e.cond)) continue;
            out.push(e);
          }
        }
      }
    }
  } finally { auraDepth--; }
  return out;
}

export function hasKeyword(s: GameState, uid: number, kw: Keyword): boolean {
  const inst = s.inst[uid];
  if (inst.grants.some((g) => g.kw === kw)) return true;
  const c = compiledOf(s, uid);
  const base = isLeader(s, uid) && s.p[inst.owner].awakened && c.backKeywords ? c.backKeywords : c.keywords;
  if (base.has(kw) && !negatedAll(s, uid)) return true;
  if (auraEffects(s, uid).some((e) => e.t === 'grant' && e.kw === kw)) return true;
  if (staticDepth >= MAX_STATIC_DEPTH) return false;
  const abs = abilitiesOf(s, uid);
  if (!summaryOf(abs).selfGrants.has(kw)) return false;
  // [Permanent] "this card gains [X]" / "this card can't attack" with conditions.
  for (const ab of abs) {
    if (ab.timing !== 'permanent') continue;
    if (!ab.effects.some((e) => e.t === 'grant' && e.kw === kw && e.target.ref === 'this')) continue;
    if (!turnMatches(s, inst.owner, ab.turn)) continue;
    if (!condsHold(s, inst.owner, uid, ab.cond)) continue;
    for (const e of ab.effects) if (e.t === 'grant' && e.kw === kw && e.target.ref === 'this' && condsHold(s, inst.owner, uid, e.cond)) return true;
  }
  return false;
}

export const turnMatches = (s: GameState, owner: Side, turn: 'your' | 'opp' | undefined) =>
  !turn || (turn === 'your') === (s.active === owner);

/**
 * Cards whose conditions read other cards' cost or power can refer to each other
 * (A's cost depends on counting cards by cost, which includes B, whose cost depends
 * on A...). Below this depth, continuous changes are ignored and printed values used.
 */
const MAX_STATIC_DEPTH = 3;
let staticDepth = 0;

/** Cost of a card where it is, with any cost changes on it. */
export function costOf(s: GameState, uid: number): number {
  const base = cardOf(s, uid).cost;
  const mods = s.inst[uid].costMods;
  let c = base;
  if (mods) for (const m of mods) c += m.amount;
  if (!inPlay(s, uid) || staticDepth >= MAX_STATIC_DEPTH) return Math.max(0, c);
  staticDepth++;
  try {
    for (const ab of abilitiesOf(s, uid)) {
      if (ab.timing !== 'permanent' || !turnMatches(s, s.inst[uid].owner, ab.turn)) continue;
      if (!ab.effects.some((e) => e.t === 'costMod' && e.target.ref === 'this')) continue;
      if (!condsHold(s, s.inst[uid].owner, uid, ab.cond)) continue;
      for (const e of ab.effects) if (e.t === 'costMod' && e.target.ref === 'this' && condsHold(s, s.inst[uid].owner, uid, e.cond)) c += e.per ? e.amount * countOf(s, s.inst[uid].owner, uid, e.per) : e.amount;
    }
    for (const e of auraEffects(s, uid)) if (e.t === 'costMod') c += e.amount;
  } finally { staticDepth--; }
  return Math.max(0, c);
}

export function inPlay(s: GameState, uid: number): boolean {
  const p = s.p[s.inst[uid].owner];
  return p.leader === uid || p.field === uid || p.battle.includes(uid);
}

export function zoneOf(s: GameState, uid: number): Zone {
  const p = s.p[s.inst[uid].owner];
  if (p.leader === uid) return 'leader';
  if (p.field === uid) return 'field';
  for (const z of ['battle', 'hand', 'energy', 'drop', 'life', 'combo', 'deck'] as const) if (p[z].includes(uid)) return z;
  return 'removed';
}

/** Game log line. Pass a function so the text is only built when a log is kept (not in AI rollouts). */
export function log(s: GameState, msg: string | (() => string)) {
  if (s.log) s.log.push(`T${s.turn} ${typeof msg === 'function' ? msg() : msg}`);
}

export function emit(s: GameState, e: GameEvent) {
  if (s.events) s.events.push(e);
}

export const nameOf = (s: GameState, uid: number) => {
  const c = cardOf(s, uid);
  return isLeader(s, uid) && s.p[s.inst[uid].owner].awakened && c.back ? c.back.name : c.name;
};

// ------------------------------------------------------------------ values worked out during a skill

/** What the resolving skill has chosen / revealed / paid so far; filters with a Val read it. */
export interface EvalCtx { prev: number[]; kiRemoved?: number; revealed?: number; paid?: number[] }
let curCtx: EvalCtx | null = null;
export function withCtx<T>(ctx: EvalCtx | null, f: () => T): T {
  const outer = curCtx;
  curCtx = ctx;
  try { return f(); } finally { curCtx = outer; }
}
export const currentCtx = () => curCtx;

/** The card a "the card chosen by this skill" refers to: the previous choice, else what the cost picked. */
function chosenCard(ctx: EvalCtx | null): number | undefined {
  return ctx?.prev[0] ?? ctx?.paid?.[0];
}

export function valOf(s: GameState, owner: Side, src: number, v: Val): number {
  const ctx = curCtx;
  let n = 0;
  switch (v.of) {
    case 'prevCost': { const u = chosenCard(ctx); n = u === undefined ? -1 : inPlay(s, u) ? costOf(s, u) : cardOf(s, u).cost; break; }
    case 'prevPower': { const u = chosenCard(ctx); n = u === undefined ? -1 : inPlay(s, u) ? powerOf(s, u) : cardOf(s, u).power; break; }
    case 'kiRemoved': n = ctx?.kiRemoved ?? 0; break;
    case 'revealedCost': n = ctx?.revealed === undefined ? -1 : cardOf(s, ctx.revealed).cost; break;
    case 'thisCost': n = inPlay(s, src) ? costOf(s, src) : cardOf(s, src).cost; break;
    case 'energy': n = s.p[owner].energy.length; break;
    case 'leaderKi': n = s.inst[s.p[owner].leader].ki; break;
    case 'count': n = v.count ? countOf(s, owner, src, v.count, ctx ?? {}) : 0; break;
    case 'totalCost': {
      const me = s.p[owner];
      for (const u of me.battle) if (!v.filter || matchesFilter(s, u, v.filter, src)) n += costOf(s, u);
      break;
    }
  }
  return n + (v.plus ?? 0);
}

// ------------------------------------------------------------------ static rules
// [Permanent] effects that change the rules rather than a card's numbers: attack bans, damage caps,
// hand/Drop cost changes, alternative costs. Each is read from the cards in play when it matters.

export interface StaticHit<E extends Effect = Effect> { e: E; src: number; idx: number; ab: Ability }

/** Every effect of type t in the [Permanent] abilities of `side`'s cards in play whose conditions hold. */
export function staticRules<T extends Effect['t']>(s: GameState, side: Side, t: T): StaticHit<Extract<Effect, { t: T }>>[] {
  const out: StaticHit<Extract<Effect, { t: T }>>[] = [];
  const p = s.p[side];
  const srcs = p.field !== null ? [p.leader, ...p.battle, p.field] : [p.leader, ...p.battle];
  for (const src of srcs) {
    const abs = abilitiesOf(s, src);
    if (!summaryOf(abs).rules.has(t)) continue;
    abs.forEach((ab, idx) => {
      if (ab.timing !== 'permanent' || !turnMatches(s, side, ab.turn)) return;
      if (!ab.effects.some((e) => e.t === t)) return;
      if (!condsHold(s, side, src, ab.cond)) return;
      for (const e of ab.effects) if (e.t === t && condsHold(s, side, src, e.cond)) out.push({ e: e as Extract<Effect, { t: T }>, src, idx, ab });
    });
  }
  return out;
}

// ------------------------------------------------------------------ conditions & filters

export function countOf(s: GameState, owner: Side, src: number, w: Count, x: { prev?: number[]; kiRemoved?: number } = {}): number {
  const p = s.p[w.side === 'self' ? owner : other(owner)];
  if (w.zone === 'thisKi') return s.inst[src].ki;
  if (w.zone === 'event') return s.trigN ?? 0;
  if (w.zone === 'thisKiRemovedBattle') return s.inst[src].kiRemovedBattle ?? 0;
  if (w.zone === 'kiTotal') return [p.leader, ...p.battle].reduce((a, u) => a + s.inst[u].ki, 0);
  if (w.zone === 'kiRemoved') return x.kiRemoved ?? 0;
  if (w.zone === 'underMax') return Math.max(0, ...p.battle.filter((u) => !w.filter || matchesFilter(s, u, w.filter, src)).map((u) => s.inst[u].under?.length ?? 0));
  let list: number[];
  if (w.zone === 'prev') list = x.prev ?? [];
  else if (w.zone === 'under') list = p.battle.flatMap((u) => s.inst[u].under ?? []);
  else if (w.zone === 'battle') list = p.field !== null ? [...p.battle, p.field] : p.battle;
  else if (w.zone === 'leaderBattle') list = [p.leader, ...p.battle];
  else if (w.zone === 'battleDrop') list = [...p.battle, ...(p.field !== null ? [p.field] : []), ...p.drop];
  else list = p[w.zone];
  if (w.filter) list = list.filter((u) => matchesFilter(s, u, w.filter!, src));
  return w.distinct ? new Set(list.map((u) => cardOf(s, u).name)).size : list.length;
}

export function condHolds(s: GameState, owner: Side, src: number, c: Cond, prev: number[] = [], x: { kiRemoved?: number } = {}): boolean {
  const me = s.p[owner];
  const opp = s.p[other(owner)];
  switch (c.t) {
    case 'oppLifeGE': return opp.life.length >= c.n;
    case 'oppHandGE': return opp.hand.length >= c.n;
    case 'count': {
      const k = countOf(s, owner, src, c.what, { prev, kiRemoved: x.kiRemoved });
      return c.op === 'none' ? k === 0 : c.op === 'ge' ? k >= c.n : c.op === 'le' ? k <= c.n : k === c.n;
    }
    case 'leaderTrait': {
      const tr = leaderTraits(s, owner);
      if (c.only) return tr.length > 0 && tr.every((t) => c.traits.some((x) => sameTrait(t, x)));
      return c.traits.some((x) => tr.some((t) => sameTrait(t, x)));
    }
    case 'thisKiGE': return s.inst[src].ki >= c.n;
    case 'hasMarker': return (me.markers > 0) === c.yes;
    case 'thisRested': return s.inst[src].rested === c.yes;
    case 'thisInBattle': return !!s.battle && (s.battle.attacker === src || s.battle.target === src);
    case 'playedThisTurn': return s.inst[src].playedTurn === s.turn;
    case 'comboAreaHasCard': return me.combo.length > 0;
    case 'energyLessThanOpp': return me.energy.length < opp.energy.length;
    case 'attackingBattleCard': {
      // "If attacking a Battle Card": this card, or for a card outside the battle (an Extra), your attacking card.
      const b = s.battle;
      if (!b || (b.attacker !== src && b.atkSide !== owner) || isLeader(s, b.target)) return false;
      return !c.filter || matchesFilter(s, b.target, c.filter, src);
    }
    case 'prevMatches': return prev.length > 0 && prev.every((u) => matchesFilter(s, u, c.filter, src));
    case 'yourTurn': return (s.active === owner) === c.yes;
    case 'not': return !condHolds(s, owner, src, c.c, prev, x);
    case 'or': return c.any.some((y) => condHolds(s, owner, src, y, prev, x));
    case 'and': return c.all.every((y) => condHolds(s, owner, src, y, prev, x));
    case 'thisHasUnder': return ((s.inst[src].under?.length ?? 0) > 0) === c.yes;
    case 'attacking': return !!s.battle && s.battle.attacker === src && matchesFilter(s, s.battle.target, c.filter, src);
    case 'koedThisTurn': return (me.koBy ?? []).some((k) => k.turn === s.turn && (!c.filter || matchesFilter(s, k.uid, c.filter, src)));
    case 'playedByLeaderSkill': return !!s.inst[src].playedByLeader && s.inst[src].playedTurn === s.turn;
    case 'leaderInBattle': return !!s.battle && (s.battle.attacker === me.leader || s.battle.target === me.leader);
    case 'removedOwnThisTurn': return me.removedOwnTurn === s.turn;
    case 'kiRemovedThisTurn': return me.kiRemovedTurn === s.turn;
    case 'comboFromFieldThisTurn': return me.comboFieldTurn === s.turn;
    case 'bouncedThisTurn': return me.bouncedTurn === s.turn;
    case 'energyLeftThisTurn': return me.energyLeftTurn === s.turn;
    case 'extraUsedThisTurn':
      if (!c.filter) return me.extraUsedTurn === s.turn;
      return (me.usedExtras ?? []).some((x) => x.turn === s.turn && matchesFilter(s, x.uid, c.filter!, src));
    case 'lifeLeftThisTurn': return me.lifeLeftTurn === s.turn;
    case 'thisMatches': return matchesFilter(s, src, c.filter, src);
    case 'markerPaid': return !!s.inst[src].markerPaid;
    case 'oppHasMarker': return (opp.markers > 0) === c.yes;
    case 'markerUsedThisTurn': return me.markerUsedTurn === s.turn;
    case 'comboFromDropThisTurn': return me.comboDropTurn === s.turn;
    case 'removedBySkillThisTurn': return c.filter
      ? (me.removedBySkill ?? []).some((x) => x.turn === s.turn && matchesFilter(s, x.uid, c.filter!, src))
      : me.removedBySkillTurn === s.turn;
    case 'playedByEvolve': return !!s.inst[src].playedByEvolve && s.inst[src].playedTurn === s.turn;
    case 'playedBySkill': return !!s.inst[src].playedBySkill && s.inst[src].playedTurn === s.turn;
    case 'battleTotalCost': {
      const list = me.field !== null ? [...me.battle, me.field] : me.battle;
      if (c.only && !list.every((u) => matchesFilter(s, u, c.only!, src))) return false;
      return list.reduce((a, u) => a + costOf(s, u), 0) >= c.n;
    }
    case 'attackedThisTurn': return (s.inst[src].attackedTurn === s.turn) === c.yes;
    case 'revealedMatches': { const r = curCtx?.revealed; return r !== undefined && matchesFilter(s, r, c.filter, src); }
    case 'causedByLeader': {
      const c0 = s.causeSrc;
      return c0 !== undefined && isLeader(s, c0) && s.inst[c0].owner === owner && (!c.filter || matchesFilter(s, c0, c.filter, src));
    }
    case 'thisKiUpThisTurn': return s.inst[src].kiUpTurn === s.turn;
    case 'inBattleWith': {
      const b = s.battle;
      if (!b || (b.attacker !== src && b.target !== src)) return false;
      return matchesFilter(s, b.attacker === src ? b.target : b.attacker, c.filter, src);
    }
    case 'handLE': return me.hand.length <= c.n;
    case 'handGE': return me.hand.length >= c.n;
    case 'energyGE': return me.energy.length >= c.n;
    case 'energyLE': return me.energy.length <= c.n;
    case 'lifeLE': return me.life.length <= c.n;
    case 'lifeGE': return me.life.length >= c.n;
    case 'oppLifeLE': return s.p[other(owner)].life.length <= c.n;
    case 'dropGE': return me.drop.length >= c.n;
    case 'leaderAwakened': return me.awakened;
    case 'kiLeaderGE': return s.inst[me.leader].ki >= c.n;
    case 'kiTotalGE': return kiTotal(s, owner, c.scope) >= c.n;
    case 'leaderIs': {
      const lc = cardOf(s, me.leader);
      return c.names.some((n) => lc.name.includes(n) || lc.characters.some((ch) => ch.includes(n)));
    }
    case 'battleCount': {
      const side = c.side === 'self' ? owner : other(owner);
      const k = s.p[side].battle.filter((u) => matchesFilter(s, u, c.filter, src)).length;
      return c.op === 'none' ? k === 0 : k >= c.n;
    }
  }
}

/** "Your Ki" counts the Leader and Battle Cards; "Ki in your Battle Area" only Battle Cards (manual p.12). */
export function kiTotal(s: GameState, owner: Side, scope: 'your' | 'battle'): number {
  const me = s.p[owner];
  let k = scope === 'your' ? s.inst[me.leader].ki : 0;
  for (const u of me.battle) k += s.inst[u].ki;
  return k;
}

export function condsHold(s: GameState, owner: Side, src: number, conds: Cond[] | undefined, prev: number[] = [], x: { kiRemoved?: number } = {}): boolean {
  if (!conds) return true;
  for (const c of conds) if (!condHolds(s, owner, src, c, prev, x)) return false;
  return true;
}

const sameTrait = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function leaderTraits(s: GameState, owner: Side): string[] {
  const p = s.p[owner];
  const c = cardOf(s, p.leader);
  // Leaders list front traits; the back side normally shares them.
  return c.traits;
}

export function nameMatches(card: Card, names: string[]): boolean {
  return names.some((n) => {
    const k = n.toLowerCase();
    return card.name.toLowerCase().includes(k) || card.characters.some((ch) => ch.toLowerCase().includes(k));
  });
}

export function matchesFilter(s: GameState, uid: number, f: Filter, src: number): boolean {
  const card = cardOf(s, uid);
  const inst = s.inst[uid];
  const leader = isLeader(s, uid);
  if (f.type && !leader && card.type !== f.type) return false;
  const here = inPlay(s, uid);
  const cost = f.originalCost ? card.cost : here ? costOf(s, uid) : costInDrop(s, uid);
  if (f.costLE !== undefined && cost > f.costLE) return false;
  if (f.costGE !== undefined && cost < f.costGE) return false;
  if (f.costEQ !== undefined && cost !== f.costEQ) return false;
  const pw = f.originalPower ? (leader ? basePower(s, uid) : card.power) : here && (leader || s.p[inst.owner].battle.includes(uid)) ? powerOf(s, uid) : card.power;
  if (f.powerLE !== undefined && pw > f.powerLE) return false;
  if (f.powerGE !== undefined && pw < f.powerGE) return false;
  if (f.powerEQ !== undefined && pw !== f.powerEQ) return false;
  if (f.notNames && nameMatches(card, f.notNames)) return false;
  if (f.traitsAll && !f.traitsAll.every((t) => card.traits.some((ct) => ct.toLowerCase() === t.toLowerCase()))) return false;
  if (f.onlyTraits && !(card.traits.length > 0 && card.traits.every((ct) => f.onlyTraits!.some((t) => ct.toLowerCase() === t.toLowerCase())))) return false;
  if (f.kiGE !== undefined && inst.ki < f.kiGE) return false;
  if (f.comboLE !== undefined && card.comboPower > f.comboLE) return false;
  if (f.comboEQ !== undefined && card.comboPower !== f.comboEQ) return false;
  if (f.notTraits && card.traits.some((ct) => f.notTraits!.some((t) => ct.toLowerCase() === t.toLowerCase()))) return false;
  if (f.underNames && !(inst.under ?? []).some((u) => nameMatches(cardOf(s, u), f.underNames!))) return false;
  if (f.anyOf && !f.anyOf.some((x) => matchesFilter(s, uid, x, src))) return false;
  if (f.costLEv || f.costEQv || f.powerLEv) {
    const owner = s.inst[src].owner;
    if (f.costLEv && cost > valOf(s, owner, src, f.costLEv)) return false;
    if (f.costEQv && cost !== valOf(s, owner, src, f.costEQv)) return false;
    if (f.powerLEv && pw > valOf(s, owner, src, f.powerLEv)) return false;
  }
  if (f.playedFrom && inst.playedFrom !== f.playedFrom) return false;
  if (f.playedThisTurn !== undefined && (inst.playedTurn === s.turn) !== f.playedThisTurn) return false;
  if (f.sharesTraitWithPrev) {
    const c0 = chosenCard(curCtx);
    if (c0 === undefined || !cardOf(s, c0).traits.some((t) => card.traits.some((ct) => ct.toLowerCase() === t.toLowerCase()))) return false;
  }
  if (f.noSkill && card.text.trim() !== '' && card.text.trim() !== '-') return false;
  if (f.keyword) {
    const cc = compiledOf(s, uid);
    const ok = f.keyword === 'evolve' ? !!cc.evolve && cc.evolve.from.length === 1
      : f.keyword === 'fusionEvolve' ? !!cc.evolve && cc.evolve.from.length === 2
      : here ? hasKeyword(s, uid, f.keyword) : cc.keywords.has(f.keyword);
    if (!ok) return false;
  }
  if (f.rested && !inst.rested) return false;
  if (f.active && inst.rested) return false;
  if (f.names && !nameMatches(card, f.names)) return false;
  if (f.traits && !f.traits.some((t) => card.traits.some((ct) => ct.toLowerCase().includes(t.toLowerCase())))) return false;
  if (f.colors && !f.colors.some((c) => card.colors.includes(c))) return false;
  if (f.other && uid === src) return false;
  return true;
}

// ------------------------------------------------------------------ power

export function staticPower(s: GameState, uid: number): number {
  const owner = s.inst[uid].owner;
  let add = 0;
  const yourTurn = s.active === owner;
  if (staticDepth >= MAX_STATIC_DEPTH) return 0;
  const abs = abilitiesOf(s, uid);
  if (!summaryOf(abs).selfPower) { const au = auraEffects(s, uid); for (const e of au) if (e.t === 'power') add += e.amount; return add; }
  staticDepth++;
  try {
  for (const ab of abs) {
    if (ab.timing !== 'permanent') continue;
    if (ab.turn === 'your' && !yourTurn) continue;
    if (ab.turn === 'opp' && yourTurn) continue;
    if (!ab.effects.some((e) => e.t === 'power')) continue;
    if (!condsHold(s, owner, uid, ab.cond)) continue;
    for (const e of ab.effects) {
      if (e.t === 'power' && (e.target.ref === 'this' || (e.target.ref === 'leader' && isLeader(s, uid))) && condsHold(s, owner, uid, (e as any).cond))
        add += e.per ? e.amount * countOf(s, owner, uid, e.per) : e.amount;
    }
  }
  for (const e of auraEffects(s, uid)) if (e.t === 'power') add += e.amount;
  } finally { staticDepth--; }
  return add;
}

export function basePower(s: GameState, uid: number): number {
  const set = s.inst[uid].basePowerSet;
  if (set && (set.until === 'battle' || set.until >= s.turn)) return set.value;
  const c = cardOf(s, uid);
  if (isLeader(s, uid) && s.p[s.inst[uid].owner].awakened && c.back) return c.back.power;
  return c.power;
}

export function powerOf(s: GameState, uid: number): number {
  let p = basePower(s, uid) + staticPower(s, uid);
  for (const m of s.inst[uid].mods) p += m.amount;
  return p;
}

export function comboPowerOf(s: GameState, uid: number): number {
  return cardOf(s, uid).comboPower + s.inst[uid].comboBonus;
}

// ------------------------------------------------------------------ costs

export function costInHand(s: GameState, uid: number): number {
  const card = cardOf(s, uid);
  const owner = s.inst[uid].owner;
  let cost = card.cost;
  for (const ab of compiledOf(s, uid).abilities) {
    if (ab.timing !== 'permanent' || !turnMatches(s, owner, ab.turn) || !condsHold(s, owner, uid, ab.cond)) continue;
    for (const e of ab.effects) if (e.t === 'costReduce' && condsHold(s, owner, uid, e.cond)) cost -= e.per ? e.n * countOf(s, owner, uid, e.per) : e.n;
  }
  for (const m of activeMods(s, owner)) {
    if (m.kind !== 'tax' && m.kind !== 'discount') continue;
    if (!matchesFilter(s, uid, m.filter, uid)) continue;
    if (m.kind === 'tax') cost += m.amount as number;
    if (m.kind === 'discount') cost = m.amount === 'free' ? 0 : cost - (m.amount as number);
  }
  // "Reduce the skill cost by N" also covers using an Extra from your hand.
  if (card.type === 'EXTRA') {
    const sd = activeMods(s, owner).find((m) => m.kind === 'skillDiscount' && matchesFilter(s, uid, m.filter, uid));
    if (sd) cost -= sd.amount as number;
  }
  for (const h of handCostMods(s, uid)) cost = h.e.amount === 'free' ? 0 : cost + h.e.amount;
  return Math.max(0, cost);
}

const handKey = (h: StaticHit) => `hc:${h.src}:${h.idx}`;

/** [Permanent] cost changes your cards in play give to a card in your hand. */
export function handCostMods(s: GameState, uid: number): StaticHit<Extract<Effect, { t: 'handCostMod' }>>[] {
  const owner = s.inst[uid].owner;
  return staticRules(s, owner, 'handCostMod').filter((h) => matchesFilter(s, uid, h.e.filter, h.src) && !(h.e.once && s.p[owner].usedOnce.includes(handKey(h))));
}

/** Mark once-per-turn hand cost changes as used when the card is paid for. */
export function spendHandCostMods(s: GameState, uid: number) {
  const owner = s.inst[uid].owner;
  for (const h of handCostMods(s, uid)) if (h.e.once) s.p[owner].usedOnce.push(handKey(h));
}

/** Cost of a card outside play: in the Drop, [Permanent] "reduce the cost of this card in its owner's Drop" applies. */
export function costInDrop(s: GameState, uid: number): number {
  const card = cardOf(s, uid);
  const owner = s.inst[uid].owner;
  const p = s.p[owner];
  const own = summaryOf(compiledOf(s, uid).abilities).rules.has('dropCost');
  let others = false;
  for (const u of p.battle) if (summaryOf(abilitiesOf(s, u)).rules.has('dropCost')) { others = true; break; }
  if ((!own && !others) || !p.drop.includes(uid)) return card.cost;
  let cost = card.cost;
  if (own) {
    for (const ab of compiledOf(s, uid).abilities) {
      if (ab.timing !== 'permanent' || !condsHold(s, owner, uid, ab.cond)) continue;
      for (const e of ab.effects) if (e.t === 'dropCost' && !e.filter && condsHold(s, owner, uid, e.cond)) cost = e.set ?? cost + (e.amount ?? 0);
    }
  }
  if (others) {
    for (const h of staticRules(s, owner, 'dropCost')) if (h.e.filter && matchesFilter(s, uid, h.e.filter, h.src)) cost = h.e.set ?? cost + (h.e.amount ?? 0);
  }
  return Math.max(0, cost);
}

export const activeMods = (s: GameState, p: Side) => (s.p[p].mods ?? []).filter((m) => m.until >= s.turn);

/** Spend the first discount that applied to this card. */
export function consumeDiscount(s: GameState, uid: number) {
  const p = s.p[s.inst[uid].owner];
  if (!p.mods) return;
  const i = p.mods.findIndex((m) => m.kind === 'discount' && m.until >= s.turn && matchesFilter(s, uid, m.filter, uid));
  if (i >= 0) p.mods.splice(i, 1);
}

/** "You can't play X for the turn". */
export function playBanned(s: GameState, uid: number): boolean {
  const owner = s.inst[uid].owner;
  const isExtra = cardOf(s, uid).type === 'EXTRA';
  return activeMods(s, owner).some((m) => m.kind === 'cantPlay' && !!m.extras === isExtra && matchesFilter(s, uid, m.filter, uid));
}

export const activeEnergy = (s: GameState, p: Side) => s.p[p].energy.filter((u) => !s.inst[u].rested);

/**
 * Pick energy to rest for a cost. Coloured orbs first (using the least
 * flexible cards), then any colour. Returns null when the cost cannot be met.
 * An energy marker counts as one energy of the leader's colour.
 */
export function planPayment(s: GameState, p: Side, total: number, spec: Partial<Record<Color, number>>): { rest: number[]; markers: number } | null {
  if (total <= 0) return { rest: [], markers: 0 };
  const avail = activeEnergy(s, p);
  if (total > avail.length + s.p[p].markers) return null; // can't afford it whatever the colors
  const used = new Set<number>();
  let markers = s.p[p].markers;
  let usedMarkers = 0;
  const leaderColors = cardOf(s, s.p[p].leader).colors;
  // Reduce the specified requirement if the total got reduced below it.
  const specTotal = Object.values(spec).reduce((a, b) => a + (b ?? 0), 0);
  let excess = Math.max(0, specTotal - total);
  const need: [Color, number][] = (Object.entries(spec) as [Color, number][]).map(([c, k]) => {
    const cut = Math.min(excess, k);
    excess -= cut;
    return [c, k - cut];
  });
  for (const [color, k] of need) {
    let left = k;
    const cands = avail
      .filter((u) => !used.has(u) && cardOf(s, u).colors.includes(color))
      .sort((a, b) => cardOf(s, a).colors.length - cardOf(s, b).colors.length);
    for (const u of cands) { if (left === 0) break; used.add(u); left--; }
    while (left > 0 && markers > 0 && leaderColors.includes(color)) { markers--; usedMarkers++; left--; }
    if (left > 0) return null;
  }
  let remaining = total - used.size - usedMarkers;
  for (const u of avail) { if (remaining <= 0) break; if (!used.has(u)) { used.add(u); remaining--; } }
  while (remaining > 0 && markers > 0) { markers--; usedMarkers++; remaining--; }
  if (remaining > 0) return null;
  return { rest: [...used], markers: usedMarkers };
}

export function payPlan(s: GameState, p: Side, plan: { rest: number[]; markers: number }) {
  for (const u of plan.rest) s.inst[u].rested = true;
  s.p[p].markers -= plan.markers;
  if (plan.markers > 0) s.p[p].markerUsedTurn = s.turn;
}

export function specFor(s: GameState, uid: number, total: number): Partial<Record<Color, number>> {
  const card = cardOf(s, uid);
  return total < card.cost ? scaleSpec(card.specified, total) : card.specified;
}

function scaleSpec(spec: Partial<Record<Color, number>>, total: number) {
  const out: Partial<Record<Color, number>> = {};
  let left = total;
  for (const [c, k] of Object.entries(spec) as [Color, number][]) {
    const t = Math.min(k, left);
    if (t > 0) out[c] = t;
    left -= t;
  }
  return out;
}

// ------------------------------------------------------------------ moving cards

export function removeFrom(s: GameState, uid: number): Zone {
  s.zoneRev = (s.zoneRev ?? 0) + 1;
  const owner = s.inst[uid].owner;
  const p = s.p[owner];
  if (p.field === uid) { p.field = null; return 'field'; }
  for (const z of ['battle', 'hand', 'energy', 'drop', 'life', 'combo', 'deck'] as const) {
    const i = p[z].indexOf(uid);
    if (i >= 0) { p[z].splice(i, 1); return z; }
  }
  return 'removed';
}

export function resetInst(i: Inst) {
  i.rested = false;
  i.mods = [];
  i.grants = [];
  i.comboBonus = 0;
  i.lockedUntil = 0;
  i.ki = 0;
  i.costMods = undefined;
  i.negatedUntil = undefined;
  i.negateScope = undefined;
  i.basePowerSet = undefined;
  i.kiRemovedBattle = undefined;
  i.playedFrom = undefined;
}

export function moveTo(s: GameState, uid: number, zone: Exclude<Zone, 'leader' | 'removed' | 'field'>, opts: { bottom?: boolean; rested?: boolean } = {}) {
  const from = removeFrom(s, uid);
  const inst = s.inst[uid];
  // "If you would add a card to its owner's energy during this turn, place that card into its owner's Drop instead."
  if (zone === 'energy' && (s.p[inst.owner].mods ?? []).some((m) => m.kind === 'energyRedirect' && m.until >= s.turn)) zone = 'drop';
  if (from === 'battle' && zone === 'hand') s.p[inst.owner].bouncedTurn = s.turn;
  if (from === 'energy') s.p[inst.owner].energyLeftTurn = s.turn;
  if (from === 'energy' && zone === 'drop') (s.removals ??= []).push({ uid, owner: inst.owner, by: s.skillBy ?? inst.owner, kind: 'energyDrop', bySrc: s.skillSrc });
  if (from === 'battle' && s.skillBy !== undefined && cardOf(s, uid).type === 'BATTLE') {
    if (s.skillBy === inst.owner) s.p[inst.owner].removedOwnTurn = s.turn;
    s.p[inst.owner].removedBySkillTurn = s.turn;
    (s.p[inst.owner].removedBySkill ??= []).push({ turn: s.turn, uid });
    (s.removals ??= []).push({ uid, owner: inst.owner, by: s.skillBy, to: zone });
  }
  if (inst.under?.length && from === 'battle') {
    for (const u of inst.under) { resetInst(s.inst[u]); s.p[s.inst[u].owner].drop.push(u); }
  }
  inst.under = undefined;
  resetInst(inst);
  if (opts.rested) inst.rested = true;
  const arr = s.p[inst.owner][zone];
  if (zone === 'deck' && opts.bottom) arr.unshift(uid);
  else arr.push(uid);
}
