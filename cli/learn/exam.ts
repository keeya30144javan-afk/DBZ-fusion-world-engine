// Compare hand-set vs residual net predictions on a row file (e.g. the user's games).
import { readFileSync } from 'node:fs';
import { NET_INPUTS_V2 } from '../../src/ai/valuenet';
const [netFile, rowsFile] = process.argv.slice(2);
const net = JSON.parse(readFileSync(netFile, 'utf8')); const rows: number[][] = JSON.parse(readFileSync(rowsFile, 'utf8'));
const D = NET_INPUTS_V2.length; const sig = (z: number) => 1 / (1 + Math.exp(-z));
const mlp = (r: number[]) => { let out = net.b2; for (let h = 0; h < net.w1.length; h++) { let z = net.b1[h]; for (let i = 0; i < D; i++) z += net.w1[h][i] * ((r[i] - net.mean[i]) / net.std[i]); out += net.w2[h] * Math.tanh(z); } return out; };
const m = (f: (r: number[]) => number) => { let l = 0, a = 0; for (const r of rows) { const p = Math.min(1 - 1e-6, Math.max(1e-6, sig(f(r)))); const y = r[D + 1]; l -= y ? Math.log(p) : Math.log(1 - p); a += (p > 0.5) === (y === 1) ? 1 : 0; } return `loss ${(l / rows.length).toFixed(4)} acc ${(100 * a / rows.length).toFixed(1)}%`; };
console.log(rows.length, 'positions');
console.log('hand-set   ', m((r) => r[D]));
console.log('residual net', m((r) => net.handScale * r[D] + mlp(r)));
