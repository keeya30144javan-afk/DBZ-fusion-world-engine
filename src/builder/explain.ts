import { Card, Decklist } from '../data/types';
import { compileCard } from '../effects/parse';
import { describeCompiled } from '../effects/describe';
import { cardValue } from '../ai/heuristics';
import { poolFor, wants } from './deckgen';
import { Change, Validated } from './counter';
import { score } from './evaluate';

/**
 * Evidence for "why is this card in the list?": everything the search actually
 * knows about the card, gathered so an answer can cite it instead of guessing.
 */

const brief = (c: Card) => ({
  id: c.id, name: c.name, type: c.type, cost: c.cost, power: c.power, comboPower: c.comboPower, traits: c.traits,
  text: c.text, ...(c.back ? { awakened: `${c.back.name}: ${c.back.text}` } : {}),
});

const has = (c: Card, n: string) => c.name.includes(n) || c.characters.some((ch) => ch.includes(n));
const hasTrait = (c: Card, t: string) => c.traits.some((x) => x.toLowerCase() === t.toLowerCase());

export interface CardEvidence {
  card: ReturnType<typeof brief> & { engineReads: string; copies: number };
  leader: ReturnType<typeof brief>;
  stats: {
    validationGames: number;
    deckWinRate: number;
    gamesWhereItWasPlayedOrComboed: number;
    winRateWhenPlayed: number | null;
    lift: number | null;
    /** About one standard error of the lift; a lift inside ±2 of these is noise. */
    noiseBand: number | null;
    rankByLiftInDeck: string;
    verdict: string;
  };
  history: string[];
  staticValue: { valueForThisLeader: number; rankAmongLegalCardsForLeader: string };
  synergy: { cardsInDeckThatAskForIt: string[]; cardsInDeckItAsksFor: string[] };
  target: { name: string; cards: { name: string; id: string; copies: number; cost: number; power: number; text: string }[] };
  baselineHasIt: boolean | null;
}

function describeHistory(history: Change[] | undefined, id: string, cards: Record<string, Card>): string[] {
  if (!history?.length) return ['(no history recorded for this run)'];
  const nm = (k: string) => `${cards[k]?.name ?? k} (${k})`;
  const out: string[] = [];
  for (const h of history) {
    if (h.gen === 0) { out.push(`start: ${h.how}${h.how.startsWith('generated') ? ' (built from card values for this Leader, a cost curve and synergy)' : ''}`); continue; }
    const add = h.added?.[id], rem = h.removed?.[id];
    const others = [...Object.entries(h.added ?? {}).filter(([k]) => k !== id).map(([k, n]) => `+${n} ${nm(k)}`), ...Object.entries(h.removed ?? {}).filter(([k]) => k !== id).map(([k, n]) => `-${n} ${nm(k)}`)];
    const rate = h.parentRate !== undefined ? ` (parent estimated at ${(h.parentRate * 100).toFixed(0)}%)` : '';
    if (add || rem) out.push(`generation ${h.gen}, ${h.how}: ${add ? `+${add}` : `-${rem}`} of this card${others.length ? `, along with ${others.join(', ')}` : ''}${rate}`);
    else out.push(`generation ${h.gen}, ${h.how}: other cards changed (${others.join(', ') || 'none'})${rate}`);
  }
  return out;
}

export function cardEvidence(cards: Record<string, Card>, v: Validated, id: string, target: Decklist, baseline?: Validated | null): CardEvidence {
  const deck = v.deck;
  const card = cards[id];
  const leader = cards[deck.leader];
  const games = v.result.games;
  const deckRate = score(v.result) / Math.max(1, games);
  const t = v.result.cards?.[id];
  const played = t?.played ?? 0;
  const whenPlayed = played ? t!.wonWhenPlayed / played : null;
  const lift = whenPlayed === null ? null : whenPlayed - deckRate;
  const noise = played ? Math.sqrt(Math.max(0.05, deckRate * (1 - deckRate)) / played) : null;
  const lifts = Object.keys(deck.main).map((k) => {
    const s = v.result.cards?.[k];
    return { k, l: s && s.played >= 4 ? s.wonWhenPlayed / s.played - deckRate : -Infinity };
  }).sort((a, b) => b.l - a.l);
  const rank = lifts.findIndex((x) => x.k === id);
  let verdict: string;
  if (played < 6) verdict = `played or comboed in only ${played} of ${games} games: too few to say it helps; it may be filler the search never removed`;
  else if (lift !== null && noise !== null && Math.abs(lift) < 2 * noise) verdict = `its win rate when played is within noise of the deck's overall rate (±${(2 * noise * 100).toFixed(0)} points): no evidence it helps or hurts`;
  else if (lift! > 0) verdict = 'games where it was played or comboed were won clearly more often than average';
  else verdict = 'games where it was played or comboed were won clearly LESS often than average (it may be drawn in games that were already going badly, or it may be weak here)';

  const pool = poolFor(cards, deck.leader).filter((c) => c.type === card.type);
  const vals = pool.map((c) => ({ id: c.id, v: cardValue(c, leader) })).sort((a, b) => b.v - a.v);
  const deckCards = Object.keys(deck.main).filter((k) => k !== id).map((k) => cards[k]);
  const asksForIt = [leader, ...deckCards].filter((c) => {
    const w = wants(c);
    return w.names.some((n) => has(card, n)) || w.traits.some((x) => hasTrait(card, x));
  }).map((c) => `${c.name} (${c.id})`);
  const w = wants(card);
  const itAsksFor = [leader, ...deckCards].filter((c) => w.names.some((n) => has(c, n)) || w.traits.some((x) => hasTrait(c, x))).map((c) => `${c.name} (${c.id})`);

  return {
    card: { ...brief(card), engineReads: describeCompiled(compileCard(card)), copies: deck.main[id] ?? 0 },
    leader: brief(leader),
    stats: {
      validationGames: games,
      deckWinRate: round(deckRate),
      gamesWhereItWasPlayedOrComboed: played,
      winRateWhenPlayed: whenPlayed === null ? null : round(whenPlayed),
      lift: lift === null ? null : round(lift),
      noiseBand: noise === null ? null : round(noise),
      rankByLiftInDeck: rank >= 0 && lifts[rank].l > -Infinity ? `${rank + 1} of ${lifts.filter((x) => x.l > -Infinity).length} cards with enough games` : 'not ranked (too few games)',
      verdict,
    },
    history: describeHistory(v.history, id, cards),
    staticValue: { valueForThisLeader: round(cardValue(card, leader)), rankAmongLegalCardsForLeader: `${vals.findIndex((x) => x.id === id) + 1} of ${vals.length} ${card.type === 'EXTRA' ? 'Extra' : 'Battle'} cards` },
    synergy: { cardsInDeckThatAskForIt: [...new Set(asksForIt)], cardsInDeckItAsksFor: [...new Set(itAsksFor)] },
    target: {
      name: target.name,
      cards: Object.entries(target.main).map(([k, n]) => ({ name: cards[k]?.name ?? k, id: k, copies: n, cost: cards[k]?.cost ?? 0, power: cards[k]?.power ?? 0, text: (cards[k]?.text ?? '').slice(0, 220) })),
    },
    baselineHasIt: baseline ? (baseline.deck.main[id] ?? 0) > 0 : null,
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** The instructions that keep the answer tied to the evidence. */
export function explainPrompt(e: CardEvidence, question: string): string {
  return [
    'You explain why a deck-building search put a card in a Dragon Ball Super Fusion World deck. The search did not reason about cards: it played simulated games and kept what won. So answer only from the EVIDENCE below.',
    'Rules:',
    '- Cite the numbers you rely on (games played, win rate when played, lift, history).',
    "- If the verdict says the stats can't separate it from noise, say so plainly: it may just be filler the search never removed. Don't invent a strategy story the numbers don't support.",
    '- You may explain what the card does against the target deck from the card texts, but label that as reading the cards, not as evidence from games.',
    '- If the history shows when and how it entered, say so (seeded from card values and synergy, or swapped in by a later generation).',
    '- Say the one thing that would settle the question (e.g. watch a game where it was played, or re-test the deck with it swapped out).',
    '- Plain English, under 170 words, no headings. The user is a player, not a programmer.',
    '',
    `QUESTION: ${question || `Why is ${e.card.name} (${e.card.id}) in this list?`}`,
    '',
    `EVIDENCE: ${JSON.stringify(e)}`,
  ].join('\n');
}
