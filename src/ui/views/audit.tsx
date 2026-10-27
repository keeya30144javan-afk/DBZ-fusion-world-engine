import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Card } from '../../data/types';
import { fromScript, parseCard } from '../../effects/parse';
import { describeCompiled } from '../../effects/describe';
import { autoCheck } from '../../effects/check';
import { textHash } from '../../effects/script';
import { store, ScriptDoc } from '../store';
import { useStore } from '../components';
import { Sampler, translateBatch, untranslated } from '../translate';

type Filter = 'review' | 'checked' | 'verified' | 'rejected';
const BATCH = 20;
const PAGE = 30;

interface Row {
  c: Card;
  status: ScriptDoc['status'];
  doc?: ScriptDoc;
  reading: string;
  /** Why a person should look at it: the checker's findings and any failed second read. Empty = checked. */
  issues: string[];
  /** A note from the check (approximations the engine makes). */
  note?: string;
}

const ERR_COPY: Record<string, string> = {
  not_granted: 'Claude was not allowed for this page, so translation is off for this visit.',
  rate_limited: 'Claude is busy for your account right now. Wait a minute, then press the button again.',
  cancelled: 'Stopped.',
};

export function AuditView() {
  const st = useStore();
  const [filter, setFilter] = useState<Filter>('review');
  const [page, setPage] = useState(0);
  const [sample, setSample] = useState<Sampler | null | undefined>(undefined);
  const [step, setStep] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    const claude = (window as any).claude;
    if (!claude?.use) { setSample(null); return; }
    claude.use('sample').then((s: Sampler | null) => { if (live) setSample(s); }, () => live && setSample(null));
    return () => { live = false; };
  }, []);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const c of Object.values(st.cards)) {
      const doc = st.reviews[c.id];
      const script = doc?.script ?? (c.script && c.script.textHash === textHash(c) ? c.script : undefined);
      if (!script && !doc) continue;
      const status = doc?.status ?? (script?.source === 'verified' ? 'verified' : 'unreviewed');
      const cc = script ? fromScript(script) : null;
      const check = doc?.check ? { ok: doc.check.ok, note: doc.check.issues } : script?.check;
      const auto = cc ? autoCheck(c, cc) : { ok: false, issues: ['no translation yet'] };
      const issues = [...auto.issues, ...(check && !check.ok && check.note && !auto.issues.length ? [check.note] : []), ...(!check ? ['not yet read a second time'] : [])];
      out.push({ c, doc, status, reading: cc ? describeCompiled(cc) : '', issues: [...new Set(issues)], note: check?.ok ? check.note : undefined });
    }
    return out.sort((a, b) => b.c.id.localeCompare(a.c.id));
  }, [st.cards, st.reviews]);

  const todo = useMemo(() => untranslated(st.cards, st.reviews), [st.cards, st.reviews]);
  const focus = st.auditFocus ? new Set(st.auditFocus) : null;
  const inFocus = (r: Row) => !focus || focus.has(r.c.id);
  const count = (f: Filter) => rows.filter((r) => inFocus(r) && match(r, f)).length;
  const shown = rows.filter((r) => inFocus(r) && match(r, filter));
  const pageRows = shown.slice(page * PAGE, page * PAGE + PAGE);
  const canWrite = st.db !== 'connected' || st.canReview !== false;

  async function translate() {
    if (!sample || step) return;
    const batch = todo.slice(0, BATCH);
    if (!batch.length) return;
    ctl.current = new AbortController();
    setLog([]);
    try {
      const res = await translateBatch(sample, batch, setStep, ctl.current.signal);
      setStep('Saving…');
      const lines: string[] = [];
      for (const r of res) {
        if (r.doc) { await store.saveScript(r.id, r.doc); lines.push(`${r.id}: translated${r.doc.check && !r.doc.check.ok ? ` — check found: ${r.doc.check.issues}` : ''}`); }
        else lines.push(`${r.id}: refused — ${(r.errors ?? []).slice(0, 2).join('; ')}`);
      }
      setLog(lines);
      setFilter('review'); setPage(0);
    } catch (e: any) {
      setLog([ERR_COPY[e?.code] ?? `Translation failed: ${e?.message ?? e}`]);
      if (e?.code === 'not_granted') setSample(null);
    } finally {
      setStep(null);
      ctl.current = null;
    }
  }

  async function review(r: Row, status: ScriptDoc['status']) {
    const note = notes[r.c.id]?.trim();
    const doc: ScriptDoc = {
      textHash: textHash(r.c),
      status,
      updated: new Date().toISOString(),
      ...(r.doc?.script ? { script: r.doc.script } : {}),
      ...(r.doc?.check ? { check: r.doc.check } : {}),
      ...(note ? { note } : {}),
    };
    try { await store.saveScript(r.c.id, doc); } catch (e: any) { setLog([`Could not save the review of ${r.c.id}: ${e?.message ?? e}`]); }
  }

  const tabs: [Filter, string][] = [['review', 'Needs you'], ['checked', 'Checked by Claude'], ['verified', 'Verified'], ['rejected', 'Rejected']];

  return (
    <div class="stack">
      <p class="intro">Every card translation the engine runs, next to the printed text. Each one goes through an automatic checker (every number, card name, special trait, timing and keyword on the card must appear in the engine's reading) and a second read by Claude. Only cards that fail one of those land in <b>Needs you</b>. A card you mark correct is trusted first.</p>

      <div class="grid2">
        <div class="panel raised stack">
          <div class="eyebrow">Trust</div>
          <div class="row" style={{ flexWrap: 'wrap', gap: '8px' }}>
            <span class="chip ok"><b>{count('verified')}</b> verified by you</span>
            <span class="chip ok"><b>{count('checked')}</b> checked by Claude</span>
            <span class="chip warn"><b>{count('review')}</b> need you</span>
            <span class="chip"><b>{count('rejected')}</b> rejected</span>
            <span class="chip"><b>{todo.length}</b> not yet translated</span>
          </div>
          <p class="note">Order the engine follows: verified translation → parser (when it reads the whole card) → unreviewed translation → parser's partial reading. A rejected translation is dropped and the card goes back to the parser.</p>
        </div>

        <div class="panel stack">
          <h2>Translate new cards</h2>
          <p class="note">Sends the next {Math.min(BATCH, todo.length)} cards the engine can't fully read to Claude, newest sets first. Each batch runs at most three requests: translate, fix anything the validator refuses, then an independent check of the engine's English reading against the printed text. It uses your own Claude usage.</p>
          {sample === undefined && <p class="note">Connecting to Claude…</p>}
          {sample === null && <p class="note warn">Claude isn't available in this view, so new cards can't be translated here. Reviews still work.</p>}
          <div class="row">
            <button id="translate-btn" class="btn primary" onClick={translate} disabled={!sample || !!step || !todo.length || !canWrite}>{todo.length ? `Translate ${Math.min(BATCH, todo.length)} cards` : 'All cards translated'}</button>
            {step && <button class="btn small" onClick={() => ctl.current?.abort()}>Stop</button>}
          </div>
          {!canWrite && <p class="note warn">Only editors of this page can save translations and reviews. You can still read them.</p>}
          {step && <p class="note" aria-live="polite">{step}</p>}
          {log.length > 0 && <div class="scroll" style={{ maxHeight: '180px' }}>{log.map((l, i) => <div key={i} class={l.includes('refused') || l.includes('failed') ? 'err' : 'note'} style={{ fontSize: '12px' }}>{l}</div>)}</div>}
        </div>
      </div>

      <div class="panel stack">
        {focus && (
          <div class="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <p class="note" style={{ margin: 0 }}>Showing the {focus.size} card{focus.size === 1 ? '' : 's'} from your counter result. Mark each one correct or wrong; verified cards stop triggering warnings.</p>
            <button class="btn small" onClick={() => store.focusAudit(null)}>Show all cards</button>
          </div>
        )}
        <nav class="row" role="tablist" aria-label="Review filter" style={{ flexWrap: 'wrap', gap: '6px' }}>
          {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={filter === k} class={`btn small${filter === k ? ' primary-lite' : ''}`} onClick={() => { setFilter(k); setPage(0); }}>{label} ({count(k)})</button>)}
        </nav>
        {pageRows.length === 0 && <p class="empty note">Nothing here.</p>}
        {pageRows.map((r) => (
          <div key={r.c.id} class="audit-card">
            <div class="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div><span class="cardname">{r.c.name}</span> <span class="mono">{r.c.id} · {r.c.type.toLowerCase()}</span></div>
              <div class="row" style={{ gap: '6px' }}>
                <span class={`chip ${r.status === 'verified' ? 'ok' : r.status === 'rejected' ? 'warn' : ''}`}>{r.status}</span>
                {r.status === 'unreviewed' && <span class={`chip ${r.issues.length ? 'warn' : 'ok'}`}>{r.issues.length ? 'needs you' : 'checked'}</span>}
                {!r.doc?.script && <span class="chip">built in</span>}
              </div>
            </div>
            <div class="audit-cols">
              <div><div class="eyebrow">Printed</div><div class="audit-text">{r.c.text}{r.c.back?.text && <><br /><b>Awakened:</b> {r.c.back.text}</>}</div></div>
              <div><div class="eyebrow">Engine reads</div><div class="audit-text">{r.reading || <span class="note">(no translation — parser: {Math.round(parseCard(r.c).coverage * 100)}% understood)</span>}</div></div>
            </div>
            {r.status === 'unreviewed' && r.issues.length > 0 && <p class="note warn">Why it's here: {r.issues.join(' · ')}</p>}
            {r.note && <p class="note">Checked — note: {r.note}</p>}
            {r.doc?.note && <p class="note">Note: {r.doc.note}</p>}
            {canWrite && (
              <div class="row" style={{ flexWrap: 'wrap' }}>
                {r.status !== 'verified' && <button class="btn small" onClick={() => review(r, 'verified')} aria-label={`Mark ${r.c.id} correct`}>✔ Correct</button>}
                {r.status !== 'rejected' && <button class="btn small danger" onClick={() => review(r, 'rejected')} aria-label={`Mark ${r.c.id} wrong`}>✘ Wrong</button>}
                {r.status !== 'unreviewed' && <button class="btn small" onClick={() => review(r, 'unreviewed')}>Undo</button>}
                <input type="text" placeholder="What's wrong (optional)" value={notes[r.c.id] ?? ''} onInput={(e) => setNotes({ ...notes, [r.c.id]: (e.target as HTMLInputElement).value })} style={{ flex: 1, minWidth: '160px' }} aria-label={`Note for ${r.c.id}`} />
              </div>
            )}
          </div>
        ))}
        {shown.length > PAGE && (
          <div class="row">
            <button class="btn small" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span class="note">{page * PAGE + 1}–{Math.min(shown.length, page * PAGE + PAGE)} of {shown.length}</span>
            <button class="btn small" disabled={(page + 1) * PAGE >= shown.length} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
    </div>
  );
}

function match(r: Row, f: Filter): boolean {
  if (f === 'review') return r.status === 'unreviewed' && r.issues.length > 0;
  if (f === 'checked') return r.status === 'unreviewed' && r.issues.length === 0;
  return r.status === f;
}
