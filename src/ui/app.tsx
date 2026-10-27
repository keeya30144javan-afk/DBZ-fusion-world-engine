import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { store } from './store';
import { useStore } from './components';
import { CounterLab } from './views/counter';
import { MetaView } from './views/meta';
import { ScouterView } from './views/scouter';
import { MatchupView } from './views/matchup';
import { CardsView } from './views/cards';
import { AuditView } from './views/audit';

const TABS = [
  ['counter', 'Counter Lab'],
  ['meta', 'Meta'],
  ['scouter', 'Scouter'],
  ['matchup', 'Matchup'],
  ['cards', 'Cards & Rules'],
  ['audit', 'Audit'],
] as const;
type Tab = (typeof TABS)[number][0];

const initialTab = (): Tab => {
  const h = location.hash.replace('#', '');
  return (TABS.find(([k]) => k === h)?.[0] ?? 'counter') as Tab;
};

function App() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>(initialTab());
  useEffect(() => {
    const on = () => setTab(initialTab());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const go = (t: Tab) => {
    setTab(t);
    try { history.replaceState(null, '', `#${t}`); } catch { /* not allowed in this frame */ }
  };
  const nCards = Object.keys(st.cards).length;
  const nLeaders = Object.values(st.cards).filter((c) => c.type === 'LEADER').length;

  return (
    <>
      <header class="top">
        <div class="wrap">
          <div class="brand">
            <h1>Shen<span>ron</span></h1>
            <small>Fusion World deck lab</small>
          </div>
          <div class="status">
            <span class="chip"><b>{nCards}</b> cards</span>
            <span class="chip"><b>{nLeaders}</b> leaders</span>
            <span class="chip"><b>{st.meta.length}</b> meta decks</span>
            <span class={`chip ${st.db === 'connected' ? 'ok' : st.db === 'offline' ? 'warn' : ''}`}><span class="dot" />{st.db === 'connected' ? 'Saved data on' : st.db === 'offline' ? 'Saving off' : 'Connecting'}</span>
          </div>
          <nav class="tabs" role="tablist" aria-label="Sections">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)}>{label}</button>
            ))}
          </nav>
        </div>
      </header>
      <main class="wrap">
        {st.error && <p class="err">{st.error}</p>}
        {tab === 'counter' && <CounterLab />}
        {tab === 'meta' && <MetaView />}
        {tab === 'scouter' && <ScouterView />}
        {tab === 'matchup' && <MatchupView />}
        {tab === 'cards' && <CardsView />}
        {tab === 'audit' && <AuditView />}
      </main>
    </>
  );
}

render(<App />, document.getElementById('app')!);
store.connect();
