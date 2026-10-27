import { Card, Color } from '../data/types';
import { RulesConfig } from '../data/rules';
import { compileCard } from '../effects/parse';
import { Ability, CompiledCard, Cond, Count, Effect, Filter, Keyword } from '../effects/types';

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
  negateScope?: 'all' | 'onPlay';
}

/** A lasting rule change on one player: discounts, play bans, taxes. */
export interface PlayerMod {
  kind: 'discount' | 'cantPlay' | 'tax' | 'playRested' | 'skillLock';
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
  /** Battle Cards that left a Battle Area during the current skill, for removal triggers. */
  removals?: { uid: number; owner: Side; by: Side }[];
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
  const clonePlayer = (p: PlayerState): PlayerState => ({
    leader: p.leader,
    awakened: p.awakened,
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
    mulliganed: p.mulliganed,
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

const auraCache = new WeakMap<object, boolean>();
const hasAura = (abs: Ability[]) => {
  let v = auraCache.get(abs);
  if (v === undefined) {
    v = abs.some((a) => a.timing === 'permanent' && a.effects.some((e) => (e.t === 'grant' || e.t === 'power') && e.target.all));
    auraCache.set(abs, v);
  }
  return v;
};
let auraDepth = 0;

/** Permanent grant/power effects other cards give to `uid`. */
export function auraEffects(s: GameState, uid: number): Effect[] {
  if (auraDepth > 0) return []; // an aura's own condition doesn't see auras: no loops
  const out: Effect[] = [];
  const where = isLeader(s, uid) ? 'leader' : 'battle';
  auraDepth++;
  try {
    for (const side of [0, 1] as Side[]) {
      const p = s.p[side];
      const srcs = p.field !== null ? [p.leader, ...p.battle, p.field] : [p.leader, ...p.battle];
      for (const src of srcs) {
        const abs = abilitiesOf(s, src);
        if (!hasAura(abs)) continue;
        for (const ab of abs) {
          if (ab.timing !== 'permanent' || !turnMatches(s, side, ab.turn)) continue;
          for (const e of ab.effects) {
            if ((e.t !== 'grant' && e.t !== 'power') || !e.target.all) continue;
            const t = e.target;
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
  // [Permanent] "this card gains [X]" / "this card can't attack" with conditions.
  for (const ab of abilitiesOf(s, uid)) {
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

/** Cost of a card where it is, with any cost changes on it. */
export function costOf(s: GameState, uid: number): number {
  const base = cardOf(s, uid).cost;
  const mods = s.inst[uid].costMods;
  let c = base;
  if (mods) for (const m of mods) c += m.amount;
  for (const ab of abilitiesOf(s, uid)) {
    if (ab.timing !== 'permanent' || !turnMatches(s, s.inst[uid].owner, ab.turn)) continue;
    if (!condsHold(s, s.inst[uid].owner, uid, ab.cond)) continue;
    for (const e of ab.effects) if (e.t === 'costMod' && e.target.ref === 'this' && inPlay(s, uid)) c += e.per ? e.amount * countOf(s, s.inst[uid].owner, uid, e.per) : e.amount;
  }
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

export function log(s: GameState, msg: string) {
  if (s.log) s.log.push(`T${s.turn} ${msg}`);
}

export function emit(s: GameState, e: GameEvent) {
  if (s.events) s.events.push(e);
}

export const nameOf = (s: GameState, uid: number) => {
  const c = cardOf(s, uid);
  return isLeader(s, uid) && s.p[s.inst[uid].owner].awakened && c.back ? c.back.name : c.name;
};

// ------------------------------------------------------------------ conditions & filters

export function countOf(s: GameState, owner: Side, src: number, w: Count, x: { prev?: number[]; kiRemoved?: number } = {}): number {
  const p = s.p[w.side === 'self' ? owner : other(owner)];
  if (w.zone === 'thisKi') return s.inst[src].ki;
  if (w.zone === 'kiTotal') return [p.leader, ...p.battle].reduce((a, u) => a + s.inst[u].ki, 0);
  if (w.zone === 'kiRemoved') return x.kiRemoved ?? 0;
  let list: number[];
  if (w.zone === 'prev') list = x.prev ?? [];
  else if (w.zone === 'under') list = p.battle.flatMap((u) => s.inst[u].under ?? []);
  else if (w.zone === 'battle') list = p.field !== null ? [...p.battle, p.field] : p.battle;
  else list = p[w.zone];
  return w.filter ? list.filter((u) => matchesFilter(s, u, w.filter!, src)).length : list.length;
}

export function condHolds(s: GameState, owner: Side, src: number, c: Cond, prev: number[] = []): boolean {
  const me = s.p[owner];
  const opp = s.p[other(owner)];
  switch (c.t) {
    case 'oppLifeGE': return opp.life.length >= c.n;
    case 'oppHandGE': return opp.hand.length >= c.n;
    case 'count': {
      const k = countOf(s, owner, src, c.what, { prev });
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
      const b = s.battle;
      if (!b || b.attacker !== src || isLeader(s, b.target)) return false;
      return !c.filter || matchesFilter(s, b.target, c.filter, src);
    }
    case 'prevMatches': return prev.length > 0 && prev.every((u) => matchesFilter(s, u, c.filter, src));
    case 'yourTurn': return (s.active === owner) === c.yes;
    case 'not': return !condHolds(s, owner, src, c.c, prev);
    case 'or': return c.any.some((x) => condHolds(s, owner, src, x, prev));
    case 'thisHasUnder': return ((s.inst[src].under?.length ?? 0) > 0) === c.yes;
    case 'attacking': return !!s.battle && s.battle.attacker === src && matchesFilter(s, s.battle.target, c.filter, src);
    case 'koedThisTurn': return (me.koBy ?? []).some((k) => k.turn === s.turn && (!c.filter || matchesFilter(s, k.uid, c.filter, src)));
    case 'playedByLeaderSkill': return !!s.inst[src].playedByLeader && s.inst[src].playedTurn === s.turn;
    case 'leaderInBattle': return !!s.battle && (s.battle.attacker === me.leader || s.battle.target === me.leader);
    case 'removedOwnThisTurn': return me.removedOwnTurn === s.turn;
    case 'kiRemovedThisTurn': return me.kiRemovedTurn === s.turn;
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

export function condsHold(s: GameState, owner: Side, src: number, conds: Cond[] | undefined, prev: number[] = []): boolean {
  if (!conds) return true;
  for (const c of conds) if (!condHolds(s, owner, src, c, prev)) return false;
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
  const cost = f.originalCost || !here ? card.cost : costOf(s, uid);
  if (f.costLE !== undefined && cost > f.costLE) return false;
  if (f.costGE !== undefined && cost < f.costGE) return false;
  if (f.costEQ !== undefined && cost !== f.costEQ) return false;
  const pw = here && (leader || s.p[inst.owner].battle.includes(uid)) ? powerOf(s, uid) : card.power;
  if (f.powerLE !== undefined && pw > f.powerLE) return false;
  if (f.powerGE !== undefined && pw < f.powerGE) return false;
  if (f.powerEQ !== undefined && pw !== f.powerEQ) return false;
  if (f.notNames && nameMatches(card, f.notNames)) return false;
  if (f.traitsAll && !f.traitsAll.every((t) => card.traits.some((ct) => ct.toLowerCase() === t.toLowerCase()))) return false;
  if (f.onlyTraits && !(card.traits.length > 0 && card.traits.every((ct) => f.onlyTraits!.some((t) => ct.toLowerCase() === t.toLowerCase())))) return false;
  if (f.kiGE !== undefined && inst.ki < f.kiGE) return false;
  if (f.notTraits && card.traits.some((ct) => f.notTraits!.some((t) => ct.toLowerCase() === t.toLowerCase()))) return false;
  if (f.underNames && !(inst.under ?? []).some((u) => nameMatches(cardOf(s, u), f.underNames!))) return false;
  if (f.anyOf && !f.anyOf.some((x) => matchesFilter(s, uid, x, src))) return false;
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
  for (const ab of abilitiesOf(s, uid)) {
    if (ab.timing !== 'permanent') continue;
    if (ab.turn === 'your' && !yourTurn) continue;
    if (ab.turn === 'opp' && yourTurn) continue;
    if (!condsHold(s, owner, uid, ab.cond)) continue;
    for (const e of ab.effects) {
      if (e.t === 'power' && (e.target.ref === 'this' || (e.target.ref === 'leader' && isLeader(s, uid))) && condsHold(s, owner, uid, (e as any).cond))
        add += e.per ? e.amount * countOf(s, owner, uid, e.per) : e.amount;
    }
  }
  for (const e of auraEffects(s, uid)) if (e.t === 'power') add += e.amount;
  return add;
}

export function basePower(s: GameState, uid: number): number {
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
    for (const e of ab.effects) if (e.t === 'costReduce' && condsHold(s, owner, uid, e.cond)) cost -= e.n;
  }
  for (const m of activeMods(s, owner)) {
    if (!matchesFilter(s, uid, m.filter, uid)) continue;
    if (m.kind === 'tax') cost += m.amount as number;
    if (m.kind === 'discount') cost = m.amount === 'free' ? 0 : cost - (m.amount as number);
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
}

export function moveTo(s: GameState, uid: number, zone: Exclude<Zone, 'leader' | 'removed' | 'field'>, opts: { bottom?: boolean; rested?: boolean } = {}) {
  const from = removeFrom(s, uid);
  const inst = s.inst[uid];
  if (from === 'battle' && s.skillBy !== undefined && cardOf(s, uid).type === 'BATTLE') {
    if (s.skillBy === inst.owner) s.p[inst.owner].removedOwnTurn = s.turn;
    (s.removals ??= []).push({ uid, owner: inst.owner, by: s.skillBy });
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
