import { Card, Decklist } from '../data/types';
import { compileCard } from '../effects/parse';

/**
 * How cards play off each other, worked out from their skills.
 *
 * Every skill is read for the resources it PRODUCES (rests an enemy card, adds
 * Ki, fills the Drop, moves life to hand, places an energy marker, shrinks an
 * enemy card's cost or power, makes you take damage...) and the resources it
 * CONSUMES (only hits rested cards, needs 3+ Ki, needs 20+ cards in the Drop,
 * works at 4 or less life, needs an energy marker, removes cards up to a cost or
 * power...). A producer and a consumer of the same resource in one deck are a
 * link: "FS11-13 rests a card, FS11-14 KOs a rested card".
 */

export type Resource =
  | 'restEnemy' | 'ki' | 'drop' | 'lowLife' | 'damageTaken' | 'marker'
  | 'enemyCostDown' | 'enemyPowerDown' | 'evolve' | 'extraUsed' | 'handSmall' | 'bigBody' | 'awaken';

export const RESOURCE_LABEL: Record<Resource, [string, string]> = {
  // [what a producer does, what a consumer needs]
  restEnemy: ["rests the opponent's cards", "punishes Rest Mode enemy cards"],
  ki: ['adds Ki', 'spends or needs Ki'],
  drop: ['fills your Drop', 'needs or uses cards in your Drop'],
  lowLife: ['brings your life down (adds life to hand / takes damage)', 'works at low life (or awakens at low life)'],
  damageTaken: ['makes you take damage', 'triggers when you take damage'],
  marker: ['places an energy marker', 'needs or spends an energy marker'],
  enemyCostDown: ["lowers enemy cards' cost", 'removes enemy cards up to a cost'],
  enemyPowerDown: ["lowers enemy cards' power", 'removes or beats enemy cards up to a power'],
  evolve: ['is an Evolve base', 'Evolves onto it'],
  extraUsed: ['is an Extra', 'needs an Extra used this turn'],
  handSmall: ['spends cards from hand', 'needs a small hand (7 or fewer)'],
  bigBody: ['is a big Battle Card (30000+ power)', 'needs a big Battle Card in play'],
  awaken: ['helps awaken your Leader', 'is better once your Leader is awakened'],
};

export interface Roles {
  produces: Partial<Record<Resource, number>>;
  consumes: Partial<Record<Resource, number>>;
}

const memo = new Map<string, Roles>();

const add = (m: Partial<Record<Resource, number>>, r: Resource, w = 1) => { m[r] = Math.max(m[r] ?? 0, w); };

/** Resources a card's skills produce and consume. */
export function rolesOf(card: Card): Roles {
  const hit = memo.get(card.id);
  if (hit) return hit;
  const cc = compileCard(card);
  const roles: Roles = { produces: {}, consumes: {} };
  const P = roles.produces, C = roles.consumes;
  const enemy = (t: any) => !t || t.side === 'opp' || (t.side === undefined && t.ref === undefined);

  const walk = (x: any, ctx: 'effect' | 'cost' | 'cond' | 'any' = 'any') => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, ctx)); return; }
    const t = x.t as string | undefined;
    if (t && ctx !== 'cond') {
      switch (t) {
        case 'rest': if (enemy(x.target)) add(P, 'restEnemy'); break;
        case 'ki': add(P, 'ki'); break;
        case 'reduceKi': add(C, 'ki'); break;
        case 'mill': case 'discard': case 'selfToDrop': case 'koSelf': case 'koOwn': case 'dropOwn': case 'energyToDrop': add(P, 'drop', 0.7); if (t === 'discard') add(P, 'handSmall', 0.5); break;
        case 'search': if (x.dest === 'drop' || x.rest === 'drop') add(P, 'drop', 0.7); break;
        case 'dropToDeck': case 'underToDrop': if (ctx === 'cost') add(C, 'drop', 0.6); break;
        case 'dropToHand': add(C, 'drop', 0.4); break;
        case 'playFrom': if (x.from === 'drop') add(C, 'drop', 0.4); break;
        case 'lifeToHand': add(P, 'lowLife', 0.8); break;
        case 'selfDamage': case 'takeDamage': add(P, 'lowLife'); add(P, 'damageTaken'); break;
        case 'placeMarker': add(P, 'marker'); break;
        case 'removeMarker': add(C, 'marker'); break;
        case 'costMod': if (x.amount < 0 && enemy(x.target)) add(P, 'enemyCostDown'); break;
        case 'power': if (x.amount < 0 && enemy(x.target)) add(P, 'enemyPowerDown'); break;
      }
      // Removal aimed at enemy cards: what it needs from them.
      if (['ko', 'bottom', 'bounce', 'toDrop', 'toEnergy', 'lockActive', 'negate'].includes(t) && x.target && enemy(x.target)) {
        const f = x.target.filter ?? {};
        if (f.rested) add(C, 'restEnemy');
        if (f.costLE !== undefined || f.costLEv) add(C, 'enemyCostDown', 0.7);
        if (f.powerLE !== undefined || f.powerLEv) add(C, 'enemyPowerDown', 0.7);
      }
    }
    if (t && ctx === 'cond') {
      switch (t) {
        case 'thisKiGE': case 'kiLeaderGE': case 'kiTotalGE': case 'kiRemovedThisTurn': add(C, 'ki'); break;
        case 'dropGE': add(C, 'drop'); break;
        case 'lifeLE': add(C, 'lowLife'); break;
        case 'hasMarker': case 'markerPaid': add(C, 'marker'); break;
        case 'handLE': add(C, 'handSmall'); break;
        case 'leaderAwakened': add(C, 'awaken', 0.8); break;
        case 'extraUsedThisTurn': add(C, 'extraUsed'); break;
        case 'count': if (x.what?.zone === 'drop') add(C, 'drop'); if (x.what?.side === 'self' && x.what?.filter?.powerGE >= 25000) add(C, 'bigBody'); break;
        case 'battleCount': if (x.side === 'self' && x.filter?.powerGE >= 25000) add(C, 'bigBody'); break;
      }
    }
    for (const [k, v] of Object.entries(x)) {
      if (k === 'cond') walk(v, 'cond');
      else if (k === 'cost') walk(v, 'cost');
      else if (k === 'effects' || k === 'options' || k === 'by') walk(v, 'effect');
      else if (typeof v === 'object') walk(v, ctx);
    }
  };
  for (const ab of [...cc.abilities, ...(cc.backAbilities ?? [])]) {
    walk(ab.cost, 'cost');
    walk(ab.cond, 'cond');
    walk(ab.effects, 'effect');
    if (ab.timing === 'whenDamaged') add(C, 'damageTaken');
  }
  if (cc.evolve) add(C, 'evolve');
  if (card.type === 'EXTRA') add(P, 'extraUsed', 0.6);
  if (card.type === 'BATTLE' && card.power >= 30000) add(P, 'bigBody', card.power >= 40000 ? 1 : 0.8);
  memo.set(card.id, roles);
  return roles;
}

export function clearSynergyCache() { memo.clear(); }

export interface Link {
  resource: Resource;
  /** The other card: it produces what this card consumes, or the reverse. */
  with: string;
  /** 'feeds' = this card produces for `with`; 'fedBy' = `with` produces for this card. */
  dir: 'feeds' | 'fedBy';
}

/** What awakens this Leader: the resources its [Awaken] condition needs. */
export function awakenNeeds(leader: Card): Resource[] {
  const cc = compileCard(leader);
  const r: Roles = { produces: {}, consumes: {} };
  for (const ab of cc.abilities.filter((a) => a.timing === 'awaken')) {
    const conds = JSON.stringify(ab.cond);
    if (/lifeLE/.test(conds)) add(r.consumes, 'lowLife');
    if (/Ki/.test(conds)) add(r.consumes, 'ki');
    if (/dropGE|"zone":"drop"/.test(conds)) add(r.consumes, 'drop');
  }
  return Object.keys(r.consumes) as Resource[];
}

/** A card's roles in a deck: "better once awakened" becomes a need for whatever awakens this Leader. */
function rolesIn(cards: Record<string, Card>, deck: Decklist, card: Card): Roles {
  const base = rolesOf(card);
  const leader = cards[deck.leader];
  if (!leader) return base;
  const needs = awakenNeeds(leader);
  const produces = { ...base.produces }, consumes = { ...base.consumes };
  if (consumes.awaken) for (const r of needs) consumes[r] = Math.max(consumes[r] ?? 0, 0.6 * consumes.awaken);
  // Anything that feeds the Leader's awaken condition also helps awaken.
  if (needs.some((r) => produces[r])) produces.awaken = 0.7;
  return { produces, consumes };
}

/** Copies of each card, with the Leader counted as always present. */
function counts(deck: Decklist): Map<string, number> {
  const m = new Map<string, number>(Object.entries(deck.main));
  m.set(deck.leader, (m.get(deck.leader) ?? 0) + 4);
  return m;
}

/** The resource links between one card and the rest of a deck. */
export function linksOf(cards: Record<string, Card>, deck: Decklist, id: string): Link[] {
  const me = rolesIn(cards, deck, cards[id]);
  const out: Link[] = [];
  for (const [other] of counts(deck)) {
    if (other === id || !cards[other]) continue;
    const r = rolesIn(cards, deck, cards[other]);
    for (const res of Object.keys(me.produces) as Resource[]) if (r.consumes[res]) out.push({ resource: res, with: other, dir: 'feeds' });
    for (const res of Object.keys(me.consumes) as Resource[]) if (r.produces[res]) out.push({ resource: res, with: other, dir: 'fedBy' });
  }
  return out;
}

/** How well a deck supplies what a card needs and uses what it makes (0 = no links). */
export function synergyBonus(cards: Record<string, Card>, deck: Decklist, card: Card): number {
  const me = rolesIn(cards, deck, card);
  const supply: Partial<Record<Resource, number>> = {}, demand: Partial<Record<Resource, number>> = {};
  for (const [id, n] of counts(deck)) {
    if (id === card.id || !cards[id]) continue;
    const r = rolesIn(cards, deck, cards[id]);
    for (const [res, w] of Object.entries(r.produces) as [Resource, number][]) supply[res] = (supply[res] ?? 0) + w * n;
    for (const [res, w] of Object.entries(r.consumes) as [Resource, number][]) demand[res] = (demand[res] ?? 0) + w * n;
  }
  const sat = (x = 0) => Math.min(1, x / 8);
  let b = 0;
  for (const [res, w] of Object.entries(me.consumes) as [Resource, number][]) if (res !== 'evolve' && res !== 'extraUsed') b += 0.9 * w * sat(supply[res]);
  for (const [res, w] of Object.entries(me.produces) as [Resource, number][]) if (res !== 'extraUsed') b += 0.5 * w * sat(demand[res]);
  return b;
}
