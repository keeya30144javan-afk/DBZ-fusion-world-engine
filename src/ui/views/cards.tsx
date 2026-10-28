import { useMemo, useState } from 'preact/hooks';
import { compileCard } from '../../effects/parse';
import { RULE_NOTES, RulesConfig } from '../../data/rules';
import { store } from '../store';
import { ColorTag, Meter, fmtPower, pct, useStore } from '../components';

export function CardsView() {
  const st = useStore();
  const [q, setQ0] = useState('');
  const [limit, setLimit] = useState(40);
  const setQ = (v: string) => { setQ0(v); setLimit(40); };
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const all = useMemo(() => Object.values(st.cards).map((c) => ({ c, cc: compileCard(c) })), [st.cards]);
  const coverage = all.length ? all.reduce((a, x) => a + x.cc.coverage, 0) / all.length : 1;
  const gaps = all.filter((x) => x.cc.coverage < 1).length;
  const shown = all
    .filter((x) => !onlyGaps || x.cc.coverage < 1)
    .filter((x) => { const k = q.trim().toLowerCase(); return !k || x.c.name.toLowerCase().includes(k) || x.c.id.toLowerCase().includes(k) || x.c.text.toLowerCase().includes(k); })
    .sort((a, b) => a.c.id.localeCompare(b.c.id))
    .slice(0, limit);

  async function doImport(text: string, source: string) {
    setBusy(true); setImportMsg(null);
    try {
      const pages = text.trim().startsWith('[') || text.trim().startsWith('{') ? [text] : text.split(/\n(?=\s*[\[{])/);
      const rows: any[] = [];
      for (const p of pages) {
        const j = JSON.parse(p);
        rows.push(...(Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.cards) ? j.cards : j.cards ? Object.values(j.cards) : []));
      }
      if (!rows.length) throw new Error('No cards found. Expected a JSON list of cards, or an object with a "data" or "cards" list.');
      const r = await store.importCards(rows, source);
      setImportMsg(`Imported ${r.cards} cards across ${r.sets} set${r.sets === 1 ? '' : 's'}.`);
      setImportText('');
    } catch (e: any) {
      setImportMsg(`Import failed: ${e?.message ?? e}`);
    } finally { setBusy(false); }
  }

  const onFile = async (e: Event) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files?.length) return;
    const texts = await Promise.all(Array.from(files).map((f) => f.text()));
    await doImport(texts.join('\n'), files[0].name);
  };

  const setRule = <K extends keyof RulesConfig>(k: K, v: RulesConfig[K]) => store.saveRules({ ...st.rules, [k]: v });

  return (
    <div class="stack">
      <p class="intro">Every card the engine knows, and how much of each card's text it can actually play. When a new set comes out, import its card list here and every tab picks it up.</p>
      <div class="grid2">
        <div class="panel raised">
          <div class="eyebrow">Card database</div>
          <div class="big">{all.length.toLocaleString()} <small>cards</small></div>
          <div class="row" style={{ marginTop: '10px' }}><span style={{ flex: 1 }}><Meter value={coverage} /></span><span class="mono">{pct(coverage, 1)} of text understood</span></div>
          <p class="note">{gaps} card{gaps === 1 ? '' : 's'} with text the engine approximates.</p>
          <div class="scroll"><table>
            <thead><tr><th>Set</th><th class="num">Cards</th><th>Source</th></tr></thead>
            <tbody>{st.sets.map((s) => <tr key={s.set}><td class="mono">{s.set}</td><td class="num">{s.count}</td><td class="note">{s.source}{s.from === 'database' ? ' · saved' : ' · built in'}</td></tr>)}</tbody>
          </table></div>
        </div>

        <div class="panel stack">
          <h2>Add a new set</h2>
          <p class="note">Load a card file (JSON) from a card database site, for example a saved page from <span class="mono">api.deckplanet.net/cardsearch/fusion_world_cards?limit=500&amp;page=1</span>. You can pick several pages at once. Cards are saved by set, and a newer import replaces the older copy of that set.</p>
          <input id="import-file" type="file" accept=".json,application/json,text/plain" multiple onChange={onFile} disabled={busy} />
          <label class="field">Or paste the JSON
            <textarea id="import-text" value={importText} onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)} placeholder='{"data":[{"card_number":"FB01-001", ...}]}' />
          </label>
          <div class="row">
            <button class="btn" onClick={() => doImport(importText, 'pasted JSON')} disabled={busy || !importText.trim()}>Import pasted cards</button>
          </div>
          {importMsg && <p class={importMsg.startsWith('Import failed') ? 'err' : 'note'}>{importMsg}</p>}
          {st.db !== 'connected' && <p class="note warn">The shared database isn't available in this view, so imported cards last only until you close the page.</p>}
        </div>
      </div>

      <div class="panel stack">
        <h2>Rule switches</h2>
        <p class="note">A few rules the official manual leaves open, or that we could not confirm. Each one changes how every simulation plays.</p>
        <div class="grid2">
          <label class="field">Battle Cards may attack the turn they are played
            <select id="rule-attack" value={String(st.rules.attackOnPlayTurn)} onChange={(e) => setRule('attackOnPlayTurn', (e.target as HTMLSelectElement).value === 'true')}>
              <option value="true">Yes</option><option value="false">No</option>
            </select>
            <span class="hint">{RULE_NOTES.attackOnPlayTurn}</span>
          </label>
          <label class="field">Combo cards per battle, per player
            <select id="rule-combo" value={String(st.rules.comboLimit)} onChange={(e) => setRule('comboLimit', +(e.target as HTMLSelectElement).value)}>
              <option value="0">No limit</option><option value="2">2</option><option value="3">3</option><option value="4">4</option>
            </select>
            <span class="hint">{RULE_NOTES.comboLimit}</span>
          </label>
          <label class="field">A player loses
            <select id="rule-lose" value={String(st.rules.loseAtZeroLife)} onChange={(e) => setRule('loseAtZeroLife', (e.target as HTMLSelectElement).value === 'true')}>
              <option value="true">as soon as life reaches 0</option><option value="false">when damaged at 0 life</option>
            </select>
            <span class="hint">{RULE_NOTES.loseAtZeroLife}</span>
          </label>
          <label class="field">Multicolour cards are legal when
            <select id="rule-color" value={st.rules.colorRule} onChange={(e) => setRule('colorRule', (e.target as HTMLSelectElement).value as 'any' | 'all')}>
              <option value="any">they share one colour with the leader</option><option value="all">every colour matches the leader</option>
            </select>
            <span class="hint">{RULE_NOTES.colorRule}</span>
          </label>
        </div>
      </div>

      <div class="panel stack">
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Cards</h2>
          <div class="row">
            <input id="card-search" type="search" placeholder="Search name, number or text" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ width: '240px' }} aria-label="Search cards" />
            <label class="row" style={{ gap: '6px', fontSize: '13px' }}><input id="only-gaps" type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps((e.target as HTMLInputElement).checked)} /> Only approximated</label>
          </div>
        </div>
        <div class="scroll"><table>
          <thead><tr><th>Card</th><th class="num">Cost</th><th class="num">Power</th><th class="num">Combo</th><th>Text</th><th class="num">Understood</th></tr></thead>
          <tbody>{shown.map(({ c, cc }) => (
            <tr key={c.id}>
              <td style={{ minWidth: '150px' }}><span class="cardname">{c.name}</span><div class="mono">{c.id} · {c.type.toLowerCase()}</div><ColorTag card={c} /></td>
              <td class="num">{c.type === 'LEADER' ? '-' : c.cost}</td>
              <td class="num">{fmtPower(c.power)}{c.back ? ` / ${fmtPower(c.back.power)}` : ''}</td>
              <td class="num">{c.comboPower ? fmtPower(c.comboPower) : '-'}</td>
              <td style={{ minWidth: '260px', fontSize: '12px' }}>{c.text || <span class="note">No skill text</span>}{c.back?.text && <div class="note">Awakened: {c.back.text}</div>}{cc.unparsed.length > 0 && <div class="err">Approximated: {cc.unparsed.join(' | ')}</div>}</td>
              <td class="num">{pct(cc.coverage, 0)}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {shown.length === limit && <p class="row note">Showing the first {limit} matches. <button class="btn small" onClick={() => setLimit(limit + 40)}>Show 40 more</button></p>}
      </div>
    </div>
  );
}
