import { useState } from 'preact/hooks';
import { deckToText, parseDecklist, validateDeck } from '../../data/decks';
import { MatchJob, MatchResult, emptyResult, mergeResults, score } from '../../builder/evaluate';
import { store, MetaDeck } from '../store';
import { ColorTag, CopyButton, Meter, deckSizeOf, getPool, leaderLabel, pct, useStore } from '../components';

export function MetaView() {
  const st = useStore();
  const [editing, setEditing] = useState<MetaDeck | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [share, setShare] = useState(10);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [matrix, setMatrix] = useState<{ names: string[]; cells: (MatchResult | null)[][] } | null>(null);
  const [gauntletRunning, setGauntletRunning] = useState(false);

  const totalShare = st.meta.reduce((a, d) => a + (d.share ?? 0), 0) || 1;
  const startEdit = (d: MetaDeck | null) => {
    setEditing(d ?? { id: '', name: '', leader: '', main: {} });
    setText(d ? deckToText(d, st.cards) : '');
    setName(d?.name ?? '');
    setShare(Math.round((d?.share ?? 0.1) * 100));
    setMsg(null);
  };
  const parsed = editing ? parseDecklist(text, st.cards, name || 'New deck') : null;
  const problems = parsed ? [...parsed.errors, ...validateDeck(parsed.deck, st.cards, st.rules)] : [];

  async function save() {
    if (!editing || !parsed) return;
    setBusy(true);
    try {
      await store.saveDeck({ ...parsed.deck, id: editing.id, name: name || parsed.deck.name, share: share / 100 });
      setEditing(null);
    } catch (e: any) {
      setMsg(String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  async function gauntlet() {
    const decks = st.meta.filter((d) => !validateDeck(d, st.cards, st.rules).length).slice(0, 10);
    if (decks.length < 2) return;
    setGauntletRunning(true);
    const games = 40;
    const jobs: MatchJob[] = [];
    const map: [number, number][] = [];
    decks.forEach((a, i) => decks.forEach((b, j) => {
      if (i >= j) return;
      for (let g = 0; g < games; g += 10) {
        jobs.push({ a, b, seeds: Array.from({ length: 10 }, (_, k) => 7000 + i * 977 + j * 131 + g + k), level: 'fast' });
        map.push([i, j]);
      }
    }));
    const results = await getPool(st.cards).run(jobs);
    const cells: (MatchResult | null)[][] = decks.map(() => decks.map(() => null));
    results.forEach((r, k) => {
      const [i, j] = map[k];
      cells[i][j] = mergeResults(cells[i][j] ?? emptyResult(), r);
    });
    // Mirror the lower triangle from the other side's point of view.
    decks.forEach((_, i) => decks.forEach((_, j) => {
      if (i > j && cells[j][i]) { const r = cells[j][i]!; cells[i][j] = { ...r, wins: r.losses, losses: r.wins }; }
    }));
    setMatrix({ names: decks.map((d) => d.name), cells });
    setGauntletRunning(false);
  }

  return (
    <div class="stack">
      <p class="intro">The decks people are playing right now. Each list's <strong>share</strong> is how much of the field it makes up. The Scouter uses it to guess which list an opponent is on, and the counter search uses these lists as the baseline to beat.</p>
      {st.meta.some((d) => d.example) && <p class="note warn">Showing example starter-deck lists until you add real meta decks. Saving any deck copies these into your saved meta so you can edit or delete them.</p>}
      <div class="panel raised">
        <div class="row" style={{ justifyContent: 'space-between', marginBottom: '8px' }}>
          <h2 style={{ margin: 0 }}>Meta decks</h2>
          <div class="row">
            <button class="btn" onClick={gauntlet} disabled={gauntletRunning || st.meta.length < 2}>{gauntletRunning ? 'Playing…' : 'Run matchup table'}</button>
            <button class="btn" onClick={() => startEdit(null)} disabled={!store.writable}>Add deck</button>
          </div>
        </div>
        {!store.writable && <p class="note">Saving decks needs the shared database, which isn't available in this view. You can still paste lists on the Counter tab.</p>}
        <div class="scroll"><table>
          <thead><tr><th>Deck</th><th>Leader</th><th class="num">Cards</th><th class="num">Share</th><th></th><th></th></tr></thead>
          <tbody>
            {st.meta.map((d) => {
              const errs = validateDeck(d, st.cards, st.rules);
              return (
                <tr key={d.id}>
                  <td><span class="cardname">{d.name}</span>{d.example && <> <span class="tag">example</span></>}{errs.length > 0 && <div class="err">{errs[0]}</div>}</td>
                  <td>{leaderLabel(st.cards, d.leader)} <ColorTag card={st.cards[d.leader]} /></td>
                  <td class="num">{deckSizeOf(d)}</td>
                  <td class="num">{pct((d.share ?? 0) / totalShare, 0)}</td>
                  <td style={{ width: '18%' }}><Meter value={(d.share ?? 0) / totalShare} /></td>
                  <td class="row" style={{ gap: '6px', justifyContent: 'flex-end' }}>
                    <CopyButton text={deckToText(d, st.cards)} label="Copy" />
                    <button class="btn small" onClick={() => startEdit(d)} disabled={!store.writable}>Edit</button>
                    {!d.example && <button class="btn small danger" onClick={() => store.deleteDeck(d.id)}>Delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>

      {editing && (
        <div class="panel raised stack">
          <h2>{editing.id ? 'Edit deck' : 'Add a deck'}</h2>
          <div class="grid2">
            <label class="field">Name<input id="deck-name" type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="e.g. Blue Vegeta tempo" /></label>
            <label class="field">Share of the meta: {share}%<input id="deck-share" type="range" min={1} max={60} value={share} onInput={(e) => setShare(+(e.target as HTMLInputElement).value)} /></label>
          </div>
          <label class="field">Decklist <span class="hint">Leader plus 50-60 cards. "4 FB01-012", "4x FB01-012" and "FB01-012 x4" all work.</span>
            <textarea id="deck-text" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          </label>
          {parsed && <div class="note">{parsed.deck.leader ? `Leader: ${leaderLabel(st.cards, parsed.deck.leader)}` : 'No leader yet'} · {deckSizeOf(parsed.deck)} cards</div>}
          {problems.length > 0 && <div class="err">{problems.slice(0, 6).map((p) => <div key={p}>{p}</div>)}</div>}
          {msg && <div class="err">{msg}</div>}
          <div class="row">
            <button class="btn primary" onClick={save} disabled={busy || problems.length > 0}>Save deck</button>
            <button class="btn" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {matrix && (
        <div class="panel">
          <h2>Matchup table</h2>
          <p class="note">Row deck's win rate against the column deck, 40 games each with the fast AI. Use it to spot what beats what, then confirm with the Counter or Matchup tabs.</p>
          <div class="scroll"><table class="heat">
            <thead><tr><th></th>{matrix.names.map((n) => <th key={n} class="num">{n.replace(/^Starter: /, '')}</th>)}</tr></thead>
            <tbody>{matrix.names.map((n, i) => (
              <tr key={n}><th>{n.replace(/^Starter: /, '')}</th>{matrix.cells[i].map((c, j) => {
                if (!c) return <td key={j} class="cell">-</td>;
                const p = score(c) / c.games;
                const bg = p >= 0.5 ? `color-mix(in srgb, var(--good) ${Math.round((p - 0.5) * 160)}%, transparent)` : `color-mix(in srgb, var(--bad) ${Math.round((0.5 - p) * 160)}%, transparent)`;
                return <td key={j} class="cell" style={{ background: bg }}>{pct(p, 0)}</td>;
              })}</tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
