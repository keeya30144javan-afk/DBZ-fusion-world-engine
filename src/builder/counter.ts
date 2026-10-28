import { Card, Decklist } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { deckKey, validateDeck } from '../data/decks';
import { compileCard } from '../effects/parse';
import { cloneDeck, crossover, mulberry, mutate, seedDeck } from './deckgen';
import { Level, MatchJob, MatchResult, emptyResult, mergeResults, score } from './evaluate';
import { Z, diffZ, wilson } from './stats';

/** Runs match jobs; `onEach` is called as each job finishes (for progress). */
export type Runner = (jobs: MatchJob[], onEach?: (r: MatchResult) => void) => Promise<MatchResult[]>;

/** Rough relative cost of one game per AI level, for progress and time estimates. */
const GAME_COST: Record<Level, number> = { fast: 1, quick: 800, strong: 2500, deep: 8000 };

export interface CounterTarget {
  deck: Decklist;
  weight: number;
}

export type Effort = 'test' | 'quick' | 'standard' | 'thorough';

export interface CounterOptions {
  targets: CounterTarget[];
  /** Leaders allowed for the counter deck; default every leader in the database. */
  leaders?: string[];
  /** Known decks to try as-is (the current meta). */
  known?: Decklist[];
  /**
   * Build from scratch: known decks are never used as building material (no seeding, no
   * crossover). They stay the yardstick: the baseline every discovered deck must beat.
   */
  blind?: boolean;
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

/**
 * gens/pop/screen: evolution with fast-AI games. rerank/rerankGames: each generation the
 * top `rerank` decks also play `rerankGames` games with the searching AI on both sides,
 * so selection follows decks that beat good play, not the fast AI's mistakes.
 */
const EFFORT = {
  /** For trying things out: at most 100 validation games per deck, whatever the AI level. */
  test: { gens: 3, pop: 10, screen: 16, validate: 100, finalists: 2, chunk: 8, rerank: 3, rerankGames: 8 },
  quick: { gens: 4, pop: 12, screen: 24, validate: 120, finalists: 2, chunk: 8, rerank: 4, rerankGames: 8 },
  standard: { gens: 8, pop: 16, screen: 40, validate: 240, finalists: 3, chunk: 8, rerank: 4, rerankGames: 12 },
  thorough: { gens: 14, pop: 24, screen: 64, validate: 480, finalists: 4, chunk: 8, rerank: 6, rerankGames: 16 },
};

/** One step in how a deck came to be: where it started, or what a generation changed. */
export interface Change {
  gen: number;
  how: string;
  added?: Record<string, number>;
  removed?: Record<string, number>;
  /** The parent's estimated win rate when the change was made. */
  parentRate?: number;
}

export interface Scored {
  deck: Decklist;
  key: string;
  origin: string;
  history: Change[];
  /** Per-target results with the fast AI (screening). */
  res: MatchResult[];
  /** Per-target results with the searching AI on both sides (re-ranking). */
  sres: MatchResult[];
}

export interface Validated {
  deck: Decklist;
  origin: string;
  history?: Change[];
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
  /** How close the best deck is to the nearest known list with the same Leader (share of cards in common). */
  nearestKnown?: { name: string; overlap: number } | null;
  /** True when the search built every candidate itself (known lists were only the bar to beat). */
  blind?: boolean;
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
  /** Share of the whole search done, 0..1 (weighted by how long each kind of game takes). */
  overall?: number;
  /** Estimated seconds left, once there is enough to go on. */
  eta?: number;
  /** The current step, e.g. games of one finalist's validation. */
  step?: { label: string; done: number; total: number };
  /** The best deck found so far, so the user can see what is being built. */
  best?: { deck: Decklist; rate: number; games: number; validated: boolean; searched?: boolean };
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
    // Translations that passed the automatic checker and Claude's second read don't need a person first.
    if (cc.source === 'claude' && !cc.check?.ok) unreviewed.push(`${id} ${c.name}`);
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

  const screenScore = (c: Scored) => aggregate(c.res, targets, 1).mean;
  const newScored = (deck: Decklist, origin: string, history: Change[] = [{ gen: 0, how: origin }]): Scored => ({ deck, key: deckKey(deck), origin, history, res: targets.map(() => emptyResult()), sres: targets.map(() => emptyResult()) });

  // ---- ranking: fast-AI screening overrates decks that exploit careless play, so decks
  // checked with the searching AI are ranked on those games, and the rest on their fast
  // win rate scaled by how much fast games have overrated the checked decks in this run.
  const searchGames = (c: Scored) => c.sres.reduce((a, r) => a + r.games, 0);
  const searchRate = (c: Scored) => aggregate(c.sres, targets, 1).mean;
  let calibration = 1;
  const recalibrate = () => {
    let fast = 0, slow = 0;
    for (const c of seen.values()) if (searchGames(c) > 0) { fast += screenScore(c); slow += searchRate(c); }
    calibration = fast > 0 ? Math.min(1, Math.max(0.2, slow / fast)) : 1;
  };
  /** Best estimate of the win rate against good play. A few search games are shrunk toward the scaled fast estimate. */
  const rankScore = (c: Scored) => {
    const prior = screenScore(c) * calibration;
    const n = searchGames(c);
    if (!n) return prior;
    const k = 4;
    return (searchRate(c) * n + prior * k) / (n + k);
  };
  const byRank = (a: Scored, b: Scored) => rankScore(b) - rankScore(a);

  // ---- progress: cost-weighted share of the planned work, an ETA, and the best deck so far
  const level: Level = opts.validateLevel ?? 'quick';
  const validateGames = level === 'fast' && opts.effort !== 'test' ? E.validate * 2 : E.validate;
  const nT = targets.length;
  const seedPlan = (2 * leaders.length + (opts.known?.length ?? 0)) * E.chunk * 2.5 * nT; // successive halving, see below
  const evolvePlan = E.gens * E.pop * E.screen * nT;
  const rerankLevel: Level | null = level === 'fast' ? null : 'quick';
  const rerankPlan = rerankLevel ? (E.gens + 1) * E.rerank * E.rerankGames * nT * GAME_COST[rerankLevel] : 0;
  const validatePlan = (E.finalists + 1) * validateGames * nT * GAME_COST[level];
  const plan = seedPlan + evolvePlan + rerankPlan + validatePlan;
  let costDone = 0;
  let lastReport = 0;
  let current: Omit<Progress, 'gamesPlayed' | 'overall' | 'eta'> = { phase: 'seed', message: '' };
  let bestSoFar: Progress['best'];
  const report = (force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    const overall = Math.min(0.999, costDone / plan);
    const elapsed = (now - t0) / 1000;
    const eta = overall > 0.03 && elapsed > 5 ? Math.round((elapsed / overall) * (1 - overall)) : undefined;
    onProgress({ ...current, gamesPlayed, overall, eta, best: bestSoFar });
  };
  const setStep = (p: Omit<Progress, 'gamesPlayed' | 'overall' | 'eta'>) => { current = p; report(true); };
  const offerBest = (pool: Scored[]) => {
    if (bestSoFar?.validated || !pool.length) return;
    const top = pool.slice().sort(byRank)[0];
    bestSoFar = { deck: top.deck, rate: rankScore(top), games: searchGames(top) || top.res.reduce((a, r) => a + r.games, 0), validated: false, searched: searchGames(top) > 0 };
  };

  /** Play `games` fast games of each candidate against each target. */
  async function screen(cands: Scored[], games: number) {
    const jobs: MatchJob[] = [];
    const map: [number, number][] = [];
    cands.forEach((c, ci) => targets.forEach((t, ti) => {
      for (let g = 0; g < games; g += E.chunk) {
        jobs.push({ a: c.deck, b: t.deck, seeds: freshSeeds(Math.min(E.chunk, games - g)), level: 'fast', track: true, rules });
        map.push([ci, ti]);
      }
    }));
    const total = jobs.length;
    let done = 0;
    const label = current.step?.label ?? 'Screening';
    const results = await run(jobs, (r) => {
      done++; gamesPlayed += r.games; costDone += r.games;
      current = { ...current, step: { label, done, total } };
      report();
    });
    results.forEach((r, i) => { const [ci, ti] = map[i]; mergeResults(cands[ci].res[ti], r); });
  }

  /** A short series with the searching AI on both sides for the top candidates. */
  async function rerank(pool: Scored[], label: string) {
    if (!rerankLevel || isCancelled()) return;
    const picks = pool.slice().sort(byRank).filter((c) => searchGames(c) < E.rerankGames * nT * 2).slice(0, E.rerank);
    const jobs: MatchJob[] = [];
    const map: [number, number][] = [];
    picks.forEach((c, ci) => targets.forEach((t, ti) => {
      for (let g = 0; g < E.rerankGames; g += 4) {
        jobs.push({ a: c.deck, b: t.deck, seeds: freshSeeds(Math.min(4, E.rerankGames - g)).map((x) => x + 2_000_000), level: rerankLevel, track: true, rules });
        map.push([ci, ti]);
      }
    }));
    const total = jobs.length * 4;
    let done = 0;
    current = { ...current, message: `${label}: checking the top ${picks.length} with the searching AI`, step: { label: `${label}: search check`, done: 0, total } };
    report(true);
    const results = await run(jobs, (r) => {
      done += r.games; gamesPlayed += r.games; costDone += r.games * GAME_COST[rerankLevel];
      current = { ...current, step: { label: `${label}: search check`, done, total } };
      report();
    });
    results.forEach((r, i) => { const [ci, ti] = map[i]; mergeResults(picks[ci].sres[ti], r); });
    recalibrate();
    offerBest(pool);
  }

  // ---- seed population
  setStep({ phase: 'seed', message: `Building starting decks for ${leaders.length} leader(s)` });
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
  if (!opts.blind) for (const k of opts.known ?? []) push(cloneDeck(k), `known: ${k.name}`);
  for (const id of leaders) {
    push(seedDeck(cards, id, rng, rules), 'generated');
    push(seedDeck(cards, id, rng, rules, 1.5), 'generated (variant)');
  }
  if (!pop.length) throw new Error('No legal candidate decks could be built from this card pool.');

  // Successive halving: every starting deck gets a short test, the better half gets more
  // games, and so on, so clearly weak leaders don't cost a full screening each.
  // No deck plays more than the usual screening budget (E.screen) in total.
  let survivors = pop.slice();
  let played = 0;
  for (let round = 1; ; round++) {
    if (isCancelled()) break;
    const first = Math.max(E.chunk, Math.ceil(E.screen / 4 / E.chunk) * E.chunk);
    const games = Math.min(first * 2 ** (round - 1), E.screen - played);
    if (games > 0) {
      setStep({ phase: 'seed', message: `Testing ${survivors.length} starting deck${survivors.length === 1 ? '' : 's'} (round ${round}, ${games} games each)`, step: { label: `Starting decks, round ${round}`, done: 0, total: 1 } });
      await screen(survivors, games);
      played += games;
    }
    if (survivors.length <= E.pop && played >= E.screen) break;
    if (survivors.length > E.pop) {
      survivors.sort((a, b) => screenScore(b) - screenScore(a));
      survivors = survivors.slice(0, Math.max(E.pop, Math.ceil(survivors.length / 2)));
    } else if (played >= E.screen) break;
  }

  offerBest(survivors);
  await rerank(survivors, 'Starting decks');

  // ---- evolve
  let population = survivors.slice();
  for (let g = 1; g <= E.gens; g++) {
    if (isCancelled()) break;
    population.sort(byRank);
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
    setStep({ phase: 'evolve', generation: g, generations: E.gens, message: `Generation ${g}/${E.gens}: breeding and testing new decks`, step: { label: `Generation ${g} of ${E.gens}`, done: 0, total: 1 } });
    const children: Scored[] = [];
    let tries = 0;
    while (children.length < E.pop - elites.length && tries++ < E.pop * 10) {
      const parent = elites[Math.floor(rng() * elites.length)];
      let child: Decklist;
      let how = 'swapped cards';
      const sameLeader = elites.filter((e) => e !== parent && e.deck.leader === parent.deck.leader);
      if (sameLeader.length && rng() < 0.3) how = 'crossed with another list for the same Leader', child = crossover(parent.deck, sameLeader[Math.floor(rng() * sameLeader.length)].deck, cards, rng, rules);
      else {
        const all = [...parent.res, ...parent.sres];
        const stats = all.reduce((acc, r) => mergeResults(acc, r), emptyResult()).cards ?? {};
        const base = all.reduce((a, r) => a + score(r), 0) / Math.max(1, all.reduce((a, r) => a + r.games, 0));
        const weak = (id: string) => {
          const t = stats[id];
          if (!t || t.played < 4) return 0;
          return base - t.wonWhenPlayed / t.played; // played but lost more than usual
        };
        child = mutate(parent.deck, cards, rng, 1 + Math.floor(rng() * 4), weak, rules);
      }
      child.name = `${cards[child.leader].name} (${child.leader}) counter`;
      const k = deckKey(child);
      if (seen.has(k) || validateDeck(child, cards, rules).length) continue;
      const s = newScored(child, 'evolved', [...parent.history, { gen: g, how, ...diffDecks(parent.deck, child), parentRate: rankScore(parent) }]);
      seen.set(k, s);
      children.push(s);
    }
    await screen(children, E.screen);
    // Elites get more games each generation, which shrinks the noise on the leaders.
    await screen(elites, Math.ceil(E.screen / 2));
    population = [...elites, ...children];
    offerBest(population);
    await rerank(population, `Generation ${g}`);
    const top = population.slice().sort(byRank)[0];
    const checked = searchGames(top) > 0;
    setStep({ phase: 'evolve', generation: g, generations: E.gens, bestScreen: rankScore(top), bestName: top.deck.name, message: `Generation ${g}/${E.gens}: best ${checked ? 'estimated' : 'screening'} win rate ${(rankScore(top) * 100).toFixed(0)}% (${cards[top.deck.leader].name})${rerankLevel ? `; fast games overrate decks by ×${(1 / calibration).toFixed(1)}` : ''}` });
  }

  // ---- validate finalists with fresh games and stronger play on both sides
  const all = [...seen.values()].filter((s) => s.res.some((r) => r.games > 0));
  all.sort(byRank);
  const finalists: Scored[] = [];
  for (const c of all) {
    if (finalists.length >= E.finalists) break;
    if (finalists.some((f) => f.deck.leader === c.deck.leader && f.origin === c.origin && finalists.length < E.finalists - 1)) continue;
    finalists.push(c);
  }
  // Baseline: the best known deck that is not just one of the finalists. If the
  // user gave no meta decks, the target itself (the mirror) is the baseline.
  const baselines = (opts.known?.length ? opts.known : targets.map((t) => t.deck)).map((d) => seen.get(deckKey(d)) ?? newScored(cloneDeck(d), `known: ${d.name}`));
  baselines.sort(byRank);
  const baselineScored = baselines[0];

  /**
   * Fresh games with the stronger AI, played in rounds. Between rounds a deck stops early
   * when it can no longer reach the bar (its upper bound is below it), or when it has
   * cleared the bar by a wide margin (a stricter z than the final one, so looking early
   * cannot turn a lucky streak into a recommendation).
   */
  async function validate(c: Scored, label: string, opts2: { early: boolean }): Promise<Validated> {
    const res = targets.map(() => emptyResult());
    const roundSize = Math.max(16, Math.ceil(validateGames / 4 / 4) * 4);
    const planned = validateGames * nT;
    let played = 0;
    for (let start = 0; start < validateGames; start += roundSize) {
      if (isCancelled()) break;
      const n = Math.min(roundSize, validateGames - start);
      const jobs: MatchJob[] = [];
      const map: number[] = [];
      targets.forEach((t, ti) => {
        for (let g = 0; g < n; g += 4) {
          jobs.push({ a: c.deck, b: t.deck, seeds: freshSeeds(Math.min(4, n - g)).map((x) => x + 1_000_000), level, track: true, rules });
          map.push(ti);
        }
      });
      const results = await run(jobs, (r) => {
        played += r.games; gamesPlayed += r.games; costDone += r.games * GAME_COST[level];
        current = { ...current, step: { label, done: played, total: planned } };
        report();
      });
      results.forEach((r, i) => mergeResults(res[map[i]], r));
      if (!opts2.early || start + n >= validateGames) continue;
      const agg = aggregate(res, targets, z);
      const strict = aggregate(res, targets, z + 0.75);
      const hopeless = agg.hi < opts.threshold;
      const clear = strict.lo >= opts.threshold;
      if (hopeless || clear) {
        costDone += (planned - played) * GAME_COST[level]; // the skipped games count as done for the estimate
        break;
      }
    }
    const agg = aggregate(res, targets, z);
    return {
      deck: c.deck, origin: c.origin, history: c.history, rate: agg.mean, lo: agg.lo, hi: agg.hi, games: agg.games,
      perTarget: res.map((r, i) => ({ name: targets[i].deck.name, ...wilson(score(r), r.games, z), rate: score(r) / Math.max(1, r.games), games: r.games })),
      result: res.reduce((acc, r) => mergeResults(acc, r), emptyResult()),
    };
  }

  const validated: Validated[] = [];
  for (let i = 0; i < finalists.length; i++) {
    if (isCancelled()) break;
    setStep({ phase: 'validate', message: `Validating finalist ${i + 1}/${finalists.length}: ${finalists[i].deck.name} (up to ${validateGames} fresh games, ${level} AI on both sides)`, step: { label: `Finalist ${i + 1} of ${finalists.length}`, done: 0, total: validateGames * nT } });
    const v = await validate(finalists[i], `Finalist ${i + 1} of ${finalists.length}`, { early: true });
    validated.push(v);
    const top = validated.slice().sort((a, b) => b.lo - a.lo || b.rate - a.rate)[0];
    bestSoFar = { deck: top.deck, rate: top.rate, games: top.games, validated: true };
    report(true);
  }
  let baseline: Validated | null = null;
  const baselineIsFinalist = validated.find((v) => deckKey(v.deck) === baselineScored.key);
  if (baselineIsFinalist) baseline = baselineIsFinalist;
  else if (!isCancelled()) {
    // The best known deck as it is: the bar evolved decks must beat, and a candidate in its own
    // right (an unchanged starter or meta list can be the real answer).
    setStep({ phase: 'validate', message: `Validating baseline "${baselineScored.deck.name}"`, step: { label: 'Baseline', done: 0, total: validateGames * nT } });
    baseline = await validate(baselineScored, 'Baseline', { early: false });
    validated.push(baseline);
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
    } else if (best.lo >= opts.threshold && baseline) {
      verdict = 'inconclusive';
      headline = `${best.deck.name} clears your ${pct(opts.threshold)} bar (wins ${pct(best.rate)}, at least ${pct(best.lo)}), but it isn't clearly better than just playing "${baseline.deck.name}" (${pct(baseline.rate)}).`;
      reasons.push(`Playing "${baseline.deck.name}" as it is works about as well; the changes aren't proven to help.`);
    } else if (best.rate >= opts.threshold && best.hi >= opts.threshold) {
      verdict = 'inconclusive';
      headline = `Promising but not proven: ${best.deck.name} wins ${pct(best.rate)}, but the ${conf} lower bound (${pct(best.lo)}) is below your ${pct(opts.threshold)} bar.`;
      reasons.push('Run again with a higher effort setting to play more games before trusting this.');
    } else {
      verdict = 'none';
      headline = `No reliable counter found. The best candidate wins ${pct(best.rate)} (range ${pct(best.lo)}-${pct(best.hi)}), which does not clear your ${pct(opts.threshold)} bar.`;
      reasons.push('Recommending something anyway would be guessing, so this is a real "no".');
    }
    if (!beatsBaseline && baseline && best.lo < opts.threshold) reasons.push(`It is not clearly better than just playing "${baseline.deck.name}" (${pct(baseline.rate)}).`);
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

  costDone = plan;
  setStep({ phase: 'done', message: headline });
  let nearestKnown: CounterReport['nearestKnown'] = null;
  if (best) {
    const size = Object.values(best.deck.main).reduce((a, b) => a + b, 0);
    for (const k of opts.known ?? []) {
      if (k.leader !== best.deck.leader || deckKey(k) === deckKey(best.deck)) continue;
      let common = 0;
      for (const [id, n] of Object.entries(best.deck.main)) common += Math.min(n, k.main[id] ?? 0);
      const overlap = common / Math.max(size, Object.values(k.main).reduce((a, b) => a + b, 0));
      if (!nearestKnown || overlap > nearestKnown.overlap) nearestKnown = { name: k.name, overlap };
    }
  }
  return {
    verdict, headline, reasons, best, nearestKnown, blind: !!opts.blind,
    alternatives: validated.slice(1),
    baseline, keyCards,
    coverage: best ? [...coverage, { deck: best.deck.name, ...coverageOf(best.deck, cards) }] : coverage,
    warnings, gamesPlayed, ms: Date.now() - t0,
  };
}

/** Synchronous runner for Node and tests. */
export function localRunner(cards: Record<string, Card>, runMatch: (c: Record<string, Card>, j: MatchJob) => MatchResult): Runner {
  return async (jobs, onEach) => jobs.map((j) => { const r = runMatch(cards, j); onEach?.(r); return r; });
}

/** Cards added to and removed from a deck, by id. */
export function diffDecks(from: Decklist, to: Decklist): { added: Record<string, number>; removed: Record<string, number> } {
  const added: Record<string, number> = {}, removed: Record<string, number> = {};
  for (const id of new Set([...Object.keys(from.main), ...Object.keys(to.main)])) {
    const d = (to.main[id] ?? 0) - (from.main[id] ?? 0);
    if (d > 0) added[id] = d;
    else if (d < 0) removed[id] = -d;
  }
  return { added, removed };
}
