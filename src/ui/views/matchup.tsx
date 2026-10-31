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
 * "Help train the AI": this computer plays searching-AI games against itself on every spare core. Every
 * ~4,000 games (about 20 MB, small enough to attach in chat) it offers them as a file for Claude to train on.
 */
const PART_GAMES = 4000;
type Batch = { rows: number[][]; games: number; inputs: number };

async function saveFile(name: string, data: string) {
  const dl = await (window as any).claude?.use?.('downloads');
  if (dl) { await dl.save({ filename: name, data }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = name;
  a.click();
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function TrainPanel() {
  const st = useStore();
  const runner = useRef<SelfplayRunner | null>(null);
  const kept = useRef<Batch>({ rows: [], games: 0, inputs: 0 });
  const offering = useRef(false);
  const [s, setS] = useState({ running: false, games: 0, cores: 0, started: 0, waiting: 0, files: 0, msg: '' });
  const bump = (patch: Partial<typeof s>) => setS((x) => ({ ...x, ...patch }));

  // Offer what has built up as one file; on a decline the games stay here for "Download now".
  const offer = async () => {
    if (offering.current || !kept.current.games) return;
    offering.current = true;
    const k = kept.current;
    kept.current = { rows: [], games: 0, inputs: k.inputs };
    try {
      await saveFile(`shenron-training-${stamp()}-${k.games}games.json`, JSON.stringify({ v: 2, inputs: k.inputs, games: k.games, rows: k.rows }));
      setS((x) => ({ ...x, files: x.files + 1, waiting: kept.current.games, msg: '' }));
    } catch (e: any) {
      kept.current = { rows: [...k.rows, ...kept.current.rows], games: k.games + kept.current.games, inputs: k.inputs };
      bump({ waiting: kept.current.games, msg: 'Download not saved. The games are kept: press "Download now" when ready.' });
    } finally {
      offering.current = false;
    }
  };

  const start = () => {
    const decks = st.meta.filter((d) => !d.name.startsWith('Starter') && !validateDeck(d, st.cards, st.rules).length).map((d) => ({ name: d.name, leader: d.leader, main: d.main }));
    const r = new SelfplayRunner(st.cards, decks, (b) => {
      const k = kept.current;
      k.rows.push(...b.rows); k.games += b.games; k.inputs = b.inputs;
      setS((x) => ({ ...x, games: x.games + b.games, waiting: k.games }));
      if (k.games >= PART_GAMES) void offer();
    }, (e) => bump({ msg: e.slice(0, 300) }));
    runner.current = r;
    r.start();
    bump({ running: true, cores: r.size, started: Date.now(), msg: '' });
  };
  const stop = () => { runner.current?.stop(); bump({ running: false }); };

  const hours = s.started ? (Date.now() - s.started) / 3600000 : 0;
  return (
    <div class="panel stack">
      <h2>Help train the AI</h2>
      <p class="note">Your computer plays the AI against itself with the meta decks, on every core but one. Every {PART_GAMES.toLocaleString()} games it offers a file (about 20 MB): accept it, then attach the files to Claude. Keep this tab open and the computer awake.</p>
      <div class="row">
        {!s.running ? <button class="btn primary" onClick={start}>Start training games</button> : <button class="btn" onClick={stop}>Stop</button>}
        {s.waiting > 0 && <button class="btn" onClick={() => void offer()}>Download now ({s.waiting.toLocaleString()} games)</button>}
      </div>
      {(s.running || s.games > 0) && (
        <table><tbody>
          <tr><td>Cores working</td><td class="num">{s.cores}</td></tr>
          <tr><td>Games played</td><td class="num">{s.games.toLocaleString()}{s.running && hours > 0.02 ? ` (${Math.round(s.games / hours).toLocaleString()}/hour)` : ''}</td></tr>
          <tr><td>Files saved</td><td class="num">{s.files}</td></tr>
          <tr><td>Waiting for the next file</td><td class="num">{s.waiting.toLocaleString()} games</td></tr>
        </tbody></table>
      )}
      {s.waiting > 0 && !s.running && <p class="note">Download these before closing the tab, or they're lost.</p>}
      {s.msg && <div class="err">{s.msg}</div>}
      <OlderTraining />
    </div>
  );
}

/** Tools for training data from before the file workflow: games still in the app database, and files too big to attach. */
function OlderTraining() {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<string>) => {
    setBusy(true);
    try { setMsg(await job()); } catch (e: any) { setMsg(`Stopped (${String(e?.code ?? e?.message ?? e)}). Run it again to continue.`); } finally { setBusy(false); }
  };
  // Database: ~400 batches per file; a batch is deleted only after its file was saved. A declined part ends the run.
  const clearDb = () => run(async () => {
    let part = 1, total = 0;
    for (;;) {
      const batch = await store.readSelfplay(400);
      if (!batch.length) break;
      const rows = batch.flatMap((x) => x.rows), games = batch.reduce((a, x) => a + x.games, 0);
      setMsg(`Part ${part}: ${games.toLocaleString()} games. Accept the download to clear them from the app.`);
      await saveFile(`shenron-training-db-${stamp()}-part${part}-${games}games.json`, JSON.stringify({ v: 2, inputs: batch[0].inputs, games, rows }));
      await store.deleteSelfplay(batch.map((x) => x.id));
      total += games; part++;
    }
    return total ? `Done: ${total.toLocaleString()} games saved and cleared from the app.` : 'No training games left in the app database.';
  });
  // Big file: split on game boundaries (a game's rows share its seed) into parts under 25 MB; declined parts are skipped.
  const split = (file: File) => run(async () => {
    const j = JSON.parse(await file.text());
    const rows: number[][] = j.rows ?? [];
    if (!rows.length) return `${file.name} has no training rows.`;
    const parts = Math.max(1, Math.ceil(JSON.stringify(rows).length / 24e6));
    const seedCol = (j.inputs ?? rows[0].length - 4) + 2, per = Math.ceil(rows.length / parts);
    const saved: number[] = [], skipped: number[] = [];
    for (let p = 1, start = 0; start < rows.length; p++) {
      let end = Math.min(rows.length, start + per);
      while (end < rows.length && rows[end][seedCol] === rows[end - 1][seedCol]) end++;
      const chunk = rows.slice(start, end), games = new Set(chunk.map((r) => r[seedCol])).size;
      setMsg(`Part ${p} of ${parts}: ${games.toLocaleString()} games. Accept (or decline to skip).`);
      try { await saveFile(`${file.name.replace(/\.json$/i, '')}-part${p}of${parts}.json`, JSON.stringify({ v: j.v ?? 2, inputs: j.inputs, games, rows: chunk })); saved.push(p); } catch { skipped.push(p); }
      start = end;
    }
    return `Saved part${saved.length === 1 ? '' : 's'} ${saved.join(', ') || 'none'}${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}.`;
  });
  return (
    <details class="note">
      <summary>Older training data</summary>
      <div class="stack" style={{ marginTop: '8px' }}>
        {store.writable && <div class="row"><button class="btn small" disabled={busy} onClick={clearDb}>Download & clear games saved in the app database</button></div>}
        <label class="field">Split a training file over 30 MB into parts you can attach
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void split(f); (e.target as HTMLInputElement).value = ''; }} />
        </label>
        {msg && <p>{msg}</p>}
      </div>
    </details>
  );
}
