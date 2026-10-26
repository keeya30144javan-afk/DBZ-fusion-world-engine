import { Card, Color } from '../data/types';
import { RulesConfig } from '../data/rules';
import { compileCard } from '../effects/parse';
import { Ability, CompiledCard, Cond, Filter, Keyword } from '../effects/types';

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
    mulliganed: p.mulliganed,
  });
  return {
    ...s,
    inst: s.inst.map((i) => ({ ...i, mods: i.mods.length ? i.mods.slice() : [], grants: i.grants.length ? i.grants.slice() : [] })),
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
  if (isLeader(s, uid) && s.p[s.inst[uid].owner].awakened && c.backAbilities) return c.backAbilities;
  return c.abilities;
}

export function hasKeyword(s: GameState, uid: number, kw: Keyword): boolean {
  const inst = s.inst[uid];
  if (inst.grants.some((g) => g.kw === kw)) return true;
  const c = compiledOf(s, uid);
  if (isLeader(s, uid) && s.p[inst.owner].awakened && c.backKeywords) return c.backKeywords.has(kw);
  return c.keywords.has(kw);
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

export function condHolds(s: GameState, owner: Side, src: number, c: Cond): boolean {
  const me = s.p[owner];
  switch (c.t) {
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

export function condsHold(s: GameState, owner: Side, src: number, conds: Cond[] | undefined): boolean {
  if (!conds) return true;
  for (const c of conds) if (!condHolds(s, owner, src, c)) return false;
  return true;
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
  if (f.costLE !== undefined && card.cost > f.costLE) return false;
  if (f.costGE !== undefined && card.cost < f.costGE) return false;
  if (f.costEQ !== undefined && card.cost !== f.costEQ) return false;
  const inPlay = leader || s.p[inst.owner].battle.includes(uid);
  const pw = inPlay ? powerOf(s, uid) : card.power;
  if (f.powerLE !== undefined && pw > f.powerLE) return false;
  if (f.powerGE !== undefined && pw < f.powerGE) return false;
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
        add += e.amount;
    }
  }
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
    if (ab.timing !== 'permanent' || !condsHold(s, owner, uid, ab.cond)) continue;
    for (const e of ab.effects) if (e.t === 'costReduce') cost -= e.n;
  }
  return Math.max(0, cost);
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
}

export function moveTo(s: GameState, uid: number, zone: Exclude<Zone, 'leader' | 'removed' | 'field'>, opts: { bottom?: boolean; rested?: boolean } = {}) {
  removeFrom(s, uid);
  const inst = s.inst[uid];
  resetInst(inst);
  if (opts.rested) inst.rested = true;
  const arr = s.p[inst.owner][zone];
  if (zone === 'deck' && opts.bottom) arr.unshift(uid);
  else arr.push(uid);
}
