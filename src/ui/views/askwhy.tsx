import { useEffect, useMemo, useState } from 'preact/hooks';
import { Card, Decklist } from '../../data/types';
import { RulesConfig } from '../../data/rules';
import { Validated } from '../../builder/counter';
import { cardEvidence, explainPrompt } from '../../builder/explain';
import { Sampler } from '../translate';
import { pct } from '../components';
import { WatchGame } from './replay';

interface QA { id: string; q: string; a: string; stats: string }

/**
 * "Why is this card here?": gathers the run's evidence for one card and asks
 * Claude to explain it from that evidence only, with the numbers alongside.
 */
export function AskWhy({ best, target, baseline, cards, rules }: { best: Validated; target: Decklist; baseline?: Validated | null; cards: Record<string, Card>; rules?: RulesConfig }) {
  const [sample, setSample] = useState<Sampler | null | undefined>(undefined);
  const ids = useMemo(() => Object.keys(best.deck.main).sort((x, y) => (cards[x]?.cost ?? 0) - (cards[y]?.cost ?? 0) || (cards[x]?.name ?? x).localeCompare(cards[y]?.name ?? y)), [best, cards]);
  const [id, setId] = useState(ids[0] ?? '');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<QA[]>([]);
  const [err, setErr] = useState('');
  const [watch, setWatch] = useState<{ id: string; n: number } | null>(null);

  useEffect(() => {
    let live = true;
    const claude = (window as any).claude;
    if (!claude?.use) { setSample(null); return; }
    claude.use('sample').then((s: Sampler | null) => { if (live) setSample(() => s); }, () => live && setSample(null));
    return () => { live = false; };
  }, []);

  const ev = useMemo(() => (id ? cardEvidence(cards, best, id, target, baseline) : null), [id, best, target, baseline, cards]);
  const statLine = ev ? `${ev.card.copies}× · played or comboed in ${ev.stats.gamesWhereItWasPlayedOrComboed} of ${ev.stats.validationGames} games${ev.stats.winRateWhenPlayed !== null ? ` · won ${pct(ev.stats.winRateWhenPlayed, 0)} of those (deck overall ${pct(ev.stats.deckWinRate, 0)})` : ''}` : '';

  async function ask() {
    if (!sample || !ev) return;
    setBusy(true); setErr('');
    try {
      const r = await sample(explainPrompt(ev, q.trim()), { modelTier: 'complex', cache: false });
      setLog([{ id, q: q.trim() || `Why ${ev.card.name}?`, a: r.text.trim(), stats: statLine }, ...log]);
      setQ('');
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setBusy(false);
  }

  return (
    <div class="panel stack">
      <h3 style={{ margin: 0 }}>Ask why a card is here</h3>
      <p class="note" style={{ margin: 0 }}>The search doesn't reason about cards; it keeps what wins. So answers come from this run's evidence: how often the card was played, what happened in those games, when it entered the list, and what it works with. If the numbers can't tell it apart from noise, the answer says so.</p>
      <div class="row">
        <label class="field" style={{ flex: '1 1 220px' }}>Card
          <select value={id} onChange={(e) => { setId((e.target as HTMLSelectElement).value); setWatch(null); }}>
            {ids.map((k) => <option key={k} value={k}>{best.deck.main[k]}× {cards[k]?.name ?? k} ({k}) · cost {cards[k]?.cost}</option>)}
          </select>
        </label>
        <label class="field" style={{ flex: '2 1 260px' }}>Your question (optional)
          <input type="text" value={q} placeholder={ev ? `Why ${ev.card.copies} ${ev.card.name}?` : ''} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') ask(); }} />
        </label>
      </div>
      {ev && <div class="note">{statLine}. {ev.stats.verdict[0].toUpperCase() + ev.stats.verdict.slice(1)}.</div>}
      <div class="row">
        <button class="btn primary" onClick={ask} disabled={!sample || busy || !ev}>{busy ? 'Thinking…' : 'Ask'}</button>
        <button class="btn" onClick={() => setWatch({ id, n: (watch?.n ?? 0) + 1 })} disabled={!id}>Watch a game where it was played</button>
      </div>
      {sample === undefined && <p class="note">Connecting to Claude…</p>}
      {sample === null && <p class="note warn">Claude isn't available in this view, so questions can't be answered here. The numbers above still apply.</p>}
      {err && <p class="err">{err}</p>}
      {log.map((x, k) => (
        <div key={k} class="vcap" style={{ background: 'var(--panel-2)' }}>
          <div><b>{x.q}</b> <span class="mono note">{x.id}</span></div>
          <div class="note">{x.stats}</div>
          <div style={{ whiteSpace: 'pre-line' }}>{x.a}</div>
        </div>
      ))}
      {watch && <WatchGame key={`${watch.id}-${watch.n}`} a={best.deck} b={target} cards={cards} rules={rules} labels={['Counter wins', 'Target wins']} mustPlay={watch.id} auto />}
    </div>
  );
}
