import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { cardFitsLeader } from '../data/decks';
import { mulberry } from '../builder/deckgen';

/**
 * Live-game opponent model. You tell it what you have seen; it tells you what
 * is probably in their hand, life and deck.
 *
 *   1. Which list are they on? Posterior over meta archetypes with their
 *      leader, from the cards seen so far (off-list cards count as tech).
 *   2. Card counting: their list minus every card seen in public.
 *   3. Behaviour: when they let an attack through that a cheap combo would
 *      have stopped, hands holding that combo become less likely.
 * Probabilities come from many simulated deals weighted by (1)-(3).
 */

export type Sighting = { id: string; n: number; where: 'public' | 'inHand' };

export type Behaviour =
  | { t: 'tookHit'; need: number; stakes: 'leader' | 'battle'; life?: number }
  | { t: 'passedWithEnergy'; energy: number }
  | { t: 'defended'; withCards: number };

export interface ScoutInput {
  leader: string;
  archetypes: Decklist[];
  seen: Sighting[];
  handSize: number;
  lifeCount: number;
  /** Cards still in their deck; when omitted it is worked out from the list size. */
  deckCount?: number;
  behaviour: Behaviour[];
  samples?: number;
  rules?: RulesConfig;
}

export interface ArchetypeBelief {
  name: string;
  prior: number;
  posterior: number;
  offList: string[];
}

export interface CardBelief {
  id: string;
  name: string;
  /** Copies not yet seen (expected, across archetypes). */
  unseen: number;
  pInHand: number;
  expInHand: number;
  pInLife: number;
  comboPower: number;
  cost: number;
}

export interface ScoutReport {
  archetypes: ArchetypeBelief[];
  cards: CardBelief[];
  /** P(their hand can add at least X combo power), with any number of cards and with one card. */
  defense: { need: number; pAny: number; pOne: number; pTwo: number }[];
  expectedHandCombo: number;
  note: string;
}

/**
 * How surprising it is that they let a hit through while holding a one-card
 * answer. Early on, taking hits is often deliberate (life becomes cards), so
 * the evidence is weak at high life and strong at low life.
 */
export const hitFactor = (stakes: 'leader' | 'battle', life?: number) =>
  stakes === 'battle' ? 0.8 : life === undefined ? 0.55 : life <= 2 ? 0.15 : life <= 4 ? 0.35 : life <= 6 ? 0.65 : 0.85;

const TECH = 0.08; // chance-weight for each card copy seen that a list does not run

export function scout(cards: Record<string, Card>, input: ScoutInput): ScoutReport {
  const rules = input.rules ?? DEFAULT_RULES;
  const leader = cards[input.leader];
  const seenPublic = new Map<string, number>();
  const seenHand = new Map<string, number>();
  for (const s of input.seen) {
    const m = s.where === 'public' ? seenPublic : seenHand;
    m.set(s.id, (m.get(s.id) ?? 0) + s.n);
  }
  const allSeen = new Map<string, number>(seenPublic);
  for (const [k, v] of seenHand) allSeen.set(k, (allSeen.get(k) ?? 0) + v);

  // ---- 1. archetypes
  let lists = input.archetypes.filter((a) => a.leader === input.leader);
  let note = '';
  if (!lists.length && leader) {
    // No known list for this leader: assume a generic list, every legal card equally likely.
    const generic: Decklist = { name: `Unknown ${leader.name} list`, leader: input.leader, main: {} };
    for (const c of Object.values(cards)) if (c.type !== 'LEADER' && cardFitsLeader(c, leader, rules)) generic.main[c.id] = 2;
    lists = [generic];
    note = 'No meta list for this leader, so every legal card is treated as equally likely (2 copies each).';
  }
  const priors = lists.map((l) => l.share ?? 1);
  const priorSum = priors.reduce((a, b) => a + b, 0) || 1;
  const arch: ArchetypeBelief[] = lists.map((l, i) => {
    let like = 1;
    const offList: string[] = [];
    for (const [id, n] of allSeen) {
      const have = l.main[id] ?? 0;
      if (n > have) {
        like *= Math.pow(TECH, n - have);
        offList.push(cards[id]?.name ?? id);
      }
    }
    return { name: l.name, prior: priors[i] / priorSum, posterior: (priors[i] / priorSum) * like, offList };
  });
  const postSum = arch.reduce((a, b) => a + b.posterior, 0) || 1;
  for (const a of arch) a.posterior /= postSum;

  // ---- 2+3. simulated deals
  const N = input.samples ?? 6000;
  const rng = mulberry(0x5c017 ^ (input.handSize * 131 + input.lifeCount * 7 + input.seen.length * 17 + input.behaviour.length * 1009));
  const handCount = new Map<string, number>();
  const handAny = new Map<string, number>();
  const lifeAny = new Map<string, number>();
  const unseenExp = new Map<string, number>();
  const needs = [5000, 10000, 15000, 20000, 25000, 30000, 40000];
  const defAny = needs.map(() => 0), defOne = needs.map(() => 0), defTwo = needs.map(() => 0);
  let wTotal = 0;
  let comboTotal = 0;

  const known = [...seenHand.entries()].flatMap(([id, n]) => Array(n).fill(id) as string[]);
  const hiddenHand = Math.max(0, input.handSize - known.length);

  // Pools per archetype (cards not seen anywhere).
  const pools = lists.map((l) => {
    const pool: string[] = [];
    for (const [id, n] of Object.entries(l.main)) {
      const left = n - (allSeen.get(id) ?? 0);
      for (let i = 0; i < left; i++) pool.push(id);
    }
    return pool;
  });
  arch.forEach((a, i) => {
    const counts = new Map<string, number>();
    for (const id of pools[i]) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) unseenExp.set(id, (unseenExp.get(id) ?? 0) + n * a.posterior);
  });

  for (let s = 0; s < N; s++) {
    // Pick an archetype by posterior.
    let r = rng(), ai = 0;
    for (; ai < arch.length - 1; ai++) { r -= arch[ai].posterior; if (r <= 0) break; }
    const pool = pools[ai].slice();
    // Partial shuffle: we only need hand + life.
    const take = Math.min(pool.length, hiddenHand + input.lifeCount);
    for (let i = 0; i < take; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const hand = known.concat(pool.slice(0, hiddenHand));
    const life = pool.slice(hiddenHand, take);

    const combos = hand.map((id) => cards[id]?.comboPower ?? 0).sort((a, b) => b - a);
    let w = 1;
    for (const b of input.behaviour) {
      if (b.t === 'tookHit') {
        let need = b.need, used = 0;
        for (const c of combos) { if (need <= 0) break; need -= c; used++; }
        if (need <= 0 && used <= (b.stakes === 'leader' ? 1 : 0)) w *= hitFactor(b.stakes, b.life);
      } else if (b.t === 'passedWithEnergy') {
        const castable = hand.filter((id) => cards[id]?.type === 'BATTLE' && (cards[id]?.cost ?? 99) <= b.energy).length;
        w *= Math.pow(0.7, castable);
      } else if (b.t === 'defended') {
        // They stopped an attack with k cards: hands that could not have are impossible.
        if (combos.filter((c) => c > 0).length < b.withCards) w *= 0.05;
      }
    }
    wTotal += w;
    const sum = combos.reduce((a, b) => a + b, 0);
    comboTotal += w * sum;
    needs.forEach((need, i) => {
      if (sum >= need) defAny[i] += w;
      if ((combos[0] ?? 0) >= need) defOne[i] += w;
      if ((combos[0] ?? 0) + (combos[1] ?? 0) >= need) defTwo[i] += w;
    });
    const seenThis = new Set<string>();
    for (const id of hand) {
      handCount.set(id, (handCount.get(id) ?? 0) + w);
      if (!seenThis.has(id)) { handAny.set(id, (handAny.get(id) ?? 0) + w); seenThis.add(id); }
    }
    const lifeSeen = new Set<string>();
    for (const id of life) if (!lifeSeen.has(id)) { lifeAny.set(id, (lifeAny.get(id) ?? 0) + w); lifeSeen.add(id); }
  }

  const ids = new Set<string>([...unseenExp.keys(), ...known]);
  const out: CardBelief[] = [...ids].map((id) => ({
    id,
    name: cards[id]?.name ?? id,
    unseen: unseenExp.get(id) ?? 0,
    pInHand: (handAny.get(id) ?? 0) / (wTotal || 1),
    expInHand: (handCount.get(id) ?? 0) / (wTotal || 1),
    pInLife: (lifeAny.get(id) ?? 0) / (wTotal || 1),
    comboPower: cards[id]?.comboPower ?? 0,
    cost: cards[id]?.cost ?? 0,
  }));
  out.sort((a, b) => b.pInHand - a.pInHand);

  return {
    archetypes: arch.sort((a, b) => b.posterior - a.posterior),
    cards: out,
    defense: needs.map((need, i) => ({ need, pAny: defAny[i] / (wTotal || 1), pOne: defOne[i] / (wTotal || 1), pTwo: defTwo[i] / (wTotal || 1) })),
    expectedHandCombo: comboTotal / (wTotal || 1),
    note,
  };
}
