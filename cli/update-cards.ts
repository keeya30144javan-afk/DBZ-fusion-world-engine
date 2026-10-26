/**
 * Pull the full Fusion World card list from DeckPlanet and rebuild data/cards.json.
 *   npx tsx cli/update-cards.ts
 * Needs network access to api.deckplanet.net. Starter cards in data/raw-starters.json
 * are kept underneath, so a failed fetch never loses them.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { normalizeCards } from '../src/data/normalize';
import { compileCard } from '../src/effects/parse';
import { CardDB } from '../src/data/types';

const BASE = 'https://api.deckplanet.net/cardsearch/fusion_world_cards?limit=500';

async function fetchAll(): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await fetch(`${BASE}&page=${page}`);
    if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
    const j: any = await res.json();
    const data = j.data ?? [];
    rows.push(...data);
    const pages = j.meta?.page_count ?? (data.length < 500 ? page : page + 1);
    console.log(`page ${page}/${pages}: ${data.length} cards`);
    if (page >= pages || data.length === 0) break;
  }
  return rows;
}

const rows = await fetchAll();
mkdirSync('data', { recursive: true });
writeFileSync('data/raw-deckplanet.json', JSON.stringify(rows));
const starters = existsSync('data/raw-starters.json') ? JSON.parse(readFileSync('data/raw-starters.json', 'utf8')) : [];
const cards = { ...normalizeCards(starters), ...normalizeCards(rows) };
const db: CardDB = { version: new Date().toISOString().slice(0, 10), source: 'DeckPlanet card search API', updated: new Date().toISOString(), cards };
writeFileSync('data/cards.json', JSON.stringify(db, null, 1));

const all = Object.values(cards);
const cov = all.reduce((a, c) => a + compileCard(c).coverage, 0) / all.length;
console.log(`${all.length} cards written to data/cards.json; ${(cov * 100).toFixed(1)}% of card text understood.`);
console.log('Run `npm run build` to rebuild the app, then republish it.');
