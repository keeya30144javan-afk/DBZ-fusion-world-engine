/**
 * Card translations ("scripts").
 *   npx tsx cli/scripts.ts todo [count] [--from id]   cards still not fully understood, meta decks first
 *   npx tsx cli/scripts.ts apply                      validate data/scripts/*.json and merge into data/cards.json
 *   npx tsx cli/scripts.ts report                     coverage by source
 *   npx tsx cli/scripts.ts show id [id ...]           printed text next to the engine's reading
 *
 * data/scripts/*.json each hold { "<card id>": CardScript-without-textHash }; the hash is
 * filled in from the current text on apply, and a script whose text later changes is dropped.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { CardDB } from '../src/data/types';
import { CardScript } from '../src/effects/types';
import { compileCard, clearCompileCache } from '../src/effects/parse';
import { expandScript, textHash, validateScript } from '../src/effects/script';
import { describeCompiled } from '../src/effects/describe';

const DB = 'data/cards.json';
const DIR = 'data/scripts';
const db: CardDB = JSON.parse(readFileSync(DB, 'utf8'));
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);

function loadScripts(): Record<string, CardScript & { file: string }> {
  const out: Record<string, CardScript & { file: string }> = {};
  if (!existsSync(DIR)) return out;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
    const j = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
    for (const [id, sc] of Object.entries(j)) out[id] = { ...(sc as CardScript), file: f };
  }
  return out;
}

const inMeta = new Set<string>(meta.decks.flatMap((d: any) => [d.leader, ...Object.keys(d.main)]));

if (cmd === 'apply') {
  const scripts = loadScripts();
  let ok = 0, bad = 0, missing = 0;
  for (const c of Object.values(db.cards)) delete c.script;
  for (const [id, sc] of Object.entries(scripts)) {
    const card = db.cards[id];
    if (!card) { console.log(`${id} (${sc.file}): no such card`); missing++; continue; }
    const { file, ...body } = expandScript(sc) as CardScript & { file: string };
    const script = { ...body, source: body.source ?? 'claude', unparsed: body.unparsed ?? [], textHash: textHash(card) } as CardScript;
    const errs = validateScript(script);
    if (errs.length) { bad++; console.log(`${id} (${file}):\n  ${errs.join('\n  ')}`); continue; }
    card.script = script;
    // "This card's name is also treated as <X> in all areas": name checks read card.characters.
    for (const a of script.aliases ?? []) if (!card.characters.includes(a)) card.characters.push(a);
    ok++;
  }
  writeFileSync(DB, JSON.stringify(db, null, 1));
  console.log(`${ok} scripts applied, ${bad} invalid, ${missing} for unknown cards`);
  process.exit(bad ? 1 : 0);
}

if (cmd === 'report' || cmd === 'todo') {
  clearCompileCache();
  const rows = Object.values(db.cards).map((c) => ({ c, cc: compileCard(c) }));
  if (cmd === 'report') {
    const by: Record<string, { n: number; cov: number; full: number }> = {};
    for (const { cc } of rows) {
      const k = cc.source ?? 'parser';
      const b = (by[k] ??= { n: 0, cov: 0, full: 0 });
      b.n++; b.cov += cc.coverage; if (cc.coverage >= 1) b.full++;
    }
    const tot = rows.reduce((a, r) => a + r.cc.coverage, 0);
    console.log(`${rows.length} cards, ${(100 * tot / rows.length).toFixed(1)}% understood, ${rows.filter((r) => r.cc.coverage >= 1).length} fully`);
    for (const [k, b] of Object.entries(by)) console.log(`  ${k.padEnd(8)} ${String(b.n).padStart(5)} cards  ${(100 * b.cov / b.n).toFixed(1)}%  ${b.full} full`);
    const needs: Record<string, number> = {};
    for (const { cc } of rows) for (const n of cc.needs ?? []) needs[n] = (needs[n] ?? 0) + 1;
    if (Object.keys(needs).length) console.log('needs:', Object.entries(needs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
    const mt = rows.filter((r) => inMeta.has(r.c.id));
    console.log(`meta cards: ${mt.filter((r) => r.cc.coverage >= 1).length}/${mt.length} fully understood`);
    process.exit(0);
  }
  const count = +(rest[0] ?? 25);
  const fromIdx = rest.indexOf('--from');
  const from = fromIdx >= 0 ? rest[fromIdx + 1] : '';
  const todo = rows
    .filter((r) => r.cc.coverage < 1 && !r.c.script)
    .sort((a, b) => Number(inMeta.has(b.c.id)) - Number(inMeta.has(a.c.id)) || a.c.id.localeCompare(b.c.id))
    .filter((r) => !from || r.c.id >= from)
    .slice(0, count);
  const outIdx = rest.indexOf('--out');
  const json = JSON.stringify(todo.map(({ c, cc }) => ({
    id: c.id, name: c.name, type: c.type, colors: c.colors, cost: c.cost, power: c.power, traits: c.traits,
    text: c.text, ...(c.back ? { back: c.back } : {}), notUnderstood: cc.unparsed,
  })), null, 1);
  if (outIdx >= 0) { writeFileSync(rest[outIdx + 1], json); console.log(`${todo.length} cards -> ${rest[outIdx + 1]}`); }
  else process.stdout.write(json + '\n');
  process.exit(0);
}

if (cmd === 'show') {
  clearCompileCache();
  for (const id of rest) {
    const c = db.cards[id];
    if (!c) { console.log(`${id}: no such card`); continue; }
    const cc = compileCard(c);
    console.log(`== ${id} ${c.name} [${cc.source}] ${(cc.coverage * 100).toFixed(0)}%\nTEXT: ${c.text}${c.back ? `\nBACK: ${c.back.text}` : ''}\nREAD: ${describeCompiled(cc)}\n`);
  }
  process.exit(0);
}

console.error('usage: scripts.ts todo [n] [--from id] | apply | report | show id...');
process.exit(1);
