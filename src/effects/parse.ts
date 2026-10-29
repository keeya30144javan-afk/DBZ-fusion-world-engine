import { Card, Color } from '../data/types';
import { normalizeAbility, textHash } from './script';
import { Ability, CardScript, CompiledCard, EvolveSpec, Cond, Cost, Duration, Effect, Filter, Keyword, Target, Timing } from './types';

/**
 * Skill text -> Ability list. Each sentence is matched against templates of
 * Fusion World wording. Anything that matches no template is kept in
 * `unparsed`, so coverage is always measured, never assumed.
 */

const NUM_WORDS: Record<string, number> = { all: NaN, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const n = (s: string) => (NUM_WORDS[s?.toLowerCase()] ?? parseInt(s, 10));

const KEYWORD_TAGS: Record<string, Keyword> = {
  blocker: 'blocker',
  critical: 'critical',
  'double strike': 'doubleStrike',
  'triple strike': 'tripleStrike',
  'super combo': 'superCombo',
  barrier: 'barrier',
  indestructible: 'indestructible',
  field: 'field',
  'dragon ball': 'dragonBall',
};

const TIMING_TAGS: Record<string, Timing> = {
  'on play': 'onPlay',
  'when attacking': 'whenAttacking',
  'when attacked': 'whenAttacked',
  "when ko'd": 'whenKOd',
  'when blocking': 'whenBlocking',
  'activate:main': 'activateMain',
  'activate: main': 'activateMain',
  'activate:battle': 'activateBattle',
  'activate: battle': 'activateBattle',
  main: 'activateMain',
  counter: 'counter',
  'counter:attack': 'counter',
  'counter: attack': 'counter',
  permanent: 'permanent',
  'end of your turn': 'endOfYourTurn',
  'start of your turn': 'startOfYourTurn',
  awaken: 'awaken',
  auto: 'auto',
};

const COLOR_WORDS: Record<string, Color> = { red: 'Red', blue: 'Blue', green: 'Green', yellow: 'Yellow', black: 'Black' };

// ---------------------------------------------------------------- filters

export function parseFilter(s: string): Filter {
  const f: Filter = {};
  let m: RegExpMatchArray | null;
  // "a cost of 3 or less" / "costs of 3 or less" / "a cost of 2 to 6"
  if ((m = s.match(/(?:energy )?costs? of (\d+) to (\d+)/i))) { f.costGE = +m[1]; f.costLE = +m[2]; }
  else if ((m = s.match(/(?:energy )?costs? of (\d+) or less/i))) f.costLE = +m[1];
  else if ((m = s.match(/(?:energy )?costs? of (\d+) or more/i))) f.costGE = +m[1];
  else if ((m = s.match(/(?:energy )?costs? of (\d+)\b/i))) f.costEQ = +m[1];
  if (f.costLE !== undefined || f.costGE !== undefined || f.costEQ !== undefined) if (/original (?:energy )?costs?/i.test(s)) f.originalCost = true;
  if ((m = s.match(/(\d+) combo power or less/i))) f.comboLE = +m[1];
  else if ((m = s.match(/(\d+) combo power\b/i))) f.comboEQ = +m[1];
  const sp = s.replace(/\d+ combo power(?: or less)?/gi, ' ');
  if ((m = sp.match(/(\d+) power or less/i))) f.powerLE = +m[1];
  else if ((m = sp.match(/(\d+) power or more/i))) f.powerGE = +m[1];
  else if ((m = sp.match(/(?<![+\-−\d])(\d{4,}) power\b/i))) f.powerEQ = +m[1];
  if (f.powerLE !== undefined || f.powerGE !== undefined || f.powerEQ !== undefined) if (/original power/i.test(sp)) f.originalPower = true;
  // "with [Evolve]", "with [Blocker]"
  for (const t of s.matchAll(/\[([^\]]+)\]/g)) {
    const k = t[1].toLowerCase();
    if (k === 'evolve') f.keyword = 'evolve';
    else if (k === 'fusion evolve') f.keyword = 'fusionEvolve';
    else if (KEYWORD_TAGS[k]) f.keyword = KEYWORD_TAGS[k];
  }
  if (/rest mode/i.test(s)) f.rested = true;
  if (/active mode/i.test(s)) f.active = true;
  // "non-<X>", "other than <X>", "without <X> in its card name" exclude a name.
  const names: string[] = [], notNames: string[] = [];
  for (const x of s.matchAll(/<([^>]+)>/g)) (/(?:non-|other than |without )$/i.test(s.slice(0, x.index)) ? notNames : names).push(x[1].trim());
  if (names.length) f.names = names;
  if (notNames.length) f.notNames = notNames;
  const traits = [...s.matchAll(/≪([^≫]+)≫/g)].map((x) => x[1].trim());
  if (traits.length && /≫-only/i.test(s)) f.onlyTraits = traits;
  else if (traits.length && /\bboth ≪/i.test(s)) f.traitsAll = traits;
  else if (traits.length) f.traits = traits;
  const colors = [...s.matchAll(/\b(red|blue|green|yellow|black)\b/gi)].map((x) => COLOR_WORDS[x[1].toLowerCase()]);
  if (colors.length) f.colors = colors;
  if (/\bextras?\b/i.test(s)) f.type = 'EXTRA';
  else if (/battle cards?/i.test(s)) f.type = 'BATTLE';
  if (/\bother\b/i.test(s)) f.other = true;
  return f;
}

// ---------------------------------------------------------------- targets

/** "up to 1 of your opponent's Rest Mode Battle Cards with a cost of 3 or less" */
function parseChoice(s: string): Target | null {
  const t = parseChoice0(s);
  if (t && Number.isNaN(t.count)) {
    if (/^(?:choose )?all\b/i.test(s) || /\ball of\b/i.test(s)) return { ...t, count: 99, upTo: false, all: true };
    return null;
  }
  return t;
}

function parseChoice0(s: string): Target | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:choose )?your leader or up to (\w+) of your (.*)$/i))) {
    return { side: 'self', zones: ['leader', 'battle'], count: n(m[1]), upTo: true, filter: parseFilter(m[2]) };
  }
  if ((m = s.match(/^(?:choose )?(up to )?(\w+) of (your opponent's|your|their) (.*)$/i))) {
    const side = /opponent|their/i.test(m[3]) ? 'opp' : 'self';
    const rest = m[4];
    const zones: Target['zones'] = /leader/i.test(rest) && !/battle card/i.test(rest) ? ['leader'] : /leader or/i.test(rest) ? ['leader', 'battle'] : ['battle'];
    return { side, zones, count: n(m[2]), upTo: !!m[1], filter: parseFilter(rest) };
  }
  if ((m = s.match(/^(?:choose )?(up to )?(\w+) (?:battle )?cards? (.*)$/i))) {
    const where = m[3];
    const side = /in your opponent's battle area/i.test(where) ? 'opp' : /in your battle area/i.test(where) ? 'self' : 'any';
    const f = parseFilter(where.replace(/in (?:your opponent's|your) battle area/i, ''));
    return { side, zones: ['battle'], count: n(m[2]), upTo: !!m[1], filter: f };
  }
  if (/^(?:choose )?your leader$/i.test(s)) return { side: 'self', ref: 'leader', zones: ['leader'], count: 1, upTo: false, filter: {} };
  if (/^(?:choose )?your opponent's leader$/i.test(s)) return { side: 'opp', zones: ['leader'], count: 1, upTo: false, filter: {} };
  return null;
}

const THIS: Target = { side: 'self', ref: 'this', zones: ['battle', 'leader'], count: 1, upTo: false, filter: {} };
const PREV: Target = { side: 'any', ref: 'prev', zones: ['battle', 'leader'], count: 1, upTo: false, filter: {} };

function parseDur(s: string | undefined, fallback: Duration): Duration {
  if (!s) return fallback;
  if (/battle/i.test(s)) return 'battle';
  if (/opponent's next turn/i.test(s)) return 'oppNextTurn';
  if (/turn/i.test(s)) return 'turn';
  return fallback;
}

/** What to do with a chosen/referenced card: "it gets +5000 power for the turn", "KO it". */
function parseAction(action: string, target: Target, staticDefault: Duration): Effect | null {
  const a = action.trim().replace(/\.$/, '');
  let m: RegExpMatchArray | null;
  if ((m = a.match(/^(?:it|they|each|that card|this card)? ?gets? ([+\-−]\d+) combo power/i))) return { t: 'comboPower', target, amount: +m[1].replace('−', '-') };
  if ((m = a.match(/^(?:it|they|each|that card|this card|them)? ?gets? \+(\d+) ki$/i))) return { t: 'ki', target, n: +m[1] };
  if ((m = a.match(/^(?:it|they|each|that card|this card|them)? ?gets? ([+\-−]\d+) power(?: (for the battle|for the turn|during your opponent's next turn|until the end of the turn))?/i)))
    return { t: 'power', target, amount: +m[1].replace('−', '-'), dur: parseDur(m[2], staticDefault) };
  if (/^ko (?:it|them)$/i.test(a)) return { t: 'ko', target };
  if (/^return (?:it|them) to (?:its|their) owners?'s? hands?$/i.test(a)) return { t: 'bounce', target };
  if (/^place (?:it|them) at the bottom of (?:its|their) owners?'s? decks?(?: in any order)?$/i.test(a)) return { t: 'bottom', target };
  if (/^switch (?:it|them) to rest mode$/i.test(a)) return { t: 'rest', target };
  if (/^switch (?:it|them) to active mode$/i.test(a)) return { t: 'activate', target };
  if (/^(?:it|they) can't (?:switch|be switched) to active mode during (?:your|their owner's) opponent's next turn$/i.test(a)) return { t: 'lockActive', target };
  if ((m = a.match(/^(?:it|they) gains? \[([^\]]+)\](?: (for the turn|for the battle))?/i))) {
    const kw = KEYWORD_TAGS[m[1].toLowerCase()];
    if (kw) return { t: 'grant', target, kw, dur: parseDur(m[2], staticDefault) };
  }
  return null;
}

// ---------------------------------------------------------------- sentences

function parseSentence(s: string, ctx: { staticDur: Duration }): Effect[] | null {
  let m: RegExpMatchArray | null;
  const t = s.trim().replace(/\.$/, '').replace(/^then,?\s*/i, '');
  if (!t) return [];

  if ((m = t.match(/^draw (\w+) cards?$/i))) return [{ t: 'draw', n: n(m[1]) }];
  if (/^ko (?:it|them|that card)$/i.test(t)) return [{ t: 'ko', target: PREV }];
  if ((m = t.match(/^(?:add|place) (up to )?(\w+) cards? from your life (?:area )?(?:to|in|into) your hand$/i)))
    return [{ t: 'lifeToHand', n: n(m[2]), upTo: !!m[1] }];
  if ((m = t.match(/^(?:add|place) (up to )?(\w+) cards? from your life (?:area )?(?:to|in|into) your energy(?: in (rest|active) mode)?$/i)))
    return [{ t: 'energyFromLife', n: n(m[2]), rested: (m[3] ?? 'rest').toLowerCase() === 'rest' }];
  if ((m = t.match(/^(?:add|place) (up to )?(\w+) cards? from the top of your deck (?:to|in|into) your energy(?: in (rest|active) mode)?$/i)))
    return [{ t: 'energyFromDeck', n: n(m[2]), rested: (m[3] ?? 'active').toLowerCase() === 'rest' }];
  if ((m = t.match(/^(?:add|place) (up to )?(\w+) (.*?)from your drop (?:to|in|into) your energy(?: in (rest|active) mode)?$/i)))
    return [{ t: 'energyFromDrop', n: n(m[2]), filter: parseFilter(m[3]), rested: (m[4] ?? 'active').toLowerCase() === 'rest' }];
  if ((m = t.match(/^(?:add|place) (up to )?(\w+) cards? from your hand (?:to|in|into) your energy(?: in (rest|active) mode)?$/i)))
    return [{ t: 'energyFromHand', n: n(m[2]), rested: (m[3] ?? 'active').toLowerCase() === 'rest' }];
  if ((m = t.match(/^switch (up to )?(\w+) of your energy to active mode$/i))) return [{ t: 'activateEnergy', n: n(m[2]) }];
  if ((m = t.match(/^discard (\w+) cards? from your hand$/i))) return [{ t: 'discard', n: n(m[1]) }];
  if ((m = t.match(/^your opponent discards (\w+) cards? from their hand$/i))) return [{ t: 'oppDiscard', n: n(m[1]) }];
  if ((m = t.match(/^place (?:the )?top (\w+) cards? of your deck in(?:to)? your drop$/i))) return [{ t: 'mill', n: n(m[1]) }];
  if ((m = t.match(/^reduce the (?:energy )?cost of this card in your hand by (\d+)$/i))) return [{ t: 'costReduce', n: +m[1] }];
  if (/^switch this card to active mode$/i.test(t)) return [{ t: 'activate', target: THIS }];
  if (/^switch this card to rest mode$/i.test(t)) return [{ t: 'rest', target: THIS }];
  if (/^flip this card over$/i.test(t)) return [{ t: 'flipLeader' }];
  if (/^your opponent can't activate \[blocker\](?: for the turn| during this battle)?$/i.test(t)) return [{ t: 'cantBlock' }];

  // "This card gets +5000 power (for the turn)."  /  "that card gets ..."
  if ((m = t.match(/^(this card|that card|your leaders?|it) (gets? .*|gains? .*|can't .*)$/i))) {
    const target = /this/i.test(m[1]) ? THIS : /leader/i.test(m[1]) ? { ...THIS, ref: 'leader' as const, zones: ['leader' as const] } : PREV;
    const e = parseAction(m[2], target, ctx.staticDur);
    if (e) return [e];
  }

  // "Choose X and <action>", "KO up to 1 of your opponent's ..."
  if ((m = t.match(/^(choose .*?) and (it gets.*|they get.*|those cards get.*|each gets.*|ko (?:it|them)|return (?:it|them).*|place (?:it|them).*|switch (?:it|them).*|(?:it|they) can't.*|(?:it|they) gains?.*)$/i))) {
    const target = parseChoice(m[1]);
    if (target) {
      const e = parseAction(m[2], target, ctx.staticDur);
      if (e) return [e];
    }
  }
  if ((m = t.match(/^(ko|rest|return) (up to \w+ of .*)$/i))) {
    const target = parseChoice(m[2].replace(/ to (?:its|their) owners?'s? hands?$/i, ''));
    if (target) return [m[1].toLowerCase() === 'ko' ? { t: 'ko', target } : m[1].toLowerCase() === 'rest' ? { t: 'rest', target } : { t: 'bounce', target }];
  }

  // Look at the top N, reveal up to 1 <X> or up to 1 Extra and add it to your hand. Rest to bottom.
  if ((m = t.match(/^look at (?:the top )?(\w+) cards? (?:from|of) the top of your deck,? (?:reveal )?(.*?) and add (?:it|them) to your hand$/i)) ||
      (m = t.match(/^look at the top (\w+) cards? of your deck,? (?:reveal )?(.*?) and add (?:it|them) to your hand$/i))) {
    // A new option starts at "up to", "card with", "[Field]" or "Extra": "<A> or card with ≪X≫" is two options,
    // "card with a cost of 5 or less and ≪Saiyan≫" and "<A> or <B>" are one.
    const options = m[2].split(/\s+or\s+(?=up to |cards? (?:with|that) |\[|Extras?\b|an? )/i).map(parseFilter);
    const take = (m[2].match(/up to (\w+)/i) ? n(m[2].match(/up to (\w+)/i)![1]) : 1);
    return [{ t: 'search', look: n(m[1]), options, take, toHand: true }];
  }
  if (/^place the rest at the bottom of your deck(?: in (?:a random|any) order)?$/i.test(t)) return [];

  // add up to 1 <A> and up to 1 <B> —both with a cost of 2 or less— from your Drop to your hand
  if ((m = t.match(/^add (.*) from your drop to your hand$/i))) {
    const body = m[1];
    const shared = body.match(/[—―-]+\s*both (.*?)\s*[—―-]+/i);
    // Only "and up to …" starts another card; "a card with a cost of 1 or less and ≪Earthling≫" is one card.
    const parts = body.replace(/[—―-]+\s*both .*?[—―-]+/i, '').split(/\s+and\s+(?=up to )/i);
    const options = parts.map((p) => ({ ...parseFilter(p), ...(shared ? parseFilter(shared[1]) : {}) }));
    const each = n(body.match(/up to (\w+)/i)?.[1] ?? '1');
    return [{ t: 'dropToHand', options, each }];
  }
  // play up to 1 <Shamoian> with a cost of 1 from your Drop
  if ((m = t.match(/^play (up to )?(\w+) (.*?) from your (drop|hand|deck)$/i)))
    return [{ t: 'playFrom', from: m[4].toLowerCase() as 'drop', filter: { ...parseFilter(m[3]), type: 'BATTLE' }, n: n(m[2]) }];
  if ((m = t.match(/^deal (\w+) damage to your opponent's leader$/i))) return [{ t: 'damageLeader', n: n(m[1]) }];
  return null;
}

// ---------------------------------------------------------------- conditions

function parseCond(s: string): Cond[] | null {
  const out: Cond[] = [];
  for (const part of s.split(/,? and (?=you |your )/i)) {
    const p = part.trim();
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^you have (\d+) or (?:fewer|less) cards in your hand$/i))) out.push({ t: 'handLE', n: +m[1] });
    else if ((m = p.match(/^you have (\d+) or more cards in your hand$/i))) out.push({ t: 'handGE', n: +m[1] });
    else if ((m = p.match(/^(?:that|the chosen) card (?:has|is) (.*)$/i))) out.push({ t: 'prevMatches', filter: parseFilter(m[1]) });
    else if ((m = p.match(/^you have (\d+) or more energy$/i))) out.push({ t: 'energyGE', n: +m[1] });
    else if ((m = p.match(/^you have (\d+) or less energy$/i))) out.push({ t: 'energyLE', n: +m[1] });
    else if ((m = p.match(/^your life is (?:at )?(\d+) or less$/i))) out.push({ t: 'lifeLE', n: +m[1] });
    else if ((m = p.match(/^your life is (?:at )?(\d+) or more$/i))) out.push({ t: 'lifeGE', n: +m[1] });
    else if ((m = p.match(/^your opponent's life is (?:at )?(\d+) or less$/i))) out.push({ t: 'oppLifeLE', n: +m[1] });
    else if ((m = p.match(/^you have (\d+) or more cards in your drop$/i))) out.push({ t: 'dropGE', n: +m[1] });
    else if (/^you have no battle cards$/i.test(p)) out.push({ t: 'battleCount', op: 'none', n: 0, filter: {}, side: 'self' });
    else if ((m = p.match(/^you have no (.*?) battle cards?$/i))) out.push({ t: 'battleCount', op: 'none', n: 0, filter: parseFilter(m[1]), side: 'self' });
    else if ((m = p.match(/^you have (\d+) or more (.*?)battle cards?$/i))) out.push({ t: 'battleCount', op: 'ge', n: +m[1], filter: parseFilter(m[2]), side: 'self' });
    else if (!/awakened$/i.test(p) && (m = p.match(/^your leader is (.*)$/i))) {
      const names = [...m[1].matchAll(/<([^>]+)>/g)].map((x) => x[1]);
      if (!names.length) return null;
      out.push({ t: 'leaderIs', names });
    } else if (/^your leader is awakened$/i.test(p)) out.push({ t: 'leaderAwakened' });
    else if ((m = p.match(/^your (?:(<[^>]+>) )?leader(?: with (<[^>]+>) in its card name)? has (\d+) or more ki$/i))) {
      const nm = (m[1] ?? m[2])?.replace(/[<>]/g, '');
      if (nm) out.push({ t: 'leaderIs', names: [nm] });
      out.push({ t: 'kiLeaderGE', n: +m[3] });
    } else if ((m = p.match(/^you have a total of (\d+) or more ki( in your battle area)?$/i))) out.push({ t: 'kiTotalGE', n: +m[1], scope: m[2] ? 'battle' : 'your' });
    else return null;
  }
  return out;
}

function parseCost(s: string): Cost[] | null {
  const out: Cost[] = [];
  for (const part of s.split(/\s*(?:,| and )\s*/i)) {
    const p = part.trim().replace(/\.$/, '');
    if (!p) continue;
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^discard (\w+) cards? from your hand$/i))) out.push({ t: 'discard', n: n(m[1]) });
    else if ((m = p.match(/^place (\w+) of your energy in(?:to)? your drop$/i))) out.push({ t: 'energyToDrop', n: n(m[1]) });
    else if (/^switch this card to rest mode$/i.test(p)) out.push({ t: 'restSelf' });
    else if (/^place this card in(?:to)? your drop$/i.test(p)) out.push({ t: 'selfToDrop' });
    else if ((m = p.match(/^(?:pay|rest) (\w+) energy$/i))) out.push({ t: 'restEnergy', n: n(m[1]) });
    else if ((m = p.match(/^add (\w+) cards? from your life to your hand$/i))) out.push({ t: 'lifeToHand', n: n(m[1]) });
    else if ((m = p.match(/^reduce your ki by (\d+)$/i))) out.push({ t: 'reduceKi', n: +m[1], scope: 'your' });
    else if ((m = p.match(/^reduce the ki of your battle area by (\d+)$/i))) out.push({ t: 'reduceKi', n: +m[1], scope: 'battle' });
    else if ((m = p.match(/^reduce the ki of your (?:<[^>]+> )?leader(?: with .*?)? by (\d+)$/i))) out.push({ t: 'reduceKi', n: +m[1], scope: 'leader' });
    else if ((m = p.match(/^(?:reduce the ki of this card by (\d+)|remove (\d+) ki from this card)$/i))) out.push({ t: 'reduceKi', n: +(m[1] ?? m[2]), scope: 'this' });
    else return null;
  }
  return out;
}

// ---------------------------------------------------------------- abilities

/** Split card text into lines that each start with their own bracket tags. */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\n+/)) {
    // A new ability starts at a timing tag that follows a full stop.
    const pieces = raw.split(/(?<=[.)])\s+(?=\[(?:On Play|When Attacking|When KO'd|Activate|Permanent|Auto|Counter|End of|Start of|Awaken|Main)\b)/);
    for (const p of pieces) if (p.trim()) lines.push(p.trim());
  }
  return lines;
}

function parseLine(line: string, keywords: Set<Keyword>): Ability | null {
  let rest = line.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(); // drop reminder text
  // "this card in a Battle Area" / "from a Battle Area" only says where the card is; the engine knows that.
  rest = rest.replace(/this card (?:in|from) (?:a|your) battle area/gi, 'this card').replace(/\bKI\b/g, 'Ki');
  const tags: string[] = [];
  let m: RegExpMatchArray | null;
  // Tags may be joined: "[When Attacking]/[When Blocking]" or "[On Play/When Attacking]".
  while ((m = rest.match(/^\/?\s*\[([^\]]+)\]\s*/))) {
    for (const t of m[1].split('/')) tags.push(t.trim());
    rest = rest.slice(m[0].length);
  }
  let timing: Timing | undefined;
  let turn: 'your' | 'opp' | undefined;
  let once = false;
  let unknownTag: string | undefined;
  const alsoTimings: Timing[] = [];
  for (const tag of tags) {
    const k = tag.toLowerCase();
    if (KEYWORD_TAGS[k]) { keywords.add(KEYWORD_TAGS[k]); continue; }
    if (k === 'your turn') { turn = 'your'; continue; }
    if (k === "opponent's turn") { turn = 'opp'; continue; }
    if (k === 'once per turn') { once = true; continue; }
    if (TIMING_TAGS[k]) { if (!timing) timing = TIMING_TAGS[k]; else alsoTimings.push(TIMING_TAGS[k]); continue; }
    if (/^counter/.test(k)) { timing = 'counter'; continue; }
    unknownTag = tag;
  }
  if (!rest) return null; // keyword-only line
  if (!timing) timing = tags.length ? 'auto' : 'permanent';

  const ab: Ability = { timing, turn, once, cost: [], cond: [], effects: [], text: line, unparsed: [] };
  if (alsoTimings.length) ab.alsoTimings = alsoTimings;
  // A skill type the engine has no trigger for (Evolve, Field, When Blocking...) is not playable yet.
  if (unknownTag) { ab.unparsed.push(line); return ab; }

  // Auto triggers whose condition is the event itself.
  if (timing === 'auto') {
    if ((m = rest.match(/^when you use this card in a combo from your hand, (.*)$/i))) { ab.timing = 'comboFromHand'; rest = m[1]; }
    else if ((m = rest.match(/^when this card blocks, (.*)$/i))) { ab.timing = 'whenBlocking'; rest = m[1]; }
    else if ((m = rest.match(/^when this card is ko'd, (.*)$/i))) { ab.timing = 'whenKOd'; rest = m[1]; }
    else if ((m = rest.match(/^when this card attacks, (.*)$/i))) { ab.timing = 'whenAttacking'; rest = m[1]; }
    else if ((m = rest.match(/^when this card is played, (.*)$/i))) { ab.timing = 'onPlay'; rest = m[1]; }
    else if ((m = rest.match(/^at the end of your turn, (.*)$/i))) { ab.timing = 'endOfYourTurn'; rest = m[1]; }
    else if ((m = rest.match(/^when (?:your leader|this card) is attacked, (.*)$/i))) { ab.timing = 'whenAttacked'; rest = m[1]; }
  }
  // Awaken: "When your life is at 4 or less, <effect>. Then, flip this card over."
  if (timing === 'awaken' && (m = rest.match(/^when your life is (?:at )?(\d+) or less,?\s*(.*)$/i))) {
    ab.cond.push({ t: 'lifeLE', n: +m[1] });
    rest = m[2];
  }
  // Cost "X : effect"
  // Card names like <Trunks : Youth> contain " : ", so look for the separator outside brackets.
  const masked = rest.replace(/<[^>]*>|≪[^≫]*≫/g, (s) => s.replace(/:/g, '\u0001'));
  const colonAt = masked.search(/\s*:\s+/);
  const colon = colonAt > 0 ? [rest, rest.slice(0, colonAt), rest.slice(colonAt).replace(/^\s*:\s+/, '')] : null;
  if (colon) {
    const cost = parseCost(colon[1]);
    if (cost) { ab.cost = cost; rest = colon[2]; }
    else { ab.unparsed.push(colon[1]); rest = colon[2]; }
  }
  const staticDur: Duration = timing === 'permanent' ? 'static' : 'turn';
  const sentences = rest.split(/(?<=\.)\s+/).map((s) => s.trim()).filter(Boolean);
  for (let s of sentences) {
    s = s.replace(/^then,?\s*/i, '');
    // Leading condition, "If ..., effect" (the comma after the condition may be the last one before the effect)
    const cm = s.match(/^if (.+?), ((?:choose|draw|add|this|that|reduce|play|place|switch|ko|look|return|your|discard|it|deal|rest).*)$/i);
    let condsHere: Cond[] = [];
    if (cm) {
      const c = parseCond(cm[1]);
      if (c) { condsHere = c; s = cm[2]; }
      else { ab.unparsed.push(s); continue; }
    }
    const effs = parseSentence(s, { staticDur });
    if (!effs) { ab.unparsed.push(s); continue; }
    if (condsHere.length) {
      // A mid-ability condition gates only what follows it; at the start it gates the ability.
      if (ab.effects.length === 0) ab.cond.push(...condsHere);
      else for (const e of effs) (e as any).cond = condsHere;
    }
    ab.effects.push(...effs);
  }
  if (timing === 'awaken' && !ab.effects.some((e) => e.t === 'flipLeader')) ab.effects.push({ t: 'flipLeader' });
  return ab;
}

/** "[Evolve] pay 2 energy: <Majin Buu: Evil> with a cost of 3 or 4." -> spec, or null when unreadable. */
export function parseEvolve(line: string): EvolveSpec | null {
  const m = line.match(/^\[(fusion )?evolve\]\s*pay (\d+) energy:\s*(.*?)\.?$/i);
  if (!m) return null;
  const body = m[3].trim();
  const one = (t: string): Filter | null => {
    let x = t.trim().replace(/\.$/, '');
    const f: Filter = {};
    let mm: RegExpMatchArray | null;
    if ((mm = x.match(/^special trait ≪([^≫]+)≫\s*(.*)$/i))) { f.traits = [mm[1]]; x = mm[2]; }
    if ((mm = x.match(/^(.*?)\s+with an? <([^>]+)> under (?:them|it)$/i))) { f.underNames = [mm[2]]; x = mm[1]; }
    if ((mm = x.match(/^(.*?)\s+without special trait ≪([^≫]+)≫$/i))) { f.notTraits = [mm[2]]; x = mm[1]; }
    if ((mm = x.match(/^(.*?)\s+with ≪([^≫]+)≫ in its special traits$/i))) { f.traits = [mm[2]]; x = mm[1]; }
    if ((mm = x.match(/^(.*?)\s+with an? (original )?cost of (\d+) or (\d+)$/i))) { f.costGE = +mm[3]; f.costLE = +mm[4]; if (mm[2]) f.originalCost = true; x = mm[1]; }
    else if ((mm = x.match(/^(.*?)\s+with an? (original )?cost of (\d+)( or less| or more)?$/i))) {
      if (mm[4] === ' or less') f.costLE = +mm[3]; else if (mm[4] === ' or more') f.costGE = +mm[3]; else f.costEQ = +mm[3];
      if (mm[2]) f.originalCost = true;
      x = mm[1];
    }
    if ((mm = x.match(/^(.*?)\s+with (\d+) power or more$/i))) { f.powerGE = +mm[2]; x = mm[1]; }
    const names = [...x.matchAll(/<([^>]+)>/g)].map((n) => n[1].trim());
    if (!names.length || x.replace(/<[^>]+>/g, '').replace(/,|\bor\b/gi, '').trim()) return null;
    f.names = names;
    return f;
  };
  if (m[1]) {
    const fm = body.match(/^(<[^>]+>) and (<[^>]+>)(?: (in rest mode))?(?:(?: and)? with equal (power|cost)(?: of (\d+) or more)?)?\.?$/i);
    if (!fm) return null;
    const spec: EvolveSpec = { from: [{ names: [fm[1].slice(1, -1)] }, { names: [fm[2].slice(1, -1)] }], cost: +m[2] };
    if (!fm[4]) spec.equal = 'none';
    else if (fm[4].toLowerCase() === 'cost') spec.equal = 'cost';
    if (fm[5]) spec.equalPowerGE = +fm[5];
    if (fm[3]) spec.baseMode = 'rested';
    return spec;
  }
  // "<A> with a cost of 3, or <B> or <C> with a <Potara> under them"
  const alts = body.split(/,\s*or\s+(?=<)/i).map(one);
  if (alts.some((f) => !f)) return null;
  return { from: [alts[0]!], cost: +m[2], ...(alts.length > 1 ? { orFrom: alts.slice(1) as Filter[] } : {}) };
}

function compileText(text: string): { keywords: Set<Keyword>; abilities: Ability[]; total: number; bad: string[]; evolve?: EvolveSpec } {
  const keywords = new Set<Keyword>();
  const abilities: Ability[] = [];
  let total = 0;
  const bad: string[] = [];
  let evolve: EvolveSpec | undefined;
  for (const line of splitLines(text.replace(/(\S)(\[(?:On Play|When Attacking|Activate|Permanent|Auto)\b)/g, '$1\n$2'))) {
    if (/^\[(fusion )?evolve\]/i.test(line)) {
      total++;
      const ev = parseEvolve(line);
      if (ev) evolve = ev; else bad.push(line);
      continue;
    }
    const ab = parseLine(line, keywords);
    if (!ab) continue;
    const sentenceCount = Math.max(1, ab.text.replace(/\([^)]*\)/g, '').split(/(?<=\.)\s+/).length);
    total += sentenceCount;
    bad.push(...ab.unparsed);
    abilities.push(ab);
    // The same skill under each extra timing tag, sharing its parsed body.
    for (const t of ab.alsoTimings ?? []) abilities.push({ ...ab, timing: t, alsoTimings: undefined });
  }
  return { keywords, abilities, total, bad, evolve };
}

const cache = new Map<string, CompiledCard>();

/**
 * Trust order: a translation you verified or that passed the checker and a second read,
 * then the parser when it reads the whole card, then an unchecked translation, then the
 * parser's partial reading.
 */
export function compileCard(card: Card): CompiledCard {
  const hit = cache.get(card.id);
  if (hit) return hit;
  const scripted = card.script && card.script.textHash === textHash(card) ? fromScript(card.script) : null;
  if (scripted && (scripted.source === 'verified' || scripted.check?.ok)) { cache.set(card.id, scripted); return scripted; }
  const parsed = parseCard(card);
  const pick = scripted && parsed.coverage < 1 ? scripted : parsed;
  cache.set(card.id, pick);
  return pick;
}

/** The parser's own reading, ignoring any stored translation. */
export function parseCard(card: Card): CompiledCard {
  const front = compileText(card.text);
  let total = front.total;
  const bad = [...front.bad];
  const out: CompiledCard = { keywords: front.keywords, abilities: front.abilities, coverage: 1, unparsed: bad, source: 'parser', ...(front.evolve ? { evolve: front.evolve } : {}) };
  if (card.back) {
    const back = compileText(card.back.text);
    out.backKeywords = back.keywords;
    out.backAbilities = back.abilities;
    total += back.total;
    bad.push(...back.bad);
  }
  out.coverage = total === 0 ? 1 : Math.max(0, 1 - bad.length / total);
  return out;
}

/** A stored translation, as the engine's compiled form. */
export function fromScript(sc: CardScript): CompiledCard {
  const abilities = sc.abilities.map(normalizeAbility);
  const backAbilities = sc.backAbilities?.map(normalizeAbility);
  const holes = [...sc.unparsed, ...abilities.flatMap((a) => a.unparsed), ...(backAbilities ?? []).flatMap((a) => a.unparsed)];
  const parts = abilities.length + (backAbilities?.length ?? 0) + holes.length;
  const out: CompiledCard = {
    keywords: new Set(sc.keywords),
    abilities,
    coverage: parts === 0 ? 1 : 1 - holes.length / parts,
    unparsed: holes,
    source: sc.source,
    ...(sc.needs?.length ? { needs: sc.needs } : {}),
    ...(sc.aliases?.length ? { aliases: sc.aliases } : {}),
    ...(sc.check ? { check: sc.check } : {}),
    ...(sc.evolve ? { evolve: sc.evolve } : {}),
  };
  if (backAbilities) { out.backAbilities = backAbilities; out.backKeywords = new Set(sc.backKeywords ?? []); }
  return out;
}

/** Bumped whenever compiled cards may have changed, so caches built on them can tell. */
export let compileGeneration = 0;

export function clearCompileCache() {
  cache.clear();
  compileGeneration++;
}
