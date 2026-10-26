import { useEffect, useState } from 'preact/hooks';
import { Card, Decklist } from '../data/types';
import { store, MetaDeck } from './store';
import { WorkerPool } from '../workers/pool';

export function useStore() {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((x) => x + 1)), []);
  return store.state;
}

let pool: WorkerPool | null = null;
let poolCards: Record<string, Card> | null = null;
export function getPool(cards: Record<string, Card>): WorkerPool {
  pool ??= new WorkerPool();
  if (poolCards !== cards) { pool.setCards(cards); poolCards = cards; }
  return pool;
}

export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
export const fmtPower = (n: number) => n.toLocaleString('en-US');

export function ColorTag({ card }: { card?: Card }) {
  if (!card) return null;
  return <>{card.colors.map((c) => <span key={c} class={`tag c-${c}`}>{c}</span>)}</>;
}

export function Meter({ value, accent }: { value: number; accent?: boolean }) {
  return <div class={`meter${accent ? ' accent' : ''}`} role="img" aria-label={pct(value, 0)}><i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}

/** Win rate with its confidence range on a 0-100% track, plus the user's bar. */
export function CIBar({ rate, lo, hi, bar, height = 46 }: { rate: number; lo: number; hi: number; bar?: number; height?: number }) {
  const W = 600, pad = 14, x = (v: number) => pad + v * (W - 2 * pad);
  return (
    <div class="ci">
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`Win rate ${pct(rate)}, range ${pct(lo)} to ${pct(hi)}`}>
        <rect class="track" x={pad} y={10} width={W - 2 * pad} height={12} rx={6} />
        <rect class="band" x={x(lo)} y={10} width={Math.max(2, x(hi) - x(lo))} height={12} rx={6} />
        <circle class="pt" cx={x(rate)} cy={16} r={6} />
        {bar !== undefined && <line class="bar" x1={x(bar)} x2={x(bar)} y1={4} y2={28} />}
        {bar !== undefined && <text class="barlbl" x={x(bar)} y={height - 2} text-anchor="middle">bar {pct(bar, 0)}</text>}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => Math.abs(t - (bar ?? -1)) > 0.06 && (
          <text key={t} class="lbl" x={x(t)} y={height - 2} text-anchor={t === 0 ? 'start' : t === 1 ? 'end' : 'middle'}>{pct(t, 0)}</text>
        ))}
      </svg>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const [fallback, setFallback] = useState(false);
  const click = () => {
    navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }, () => setFallback(true));
    if (!navigator.clipboard) setFallback(true);
  };
  return (
    <>
      <button class="btn small" onClick={click}>{done ? 'Copied' : label}</button>
      {fallback && <textarea readOnly value={text} onFocus={(e) => (e.target as HTMLTextAreaElement).select()} aria-label="Text to copy" />}
    </>
  );
}

export function DeckSelect({ id, value, onChange, decks, cards, allowNone }: { id: string; value: string; onChange: (v: string) => void; decks: MetaDeck[]; cards: Record<string, Card>; allowNone?: string }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {allowNone && <option value="">{allowNone}</option>}
      {decks.map((d) => <option key={d.id} value={d.id}>{d.name}{d.example ? ' (example)' : ''} · {cards[d.leader]?.name ?? d.leader}</option>)}
    </select>
  );
}

export function Seg<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export const deckSizeOf = (d: Decklist) => Object.values(d.main).reduce((a, b) => a + b, 0);

export function safeStorage<T>(key: string, fallback: T): [() => T, (v: T) => void] {
  return [
    () => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; } },
    (v: T) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  ];
}
