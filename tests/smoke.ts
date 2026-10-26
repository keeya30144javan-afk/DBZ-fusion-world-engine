import { readFileSync } from 'node:fs';
import { newGame, legalActions, step } from '../src/engine/game';
import { FastPolicy, defaultChooser, playout } from '../src/ai/heuristics';
const db = JSON.parse(readFileSync('data/cards.json', 'utf8'));
const meta = JSON.parse(readFileSync('data/meta.json', 'utf8'));
const decks = meta.decks;
const pol = new FastPolicy(0.1);
if (process.argv[2] === 'log') {
  const s = newGame(db.cards, [decks[0], decks[3]], { seed: 7, log: true });
  playout(s, [pol, pol]);
  console.log(s.log!.join('\n'));
  console.log('winner', s.winner, s.reason, 'turns', s.turn);
} else {
  const t0 = Date.now();
  const N = 400;
  const res: Record<string, number[]> = {};
  let turns = 0, draws = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    if (a === b) continue;
    let w = 0;
    for (let i = 0; i < N / 12; i++) {
      const s = newGame(db.cards, [decks[a], decks[b]], { seed: i * 31 + a * 7 + b });
      playout(s, [pol, pol]);
      if (s.winner === 0) w++;
      if (s.winner === -1) draws++;
      turns += s.turn;
    }
    (res[decks[a].name] ??= []).push(w / Math.floor(N / 12));
  }
  const games = 12 * Math.floor(N / 12);
  console.log(res);
  console.log(`games ${games} in ${Date.now() - t0}ms; avg turns ${(turns / games).toFixed(1)}; draws ${draws}`);
}
