import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Card } from '../../data/types';
import { CardSnap, Frame, Replay, SideSnap } from '../../builder/replay';
import { Decklist } from '../../data/types';
import { RulesConfig } from '../../data/rules';
import { Level } from '../../builder/evaluate';
import { recordReplay } from '../../workers/pool';
import { Seg, fmtPower, pct } from '../components';

/**
 * Step through a recorded game: both boards after every move, what the move
 * did, and (for the searching AI) the options it weighed.
 */
export function GameViewer({ replay, cards, onClose }: { replay: Replay; cards: Record<string, Card>; onClose?: () => void }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(900);
  const [inspect, setInspect] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const n = replay.frames.length;
  const f = replay.frames[Math.min(i, n - 1)];
  const label = (p: 0 | 1) => (p === 0 ? 'A' : 'B');

  useEffect(() => {
    if (!playing) return;
    if (i >= n - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI(i + 1), speed);
    return () => clearTimeout(t);
  }, [playing, i, speed, n]);

  useEffect(() => {
    // Scroll only the move list, never the page (scrollIntoView would pull the page back to the
    // viewer on every move and stop the reader from scrolling away while it plays).
    const list = listRef.current, row = list?.querySelector('[aria-current="step"]') as HTMLElement | null;
    if (list && row) {
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
  }, [i]);

  // Turn starts, for the jump list.
  const turns = useMemo(() => {
    const out: { turn: number; idx: number; active: 0 | 1 }[] = [];
    replay.frames.forEach((fr, k) => { if (!out.length || out[out.length - 1].turn !== fr.turn) out.push({ turn: fr.turn, idx: k, active: fr.actor === -1 ? fr.snap.active : (fr.actor as 0 | 1) }); });
    return out;
  }, [replay]);

  const go = (k: number) => { setPlaying(false); setI(Math.max(0, Math.min(n - 1, k))); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
  };

  const nm = (id: string) => cards[id]?.name ?? id;
  const result = replay.winner === -1 ? 'Draw' : `${label(replay.winner as 0 | 1)} wins: ${replay.names[replay.winner]}`;
  const card = inspect ? cards[inspect] : null;

  return (
    <div class="panel raised stack viewer" tabIndex={0} onKeyDown={onKey as any} aria-label="Game viewer">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div class="eyebrow">Game viewer · seed {replay.seed} · {label(replay.first)} goes first</div>
          <h3 style={{ margin: '2px 0 0' }}>A: {replay.names[0]} <span class="note">vs</span> B: {replay.names[1]}</h3>
          <div class="note">{result} ({replay.reason}) on turn {replay.turns} · AI: A {aiName(replay.levels[0])}, B {aiName(replay.levels[1])}</div>
        </div>
        {onClose && <button class="btn" onClick={onClose}>Close</button>}
      </div>

      <div class="vctl row">
        <button class="btn" onClick={() => go(0)} aria-label="First move">⏮</button>
        <button class="btn" onClick={() => go(i - 1)} aria-label="Previous move">◀</button>
        <button class="btn primary" onClick={() => { if (i >= n - 1) setI(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '⏸ Pause' : '▶ Play'}</button>
        <button class="btn" onClick={() => go(i + 1)} aria-label="Next move">▶</button>
        <button class="btn" onClick={() => go(n - 1)} aria-label="Last move">⏭</button>
        <input type="range" min={0} max={n - 1} value={i} onInput={(e) => go(+(e.target as HTMLInputElement).value)} aria-label="Move" style={{ flex: 1, minWidth: '120px' }} />
        <span class="mono">{i + 1}/{n}</span>
        <select value={String(speed)} onChange={(e) => setSpeed(+(e.target as HTMLSelectElement).value)} aria-label="Speed" style={{ width: 'auto' }}>
          <option value="1600">Slow</option><option value="900">Normal</option><option value="350">Fast</option>
        </select>
      </div>

      <div class="vgrid">
        <div class="stack" style={{ gap: '10px' }}>
          <Board nm={nm} side={f.snap.p[1]} who="B" name={replay.names[1]} active={f.snap.active === 1} snapBattle={f.snap.battle} sideIdx={1} onPick={setInspect} cards={cards} />
          <Caption f={f} label={label} nm={nm} />
          <Board nm={nm} side={f.snap.p[0]} who="A" name={replay.names[0]} active={f.snap.active === 0} snapBattle={f.snap.battle} sideIdx={0} onPick={setInspect} cards={cards} />
        </div>
        <div class="stack" style={{ gap: '10px' }}>
          {f.options && (
            <div class="panel">
              <div class="eyebrow">{f.options[0]?.line ? `Turn plans ${label(f.actor as 0 | 1)}'s AI compared` : `What ${label(f.actor as 0 | 1)}'s AI weighed`}</div>
              <table class="vopts"><tbody>
                {f.options.map((o) => (
                  <tr key={o.label} class={o.chosen ? 'chosen' : ''}>
                    <td>{o.chosen ? '▸ ' : ''}{o.label}</td>
                    <td class="num">{pct(o.value, 0)}</td>
                  </tr>
                ))}
              </tbody></table>
              <p class="note" style={{ margin: '6px 0 0' }}>{f.options[0]?.line
                ? "Whole lines of play for this turn, each scored by the chance to win after the opponent's reply, in several imagined deals of their hidden cards. It plays the first step of the best line, then plans again."
                : `Estimated chance to win after each move, from ${f.options.reduce((a, o) => a + o.visits, 0)} imagined continuations. The opponent's hidden cards are guessed, not peeked at.`}</p>
            </div>
          )}
          {card && (
            <div class="panel">
              <div class="row" style={{ justifyContent: 'space-between' }}><b>{card.name}</b><span class="mono">{card.id}</span></div>
              <div class="note">{card.type} · cost {card.cost}{card.power ? ` · ${fmtPower(card.power)} power` : ''}{card.comboPower ? ` · combo +${fmtPower(card.comboPower)}` : ''}</div>
              <div class="audit-text" style={{ marginTop: '6px' }}>{card.text || '(no skill)'}{card.back ? `\n— Awakened: ${card.back.name} —\n${card.back.text}` : ''}</div>
            </div>
          )}
          <div class="panel">
            <div class="eyebrow">Moves</div>
            <div class="row" style={{ gap: '4px', margin: '6px 0' }}>
              {turns.map((t) => <button key={t.idx} class={`tag vturn${f.turn === t.turn ? ' on' : ''}`} onClick={() => go(t.idx)}>T{t.turn}{t.turn ? ` ${label(t.active)}` : ''}</button>)}
            </div>
            <div class="vlist" ref={listRef}>
              {replay.frames.map((fr, k) => (
                <button key={k} class="vmove" aria-current={k === i ? 'step' : undefined} onClick={() => go(k)}>
                  <span class="mono">T{fr.turn}</span> {fr.actor === -1 ? '' : <b>{label(fr.actor)}</b>} {fr.move}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <p class="note" style={{ margin: 0 }}>Both hands are shown because you're watching as a spectator; each AI only sees its own. Click a card for its text. Keys: ← → step, space plays.</p>
    </div>
  );
}

const aiName = (l: string) => (l === 'fast' ? 'fast' : l === 'quick' ? 'search' : l);

function Caption({ f, label, nm }: { f: Frame; label: (p: 0 | 1) => string; nm: (id: string) => string }) {
  const lines = f.lines.map((l) => l.replace(/^T\d+ /, '').replace(/\bP0\b/g, 'A').replace(/\bP1\b/g, 'B'));
  const b = f.snap.battle;
  return (
    <div class="vcap" aria-live="polite">
      <div><b>{f.actor === -1 ? 'Start' : `${label(f.actor)}`}</b> {f.move}</div>
      {lines.length > 0 && <div class="mono note">{lines.join(' · ')}</div>}
      {b && <div class="note">Battle: {label(b.atk)}'s {nm(b.attacker)} ({fmtPower(b.atkPower)}) attacks {nm(b.target)} ({fmtPower(b.defPower)})</div>}
    </div>
  );
}

/** A card's printed text (both sides of a Leader), for tooltips and the text-on-board view. */
export const cardText = (c?: Card, leader?: boolean, awakened?: boolean) =>
  !c ? '' : leader && c.back ? (awakened ? `${c.back.text}` : `${c.text}\n— Awakened (${fmtPower(c.back.power)}): ${c.back.text}`) : c.text || '(no skill)';

export function Board({ nm, side, who, name, active, snapBattle, sideIdx, onPick, hiddenHand, cards, showText }: { nm: (id: string) => string; side: SideSnap; who: string; name: string; active: boolean; snapBattle: Frame['snap']['battle']; sideIdx: 0 | 1; onPick: (id: string) => void; hiddenHand?: number; cards?: Record<string, Card>; showText?: boolean }) {
  const inBattle = (c: CardSnap) => !!snapBattle && (c.id === snapBattle.attacker && snapBattle.atk === sideIdx || c.id === snapBattle.target && snapBattle.atk !== sideIdx);
  return (
    <div class={`vboard${active ? ' active' : ''}`}>
      <div class="row" style={{ justifyContent: 'space-between', gap: '6px' }}>
        <span class="eyebrow">{who} · {name}{active ? ' · to move' : ''}</span>
        <span class="row" style={{ gap: '6px' }}>
          <span class="chip" title="Life">♥ <b>{side.life}</b></span>
          <span class="chip" title="Ki on the Leader">Ki <b>{side.leader.ki ?? 0}</b></span>
          <span class="chip" title="Energy: active / rested">⚡ <b>{side.energy.active}</b>/{side.energy.active + side.energy.rested}</span>
          {side.markers > 0 && <span class="chip" title="Energy marker: pays 1 energy once, then it's removed">Marker <b>{side.markers}</b></span>}
          <span class="chip" title="Deck">Deck <b>{side.deck}</b></span>
          <span class="chip" title="Drop">Drop <b>{side.drop.length}</b></span>
        </span>
      </div>
      <div class="vzone">
        <Slot c={side.leader} leader awakened={side.awakened} hot={inBattle(side.leader)} onPick={onPick} card={cards?.[side.leader.id]} showText={showText} />
        {side.battle.length ? side.battle.map((c, k) => <Slot key={k} c={c} hot={inBattle(c)} onPick={onPick} card={cards?.[c.id]} showText={showText} />) : <span class="note">(no Battle Cards)</span>}
      </div>
      {side.combo.length > 0 && <div class="note">Combo: {side.combo.map((id, k) => <button key={k} class="tag vlink" onClick={() => onPick(id)}>{nm(id)}</button>)}</div>}
      <div class="vhand">
        {hiddenHand !== undefined
          ? <span class="note">Hand: {hiddenHand} card{hiddenHand === 1 ? '' : 's'} (hidden)</span>
          : <><span class="note">Hand ({side.hand.length}):</span>
            {showText && cards
              ? <div class="vzone" style={{ width: '100%' }}>{side.hand.map((id, k) => <HandCard key={k} card={cards[id]} onPick={onPick} />)}</div>
              : side.hand.map((id, k) => <button key={k} class="tag vlink" title={cards ? cardText(cards[id]) : undefined} onClick={() => onPick(id)}>{nm(id)}</button>)}</>}
      </div>
      {side.drop.length > 0 && <div class="note">Drop: {side.drop.slice(-8).map((id, k) => <button key={k} class="tag vlink" onClick={() => onPick(id)}>{nm(id)}</button>)}{side.drop.length > 8 ? ` +${side.drop.length - 8} more` : ''}</div>}
    </div>
  );
}

function HandCard({ card, onPick }: { card?: Card; onPick: (id: string) => void }) {
  if (!card) return null;
  return (
    <button class="vcard vhandcard" onClick={() => onPick(card.id)}>
      <span class="vname">{card.name}</span>
      <span class="vmeta">cost {card.cost}{card.power ? ` · ${fmtPower(card.power)}` : ''}{card.comboPower ? ` · combo +${fmtPower(card.comboPower)}` : ''}</span>
      <span class="vtext">{cardText(card)}</span>
    </button>
  );
}

function Slot({ c, leader, awakened, hot, onPick, card, showText }: { c: CardSnap; leader?: boolean; awakened?: boolean; hot?: boolean; onPick: (id: string) => void; card?: Card; showText?: boolean }) {
  const text = cardText(card, leader, awakened);
  return (
    <button class={`vcard${leader ? ' leader' : ''}${c.rested ? ' rested' : ''}${hot ? ' hot' : ''}${showText ? ' withtext' : ''}`} onClick={() => onPick(c.id)} title={text ? `${c.rested ? 'Rest Mode' : 'Active Mode'}\n${text}` : c.rested ? 'Rest Mode' : 'Active Mode'}>
      {c.rested && <span class="vrest">Rest Mode</span>}
      {(leader || !!c.ki) && <span class="vki" title="Ki on this card">Ki {c.ki ?? 0}</span>}
      <span class="vname">{c.name}</span>
      <span class="vpow">{fmtPower(c.power)}</span>
      <span class="vmeta">{leader ? (awakened ? 'Leader · awakened' : 'Leader') : c.id}{c.under ? ` · ${c.under} under` : ''}</span>
      {c.tags && c.tags.length > 0 && <span class="vmeta" style={{ fontWeight: 600 }}>{c.tags.join(' · ')}</span>}
      {showText && text && <span class="vtext">{text}</span>}
    </button>
  );
}

/**
 * "Watch a game" controls plus the viewer: pick who should win and which AI plays,
 * then record a game on its own worker.
 */
export function WatchGame({ a, b, cards, rules, level: initialLevel = 'quick', labels, mustPlay, auto }: { a: Decklist; b: Decklist; cards: Record<string, Card>; rules?: RulesConfig; level?: Level; labels?: [string, string]; mustPlay?: string; auto?: boolean }) {
  const [want, setWant] = useState<'any' | 'win' | 'loss'>('any');
  const [level, setLevel] = useState<Level>(initialLevel === 'fast' ? 'fast' : 'quick');
  const [busy, setBusy] = useState<null | (() => void)>(null);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [err, setErr] = useState('');
  const [nA, nB] = labels ?? ['A wins', 'B wins'];

  async function watch() {
    setErr('');
    const seed = Math.floor(Math.random() * 1_000_000);
    const job = recordReplay(cards, { decks: [a, b], levels: [level, level], seed, want, tries: level === 'fast' ? 12 : 6, rules, mustPlay });
    setBusy(() => job.cancel);
    try {
      const r = await job.done;
      setReplay(r);
      const missed = (want !== 'any' && (want === 'win' ? r.winner !== 0 : r.winner !== 1)) || (mustPlay && !r.played[0].includes(mustPlay));
      if (missed) setErr(`No game went that way in ${level === 'fast' ? 12 : 6} tries, so here is the last one.`);
    } catch (e: any) {
      if (e?.message !== 'cancelled') setErr(String(e?.message ?? e));
    }
    setBusy(null);
  }

  useEffect(() => { if (auto) watch(); }, []);

  return (
    <div class="stack">
      <div class="panel stack">
        <div class="eyebrow">Watch a game{mustPlay ? ` where ${cards[mustPlay]?.name ?? mustPlay} was played` : ''}</div>
        <div class="row">
          <Seg label="Outcome" options={[['any', 'Any game'], ['win', nA], ['loss', nB]]} value={want} onChange={setWant} />
          <Seg label="AI" options={[['quick', 'Search AI'], ['fast', 'Fast AI']]} value={level} onChange={(v) => setLevel(v as Level)} />
          {busy
            ? <button class="btn" onClick={() => { busy(); setBusy(null); }}>Stop</button>
            : <button class="btn primary" onClick={watch}>Watch a game</button>}
        </div>
        {busy && <p class="note" aria-live="polite">Playing a game{want !== 'any' ? ' (and more if needed to find that outcome)' : ''}… {level === 'fast' ? 'a moment' : 'the search AI takes several seconds to a minute'}.</p>}
        {!busy && <p class="note" style={{ margin: 0 }}>The search AI is what validation uses, and its moves come with the options it weighed. The fast AI is instant but plays more simply.</p>}
        {err && <p class="note warn">{err}</p>}
      </div>
      {replay && <GameViewer replay={replay} cards={cards} onClose={() => setReplay(null)} />}
    </div>
  );
}
