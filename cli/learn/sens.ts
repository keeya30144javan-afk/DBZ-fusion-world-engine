// Average effect on the net's correction of +1 standard deviation in each input (in logits).
import { readFileSync, readdirSync } from 'node:fs';
import { NET_INPUTS_V2 } from '../../src/ai/valuenet';
const [netFile, dir] = process.argv.slice(2);
const net = JSON.parse(readFileSync(netFile, 'utf8')); const D = NET_INPUTS_V2.length;
let rows: number[][] = []; for (const f of readdirSync(dir)) rows = rows.concat(JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')));
rows = rows.filter((_, i) => i % 20 === 0);
const mlp = (z0: number[]) => { let out = net.b2; for (let h = 0; h < net.w1.length; h++) { let z = net.b1[h]; for (let i = 0; i < D; i++) z += net.w1[h][i] * z0[i]; out += net.w2[h] * Math.tanh(z); } return out; };
const eff = NET_INPUTS_V2.map((name, i) => {
  let s = 0;
  for (const r of rows) { const z = r.slice(0, D).map((v, k) => (v - net.mean[k]) / net.std[k]); const b = mlp(z); z[i] += 1; s += mlp(z) - b; }
  return { name, e: s / rows.length, sd: net.std[i] };
});
eff.sort((a, b) => Math.abs(b.e) - Math.abs(a.e)).slice(0, 24).forEach((x) => console.log(x.e.toFixed(3).padStart(7), x.name.padEnd(20), 'sd', x.sd.toFixed(2)));
console.log('handScale', net.handScale);
