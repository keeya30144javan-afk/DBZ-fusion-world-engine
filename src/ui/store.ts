import { Card, CardDB, Decklist, Meta } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { normalizeCards } from '../data/normalize';
import { clearCompileCache } from '../effects/parse';
import { clearValueCache } from '../ai/heuristics';

declare const __BUNDLED_CARDS__: CardDB;
declare const __BUNDLED_META__: Meta;

export interface MetaDeck extends Decklist {
  id: string;
  example?: boolean;
}

export interface SetInfo {
  set: string;
  count: number;
  source: string;
  updated: string;
  from: 'bundled' | 'database';
}

export interface State {
  cards: Record<string, Card>;
  sets: SetInfo[];
  meta: MetaDeck[];
  rules: RulesConfig;
  db: 'connecting' | 'connected' | 'offline';
  canWrite: boolean | null;
  error: string | null;
}

type Listener = () => void;

const bundledSets = (): Map<string, { cards: Card[]; info: SetInfo }> => {
  const m = new Map<string, { cards: Card[]; info: SetInfo }>();
  for (const c of Object.values(__BUNDLED_CARDS__.cards)) {
    const e = m.get(c.set) ?? { cards: [], info: { set: c.set, count: 0, source: __BUNDLED_CARDS__.source, updated: __BUNDLED_CARDS__.updated, from: 'bundled' as const } };
    e.cards.push(c);
    e.info.count++;
    m.set(c.set, e);
  }
  return m;
};

const exampleMeta = (): MetaDeck[] => __BUNDLED_META__.decks.map((d, i) => ({ ...d, id: `example-${i}`, example: true }));

export class Store {
  state: State = {
    cards: { ...__BUNDLED_CARDS__.cards },
    sets: [...bundledSets().values()].map((s) => s.info),
    meta: exampleMeta(),
    rules: { ...DEFAULT_RULES },
    db: 'connecting',
    canWrite: null,
    error: null,
  };
  private listeners = new Set<Listener>();
  private db: any = null;
  private dbSets = new Map<string, { cards: Card[]; info: SetInfo }>();
  private dbMeta: MetaDeck[] | null = null;

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  async connect() {
    setTimeout(() => { if (this.state.db === 'connecting') this.set({ db: 'offline' }); }, 12000);
    const claude = (window as any).claude;
    if (!claude?.use) { this.set({ db: 'offline' }); return; }
    try {
      const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
      if (!db) { this.set({ db: 'offline' }); return; }
      this.db = db;
      let canWrite: boolean | null = null;
      try { canWrite = user ? await user.can('data.write') : null; } catch { canWrite = null; }
      this.set({ db: 'connected', canWrite });
      db.collection('carddb').onSnapshot((snap: any) => {
        this.dbSets.clear();
        for (const d of snap.docs) {
          const body = d.data();
          if (!body || !Array.isArray(body.cards)) continue;
          const cards = Object.values(normalizeCards(body.cards));
          this.dbSets.set(d.id, { cards, info: { set: d.id, count: cards.length, source: String(body.source ?? 'database'), updated: String(body.updated ?? ''), from: 'database' } });
        }
        this.rebuildCards();
      }, (e: any) => this.set({ error: `Card database: ${e.message}` }));
      db.collection('meta').onSnapshot((snap: any) => {
        this.dbMeta = snap.docs.map((d: any) => ({ ...(d.data() as Decklist), id: d.id }));
        this.set({ meta: this.dbMeta!.length ? this.dbMeta! : exampleMeta() });
      }, (e: any) => this.set({ error: `Meta decks: ${e.message}` }));
      db.doc('settings/rules').onSnapshot((snap: any) => {
        if (snap.exists) this.set({ rules: { ...DEFAULT_RULES, ...(snap.data() as Partial<RulesConfig>) } });
      }, () => {});
    } catch (e: any) {
      this.set({ db: 'offline', error: String(e?.message ?? e) });
    }
  }

  private rebuildCards() {
    const merged = new Map(bundledSets());
    for (const [k, v] of this.dbSets) merged.set(k, v);
    const cards: Record<string, Card> = {};
    for (const { cards: list } of merged.values()) for (const c of list) cards[c.id] = c;
    clearCompileCache();
    clearValueCache();
    this.set({ cards, sets: [...merged.values()].map((m) => m.info).sort((a, b) => a.set.localeCompare(b.set)) });
  }

  // ---- writes

  get writable() {
    return this.state.db === 'connected' && this.state.canWrite !== false;
  }

  async saveDeck(deck: MetaDeck): Promise<void> {
    if (!this.db) throw new Error('Saving needs the shared database, which is not available in this view.');
    const { id, example, ...body } = deck;
    void example;
    const ref = id && !id.startsWith('example-') ? this.db.collection('meta').doc(id) : this.db.collection('meta').doc();
    // Bringing the examples along the first time the user edits, so the meta is not lost.
    if (this.dbMeta && this.dbMeta.length === 0) {
      for (const ex of exampleMeta()) {
        if (ex.id === id) continue;
        const { id: _i, example: _e, ...b } = ex;
        await this.db.collection('meta').doc().set({ ...b, updated: new Date().toISOString() });
      }
    }
    await ref.set({ ...body, updated: new Date().toISOString() });
  }

  async deleteDeck(id: string): Promise<void> {
    if (!this.db || id.startsWith('example-')) return;
    await this.db.collection('meta').doc(id).delete();
  }

  async saveRules(rules: RulesConfig): Promise<void> {
    this.set({ rules });
    if (this.db) await this.db.doc('settings/rules').set({ ...rules });
  }

  /** Import a card file (any supported shape) into the shared database, one document per set. */
  async importCards(rows: any[], source: string): Promise<{ sets: number; cards: number }> {
    const cards = Object.values(normalizeCards(rows));
    const bySet = new Map<string, Card[]>();
    for (const c of cards) bySet.set(c.set, [...(bySet.get(c.set) ?? []), c]);
    if (!this.db) {
      // No database in this view: use the cards for this visit only.
      for (const [set, list] of bySet) this.dbSets.set(set, { cards: list, info: { set, count: list.length, source: `${source} (this visit only)`, updated: new Date().toISOString(), from: 'database' } });
      this.rebuildCards();
      return { sets: bySet.size, cards: cards.length };
    }
    for (const [set, list] of bySet) {
      await this.db.collection('carddb').doc(set.replace(/[^A-Za-z0-9_\-.~:@+]/g, '_')).set({ source, updated: new Date().toISOString(), cards: list });
    }
    return { sets: bySet.size, cards: cards.length };
  }
}

export const store = new Store();
