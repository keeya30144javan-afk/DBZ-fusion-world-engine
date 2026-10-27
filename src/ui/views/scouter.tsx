import { useMemo, useState } from 'preact/hooks';
import { cardFitsLeader } from '../../data/decks';
import { Behaviour, Sighting, scout } from '../../ai/scouter';
import { ColorTag, Meter, fmtPower, pct, useStore } from '../components';

const BEHAVIOUR_TEXT = (b: Behaviour) =>
  b.t === 'tookHit' ? `Let ${b.stakes === 'leader' ? 'a leader hit' : 'a battle card die'} through, ${fmtPower(b.need)} short${b.life !== undefined ? `, at ${b.life} life` : ''}`
    : b.t === 'passedWithEnergy' ? `Ended turn with ${b.energy} energy unused`
      : `Stopped an attack using ${b.withCards} combo card${b.withCards === 1 ? '' : 's'}`;

function Stepper({ id, label, value, set, min = 0, max = 30 }: { id: string; label: string; value: number; set: (n: number) => void; min?: number; max?: number }) {
  return (
    <label class="field">{label}
      <div class="row" style={{ flexWrap: 'nowrap', gap: '6px' }}>
        <button class="btn small" type="button" aria-label={`Decrease ${label}`} onClick={() => set(Math.max(min, value - 1))}>−</button>
        <input id={id} type="number" min={min} max={max} value={value} onInput={(e) => set(Math.max(min, Math.min(max, +(e.target as HTMLInputElement).value || 0)))} style={{ textAlign: 'center' }} />
        <button class="btn small" type="button" aria-label={`Increase ${label}`} onClick={() => set(Math.min(max, value + 1))}>+</button>
      </div>
    </label>
  );
}

export function ScouterView() {
  const st = useStore();
  const leaders = useMemo(() => {
    const inMeta = new Set(st.meta.map((m) => m.leader));
    return Object.values(st.cards).filter((c) => c.type === 'LEADER').sort((a, b) => Number(inMeta.has(b.id)) - Number(inMeta.has(a.id)) || a.name.localeCompare(b.name));
  }, [st.cards, st.meta]);
  const [leader, setLeader] = useState(leaders[0]?.id ?? '');
  const [hand, setHand] = useState(6);
  const [life, setLife] = useState(8);
  const [seen, setSeen] = useState<Sighting[]>([]);
  const [behaviour, setBehaviour] = useState<Behaviour[]>([]);
  const [q, setQ] = useState('');
  const [gap, setGap] = useState(5000);
  const [energy, setEnergy] = useState(2);
  const [withCards, setWithCards] = useState(1);

  const leaderCard = st.cards[leader];
  const candidates = useMemo(() => {
    if (!leaderCard) return [];
    const k = q.trim().toLowerCase();
    return Object.values(st.cards)
      .filter((c) => c.type !== 'LEADER' && cardFitsLeader(c, leaderCard, st.rules))
      .filter((c) => !k || c.name.toLowerCase().includes(k) || c.id.toLowerCase().includes(k))
      .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))
      .slice(0, 40);
  }, [st.cards, leaderCard, q, st.rules]);

  const report = useMemo(() => leader ? scout(st.cards, { leader, archetypes: st.meta, seen, handSize: hand, lifeCount: life, behaviour, rules: st.rules }) : null, [leader, st.cards, st.meta, seen, hand, life, behaviour, st.rules]);

  const addSeen = (id: string, where: Sighting['where']) => setSeen((s) => {
    const i = s.findIndex((x) => x.id === id && x.where === where);
    if (i < 0) return [...s, { id, n: 1, where }];
    const copy = s.slice(); copy[i] = { ...copy[i], n: copy[i].n + 1 }; return copy;
  });
  const dropSeen = (i: number) => setSeen((s) => (s[i].n > 1 ? s.map((x, j) => (j === i ? { ...x, n: x.n - 1 } : x)) : s.filter((_, j) => j !== i)));
  const reset = () => { setSeen([]); setBehaviour([]); setHand(6); setLife(8); };

  return (
    <div class="split">
      <div class="stack">
        <p class="intro">Use this during a real game. Log what you have seen and how your opponent has played, and the Scouter estimates what is in their hand and life. It counts cards against the meta lists and weighs their choices: <strong>a player who lets a cheap hit through probably could not stop it.</strong></p>
        <div class="panel raised stack">
          <h2>Opponent</h2>
          <label class="field">Leader
            <select id="scout-leader" value={leader} onChange={(e) => { setLeader((e.target as HTMLSelectElement).value); reset(); }}>
              {leaders.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.colors.join('/')} · {l.id}</option>)}
            </select>
          </label>
          <div class="grid2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            <Stepper id="scout-hand" label="Cards in hand" value={hand} set={setHand} />
            <Stepper id="scout-life" label="Life left" value={life} set={setLife} max={8} />
          </div>
          <button class="btn small" onClick={reset}>New game</button>
        </div>

        <div class="panel stack">
          <h2>Cards seen</h2>
          <input id="scout-search" type="search" placeholder="Search name or number" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Search cards" />
          <div class="scroll" style={{ maxHeight: '240px', overflowY: 'auto' }}><table>
            <tbody>{candidates.map((c) => (
              <tr key={c.id}>
                <td><span class="cardname">{c.name}</span> <span class="mono">{c.id}</span><div class="note">cost {c.cost}{c.type === 'BATTLE' ? ` · ${fmtPower(c.power)} power · combo ${fmtPower(c.comboPower)}` : ' · Extra'}</div></td>
                <td class="num"><div class="row" style={{ gap: '4px', justifyContent: 'flex-end' }}>
                  <button class="btn small" onClick={() => addSeen(c.id, 'public')} title="Played, in the Drop, in energy, or used in a combo">Seen</button>
                  <button class="btn small" onClick={() => addSeen(c.id, 'inHand')} title="Revealed or returned to their hand">In hand</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
          {seen.length > 0 && (
            <div class="stack" style={{ gap: '4px' }}>
              <div class="eyebrow">Logged</div>
              {seen.map((s, i) => (
                <div key={`${s.id}-${s.where}`} class="row" style={{ justifyContent: 'space-between' }}>
                  <span>{s.n}× {st.cards[s.id]?.name} <span class="tag">{s.where === 'public' ? 'seen' : 'in hand'}</span></span>
                  <button class="btn small" onClick={() => dropSeen(i)} aria-label={`Remove one ${st.cards[s.id]?.name}`}>−1</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class="panel stack">
          <h2>How they played</h2>
          <div class="row" style={{ flexWrap: 'nowrap' }}>
            <label class="field" style={{ flex: 1 }}>They took a hit, short by
              <select id="scout-gap" value={gap} onChange={(e) => setGap(+(e.target as HTMLSelectElement).value)}>
                {[1, 5000, 10000, 15000, 20000].map((g) => <option key={g} value={g}>{g === 1 ? 'a tie' : fmtPower(g)}</option>)}
              </select>
            </label>
            <button class="btn small" style={{ alignSelf: 'flex-end' }} onClick={() => setBehaviour((b) => [...b, { t: 'tookHit', need: gap, stakes: 'leader', life }])}>Log</button>
          </div>
          <div class="row" style={{ flexWrap: 'nowrap' }}>
            <label class="field" style={{ flex: 1 }}>Ended turn with unused energy
              <input id="scout-energy" type="number" min={1} max={10} value={energy} onInput={(e) => setEnergy(+(e.target as HTMLInputElement).value || 1)} />
            </label>
            <button class="btn small" style={{ alignSelf: 'flex-end' }} onClick={() => setBehaviour((b) => [...b, { t: 'passedWithEnergy', energy }])}>Log</button>
          </div>
          <div class="row" style={{ flexWrap: 'nowrap' }}>
            <label class="field" style={{ flex: 1 }}>Stopped an attack with combo cards
              <input id="scout-with" type="number" min={1} max={6} value={withCards} onInput={(e) => setWithCards(+(e.target as HTMLInputElement).value || 1)} />
            </label>
            <button class="btn small" style={{ alignSelf: 'flex-end' }} onClick={() => setBehaviour((b) => [...b, { t: 'defended', withCards }])}>Log</button>
          </div>
          {behaviour.map((b, i) => (
            <div key={i} class="row" style={{ justifyContent: 'space-between' }}>
              <span class="note">{BEHAVIOUR_TEXT(b)}</span>
              <button class="btn small" onClick={() => setBehaviour((x) => x.filter((_, j) => j !== i))} aria-label="Remove">×</button>
            </div>
          ))}
        </div>
      </div>

      <div class="stack">
        {report && (
          <>
            <div class="panel raised">
              <h2>Can they stop your attack?</h2>
              <p class="note">Chance their hand holds enough combo power to block an attack that is ahead by this much. Expected combo power in hand: <b>{fmtPower(Math.round(report.expectedHandCombo / 1000) * 1000)}</b>.</p>
              <div class="scroll"><table>
                <thead><tr><th>You are ahead by</th><th class="num">With 1 card</th><th class="num">With 2 cards</th><th class="num">Whole hand</th></tr></thead>
                <tbody>{report.defense.map((d) => (
                  <tr key={d.need}><td class="mono">{fmtPower(d.need)}</td><td class="num">{pct(d.pOne, 0)}</td><td class="num">{pct(d.pTwo, 0)}</td><td class="num">{pct(d.pAny, 0)}</td></tr>
                ))}</tbody>
              </table></div>
            </div>

            <div class="panel">
              <h2>Which list are they on?</h2>
              {report.note && <p class="note warn">{report.note}</p>}
              <table><tbody>{report.archetypes.map((a) => (
                <tr key={a.name}><td>{a.name}{a.offList.length > 0 && <div class="note">off-list: {a.offList.join(', ')}</div>}</td><td class="num">{pct(a.posterior, 0)}</td><td style={{ width: '35%' }}><Meter value={a.posterior} /></td></tr>
              ))}</tbody></table>
            </div>

            <div class="panel">
              <h2>Likely in their hand</h2>
              <div class="scroll"><table>
                <thead><tr><th>Card</th><th class="num">Copies unseen</th><th class="num">In hand</th><th></th><th class="num">In life</th></tr></thead>
                <tbody>{report.cards.filter((c) => c.unseen > 0.05 || c.pInHand > 0.01).slice(0, 30).map((c) => (
                  <tr key={c.id}>
                    <td><span class="cardname">{c.name}</span> <span class="mono">{c.id}</span><div class="note">cost {c.cost} · combo {fmtPower(c.comboPower)}</div></td>
                    <td class="num">{c.unseen.toFixed(1)}</td>
                    <td class="num">{pct(c.pInHand, 0)}</td>
                    <td style={{ width: '20%' }}><Meter value={c.pInHand} accent /></td>
                    <td class="num">{pct(c.pInLife, 0)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p class="note">"In hand" is the chance at least one copy is there now. Life cards are dealt at random from the deck, so "In life" only reflects card counting.</p>
            </div>
          </>
        )}
        {leaderCard && <p class="note">Tracking {leaderCard.name} · {leaderCard.id} <ColorTag card={leaderCard} /></p>}
      </div>
    </div>
  );
}
