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
  /** Battle Cards can attack the turn they are played (manual p.9). */
  attackOnPlayTurn: boolean;
  /** Max cards one player may add to the Combo Area per battle; 0 = unlimited. */
  comboLimit: number;
  /** true: lose the moment life is 0. false: lose when damaged at 0 life. Manual p.2/p.6: life reduced to 0 loses. */
  loseAtZeroLife: boolean;
  /** 'any': a card must share one colour with the leader; 'all': every colour must. Manual p.4: 'one of the same colors'. */
  colorRule: 'any' | 'all';
  /** The first player draws in their first Charge Phase (manual p.7: no exception is listed). */
  firstPlayerDraws: boolean;
  /** Lose the moment your deck reaches 0 cards (manual p.6), not only on an empty draw. */
  deckOutAtZero: boolean;
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
  firstPlayerDraws: true,
  deckOutAtZero: true,
  maxTurns: 40,
};

export const RULE_NOTES: Record<string, string> = {
  attackOnPlayTurn: 'Official Rule Manual v1.20 p.9: "Battle Cards can attack in the same turn that they\'re played."',
  comboLimit: 'Manual p.10: combo cards may be added any number of times during the Offense/Defense Steps.',
  loseAtZeroLife: 'Manual p.6: you win when your opponent\'s life is reduced to zero cards.',
  colorRule: 'Manual p.4: a deck can only include cards that have one of the same colors as your Leader.',
  firstPlayerDraws: 'Manual p.7: the Charge Phase draws 1 card; the only first-turn exception (p.9) is that the first player cannot attack.',
  deckOutAtZero: 'Manual p.6: you win when your opponent\'s deck is reduced to zero cards.',
};
