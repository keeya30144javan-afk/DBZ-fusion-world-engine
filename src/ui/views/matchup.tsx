import { useMemo, useRef, useState } from 'preact/hooks';
import { parseDecklist, validateDeck } from '../../data/decks';
import { Decklist } from '../../data/types';
import { Level, MatchJob, MatchResult, emptyResult, mergeResults, score } from '../../builder/evaluate';
import { wilson } from '../../builder/stats';
import { WatchGame } from './replay';
import { store } from '../store';
import { SelfplayRunner } from '../../workers/pool';
import { CIBar, ColorTag, DeckSelect, Meter, Seg, getPool, leaderLabel, pct, safeStorage, useStore } from '../components';

const [loadPastes, savePastes] = safeStorage<{ a: string; b: string }>('shenron.matchupPastes', { a: '', b: '' });

export function MatchupView() {
  const st = useStore();
  const top = useMemo(() => [...st.meta].filter((d) => !d.name.startsWith('Starter')).sort((x, y) => (y.share ?? 0) - (x.share ?? 0)), []);
  const [a, setA] = useState(top[0]?.id ?? st.meta[0]?.id ?? '');
  const [b, setB] = useState(top[1]?.id ?? st.meta[1]?.id ?? st.meta[0]?.id ?? '');
  const [games, setGames] = useState('100');
  const [level, setLevel] = useState<Level>('fast');
  const [res, setRes] = useState<{ r: MatchResult; a: string; b: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; t0: number; r: MatchResult } | null>(null);
  const runId = useRef(0);
  const partial = useRef<{ r: MatchResult; a: string; b: string } | null>(null);
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
    const id = ++runId.current;
    const n = +games;
    const chunk = level === 'fast' ? 10 : 2;
    const base = Date.now() % 1_000_000;
    const jobs: MatchJob[] = [];
    for (let g = 0; g < n; g += chunk) jobs.push({ a: da, b: db, seeds: Array.from({ length: Math.min(chunk, n - g) }, (_, k) => base + g + k), level, track: true, rules: st.rules });
    let sofar = emptyResult();
    partial.current = null;
    const t0 = Date.now();
    setProg({ done: 0, total: n, t0, r: sofar });
    try {
      await getPool(st.cards).run(jobs, (r) => {
        if (runId.current !== id) return;
        sofar = mergeResults(sofar, r);
        partial.current = { r: sofar, a: da.name, b: db.name };
        setProg({ done: sofar.games, total: n, t0, r: sofar });
      });
    } catch { /* stopped: keep the games played so far */ }
    if (runId.current !== id) return;
    if (sofar.games > 0) setRes({ r: sofar, a: da.name, b: db.name });
    setProg(null);
    setRunning(false);
  }

  function stop() {
    runId.current++;
    getPool(st.cards).cancelQueued();
    if (partial.current && partial.current.r.games > 0) setRes(partial.current);
    setProg(null);
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
          {running && <button class="btn" onClick={stop}>Stop and show results so far</button>}
          {level !== 'fast' && <p class="note">Search AI takes about a second per move decision. 100 games can take a few minutes.</p>}
        </div>
        <TrainPanel />
      </div>
      <div class="stack">
        {prog && <MatchProgress {...prog} />}
        {res && ci && !prog ? (
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
        ) : !prog && <div class="empty">Pick two decks and press <b>Play matchup</b>.</div>}
        {da && db && errs.length === 0 && <div class="row"><button class="btn" onClick={() => store.requestPlay(da, db)}>Play this matchup yourself (you are A)</button></div>}
        {da && db && errs.length === 0 && <WatchGame key={`${da.name}|${db.name}|${JSON.stringify(da.main)}|${JSON.stringify(db.main)}`} a={da} b={db} cards={st.cards} rules={st.rules} level={level} />}
      </div>
    </div>
  );
}

function MatchProgress({ done, total, t0, r }: { done: number; total: number; t0: number; r: MatchResult }) {
  const secs = (Date.now() - t0) / 1000;
  const left = done > 0 ? (secs / done) * (total - done) : null;
  return (
    <div class="panel raised progress" aria-live="polite">
      <div class="eyebrow">Playing · {done} / {total} games · {pct(done / total, 0)} done{left !== null ? ` · about ${fmtLeft(left)} left` : ' · estimating time left…'}</div>
      <Meter value={done / total} accent />
      {r.games > 0 ? <p class="note">So far deck A has won {pct(score(r) / r.games, 0)} of {r.games} games.</p> : null}
    </div>
  );
}

function fmtLeft(sec: number): string {
  if (sec < 90) return `${Math.max(5, Math.round(sec / 5) * 5)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/**
 * "Help train the AI": this computer plays searching-AI games against itself on every spare core and
 * saves each turn's position with who went on to win, for Claude to train the AI's judgement on.
 */
function TrainPanel() {
  const st = useStore();
  const runner = useRef<SelfplayRunner | null>(null);
  const buffer = useRef<{ rows: number[][]; games: number; inputs: number }>({ rows: [], games: 0, inputs: 0 });
  // File mode: everything stays in memory until the viewer downloads it (no database, or it's full).
  const kept = useRef<{ rows: number[][]; games: number; inputs: number }>({ rows: [], games: 0, inputs: 0 });
  const [toFile, setToFile] = useState(!store.writable);
  const fileMode = useRef(toFile);
  fileMode.current = toFile;
  const [state, setState] = useState({ running: false, games: 0, positions: 0, saved: 0, cores: 0, started: 0, error: '', unsaved: 0 });
  const keep = (b: { rows: number[][]; games: number; inputs: number }) => {
    kept.current.rows.push(...b.rows); kept.current.games += b.games; kept.current.inputs = b.inputs;
    setState((s) => ({ ...s, unsaved: kept.current.games }));
  };
  const flush = async () => {
    const b = buffer.current;
    if (!b.games) return;
    buffer.current = { rows: [], games: 0, inputs: b.inputs };
    if (fileMode.current) { keep(b); return; }
    try {
      await store.saveSelfplay(b, runner.current?.size ?? 0);
      setState((s) => ({ ...s, saved: s.saved + b.games }));
    } catch (e: any) {
      // Database missing or full: keep going and hold the games for a download instead.
      keep(b);
      setToFile(true);
      setState((s) => ({ ...s, error: `Couldn't save to the app database (${String(e?.code ?? e?.message ?? e)}), so games are now kept for a file download.` }));
    }
  };
  // Move training games out of the app database into files (under 25 MB each, to fit a chat attachment):
  // each part is deleted only after its download was accepted.
  const [clearing, setClearing] = useState('');
  const saveFile = async (name: string, data: string) => {
    const dl = await (window as any).claude?.use?.('downloads');
    if (dl) { await dl.save({ filename: name, data }); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = name;
    a.click();
  };
  const exportDb = async () => {
    let part = 1, total = 0;
    try {
      for (;;) {
        // ~400 batches of 10 games is ~22 MB: one file under the 30 MB attachment limit.
        const batch = await store.readSelfplay(400);
        if (!batch.length) break;
        const rows: number[][] = [];
        let games = 0, inputs = 0;
        for (const x of batch) { rows.push(...x.rows); games += x.games; inputs = x.inputs || inputs; }
        setClearing(`Part ${part}: ${games} games ready. Accept the download to clear them from the app.`);
        await saveFile(`shenron-training-db-part${part}-${games}games.json`, JSON.stringify({ v: 2, inputs, games, rows }));
        await store.deleteSelfplay(batch.map((x) => x.id));
        total += games; part++;
        setClearing(`Saved and cleared ${total} games so far…`);
      }
      setClearing(total ? `Done: ${total} games saved to ${part - 1} file(s) and cleared from the app database.` : 'No training games in the app database.');
    } catch (e: any) {
      setClearing(`Stopped (${String(e?.code ?? e?.message ?? e)}). Nothing unsaved was deleted; you can run it again.`);
    }
  };
  // A training file too big to attach (over 30 MB): read it here and save it again as parts under 25 MB.
  const splitFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setClearing(`Reading ${file.name}…`);
      const j = JSON.parse(await file.text());
      const rows: number[][] = j.rows ?? [];
      if (!rows.length) { setClearing(`${file.name} has no training rows.`); return; }
      const size = JSON.stringify(rows).length;
      const parts = Math.max(1, Math.ceil(size / 24e6));
      // Split on game boundaries: a game's rows share its seed (column inputs + 2).
      const seedCol = (j.inputs ?? rows[0].length - 4) + 2;
      const per = Math.ceil(rows.length / parts);
      let start = 0;
      const saved: number[] = [], skipped: number[] = [];
      for (let p = 1; start < rows.length; p++) {
        let end = Math.min(rows.length, start + per);
        while (end < rows.length && rows[end][seedCol] === rows[end - 1][seedCol]) end++;
        const chunk = rows.slice(start, end);
        const games = new Set(chunk.map((r) => r[seedCol])).size;
        setClearing(`Part ${p} of ${parts}: ${games} games. Accept the download (or decline to skip it).`);
        const name = `${file.name.replace(/\.json$/i, '')}-part${p}of${parts}.json`;
        const data = JSON.stringify({ v: j.v ?? 2, inputs: j.inputs, games, rows: chunk });
        // One part's refusal doesn't stop the rest: a declined part is skipped, a busy prompt is retried.
        for (let tries = 0; ; tries++) {
          try { await saveFile(name, data); saved.push(p); break; } catch (e: any) {
            if (e?.code === 'rate_limited' && tries < 5) { await new Promise((r) => setTimeout(r, 3000)); continue; }
            skipped.push(p); break;
          }
        }
        start = end;
      }
      setClearing(`Done with ${file.name}: saved part${saved.length === 1 ? '' : 's'} ${saved.join(', ') || 'none'}${skipped.length ? `; skipped ${skipped.join(', ')} (choose the file again to retry those)` : ''}.`);
    } catch (e: any) {
      setClearing(`Couldn't split it (${String(e?.code ?? e?.message ?? e)}).`);
    }
  };
  const download = async () => {
    await flush();
    const k = kept.current;
    if (!k.games) return;
    const name = `shenron-training-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${k.games}games.json`;
    const data = JSON.stringify({ v: 2, inputs: k.inputs, games: k.games, rows: k.rows });
    try {
      const dl = await (window as any).claude?.use?.('downloads');
      if (dl) await dl.save({ filename: name, data });
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        a.download = name;
        a.click();
      }
      kept.current = { rows: [], games: 0, inputs: k.inputs };
      setState((s) => ({ ...s, unsaved: 0 }));
    } catch (e: any) {
      setState((s) => ({ ...s, error: `Download didn't happen (${String(e?.code ?? e?.message ?? e)}). The games are still here; try again.` }));
    }
  };
  const start = () => {
    const decks = st.meta.filter((d) => !d.name.startsWith('Starter') && !validateDeck(d, st.cards, st.rules).length).map((d) => ({ name: d.name, leader: d.leader, main: d.main }));
    const r = new SelfplayRunner(st.cards, decks, (b) => {
      const buf = buffer.current;
      buf.rows.push(...b.rows); buf.games += b.games; buf.inputs = b.inputs;
      setState((s) => ({ ...s, games: s.games + b.games, positions: s.positions + b.rows.length }));
      if (buf.games >= 10) void flush();
    }, (e) => setState((s) => ({ ...s, error: e.slice(0, 300) })));
    runner.current = r;
    r.start();
    setState((s) => ({ ...s, running: true, cores: r.size, started: Date.now(), error: '' }));
  };
  const stop = () => {
    runner.current?.stop();
    void flush();
    setState((s) => ({ ...s, running: false }));
  };
  const mins = state.started ? (Date.now() - state.started) / 60000 : 0;
  return (
    <div class="panel stack">
      <h2>Help train the AI</h2>
      <p class="note">Your computer plays the searching AI against itself with the meta decks, on every core but one, and saves each turn's position and who went on to win. Claude trains the AI's judgement on these. Keep this tab open and the computer awake; stop any time (games in progress are dropped, everything finished is saved).</p>
      <label class="field">Save games to<Seg label="Save games to" options={[['db', 'App database'], ['file', 'A file on this PC']]} value={toFile ? 'file' : 'db'} onChange={(v) => setToFile(v === 'file' || !store.writable)} /></label>
      {toFile && <p class="note">Games are kept in this tab until you press <b>Download</b> (do it before closing the tab). Send the file to Claude next time.</p>}
      <div class="row">
        {!state.running
          ? <button class="btn primary" onClick={start}>Start training games</button>
          : <button class="btn" onClick={stop}>Stop</button>}
        {state.unsaved > 0 && <button class="btn" onClick={download}>Download {state.unsaved} games</button>}
      </div>
      {store.writable && !state.running && (
        <div class="row">
          <button class="btn" onClick={exportDb} disabled={!!clearing && !/^(Done|Stopped|No training)/.test(clearing)}>Download & clear games saved in the app</button>
        </div>
      )}
      <label class="field">Split a large training file (over 30 MB) into parts you can attach
        <input type="file" accept=".json,application/json" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; void splitFile(f); (e.target as HTMLInputElement).value = ''; }} />
      </label>
      {clearing && <p class="note">{clearing}</p>}
      {(state.running || state.games > 0) && (
        <table><tbody>
          <tr><td>Cores working</td><td class="num">{state.cores}</td></tr>
          <tr><td>Games finished</td><td class="num">{state.games}{state.running && mins > 1 ? ` (${(state.games / mins * 60).toFixed(0)}/hour)` : ''}</td></tr>
          <tr><td>Positions</td><td class="num">{state.positions.toLocaleString()}</td></tr>
          <tr><td>Saved to the app database</td><td class="num">{state.saved} games</td></tr>
          {toFile && <tr><td>Waiting to download</td><td class="num">{state.unsaved} games</td></tr>}
        </tbody></table>
      )}
      {state.error && <div class="err">{state.error}</div>}
    </div>
  );
}
