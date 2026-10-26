/**
 * Game constants and the handful of rules we are not certain of.
 * Each uncertain rule is a switch so it can be corrected without code changes.
 */
export interface RulesConfig {
  deckMin: number;
  deckMax: number;
  maxCopies: number;
  superComboMax: number;
  handSize: number;
  lifeCount: number;
  awakenLife: number;
  /** Battle Cards can attack the turn they are played. (uncertain) */
  attackOnPlayTurn: boolean;
  /** Max cards one player may add to the Combo Area per battle; 0 = unlimited. (uncertain) */
  comboLimit: number;
  /** true: lose the moment life is 0. false: lose when damaged at 0 life. (uncertain) */
  loseAtZeroLife: boolean;
  /** 'any': a card must share one colour with the leader; 'all': every colour must. (uncertain) */
  colorRule: 'any' | 'all';
  /** Lose when you must draw from an empty deck. */
  loseOnEmptyDraw: boolean;
  /** Safety cap so a stalled simulation cannot loop forever. */
  maxTurns: number;
}

export const DEFAULT_RULES: RulesConfig = {
  deckMin: 50,
  deckMax: 60,
  maxCopies: 4,
  superComboMax: 4,
  handSize: 6,
  lifeCount: 8,
  awakenLife: 4,
  attackOnPlayTurn: true,
  comboLimit: 0,
  loseAtZeroLife: true,
  colorRule: 'any',
  loseOnEmptyDraw: true,
  maxTurns: 40,
};

export const RULE_NOTES: Record<string, string> = {
  attackOnPlayTurn: 'Battle Cards enter in Active Mode; we assume they may attack immediately.',
  comboLimit: 'The FW manual describes adding combo cards one at a time with no stated cap; 0 means unlimited.',
  loseAtZeroLife: 'Assumed: a player whose life reaches 0 loses.',
  colorRule: 'Off-colour cards are illegal; assumed a multicolour card needs one colour shared with the Leader.',
};
