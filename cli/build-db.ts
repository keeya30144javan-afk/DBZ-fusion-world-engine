/**
 * Build data/cards.json from one or more raw card files (any supported shape).
 *   npx tsx cli/build-db.ts out.json raw1.json [raw2.json ...] --source "name"
 * Later files override earlier ones card by card.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeCards } from '../src/data/normalize';
import { CardDB } from '../src/data/types';

const args = process.argv.slice(2);
const srcIdx = args.indexOf('--source');
const source = srcIdx >= 0 ? args.splice(srcIdx, 2)[1] : 'local files';
const [out, ...inputs] = args;
if (!out || inputs.length === 0) {
  console.error('usage: build-db.ts out.json raw.json [...] [--source name]');
  process.exit(1);
}

const rowsOf = (j: any): any[] => (Array.isArray(j) ? j : j.cards ? (Array.isArray(j.cards) ? j.cards : Object.values(j.cards)) : j.data ?? []);

const cards = {};
for (const f of inputs) Object.assign(cards, normalizeCards(rowsOf(JSON.parse(readFileSync(f, 'utf8')))));
const db: CardDB = { version: new Date().toISOString().slice(0, 10), source, updated: new Date().toISOString(), cards };
writeFileSync(out, JSON.stringify(db, null, 1));
console.log(`${Object.keys(cards).length} cards -> ${out}`);
console.log('Run "npx tsx cli/scripts.ts apply" to attach the card translations in data/scripts/.');
