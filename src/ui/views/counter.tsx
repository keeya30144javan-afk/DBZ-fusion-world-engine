import { WatchGame } from './replay';
import { AskWhy } from './askwhy';
import { useMemo, useRef, useState } from 'preact/hooks';
import { Decklist } from '../../data/types';
import { deckToText, parseDecklist, validateDeck } from '../../data/decks';
import { CounterReport, Effort, Progress, findCounter } from '../../builder/counter';
import { Level } from '../../builder/evaluate';
import { store } from '../store';
import { CIBar, ColorTag, CopyButton, DeckSelect, Meter, leaderLabel, Seg, getPool, pct, safeStorage, useStore } from '../components';

type RunRecord = { report: CounterReport; target: string; targetDeck?: Decklist; at: string; threshold: number };
const [loadLast, saveLast] = safeStorage<RunRecord | null>('shenron.lastCounter', null);

const VERDICT_LABEL = { recommend: 'Counter found', inconclusive: 'Promising, not proven', none: 'No reliable counter' };

export function CounterLab() {
  const st = useStore();
  const [mode, setMode] = useState<'meta' | 'paste'>('meta');
  const [targetId, setTargetId] = useState(() => [...st.meta].filter((d) => !d.name.startsWith('Starter')).sort((x, y) => (y.share ?? 0) - (x.share ?? 0))[0]?.id ?? st.meta[0]?.id ?? '');
  const [paste, setPaste] = useState('');
  const [effort, setEffort] = useState<Effort>('test');
  const [threshold, setThreshold] = useState(55);
  const [confidence, setConfidence] = useState('0.95');
  const [level, setLevel] = useState<Level>('quick');
  const [leaderMode, setLeaderMode] = useState<'all' | 'pick'>('all');
  const [leaders, setLeaders] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState(loadLast());
  const cancel = useRef(false);

  const allLeaders = useMemo(() => Object.values(st.cards).filter((c) => c.type === 'LEADER').sort((a, b) => a.name.localeCompare(b.name)), [st.cards]);

  const target: { deck: Decklist | null; errors: string[] } = useMemo(() => {
    if (mode === 'meta') {
      const d = st.meta.find((m) => m.id === targetId) ?? st.meta[0];
      return { deck: d ?? null, errors: d ? validateDeck(d, st.cards, st.rules) : ['Add a deck on the Meta tab first'] };
    }
    if (!paste.trim()) return { deck: null, errors: [] };
    const { deck, errors } = parseDecklist(paste, st.cards, 'Pasted deck');
    return { deck, errors: [...errors, ...validateDeck(deck, st.cards, st.rules)] };
  }, [mode, targetId, paste, st.meta, st.cards, st.rules]);

  async function run() {
    if (!target.deck) return;
    setRunning(true); setError(null); setLog([]); cancel.current = false;
    const pool = getPool(st.cards);
    try {
      const report = await findCounter(
        st.cards,
        {
          targets: [{ deck: target.deck, weight: 1 }],
          known: st.meta.filter((m) => !validateDeck(m, st.cards, st.rules).length),
          leaders: leaderMode === 'pick' ? leaders : undefined,
          threshold: threshold / 100,
          confidence: +confidence,
          effort,
          validateLevel: level,
          seed: Date.now() % 100000,
          rules: st.rules,
        },
        (jobs, onEach) => pool.run(jobs, onEach),
        (p) => { setProgress(p); setLog((l) => (l[l.length - 1] === p.message ? l : [...l.slice(-60), p.message])); },
        () => cancel.current,
      );
      const rec = { report, target: target.deck.name, targetDeck: target.deck, at: new Date().toLocaleString(), threshold: threshold / 100 };
      setLast(rec);
      saveLast(rec);
    } catch (e: any) {
      if (!cancel.current) setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  const overall = progress?.phase === 'done' ? 1 : progress?.overall ?? 0;

  return (
    <div class="split">
      <div class="stack">
        <p class="intro">Pick the deck everyone is playing. Shenron builds candidate decks, plays thousands of games against it, then re-tests the best ones on fresh games with the searching AI on both sides. It only recommends a deck that clears your bar with confidence. <strong>Otherwise it says there is no reliable counter.</strong></p>
        <div class="panel raised stack">
          <h2>Target deck</h2>
          <Seg label="Target source" options={[['meta', 'From meta'], ['paste', 'Paste a list']]} value={mode} onChange={setMode} />
          {mode === 'meta' ? (
            <label class="field">Deck to beat
              <DeckSelect id="target" value={targetId} onChange={setTargetId} decks={st.meta} cards={st.cards} />
            </label>
          ) : (
            <label class="field">Decklist <span class="hint">One card per line, e.g. "4 FB01-012". Include the leader.</span>
              <textarea id="paste" value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} placeholder={'1 FS02-01\n4 FS02-05\n4 FS02-06\n...'} />
            </label>
          )}
          {target.deck?.leader && st.cards[target.deck.leader] && <div class="note">Target leader: <b>{leaderLabel(st.cards, target.deck.leader)}</b> <ColorTag card={st.cards[target.deck.leader]} /></div>}
          {target.errors.length > 0 && <div class="err">{target.errors.slice(0, 4).map((e) => <div key={e}>{e}</div>)}</div>}
        </div>

        <div class="panel stack">
          <h2>How sure do you need to be?</h2>
          <label class="field">Minimum win rate: {threshold}%
            <span class="hint">A recommendation must beat the target at least this often.</span>
            <input id="threshold" type="range" min={50} max={75} step={1} value={threshold} onInput={(e) => setThreshold(+(e.target as HTMLInputElement).value)} />
          </label>
          <label class="field">Confidence
            <Seg label="Confidence" options={[['0.8', '80%'], ['0.9', '90%'], ['0.95', '95%'], ['0.99', '99%']]} value={confidence} onChange={setConfidence} />
          </label>
          <label class="field">Effort <span class="hint">More effort means more decks tried and more games played. "Test" caps validation at 100 games per deck: fast, but the win-rate range is wider.</span>
            <Seg label="Effort" options={[['test', 'Test'], ['quick', 'Quick'], ['standard', 'Standard'], ['thorough', 'Thorough']]} value={effort} onChange={setEffort} />
          </label>
          <label class="field">Test-game AI <span class="hint">"Search" thinks ahead on every move. "Fast" is quicker but easier to exploit.</span>
            <Seg label="AI level" options={[['fast', 'Fast'], ['quick', 'Search'], ['strong', 'Strong search']]} value={level} onChange={setLevel} />
          </label>
          <label class="field">Counter leaders
            <Seg label="Leaders" options={[['all', 'Any leader'], ['pick', 'Choose']]} value={leaderMode} onChange={setLeaderMode} />
          </label>
          {leaderMode === 'pick' && (
            <div class="stack" style={{ gap: '4px', maxHeight: '180px', overflow: 'auto' }}>
              {allLeaders.map((l) => (
                <label key={l.id} class="row" style={{ gap: '8px', fontSize: '13px' }}>
                  <input type="checkbox" id={`leader-${l.id}`} checked={leaders.includes(l.id)} onChange={(e) => setLeaders((x) => ((e.target as HTMLInputElement).checked ? [...x, l.id] : x.filter((y) => y !== l.id)))} />
                  <span>{l.name}</span> <ColorTag card={l} /> <span class="mono">{l.id}</span>
                </label>
              ))}
            </div>
          )}
          <div class="row">
            {!running ? (
              <button class="btn primary" onClick={run} disabled={!target.deck || target.errors.length > 0 || (leaderMode === 'pick' && !leaders.length)}>Find a counter</button>
            ) : (
              <button class="btn" onClick={() => { cancel.current = true; }}>Stop after this step</button>
            )}
          </div>
        </div>
      </div>

      <div class="stack">
        {(running || (progress && progress.phase !== 'done')) && (
          <div class="panel raised progress" aria-live="polite">
            <div class="eyebrow">{PHASE_LABEL[progress?.phase ?? 'seed']} · {(progress?.gamesPlayed ?? 0).toLocaleString()} games played · {pct(overall, 0)} done{progress?.eta !== undefined ? ` · about ${fmtEta(progress.eta)} left` : ''}</div>
            <Meter value={overall} accent />
            {progress?.step && progress.step.total > 1 && (
              <div class="row" style={{ gap: '10px', fontSize: '12px' }}>
                <span style={{ minWidth: '9em' }}>{progress.step.label}</span>
                <span style={{ flex: 1 }}><Meter value={progress.step.done / progress.step.total} /></span>
                <span class="mono">{progress.step.done.toLocaleString()} / {progress.step.total.toLocaleString()}</span>
              </div>
            )}
            <div class="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>
          </div>
        )}
        {running && progress?.best && <BestSoFar best={progress.best} />}
        {error && <div class="panel err">The search stopped: {error}</div>}
        {last ? <Report rec={last} /> : !running && (
          <div class="empty">No search yet. Choose a target deck and press <b>Find a counter</b>. Results show here with the evidence behind them.</div>
        )}
      </div>
    </div>
  );
}

/** Card ids of unreviewed translations used by any deck in the result (entries are "ID Name"). */
const unreviewedIds = (r: CounterReport) => [...new Set(r.coverage.flatMap((c) => (c.unreviewed ?? []).map((x) => x.split(' ')[0])))];

const PHASE_LABEL: Record<Progress['phase'], string> = { seed: 'Testing starting decks', evolve: 'Evolving decks', validate: 'Validating finalists', done: 'Done' };

function fmtEta(sec: number): string {
  if (sec < 90) return `${Math.max(5, Math.round(sec / 5) * 5)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/** The deck the search currently likes best, shown while it runs. */
function BestSoFar({ best }: { best: NonNullable<Progress['best']> }) {
  const st = useStore();
  const text = deckToText(best.deck, st.cards);
  return (
    <div class="panel stack">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div class="eyebrow">{best.validated ? 'Best validated so far' : best.searched ? 'Best so far (checked with the searching AI, not yet validated)' : 'Best so far (screening, not yet validated)'}</div>
          <h2 style={{ margin: 0 }}>{best.deck.name}</h2>
          <div class="note">{leaderLabel(st.cards, best.deck.leader)} <ColorTag card={st.cards[best.deck.leader]} /> · {best.validated ? `${pct(best.rate, 0)} over ${best.games.toLocaleString()} validation games` : best.searched ? `estimated ${pct(best.rate, 0)} (${best.games.toLocaleString()} searching-AI games)` : `estimated ${pct(best.rate, 0)} from fast-AI screening`}</div>
        </div>
        <CopyButton text={text} label="Copy list" />
      </div>
      <div class="decklist">{text}</div>
      {!best.validated && <p class="note">An estimate while the search runs. The final verdict comes from fresh games with the stronger AI on both sides.</p>}
    </div>
  );
}

function Report({ rec }: { rec: RunRecord }) {
  const st = useStore();
  const r = rec.report;
  const best = r.best;
  return (
    <div class="stack">
      <div class={`verdict ${r.verdict}`}>
        <span class="pill">{VERDICT_LABEL[r.verdict]}</span>
        <p class="head">{r.headline}</p>
        {r.reasons.length > 0 && <ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
        {unreviewedIds(r).length > 0 && (
          <div class="row"><button class="btn small" onClick={() => store.focusAudit(unreviewedIds(r))}>Review these {unreviewedIds(r).length} cards</button></div>
        )}
        <div class="note">Target: {rec.target} · {r.gamesPlayed.toLocaleString()} games in {(r.ms / 1000).toFixed(0)}s · {rec.at}</div>
      </div>

      {best && (
        <div class="panel raised stack">
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <div class="eyebrow">{r.verdict === 'recommend' ? 'Recommended deck' : 'Best attempt'}</div>
              <h2 style={{ margin: 0 }}>{best.deck.name}</h2>
              <div class="note">{leaderLabel(st.cards, best.deck.leader)} <ColorTag card={st.cards[best.deck.leader]} /> · {best.origin}</div>
            </div>
            <div class="big">{pct(best.rate)} <small>win rate</small></div>
          </div>
          <CIBar rate={best.rate} lo={best.lo} hi={best.hi} bar={rec.threshold} />
          <p class="note">The shaded range is where the true win rate most likely sits, from {best.games} games the search had never seen.</p>
          <div class="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>Decklist</h3>
            <CopyButton text={deckToText(best.deck, st.cards)} label="Copy list" />
          </div>
          <div class="decklist">{deckToText(best.deck, st.cards)}</div>
        </div>
      )}

      {best && rec.targetDeck && (
        <div class="row" style={{ gap: '6px' }}>
          <button class="btn primary" onClick={() => store.requestPlay(best.deck, rec.targetDeck)}>Play the counter yourself</button>
          <button class="btn" onClick={() => store.requestPlay(rec.targetDeck, best.deck)}>Play against the counter</button>
        </div>
      )}
      {best && rec.targetDeck && (
        <WatchGame key={deckToText(best.deck, st.cards)} a={best.deck} b={rec.targetDeck} cards={st.cards} rules={st.rules} labels={['Counter wins', 'Target wins']} />
      )}

      {best && rec.targetDeck && <AskWhy key={deckToText(best.deck, st.cards)} best={best} target={rec.targetDeck} baseline={r.baseline} cards={st.cards} rules={st.rules} />}

      {best && (
        <div class="grid2">
          <div class="panel">
            <h3>Why it wins</h3>
            {r.keyCards.length ? (
              <div class="scroll"><table>
                <thead><tr><th>Card</th><th class="num">Used in</th><th class="num">Win when used</th></tr></thead>
                <tbody>{r.keyCards.slice(0, 8).map((k) => (
                  <tr key={k.id}><td><span class="cardname">{k.name}</span> <span class="mono">{k.id}</span></td><td class="num">{k.played}</td><td class="num">{pct(k.winWhenPlayed, 0)} <span class="note">({k.lift >= 0 ? '+' : ''}{(k.lift * 100).toFixed(0)})</span></td></tr>
                ))}</tbody>
              </table></div>
            ) : <p class="note">Not enough games per card to single any out.</p>}
          </div>
          <div class="panel">
            <h3>How the games ended</h3>
            <table><tbody>
              {Object.entries(best.result.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                <tr key={k}><td>{k}</td><td class="num">{v}</td><td style={{ width: '40%' }}><Meter value={v / best.result.games} /></td></tr>
              ))}
              <tr><td>Average game length</td><td class="num">{(best.result.turns / Math.max(1, best.result.games)).toFixed(1)}</td><td class="note">turns</td></tr>
              <tr><td>Win rate going first</td><td class="num">{pct(best.result.firstWins / Math.max(1, best.result.firstGames), 0)}</td><td class="note">{best.result.firstGames} games</td></tr>
            </tbody></table>
          </div>
        </div>
      )}

      {(r.baseline || r.alternatives.length > 0) && (
        <div class="panel">
          <h3>Compared with</h3>
          <div class="scroll"><table>
            <thead><tr><th>Deck</th><th class="num">Win rate</th><th class="num">Range</th><th class="num">Games</th></tr></thead>
            <tbody>
              {[...(best ? [best] : []), ...r.alternatives, ...(r.baseline && (!best || r.baseline.deck !== best.deck) ? [r.baseline] : [])].map((v, i) => (
                <tr key={i}><td>{v.deck.name}{v === r.baseline ? ' (baseline: play the known deck)' : ''}</td><td class="num">{pct(v.rate)}</td><td class="num">{pct(v.lo, 0)}-{pct(v.hi, 0)}</td><td class="num">{v.games}</td></tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      <div class="panel">
        <h3>What the engine understood</h3>
        <table><tbody>
          {r.coverage.map((c) => (
            <tr key={c.deck}><td>{c.deck}</td><td class="num">{pct(c.coverage, 0)}</td><td style={{ width: '35%' }}><Meter value={c.coverage} /></td></tr>
          ))}
        </tbody></table>
        <p class="note">Share of card text the simulator can play exactly. Anything below 100% is approximated, and results get less precise.</p>
      </div>
    </div>
  );
}
