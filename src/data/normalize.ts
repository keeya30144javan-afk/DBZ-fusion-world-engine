import { Card, CardType, Color, COLORS } from './types';

/**
 * Turns card rows from any source we know about into our Card shape.
 * Sources differ in field names, so every field is looked up under several
 * candidate keys. Anything we cannot read is left empty rather than guessed,
 * except the coloured part of the cost (see assumeSpecified).
 */

const pick = (row: any, keys: string[]): any => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), row);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const num = (v: any): number => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const m = v.replace(/,/g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : 0;
};

const COLOR_ALIASES: Record<string, Color> = {
  red: 'Red', r: 'Red', blue: 'Blue', b: 'Blue', u: 'Blue', green: 'Green', g: 'Green',
  yellow: 'Yellow', y: 'Yellow', black: 'Black', k: 'Black',
};

export function parseColors(v: any): Color[] {
  if (Array.isArray(v)) return v.flatMap(parseColors);
  if (typeof v !== 'string') return [];
  const out: Color[] = [];
  for (const part of v.split(/[\/,;&|\s]+/)) {
    const c = COLOR_ALIASES[part.trim().toLowerCase()];
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

function parseType(v: any): CardType {
  const s = String(v ?? '').toUpperCase();
  if (s.includes('LEADER')) return 'LEADER';
  if (s.includes('EXTRA')) return 'EXTRA';
  return 'BATTLE';
}

/** "3(RR)", "3 (Red x2)", {total:3, Red:2} ... -> total and coloured orbs. */
export function parseCost(v: any, colors: Color[]): { cost: number; specified: Partial<Record<Color, number>>; known: boolean } {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const specified: Partial<Record<Color, number>> = {};
    for (const c of COLORS) if (v[c]) specified[c] = num(v[c]);
    return { cost: num(v.total ?? v.cost), specified, known: Object.keys(specified).length > 0 };
  }
  const s = String(v ?? '');
  const cost = num(s);
  const inner = s.match(/\(([^)]*)\)/);
  if (inner) {
    const specified: Partial<Record<Color, number>> = {};
    const body = inner[1];
    const words = body.match(/(red|blue|green|yellow|black)\s*[x×]?\s*(\d*)/gi);
    if (words) {
      for (const w of words) {
        const [, name, n] = w.match(/(red|blue|green|yellow|black)\s*[x×]?\s*(\d*)/i)!;
        const c = COLOR_ALIASES[name.toLowerCase()];
        specified[c] = (specified[c] ?? 0) + (n ? parseInt(n, 10) : 1);
      }
    } else {
      for (const ch of body.replace(/\s/g, '')) {
        const c = COLOR_ALIASES[ch.toLowerCase()];
        if (c) specified[c] = (specified[c] ?? 0) + 1;
      }
    }
    return { cost, specified, known: true };
  }
  return { cost, specified: assumeSpecified(cost, colors), known: false };
}

/**
 * When a source omits coloured orbs we assume one orb of the card's colour
 * (two from cost 5 up). This is a labelled assumption: it only matters for
 * mixed-colour energy, and is replaced as soon as real data is loaded.
 */
export function assumeSpecified(cost: number, colors: Color[]): Partial<Record<Color, number>> {
  if (cost <= 0 || colors.length === 0) return {};
  const orbs = cost >= 5 ? 2 : 1;
  return { [colors[0]]: Math.min(orbs, cost) };
}

// DeckPlanet's plain-text skills use lower-case tags ("[activate main]"), [br]/[em] markup,
// and {1} for energy balls. Bring them to the official wording the effect parser reads.
const TAG_CANON: Record<string, string> = {
  'on play': 'On Play', 'when attacking': 'When Attacking', "when ko'd": "When KO'd", 'when blocking': 'When Blocking',
  'activate main': 'Activate:Main', 'activate: main': 'Activate:Main', 'activate battle': 'Activate:Battle', 'activate: battle': 'Activate:Battle',
  'permanent': 'Permanent', 'auto': 'Auto', 'awaken': 'Awaken', 'once per turn': 'Once Per Turn', 'your turn': 'Your Turn',
  "opponent's turn": "Opponent's Turn", 'end of your turn': 'End of Your Turn', 'start of your turn': 'Start of Your Turn',
  'blocker': 'Blocker', 'critical': 'Critical', 'double strike': 'Double Strike', 'triple strike': 'Triple Strike',
  'super combo': 'Super Combo', 'evolve': 'Evolve', 'fusion evolve': 'Fusion Evolve', 'field': 'Field',
};

/** Hide <card names> while editing text, so "(Mini)" or ":" inside a name is left alone. */
const outsideNames = (s: string, fn: (part: string) => string) => s.split(/(<[^<>]*>)/).map((p, i) => (i % 2 ? p : fn(p))).join('');

export function canonSkillText(raw: string): string {
  let s = raw
    .replace(/\[br\]/gi, '\n')
    .replace(/\[\/?em\]/gi, '')
    .replace(/\{(\d+)\}/g, '($1)')
    .replace(/\{[rbugyk]\}/gi, '(1)');
  s = s.replace(/\[([^\]]+)\]/g, (all, t: string) => {
    const k = t.trim().toLowerCase();
    if (k === 'ki') return 'Ki';
    const parts = k.split('/').map((x) => TAG_CANON[x.trim()]);
    return parts.every(Boolean) ? `[${parts.join('/')}]` : all;
  });
  // Reminder text in parentheses carries no rules; drop it (outside card names) before reading costs.
  s = outsideNames(s, (p) => p.replace(/\((?=[A-Za-z\[])[^()]*\)/g, ''));
  // "(2): effect" or "(1), discard 1 card: effect" is an energy cost.
  s = outsideNames(s, (p) => p.replace(/\((\d+)\)(?=\s*[:,])/g, ' pay $1 energy'));
  // Each ability on its own line.
  s = s.replace(/([.)\]])\s*(?=\[(?:On Play|When|Activate|Permanent|Auto|End of|Start of|Awaken|Blocker|Critical|Double|Triple|Super Combo|Evolve|Fusion Evolve|Field)\b)/g, '$1\n');
  // "[On Play/When Attacking] X" is two abilities with the same text.
  s = s.split('\n').flatMap((line) => {
    const m = line.match(/^\s*\[([^\]]+\/[^\]]+)\](.*)$/);
    return m ? m[1].split('/').map((t) => `[${t}]${m[2]}`) : [line];
  }).join('\n');
  // Same rules, newer wording: map to the phrasing the parser already reads.
  s = outsideNames(s, (p) => p
    .replace(/\bthe rest at the bottom of (?:their|its) owner's deck/gi, 'the rest at the bottom of your deck')
    .replace(/\b(your (?:deck|energy|hand)) into (?:their|its) owner's Drop/gi, '$1 into your Drop')
    .replace(/\bthis card (?:from|in) (?:a|the) Battle Area into (?:its|their) owner's Drop/gi, 'this card into your Drop')
    .replace(/\bthis card in (?:a|the|your) Battle Area\b/gi, 'this card')
    .replace(/\bplace (\w+) of your energy into (?:their|its) owner's Drop/gi, 'place $1 of your energy into your Drop'));
  if (/^\s*-\s*$/.test(s)) return '';
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const cleanText = (v: any): string =>
  String(v ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:span|b|i|u|em|strong|div|p|font|a|img|small|sup|sub)\b[^>]*>/gi, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/《/g, '≪').replace(/》/g, '≫')
    .replace(/\r/g, '')
    .trim();

const splitList = (v: any): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(/[\/,;]/).map((s) => s.trim()).filter(Boolean) : [];

export function normalizeCard(row: any): Card | null {
  // DeckPlanet rows also carry a numeric database "id"; the card number wins.
  const id = pick(row, ['card_number', 'cardNumber', 'code', 'number', 'id']);
  if (!id) return null;
  if (/energy marker/i.test(String(pick(row, ['type', 'card_type']) ?? ''))) return null;
  const name = cleanText(pick(row, ['name', 'card_name', 'cardName', 'front.name']));
  const type = parseType(pick(row, ['type', 'card_type', 'cardType', 'category']));
  const colors = parseColors(pick(row, ['colors', 'color', 'card_color', 'cardColor']));
  const rawCost = pick(row, ['costDetail', 'card_energy_cost', 'energy_cost', 'energyCost', 'cost']);
  const parsed = parseCost(rawCost, colors);
  const explicitSpec = pick(row, ['specified', 'specifiedCost', 'card_specified_cost']);
  let specified = parsed.specified;
  let known = parsed.known;
  if (explicitSpec && typeof explicitSpec === 'object') {
    specified = Array.isArray(explicitSpec)
      ? explicitSpec.reduce((o: any, c: any) => { const k = parseColors(c)[0]; if (k) o[k] = (o[k] ?? 0) + 1; return o; }, {})
      : explicitSpec;
    known = true;
  }
  if (typeof row.specifiedKnown === 'boolean') known = row.specifiedKnown;
  const plain = pick(row, ['card_skill_unstyled']);
  const text = plain !== undefined ? canonSkillText(cleanText(plain)) : cleanText(pick(row, ['text', 'skill', 'card_skill', 'effect', 'front.text']));
  const backName = pick(row, ['back.name', 'card_back_name']);
  const backPlain = pick(row, ['card_back_skill_unstyled']);
  const backText = backPlain !== undefined ? canonSkillText(cleanText(backPlain)) : pick(row, ['back.text', 'back.skill', 'card_back_skill']);
  const backPower = pick(row, ['back.power', 'card_back_power']);
  const traits = splitList(pick(row, ['traits', 'card_features', 'features', 'trait', 'special_traits']));
  const characters = splitList(pick(row, ['characters', 'card_character', 'character']));
  const card: Card = {
    id: String(id).trim(),
    name,
    type,
    colors,
    cost: type === 'LEADER' ? 0 : parsed.cost,
    specified: type === 'LEADER' ? {} : specified,
    specifiedKnown: type === 'LEADER' ? true : known,
    power: num(pick(row, ['power', 'card_power', 'front.power'])),
    comboPower: num(pick(row, ['comboPower', 'combo_power', 'card_combo_power'])),
    traits,
    characters: characters.length ? characters : [name.replace(/\s*\(.*?\)\s*$/, '')],
    text,
    set: String(pick(row, ['set', 'card_series', 'series']) ?? String(id).split('-')[0]),
    rarity: pick(row, ['rarity', 'card_rarity']),
  };
  if (type === 'LEADER' && (backName || backText || backPower)) {
    card.back = {
      name: cleanText(backName ?? name),
      power: num(backPower),
      text: cleanText(backText),
    };
  }
  return card;
}

/** Parallel / alternate-art printings share a base number like FB01-001_p1. */
export const baseId = (id: string) => id.replace(/_.*$/, '').replace(/[a-z]$/, '').toUpperCase();

export function normalizeCards(rows: any[]): Record<string, Card> {
  const out: Record<string, Card> = {};
  for (const row of rows) {
    const c = normalizeCard(row);
    if (!c) continue;
    const id = baseId(c.id);
    if (out[id]) continue; // keep the first printing; parallels are cosmetic
    out[id] = { ...c, id };
  }
  return out;
}
