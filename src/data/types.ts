export type Color = 'Red' | 'Blue' | 'Green' | 'Yellow' | 'Black';
export const COLORS: Color[] = ['Red', 'Blue', 'Green', 'Yellow', 'Black'];

export type CardType = 'LEADER' | 'BATTLE' | 'EXTRA';

export interface CardFace {
  name: string;
  power: number;
  text: string;
}

/** One printed card, normalised from whatever source it came from. */
export interface Card {
  id: string;
  name: string;
  type: CardType;
  colors: Color[];
  /** Total energy cost (0 for a Leader). */
  cost: number;
  /** Coloured orbs inside the total cost. */
  specified: Partial<Record<Color, number>>;
  /** False when the source did not list coloured orbs and we assumed them. */
  specifiedKnown: boolean;
  power: number;
  comboPower: number;
  traits: string[];
  /** Character names, used by "<Name>" references in skill text. */
  characters: string[];
  text: string;
  /** Awakened side of a Leader. */
  back?: CardFace;
  set: string;
  rarity?: string;
  /** A translation of the skill text (by Claude, possibly verified by a person). */
  script?: import('../effects/types').CardScript;
}

export interface CardDB {
  version: string;
  source: string;
  updated: string;
  cards: Record<string, Card>;
}

export interface Decklist {
  name: string;
  leader: string;
  /** card id -> copies */
  main: Record<string, number>;
  /** Share of the meta (0..1), used as the archetype prior. */
  share?: number;
  notes?: string;
}

export interface Meta {
  updated: string;
  source: string;
  decks: Decklist[];
  /** Real tournament results for the current format (cli/import-tournaments.ts). */
  results?: TournamentSummary;
}

export interface TournamentSummary {
  format: string;
  events: number;
  players: number;
  from: string;
  to: string;
  source: string;
  /** Per Leader: share of the field, share of top-cut spots, event wins. */
  leaders: { leader: string; field: number; top: number; wins: number }[];
}
