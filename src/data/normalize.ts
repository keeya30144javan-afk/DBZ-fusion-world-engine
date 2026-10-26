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
  const id = pick(row, ['id', 'card_number', 'cardNumber', 'code', 'number']);
  if (!id) return null;
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
  const text = cleanText(pick(row, ['text', 'skill', 'card_skill_unstyled', 'card_skill', 'effect', 'front.text']));
  const backName = pick(row, ['back.name', 'card_back_name']);
  const backText = pick(row, ['back.text', 'back.skill', 'card_back_skill_unstyled', 'card_back_skill']);
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
