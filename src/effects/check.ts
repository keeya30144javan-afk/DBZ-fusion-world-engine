import { Card } from '../data/types';
import { CompiledCard } from './types';
import { describeCompiled } from './describe';

/**
 * A mechanical check of a translation: does the engine's English reading carry every number,
 * card name, special trait, timing tag, keyword and key action of the printed text?
 * It can't prove a translation right, but it catches dropped clauses, wrong numbers and
 * wrong names, and it never shares the translator's blind spots.
 */

export interface AutoCheck {
  ok: boolean;
  issues: string[];
}

const TAGS: [RegExp, RegExp, string][] = [
  [/\[On Play\]/gi, /\[On Play\]/g, '[On Play]'],
  [/\[When Attacking\]/gi, /\[When Attacking\]/g, '[When Attacking]'],
  [/\[When Attacked\]/gi, /\[When Attacked\]/g, '[When Attacked]'],
  [/\[When KO'd\]/gi, /\[When KO'd\]/g, "[When KO'd]"],
  [/\[Activate ?: ?Main\]/gi, /\[Activate: Main\]/g, '[Activate:Main]'],
  [/\[Activate ?: ?Battle\]/gi, /\[Activate: Battle\]/g, '[Activate:Battle]'],
  [/\[Counter\]/gi, /\[Counter\]/g, '[Counter]'],
  [/\[End of Your Turn\]/gi, /\[End of Your Turn\]/g, '[End of Your Turn]'],
  [/\[Once Per Turn\]/gi, /\[Once per turn\]/g, '[Once Per Turn]'],
  [/\[Your Turn\]/gi, /\[Your Turn\]/g, '[Your Turn]'],
  [/\[Opponent's Turn\]/gi, /\[Opponent's Turn\]/g, "[Opponent's Turn]"],
  [/\[Awaken\]/gi, /\[Awaken\]/g, '[Awaken]'],
];

const KEYWORDS: [RegExp, string, string][] = [
  [/\[Blocker\]/i, 'blocker', '[Blocker]'],
  [/\[Critical\]/i, 'critical', '[Critical]'],
  [/\[Double Strike\]/i, 'doubleStrike', '[Double Strike]'],
  [/\[Triple Strike\]/i, 'tripleStrike', '[Triple Strike]'],
  [/\[Barrier\]/i, 'barrier', '[Barrier]'],
  [/\[Super Combo\]/i, 'superCombo', '[Super Combo]'],
  [/\[Indestructible\]/i, 'indestructible', '[Indestructible]'],
  [/\[Field\]\s*(\(|\n|$)/i, 'field', '[Field]'],
];

/** Phrases whose action the reading must also mention. */
const ACTIONS: [RegExp, RegExp, string][] = [
  [/\bKO\b/, /\bKO/, 'a KO'],
  [/Rest Mode/i, /Rest Mode|pay \d+ energy/i, 'Rest Mode'],
  [/Active Mode/i, /Active Mode/i, 'Active Mode'],
  [/\bdraw\b/i, /\bdraw/i, 'drawing'],
  [/\bdiscard\b/i, /\bdiscard/i, 'discarding'],
  [/bottom of/i, /bottom/i, 'the bottom of a deck'],
  [/\bDrop\b/, /\bDrop\b/, 'the Drop'],
  [/\blife\b/i, /\blife\b/i, 'life'],
  [/\benergy\b/i, /\benergy\b/i, 'energy'],
  [/\bKi\b/, /\bKi\b/, 'Ki'],
  [/\bhand\b/i, /\bhands?\b|\bdraw/i, 'the hand'],
  [/combo/i, /combo/i, 'combos'],
  [/\bnegate/i, /\bnegate/i, 'negating'],
  [/can't attack/i, /can't attack|can only attack/i, "can't attack"],
  [/can't be KO'd/i, /can't be KO'd/i, "can't be KO'd"],
  [/\bpower\b/i, /\bpower\b/i, 'power'],
  [/\bcosts?\b/i, /\bcosts?\b/i, 'cost'],
  [/energy marker/i, /energy marker/i, 'energy markers'],
  [/\[Evolve\]/i, /\[Evolve\]|\[evolve\]/i, '[Evolve]'],
  [/\[Fusion Evolve\]/i, /\[Fusion Evolve\]|\[fusionEvolve\]/i, '[Fusion Evolve]'],
];

/** Text with reminder parentheses removed ("( This card inflicts 2 damage ... )"); "(1)"-style costs stay. */
const stripReminders = (t: string) => t.replace(/\([^()]{12,}\)/g, ' ').replace(/[’‘]/g, "'");

const numbersOf = (t: string) => {
  const out = new Set<string>();
  const clean = t.replace(/\b[A-Z]{1,4}\d{0,3}-\d{2,3}[a-z]?\b/gi, ' ').replace(/\((\d+)\)/g, ' $1 ');
  for (const m of clean.matchAll(/\b\d+\b/g)) out.add(String(+m[0]));
  return out;
};
const bracketed = (t: string, open: string, close: string) => {
  const out = new Set<string>();
  const re = new RegExp(`${open}\\s*([^${close}${open}]+?)\\s*${close}`, 'g');
  for (const m of t.matchAll(re)) out.add(m[1].replace(/\s*:\s*/g, ': ').replace(/\s+/g, ' ').trim().toLowerCase());
  return out;
};
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

/** Words the reading spells out instead of printing a number ("all", "a", "any number"). */
const NUMBER_WORDS: Record<string, RegExp> = { '1': /\b(a|an|one|1|this card|all|any|each|the top card|the bottom card|it)\b/i, '2': /\b(two|2|double)\b/i, '3': /\b(three|3|triple)\b/i };

export function autoCheck(card: Card, cc: CompiledCard): AutoCheck {
  const issues: string[] = [];
  const printed = stripReminders([card.text, card.back?.text ?? ''].join('\n'));
  const reading = describeCompiled(cc).replace(/[’‘]/g, "'");
  if (cc.unparsed.length) issues.push(`parts the engine can't read: ${cc.unparsed.join(' / ').slice(0, 140)}`);
  if (cc.needs?.length) issues.push(`needs engine support for: ${cc.needs.join(', ')}`);

  const nums = numbersOf(reading);
  const missingNums = [...numbersOf(printed)].filter((n) => !nums.has(n) && !(NUMBER_WORDS[n]?.test(reading)) && n !== '0');
  if (missingNums.length) issues.push(`number${missingNums.length > 1 ? 's' : ''} not in the reading: ${missingNums.join(', ')}`);

  const nameSet = (t: string) => new Set([...bracketed(t, '<', '>')].flatMap((n) => n.split(/\s*\/\s*|\s+or\s+/)).map((n) => n.replace(/\s+/g, ' ')));
  const readNames = nameSet(reading);
  const readFlat = reading.toLowerCase().replace(/\s*:\s*/g, ': ');
  const missingNames = [...nameSet(printed)].filter((n) => !readNames.has(n) && !readFlat.includes(n));
  if (missingNames.length) issues.push(`card name${missingNames.length > 1 ? 's' : ''} not in the reading: ${missingNames.map((n) => `<${n}>`).join(', ')}`);

  const readTraits = bracketed(reading, '≪', '≫');
  const missingTraits = [...bracketed(printed, '≪', '≫')].filter((n) => !readTraits.has(n) && !readFlat.includes(n));
  if (missingTraits.length) issues.push(`special trait${missingTraits.length > 1 ? 's' : ''} not in the reading: ${missingTraits.map((n) => `≪${n}≫`).join(', ')}`);

  for (const [pre, post, label] of TAGS) {
    const a = count(printed, pre), b = count(reading, post);
    if (a > b) issues.push(`${label} appears ${a}× on the card but ${b}× in the reading`);
  }
  const kws = new Set([...cc.keywords, ...(cc.backKeywords ?? [])]);
  for (const [re, kw, label] of KEYWORDS) {
    const line = printed.split('\n').some((l) => re.test(l.trim()) && l.trim().search(re) === 0);
    if (line && !kws.has(kw as never) && !new RegExp(label.replace(/[[\]]/g, '\\$&'), 'i').test(reading)) issues.push(`keyword ${label} missing`);
  }
  for (const [pre, post, label] of ACTIONS) if (pre.test(printed) && !post.test(reading)) issues.push(`the card mentions ${label}; the reading doesn't`);
  return { ok: issues.length === 0, issues };
}
