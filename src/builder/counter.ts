import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { deckKey, validateDeck } from '../data/decks';
import { compileCard } from '../effects/parse';
import { cloneDeck, crossover, mulberry, mutate, seedDeck } from './deckgen';
import { Level, MatchJob, MatchResult, emptyResult, mergeResults, score } from './evaluate';
import { Z, diffZ, wilson } from './stats';

export type Runner = (jobs: MatchJob[]) => Promise<MatchResult[]>;

export interface CounterTarget {
  deck: Decklist;
  weight: number;
}

export type Effort = 'quick' | 'standard' | 'thorough';

export interface CounterOptions {
  targets: CounterTarget[];
  /** Leaders allowed for the counter deck; default every leader in the database. */
  leaders?: string[];
  /** Known decks to try as-is (the current meta). */
  known?: Decklist[];
  /** Minimum win rate worth recommending, e.g. 0.55. */
  threshold: number;
  /** Confidence for the lower bound, e.g. 0.95. */
  confidence: number;
  effort: Effort;
  /** AI level for the validation games (both sides). */
  validateLevel?: Level;
  seed?: number;
  rules?: RulesConfig;
}

const EFFORT = {
  quick: { gens: 4, pop: 12, screen: 24, validate: 120, finalists: 2, chunk: 8 },
  standard: { gens: 8, pop: 16, screen: 40, validate: 240, finalists: 3, chunk: 8 },
  thorough: { gens: 14, pop: 24, screen: 64, validate: 480, finalists: 4, chunk: 8 },
};

export interface Scored {
  deck: Decklist;
  key: string;
  origin: string;
  /** Per-target results. */
  res: MatchResult[];
}

export interface Validated {
  deck: Decklist;
  origin: string;
  rate: number;
  lo: number;
  hi: number;
  games: number;
  perTarget: { name: string; rate: number; lo: number; hi: number; games: number }[];
  result: MatchResult;
}

export interface KeyCard {
  id: string;
  name: string;
  played: number;
  winWhenPlayed: number;
  lift: number;
}

export interface CounterReport {
  verdict: 'recommend' | 'inconclusive' | 'none';
  headline: string;
  reasons: string[];
  best: Validated | null;
  alternatives: Validated[];
  baseline: Validated | null;
  keyCards: KeyCard[];
  coverage: { deck: string; coverage: number; unparsedCards: string[]; unreviewed: string[] }[];
  warnings: string[];
  gamesPlayed: number;
  ms: number;
}

export interface Progress {
  phase: 'seed' | 'evolve' | 'validate' | 'done';
  generation?: number;
  generations?: number;
  bestScreen?: number;
  bestName?: string;
  gamesPlayed: number;
  message: string;
}

// ------------------------------------------------------------------ helpers

function aggregate(results: MatchResult[], targets: CounterTarget[], z: number) {
  const wsum = targets.reduce((a, t) => a + t.weight, 0) || 1;
  let mean = 0, varSum = 0, games = 0;
  results.forEach((r, i) => {
    const w = targets[i].weight / wsum;
    const p = r.games ? score(r) / r.games : 0;
    mean += w * p;
    varSum += r.games ? (w * w * Math.max(p * (1 - p), 0.0025)) / r.games : w * w * 0.25;
    games += r.games;
  });
  const half = z * Math.sqrt(varSum);
  return { mean, lo: Math.max(0, mean - half), hi: Math.min(1, mean + half), games };
}

export function coverageOf(deck: Decklist, cards: Record<string, Card>) {
  const ids = [deck.leader, ...Object.keys(deck.main)];
  let total = 0, covered = 0;
  const bad: string[] = [];
  const unreviewed: string[] = [];
  for (const id of ids) {
    const c = cards[id];
    if (!c) continue;
    const copies = id === deck.leader ? 1 : deck.main[id];
    const cc = compileCard(c);
    total += copies;
    covered += copies * cc.coverage;
    if (cc.coverage < 1) bad.push(`${id} ${c.name}`);
    if (cc.source === 'claude') unreviewed.push(`${id} ${c.name}`);
  }
  return { coverage: total ? covered / total : 1, unparsedCards: bad, unreviewed };
}

// ------------------------------------------------------------------ main search

export async function findCounter(cards: Record<string, Card>, opts: CounterOptions, run: Runner, onProgress: (p: Progress) => void = () => {}, isCancelled: () => boolean = () => false): Promise<CounterReport> {
  const t0 = Date.now();
  const rules = opts.rules ?? DEFAULT_RULES;
  const E = EFFORT[opts.effort];
  const z = Z[String(opts.confidence)] ?? 1.96;
  const rng = mulberry(opts.seed ?? 12345);
  const targets = opts.targets;
  const warnings: string[] = [];
  let gamesPlayed = 0;
  let seedCounter = (opts.seed ?? 12345) * 7919;

  const leaders = (opts.leaders?.length ? opts.leaders : Object.values(cards).filter((c) => c.type === 'LEADER').map((c) => c.id)).filter((id) => cards[id]);

  // Coverage first: be honest about how much of the card text the engine understands.
  const coverage = [...targets.map((t) => t.deck), ...(opts.known ?? [])].map((d) => ({ deck: d.name, ...coverageOf(d, cards) }));
  for (const c of coverage) if (c.coverage < 0.9) warnings.push(`Only ${(c.coverage * 100).toFixed(0)}% of the card text in "${c.deck}" is understood by the engine; results for it are approximate.`);
  for (const c of coverage) if (c.unreviewed.length) warnings.push(`"${c.deck}" relies on ${c.unreviewed.length} card${c.unreviewed.length === 1 ? '' : 's'} whose rules were translated by Claude and not yet reviewed (${c.unreviewed.slice(0, 4).join(', ')}${c.unreviewed.length > 4 ? ', …' : ''}). Check them in the Audit tab.`);

  const freshSeeds = (n: number) => Array.from({ length: n }, () => (seedCounter = (seedCounter * 48271 + 11) % 2147483647));

  async function screen(cands: Scored[], games: number) {
    const jobs: MatchJob[] = [];
    const map: [number, number][] = [];
    cands.forEach((c, ci) => targets.forEach((t, ti) => {
      for (let g = 0; g < games; g += E.chunk) {
        jobs.push({ a: c.deck, b: t.deck, seeds: freshSeeds(Math.min(E.chunk, games - g)), level: 'fast', track: true, rules });
        map.push([ci, ti]);
      }
    }));
    const results = await run(jobs);
    results.forEach((r, i) => { const [ci, ti] = map[i]; mergeResults(cands[ci].res[ti], r); gamesPlayed += r.games; });
  }

  const screenScore = (c: Scored) => aggregate(c.res, targets, 1).mean;
  const newScored = (deck: Decklist, origin: string): Scored => ({ deck, key: deckKey(deck), origin, res: targets.map(() => emptyResult()) });

  // ---- seed population
  onProgress({ phase: 'seed', gamesPlayed, message: `Building starting decks for ${leaders.length} leader(s)` });
  const seen = new Map<string, Scored>();
  const pop: Scored[] = [];
  const push = (d: Decklist, origin: string) => {
    if (validateDeck(d, cards, rules).length) return;
    const k = deckKey(d);
    if (seen.has(k)) return;
    const s = newScored(d, origin);
    seen.set(k, s);
    pop.push(s);
  };
  for (const k of opts.known ?? []) push(cloneDeck(k), `known: ${k.name}`);
  for (const id of leaders) {
    push(seedDeck(cards, id, rng, rules), 'generated');
    push(seedDeck(cards, id, rng, rules, 1.5), 'generated (variant)');
  }
  if (!pop.length) throw new Error('No legal candidate decks could be built from this card pool.');
  await screen(pop, E.screen);

  // ---- evolve
  let population = pop.slice();
  for (let g = 1; g <= E.gens; g++) {
    if (isCancelled()) break;
    population.sort((a, b) => screenScore(b) - screenScore(a));
    // Keep the best per leader in early generations so one leader cannot take over on noise.
    const elites: Scored[] = [];
    const perLeader = new Map<string, number>();
    const cap = g <= E.gens / 2 ? 2 : 4;
    for (const c of population) {
      const n = perLeader.get(c.deck.leader) ?? 0;
      if (n >= cap) continue;
      perLeader.set(c.deck.leader, n + 1);
      elites.push(c);
      if (elites.length >= Math.ceil(E.pop / 3)) break;
    }
    const children: Scored[] = [];
    let tries = 0;
    while (children.length < E.pop - elites.length && tries++ < E.pop * 10) {
      const parent = elites[Math.floor(rng() * elites.length)];
      let child: Decklist;
      const sameLeader = elites.filter((e) => e !== parent && e.deck.leader === parent.deck.leader);
      if (sameLeader.length && rng() < 0.3) child = crossover(parent.deck, sameLeader[Math.floor(rng() * sameLeader.length)].deck, cards, rng, rules);
      else {
        const stats = parent.res.reduce((acc, r) => mergeResults(acc, r), emptyResult()).cards ?? {};
        const base = parent.res.reduce((a, r) => a + score(r), 0) / Math.max(1, parent.res.reduce((a, r) => a + r.games, 0));
        const weak = (id: string) => {
          const t = stats[id];
          if (!t || t.played < 4) return 0;
          return base - t.wonWhenPlayed / t.played; // played but lost more than usual
        };
        child = mutate(parent.deck, cards, rng, 1 + Math.floor(rng() * 4), weak, rules);
      }
      child.name = `${cards[child.leader].name} counter`;
      const k = deckKey(child);
      if (seen.has(k) || validateDeck(child, cards, rules).length) continue;
      const s = newScored(child, 'evolved');
      seen.set(k, s);
      children.push(s);
    }
    await screen(children, E.screen);
    // Elites get more games each generation, which shrinks the noise on the leaders.
    await screen(elites, Math.ceil(E.screen / 2));
    population = [...elites, ...children];
    const top = population.slice().sort((a, b) => screenScore(b) - screenScore(a))[0];
    onProgress({ phase: 'evolve', generation: g, generations: E.gens, bestScreen: screenScore(top), bestName: top.deck.name, gamesPlayed, message: `Generation ${g}/${E.gens}: best screening win rate ${(screenScore(top) * 100).toFixed(0)}% (${cards[top.deck.leader].name})` });
  }

  // ---- validate finalists with fresh games and stronger play on both sides
  const all = [...seen.values()].filter((s) => s.res.some((r) => r.games > 0));
  all.sort((a, b) => screenScore(b) - screenScore(a));
  const finalists: Scored[] = [];
  for (const c of all) {
    if (finalists.length >= E.finalists) break;
    if (finalists.some((f) => f.deck.leader === c.deck.leader && f.origin === c.origin && finalists.length < E.finalists - 1)) continue;
    finalists.push(c);
  }
  // Baseline: the best known deck that is not just one of the finalists. If the
  // user gave no meta decks, the target itself (the mirror) is the baseline.
  const baselines = (opts.known?.length ? opts.known : targets.map((t) => t.deck)).map((d) => seen.get(deckKey(d)) ?? newScored(cloneDeck(d), `known: ${d.name}`));
  baselines.sort((a, b) => screenScore(b) - screenScore(a));
  const baselineScored = baselines[0];

  const level: Level = opts.validateLevel ?? 'quick';
  const validateGames = level === 'fast' ? E.validate * 2 : E.validate;
  async function validate(c: Scored): Promise<Validated> {
    const jobs: MatchJob[] = [];
    const map: number[] = [];
    targets.forEach((t, ti) => {
      for (let g = 0; g < validateGames; g += 4) {
        jobs.push({ a: c.deck, b: t.deck, seeds: freshSeeds(Math.min(4, validateGames - g)).map((x) => x + 1_000_000), level, track: true, rules });
        map.push(ti);
      }
    });
    const res = targets.map(() => emptyResult());
    const results = await run(jobs);
    results.forEach((r, i) => { mergeResults(res[map[i]], r); gamesPlayed += r.games; });
    const agg = aggregate(res, targets, z);
    return {
      deck: c.deck, origin: c.origin, rate: agg.mean, lo: agg.lo, hi: agg.hi, games: agg.games,
      perTarget: res.map((r, i) => ({ name: targets[i].deck.name, ...wilson(score(r), r.games, z), rate: score(r) / Math.max(1, r.games), games: r.games })),
      result: res.reduce((acc, r) => mergeResults(acc, r), emptyResult()),
    };
  }

  const validated: Validated[] = [];
  for (let i = 0; i < finalists.length; i++) {
    if (isCancelled()) break;
    onProgress({ phase: 'validate', gamesPlayed, message: `Validating finalist ${i + 1}/${finalists.length} with ${validateGames} fresh games (${level} AI on both sides)` });
    validated.push(await validate(finalists[i]));
  }
  let baseline: Validated | null = null;
  const baselineIsFinalist = validated.find((v) => deckKey(v.deck) === baselineScored.key);
  if (baselineIsFinalist) baseline = baselineIsFinalist;
  else if (!isCancelled()) {
    onProgress({ phase: 'validate', gamesPlayed, message: `Validating baseline "${baselineScored.deck.name}"` });
    baseline = await validate(baselineScored);
  }

  validated.sort((a, b) => b.lo - a.lo || b.rate - a.rate);
  const best = validated[0] ?? null;

  // ---- verdict
  const reasons: string[] = [];
  let verdict: CounterReport['verdict'] = 'none';
  let headline = '';
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (!best) {
    headline = 'Search was cancelled before any deck could be validated.';
  } else {
    const beatsBaseline = !baseline || deckKey(baseline.deck) === deckKey(best.deck) || diffZ(best.rate * best.games, best.games, baseline.rate * baseline.games, baseline.games) > 1.645;
    const conf = `${Math.round(opts.confidence * 100)}%`;
    if (best.lo >= opts.threshold && beatsBaseline) {
      verdict = 'recommend';
      headline = `Recommended: ${best.deck.name}. Wins ${pct(best.rate)} (${conf} confidence: at least ${pct(best.lo)}) over ${best.games} fresh games.`;
    } else if (best.rate >= opts.threshold && best.hi >= opts.threshold) {
      verdict = 'inconclusive';
      headline = `Promising but not proven: ${best.deck.name} wins ${pct(best.rate)}, but the ${conf} lower bound (${pct(best.lo)}) is below your ${pct(opts.threshold)} bar.`;
      reasons.push('Run again with a higher effort setting to play more games before trusting this.');
    } else {
      verdict = 'none';
      headline = `No reliable counter found. The best candidate wins ${pct(best.rate)} (range ${pct(best.lo)}-${pct(best.hi)}), which does not clear your ${pct(opts.threshold)} bar.`;
      reasons.push('Recommending something anyway would be guessing, so this is a real "no".');
    }
    if (!beatsBaseline && baseline) reasons.push(`It is not clearly better than just playing "${baseline.deck.name}" (${pct(baseline.rate)}).`);
  }
  if (best) {
    const own = coverageOf(best.deck, cards);
    if (own.unreviewed.length) warnings.push(`The recommended deck uses ${own.unreviewed.length} card${own.unreviewed.length === 1 ? '' : 's'} whose rules were translated by Claude and not yet reviewed (${own.unreviewed.slice(0, 4).join(', ')}${own.unreviewed.length > 4 ? ', …' : ''}). Verify them in the Audit tab before trusting the number.`);
  }
  if (warnings.length) reasons.push(...warnings);

  // ---- key cards: which cards were played in wins more than in losses
  const keyCards: KeyCard[] = [];
  if (best?.result.cards) {
    const base = score(best.result) / Math.max(1, best.result.games);
    for (const [id, t] of Object.entries(best.result.cards)) {
      if (t.played < Math.max(6, best.result.games * 0.08) || !best.deck.main[id]) continue;
      keyCards.push({ id, name: cards[id]?.name ?? id, played: t.played, winWhenPlayed: t.wonWhenPlayed / t.played, lift: t.wonWhenPlayed / t.played - base });
    }
    keyCards.sort((a, b) => b.lift - a.lift);
  }

  onProgress({ phase: 'done', gamesPlayed, message: headline });
  return {
    verdict, headline, reasons, best,
    alternatives: validated.slice(1),
    baseline, keyCards,
    coverage: best ? [...coverage, { deck: best.deck.name, ...coverageOf(best.deck, cards) }] : coverage,
    warnings, gamesPlayed, ms: Date.now() - t0,
  };
}

/** Synchronous runner for Node and tests. */
export function localRunner(cards: Record<string, Card>, runMatch: (c: Record<string, Card>, j: MatchJob) => MatchResult): Runner {
  return async (jobs) => jobs.map((j) => runMatch(cards, j));
}
