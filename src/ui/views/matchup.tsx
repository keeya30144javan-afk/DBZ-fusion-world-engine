import { useMemo, useState } from 'preact/hooks';
import { parseDecklist, validateDeck } from '../../data/decks';
import { Decklist } from '../../data/types';
import { Level, MatchJob, MatchResult, emptyResult, mergeResults, score } from '../../builder/evaluate';
import { wilson } from '../../builder/stats';
import { WatchGame } from './replay';
import { CIBar, ColorTag, DeckSelect, Meter, Seg, getPool, leaderLabel, pct, safeStorage, useStore } from '../components';

const [loadPastes, savePastes] = safeStorage<{ a: string; b: string }>('shenron.matchupPastes', { a: '', b: '' });

export function MatchupView() {
  const st = useStore();
  const [a, setA] = useState(st.meta[0]?.id ?? '');
  const [b, setB] = useState(st.meta[1]?.id ?? st.meta[0]?.id ?? '');
  const [games, setGames] = useState('100');
  const [level, setLevel] = useState<Level>('fast');
  const [res, setRes] = useState<{ r: MatchResult; a: string; b: string } | null>(null);
  const [running, setRunning] = useState(false);
  const saved = useMemo(() => loadPastes(), []);
  const [modeA, setModeA] = useState<'meta' | 'paste'>(saved.a ? 'paste' : 'meta');
  const [modeB, setModeB] = useState<'meta' | 'paste'>(saved.b ? 'paste' : 'meta');
  const [pasteA, setPasteA0] = useState(saved.a);
  const [pasteB, setPasteB0] = useState(saved.b);
  const setPasteA = (v: string) => { setPasteA0(v); savePastes({ a: v, b: pasteB }); };
  const setPasteB = (v: string) => { setPasteB0(v); savePastes({ a: pasteA, b: v }); };
  const pick = (mode: 'meta' | 'paste', id: string, text: string, label: string): { deck?: Decklist; errors: string[] } => {
    if (mode === 'meta') {
      const d = st.meta.find((m) => m.id === id);
      return d ? { deck: d, errors: validateDeck(d, st.cards, st.rules) } : { errors: [`Pick deck ${label}`] };
    }
    if (!text.trim()) return { errors: [`Paste deck ${label}`] };
    const { deck, errors } = parseDecklist(text, st.cards, `Pasted deck ${label}`);
    return { deck, errors: [...errors, ...validateDeck(deck, st.cards, st.rules)].map((e) => `Deck ${label}: ${e}`) };
  };
  const A = useMemo(() => pick(modeA, a, pasteA, 'A'), [modeA, a, pasteA, st.meta, st.cards, st.rules]);
  const B = useMemo(() => pick(modeB, b, pasteB, 'B'), [modeB, b, pasteB, st.meta, st.cards, st.rules]);
  const da = A.deck, db = B.deck;
  const errs = [...A.errors, ...B.errors];
  const deckField = (label: string, mode: 'meta' | 'paste', setMode: (m: 'meta' | 'paste') => void, id: string, setId: (v: string) => void, text: string, setText: (v: string) => void, d?: Decklist) => (
    <div class="stack" style={{ gap: '6px' }}>
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <b>Deck {label}</b>
        <Seg label={`Deck ${label} source`} options={[['meta', 'Saved deck'], ['paste', 'Paste a list']]} value={mode} onChange={setMode} />
      </div>
      {mode === 'meta'
        ? <DeckSelect id={`deck-${label.toLowerCase()}`} value={id} onChange={setId} decks={st.meta} cards={st.cards} />
        : <textarea aria-label={`Decklist ${label}`} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} placeholder={'One card per line, include the Leader:\n1 FS02-01\n4 FS02-05\n...'} />}
      {mode === 'paste' && d?.leader && st.cards[d.leader] && <div class="note">Leader: <b>{leaderLabel(st.cards, d.leader)}</b> <ColorTag card={st.cards[d.leader]} /></div>}
    </div>
  );

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

  const ci = res ? wilson(score(res.r), res.r.games) : null;
  return (
    <div class="split">
      <div class="stack">
        <p class="intro">Play two decks against each other many times. Who goes first alternates every game.</p>
        <div class="panel raised stack">
          {deckField('A', modeA, setModeA, a, setA, pasteA, setPasteA, da)}
          {deckField('B', modeB, setModeB, b, setB, pasteB, setPasteB, db)}
          <label class="field">Games<Seg label="Games" options={[['50', '50'], ['100', '100'], ['200', '200'], ['400', '400']]} value={games} onChange={setGames} /></label>
          <label class="field">AI<Seg label="AI" options={[['fast', 'Fast'], ['quick', 'Search'], ['strong', 'Strong']]} value={level} onChange={setLevel} /></label>
          {errs.length > 0 && <div class="err">{errs.slice(0, 3).map((e) => <div key={e}>{e}</div>)}</div>}
          <div class="row">
            <button class="btn primary" onClick={run} disabled={running || errs.length > 0}>{running ? 'Playing…' : 'Play matchup'}</button>
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
        {da && db && errs.length === 0 && <WatchGame key={`${da.name}|${db.name}|${JSON.stringify(da.main)}|${JSON.stringify(db.main)}`} a={da} b={db} cards={st.cards} rules={st.rules} level={level} />}
      </div>
    </div>
  );
}
