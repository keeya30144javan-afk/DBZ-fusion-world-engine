import { Color } from '../data/types';

export type Timing =
  | 'onPlay'
  | 'whenAttacking'
  | 'whenAttacked'
  | 'whenKOd'
  | 'activateMain'
  | 'activateBattle'
  | 'counter'
  | 'permanent'
  | 'endOfYourTurn'
  | 'startOfYourTurn'
  | 'awaken'
  | 'comboFromHand'
  | 'auto';

export type Duration = 'battle' | 'turn' | 'oppNextTurn' | 'static';

export interface Filter {
  costLE?: number;
  costGE?: number;
  costEQ?: number;
  powerLE?: number;
  powerGE?: number;
  rested?: boolean;
  active?: boolean;
  names?: string[];
  traits?: string[];
  colors?: Color[];
  type?: 'BATTLE' | 'EXTRA';
  other?: boolean;
}

export interface Target {
  side: 'opp' | 'self' | 'any';
  /** 'this' = the card with the skill; 'prev' = what the previous effect chose. */
  ref?: 'this' | 'prev' | 'leader';
  zones: ('leader' | 'battle')[];
  count: number;
  upTo: boolean;
  filter: Filter;
}

export type Effect =
  | { t: 'draw'; n: number }
  | { t: 'lifeToHand'; n: number; upTo: boolean }
  | { t: 'power'; target: Target; amount: number; dur: Duration }
  | { t: 'comboPower'; target: Target; amount: number }
  | { t: 'ko'; target: Target }
  | { t: 'bounce'; target: Target }
  | { t: 'bottom'; target: Target }
  | { t: 'rest'; target: Target }
  | { t: 'activate'; target: Target }
  | { t: 'lockActive'; target: Target }
  | { t: 'grant'; target: Target; kw: Keyword; dur: Duration }
  | { t: 'search'; look: number; options: Filter[]; take: number; toHand: boolean }
  | { t: 'dropToHand'; options: Filter[]; each: number }
  | { t: 'playFrom'; from: 'drop' | 'hand' | 'deck'; filter: Filter; n: number }
  | { t: 'energyFromDeck'; n: number; rested: boolean }
  | { t: 'energyFromDrop'; filter: Filter; n: number; rested: boolean }
  | { t: 'energyFromLife'; n: number; rested: boolean }
  | { t: 'energyFromHand'; n: number; rested: boolean }
  | { t: 'activateEnergy'; n: number }
  | { t: 'discard'; n: number }
  | { t: 'oppDiscard'; n: number }
  | { t: 'mill'; n: number }
  | { t: 'costReduce'; n: number }
  | { t: 'cantBlock' }
  | { t: 'damageLeader'; n: number }
  | { t: 'flipLeader' };

export type Cost =
  | { t: 'discard'; n: number }
  | { t: 'energyToDrop'; n: number }
  | { t: 'restSelf' }
  | { t: 'restEnergy'; n: number }
  | { t: 'selfToDrop' }
  | { t: 'lifeToHand'; n: number };

export type Cond =
  | { t: 'handLE'; n: number }
  | { t: 'handGE'; n: number }
  | { t: 'energyGE'; n: number }
  | { t: 'energyLE'; n: number }
  | { t: 'lifeLE'; n: number }
  | { t: 'lifeGE'; n: number }
  | { t: 'oppLifeLE'; n: number }
  | { t: 'dropGE'; n: number }
  | { t: 'battleCount'; op: 'none' | 'ge'; n: number; filter: Filter; side: 'self' | 'opp' }
  | { t: 'leaderIs'; names: string[] }
  | { t: 'leaderAwakened' };

export type Keyword = 'blocker' | 'critical' | 'doubleStrike' | 'tripleStrike' | 'superCombo' | 'barrier' | 'indestructible';

export interface Ability {
  timing: Timing;
  turn?: 'your' | 'opp';
  once: boolean;
  cost: Cost[];
  cond: Cond[];
  effects: Effect[];
  text: string;
  /** Sentences of this ability we could not translate. */
  unparsed: string[];
}

export interface CompiledCard {
  keywords: Set<Keyword>;
  abilities: Ability[];
  backKeywords?: Set<Keyword>;
  backAbilities?: Ability[];
  /** Fraction of skill sentences translated, 0..1 (1 for vanilla cards). */
  coverage: number;
  unparsed: string[];
}
