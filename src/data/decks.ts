import { Card, Decklist } from './types';
import { RulesConfig, DEFAULT_RULES } from './rules';
import { baseId } from './normalize';

const ID_RE = /\b([A-Z]{1,4}\d{0,3}-\d{2,3}[a-z]?)\b/i;

/**
 * Accepts the common pasted shapes:
 *   4 FB01-002 / 4x FB01-002 / FB01-002 x4 / 4 Son Goku (FB01-002) / Leader: FB01-001
 * The first LEADER card found (or a line starting "Leader") becomes the leader.
 */
export function parseDecklist(text: string, cards: Record<string, Card>, name = 'Pasted deck'): { deck: Decklist; errors: string[] } {
  const errors: string[] = [];
  const main: Record<string, number> = {};
  let leader = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const idm = line.match(ID_RE);
    if (!idm) {
      if (!/^(main|deck|leader|extra|side)\b[:\s]*$/i.test(line)) errors.push(`No card number on line: "${line}"`);
      continue;
    }
    const id = baseId(idm[1]);
    const rest = line.replace(idm[0], ' ');
    const cm = rest.match(/(?:^|\s)[x×]?\s*(\d{1,2})\s*[x×]?(?:\s|$)/i);
    const n = cm ? parseInt(cm[1], 10) : 1;
    const card = cards[id];
    if (!card) { errors.push(`Unknown card ${id}`); continue; }
    if (card.type === 'LEADER' || /^leader\b/i.test(line)) {
      if (card.type !== 'LEADER') errors.push(`${id} is not a Leader`);
      else leader = id;
      continue;
    }
    main[id] = (main[id] ?? 0) + n;
  }
  if (!leader) errors.push('No Leader card found');
  return { deck: { name, leader, main }, errors };
}

export function deckToText(deck: Decklist, cards: Record<string, Card>): string {
  const lines = [`1 ${deck.leader}  ${cards[deck.leader]?.name ?? ''}`.trimEnd()];
  const ids = Object.keys(deck.main).sort((a, b) => (cards[a]?.cost ?? 0) - (cards[b]?.cost ?? 0) || a.localeCompare(b));
  for (const id of ids) if (deck.main[id] > 0) lines.push(`${deck.main[id]} ${id}  ${cards[id]?.name ?? ''}`.trimEnd());
  return lines.join('\n');
}

export const deckSize = (d: Decklist) => Object.values(d.main).reduce((a, b) => a + b, 0);

export function cardFitsLeader(card: Card, leader: Card, rules: RulesConfig = DEFAULT_RULES): boolean {
  if (card.colors.length === 0) return true;
  return rules.colorRule === 'all'
    ? card.colors.every((c) => leader.colors.includes(c))
    : card.colors.some((c) => leader.colors.includes(c));
}

const hasKeyword = (c: Card, kw: string) => c.text.toLowerCase().includes(`[${kw.toLowerCase()}]`);

export function validateDeck(deck: Decklist, cards: Record<string, Card>, rules: RulesConfig = DEFAULT_RULES): string[] {
  const errs: string[] = [];
  const leader = cards[deck.leader];
  if (!leader || leader.type !== 'LEADER') errs.push('Missing or invalid Leader');
  const size = deckSize(deck);
  if (size < rules.deckMin || size > rules.deckMax) errs.push(`Deck has ${size} cards (needs ${rules.deckMin}-${rules.deckMax})`);
  let superCombo = 0;
  let dragonBalls = 0;
  for (const [id, n] of Object.entries(deck.main)) {
    const c = cards[id];
    if (!c) { errs.push(`Unknown card ${id}`); continue; }
    if (c.type === 'LEADER') errs.push(`${id} is a Leader in the main deck`);
    // Manual p.12: [Dragon Ball] cards ignore the 4-copy limit but total at most 7.
    const isDragonBall = /\[Dragon Ball\]/i.test(c.text);
    if (isDragonBall) dragonBalls += n;
    else if (n > rules.maxCopies) errs.push(`${n} copies of ${id} (max ${rules.maxCopies})`);
    if (leader && !cardFitsLeader(c, leader, rules)) errs.push(`${id} (${c.colors.join('/')}) is off-colour for ${leader.name}`);
    if (hasKeyword(c, 'Super Combo')) superCombo += n;
  }
  if (dragonBalls > 7) errs.push(`${dragonBalls} [Dragon Ball] cards (max 7)`);
  if (superCombo > rules.superComboMax) errs.push(`${superCombo} [Super Combo] cards (max ${rules.superComboMax})`);
  return errs;
}

export function expandDeck(deck: Decklist, listedOrder = false): string[] {
  const out: string[] = [];
  if (listedOrder) { for (const [id, n] of Object.entries(deck.main)) for (let i = 0; i < n; i++) out.push(id); return out; }
  // Sorted, so a deck's order (and so every seeded game) doesn't depend on how its card map was
  // stored: a database can hand the same list back with its keys reordered.
  for (const [id, n] of Object.entries(deck.main).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) for (let i = 0; i < n; i++) out.push(id);
  return out;
}

export const deckKey = (d: Decklist) =>
  d.leader + '|' + Object.keys(d.main).filter((k) => d.main[k] > 0).sort().map((k) => `${k}:${d.main[k]}`).join(',');
