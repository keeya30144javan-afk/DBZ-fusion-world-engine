import { useState } from 'preact/hooks';
import { validateDeck } from '../../data/decks';
import { Level, MatchJob, MatchResult, emptyResult, mergeResults, score } from '../../builder/evaluate';
import { wilson } from '../../builder/stats';
import { newGame } from '../../engine/game';
import { FastPolicy, playout } from '../../ai/heuristics';
import { CIBar, DeckSelect, Meter, Seg, getPool, pct, useStore } from '../components';

export function MatchupView() {
  const st = useStore();
  const [a, setA] = useState(st.meta[0]?.id ?? '');
  const [b, setB] = useState(st.meta[1]?.id ?? st.meta[0]?.id ?? '');
  const [games, setGames] = useState('100');
  const [level, setLevel] = useState<Level>('fast');
  const [res, setRes] = useState<{ r: MatchResult; a: string; b: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [sample, setSample] = useState<string[] | null>(null);
  const da = st.meta.find((d) => d.id === a);
  const db = st.meta.find((d) => d.id === b);
  const errs = [...(da ? validateDeck(da, st.cards, st.rules) : ['Pick deck A']), ...(db ? validateDeck(db, st.cards, st.rules) : ['Pick deck B'])];

  async function run() {
    if (!da || !db) return;
    setRunning(true);
    const n = +games;
    const chunk = level === 'fast' ? 25 : 4;
    const base = Date.now() % 1_000_000;
    const jobs: MatchJob[] = [];
    for (let g = 0; g < n; g += chunk) jobs.push({ a: da, b: db, seeds: Array.from({ length: Math.min(chunk, n - g) }, (_, k) => base + g + k), level, track: true, rules: st.rules });
    const out = await getPool(st.cards).run(jobs);
    setRes({ r: out.reduce((acc, r) => mergeResults(acc, r), emptyResult()), a: da.name, b: db.name });
    setRunning(false);
  }

  function sampleGame() {
    if (!da || !db) return;
    const s = newGame(st.cards, [da, db], { seed: Date.now() % 100000, log: true, rules: st.rules });
    const p = new FastPolicy(0.1);
    playout(s, [p, p]);
    setSample(s.log!.map((l) => l.replace(/P0/g, 'A').replace(/P1/g, 'B')));
  }

  const ci = res ? wilson(score(res.r), res.r.games) : null;
  return (
    <div class="split">
      <div class="stack">
        <p class="intro">Play two decks against each other many times. Who goes first alternates every game.</p>
        <div class="panel raised stack">
          <label class="field">Deck A<DeckSelect id="deck-a" value={a} onChange={setA} decks={st.meta} cards={st.cards} /></label>
          <label class="field">Deck B<DeckSelect id="deck-b" value={b} onChange={setB} decks={st.meta} cards={st.cards} /></label>
          <label class="field">Games<Seg label="Games" options={[['50', '50'], ['100', '100'], ['200', '200'], ['400', '400']]} value={games} onChange={setGames} /></label>
          <label class="field">AI<Seg label="AI" options={[['fast', 'Fast'], ['quick', 'Search'], ['strong', 'Strong']]} value={level} onChange={setLevel} /></label>
          {errs.length > 0 && <div class="err">{errs.slice(0, 3).map((e) => <div key={e}>{e}</div>)}</div>}
          <div class="row">
            <button class="btn primary" onClick={run} disabled={running || errs.length > 0}>{running ? 'Playing…' : 'Play matchup'}</button>
            <button class="btn" onClick={sampleGame} disabled={errs.length > 0}>Show one game</button>
          </div>
          {level !== 'fast' && <p class="note">Search AI takes about a second per move decision. 100 games can take a few minutes.</p>}
        </div>
      </div>
      <div class="stack">
        {res && ci ? (
          <div class="panel raised stack">
            <div class="eyebrow">{res.a} vs {res.b}</div>
            <div class="big">{pct(ci.mean)} <small>for deck A</small></div>
            <CIBar rate={ci.mean} lo={ci.lo} hi={ci.hi} bar={0.5} />
            <p class="note">95% range: {pct(ci.lo)} to {pct(ci.hi)} over {res.r.games} games. {ci.lo > 0.5 ? 'Deck A is favoured.' : ci.hi < 0.5 ? 'Deck B is favoured.' : 'Too close to call at this sample size.'}</p>
            <table><tbody>
              {Object.entries(res.r.reasons).sort((x, y) => y[1] - x[1]).map(([k, v]) => <tr key={k}><td>{k.replace('win', 'A wins').replace('loss', 'B wins')}</td><td class="num">{v}</td><td style={{ width: '35%' }}><Meter value={v / res.r.games} /></td></tr>)}
              <tr><td>A's win rate going first</td><td class="num">{pct(res.r.firstWins / Math.max(1, res.r.firstGames), 0)}</td><td /></tr>
              <tr><td>Average length</td><td class="num">{(res.r.turns / Math.max(1, res.r.games)).toFixed(1)} turns</td><td /></tr>
            </tbody></table>
          </div>
        ) : <div class="empty">Pick two decks and press <b>Play matchup</b>.</div>}
        {sample && (
          <div class="panel">
            <h3>One game, move by move</h3>
            <div class="gamelog">{sample.join('\n')}</div>
          </div>
        )}
      </div>
    </div>
  );
}
