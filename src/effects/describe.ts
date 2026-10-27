import { Ability, CompiledCard, Cond, Cost, Count, Effect, EvolveSpec, Filter, Target } from './types';

/**
 * Compiled skills -> plain English, in Fusion World's own phrasing where
 * possible. Used to check a translation against the printed text: if the
 * reading says something different, the translation is wrong.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const list = (xs: string[], join = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${join} ${xs[xs.length - 1]}`);

export function describeFilter(f: Filter, noun = 'card'): string {
  const pre: string[] = [];
  if (f.rested) pre.push('Rest Mode');
  if (f.active) pre.push('Active Mode');
  if (f.colors?.length) pre.push(list(f.colors.map((c) => c.toLowerCase())));
  if (f.names?.length) pre.push(list(f.names.map((n) => `<${n}>`)));
  const base = f.type === 'EXTRA' ? 'Extra' : f.type === 'BATTLE' ? 'Battle Card' : noun;
  const post: string[] = [];
  const cost = f.originalCost ? 'an original cost' : 'a cost';
  if (f.costEQ !== undefined) post.push(`${cost} of ${f.costEQ}`);
  if (f.costLE !== undefined && f.costGE !== undefined) post.push(`${cost} of ${f.costGE} to ${f.costLE}`);
  else if (f.costLE !== undefined) post.push(`${cost} of ${f.costLE} or less`);
  else if (f.costGE !== undefined) post.push(`${cost} of ${f.costGE} or more`);
  if (f.powerEQ !== undefined) post.push(`${f.powerEQ} power`);
  if (f.powerLE !== undefined) post.push(`${f.powerLE} power or less`);
  if (f.powerGE !== undefined) post.push(`${f.powerGE} power or more`);
  if (f.traits?.length) post.push(`${list(f.traits.map((t) => `≪${t}≫`))} in its special traits`);
  if (f.traitsAll?.length) post.push(`${list(f.traitsAll.map((t) => `≪${t}≫`), 'and')} in its special traits`);
  if (f.onlyTraits?.length) pre.unshift(`${list(f.onlyTraits.map((t) => `≪${t}≫`))}-only`);
  if (f.notTraits?.length) post.push(`no ${list(f.notTraits.map((t) => `≪${t}≫`))} special trait`);
  if (f.notNames?.length) pre.unshift(`non-${list(f.notNames.map((n) => `<${n}>`))}`);
  if (f.keyword) post.push(`[${f.keyword}]`);
  if (f.noSkill) pre.unshift('skill-less');
  if (f.kiGE !== undefined) post.push(`${f.kiGE} or more Ki`);
  if (f.underNames?.length) post.push(`a ${list(f.underNames.map((n) => `<${n}>`))} under it`);
  let out = [...pre, base].join(' ');
  if (post.length) out += ` with ${list(post, 'and')}`;
  if (f.other) out = `other ${out}`;
  return out;
}

function whose(t: Target): string {
  return t.side === 'opp' ? "in your opponent's Battle Area" : t.side === 'self' ? 'in your Battle Area' : 'in a Battle Area';
}

export function describeTarget(t: Target): string {
  switch (t.ref) {
    case 'this': return 'this card';
    case 'prev': return 'the chosen card';
    case 'leader': return 'your Leader';
    case 'oppLeader': return "your opponent's Leader";
    case 'battler': return `your ${t.filter && Object.keys(t.filter).length ? describeFilter(t.filter) : 'card'} that's in a battle`;
    case 'oppBattler': return "your opponent's card that's in a battle";
  }
  const what = describeFilter(t.filter, t.zones.includes('field') && !t.zones.includes('battle') ? '[Field]' : 'Battle Card');
  const who = t.zones.includes('leader') && t.zones.includes('battle') ? (t.side === 'opp' ? "your opponent's Leader or" : 'your Leader or') : '';
  const qty = t.all ? 'all' : `${t.upTo ? 'up to ' : ''}${t.count}`;
  return `${who ? who + ' ' : ''}${qty} ${what}${t.all || t.count > 1 ? '(s)' : ''} ${whose(t)}`;
}

const DUR: Record<string, string> = { battle: ' for the battle', turn: ' for the turn', oppNextTurn: " until the end of your opponent's next turn", static: '' };

const KW: Record<string, string> = {
  cantAttack: "can't attack", cantAttackLeader: "can't attack your opponent's Leader", cantBlock: "can't activate [Blocker]",
  koImmuneSkills: "can't be KO'd by your opponent's skills", koImmune: "can't be KO'd", koImmuneOnce: "can't be KO'd once per turn",
  removeImmune: "can't be removed from the Battle Area by your opponent's skills", cantBeRested: "can't be switched to Rest Mode by your opponent",
  attackActive: "can attack Active Mode Battle Cards",
};

function describeCount(c: Count): string {
  const zone = c.zone === 'under' ? 'under your cards' : `in ${c.side === 'self' ? 'your' : "your opponent's"} ${c.zone === 'battle' ? 'Battle Area' : c.zone[0].toUpperCase() + c.zone.slice(1)}`;
  return `${describeFilter(c.filter ?? {})} ${zone}`;
}

export function describeEffect(e: Effect): string {
  const tgt = 'target' in e ? describeTarget(e.target) : '';
  const pick = 'target' in e && !e.target.ref && !e.target.all ? `choose ${tgt} and ` : '';
  const subj = 'target' in e && (e.target.ref || e.target.all) ? tgt : 'it';
  let out: string;
  switch (e.t) {
    case 'draw': out = `draw ${plural(e.n, 'card')}`; break;
    case 'lifeToHand': out = `add ${e.upTo ? 'up to ' : ''}${plural(e.n, 'card')} from your life to your hand`; break;
    case 'power': out = `${pick}${subj} gets ${e.amount >= 0 ? '+' : ''}${e.amount} power${e.per ? ` for each ${describeCount(e.per)}` : ''}${DUR[e.dur]}`; break;
    case 'comboPower': out = `${subj === 'it' ? 'this card' : subj} gets +${e.amount} combo power`; break;
    case 'ko': out = `${pick ? pick + 'KO it' : `KO ${tgt}`}`; break;
    case 'bounce': out = `${pick ? pick + "return it to its owner's hand" : `return ${tgt} to its owner's hand`}`; break;
    case 'bottom': out = `${pick ? pick + "place it at the bottom of its owner's deck" : `place ${tgt} at the bottom of its owner's deck`}`; break;
    case 'toDrop': out = `${pick ? pick + "place it into its owner's Drop" : `place ${tgt} into its owner's Drop`}`; break;
    case 'toEnergy': out = `${pick ? pick + 'add it' : `add ${tgt}`} to its owner's energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'rest': out = `${pick ? pick + 'switch it' : `switch ${tgt}`} to Rest Mode`; break;
    case 'activate': out = `${pick ? pick + 'switch it' : `switch ${tgt}`} to Active Mode`; break;
    case 'lockActive': out = `${pick}${subj} can't switch to Active Mode during your opponent's next turn`; break;
    case 'grant': out = `${pick}${subj} ${KW[e.kw] ?? `gains [${e.kw}]`}${DUR[e.dur]}`; break;
    case 'costMod': out = `${pick}${e.amount < 0 ? `reduce its cost by ${-e.amount}` : `increase its cost by ${e.amount}`}${DUR[e.dur]}`; break;
    case 'search': {
      const dest = e.dest ?? 'hand';
      out = `look at ${plural(e.look, 'card')} from the top of your deck, reveal up to ${e.take} ${list(e.options.map((f) => describeFilter(f)))} and ${dest === 'play' ? 'play it' : `add it to your ${dest === 'hand' ? 'hand' : dest === 'drop' ? 'Drop' : 'life'}`}. Place the rest ${e.rest === 'drop' ? 'into your Drop' : e.rest === 'top' ? 'on top of your deck' : 'at the bottom of your deck in a random order'}`;
      break;
    }
    case 'dropToHand': out = `add ${list(e.options.map((f) => `up to ${e.each} ${describeFilter(f)}`), 'and')} from your Drop to your hand`; break;
    case 'playFrom': out = `play up to ${e.n} ${describeFilter(e.filter)} from your ${e.from === 'drop' ? 'Drop' : e.from}${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromDeck': out = `add the top ${plural(e.n, 'card')} of your deck to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromDrop': out = `add up to ${e.n} ${describeFilter(e.filter)} from your Drop to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromLife': out = `add ${plural(e.n, 'card')} from your life to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromHand': out = `add up to ${e.n} ${describeFilter(e.filter ?? {})} from your hand to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'activateEnergy': out = `switch up to ${e.n} of your energy to Active Mode`; break;
    case 'discard': out = `discard ${plural(e.n, 'card')} from your hand`; break;
    case 'oppDiscard': out = `your opponent discards ${plural(e.n, 'card')} from their hand`; break;
    case 'mill': out = `place the top ${plural(e.n, 'card')} of your deck into your Drop`; break;
    case 'costReduce': out = `reduce the cost of this card in your hand by ${e.n}`; break;
    case 'cantBlock': out = "your opponent can't activate [Blocker] during this battle"; break;
    case 'damageLeader': out = `deal ${e.n} damage to your opponent`; break;
    case 'flipLeader': out = 'flip this card over'; break;
    case 'ki': out = `${pick}${subj} gets +${e.n} Ki`; break;
    case 'placeMarker': out = `you place ${e.n} energy marker`; break;
    case 'lifeFromDeck': out = `add the top ${plural(e.n, 'card')} of your deck to your life`; break;
    case 'handToLife': out = `add ${e.upTo ? 'up to ' : ''}${plural(e.n, 'card')} from your hand to your life`; break;
    case 'handToDeck': out = `place ${plural(e.n, 'card')} from your hand ${e.bottom ? 'at the bottom' : 'on top'} of your deck`; break;
    case 'self': out = { hand: "return this card to its owner's hand", drop: 'place this card into your Drop', energy: `add this card to your energy${e.rested ? ' in Rest Mode' : ''}`, deckBottom: 'place this card at the bottom of your deck', play: `play this card${e.rested ? ' in Rest Mode' : ''}` }[e.to]; break;
    case 'nextDiscount': out = `during this turn, the next time you use ${describeFilter(e.filter)}, ${e.amount === 'free' ? "you don't have to pay the cost" : `reduce the cost by ${e.amount}`}`; break;
    case 'cantPlay': out = `you can't ${e.extras ? 'use' : 'play'} ${describeFilter(e.filter, e.extras ? 'Extra' : 'Battle Card')}${DUR[e.dur]}`; break;
    case 'oppTax': out = `add ${e.amount} to the cost of ${describeFilter(e.filter ?? {})}s your opponent uses until the end of their next turn`; break;
    case 'oppPlayRested': out = `during your opponent's next turn, their ${describeFilter(e.filter, 'Battle Card')}s are played in Rest Mode`; break;
    case 'placeUnder': out = `place ${list(e.filters.map((f) => `up to ${e.n} ${describeFilter(f)}`), 'and')} from your ${e.from === 'drop' ? 'Drop' : e.from} under ${describeTarget(e.target)}`; break;
    case 'choose': out = `choose one — ${e.options.map((o, i) => `(${i + 1}) ${o.map(describeEffect).join('. Then, ')}`).join(' ')}`; break;
    case 'comboFrom': out = `use up to ${e.n} ${describeFilter(e.filter, 'Battle Card')} from your ${e.from === 'drop' ? 'Drop' : 'deck top'} in a combo`; break;
    case 'noop': out = e.note; break;
  }
  return e.cond?.length ? `if ${e.cond.map(describeCond).join(' and ')}, ${out}` : out;
}

export function describeCond(c: Cond): string {
  switch (c.t) {
    case 'handLE': return `you have ${c.n} or fewer cards in your hand`;
    case 'handGE': return `you have ${c.n} or more cards in your hand`;
    case 'energyGE': return `you have ${c.n} or more energy`;
    case 'energyLE': return `you have ${c.n} or less energy`;
    case 'lifeLE': return `your life is at ${c.n} or less`;
    case 'lifeGE': return `your life is at ${c.n} or more`;
    case 'oppLifeLE': return `your opponent's life is at ${c.n} or less`;
    case 'oppLifeGE': return `your opponent's life is at ${c.n} or more`;
    case 'oppHandGE': return `your opponent has ${c.n} or more cards in their hand`;
    case 'dropGE': return `you have ${c.n} or more cards in your Drop`;
    case 'battleCount': return c.op === 'none' ? `${c.side === 'self' ? 'you have' : 'your opponent has'} no ${describeFilter(c.filter, 'Battle Card')}s` : `${c.side === 'self' ? 'you have' : 'your opponent has'} ${c.n} or more ${describeFilter(c.filter, 'Battle Card')}s`;
    case 'count': return `there ${c.op === 'none' ? 'are no' : `are ${c.op === 'ge' ? `${c.n} or more` : c.op === 'le' ? `${c.n} or fewer` : `exactly ${c.n}`}`} ${describeCount(c.what)}`;
    case 'leaderIs': return `your Leader is ${list(c.names.map((n) => `<${n}>`))}`;
    case 'leaderTrait': return `your Leader ${c.only ? `is a ${list(c.traits.map((t) => `≪${t}≫`))}-only card` : `has ${list(c.traits.map((t) => `≪${t}≫`))} in its special traits`}`;
    case 'leaderAwakened': return 'your Leader is awakened';
    case 'kiLeaderGE': return `your Leader has ${c.n} or more Ki`;
    case 'kiTotalGE': return `you have a total of ${c.n} or more Ki${c.scope === 'battle' ? ' in your Battle Area' : ''}`;
    case 'thisKiGE': return `this card has ${c.n} or more Ki`;
    case 'hasMarker': return c.yes ? 'you have an energy marker' : "you don't have an energy marker";
    case 'thisRested': return `this card is in ${c.yes ? 'Rest' : 'Active'} Mode`;
    case 'thisInBattle': return 'this card is in a battle';
    case 'playedThisTurn': return 'this card was played this turn';
    case 'comboAreaHasCard': return 'you have a card in your Combo Area';
    case 'energyLessThanOpp': return 'you have less energy than your opponent';
    case 'attackingBattleCard': return `attacking ${c.filter ? describeFilter(c.filter, 'Battle Card') : 'a Battle Card'}`;
    case 'prevMatches': return `the chosen card is ${describeFilter(c.filter)}`;
    case 'yourTurn': return c.yes ? "it's your turn" : "it's your opponent's turn";
    case 'not': return `not (${describeCond(c.c)})`;
    case 'or': return c.any.map(describeCond).join(' or ');
  }
}

export function describeCost(c: Cost): string {
  switch (c.t) {
    case 'discard': return `discard ${c.n} ${c.filter ? describeFilter(c.filter) : plural(c.n, 'card').replace(/^\d+ /, '')} from your hand`;
    case 'energyToDrop': return `place ${c.n} of your energy into your Drop`;
    case 'restSelf': return 'switch this card to Rest Mode';
    case 'restEnergy': return `pay ${c.n} energy`;
    case 'selfToDrop': return 'place this card into your Drop';
    case 'selfToHand': return "return this card to its owner's hand";
    case 'selfToDeckBottom': return 'place this card at the bottom of your deck';
    case 'koSelf': return 'KO this card';
    case 'lifeToHand': return `add ${plural(c.n, 'card')} from your life to your hand`;
    case 'lifeToDrop': return `place ${plural(c.n, 'card')} from your life into your Drop`;
    case 'reduceKi': return `reduce ${c.scope === 'this' ? "this card's" : c.scope === 'leader' ? "your Leader's" : c.scope === 'battle' ? 'the' : 'your'} Ki${c.scope === 'battle' ? ' of your Battle Area' : ''} by ${c.n}`;
    case 'koOwn': return `KO ${c.n} ${describeFilter(c.filter, 'Battle Card')} in your Battle Area`;
    case 'restOwn': return `switch ${c.n} ${describeFilter(c.filter, 'card')} in your Battle Area to Rest Mode`;
    case 'dropOwn': return `place ${c.n} ${describeFilter(c.filter, 'card')} from your Battle Area into your Drop`;
    case 'bounceOwn': return `return ${c.n} ${describeFilter(c.filter, 'card')} from your Battle Area to your hand`;
    case 'handToDeckTop': return `place ${plural(c.n, 'card')} from your hand on top of your deck`;
    case 'mill': return `place the top ${plural(c.n, 'card')} of your deck into your Drop`;
    case 'reveal': return `reveal 1 ${describeFilter(c.filter)} from your hand`;
    case 'underToDrop': return `place ${plural(c.n, 'card')} from under your ${c.filter ? describeFilter(c.filter) : 'cards'} into your Drop`;
  }
}

const TIMING: Record<string, string> = {
  onPlay: 'On Play', whenAttacking: 'When Attacking', whenAttacked: 'When Attacked', whenKOd: "When KO'd", whenBlocking: 'When Blocking',
  activateMain: 'Activate: Main', activateBattle: 'Activate: Battle', counter: 'Counter', permanent: 'Permanent', endOfYourTurn: 'End of Your Turn',
  startOfYourTurn: 'Start of Your Turn', awaken: 'Awaken', comboFromHand: 'Auto: when used in a combo from your hand',
  comboFromField: 'Auto: when used in a combo from the Battle Area', whenDamaged: 'Auto: when you take damage',
  whenAllyPlayed: 'Auto: when your card is played', whenMilled: 'Auto: when placed from your deck into your Drop',
  gameStart: 'Auto: when placed in your Leader Area', auto: 'Auto',
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function describeAbility(a: Ability): string {
  const tags = [`[${TIMING[a.timing] ?? a.timing}]`];
  if (a.turn) tags.push(a.turn === 'your' ? '[Your Turn]' : "[Opponent's Turn]");
  if (a.once) tags.push('[Once per turn]');
  let body = '';
  if (a.timing === 'whenAllyPlayed' && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} is played, `;
  if (a.cost.length) body += a.cost.map(describeCost).join(', ') + ': ';
  if (a.cond.length) body += `If ${a.cond.map(describeCond).join(' and ')}, `;
  body += a.effects.map(describeEffect).join('. Then, ');
  if (a.unparsed.length) body += ` [not understood: ${a.unparsed.join(' / ')}]`;
  return `${tags.join('')} ${cap(body.trim())}.`.replace(/\.\./g, '.');
}

export function describeEvolve(ev: EvolveSpec): string {
  const bases = ev.from.map((f) => describeFilter(f));
  if (ev.from.length === 2) return `[Fusion Evolve] pay ${ev.cost} energy: ${bases.join(' and ')}${ev.baseMode === 'rested' ? ' in Rest Mode' : ''} with equal power${ev.equalPowerGE ? ` of ${ev.equalPowerGE} or more` : ''}.`;
  return `[Evolve] pay ${ev.cost} energy: ${list([bases[0], ...(ev.orFrom ?? []).map((f) => describeFilter(f))])}.`;
}

/** The whole card as the engine understands it. */
export function describeCompiled(c: CompiledCard): string {
  const lines: string[] = [];
  const kws = [...c.keywords].filter((k) => !['field', 'dragonBall'].includes(k) || true);
  if (kws.length) lines.push(kws.map((k) => `[${k}]`).join(' '));
  if (c.evolve) lines.push(describeEvolve(c.evolve));
  for (const a of c.abilities) lines.push(describeAbility(a));
  if (c.backAbilities) {
    lines.push('— Awakened side —');
    if (c.backKeywords?.size) lines.push([...c.backKeywords].map((k) => `[${k}]`).join(' '));
    for (const a of c.backAbilities) lines.push(describeAbility(a));
  }
  if (c.needs?.length) lines.push(`Needs engine support for: ${c.needs.join(', ')}`);
  return lines.join('\n');
}
