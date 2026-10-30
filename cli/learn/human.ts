// The user's saved games -> v2 positions (same row format as gen2), for an exam set. usage: human.ts DIR OUT
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { replayRecord } from '../../src/play/host';
import { DEFAULT_EVAL, evaluate } from '../../src/ai/heuristics';
import { netInputV2 } from '../../src/ai/valuenet';
const cards = JSON.parse(readFileSync('data/cards.json', 'utf8')).cards;
const [dir, out] = process.argv.slice(2);
const rows: number[][] = [];
let gi = 0;
for (const f of readdirSync(dir)) {
  const raw = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  const d = raw.data ?? raw;
  if (!d.finished || d.winner === undefined || d.winner === -1) continue;
  const tr = typeof d.trace === 'string' ? JSON.parse(d.trace) : d.trace;
  let st;
  try { st = replayRecord(cards, { ...d, trace: tr, you: d.youDeck, ai: d.aiDeck }); } catch (e) { console.log(f, 'replay failed'); continue; }
  const end = st[st.length - 1];
  const ok = end.stage === 'over' && end.winner === d.winner;
  let last = -1, n = 0;
  for (const s of st) {
    if (s.stage !== 'main' || s.turn === last) continue;
    last = s.turn;
    for (const me of [0, 1] as const) { rows.push([...netInputV2(s, me), evaluate(s, me, DEFAULT_EVAL) / 3, d.winner === me ? 1 : 0, 5 + gi * 5, d.turns - s.turn]); n++; }
  }
  console.log(f, d.you, 'vs', d.ai, 'winner', d.winner === 0 ? 'you' : 'AI', '| replay reaches the same end:', ok, '| positions', n);
  gi++;
}
writeFileSync(out, JSON.stringify(rows));
