import { Card, CardDB, Decklist, Meta } from '../data/types';
import { DEFAULT_RULES, RulesConfig } from '../data/rules';
import { normalizeCards } from '../data/normalize';
import { clearCompileCache } from '../effects/parse';
import { clearValueCache } from '../ai/heuristics';
import { CardScript } from '../effects/types';
import { textHash } from '../effects/script';

/**
 * One card's translation and its review, kept in the shared `scripts` collection.
 * A doc may carry only a review (for a translation shipped with the app) or a new
 * translation made in the app. It is ignored once the card's printed text changes.
 */
export interface ScriptDoc {
  textHash: string;
  script?: CardScript;
  status: 'unreviewed' | 'verified' | 'rejected';
  check?: { ok: boolean; issues: string };
  note?: string;
  updated: string;
}

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
  /** Editors and the owner may save translations and reviews. */
  canReview: boolean | null;
  error: string | null;
  /** Reviews and in-app translations, by card id (only those matching the current text). */
  reviews: Record<string, ScriptDoc>;
  /** Cards the Audit tab should show on its own (set from a counter result). */
  auditFocus: string[] | null;
  /** A tab another view asked to open. */
  tabRequest: string | null;
  /** Decks handed to the Play tab from another tab (a counter, a matchup). */
  playRequest: { you?: Decklist; ai?: Decklist } | null;
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

/** Real tournament results for the current format, if the build has them. */
export const BUNDLED_RESULTS = __BUNDLED_META__.results;

const exampleMeta = (): MetaDeck[] => __BUNDLED_META__.decks.map((d, i) => ({ ...d, id: `example-${i}`, example: true }));

export class Store {
  state: State = {
    cards: { ...__BUNDLED_CARDS__.cards },
    sets: [...bundledSets().values()].map((s) => s.info),
    meta: exampleMeta(),
    rules: { ...DEFAULT_RULES },
    db: 'connecting',
    canWrite: null,
    canReview: null,
    error: null,
    reviews: {},
    auditFocus: null,
    tabRequest: null,
    playRequest: null,
  };
  private listeners = new Set<Listener>();
  private db: any = null;
  private dbSets = new Map<string, { cards: Card[]; info: SetInfo }>();
  private dbMeta: MetaDeck[] | null = null;
  private dbScripts: Record<string, ScriptDoc> = {};

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

  /** The viewer's opaque account id (to tell players' saved games apart). */
  userId: string | null = null;

  async connect() {
    setTimeout(() => { if (this.state.db === 'connecting') this.set({ db: 'offline' }); }, 12000);
    const claude = (window as any).claude;
    if (!claude?.use) { this.set({ db: 'offline' }); return; }
    try {
      const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
      if (!db) { this.set({ db: 'offline' }); return; }
      this.db = db;
      try { this.userId = user ? await user.id() : null; } catch { this.userId = null; }
      let canWrite: boolean | null = null;
      try { canWrite = user ? await user.can('data.write') : null; } catch { canWrite = null; }
      let canReview: boolean | null = null;
      try { canReview = user ? await user.canEdit() : null; } catch { canReview = null; }
      this.set({ db: 'connected', canWrite, canReview });
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
      db.collection('scripts').onSnapshot((snap: any) => {
        this.dbScripts = {};
        for (const d of snap.docs) {
          const b = d.data();
          if (!b || typeof b.textHash !== 'string' || typeof b.status !== 'string') continue;
          let script: CardScript | undefined;
          try { script = typeof b.script === 'string' ? JSON.parse(b.script) : undefined; } catch { script = undefined; }
          this.dbScripts[d.id] = { ...(b as ScriptDoc), script };
        }
        this.rebuildCards();
      }, (e: any) => this.set({ error: `Translations: ${e.message}` }));
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
    const reviews: Record<string, ScriptDoc> = {};
    for (const [id, doc] of Object.entries(this.dbScripts)) {
      const c = cards[id];
      if (!c || doc.textHash !== textHash(c)) continue;
      reviews[id] = doc;
      const base = doc.script ?? c.script;
      if (doc.status === 'rejected' || !base) { const { script: _s, ...rest } = c; void _s; cards[id] = rest; continue; }
      cards[id] = { ...c, script: { ...base, textHash: doc.textHash, source: doc.status === 'verified' ? 'verified' : 'claude' } };
    }
    clearCompileCache();
    clearValueCache();
    this.set({ cards, reviews, sets: [...merged.values()].map((m) => m.info).sort((a, b) => a.set.localeCompare(b.set)) });
  }

  /** Open the Play tab with these decks ready. */
  requestPlay(you?: Decklist, ai?: Decklist) {
    this.set({ playRequest: { you, ai }, tabRequest: 'play' });
  }

  clearPlayRequest() {
    if (this.state.playRequest) this.set({ playRequest: null });
  }

  /** Open the Audit tab showing just these cards (null shows everything again). */
  focusAudit(ids: string[] | null) {
    this.set({ auditFocus: ids, tabRequest: ids ? 'audit' : null });
  }

  clearTabRequest() {
    if (this.state.tabRequest) this.set({ tabRequest: null });
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

  /** Store a translation and/or its review. */
  async saveScript(id: string, doc: ScriptDoc): Promise<void> {
    if (!this.db) {
      this.dbScripts[id] = doc;
      this.rebuildCards();
      return;
    }
    // The script travels as a JSON string: it nests lists inside lists, which the store may not keep.
    const body = JSON.parse(JSON.stringify({ ...doc, script: doc.script ? JSON.stringify(doc.script) : undefined }));
    await this.db.collection('scripts').doc(id).set(body);
  }

  /** Save (or update) a game played against the AI, for Claude to review. Returns its id. */
  async savePlayGame(id: string | null, body: Record<string, unknown>): Promise<string | null> {
    if (!this.db) return null;
    const ref = id ? this.db.collection('playgames').doc(id) : this.db.collection('playgames').doc();
    // Nested lists (moves inside the trace) travel as a JSON string, like scripts.
    await ref.set(JSON.parse(JSON.stringify({ ...body, ...(this.userId ? { player: this.userId } : {}), updated: new Date().toISOString() })));
    return ref.id ?? id;
  }

  /** Self-play training positions from this computer ("Help train the AI"). Rows travel as a JSON string. */
  async saveSelfplay(batch: { rows: number[][]; games: number; inputs: number }, cores: number): Promise<void> {
    if (!this.db) throw new Error('Saving training games needs the shared database, which is not available in this view.');
    await this.db.collection('selfplay').doc().set({ rows: JSON.stringify(batch.rows), games: batch.games, inputs: batch.inputs, v: 2, cores, ...(this.userId ? { player: this.userId } : {}), at: new Date().toISOString() });
  }

  /** Up to n saved training batches (oldest ids first), for "Download & clear". */
  async readSelfplay(n: number): Promise<{ id: string; rows: number[][]; games: number; inputs: number }[]> {
    if (!this.db) return [];
    const snap = await this.db.collection('selfplay').limit(n).get();
    return snap.docs.map((d: any) => { const b = d.data() ?? {}; let rows: number[][] = []; try { rows = JSON.parse(b.rows ?? '[]'); } catch { /* skip a broken batch */ } return { id: d.id, rows, games: b.games ?? 0, inputs: b.inputs ?? 0 }; });
  }

  async deleteSelfplay(ids: string[]): Promise<void> {
    if (!this.db) return;
    for (const id of ids) await this.db.collection('selfplay').doc(id).delete();
  }

  /** "This card's text or engine reading is wrong", from the Play tab. */
  async reportCard(cardId: string, note: string, textHashValue: string): Promise<void> {
    if (!this.db) throw new Error('Reporting needs the shared database, which is not available in this view.');
    await this.db.collection('reports').doc().set({ cardId, note, textHash: textHashValue, from: 'play', ...(this.userId ? { player: this.userId } : {}), at: new Date().toISOString() });
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
