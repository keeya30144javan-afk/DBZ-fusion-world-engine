import { Color } from '../data/types';

/**
 * The card-skill language. Every card is compiled (by the text parser, or a
 * translation written by Claude) into these JSON-serialisable structures, and
 * the engine runs only these. A skill the language cannot express is kept as
 * text in `unparsed` so coverage is always measured, never assumed.
 */

export type Timing =
  | 'onPlay'
  | 'whenAttacking'
  | 'whenAttacked'
  | 'whenKOd'
  | 'whenBlocking'
  | 'activateMain'
  | 'activateBattle'
  | 'counter'
  | 'permanent'
  | 'endOfYourTurn'
  | 'startOfYourTurn'
  | 'awaken'
  | 'comboFromHand'
  /** [Auto] "When this card is used in a combo from the Battle Area". */
  | 'comboFromField'
  /** [Auto] "When you take damage". */
  | 'whenDamaged'
  /** [Auto] "When your Battle Card ... is played" (filter in `trigger`). */
  | 'whenAllyPlayed'
  /** [Auto] "When this card is placed from your deck into your Drop". */
  | 'whenMilled'
  /** [Auto] "When this card is placed in your Leader Area" (game start). */
  | 'gameStart'
  | 'auto';

export type Duration = 'battle' | 'turn' | 'oppNextTurn' | 'static' | 'game';

export interface Filter {
  costLE?: number;
  costGE?: number;
  costEQ?: number;
  /** Printed cost, ignoring cost changes ("original cost"). */
  originalCost?: boolean;
  powerLE?: number;
  powerGE?: number;
  powerEQ?: number;
  rested?: boolean;
  active?: boolean;
  /** Card name contains any of these ("<Son Goku>"). */
  names?: string[];
  /** "non-<X>" / "other than <X>". */
  notNames?: string[];
  /** Has any of these special traits. */
  traits?: string[];
  /** Has every one of these special traits ("both ≪A≫ and ≪B≫"). */
  traitsAll?: string[];
  /** "≪X≫-only": its special traits are exactly these. */
  onlyTraits?: string[];
  colors?: Color[];
  type?: 'BATTLE' | 'EXTRA';
  other?: boolean;
  /** Has this keyword ("a card with [Evolve]", "with [Blocker]"). */
  keyword?: Keyword | 'evolve' | 'fusionEvolve';
  /** "skill-less". */
  noSkill?: boolean;
  /** Has at least N Ki. */
  kiGE?: number;
  /** Lacks all of these special traits ("without Special Trait ≪X≫"). */
  notTraits?: string[];
  /** Has a card with one of these names under it ("with a <Potara> under them"). */
  underNames?: string[];
  /** Matches if any of these filters match ("<Sorbet> or a Battle Card with a cost of 1"). */
  anyOf?: Filter[];
}

export interface Target {
  side: 'opp' | 'self' | 'any';
  /**
   * 'this' = the card with the skill; 'prev' = what the previous effect chose;
   * 'leader' = your Leader; 'oppLeader' = the opponent's Leader;
   * 'battler' = your card that's in the current battle;
   * 'oppBattler' = the opponent's card in the current battle.
   */
  ref?: 'this' | 'prev' | 'leader' | 'oppLeader' | 'battler' | 'oppBattler';
  zones: ('leader' | 'battle' | 'field')[];
  count: number;
  upTo: boolean;
  /** "Choose all ...". */
  all?: boolean;
  /** Who makes the choice: 'opp' for "your opponent KO's 1 Battle Card in their Battle Area". */
  chooser?: 'opp';
  filter: Filter;
}

/** Something to count, for "for each ..." and count conditions. */
export interface Count {
  side: 'self' | 'opp';
  zone: 'battle' | 'drop' | 'hand' | 'energy' | 'life' | 'deck' | 'combo' | 'under';
  filter?: Filter;
}

type E<T> = T & { cond?: Cond[] };

export type Effect = E<
  | { t: 'draw'; n: number }
  | { t: 'lifeToHand'; n: number; upTo: boolean }
  | { t: 'power'; target: Target; amount: number; dur: Duration; per?: Count }
  | { t: 'comboPower'; target: Target; amount: number }
  | { t: 'ko'; target: Target }
  | { t: 'bounce'; target: Target }
  | { t: 'bottom'; target: Target }
  /** Place a card from a Battle Area into its owner's Drop (not a KO). */
  | { t: 'toDrop'; target: Target }
  /** Add a card from a Battle Area to its owner's energy. */
  | { t: 'toEnergy'; target: Target; rested: boolean }
  | { t: 'rest'; target: Target }
  | { t: 'activate'; target: Target }
  | { t: 'lockActive'; target: Target }
  | { t: 'grant'; target: Target; kw: Keyword; dur: Duration }
  /** Change the cost of a card in play ("reduce its cost by 1 for the turn"). */
  | { t: 'costMod'; target: Target; amount: number; dur: Duration }
  /**
   * Look at the top `look` cards; take up to `take` matching any option.
   * dest: where the taken cards go; rest: where the others go.
   */
  | { t: 'search'; look: number; options: Filter[]; take: number; toHand: boolean; dest?: 'hand' | 'play' | 'drop' | 'life'; rest?: 'bottom' | 'drop' | 'top' }
  | { t: 'dropToHand'; options: Filter[]; each: number }
  | { t: 'playFrom'; from: 'drop' | 'hand' | 'deck' | 'energy'; filter: Filter; n: number; rested?: boolean; extraType?: boolean }
  | { t: 'energyFromDeck'; n: number; rested: boolean }
  | { t: 'energyFromDrop'; filter: Filter; n: number; rested: boolean }
  | { t: 'energyFromLife'; n: number; rested: boolean }
  | { t: 'energyFromHand'; n: number; rested: boolean; filter?: Filter }
  | { t: 'activateEnergy'; n: number }
  | { t: 'discard'; n: number }
  | { t: 'oppDiscard'; n: number }
  | { t: 'mill'; n: number }
  | { t: 'costReduce'; n: number }
  | { t: 'cantBlock' }
  | { t: 'damageLeader'; n: number }
  | { t: 'flipLeader' }
  /** Place N energy markers from outside the game under the target as Ki (manual p.12). */
  | { t: 'ki'; target: Target; n: number }
  /** "you place 1 energy marker". */
  | { t: 'placeMarker'; n: number }
  /** Top card(s) of your deck to your life. */
  | { t: 'lifeFromDeck'; n: number }
  /** Card(s) from your hand to your life. */
  | { t: 'handToLife'; n: number; upTo: boolean }
  /** Card(s) from your hand on top of (or under) your deck. */
  | { t: 'handToDeck'; n: number; bottom?: boolean }
  /** Move the card with this skill. */
  | { t: 'self'; to: 'hand' | 'drop' | 'energy' | 'deckBottom' | 'play'; rested?: boolean }
  /** "During this turn, the next time you use <filter>, reduce its cost by N / you don't pay the cost." */
  | { t: 'nextDiscount'; filter: Filter; amount: number | 'free' }
  /** "You can't play <filter> for the turn" (applies to the skill's owner). */
  | { t: 'cantPlay'; filter: Filter; dur: Duration; extras?: boolean }
  /** Your opponent's cards cost more / their Battle Cards enter rested, until their next turn ends. */
  | { t: 'oppTax'; amount: number; filter?: Filter }
  | { t: 'oppPlayRested'; filter: Filter }
  /** Place cards under a card in play (evolve stacks, Potara, Majin absorption). */
  | { t: 'placeUnder'; target: Target; from: 'drop' | 'hand' | 'deck' | 'battle'; filters: Filter[]; n: number }
  /** Choose one of several effect lists. */
  | { t: 'choose'; options: Effect[][] }
  /** Use cards from a zone in the current battle's combo. */
  | { t: 'comboFrom'; from: 'drop' | 'deckTop'; filter: Filter; n: number }
  /** Run these effects at the end of the current turn ("at the end of the turn, switch this card to Active Mode"). */
  | { t: 'atEndOfTurn'; effects: Effect[] }
  /** "You can't activate the [Activate:Main] of <X> for the turn." */
  | { t: 'lockSkill'; names: string[]; timing: 'activateMain' | 'activateBattle'; dur: Duration }
  /** Return every card in your Drop to your deck and shuffle. */
  | { t: 'dropToDeck' }
  /** Look through your life and place N of those cards on top of your deck. */
  | { t: 'lifeToDeck'; n: number }
  /** Reveal/rearrange deck or shuffle: no effect the simulator models. */
  | { t: 'noop'; note: string }
>;

export type Cost =
  | { t: 'discard'; n: number; filter?: Filter }
  | { t: 'energyToDrop'; n: number }
  | { t: 'restSelf' }
  | { t: 'restEnergy'; n: number }
  | { t: 'selfToDrop' }
  | { t: 'selfToHand' }
  | { t: 'selfToDeckBottom' }
  | { t: 'koSelf' }
  | { t: 'lifeToHand'; n: number }
  | { t: 'lifeToDrop'; n: number }
  /** Remove N Ki. 'your' = leader and Battle Cards, 'battle' = Battle Cards only (manual p.12). */
  | { t: 'reduceKi'; n: number; scope: 'this' | 'leader' | 'your' | 'battle' }
  /** KO / rest / drop / bounce N of your own cards in play matching filter. */
  | { t: 'koOwn'; n: number; filter: Filter }
  | { t: 'restOwn'; n: number; filter: Filter }
  | { t: 'dropOwn'; n: number; filter: Filter }
  | { t: 'bounceOwn'; n: number; filter: Filter }
  /** N cards from your hand on top of your deck. */
  | { t: 'handToDeckTop'; n: number }
  | { t: 'mill'; n: number }
  /** Reveal a card from hand (must exist). */
  | { t: 'reveal'; filter: Filter }
  /** Remove N cards from under your cards (filter on the card above). */
  | { t: 'underToDrop'; n: number; filter?: Filter }
  /** Place N cards from your Drop at the bottom of your deck. */
  | { t: 'dropToDeck'; n: number; filter?: Filter }
  /** Place a card from your hand under one of your cards in play. */
  | { t: 'handToUnder'; filter: Filter; onto: Filter }
  /** Switch one of your Rest Mode cards in play to Active Mode. */
  | { t: 'activateOwn'; filter: Filter };

export type Cond =
  | { t: 'handLE'; n: number }
  | { t: 'handGE'; n: number }
  | { t: 'energyGE'; n: number }
  | { t: 'energyLE'; n: number }
  | { t: 'lifeLE'; n: number }
  | { t: 'lifeGE'; n: number }
  | { t: 'oppLifeLE'; n: number }
  | { t: 'oppLifeGE'; n: number }
  | { t: 'oppHandGE'; n: number }
  | { t: 'dropGE'; n: number }
  | { t: 'battleCount'; op: 'none' | 'ge'; n: number; filter: Filter; side: 'self' | 'opp' }
  /** General count: matching cards in a zone vs n. */
  | { t: 'count'; what: Count; op: 'ge' | 'le' | 'eq' | 'none'; n: number }
  | { t: 'leaderIs'; names: string[] }
  | { t: 'leaderTrait'; traits: string[]; only?: boolean }
  | { t: 'leaderAwakened' }
  | { t: 'kiLeaderGE'; n: number }
  | { t: 'kiTotalGE'; n: number; scope: 'your' | 'battle' }
  | { t: 'thisKiGE'; n: number }
  /** Energy markers: has at least one / has none. */
  | { t: 'hasMarker'; yes: boolean }
  | { t: 'thisRested'; yes: boolean }
  | { t: 'thisInBattle' }
  | { t: 'playedThisTurn' }
  | { t: 'comboAreaHasCard' }
  | { t: 'energyLessThanOpp' }
  | { t: 'attackingBattleCard'; filter?: Filter }
  /** The card(s) the previous effect chose match a filter ("if that card has a cost of 2 or less"). */
  | { t: 'prevMatches'; filter: Filter }
  | { t: 'yourTurn'; yes: boolean }
  /** This card has cards under it / none. */
  | { t: 'thisHasUnder'; yes: boolean }
  /** This card is attacking a card (Leader or Battle Card) that matches. */
  | { t: 'attacking'; filter: Filter }
  /** One of your cards matching filter KO'd an opponent's Battle Card this turn. */
  | { t: 'koedThisTurn'; filter?: Filter }
  /** This card was played by your Leader's skill. */
  | { t: 'playedByLeaderSkill' }
  | { t: 'leaderInBattle' }
  | { t: 'not'; c: Cond }
  | { t: 'or'; any: Cond[] };

export type Keyword =
  | 'blocker' | 'critical' | 'doubleStrike' | 'tripleStrike' | 'superCombo' | 'barrier' | 'indestructible' | 'field' | 'dragonBall'
  | 'cantAttack' | 'cantAttackLeader' | 'cantBlock'
  /** Can't be KO'd by the opponent's skills. */
  | 'koImmuneSkills'
  /** Can't be KO'd (by battle or skill). */
  | 'koImmune'
  /** Can't be KO'd once per turn. */
  | 'koImmuneOnce'
  /** Can't be removed from the Battle Area by the opponent's skills. */
  | 'removeImmune'
  | 'cantBeRested'
  /** May attack the opponent's Active Mode Battle Cards. */
  | 'attackActive';

/** [Evolve] / [Fusion Evolve]: play on top of the specified card(s) for `cost` energy. */
export interface EvolveSpec {
  /** One filter for Evolve, two for Fusion Evolve. */
  from: Filter[];
  cost: number;
  /** Fusion Evolve: both cards have equal power of at least this much. */
  equalPowerGE?: number;
  /** Evolve: other cards it may also be played on ("<A> with a cost of 3, or <B> with a <Potara> under them"). */
  orFrom?: Filter[];
  /** Fusion Evolve: the two cards must be in Rest Mode / Active Mode. */
  baseMode?: 'rested' | 'active';
}

export interface Ability {
  timing: Timing;
  turn?: 'your' | 'opp';
  once: boolean;
  cost: Cost[];
  cond: Cond[];
  effects: Effect[];
  text: string;
  /** Further timing tags sharing this body, e.g. [On Play/When Attacking]. */
  alsoTimings?: Timing[];
  /** For 'whenAllyPlayed': which of your cards. */
  trigger?: Filter;
  /** Sentences of this ability we could not translate. */
  unparsed: string[];
}

export interface CompiledCard {
  keywords: Set<Keyword>;
  abilities: Ability[];
  backKeywords?: Set<Keyword>;
  backAbilities?: Ability[];
  evolve?: EvolveSpec;
  /** Fraction of skill sentences translated, 0..1 (1 for vanilla cards). */
  coverage: number;
  unparsed: string[];
  /** Where this compilation came from. */
  source?: 'parser' | 'claude' | 'verified';
  /** Mechanics the engine still lacks for this card. */
  needs?: string[];
}

/** A stored translation of one card (JSON form of CompiledCard). */
export interface CardScript {
  /** Hash of the card text it was written for; a reprint/errata invalidates it. */
  textHash: string;
  keywords: Keyword[];
  abilities: Ability[];
  backKeywords?: Keyword[];
  backAbilities?: Ability[];
  evolve?: EvolveSpec;
  /** Sentences that could not be expressed. */
  unparsed: string[];
  needs?: string[];
  source: 'claude' | 'verified';
  /** Plain-English reading of the script, for review. */
  reading?: string;
  /** Second-pass judgement: does the reading match the printed text? */
  check?: { ok: boolean; note?: string };
  updated?: string;
}
