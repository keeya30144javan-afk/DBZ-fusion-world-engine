import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Card, Decklist } from '../../data/types';
import { parseDecklist, validateDeck } from '../../data/decks';
import { compileCard } from '../../effects/parse';
import { describeCompiled } from '../../effects/describe';
import { textHash } from '../../effects/script';
import { PlayClient } from '../../workers/pool';
import { ActionOption, ChoiceOption, Decision, PlayLevel, PlayView } from '../../play/host';
import { store } from '../store';
import { Board } from './replay';
import { ColorTag, DeckSelect, Seg, fmtPower, leaderLabel, safeStorage, useStore } from '../components';

const [loadPaste, savePaste] = safeStorage<string>('shenron.playPaste', '');

interface Flag { atMove: number; turn: number; aiMove: string; note: string }

/**
 * Play a game against the AI. Every game is saved (with the notes you flag)
 * so Claude can replay it move by move and see where the AI went wrong.
 */
export function PlayTab() {
  const st = useStore();
  const [youId, setYouId] = useState(st.meta[4]?.id ?? st.meta[0]?.id ?? '');
  const [aiId, setAiId] = useState(st.meta[5]?.id ?? st.meta[0]?.id ?? '');
  const [mode, setMode] = useState<'meta' | 'paste'>(loadPaste() ? 'paste' : 'meta');
  const [paste, setPaste0] = useState(loadPaste());
  const setPaste = (v: string) => { setPaste0(v); savePaste(v); };
  const [level, setLevel] = useState<PlayLevel>('quick');
  const [first, setFirst] = useState<'random' | 'you' | 'ai'>('random');

  const [client, setClient] = useState<PlayClient | null>(null);
  const [view, setView] = useState<PlayView | null>(null);
  const [names, setNames] = useState<[string, string]>(['', '']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [inspect, setInspect] = useState<string | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [flagText, setFlagText] = useState('');
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState<'' | 'saving' | 'saved' | 'failed' | 'offline'>('');
  const docId = useRef<string | null>(null);
  const meta = useRef<{ you: Decklist; ai: Decklist; level: PlayLevel; seed: number } | null>(null);

  const you = useMemo((): { deck?: Decklist; errors: string[] } => {
    if (mode === 'meta') {
      const d = st.meta.find((m) => m.id === youId);
      return d ? { deck: d, errors: validateDeck(d, st.cards, st.rules) } : { errors: ['Pick your deck'] };
    }
    if (!paste.trim()) return { errors: ['Paste your decklist'] };
    const { deck, errors } = parseDecklist(paste, st.cards, 'Your deck');
    return { deck, errors: [...errors, ...validateDeck(deck, st.cards, st.rules)] };
  }, [mode, youId, paste, st.meta, st.cards, st.rules]);
  const ai = st.meta.find((m) => m.id === aiId);

  useEffect(() => () => client?.close(), [client]);

  async function save(v: PlayView | null, fl: Flag[], nt: string, c = client) {
    if (!c || !meta.current) return;
    if (!store.writable) { setSaved('offline'); return; }
    setSaved('saving');
    try {
      const r = await c.record();
      const id = await store.savePlayGame(docId.current, {
        version: r.version, ...(r.undos ? { undos: r.undos } : {}), you: names[0] || r.you.name, ai: names[1] || r.ai.name, youDeck: r.you, aiDeck: r.ai, level: r.level, seed: r.seed, first: r.first,
        winner: r.winner, reason: r.reason, turns: r.turns, finished: !!v?.over, flags: fl, notes: nt, trace: JSON.stringify(r.trace),
      });
      docId.current = id;
      setSaved('saved');
    } catch (e: any) {
      setSaved('failed');
      setErr(`Could not save the game: ${e?.message ?? e}`);
    }
  }

  /** Show a view, then let the AI move (one move at a time so the board updates) until it's your decision. */
  async function settle(v: PlayView, c = client) {
    setView(v);
    if (!c) return;
    let guard = 0;
    while (!v.over && !v.decision && guard++ < 400) {
      setBusy(true);
      const before = v.moves;
      v = await c.aiStep();
      setView(v);
      if (v.moves === before && !v.decision) break;
    }
    setBusy(false);
    if (v.over) await save(v, flags, notes, c);
  }

  async function start() {
    if (!you.deck || !ai) return;
    setErr(''); setFlags([]); setNotes(''); setSaved(''); docId.current = null;
    client?.close();
    const c = new PlayClient(st.cards);
    setClient(c);
    const seed = Math.floor(Math.random() * 2 ** 30);
    meta.current = { you: you.deck, ai, level, seed };
    setNames([you.deck.name, ai.name]);
    try {
      setBusy(true);
      const v = await c.start({ you: you.deck, ai, level, seed, youFirst: first === 'random' ? null : first === 'you', rules: st.rules });
      await settle(v, c);
    } catch (e: any) {
      setBusy(false);
      setErr(String(e?.message ?? e));
    }
  }

  async function act(o: ActionOption) {
    if (!client || busy) return;
    setBusy(true);
    try { await settle(await client.act(o.i)); } catch (e: any) { setBusy(false); setErr(String(e?.message ?? e)); }
  }
  async function answer(picks: number[]) {
    if (!client || busy) return;
    setBusy(true);
    try { await settle(await client.answer(picks)); } catch (e: any) { setBusy(false); setErr(String(e?.message ?? e)); }
  }
  async function undo() {
    if (!client || busy) return;
    setBusy(true);
    try { const v = await client.undo(); setView(v); setBusy(false); } catch (e: any) { setBusy(false); setErr(String(e?.message ?? e)); }
  }
  async function addFlag() {
    if (!view || !flagText.trim()) return;
    const f: Flag = { atMove: view.moves, turn: view.turn, aiMove: view.aiMoves[view.aiMoves.length - 1] ?? '', note: flagText.trim() };
    const next = [...flags, f];
    setFlags(next);
    setFlagText('');
    await save(view, next, notes);
  }
  function quit() {
    if (view && !view.over) void save(view, flags, notes);
    client?.close();
    setClient(null);
    setView(null);
  }

  const nm = (id: string) => st.cards[id]?.name ?? id;

  if (!view) {
    return (
      <div class="split">
        <div class="stack">
          <p class="intro">Play a game against the AI. Every game you play is saved with any notes you flag, so Claude can replay it move by move and fix what the AI got wrong. Click any card to see its printed text and how the engine reads it.</p>
          <div class="panel raised stack">
            <div class="row" style={{ justifyContent: 'space-between' }}>
              <b>Your deck</b>
              <Seg label="Your deck source" options={[['meta', 'Saved deck'], ['paste', 'Paste a list']]} value={mode} onChange={setMode} />
            </div>
            {mode === 'meta'
              ? <DeckSelect id="play-you" value={youId} onChange={setYouId} decks={st.meta} cards={st.cards} />
              : <textarea aria-label="Your decklist" value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} placeholder={'One card per line, include the Leader:\n1 FS02-01\n4 FS02-05\n...'} />}
            {mode === 'paste' && you.deck?.leader && st.cards[you.deck.leader] && <div class="note">Leader: <b>{leaderLabel(st.cards, you.deck.leader)}</b> <ColorTag card={st.cards[you.deck.leader]} /></div>}
            <label class="field"><b>AI's deck</b><DeckSelect id="play-ai" value={aiId} onChange={setAiId} decks={st.meta} cards={st.cards} /></label>
            <label class="field">AI strength<Seg label="AI strength" options={[['quick', 'Search'], ['strong', 'Strong'], ['deep', 'Deep']]} value={level} onChange={setLevel} /></label>
            <label class="field">Who goes first<Seg label="Who goes first" options={[['random', 'Random'], ['you', 'You'], ['ai', 'AI']]} value={first} onChange={setFirst} /></label>
            {you.errors.length > 0 && <div class="err">{you.errors.slice(0, 3).map((e) => <div key={e}>{e}</div>)}</div>}
            <div class="row"><button class="btn primary" onClick={start} disabled={busy || you.errors.length > 0 || !ai}>{busy ? 'Setting up…' : 'Start game'}</button></div>
            <p class="note">Search thinks for about a second a move, Strong a few seconds, Deep longer. {store.writable ? 'Games save to this app for Claude to study.' : 'Saving is off in this view, so games won’t be kept.'}</p>
            {err && <p class="err">{err}</p>}
          </div>
        </div>
        <div class="stack">
          <div class="panel">
            <div class="eyebrow">How it works</div>
            <ul class="note" style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
              <li>You are the bottom board. Your moves appear as buttons, grouped by kind.</li>
              <li>When a skill asks you to choose (targets, discards, a mode), pick the cards and confirm.</li>
              <li>See a strange AI move? Use <b>Flag the AI's last move</b> and say what a good player would have done.</li>
              <li>See a card play differently from its text? Click it and use <b>Report</b>.</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  const s = view.snap;
  const card = inspect ? st.cards[inspect] : null;
  const result = view.over ? (view.over.winner === 0 ? 'You win!' : view.over.winner === 1 ? 'The AI wins.' : 'Draw.') : '';

  return (
    <div class="stack">
      <div class="panel raised stack">
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div class="eyebrow">You vs AI · {meta.current?.level === 'quick' ? 'Search' : meta.current?.level === 'strong' ? 'Strong' : 'Deep'} AI · turn {s.turn}</div>
            <h3 style={{ margin: '2px 0 0' }}>{names[0]} <span class="note">vs</span> {names[1]}</h3>
            {view.over && <div><b>{result}</b> <span class="note">({view.over.reason})</span></div>}
          </div>
          <div class="row" style={{ gap: '6px' }}>
            <span class="note" aria-live="polite">{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved for Claude' : saved === 'failed' ? 'Save failed' : saved === 'offline' ? 'Saving off' : ''}</span>
            {!view.over && <button class="btn" onClick={undo} disabled={busy || !view.canUndo} title="Take back your last move (and the AI's reply to it)">↶ Undo</button>}
            {!view.over && <button class="btn" onClick={() => save(view, flags, notes)}>Save now</button>}
            <button class="btn" onClick={quit}>{view.over ? 'New game' : 'Quit'}</button>
          </div>
        </div>
        {err && <p class="err">{err}</p>}
      </div>

      <div class="vgrid">
        <div class="stack" style={{ gap: '10px' }}>
          <Board nm={nm} side={s.p[1]} who="AI" name={names[1]} active={s.active === 1} snapBattle={s.battle} sideIdx={1} onPick={setInspect} hiddenHand={view.aiHand} />
          {s.battle && <div class="panel note">Battle: <b>{nm(s.battle.attacker)}</b> ({fmtPower(s.battle.atkPower)}) attacks <b>{nm(s.battle.target)}</b> ({fmtPower(s.battle.defPower)})</div>}
          <Board nm={nm} side={s.p[0]} who="You" name={names[0]} active={s.active === 0} snapBattle={s.battle} sideIdx={0} onPick={setInspect} />
          <div class="panel stack" aria-live="polite">
            {busy && <div class="note"><b>The AI is thinking…</b></div>}
            {!busy && view.decision && <DecisionPanel d={view.decision} onAct={act} onAnswer={answer} nm={nm} onPick={setInspect} stage={s.stage} />}
            {view.over && <div><b>{result}</b> {saved === 'saved' ? 'The game is saved for Claude. Add any last notes on the right.' : saved === 'saving' ? 'Saving…' : 'Saving is off in this view, so this game was not kept.'}</div>}
          </div>
        </div>
        <div class="stack" style={{ gap: '10px' }}>
          {card && <CardPanel card={card} reading={st.reviews?.[card.id]} />}
          <div class="panel stack">
            <div class="eyebrow">AI's recent moves</div>
            {view.aiMoves.length ? <ol class="note" style={{ margin: 0, paddingLeft: '18px' }}>{view.aiMoves.map((m, k) => <li key={k}>{m}</li>)}</ol> : <span class="note">None yet.</span>}
            <textarea aria-label="What should the AI have done?" value={flagText} onInput={(e) => setFlagText((e.target as HTMLTextAreaElement).value)} placeholder="What was wrong with the AI's last move, and what would a good player do?" style={{ minHeight: '60px' }} />
            <div class="row"><button class="btn" onClick={addFlag} disabled={!flagText.trim()}>Flag the AI's last move</button>{flags.length > 0 && <span class="note">{flags.length} flagged</span>}</div>
          </div>
          <div class="panel stack">
            <div class="eyebrow">Notes on this game</div>
            <textarea aria-label="Notes on this game" value={notes} onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)} onBlur={() => save(view, flags, notes)} placeholder="Anything else Claude should know (saved when you click away)" style={{ minHeight: '50px' }} />
          </div>
          <div class="panel">
            <div class="eyebrow">Game log</div>
            <div class="vlist mono" style={{ maxHeight: '260px', fontSize: '12px' }}>{view.log.slice(-40).map((l, k) => <div key={k}>{l.replace(/\bP0\b/g, 'You').replace(/\bP1\b/g, 'AI')}</div>)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DecisionPanel({ d, onAct, onAnswer, nm, onPick, stage }: { d: Decision; onAct: (o: ActionOption) => void; onAnswer: (p: number[]) => void; nm: (id: string) => string; onPick: (id: string) => void; stage: string }) {
  const [sel, setSel] = useState<number[]>([]);
  useEffect(() => setSel([]), [d]);
  if (d.kind === 'action') {
    const groups = new Map<string, ActionOption[]>();
    for (const o of d.options) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);
    return (
      <div class="stack" style={{ gap: '8px' }}>
        <div class="eyebrow">Your move · {STAGE[stage] ?? stage}</div>
        {d.battle && <BattleMath b={d.battle} />}
        {[...groups].map(([g, os]) => (
          <div key={g} class="stack" style={{ gap: '4px' }}>
            <span class="note">{g}</span>
            <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
              {os.map((o) => <button key={o.i} class={`btn${o.group === 'End' ? ' primary' : ''}`} title={o.detail ?? ''} onClick={() => onAct(o)}>{cap(o.label)}{o.detail ? <span class="note" style={{ display: 'block', fontWeight: 'normal', maxWidth: '340px' }}>{o.detail}</span> : null}</button>)}
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (d.options.length === 1 && d.options[0].label === 'Yes' && d.max === 1) {
    return (
      <div class="stack" style={{ gap: '6px' }}>
        <div class="eyebrow">{d.prompt}</div>
        {d.detail && <div class="note">{d.detail}</div>}
        <div class="row"><button class="btn primary" onClick={() => onAnswer([1])}>Yes</button><button class="btn" onClick={() => onAnswer([])}>No</button></div>
      </div>
    );
  }
  const toggle = (o: ChoiceOption) => setSel(sel.includes(o.v) ? sel.filter((x) => x !== o.v) : d.max === 1 ? [o.v] : sel.length < d.max ? [...sel, o.v] : sel);
  const ok = sel.length >= Math.min(d.min, d.options.length) && sel.length <= d.max;
  return (
    <div class="stack" style={{ gap: '6px' }}>
      <div class="eyebrow">{d.prompt}</div>
      {d.detail && <div class="note">{d.detail}</div>}
      <div class="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
        {d.options.map((o) => (
          <button key={o.v} class={`btn${sel.includes(o.v) ? ' primary' : ''}`} aria-pressed={sel.includes(o.v)} onClick={() => { toggle(o); if (o.id) onPick(o.id); }}>
            {o.id ? nm(o.id) : o.label}{o.where ? <span class="note" style={{ display: 'block', fontWeight: 'normal' }}>{o.where}</span> : null}
          </button>
        ))}
      </div>
      <div class="row">
        <button class="btn primary" onClick={() => onAnswer(sel)} disabled={!ok}>Confirm{d.max > 1 ? ` (${sel.length})` : ''}</button>
        {d.min === 0 && <button class="btn" onClick={() => onAnswer([])}>Choose none</button>}
      </div>
    </div>
  );
}

function CardPanel({ card, reading }: { card: Card; reading?: { status?: string } }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { setOpen(false); setNote(''); setMsg(''); }, [card.id]);
  const engine = useMemo(() => { try { return describeCompiled(compileCard(card)); } catch (e: any) { return `(could not read: ${e?.message ?? e})`; } }, [card.id]);
  async function report() {
    try { await store.reportCard(card.id, note.trim(), textHash(card)); setMsg('Reported. Claude will check this card.'); setOpen(false); setNote(''); } catch (e: any) { setMsg(String(e?.message ?? e)); }
  }
  return (
    <div class="panel stack" style={{ gap: '6px' }}>
      <div class="row" style={{ justifyContent: 'space-between' }}><b>{card.name}</b><span class="mono">{card.id}</span></div>
      <div class="note">{card.type} · cost {card.cost}{card.power ? ` · ${fmtPower(card.power)} power` : ''}{card.comboPower ? ` · combo +${fmtPower(card.comboPower)}` : ''} · {card.colors.join('/')}{card.traits.length ? ` · ${card.traits.join(', ')}` : ''}</div>
      <div class="eyebrow">Printed text</div>
      <div class="audit-text">{card.text || '(no skill)'}{card.back ? `\n— Awakened: ${card.back.name} (${fmtPower(card.back.power)}) —\n${card.back.text}` : ''}</div>
      <div class="eyebrow">How the engine plays it{reading?.status === 'verified' ? ' · verified by you' : ''}</div>
      <div class="audit-text">{engine}</div>
      {!open ? <div class="row"><button class="btn" onClick={() => setOpen(true)}>Report a problem with this card</button>{msg && <span class="note">{msg}</span>}</div> : (
        <div class="stack" style={{ gap: '6px' }}>
          <textarea aria-label="What is wrong with this card?" value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} placeholder="What's wrong: the printed text, or how the engine plays it?" style={{ minHeight: '60px' }} />
          <div class="row"><button class="btn primary" onClick={report} disabled={!note.trim()}>Send report</button><button class="btn" onClick={() => setOpen(false)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

/** "You attack 25k into 20k: you win the battle (ties go to the attacker)". */
function BattleMath({ b }: { b: { atk: number; def: number; youAttack: boolean } }) {
  const atkWins = b.atk >= b.def;
  const you = b.youAttack ? 'Your attack' : 'Their attack';
  const youWin = b.youAttack ? atkWins : !atkWins;
  // Combo power comes in 5000 steps.
  const need = Math.ceil((b.youAttack ? b.def - b.atk : b.atk - b.def + 1) / 5000) * 5000;
  return (
    <div class={`note ${youWin ? '' : 'warn'}`} style={{ padding: '6px 8px', border: '1px solid var(--line, #ccd)', borderRadius: '6px' }}>
      {you}: <b>{fmtPower(b.atk)}</b> vs defence <b>{fmtPower(b.def)}</b>.{' '}
      {youWin ? <b>You win this battle as it stands{b.youAttack ? ' (ties go to the attacker)' : ''}: no combo needed.</b> : <b>You need {fmtPower(need)} more to win this battle{b.youAttack ? '' : ' (ties go to the attacker)'}.</b>}
    </div>
  );
}

const STAGE: Record<string, string> = { mulligan: 'opening hand', charge: 'charge phase', main: 'main phase', counter: 'counter step', block: 'block step', offCombo: 'your combo (attacking)', defCombo: 'your combo (defending)' };
/** "plays X" (the log's voice) becomes "Play X" for a button. */
const VERB: Record<string, string> = {
  keeps: 'Keep', redraws: 'Redraw', charges: 'Charge', plays: 'Play', evolves: 'Evolve', uses: 'Use', awakens: 'Awaken', attacks: 'Attack',
  ends: 'End', counters: 'Counter with', blocks: 'Block', combos: 'Combo', stops: 'Stop',
};
const cap = (t: string) => {
  if (t.startsWith('does not ')) return "Don't " + t.slice(9);
  if (t.startsWith('counters with ')) return 'Counter with ' + t.slice(14);
  const [w, ...rest] = t.split(' ');
  return VERB[w] ? [VERB[w], ...rest].join(' ') : t.charAt(0).toUpperCase() + t.slice(1);
};
