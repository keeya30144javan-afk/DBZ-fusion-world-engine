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
  /** [Auto] "When this card inflicts damage with an attack". */
  | 'whenDealsDamage'
  /** [Auto] "When your <X> attacks" (filter in `trigger`; not this card). */
  | 'whenAllyAttacks'
  /** [Auto] "When you use a card in a combo while this card is in a battle". */
  | 'whenComboInBattle'
  /** [Auto] "When this card is used in a combo from your Drop". */
  | 'comboFromDrop'
  /** [Auto] "When your <X> is KO'd" (filter in `trigger`). */
  | 'whenAllyKOd'
  /** [Auto] "When this card KO's an opponent's Battle Card in battle". */
  | 'whenKOsInBattle'
  /** [Auto] "When this card wins a battle". */
  | 'whenWinsBattle'
  /** [Auto] "When an opponent's Battle Card attacks" (on the defending player's cards). */
  | 'whenOppAttacks'
  /** [Auto] "When your <X> is removed from the Battle Area by one of your skills" (filter in `trigger`). */
  | 'whenAllyRemovedBySelf'
  /** [Auto] "When your <X> is removed from the Battle Area by your opponent" (filter in `trigger`). */
  | 'whenAllyRemovedByOpp'
  /** [Auto] "When an opponent's Battle Card is returned to their hand by one of your skills". */
  | 'whenOppBounced'
  /** [Auto] "When a card is placed in your Drop from your energy" (cond causedByLeader for "by your Leader's skill"). */
  | 'whenEnergyToDrop'
  /** [Auto] "When your opponent plays a Battle Card" (filter in `trigger`). */
  | 'whenOppPlays'
  /** [Auto] "When this card is switched to Active Mode by a skill". */
  | 'whenActivated'
  /** [Auto] "When one of your Battle Cards is switched to Active Mode by a skill" (filter in `trigger`). */
  | 'whenAllyActivated'
  /** [Auto] "When a card is used in a combo from your Battle Area while this card is in a battle". */
  | 'whenFieldComboInBattle'
  /** [Auto] "When you discard a card from your hand using the skill of <trigger>"; count with zone 'event'. */
  | 'whenDiscardBySkill'
  /** [Auto] "When your card deals damage" / "KO's your opponent's Battle Card in battle" (any of your cards). */
  | 'whenAllyDealsDamage'
  | 'whenAllyKOsInBattle'
  /** [Auto] "When this card is switched to Rest Mode by one of your skills". */
  | 'whenRestedBySelf'
  /**
   * Replacement: "If <replace.what> would be <removed/KO'd> by <replace.by>, [you may] <cost> instead."
   * The costs are paid instead of the removal; effects then run (e.g. KO this card instead).
   */
  | 'replace'
  | 'auto';

export type Duration = 'battle' | 'turn' | 'oppNextTurn' | 'static' | 'game';

/** A number worked out while a skill resolves ("a cost less than or equal to the card chosen by this skill"). */
export interface Val {
  /**
   * prevCost/prevPower = the card the previous step chose (or the cost paid with); kiRemoved = Ki removed by this skill's cost;
   * revealedCost = the card revealed by this skill; thisCost = the card with the skill; energy = your energy count;
   * count = a Count; totalCost = combined cost of your Battle Area cards matching `filter`.
   */
  of: 'prevCost' | 'prevPower' | 'kiRemoved' | 'revealedCost' | 'thisCost' | 'energy' | 'count' | 'totalCost' | 'leaderKi';
  count?: Count;
  filter?: Filter;
  plus?: number;
}

export interface Filter {
  costLE?: number;
  costGE?: number;
  costEQ?: number;
  /** Printed cost, ignoring cost changes ("original cost"). */
  originalCost?: boolean;
  /** Printed power, ignoring power changes ("original power"). */
  originalPower?: boolean;
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
  /** Printed combo power at most / exactly N. */
  comboLE?: number;
  comboEQ?: number;
  /** Lacks all of these special traits ("without Special Trait ≪X≫"). */
  notTraits?: string[];
  /** Has a card with one of these names under it ("with a <Potara> under them"). */
  underNames?: string[];
  /** Matches if any of these filters match ("<Sorbet> or a Battle Card with a cost of 1"). */
  anyOf?: Filter[];
  /** Cost / power compared with a value worked out during the skill. */
  costLEv?: Val;
  costEQv?: Val;
  powerLEv?: Val;
  /** Was played from this zone (this turn or earlier, while it stays in play). */
  playedFrom?: 'hand' | 'drop' | 'deck' | 'life' | 'energy';
  /** Was played this turn. */
  playedThisTurn?: boolean;
  /** Shares a special trait with the card the previous step chose. */
  sharesTraitWithPrev?: boolean;
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
  /** "Battle Cards whose costs add up to N or less" / "a total power of N or less". */
  totalCostLE?: number;
  totalPowerLE?: number;
}

/** Something to count, for "for each ..." and count conditions. */
export interface Count {
  side: 'self' | 'opp';
  /**
   * thisKi = Ki on the card with the skill; kiTotal = Ki on your Leader and Battle Cards;
   * kiRemoved = Ki removed by this skill's cost; prev = cards the previous effect affected;
   * underMax = cards under the one of your Battle Cards (matching filter) with the most ("choose 1 ... for each card under that card").
   */
  zone: 'battle' | 'drop' | 'hand' | 'energy' | 'life' | 'deck' | 'combo' | 'under' | 'thisKi' | 'kiTotal' | 'kiRemoved' | 'prev' | 'underMax'
    /** battleDrop = Battle Area and Drop together; event = how many cards the triggering event moved; thisKiRemovedBattle = Ki removed from this card during this battle. */
    | 'battleDrop' | 'event' | 'thisKiRemovedBattle'
    /** Your Leader and Battle Cards together ("among your Leader and Battle Cards"). */
    | 'leaderBattle';
  filter?: Filter;
  /** Count different card names ("types of cards") instead of cards. */
  distinct?: boolean;
}

type E<T> = T & { cond?: Cond[] };

export type Effect = E<
  | { t: 'draw'; n: number; per?: Count }
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
  | { t: 'costMod'; target: Target; amount: number; dur: Duration; per?: Count; /** [Permanent] on this card: also applies while it is in the deck. */ inDeck?: boolean }
  /**
   * Look at the top `look` cards; take up to `take` matching any option.
   * dest: where the taken cards go; rest: where the others go.
   */
  | { t: 'search'; look: number; options: Filter[]; take: number; toHand: boolean; /** "Look through your deck and life": the life is searched too, then deck and life are shuffled. */ withLife?: boolean; dest?: 'hand' | 'play' | 'drop' | 'life'; rest?: 'bottom' | 'drop' | 'top' | 'hand'; rested?: boolean; negate?: 'all' | 'onPlay'; fromBottom?: boolean; /** "up to 1 <A> and up to 1 <B>": one card per option. */ eachOption?: boolean }
  /** `per`: take up to `each` for each counted thing; distinctCosts: all with different costs. */
  | { t: 'dropToHand'; options: Filter[]; each: number; per?: Count; distinctCosts?: boolean; /** Different card names only. */ distinctNames?: boolean; /** The chosen cards' costs add up to this or less. */ totalCostLE?: number }
  /**
   * 'life' = look through your life (then shuffle it); 'lifeTop' = the top card of your life.
   * each: up to 1 card per filter ("up to 1 <A> and up to 1 <B>"); totalCostLE: combined cost cap; distinctNames: different card names.
   */
  | { t: 'playFrom'; from: 'drop' | 'hand' | 'deck' | 'energy' | 'life' | 'lifeTop'; filter: Filter; n: number; rested?: boolean; extraType?: boolean; negate?: 'all' | 'onPlay'; each?: Filter[]; totalCostLE?: number; distinctNames?: boolean }
  | { t: 'energyFromDeck'; n: number; rested: boolean }
  | { t: 'energyFromDrop'; filter: Filter; n: number; rested: boolean }
  | { t: 'energyFromLife'; n: number; rested: boolean }
  | { t: 'energyFromHand'; n: number; rested: boolean; filter?: Filter }
  | { t: 'activateEnergy'; n: number }
  | { t: 'discard'; n: number }
  | { t: 'oppDiscard'; n: number }
  | { t: 'mill'; n: number }
  | { t: 'costReduce'; n: number; per?: Count }
  | { t: 'cantBlock' }
  | { t: 'damageLeader'; n: number }
  | { t: 'flipLeader' }
  /** Place N energy markers from outside the game under the target as Ki (manual p.12). */
  | { t: 'ki'; target: Target; n: number; per?: Count }
  /** "you place 1 energy marker". */
  | { t: 'placeMarker'; n: number }
  /** Top card(s) of your deck to your life. */
  | { t: 'lifeFromDeck'; n: number; until?: number }
  /** Card(s) from your hand to your life. */
  | { t: 'handToLife'; n: number; upTo: boolean; /** Where in the life: top (default), bottom, or the player's choice. */ pos?: 'bottom' | 'topOrBottom' }
  /** Card(s) from your hand on top of (or under) your deck. */
  | { t: 'handToDeck'; n: number; bottom?: boolean; /** "at the top or bottom": the player chooses. */ either?: boolean }
  /** Move the card with this skill. */
  | { t: 'self'; to: 'hand' | 'drop' | 'energy' | 'deckBottom' | 'play' | 'life'; rested?: boolean }
  /** "During this turn, the next time you use <filter>, reduce its cost by N / you don't pay the cost." */
  | { t: 'nextDiscount'; filter: Filter; amount: number | 'free' }
  /** "You can't play <filter> for the turn" (applies to the skill's owner). */
  | { t: 'cantPlay'; filter: Filter; dur: Duration; extras?: boolean; opp?: boolean }
  /** Your opponent's cards cost more / their Battle Cards enter rested, until their next turn ends. */
  | { t: 'oppTax'; amount: number; filter?: Filter; dur?: 'turn' | 'oppNextTurn' }
  | { t: 'oppPlayRested'; filter: Filter }
  /** Place cards under a card in play (evolve stacks, Potara, Majin absorption). */
  | { t: 'placeUnder'; target: Target; from: 'drop' | 'hand' | 'deck' | 'battle' | 'handOrBattle'; filters: Filter[]; n: number; untilUnder?: number }
  /** Choose one of several effect lists. */
  | { t: 'choose'; options: Effect[][] }
  /** Use cards from a zone in the current battle's combo. */
  | { t: 'comboFrom'; from: 'drop' | 'deckTop'; filter: Filter; n: number; per?: Count; /** deckTop: look at this many cards (default 1). */ look?: number; /** deckTop: where the cards not used go (default: stay on top). */ rest?: 'top' | 'either' }
  /** Run these effects at the end of the current turn ("at the end of the turn, switch this card to Active Mode"). */
  | { t: 'atEndOfTurn'; effects: Effect[] }
  /** "You can't activate the [Activate:Main] of <X> for the turn." */
  | { t: 'lockSkill'; names: string[]; timing: 'activateMain' | 'activateBattle'; dur: Duration }
  /** Return every card in your Drop to your deck and shuffle. */
  | { t: 'dropToDeck'; /** "at the bottom of their owner's deck in a random order" instead of shuffling in. */ bottom?: boolean }
  /** Look through your life and place N of those cards on top of your deck. */
  | { t: 'lifeToDeck'; n: number }
  /** "Negate its skills for the turn" ('onPlay': only its [On Play]). */
  | { t: 'negate'; target: Target; dur: Duration; scope?: 'all' | 'onPlay' }
  /** "Switch the attack target to the chosen card" (choose among your own cards). */
  | { t: 'redirect'; target: Target }
  /** "At the end of the battle, ..." */
  | { t: 'atEndOfBattle'; effects: Effect[] }
  /** "Your opponent places N energy markers." */
  | { t: 'oppMarker'; n: number }
  /** "You take N damage." */
  | { t: 'selfDamage'; n: number }
  /** Place N of your energy into your Drop (as an effect, not a cost). */
  | { t: 'energyToDrop'; n: number }
  /** "You win the game." */
  | { t: 'winGame' }
  /** Reveal a card; later steps read it (revealedMatches, Val revealedCost). */
  | { t: 'reveal'; from: 'deckTop' | 'oppDeckTop' | 'oppHand' | 'lifeTop' }
  /** Just choose cards, for later steps that compare with "the card chosen by this skill". */
  | { t: 'pick'; target: Target }
  /**
   * Attack rules on the opponent. attacker: which of their cards the rule covers (all if absent); against / againstZone / againstThis:
   * what those can't attack (with none of the three: they can't attack at all); onlyAgainst: they may only attack these;
   * restTax: each attack also rests N of their other Active cards; noBlock: they can't [Blocker].
   * In a [Permanent] it holds while its conditions do; otherwise for `dur`.
   */
  | { t: 'attackRule'; attacker?: Filter; against?: Filter; againstZone?: 'leader' | 'battle'; againstThis?: boolean; onlyAgainst?: Filter; restTax?: number; noBlock?: boolean; dur: Duration }
  /** [Permanent] "you only take up to N damage in each battle". */
  | { t: 'damageCap'; n: number }
  /** "Negate the next damage you take" until the duration ends. */
  | { t: 'shield'; dur: Duration }
  /** "You will not lose the game for the turn." */
  | { t: 'cantLose'; dur: Duration }
  /** Move N of your opponent's life to their Drop / energy. */
  | { t: 'oppLife'; n: number; to: 'drop' | 'energy'; rested?: boolean }
  /** Top N of the opponent's deck into their Drop. */
  | { t: 'oppMill'; n: number }
  /**
   * "During this turn, when/if <on> ..., <effects>". on: dealsDamage (your card damages the opponent), koInBattle (your card KO's in battle),
   * attacks (your card matching `filter` attacks a card matching `targetFilter`). once: only the next time.
   */
  | { t: 'delayed'; on: 'dealsDamage' | 'koInBattle' | 'attacks' | 'usesExtra'; filter?: Filter; targetFilter?: Filter; once: boolean; effects: Effect[] }
  /** [Permanent] cost change for your cards in hand matching filter ('free' = no cost); once: once per turn. */
  | { t: 'handCostMod'; filter: Filter; amount: number | 'free'; once?: boolean }
  /**
   * [Permanent] "When you would pay the cost of <filter> (this card without a filter) from your hand, you may <costs> instead."
   * scaleN: each cost's n is multiplied by the card's cost; costLEv: only cards with a cost up to this value; inBattle: only during a battle.
   */
  | { t: 'altCost'; filter?: Filter; costs: Cost[]; scaleN?: boolean; once?: boolean; inBattle?: boolean; costLEv?: Val }
  /** [Permanent] cost of this card (or of `filter` cards) in the Drop: +amount, or becomes `set`. */
  | { t: 'dropCost'; amount?: number; set?: number; filter?: Filter }
  /** "Its original power becomes N" (value: a number or a Val such as the chosen card's power). */
  | { t: 'setBasePower'; target: Target; value: number | Val; dur: Duration }
  /** "Reduce the cost of the next [Evolve] skill you activate this turn for <filter> by N." */
  | { t: 'evolveDiscount'; filter: Filter; amount: number }
  /** [Permanent] on a [Field]: [Evolve] of <filter> from your hand may use a card under this card. */
  | { t: 'evolveFromUnder'; filter: Filter }
  /** Place a Battle Card into its owner's Combo Area (counts in the current battle's combo). */
  | { t: 'toCombo'; target: Target }
  /** [Permanent] your opponent's cards can't be switched to Active Mode by skills. */
  | { t: 'oppNoActivate' }
  /** "The next time you use <filter> Extra this turn, activate its skill again." */
  | { t: 'repeatExtra'; filter: Filter }
  /** "The next time you activate a skill on <filter> this turn, reduce the skill cost by N." */
  | { t: 'skillDiscount'; filter: Filter; amount: number }
  /** Flip your Leader to its front side. */
  | { t: 'unflipLeader' }
  /** Change your card that's in a battle to the chosen card. */
  | { t: 'swapBattler'; target: Target }
  /** Take an extra turn after this one. */
  | { t: 'extraTurn' }
  /** Activate the costless [On Play] skills of up to n cards under this card as though this card had them. */
  | { t: 'copyOnPlay'; filter: Filter; n: number }
  /** Activate the <timing> skill of up to 1 card in your Drop, then place it at the bottom of your deck. */
  | { t: 'useDropSkill'; filter: Filter; timing: Timing }
  /** Add up to N cards from your energy to your hand. */
  | { t: 'energyToHand'; n: number; filter: Filter }
  /** "If you would add a card to its owner's energy during this turn, place it into its owner's Drop instead." */
  | { t: 'energyRedirect' }
  /** Choose up to N of your opponent's Rest Mode energy; they can't switch to Active Mode during their next turn. */
  | { t: 'lockEnergy'; n: number }
  /** Switch all of your opponent's energy matching filter to Rest Mode. */
  | { t: 'restOppEnergy'; filter: Filter; /** Rest only this many (active ones first); all when omitted. */ n?: number }
  /** "You may <costs>. If you do, <effects>." */
  | { t: 'optionalCost'; costs: Cost[]; effects: Effect[] }
  /** Several steps under one condition ("If X, A. Then, B."), checked once before A. */
  | { t: 'group'; effects: Effect[] }
  /** Play the card chosen by this skill's cost (from under a card) on top of this card. */
  | { t: 'evolveOnto' }
  /** Reveal/rearrange deck or shuffle: no effect the simulator models. */
  | { t: 'noop'; note: string }
>;

export type Cost =
  | { t: 'discard'; n: number; filter?: Filter }
  | { t: 'energyToDrop'; n: number; filter?: Filter }
  | { t: 'restSelf' }
  | { t: 'restEnergy'; n: number }
  | { t: 'selfToDrop' }
  | { t: 'selfToHand' }
  | { t: 'selfToDeckBottom' }
  | { t: 'koSelf' }
  /** all: every card in your life ("add all of your life to your hand"). */
  | { t: 'lifeToHand'; n: number; all?: boolean }
  | { t: 'lifeToDrop'; n: number }
  /** "You take 1 damage:" as a cost (fires "when you take damage" skills, unlike moving life to hand). */
  | { t: 'takeDamage'; n: number }
  /** Remove N Ki. 'your' = leader and Battle Cards, 'battle' = Battle Cards only (manual p.12). */
  /** `max`: "remove N or more" / "remove all" — removes up to max (99 = all); the amount is countable as kiRemoved. */
  | { t: 'reduceKi'; n: number; scope: 'this' | 'leader' | 'your' | 'battle'; max?: number; /** "Remove N or more": the player chooses how many (up to max). */ choose?: boolean }
  /** KO / rest / drop / bounce N of your own cards in play matching filter. */
  | { t: 'koOwn'; n: number; filter: Filter }
  /** orLeader: your Leader may be the card rested ("your Leader or 1 card in your Battle Area"). */
  | { t: 'restOwn'; n: number; filter: Filter; orLeader?: boolean }
  | { t: 'dropOwn'; n: number; filter: Filter }
  | { t: 'bounceOwn'; n: number; filter: Filter }
  /** all: every matching card (n is the minimum). */
  | { t: 'bottomOwn'; n: number; filter: Filter; all?: boolean }
  | { t: 'removeMarker'; n: number }
  /** Return N cards matching filter from your energy to your hand. */
  | { t: 'energyToHand'; n: number; filter: Filter }
  /** Place 1 card per filter from your hand or Battle Area at the bottom of your deck. */
  | { t: 'handOrBattleToBottom'; filters: Filter[] }
  /** Place N of your energy at the bottom of your deck. */
  | { t: 'energyToDeckBottom'; n: number }
  /** Choose a card matching filter under one of your cards matching onto (the skill then refers to it). */
  | { t: 'pickUnder'; filter: Filter; onto: Filter }
  /** Place 1 of your Battle Cards matching filter into your Combo Area. */
  | { t: 'toComboOwn'; filter: Filter }
  /** N cards from your hand on top of your deck. */
  | { t: 'handToDeckTop'; n: number; /** "at the top or bottom": the player chooses. */ either?: boolean }
  /** Pay one of several ways ("discard 1 card or place 1 card on top of your deck"). */
  | { t: 'anyOf'; options: Cost[][] }
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
  | { t: 'koedThisTurn'; filter?: Filter; /** Only KOs in battle count, not KOs by skills. */ inBattle?: boolean }
  /** This card was played by your Leader's skill. */
  | { t: 'playedByLeaderSkill' }
  | { t: 'leaderInBattle' }
  /** One of your Battle Cards was removed from a Battle Area by your own skill this turn. */
  | { t: 'removedOwnThisTurn' }
  /** Ki was removed from your cards this turn. */
  | { t: 'kiRemovedThisTurn'; /** Only Ki removed from your Leader, or only from your Battle Area. */ from?: 'leader' | 'battle' }
  /** You used a card from your Battle Area in a combo this turn. */
  | { t: 'comboFromFieldThisTurn' }
  /** A Battle Card in your Battle Area was returned to its owner's hand this turn. */
  | { t: 'bouncedThisTurn' }
  /** A card left your energy this turn. */
  | { t: 'energyLeftThisTurn' }
  /** You placed a card from your energy into your Drop during this turn. */
  | { t: 'energyToDropThisTurn' }
  /** You used an Extra this turn (without filter: one with an original cost of 1 or more). */
  | { t: 'extraUsedThisTurn'; filter?: Filter }
  /** A card was removed from your life this turn. */
  | { t: 'lifeLeftThisTurn' }
  /** The card with this skill matches the filter ("if this card has 30000 power or more"). */
  | { t: 'thisMatches'; filter: Filter }
  /** "If you removed an energy marker to use this card". */
  | { t: 'markerPaid' }
  | { t: 'oppHasMarker'; yes: boolean }
  /** One of your energy markers was removed this turn. */
  | { t: 'markerUsedThisTurn' }
  /** You used a card from your Drop in a combo this turn. */
  | { t: 'comboFromDropThisTurn' }
  /** One of your Battle Cards was removed from the Battle Area by any skill this turn. */
  | { t: 'removedBySkillThisTurn'; filter?: Filter }
  /** This card was played by an [Evolve] skill this turn. */
  | { t: 'playedByEvolve' }
  /** This card was played by a skill this turn. */
  | { t: 'playedBySkill' }
  /** The cards in your Battle Area total a cost of n or more (and, with `only`, all match it). */
  | { t: 'battleTotalCost'; n: number; only?: Filter }
  /** This card has / hasn't attacked this turn. */
  | { t: 'attackedThisTurn'; yes: boolean }
  /** This card is in a battle with an opponent's card matching the filter. */
  | { t: 'inBattleWith'; filter: Filter; /** Your Leader is the one in the battle, not this card. */ leader?: boolean }
  /** The card revealed by this skill matches. */
  | { t: 'revealedMatches'; filter: Filter }
  /** The skill that caused this trigger is your Leader's (optionally a Leader matching filter). */
  | { t: 'causedByLeader'; filter?: Filter }
  /** This card's Ki increased during this turn. */
  | { t: 'thisKiUpThisTurn' }
  | { t: 'not'; c: Cond }
  | { t: 'or'; any: Cond[] }
  | { t: 'and'; all: Cond[] };

export type Keyword =
  | 'blocker' | 'critical' | 'doubleStrike' | 'tripleStrike' | 'superCombo' | 'barrier' | 'indestructible' | 'field' | 'dragonBall'
  | 'cantAttack' | 'cantAttackLeader' | 'cantBlock'
  /** Can't be KO'd by the opponent's skills. */
  | 'koImmuneSkills'
  /** Can't be KO'd (by battle or skill). */
  | 'koImmune'
  /** Can't be KO'd in battle. */
  | 'koImmuneBattle'
  /** Can't be KO'd once per turn. */
  | 'koImmuneOnce'
  /** Can't be removed from the Battle Area by the opponent's skills. */
  | 'removeImmune'
  | 'cantBeRested'
  /** May attack the opponent's Active Mode Battle Cards. */
  | 'attackActive'
  /** Can be used in a combo while in Rest Mode. */
  | 'comboRested'
  /** Can't be switched to Active Mode during your Charge Phase. */
  | 'noUntap'
  /** Must attack whenever possible. */
  | 'mustAttack'
  /** Counts as 2 cards when rested to pay your Leader's skill cost. */
  | 'doubleForRest';

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
  /** Costs paid besides energy ("pay 3 energy, discard 1 card from your hand"). */
  extraCost?: Cost[];
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
  /** For 'replace': what the replacement protects and from what. */
  replace?: Replace;
}

export interface Replace {
  /** 'this' = this card; 'ally' = your card matching filter (not this one). */
  what: 'this' | 'ally';
  filter?: Filter;
  /** Who is removing it: 'opp' (skill or battle), 'oppSkill', 'any'. */
  by: 'opp' | 'oppSkill' | 'any';
  /** Only a KO (not other removal). */
  ko?: boolean;
  /** Also replaces losing the game through 0 life. */
  lose?: boolean;
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
  /** "This card's name is also treated as <X> in all areas." */
  aliases?: string[];
  /** A translation's check: passed the automatic checker and a second read (ok), or flagged for a person. */
  check?: { ok: boolean; note?: string };
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
  aliases?: string[];
  source: 'claude' | 'verified';
  /** Plain-English reading of the script, for review. */
  reading?: string;
  /** Second-pass judgement: does the reading match the printed text? */
  check?: { ok: boolean; note?: string };
  updated?: string;
}
