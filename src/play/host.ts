import { Card, Decklist } from '../data/types';
import { RulesConfig } from '../data/rules';
import { GameState, Side, cardOf, cloneState, isLeader, nameOf, other, powerOf } from '../engine/core';
import { ChoiceReq, Chooser } from '../engine/effects';
import { Action, battleTotals, legalActions, newGame, step } from '../engine/game';
import { compileCard } from '../effects/parse';
import { describeAbility, describeEffect } from '../effects/describe';
import { Policy, defaultChooser } from '../ai/heuristics';
import { SEARCH_LEVELS, SearchPolicy } from '../ai/search';
import { Snap, describeAction, snapshot } from '../builder/replay';

/**
 * A game between a person and the AI. The person is always side 0.
 *
 * Skills ask for choices in the middle of a move, but a person can't answer
 * synchronously. So a move runs on a copy of the game; when it needs the
 * person's choice the copy is thrown away, the question goes to the page, and
 * once answered the move runs again from the start with the answers so far.
 * The engine is deterministic, so the replay reaches the same question.
 */

export type PlayLevel = 'quick' | 'strong' | 'deep';

export interface PlayOpts {
  you: Decklist;
  ai: Decklist;
  level: PlayLevel;
  seed: number;
  /** null = random. */
  youFirst: boolean | null;
  rules?: RulesConfig;
}

export interface ActionOption { i: number; label: string; group: string; detail?: string }
export interface ChoiceOption { v: number; label: string; id?: string; where?: string }

export type Decision =
  | { kind: 'action'; options: ActionOption[]; battle?: { atk: number; def: number; youAttack: boolean } }
  | { kind: 'choice'; prompt: string; detail: string; min: number; max: number; options: ChoiceOption[]; srcId?: string };

export interface PlayView {
  snap: Snap;
  aiHand: number;
  log: string[];
  turn: number;
  /** Moves made so far (an index into the trace: flags point here). */
  moves: number;
  decision: Decision | null;
  over: { winner: Side | -1; reason: string } | null;
  /** The AI's last few moves in words. */
  aiMoves: string[];
  /** The AI's moves in its latest turn, each with what it did (log lines, from your point of view). */
  aiTurn: { label: string; lines: string[] }[];
  /** Your last move can be taken back. */
  canUndo: boolean;
}

/** Every move and every choice made inside it, in order: enough to replay the game exactly. */
export interface TraceStep { by: Side; a: Action; picks: number[][]; label: string; turn: number }

export interface GameRecord {
  /** 2: decks are built in sorted card order (1: in the order the lists were written). */
  version: 1 | 2;
  you: Decklist;
  ai: Decklist;
  level: PlayLevel;
  seed: number;
  first: Side;
  winner: Side | -1;
  reason: string;
  turns: number;
  trace: TraceStep[];
  /** Moves you took back: where, and what they were. */
  undos?: { atMove: number; label: string; undidEnding?: { winner: Side | -1; reason: string; turn: number } }[];
}

class NeedChoice {
  constructor(public req: ChoiceReq, public options: ChoiceOption[], public snap: Snap, public prompt: string, public detail: string) {}
}

const ZONE_LABEL: Record<string, string> = { hand: 'hand', battle: 'Battle Area', energy: 'energy', drop: 'Drop', life: 'life', deck: 'deck', combo: 'combo', leader: 'Leader', field: 'field', under: 'under a card' };

function zoneOf(s: GameState, u: number): string {
  for (const p of [0, 1] as Side[]) {
    const pl = s.p[p];
    const mine = p === 0 ? 'your' : "AI's";
    if (pl.leader === u) return `${mine} Leader`;
    if (pl.field === u) return `${mine} field`;
    for (const z of ['hand', 'battle', 'energy', 'drop', 'life', 'deck', 'combo'] as const) if ((pl[z] as number[]).includes(u)) return `${mine} ${ZONE_LABEL[z]}`;
  }
  return '';
}

const PROMPT: Record<ChoiceReq['kind'], string> = {
  target: 'Choose', discard: 'Choose cards to discard', pick: 'Choose', energyToDrop: 'Choose energy to place in the Drop', yesno: 'Use this?', mode: 'Choose one',
};

/** Records every choice either player makes, so the move can be replayed exactly. */
class Rec implements Chooser {
  constructor(private inner: Chooser, private out: number[][]) {}
  choose(s: GameState, req: ChoiceReq): number[] {
    const p = this.inner.choose(s, req);
    this.out.push(p.slice());
    return p;
  }
}

/** The person's choices: answers given so far, then a question. */
class HumanChooser implements Chooser {
  k = 0;
  constructor(private answers: number[][]) {}
  choose(s: GameState, req: ChoiceReq): number[] {
    if (this.k < this.answers.length) return this.answers[this.k++];
    const n = (u: number) => nameOf(s, u);
    const options: ChoiceOption[] = req.kind === 'mode'
      ? req.options.map((i) => ({ v: i, label: req.effect && (req.effect as any).options?.[i] ? (req.effect as any).options[i].map((e: any) => describeEffect(e)).join(', then ') : `Option ${i + 1}` }))
      : req.kind === 'yesno' ? [{ v: 1, label: 'Yes' }]
      : req.options.map((u) => ({ v: u, label: n(u), id: s.inst[u].id, where: zoneOf(s, u) }));
    const src = s.inst[req.src];
    const what = req.effect ? describeEffect(req.effect as any) : '';
    const prompt = `${src ? nameOf(s, req.src) + ': ' : ''}${PROMPT[req.kind]}${req.kind === 'yesno' || req.kind === 'mode' ? '' : req.min === req.max ? ` ${req.max}` : ` ${req.min}–${req.max}`}`;
    throw new NeedChoice(req, options, snapshot(s), prompt, what);
  }
}

function actionDetail(s: GameState, a: Action): string | undefined {
  if (a.k === 'activate' || a.k === 'counter' || a.k === 'battleSkill') {
    const ab = compileCard(cardOf(s, a.uid)).abilities[a.ab] ?? (s.p[s.inst[a.uid].owner].awakened && isLeader(s, a.uid) ? compileCard(cardOf(s, a.uid)).backAbilities?.[a.ab] : undefined);
    return ab ? describeAbility(ab) : undefined;
  }
  return undefined;
}

const GROUP: Partial<Record<Action['k'], string>> = {
  keep: 'Opening hand', mulligan: 'Opening hand', charge: 'Charge', noCharge: 'Charge', play: 'Play', evolve: 'Evolve', activate: 'Skills', awaken: 'Skills',
  attack: 'Attack', end: 'End', counter: 'Counter', noCounter: 'Counter', block: 'Block', noBlock: 'Block', combo: 'Combo', battleSkill: 'Battle skills', comboDone: 'Combo',
};

export class PlayHost {
  real: GameState;
  trace: TraceStep[] = [];
  private ai: Policy;
  private answers: number[][] = [];
  /** The move waiting on the person's choice, and who made it. */
  private pending: { a: Action; by: Side } | null = null;
  private question: NeedChoice | null = null;
  private aiMoves: string[] = [];
  private aiTurn: { turn: number; moves: { label: string; lines: string[] }[] } = { turn: -1, moves: [] };
  /** The game before each of your moves, for undo. */
  private history: { real: GameState; trace: number; aiMoves: string[]; aiTurn: { turn: number; moves: { label: string; lines: string[] }[] } }[] = [];
  private undos: NonNullable<GameRecord['undos']> = [];
  readonly first: Side;
  /** Testing: a snapshot after every move. */
  debug?: string[];

  constructor(private cards: Record<string, Card>, private o: PlayOpts) {
    const first: Side = o.youFirst === null ? ((o.seed >>> 3) & 1 ? 1 : 0) : o.youFirst ? 0 : 1;
    this.first = first;
    this.real = newGame(cards, [o.you, o.ai], { seed: o.seed, first, log: true, rules: o.rules });
    this.ai = new SearchPolicy(SEARCH_LEVELS[o.level]);
  }

  /** Run one move on a copy; keep it if it finished, else hold the question. */
  private fresh(): GameState {
    const work = cloneState(this.real);
    work.log = this.real.log ? this.real.log.slice() : [];
    return work;
  }

  private tryStep(a: Action, by: Side, work = this.fresh()): boolean {
    const picks: number[][] = [];
    const human = new Rec(new HumanChooser(this.answers), picks);
    const machine = new Rec(defaultChooser, picks);
    const label = describeAction(this.real, a);
    try {
      step(work, a, [human, machine]);
    } catch (e) {
      if (e instanceof NeedChoice) { this.pending = { a, by }; this.question = e; return false; }
      throw e;
    }
    this.trace.push({ by, a, picks, label, turn: this.real.turn });
    this.debug?.push(JSON.stringify(snapshot(work)));
    if (by === 1) {
      this.aiMoves = [...this.aiMoves, `T${this.real.turn}: ${label}`].slice(-6);
      const before = this.real.log?.length ?? 0;
      const lines = (work.log ?? []).slice(before).map((l) => l.replace(/^T\d+ /, '').replace(/\bP0\b/g, 'You').replace(/\bP1\b/g, 'AI'))
        .filter((l) => !/^AI (attacks|plays|charges|uses|evolves|awakens)\b/.test(l) && !/skill resolves$/.test(l));
      // A new turn of the AI's (or a move during your turn, like a combo) starts a new recap.
      if (this.aiTurn.turn !== this.real.turn) this.aiTurn = { turn: this.real.turn, moves: [] };
      if (!/stops adding combo cards|charges nothing|does not (block|counter)/.test(label) || lines.length) this.aiTurn.moves.push({ label, lines });
    }
    this.real = work;
    this.pending = null;
    this.question = null;
    this.answers = [];
    return true;
  }

  /** Let the AI move until it's the person's turn to decide (or the game ends). */
  advance(budget = 400): PlayView {
    while (!this.question && this.real.stage !== 'over' && this.real.toAct === 1 && budget-- > 0) {
      if (!this.aiMove()) break;
    }
    return this.view();
  }

  /** The AI's next move only (so the page can show progress between AI moves). */
  aiStep(): PlayView {
    if (this.aiToMove()) this.aiMove();
    return this.view();
  }

  /** The AI plans on the same copy it moves on, so its planned in-skill choices apply. */
  private aiMove(): boolean {
    const work = this.fresh();
    const legal = legalActions(work);
    if (!legal.length) return false;
    // The search draws from the game's random seed while it imagines; put it back so the
    // real game (and its replay) doesn't depend on how much the AI thought.
    const seed = work.seed;
    const a = this.ai.act(work, legal);
    work.seed = seed;
    return this.tryStep(a, 1, work);
  }

  /** The person picks option i of the current action list. */
  act(i: number): PlayView {
    if (this.question || this.real.toAct !== 0) return this.view();
    const legal = legalActions(this.real);
    const a = legal[i];
    if (a) {
      this.history.push({ real: this.fresh(), trace: this.trace.length, aiMoves: this.aiMoves.slice(), aiTurn: { turn: this.aiTurn.turn, moves: this.aiTurn.moves.slice() } });
      if (this.history.length > 60) this.history.shift();
      this.tryStep(a, 0);
    }
    return this.view();
  }

  /** Take back your last move (and whatever the AI did after it), or cancel a move waiting on a choice. */
  undo(): PlayView {
    if (this.question && this.pending?.by === 0) {
      this.undos.push({ atMove: this.trace.length, label: `cancelled: ${describeAction(this.real, this.pending.a)}` });
      this.question = null; this.pending = null; this.answers = [];
      // The move never happened, so the board is as it was; drop the history entry it pushed.
      this.history.pop();
      return this.view();
    }
    const h = this.history.pop();
    if (!h) return this.view();
    const ended = this.real.stage === 'over' ? { undidEnding: { winner: this.real.winner, reason: this.real.reason, turn: this.real.turn } } : {};
    this.undos.push({ atMove: h.trace, label: this.trace[h.trace]?.label ?? '', ...ended });
    this.real = h.real;
    this.trace = this.trace.slice(0, h.trace);
    this.aiMoves = h.aiMoves;
    this.aiTurn = h.aiTurn;
    this.question = null; this.pending = null; this.answers = [];
    return this.view();
  }

  /** The person answers the pending question. */
  answer(picks: number[]): PlayView {
    if (!this.question || !this.pending) return this.view();
    this.answers = [...this.answers, picks];
    const { a, by } = this.pending;
    this.question = null;
    this.tryStep(a, by);
    return this.view();
  }

  /**
   * Advice for the person's current decision: the engine searches from their seat (guessing the
   * AI's hidden cards, never reading them) and ranks their options; plus the position in words.
   */
  advise(level: PlayLevel = 'strong'): Advice {
    const s = this.real;
    if (this.question || s.stage === 'over' || s.toAct !== 0) {
      return { context: describePosition(s, [], this.question?.prompt ?? null), ranked: [], lines: false };
    }
    const legal = legalActions(s);
    const work = cloneState(s);
    const pol = new SearchPolicy(SEARCH_LEVELS[level]);
    pol.lastStats = []; pol.lastLines = [];
    if (legal.length > 1) pol.act(work, legalActions(work));
    let ranked: Advice['ranked'] = [];
    let lines = false;
    if (pol.lastLines.length) {
      lines = true;
      ranked = pol.lastLines.slice(0, 5).map((l) => ({ label: l.actions.filter((x) => x.k !== 'end').map((x) => describeAction(s, x)).join(' → ') || 'end the turn', value: l.value }));
    } else if (pol.lastStats.length) {
      ranked = pol.lastStats.map((x) => ({ label: describeAction(s, x.action), value: x.value })).sort((a, b) => b.value - a.value).slice(0, 5);
    } else if (legal.length === 1) {
      ranked = [{ label: describeAction(s, legal[0]), value: NaN }];
    }
    return { context: describePosition(s, legal, null), ranked, lines };
  }

  aiToMove(): boolean { return !this.question && this.real.stage !== 'over' && this.real.toAct === 1; }

  view(): PlayView {
    const s = this.real;
    let decision: Decision | null = null;
    let snap = snapshot(s);
    if (this.question) {
      const q = this.question;
      snap = q.snap;
      decision = { kind: 'choice', prompt: q.prompt, detail: q.detail, min: q.req.min, max: q.req.max, options: q.options, srcId: s.inst[q.req.src]?.id };
    } else if (s.stage !== 'over' && s.toAct === 0) {
      const legal = legalActions(s);
      const label = (a: Action) => a.k === 'combo' ? `${describeAction(s, a)}${s.p[0].hand.includes(a.uid) ? ' from your hand' : ' from your Battle Area (it leaves the board)'} (+${(cardOf(s, a.uid).comboPower / 1000) | 0}k)` : describeAction(s, a);
      decision = { kind: 'action', options: legal.map((a, i) => ({ i, label: label(a), group: GROUP[a.k] ?? 'Other', detail: actionDetail(s, a) })) };
      if (s.battle && (s.stage === 'offCombo' || s.stage === 'defCombo' || s.stage === 'counter' || s.stage === 'block')) {
        const { atk, def } = battleTotals(s);
        decision.battle = { atk, def, youAttack: s.battle.atkSide === 0 };
      }
    }
    const aiHand = snap.p[1].hand.length;
    snap = { ...snap, p: [snap.p[0], { ...snap.p[1], hand: [] }] };
    return {
      snap,
      aiHand,
      log: (s.log ?? []).slice(-60),
      turn: s.turn,
      moves: this.trace.length,
      decision,
      over: s.stage === 'over' ? { winner: s.winner, reason: s.reason } : null,
      aiMoves: this.aiMoves,
      aiTurn: this.aiTurn.moves.slice(-14),
      canUndo: (!!this.question && this.pending?.by === 0) || this.history.length > 0,
    };
  }

  record(): GameRecord {
    const s = this.real;
    return { version: 2, you: this.o.you, ai: this.o.ai, level: this.o.level, seed: this.o.seed, first: this.first, winner: s.winner, reason: s.reason, turns: s.turn, trace: this.trace, ...(this.undos.length ? { undos: this.undos } : {}) };
  }
}

export interface Advice {
  /** The position from your side, in words, with every visible card's printed text. */
  context: string;
  /** The engine's ranking of your options (searched from your seat, guessing the AI's hidden hand). */
  ranked: { label: string; value: number }[];
  /** Whole turns when it's your main phase. */
  lines: boolean;
}

/** The position as the person sees it: nothing hidden from them is included. */
function describePosition(s: GameState, legal: Action[], question: string | null): string {
  const seen = new Set<string>();
  const card = (u: number) => {
    const c = cardOf(s, u), i = s.inst[u];
    seen.add(i.id);
    return `${nameOf(s, u)} [${i.id}] ${powerOf(s, u)} power${i.rested ? ', rested' : ''}${i.ki ? `, ${i.ki} Ki` : ''}${i.under?.length ? `, ${i.under.length} under it` : ''}`;
  };
  const handCard = (u: number) => { const c = cardOf(s, u); seen.add(c.id); return `${c.name} [${c.id}] cost ${c.cost}, ${c.power} power, combo +${c.comboPower}`; };
  const side = (p: Side) => {
    const pl = s.p[p], who = p === 0 ? 'YOU' : 'THE AI';
    const rested = pl.energy.filter((u) => s.inst[u].rested).length;
    return [
      `${who}: Leader ${card(pl.leader)}${pl.awakened ? ' (awakened)' : ''}; life ${pl.life.length}; energy ${pl.energy.length - rested} active of ${pl.energy.length}${pl.markers ? `, ${pl.markers} energy marker` : ''}; deck ${pl.deck.length}`,
      `  Battle Area: ${pl.battle.length ? pl.battle.map(card).join('; ') : 'empty'}`,
      p === 0 ? `  Hand (${pl.hand.length}): ${pl.hand.map(handCard).join('; ') || 'empty'}` : `  Hand: ${pl.hand.length} cards (hidden from you)`,
      `  Drop (${pl.drop.length}): ${pl.drop.map((u) => s.inst[u].id).map((id) => s.cards[id].name).join(', ') || 'empty'}`,
      ...(pl.energy.length ? [`  Energy: ${pl.energy.map((u) => s.cards[s.inst[u].id].name).join(', ')}`] : []),
    ].join('\n');
  };
  const b = s.battle;
  const battle = b ? (() => { const t = battleTotals(s); return `Current battle: ${b.atkSide === 0 ? 'your' : "the AI's"} ${nameOf(s, b.attacker)} attacks ${nameOf(s, b.target)}: attack ${t.atk} vs defence ${t.def} (ties go to the attacker).`; })() : '';
  const texts = [...seen].map((id) => { const c = s.cards[id]; return `${c.name} [${id}]: ${c.text || '(no skill)'}${c.back ? ` || Awakened: ${c.back.text}` : ''}`; });
  return [
    `Turn ${s.turn}, ${s.active === 0 ? 'your' : "the AI's"} turn, stage: ${s.stage}. You went ${s.first === 0 ? 'first' : 'second'}.`,
    side(0), side(1), battle,
    question ? `You are being asked: ${question}` : `Your legal moves now: ${legal.map((a) => describeAction(s, a)).join(' | ')}`,
    `Recent log:\n${(s.log ?? []).slice(-16).map((l) => l.replace(/\bP0\b/g, 'You').replace(/\bP1\b/g, 'AI')).join('\n')}`,
    `Printed text of the visible cards:\n${texts.join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

/** Rebuild a recorded game move by move (for Claude's review): returns the state before each move. */
export function replayRecord(cards: Record<string, Card>, r: GameRecord, rules?: RulesConfig): GameState[] {
  let s = newGame(cards, [r.you, r.ai], { seed: r.seed, first: r.first, log: true, rules, listedOrder: r.version === 1 });
  const states: GameState[] = [];
  for (const t of r.trace) {
    states.push(cloneState(s));
    const picks = t.picks.slice();
    const forced: Chooser = { choose: (st, req) => picks.shift() ?? defaultChooser.choose(st, req) };
    step(s, t.a, [forced, forced]);
  }
  states.push(s);
  return states;
}

export const whoLabel = (p: Side) => (p === 0 ? 'You' : 'AI');
export { other };
