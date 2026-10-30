// Train value net v2 as a residual on the hand-set evaluation: logit = handLogit + MLP(x).
// usage: train2.ts DATADIR OUT.json   (rows from gen2.ts; holds out every 5th game by seed)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { NET_INPUTS_V2 } from '../../src/ai/valuenet';
const [dir, outFile] = process.argv.slice(2);
const H = process.env.LINEAR ? 1 : +(process.env.HIDDEN ?? 24), EPOCHS = +(process.env.EPOCHS ?? 20), LR = +(process.env.LR ?? 0.002), L2 = +(process.env.L2 ?? 3e-4);
const D = NET_INPUTS_V2.length;
let rows: number[][] = [];
for (const f of readdirSync(dir).filter((f) => /^gen2-.*\.json$/.test(f))) { try { rows = rows.concat(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'))); } catch {} }
rows = rows.filter((r) => r.length === D + 4);
// TURNSTART=1: keep only each turn's first two rows (both points of view at the start of the main phase).
if (process.env.TURNSTART) { const seen = new Map<string, number>(); rows = rows.filter((r) => { const k = `${r[D + 2]}:${r[D + 3]}`; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return n < 2; }); }
// DROP=a,b: inputs the net may not use (their normalised value is held at 0 and their weights zeroed).
const drop = new Set((process.env.DROP ?? '').split(',').filter(Boolean).flatMap((k) => [`me.${k}`, `op.${k}`, k]));
if (process.env.KEEP) { const keep = new Set(process.env.KEEP.split(',').flatMap((k) => [`me.${k}`, `op.${k}`, k])); for (const n of NET_INPUTS_V2) if (!keep.has(n)) drop.add(n); }
const dropIdx = NET_INPUTS_V2.map((n, i) => (drop.has(n) ? i : -1)).filter((i) => i >= 0);
const HL = D, Y = D + 1, SEED = D + 2;
// FRAC=k: keep only every k-th training game (learning curves); the held-out games stay the same.
if (process.env.FRAC) { const k = +process.env.FRAC; rows = rows.filter((r) => (Math.imul(r[SEED] | 0, 2654435761) >>> 0) % 100 < 20 || Math.floor(r[SEED] / 7) % k === 0); }
// Hold out ~20% of games by a hash of the game seed (seeds from the browser come in pairs).
const held = (seed: number) => (Math.imul(seed | 0, 2654435761) >>> 0) % 100 < 20;
const test = rows.filter((r) => held(r[SEED])), train = rows.filter((r) => !held(r[SEED]));
console.log(rows.length, 'rows,', train.length, 'train,', test.length, 'held out;', new Set(rows.map((r) => r[SEED])).size, 'games');
const mean = Array(D).fill(0), std = Array(D).fill(0);
for (const r of train) for (let i = 0; i < D; i++) mean[i] += r[i] / train.length;
for (const r of train) for (let i = 0; i < D; i++) std[i] += (r[i] - mean[i]) ** 2 / train.length;
for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i]) || 1;
const X = (r: number[]) => r.slice(0, D).map((v, i) => (dropIdx.includes(i) ? 0 : (v - mean[i]) / std[i]));
const trX = train.map(X), trY = train.map((r) => r[Y]), trH = train.map((r) => r[HL]);
const teX = test.map(X), teY = test.map((r) => r[Y]), teH = test.map((r) => r[HL]);
let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sig = (z: number) => 1 / (1 + Math.exp(-z));
const score = (f: (n: number) => number, ys: number[]) => {
  let loss = 0, acc = 0;
  ys.forEach((y, n) => { const p = Math.min(1 - 1e-6, Math.max(1e-6, sig(f(n)))); loss -= y ? Math.log(p) : Math.log(1 - p); acc += (p > 0.5) === (y === 1) ? 1 : 0; });
  return `loss ${(loss / ys.length).toFixed(4)} acc ${((acc / ys.length) * 100).toFixed(1)}%`;
};
console.log('hand-set eval   held-out', score((n) => teH[n], teY));
// The hand-set eval's logit may be mis-scaled: fit a*h + b first (2 numbers).
let a = 1, b = 0;
for (let it = 0; it < 300; it++) { let ga = 0, gb = 0; trH.forEach((h, n) => { const e = sig(a * h + b) - trY[n]; ga += e * h; gb += e; }); a -= 0.5 * ga / trH.length; b -= 0.5 * gb / trH.length; }
console.log(`rescaled hand   held-out ${score((n) => a * teH[n] + b, teY)}  (a=${a.toFixed(3)} b=${b.toFixed(3)})`);
// MLP residual on top of the rescaled hand eval.
const w1 = Array.from({ length: H }, () => Array.from({ length: D }, () => (rnd() - 0.5) * 2 * Math.sqrt(1 / D)));
const b1 = Array(H).fill(0), w2 = Array.from({ length: H }, () => (process.env.LINEAR ? 20 : (rnd() - 0.5) * 0.02)); let b2 = 0;
if (process.env.LINEAR) for (const row of w1) row.fill(0);
const m1 = w1.map((r) => r.map(() => 0)), v1 = w1.map((r) => r.map(() => 0)), mb1 = Array(H).fill(0), vb1 = Array(H).fill(0), m2 = Array(H).fill(0), v2 = Array(H).fill(0);
let mb2 = 0, vb2 = 0, t = 0;
const fwd = (x: number[]) => { const h = w1.map((row, k) => { let z = b1[k]; for (let i = 0; i < D; i++) z += row[i] * x[i]; return Math.tanh(z); }); let z = b2; for (let k = 0; k < H; k++) z += w2[k] * h[k]; return { h, z }; };
const idx = trX.map((_, n) => n);
let best = { loss: Infinity, ep: -1, snap: '' };
const heldLoss = () => { let l = 0; teX.forEach((x, n) => { const p = Math.min(1 - 1e-6, Math.max(1e-6, sig(a * teH[n] + b + fwd(x).z))); l -= teY[n] ? Math.log(p) : Math.log(1 - p); }); return l / teX.length; };
for (let ep = 0; ep < EPOCHS; ep++) {
  for (let n = idx.length - 1; n > 0; n--) { const k = Math.floor(rnd() * (n + 1)); [idx[n], idx[k]] = [idx[k], idx[n]]; }
  for (let start = 0; start < idx.length; start += 256) {
    const end = Math.min(idx.length, start + 256), m = end - start;
    const g1 = w1.map((r) => r.map(() => 0)), gb1 = Array(H).fill(0), g2 = Array(H).fill(0); let gb2 = 0;
    for (let q = start; q < end; q++) {
      const n = idx[q], x = trX[n]; const { h, z } = fwd(x); const e = sig(a * trH[n] + b + z) - trY[n];
      gb2 += e;
      for (let k = 0; k < H; k++) { g2[k] += e * h[k]; const d = e * w2[k] * (1 - h[k] * h[k]); gb1[k] += d; const gr = g1[k]; for (let i = 0; i < D; i++) gr[i] += d * x[i]; }
    }
    t++;
    const st = (p: number, g: number, mm: number, vv: number): [number, number, number] => { mm = 0.9 * mm + 0.1 * g; vv = 0.999 * vv + 0.001 * g * g; return [p - LR * (mm / (1 - 0.9 ** t)) / (Math.sqrt(vv / (1 - 0.999 ** t)) + 1e-8), mm, vv]; };
    for (let k = 0; k < H; k++) {
      for (let i = 0; i < D; i++) [w1[k][i], m1[k][i], v1[k][i]] = st(w1[k][i], g1[k][i] / m + L2 * w1[k][i], m1[k][i], v1[k][i]);
      [b1[k], mb1[k], vb1[k]] = st(b1[k], gb1[k] / m, mb1[k], vb1[k]);
      if (!process.env.LINEAR) [w2[k], m2[k], v2[k]] = st(w2[k], g2[k] / m + L2 * w2[k], m2[k], v2[k]);
    }
    [b2, mb2, vb2] = st(b2, gb2 / m, mb2, vb2);
  }
  const l = heldLoss();
  console.log('epoch', ep + 1, 'residual held-out loss', l.toFixed(4));
  if (l < best.loss) best = { loss: l, ep, snap: JSON.stringify({ w1, b1, w2, b2 }) };
}
const net = JSON.parse(best.snap);
// Stored so that hand + scale*netLogit(x) reproduces a*h + b + mlp: fold a,b in as a correction of (a-1)*h + b,
// which the engine can't compute inside the net, so keep a,b alongside for reference and use residual = mlp + b.
// (a stays near 1 when the hand eval is well scaled; the A/B decides.)
net.b2 += b;
for (const row of net.w1) for (const i of dropIdx) row[i] = 0;
console.log('dropped inputs:', dropIdx.map((i) => NET_INPUTS_V2[i]).join(' '));
writeFileSync(outFile, JSON.stringify({ inputs: NET_INPUTS_V2, mean, std, ...net, scale: 3, handScale: a, trainedOn: rows.length, heldOutLoss: best.loss }));
console.log('best epoch', best.ep + 1, 'loss', best.loss.toFixed(4), 'saved', outFile, 'hand scale a =', a.toFixed(3));
