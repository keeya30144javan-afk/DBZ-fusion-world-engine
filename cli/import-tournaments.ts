/**
 * Refresh data/meta.json from real tournament results (data/tournaments.json, from
 * deckbuilder.egmanevents.com/api/tournaments/fusionworld).
 *   npx tsx cli/import-tournaments.ts [--format FB10] [--per 2] [--dry]
 *
 * Each Leader's share is its share of the format's field (players of every listed event). Its best
 * recent top-cut lists are added (placement first, then date). Lists already in the meta stay; a Leader
 * the format's events never saw keeps a small floor share (newer sets, off-meta decks the user gave).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CardDB, Decklist } from '../src/data/types';
import { validateDeck } from '../src/data/decks';
import { DEFAULT_RULES } from '../src/data/rules';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const db: CardDB = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const data = JSON.parse(readFileSync('data/tournaments.json', 'utf8'));
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
// Rerunning replaces this importer's own lists; lists from anywhere else stay.
meta.decks = meta.decks.filter((d: Decklist) => !/egmanevents/.test(d.notes ?? ''));
const per = +(arg('per') ?? 2);
const MIN_FIELD = 0.01, FLOOR = 0.01, STARTER = 0.004;

type Event = { tournament_name: string; set_group: string; start_date: string; player_count: number | null; leader_breakdown: { count: number; deck_type: string }[]; results: { placement: number; deck_type: string; player_name: string; deck_list_url: string[] | null }[] };
const events: Event[] = data.tournaments;
const format = arg('format') ?? events.map((e) => e.set_group).sort().at(-1)!;
const inFormat = events.filter((e) => e.set_group === format).sort((a, b) => b.start_date.localeCompare(a.start_date));

const leaderOf = (code: string) => code.replace(/-[FB]$/, '');
const field = new Map<string, number>();
const top = new Map<string, number>();
const wins = new Map<string, number>();
let players = 0, topN = 0;
for (const e of inFormat) for (const r of e.results) {
  if (!db.cards[leaderOf(r.deck_type)]) continue;
  top.set(leaderOf(r.deck_type), (top.get(leaderOf(r.deck_type)) ?? 0) + 1);
  topN++;
  if (r.placement === 1) wins.set(leaderOf(r.deck_type), (wins.get(leaderOf(r.deck_type)) ?? 0) + 1);
}
for (const e of inFormat) for (const b of e.leader_breakdown) {
  if (!db.cards[leaderOf(b.deck_type)]) continue; // "Other"
  field.set(leaderOf(b.deck_type), (field.get(leaderOf(b.deck_type)) ?? 0) + b.count);
  players += b.count;
}

function parseList(url: string): Decklist | null {
  const q = new URL(url).searchParams.get('deck');
  if (!q) return null;
  let leader = '';
  const main: Record<string, number> = {};
  for (const part of q.split(',')) {
    const [code, n] = part.split(':');
    const id = leaderOf(code);
    if (db.cards[id]?.type === 'LEADER') leader = id;
    else main[id] = (main[id] ?? 0) + +n;
  }
  return leader ? { name: '', leader, main } : null;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const place = (e: Event) => e.tournament_name.replace(/^(Play!TCG|TAK Games'?|401 Games'?|CoreTCG|Victory Road'?s?|CCG Eventos'?|Gametrade Distribuzione|Egman Event'?s|Top Cut Event'?s|Versus Games'?|SangSang Event['’]s)\s*/i, '').replace(/ Regionals?$/i, '');
const same = (a: Decklist, b: Decklist) => a.leader === b.leader && JSON.stringify(Object.entries(a.main).sort()) === JSON.stringify(Object.entries(b.main).sort());

const added: Decklist[] = [];
const report: string[] = [];
for (const [leader, n] of [...field].sort((a, b) => b[1] - a[1])) {
  if (n / players < MIN_FIELD) continue;
  const lists = inFormat.flatMap((e) => e.results.filter((r) => leaderOf(r.deck_type) === leader && r.deck_list_url?.length).map((r) => ({ e, r })))
    .sort((a, b) => a.r.placement - b.r.placement || b.e.start_date.localeCompare(a.e.start_date));
  const picked: Decklist[] = [];
  for (const { e, r } of lists) {
    if (picked.length >= per) break;
    const d = parseList(r.deck_list_url![0]);
    if (!d) continue;
    const errs = validateDeck(d, db.cards, DEFAULT_RULES);
    if (errs.length) { report.push(`  skip ${leader} ${e.tournament_name} ${r.placement}: ${errs[0]}`); continue; }
    if ([...picked, ...meta.decks].some((x: Decklist) => same(x, d))) continue;
    const c = db.cards[leader];
    d.name = `${c.name} (${c.colors.join('/')}, ${place(e)} ${ordinal(r.placement)})`;
    d.notes = `${e.tournament_name}, ${e.start_date}: ${ordinal(r.placement)} of ${e.player_count ?? '?'} (${r.player_name}). From deckbuilder.egmanevents.com`;
    picked.push(d);
  }
  added.push(...picked);
  report.push(`${db.cards[leader].name.padEnd(18)} ${leader.padEnd(9)} field ${(100 * n / players).toFixed(1).padStart(5)}%  +${picked.length} lists`);
}

const decks: Decklist[] = [...meta.decks, ...added];
// Shares: a Leader's field share split across its lists; Leaders the format never saw get a floor.
const byLeader = new Map<string, Decklist[]>();
for (const d of decks) byLeader.set(d.leader, [...(byLeader.get(d.leader) ?? []), d]);
for (const [leader, ds] of byLeader) {
  const f = field.get(leader);
  for (const d of ds) d.share = d.name.startsWith('Starter') ? STARTER : f && f / players >= MIN_FIELD * 0.5 ? f / players / ds.length : FLOOR / ds.length;
}
const tot = decks.reduce((a, d) => a + (d.share ?? 0), 0);
for (const d of decks) d.share = Math.round((d.share! / tot) * 10000) / 10000;

console.log(`${format}: ${inFormat.length} events, ${players} players with a known Leader`);
console.log(report.join('\n'));
console.log(`${added.length} lists added; ${decks.length} meta decks`);
for (const d of [...decks].sort((a, b) => b.share! - a.share!)) console.log(`  ${(100 * d.share!).toFixed(1).padStart(5)}%  ${d.name}`);
if (!process.argv.includes('--dry')) {
  meta.decks = decks;
  meta.results = {
    format, events: inFormat.length, players, from: inFormat.at(-1)!.start_date, to: inFormat[0].start_date, source: 'deckbuilder.egmanevents.com',
    leaders: [...field].filter(([, n]) => n / players >= 0.005).sort((a, b) => b[1] - a[1])
      .map(([leader, n]) => ({ leader, field: +(n / players).toFixed(4), top: +((top.get(leader) ?? 0) / topN).toFixed(4), wins: wins.get(leader) ?? 0 })),
  };
  meta.updated = new Date().toISOString().slice(0, 10);
  meta.source = `${meta.source ?? ''}; shares from ${format} tournament fields (deckbuilder.egmanevents.com)`.replace(/^; /, '');
  writeFileSync('data/meta.json', JSON.stringify(meta, null, 1));
}
