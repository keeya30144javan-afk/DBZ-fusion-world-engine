import { Card } from '../data/types';
import { Ability, Cond, Cost, Effect, Filter, Keyword, Target, Timing } from './types';

/**
 * Translations ("scripts"): a card's skills written directly in the skill
 * language, by Claude or a person, for text the parser cannot read.
 * Everything here is plain JSON so it can be stored, checked and diffed.
 */

/** FNV-1a over both faces' text: a script is only used for the exact text it was written for. */
export function textHash(card: Pick<Card, 'text' | 'back'>): string {
  const t = card.text + '\u0000' + (card.back?.text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ vocabulary

export const TIMINGS: Timing[] = [
  'onPlay', 'whenAttacking', 'whenAttacked', 'whenKOd', 'whenBlocking', 'activateMain', 'activateBattle', 'counter', 'permanent',
  'endOfYourTurn', 'startOfYourTurn', 'awaken', 'comboFromHand', 'comboFromField', 'whenDamaged', 'whenAllyPlayed', 'whenMilled', 'gameStart',
  'whenWinsBattle', 'whenDealsDamage', 'whenKOsInBattle', 'whenAllyKOd', 'comboFromDrop', 'whenAllyAttacks', 'whenComboInBattle', 'whenOppAttacks', 'whenAllyRemovedBySelf', 'whenAllyRemovedByOpp',
  'whenOppBounced', 'whenEnergyToDrop', 'whenOppPlays', 'whenActivated', 'whenAllyActivated', 'whenFieldComboInBattle', 'whenDiscardBySkill',
  'whenAllyDealsDamage', 'whenAllyKOsInBattle', 'whenRestedBySelf', 'replace', 'auto',
];
export const KEYWORDS: Keyword[] = [
  'blocker', 'critical', 'doubleStrike', 'tripleStrike', 'superCombo', 'barrier', 'indestructible', 'field', 'dragonBall',
  'cantAttack', 'cantAttackLeader', 'cantBlock', 'koImmuneSkills', 'koImmune', 'koImmuneOnce', 'koImmuneBattle', 'removeImmune', 'cantBeRested', 'attackActive',
  'comboRested', 'noUntap', 'mustAttack', 'doubleForRest',
];
const DURATIONS = ['battle', 'turn', 'oppNextTurn', 'static', 'game'];
const COLORS = ['Red', 'Blue', 'Green', 'Yellow', 'Black'];

type Spec = Record<string, string>;
/**
 * Field types: n=number, b=boolean, s=string, T=Target, F=Filter, F[]=Filter list, D=Duration,
 * K=Keyword, E[][]=effect option lists, C=Count, Z:a|b=one of; trailing ? = optional.
 */
const EFFECTS: Record<Effect['t'], Spec> = {
  draw: { n: 'n', per: 'C?' },
  lifeToHand: { n: 'n', upTo: 'b' },
  power: { target: 'T', amount: 'n', dur: 'D', per: 'C?' },
  comboPower: { target: 'T', amount: 'n' },
  ko: { target: 'T' },
  bounce: { target: 'T' },
  bottom: { target: 'T' },
  toDrop: { target: 'T' },
  toEnergy: { target: 'T', rested: 'b' },
  rest: { target: 'T' },
  activate: { target: 'T' },
  lockActive: { target: 'T' },
  grant: { target: 'T', kw: 'K', dur: 'D' },
  costMod: { target: 'T', amount: 'n', dur: 'D', per: 'C?' },
  search: { look: 'n', options: 'F[]', take: 'n', toHand: 'b', dest: 'Z:hand|play|drop|life?', rest: 'Z:bottom|drop|top|hand?', rested: 'b?', negate: 'Z:all|onPlay?', fromBottom: 'b?', eachOption: 'b?' },
  dropToHand: { options: 'F[]', each: 'n', per: 'C?', distinctCosts: 'b?', distinctNames: 'b?', totalCostLE: 'n?' },
  playFrom: { from: 'Z:drop|hand|deck|energy|life|lifeTop', filter: 'F', n: 'n', rested: 'b?', extraType: 'b?', negate: 'Z:all|onPlay?', each: 'F[]?', totalCostLE: 'n?', distinctNames: 'b?' },
  energyFromDeck: { n: 'n', rested: 'b' },
  energyFromDrop: { filter: 'F', n: 'n', rested: 'b' },
  energyFromLife: { n: 'n', rested: 'b' },
  energyFromHand: { n: 'n', rested: 'b', filter: 'F?' },
  activateEnergy: { n: 'n' },
  discard: { n: 'n' },
  oppDiscard: { n: 'n' },
  mill: { n: 'n' },
  costReduce: { n: 'n', per: 'C?' },
  cantBlock: {},
  damageLeader: { n: 'n' },
  flipLeader: {},
  ki: { target: 'T', n: 'n', per: 'C?' },
  placeMarker: { n: 'n' },
  lifeFromDeck: { n: 'n', until: 'n?' },
  handToLife: { n: 'n', upTo: 'b', pos: 'Z:bottom|topOrBottom?' },
  handToDeck: { n: 'n', bottom: 'b?' },
  self: { to: 'Z:hand|drop|energy|deckBottom|play|life', rested: 'b?' },
  nextDiscount: { filter: 'F', amount: 'n|free' },
  cantPlay: { filter: 'F', dur: 'D', extras: 'b?', opp: 'b?' },
  oppTax: { amount: 'n', filter: 'F?', dur: 'Z:turn|oppNextTurn?' },
  oppPlayRested: { filter: 'F' },
  placeUnder: { target: 'T', from: 'Z:drop|hand|deck|battle|handOrBattle', filters: 'F[]', n: 'n', untilUnder: 'n?' },
  choose: { options: 'E[][]' },
  comboFrom: { from: 'Z:drop|deckTop', filter: 'F', n: 'n', per: 'C?' },
  atEndOfTurn: { effects: 'E[]' },
  lockSkill: { names: 's[]', timing: 'Z:activateMain|activateBattle', dur: 'D' },
  dropToDeck: { bottom: 'b?' },
  lifeToDeck: { n: 'n' },
  negate: { target: 'T', dur: 'D', scope: 'Z:all|onPlay?' },
  redirect: { target: 'T' },
  winGame: {},
  selfDamage: { n: 'n' },
  atEndOfBattle: { effects: 'E[]' },
  oppMarker: { n: 'n' },
  energyToDrop: { n: 'n' },
  reveal: { from: 'Z:deckTop|oppDeckTop|oppHand|lifeTop' },
  pick: { target: 'T' },
  attackRule: { attacker: 'F?', against: 'F?', againstZone: 'Z:leader|battle?', againstThis: 'b?', onlyAgainst: 'F?', restTax: 'n?', noBlock: 'b?', dur: 'D' },
  damageCap: { n: 'n' },
  shield: { dur: 'D' },
  cantLose: { dur: 'D' },
  oppLife: { n: 'n', to: 'Z:drop|energy', rested: 'b?' },
  oppMill: { n: 'n' },
  delayed: { on: 'Z:dealsDamage|koInBattle|attacks|usesExtra', filter: 'F?', targetFilter: 'F?', once: 'b', effects: 'E[]' },
  handCostMod: { filter: 'F', amount: 'n|free', once: 'b?' },
  altCost: { filter: 'F?', costs: 'Co[]', scaleN: 'b?', once: 'b?', inBattle: 'b?', costLEv: 'V?' },
  dropCost: { amount: 'n?', set: 'n?', filter: 'F?' },
  setBasePower: { target: 'T', value: 'n|V', dur: 'D' },
  evolveDiscount: { filter: 'F', amount: 'n' },
  evolveFromUnder: { filter: 'F' },
  toCombo: { target: 'T' },
  oppNoActivate: {},
  repeatExtra: { filter: 'F' },
  skillDiscount: { filter: 'F', amount: 'n' },
  unflipLeader: {},
  swapBattler: { target: 'T' },
  extraTurn: {},
  copyOnPlay: { filter: 'F', n: 'n' },
  useDropSkill: { filter: 'F', timing: 'Tm' },
  energyToHand: { n: 'n', filter: 'F' },
  energyRedirect: {},
  lockEnergy: { n: 'n' },
  restOppEnergy: { filter: 'F', n: 'n?' },
  optionalCost: { costs: 'Co[]', effects: 'E[]' },
  evolveOnto: {},
  group: { effects: 'E[]' },
  noop: { note: 's' },
};
const COSTS: Record<Cost['t'], Spec> = {
  discard: { n: 'n', filter: 'F?' },
  energyToDrop: { n: 'n', filter: 'F?' },
  restSelf: {},
  restEnergy: { n: 'n' },
  selfToDrop: {},
  selfToHand: {},
  selfToDeckBottom: {},
  koSelf: {},
  lifeToHand: { n: 'n', all: 'b?' },
  lifeToDrop: { n: 'n' },
  takeDamage: { n: 'n' },
  reduceKi: { n: 'n', scope: 'Z:this|leader|your|battle', max: 'n?' },
  koOwn: { n: 'n', filter: 'F' },
  restOwn: { n: 'n', filter: 'F', orLeader: 'b?' },
  dropOwn: { n: 'n', filter: 'F' },
  bounceOwn: { n: 'n', filter: 'F' },
  bottomOwn: { n: 'n', filter: 'F', all: 'b?' },
  removeMarker: { n: 'n' },
  energyToHand: { n: 'n', filter: 'F' },
  handOrBattleToBottom: { filters: 'F[]' },
  energyToDeckBottom: { n: 'n' },
  pickUnder: { filter: 'F', onto: 'F' },
  toComboOwn: { filter: 'F' },
  handToDeckTop: { n: 'n' },
  mill: { n: 'n' },
  reveal: { filter: 'F' },
  underToDrop: { n: 'n', filter: 'F?' },
  dropToDeck: { n: 'n', filter: 'F?' },
  handToUnder: { filter: 'F', onto: 'F' },
  activateOwn: { filter: 'F' },
};
const CONDS: Record<Cond['t'], Spec> = {
  handLE: { n: 'n' }, handGE: { n: 'n' }, energyGE: { n: 'n' }, energyLE: { n: 'n' }, lifeLE: { n: 'n' }, lifeGE: { n: 'n' },
  oppLifeLE: { n: 'n' }, oppLifeGE: { n: 'n' }, oppHandGE: { n: 'n' }, dropGE: { n: 'n' },
  battleCount: { op: 'Z:none|ge', n: 'n', filter: 'F', side: 'Z:self|opp' },
  count: { what: 'C', op: 'Z:ge|le|eq|none', n: 'n' },
  leaderIs: { names: 's[]' },
  leaderTrait: { traits: 's[]', only: 'b?' },
  leaderAwakened: {},
  kiLeaderGE: { n: 'n' },
  kiTotalGE: { n: 'n', scope: 'Z:your|battle' },
  thisKiGE: { n: 'n' },
  hasMarker: { yes: 'b' },
  thisRested: { yes: 'b' },
  thisInBattle: {},
  playedThisTurn: {},
  comboAreaHasCard: {},
  energyLessThanOpp: {},
  attackingBattleCard: { filter: 'F?' },
  prevMatches: { filter: 'F' },
  yourTurn: { yes: 'b' },
  thisHasUnder: { yes: 'b' },
  attacking: { filter: 'F' },
  koedThisTurn: { filter: 'F?' },
  playedByLeaderSkill: {},
  leaderInBattle: {},
  removedOwnThisTurn: {},
  kiRemovedThisTurn: {},
  comboFromFieldThisTurn: {},
  bouncedThisTurn: {},
  energyLeftThisTurn: {},
  extraUsedThisTurn: { filter: 'F?' },
  lifeLeftThisTurn: {},
  thisMatches: { filter: 'F' },
  markerPaid: {},
  oppHasMarker: { yes: 'b' },
  markerUsedThisTurn: {},
  comboFromDropThisTurn: {},
  removedBySkillThisTurn: { filter: 'F?' },
  playedBySkill: {},
  playedByEvolve: {},
  battleTotalCost: { n: 'n', only: 'F?' },
  attackedThisTurn: { yes: 'b' },
  inBattleWith: { filter: 'F', leader: 'b?' },
  revealedMatches: { filter: 'F' },
  causedByLeader: { filter: 'F?' },
  thisKiUpThisTurn: {},
  not: { c: 'Cond' },
  or: { any: 'Cond[]' },
  and: { all: 'Cond[]' },
};
const FILTER: Spec = {
  costLE: 'n?', costGE: 'n?', costEQ: 'n?', originalCost: 'b?', originalPower: 'b?', powerLE: 'n?', powerGE: 'n?', powerEQ: 'n?', rested: 'b?', active: 'b?',
  names: 's[]?', notNames: 's[]?', traits: 's[]?', traitsAll: 's[]?', onlyTraits: 's[]?', colors: 'col[]?', type: 'Z:BATTLE|EXTRA?',
  other: 'b?', keyword: 'kwx?', noSkill: 'b?', kiGE: 'n?', comboLE: 'n?', comboEQ: 'n?', notTraits: 's[]?', underNames: 's[]?', anyOf: 'F[]?',
  costLEv: 'V?', costEQv: 'V?', powerLEv: 'V?', playedFrom: 'Z:hand|drop|deck|life|energy?', playedThisTurn: 'b?', sharesTraitWithPrev: 'b?',
};
const TARGET: Spec = {
  side: 'Z:opp|self|any', ref: 'Z:this|prev|leader|oppLeader|battler|oppBattler?', chooser: 'Z:opp?', zones: 'zones', count: 'n', upTo: 'b', all: 'b?', filter: 'F',
  totalCostLE: 'n?', totalPowerLE: 'n?',
};
const COUNT: Spec = { side: 'Z:self|opp', zone: 'Z:battle|drop|hand|energy|life|deck|combo|under|thisKi|kiTotal|kiRemoved|prev|underMax|battleDrop|event|thisKiRemovedBattle|leaderBattle', filter: 'F?', distinct: 'b?' };
const VAL: Spec = { of: 'Z:prevCost|prevPower|kiRemoved|revealedCost|thisCost|energy|count|totalCost|leaderKi', count: 'C?', filter: 'F?', plus: 'n?' };
const REPLACE: Spec = { what: 'Z:this|ally', filter: 'F?', by: 'Z:opp|oppSkill|any', ko: 'b?', lose: 'b?' };

// ------------------------------------------------------------------ validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkObj(v: unknown, spec: Spec, path: string, errs: string[]) {
  if (!isObj(v)) { errs.push(`${path}: expected an object`); return; }
  for (const k of Object.keys(v)) if (!(k in spec) && k !== 't' && k !== 'cond') errs.push(`${path}.${k}: unknown field`);
  for (const [k, type] of Object.entries(spec)) checkField(v[k], type, `${path}.${k}`, errs);
  if ('cond' in v) checkConds(v.cond, `${path}.cond`, errs);
}

function checkField(v: unknown, type: string, path: string, errs: string[]) {
  const optional = type.endsWith('?');
  const t = optional ? type.slice(0, -1) : type;
  if (v === undefined) { if (!optional) errs.push(`${path}: missing`); return; }
  const bad = (what: string) => errs.push(`${path}: expected ${what}, got ${JSON.stringify(v)?.slice(0, 60)}`);
  switch (t) {
    case 'n': if (typeof v !== 'number' || !Number.isFinite(v)) bad('a number'); return;
    case 'b': if (typeof v !== 'boolean') bad('true/false'); return;
    case 's': if (typeof v !== 'string') bad('text'); return;
    case 'n|free': if (v !== 'free' && typeof v !== 'number') bad('a number or "free"'); return;
    case 'n|V': if (typeof v !== 'number') checkObj(v, VAL, path, errs); return;
    case 'V': checkObj(v, VAL, path, errs); return;
    case 'Tm': if (!TIMINGS.includes(v as Timing)) bad('a timing'); return;
    case 'Co[]': if (!Array.isArray(v)) bad('a list of costs'); else v.forEach((c, i) => checkTagged(c, COSTS, `${path}[${i}]`, errs, 'cost')); return;
    case 's[]': if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('a list of text'); return;
    case 'col[]': if (!Array.isArray(v) || !v.every((x) => COLORS.includes(x as string))) bad(`colours from ${COLORS.join('/')}`); return;
    case 'zones': if (!Array.isArray(v) || !v.length || !v.every((x) => ['leader', 'battle', 'field'].includes(x as string))) bad('zones from leader/battle/field'); return;
    case 'D': if (!DURATIONS.includes(v as string)) bad(DURATIONS.join('|')); return;
    case 'K': if (!KEYWORDS.includes(v as Keyword)) bad('a keyword'); return;
    case 'kwx': if (!KEYWORDS.includes(v as Keyword) && v !== 'evolve' && v !== 'fusionEvolve') bad('a keyword'); return;
    case 'T': checkObj(v, TARGET, path, errs); if (isObj(v)) checkObj(v.filter, FILTER, `${path}.filter`, errs); return;
    case 'F': checkObj(v, FILTER, path, errs); return;
    case 'F[]': if (!Array.isArray(v)) bad('a list of filters'); else v.forEach((f, i) => checkObj(f, FILTER, `${path}[${i}]`, errs)); return;
    case 'C': checkObj(v, COUNT, path, errs); return;
    case 'E[]': checkEffects(v, path, errs); return;
    case 'E[][]':
      if (!Array.isArray(v) || !v.length) bad('a list of effect lists');
      else v.forEach((list, i) => checkEffects(list, `${path}[${i}]`, errs));
      return;
    case 'Cond': checkCond(v, path, errs); return;
    case 'Cond[]': checkConds(v, path, errs); return;
  }
  if (t.startsWith('Z:')) { const opts = t.slice(2).split('|'); if (!opts.includes(v as string)) bad(opts.join('|')); return; }
  errs.push(`${path}: unknown type ${t}`);
}

function checkTagged<T extends string>(v: unknown, table: Record<T, Spec>, path: string, errs: string[], kind: string) {
  if (!isObj(v) || typeof v.t !== 'string') { errs.push(`${path}: expected a ${kind} with a "t" field`); return; }
  const spec = (table as Record<string, Spec>)[v.t];
  if (!spec) { errs.push(`${path}: unknown ${kind} "${v.t}"`); return; }
  checkObj(v, spec, `${path}<${v.t}>`, errs);
}

const checkCond = (v: unknown, path: string, errs: string[]) => checkTagged(v, CONDS, path, errs, 'condition');
function checkConds(v: unknown, path: string, errs: string[]) {
  if (!Array.isArray(v)) { errs.push(`${path}: expected a list`); return; }
  v.forEach((c, i) => checkCond(c, `${path}[${i}]`, errs));
}
function checkEffects(v: unknown, path: string, errs: string[]) {
  if (!Array.isArray(v)) { errs.push(`${path}: expected a list`); return; }
  v.forEach((e, i) => checkTagged(e, EFFECTS, `${path}[${i}]`, errs, 'effect'));
}

function checkAbility(v: unknown, path: string, errs: string[]) {
  if (!isObj(v)) { errs.push(`${path}: expected an object`); return; }
  if (!TIMINGS.includes(v.timing as Timing)) errs.push(`${path}.timing: unknown "${v.timing}"`);
  if (v.turn !== undefined && v.turn !== 'your' && v.turn !== 'opp') errs.push(`${path}.turn: your|opp`);
  if (typeof v.once !== 'boolean') errs.push(`${path}.once: expected true/false`);
  if (!Array.isArray(v.cost)) errs.push(`${path}.cost: expected a list`);
  else v.cost.forEach((c, i) => checkTagged(c, COSTS, `${path}.cost[${i}]`, errs, 'cost'));
  checkConds(v.cond, `${path}.cond`, errs);
  checkEffects(v.effects, `${path}.effects`, errs);
  if (v.trigger !== undefined) checkObj(v.trigger, FILTER, `${path}.trigger`, errs);
  if (v.replace !== undefined) checkObj(v.replace, REPLACE, `${path}.replace`, errs);
  if (v.timing === 'replace' && v.replace === undefined) errs.push(`${path}.replace: missing for a replacement`);
  if (v.unparsed !== undefined && (!Array.isArray(v.unparsed) || !v.unparsed.every((x) => typeof x === 'string'))) errs.push(`${path}.unparsed: list of text`);
}

/** Every problem with a script, as "path: problem" lines. Empty means it is well-formed. */
export function validateScript(v: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(v)) return ['script: expected an object'];
  const kws = (k: string) => {
    if (v[k] === undefined) return;
    if (!Array.isArray(v[k]) || !(v[k] as unknown[]).every((x) => KEYWORDS.includes(x as Keyword))) errs.push(`${k}: expected keywords`);
  };
  kws('keywords'); kws('backKeywords');
  for (const k of ['abilities', 'backAbilities']) {
    if (v[k] === undefined) { if (k === 'abilities') errs.push('abilities: missing'); continue; }
    if (!Array.isArray(v[k])) errs.push(`${k}: expected a list`);
    else (v[k] as unknown[]).forEach((a, i) => checkAbility(a, `${k}[${i}]`, errs));
  }
  if (v.evolve !== undefined) {
    const ev = v.evolve;
    if (!isObj(ev) || !Array.isArray(ev.from) || ![1, 2].includes(ev.from.length) || typeof ev.cost !== 'number') errs.push('evolve: expected {from: [filter] or [filter, filter], cost: number}');
    else {
      ev.from.forEach((f, i) => checkObj(f, FILTER, `evolve.from[${i}]`, errs));
      if (ev.orFrom !== undefined) checkField(ev.orFrom, 'F[]', 'evolve.orFrom', errs);
      if (ev.equalPowerGE !== undefined && typeof ev.equalPowerGE !== 'number') errs.push('evolve.equalPowerGE: number');
      if (ev.baseMode !== undefined && ev.baseMode !== 'rested' && ev.baseMode !== 'active') errs.push('evolve.baseMode: rested|active');
      if (ev.extraCost !== undefined) checkField(ev.extraCost, 'Co[]', 'evolve.extraCost', errs);
    }
  }
  if (v.unparsed !== undefined && (!Array.isArray(v.unparsed) || !v.unparsed.every((x) => typeof x === 'string'))) errs.push('unparsed: list of text');
  if (v.needs !== undefined && (!Array.isArray(v.needs) || !v.needs.every((x) => typeof x === 'string'))) errs.push('needs: list of text');
  if (v.aliases !== undefined && (!Array.isArray(v.aliases) || !v.aliases.every((x) => typeof x === 'string'))) errs.push('aliases: list of text');
  return errs;
}

/**
 * Fill in what a hand-written script may leave out:
 * abilities default to once:false, no cost/cond, and a Target defaults to
 * "up to 1 of your opponent's Battle Cards" with any fields given overriding.
 * Lets translations stay short; validation runs on the expanded form.
 */
export function expandScript<T>(v: T): T {
  const walk = (x: unknown, key = ''): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, key === 'options' ? 'options' : ''));
    if (!isObj(x)) return x;
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x)) o[k] = walk(val, k);
    if (key === 'target') {
      const ref = o.ref as string | undefined;
      return {
        side: ref === 'oppLeader' || ref === 'oppBattler' ? 'opp' : ref ? 'self' : 'opp',
        zones: ref === 'leader' || ref === 'oppLeader' ? ['leader'] : ['battle'],
        count: 1, upTo: !ref && !o.all, filter: {}, ...o,
      };
    }
    if ('timing' in o && 'effects' in o) return { once: false, cost: [], cond: [], text: '', unparsed: [], ...o };
    if ('timing' in o && 'replace' in o) return { once: false, cost: [], cond: [], effects: [], text: '', unparsed: [], ...o };
    return o;
  };
  const out = walk(v) as Record<string, unknown>;
  if (isObj(out)) { out.keywords ??= []; out.abilities ??= []; }
  return out as T;
}

/** Fill in the fields a hand-written ability may leave out. */
export function normalizeAbility(a: Partial<Ability>): Ability {
  return {
    timing: a.timing ?? 'permanent', turn: a.turn, once: a.once ?? false, cost: a.cost ?? [], cond: a.cond ?? [],
    effects: a.effects ?? [], text: a.text ?? '', unparsed: a.unparsed ?? [], ...(a.trigger ? { trigger: a.trigger } : {}),
    ...(a.replace ? { replace: a.replace } : {}),
  };
}

export const ALL_TARGET = (t: Partial<Target>): Target => ({ side: 'opp', zones: ['battle'], count: 1, upTo: true, filter: {}, ...t });
export type { Filter };
