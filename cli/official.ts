/**
 * Correct data/cards.json from the official card database (dbs-cardgame.com), parsed into data/official.json
 * by cli/official-parse.py. Stats (name, cost, specified cost, power, combo power, traits) come from the
 * official site for every card; printed text only for the cards in TEXT, whose meaning differed (the rest
 * differ only in wording style, and changing their text would drop their scripts).
 *   npx tsx cli/official.ts [--dry]     then: npx tsx cli/scripts.ts apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CardDB } from '../src/data/types';

const TEXT = ['FB07-062', 'FS10-08', 'FB11-122', 'ST01-035', 'FB11-102', 'FB01-102', 'FB02-072'];

const db: CardDB = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const off: Record<string, any> = JSON.parse(readFileSync('data/official.json', 'utf8'));
const dry = process.argv.includes('--dry');

const name = (x: string) => x.replace(/\s+:\s+/g, ': ').replace(/<([^>]+?) : ([^>]+)>/g, '<$1: $2>');
const style = (x: string) => name(x).replace(/《/g, '≪').replace(/》/g, '≫').replace(/\[Activate (Main|Battle)\]/g, '[Activate:$1]').replace(/\s+:\s/g, ': ');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const changes: string[] = [];
const set = (id: string, field: string, from: unknown, to: unknown, apply: () => void) => {
  if (same(from, to)) return;
  changes.push(`${id} ${field}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  if (!dry) apply();
};

for (const [id, o] of Object.entries(off)) {
  const c = db.cards[id];
  if (!c || o.type === 'ENERGY MARKER' || o.type !== c.type) continue;
  if (id === 'FP-030') continue; // "all colors / all traits" Leader: the site's ALL placeholders aren't real values
  const n = name(o.name);
  if (n !== c.name) set(id, 'name', c.name, n, () => { const old = c.name; c.name = n; c.characters = c.characters.map((x) => (x === old ? n : x)); });
  if (c.type !== 'LEADER') {
    set(id, 'cost', c.cost, o.cost ?? 0, () => (c.cost = o.cost ?? 0));
    set(id, 'specified', c.specified, o.specified, () => { c.specified = o.specified; c.specifiedKnown = true; });
    if (!dry) c.specifiedKnown = true;
  }
  if (c.type !== 'EXTRA') set(id, 'power', c.power, o.power ?? 0, () => (c.power = o.power ?? 0));
  if (c.type === 'BATTLE') set(id, 'comboPower', c.comboPower, o.comboPower ?? 0, () => (c.comboPower = o.comboPower ?? 0));
  if (c.type === 'EXTRA' && c.comboPower) set(id, 'comboPower', c.comboPower, 0, () => (c.comboPower = 0));
  const traits = (o.traits as string[]).map((x) => x.replace(/’/g, "'"));
  if (!same([...(c.traits ?? [])].sort(), [...traits].sort())) set(id, 'traits', c.traits, traits, () => (c.traits = traits));
  // The site repeats the front on some Leaders' backs (FB08); only trust a back that differs from the front.
  if (c.back && o.back && o.back.text && o.back.text !== o.text) set(id, 'back power', c.back.power, o.back.power, () => (c.back!.power = o.back.power));
  if (TEXT.includes(id)) set(id, 'text', c.text, style(o.text), () => (c.text = style(o.text)));
}
console.log(changes.length, 'changes');
for (const line of changes) if (!/ specified: /.test(line)) console.log(' ', line);
console.log(' ', changes.filter((l) => / specified: /.test(l)).length, 'specified-cost corrections');
if (!dry) writeFileSync('data/cards.json', JSON.stringify(db, null, 1));
