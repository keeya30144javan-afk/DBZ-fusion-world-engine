import { Ability, CompiledCard, Cond, Cost, Count, Effect, EvolveSpec, Filter, Target, Val } from './types';

/**
 * Compiled skills -> plain English, in Fusion World's own phrasing where
 * possible. Used to check a translation against the printed text: if the
 * reading says something different, the translation is wrong.
 */

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const list = (xs: string[], join = 'or') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${join} ${xs[xs.length - 1]}`);

const PLURAL: Record<string, string> = { card: 'cards', 'Battle Card': 'Battle Cards', Extra: 'Extras', Leader: 'Leaders', '[Field]': '[Field] cards' };

/** Printed names of keywords, for "[Blocker]" rather than the engine's "blocker". */
export const KW_NAME: Record<string, string> = {
  blocker: '[Blocker]', critical: '[Critical]', doubleStrike: '[Double Strike]', tripleStrike: '[Triple Strike]', superCombo: '[Super Combo]',
  barrier: '[Barrier]', indestructible: '[Indestructible]', field: '[Field]', dragonBall: '[Dragon Ball]', evolve: '[Evolve]', fusionEvolve: '[Fusion Evolve]',
};

export function describeFilter(f: Filter, noun = 'card', plural = false): string {
  const pre: string[] = [];
  if (f.rested) pre.push('Rest Mode');
  if (f.active) pre.push('Active Mode');
  if (f.colors?.length) pre.push(list(f.colors.map((c) => c.toLowerCase())));
  if (f.names?.length) pre.push(list(f.names.map((n) => `<${n}>`)));
  const single = f.type === 'EXTRA' ? 'Extra' : f.type === 'BATTLE' ? 'Battle Card' : noun;
  const base = plural ? PLURAL[single] ?? `${single}s` : single;
  const its = plural ? 'their' : 'its';
  const post: string[] = [];
  const cost = f.originalCost ? 'an original cost' : 'a cost';
  if (f.costEQ !== undefined) post.push(`${cost} of ${f.costEQ}`);
  if (f.costLE !== undefined && f.costGE !== undefined) post.push(`${cost} of ${f.costGE} to ${f.costLE}`);
  else if (f.costLE !== undefined) post.push(`${cost} of ${f.costLE} or less`);
  else if (f.costGE !== undefined) post.push(`${cost} of ${f.costGE} or more`);
  const pwr = f.originalPower ? 'an original power of ' : '';
  if (f.powerEQ !== undefined) post.push(f.originalPower ? `${pwr}${f.powerEQ}` : `${f.powerEQ} power`);
  if (f.powerLE !== undefined) post.push(f.originalPower ? `${pwr}${f.powerLE} or less` : `${f.powerLE} power or less`);
  if (f.powerGE !== undefined) post.push(f.originalPower ? `${pwr}${f.powerGE} or more` : `${f.powerGE} power or more`);
  if (f.traits?.length) post.push(`${list(f.traits.map((t) => `≪${t}≫`))} in ${its} special traits`);
  if (f.traitsAll?.length) post.push(`${f.traitsAll.length > 1 ? 'both ' : ''}${list(f.traitsAll.map((t) => `≪${t}≫`), 'and')} in ${its} special traits`);
  if (f.onlyTraits?.length) pre.unshift(`${list(f.onlyTraits.map((t) => `≪${t}≫`))}-only`);
  if (f.notTraits?.length) post.push(`no ${list(f.notTraits.map((t) => `≪${t}≫`))} special trait`);
  if (f.notNames?.length) pre.unshift(`non-${list(f.notNames.map((n) => `<${n}>`))}`);
  if (f.keyword) post.push(KW_NAME[f.keyword] ?? `[${f.keyword}]`);
  if (f.noSkill) pre.unshift('skill-less');
  if (f.kiGE !== undefined) post.push(`${f.kiGE} or more Ki`);
  if (f.comboEQ !== undefined) post.push(`${f.comboEQ} combo power`);
  if (f.comboLE !== undefined) post.push(`${f.comboLE} combo power or less`);
  if (f.underNames?.length) post.push(`a ${list(f.underNames.map((n) => `<${n}>`))} under it`);
  if (f.costLEv) post.push(`a cost less than or equal to ${describeVal(f.costLEv)}`);
  if (f.costEQv) post.push(`a cost equal to ${describeVal(f.costEQv)}`);
  if (f.powerLEv) post.push(`power less than or equal to ${describeVal(f.powerLEv)}`);
  if (f.sharesTraitWithPrev) post.push('a special trait shared with the card chosen by this skill');
  const rel: string[] = [];
  if (f.playedFrom) rel.push(`played from your ${f.playedFrom === 'drop' ? 'Drop' : f.playedFrom}`);
  if (f.playedThisTurn) rel.push('played during this turn');
  if (f.anyOf?.length) {
    // "A or B -- both with ...": the alternatives, then whatever every option must also have.
    const rest: Filter = { ...f, anyOf: undefined };
    const shared = Object.values(rest).some((v) => v !== undefined) ? describeFilter(rest, noun, plural) : '';
    const tail = shared.includes(' with ') ? ` (${f.anyOf.length === 2 ? 'both ' : 'all '}${shared.slice(shared.indexOf(' with ') + 1)})` : shared && shared !== base ? ` (${shared})` : '';
    return `${f.anyOf.map((x) => describeFilter(x, noun, plural)).join(' or ')}${tail}`;
  }
  let out = [...pre, base].join(' ');
  if (post.length) out += ` with ${list(post, 'and')}`;
  if (rel.length) out += ` that ${plural ? 'were' : 'was'} ${list(rel, 'and')}`;
  if (f.other) out = `other ${out}`;
  return out;
}

export function describeVal(v: Val): string {
  const plus = v.plus ? (v.plus > 0 ? ` plus ${v.plus}` : ` minus ${-v.plus}`) : '';
  const base = {
    prevCost: "the cost of the card chosen by this skill",
    prevPower: "the power of the card chosen by this skill",
    kiRemoved: 'the number of Ki removed by this skill',
    revealedCost: "the revealed card's cost",
    thisCost: "this card's cost",
    energy: 'the number of your energy',
    leaderKi: 'the Ki under your Leader',
    count: `the number of ${v.count ? describeCount(v.count) : 'cards'}`,
    totalCost: `the combined cost of your ${describeFilter(v.filter ?? {}, 'Battle Card', true)} in your Battle Area`,
  }[v.of];
  return base + plus;
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
  if (t.zones.length === 1 && t.zones[0] === 'leader') {
    const f = Object.keys(t.filter).length ? ` (if it is a ${describeFilter(t.filter, 'Leader')})` : '';
    return `${t.side === 'opp' ? "your opponent's" : t.side === 'any' ? 'each' : 'your'} Leader${f}`;
  }
  const many = !!t.all || t.count > 1;
  const what = describeFilter(t.filter, t.zones.includes('field') && !t.zones.includes('battle') ? '[Field]' : 'Battle Card', many);
  const who = t.zones.includes('leader') && t.zones.includes('battle') ? (t.side === 'opp' ? "your opponent's Leader or" : 'your Leader or') : '';
  const qty = t.all ? 'all' : t.count >= 99 ? 'any number of' : `${t.upTo ? 'up to ' : ''}${t.count}`;
  const budget = t.totalCostLE !== undefined ? ` whose costs add up to ${t.totalCostLE} or less` : t.totalPowerLE !== undefined ? ` that add up to a total power of ${t.totalPowerLE} or less` : '';
  const base = `${who ? who + ' ' : ''}${qty} ${what}${budget} ${whose(t)}`;
  return t.chooser === 'opp' ? `${base} (your opponent chooses)` : base;
}

const DUR: Record<string, string> = { battle: ' for the battle', turn: ' for the turn', oppNextTurn: " until the end of your opponent's next turn", static: '', game: ' for the game' };

const KW: Record<string, string> = {
  cantAttack: "can't attack", cantAttackLeader: "can't attack your opponent's Leader", cantBlock: "can't activate [Blocker]",
  koImmuneSkills: "can't be KO'd by your opponent's skills", koImmune: "can't be KO'd", koImmuneOnce: "can't be KO'd once per turn", koImmuneBattle: "can't be KO'd in battle",
  removeImmune: "can't be removed from the Battle Area by your opponent's skills", cantBeRested: "can't be switched to Rest Mode by your opponent",
  attackActive: "can attack Active Mode Battle Cards", comboRested: 'can be used in a combo even while in Rest Mode',
  noUntap: "can't be switched to Active Mode during your Charge Phase", mustAttack: 'must attack whenever possible',
};

/** Keywords that are really rules on the card itself. */
const KW_RULE: Record<string, string> = {
  noUntap: "can't be switched to Active Mode during your Charge Phase", mustAttack: 'must attack whenever possible',
  comboRested: 'can be used in a combo even while in Rest Mode', doubleForRest: "can be treated as 2 copies when it is switched to Rest Mode by your Leader's skill",
};

function describeCount(c: Count, plural = false): string {
  if (c.zone === 'thisKi') return 'Ki this card has';
  if (c.zone === 'kiTotal') return 'Ki you have in total';
  if (c.zone === 'kiRemoved') return 'Ki removed by this skill';
  if (c.zone === 'underMax') return `card under your chosen ${describeFilter(c.filter ?? {}, 'Battle Card')}`;
  if (c.zone === 'prev') return `${describeFilter(c.filter ?? {}, 'card')} chosen by this skill`;
  if (c.zone === 'event') return 'card moved by that event';
  if (c.zone === 'thisKiRemovedBattle') return 'Ki removed from this card during this battle';
  if (c.distinct) return `${plural ? 'types' : 'type'} of ${describeFilter(c.filter ?? {}, 'card', true)} in ${c.side === 'self' ? 'your' : "your opponent's"} ${c.zone === 'battleDrop' ? 'Battle Area and/or Drop' : c.zone === 'battle' ? 'Battle Area' : c.zone[0].toUpperCase() + c.zone.slice(1)}`;
  if (c.zone === 'leaderBattle') return `${describeFilter(c.filter ?? {}, 'card', plural)} among your Leader and Battle Cards`;
  if (c.zone === 'battleDrop') return `${describeFilter(c.filter ?? {}, 'card', plural)} in your Battle Area and/or Drop`;
  const zone = c.zone === 'under' ? 'under your cards' : `in ${c.side === 'self' ? 'your' : "your opponent's"} ${c.zone === 'battle' ? 'Battle Area' : c.zone[0].toUpperCase() + c.zone.slice(1)}`;
  return `${describeFilter(c.filter ?? {}, 'card', plural)} ${zone}`;
}

export function describeEffect(e: Effect): string {
  const tgt = 'target' in e ? describeTarget(e.target) : '';
  const pick = 'target' in e && !e.target.ref && !e.target.all ? `choose ${tgt} and ` : '';
  const many = 'target' in e && !e.target.ref && (!!e.target.all || e.target.count > 1);
  const it = many ? 'them' : 'it';
  const subj = 'target' in e && (e.target.ref || e.target.all) ? tgt : many ? 'they' : 'it';
  let out: string;
  switch (e.t) {
    case 'draw': out = `draw ${plural(e.n, 'card')}${e.per ? ` for each ${describeCount(e.per)}` : ''}`; break;
    case 'lifeToHand': out = `add ${e.upTo ? 'up to ' : ''}${plural(e.n, 'card')} from your life to your hand`; break;
    case 'power': out = `${pick}${subj} ${many ? 'get' : 'gets'} ${e.amount >= 0 ? '+' : ''}${e.amount} power${e.per ? ` for each ${describeCount(e.per)}` : ''}${DUR[e.dur]}`; break;
    case 'comboPower': out = `${subj === 'it' ? 'this card' : subj} gets +${e.amount} combo power`; break;
    case 'ko': out = `${pick ? `${pick}KO ${it}` : `KO ${tgt}`}`; break;
    case 'bounce': out = `${pick ? `${pick}return ${it}` : `return ${tgt}`} to ${many || e.target.all ? "their owner's hands" : "its owner's hand"}`; break;
    case 'bottom': out = `${pick ? `${pick}place ${it}` : `place ${tgt}`} at the bottom of ${many || e.target.all ? "their owner's deck" : "its owner's deck"}`; break;
    case 'toDrop': out = `${pick ? `${pick}place ${it}` : `place ${tgt}`} into ${many || e.target.all ? "their owner's Drop" : "its owner's Drop"}`; break;
    case 'toEnergy': out = `${pick ? `${pick}add ${it}` : `add ${tgt}`} to its owner's energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'rest': out = `${pick ? `${pick}switch ${it}` : `switch ${tgt}`} to Rest Mode`; break;
    case 'activate': out = `${pick ? `${pick}switch ${it}` : `switch ${tgt}`} to Active Mode`; break;
    case 'lockActive': out = `${pick}${subj} can't switch to Active Mode during your opponent's next turn`; break;
    case 'grant': out = `${pick}${subj} ${KW[e.kw] ?? `${many || e.target.all ? 'gain' : 'gains'} ${KW_NAME[e.kw] ?? `[${e.kw}]`}`}${DUR[e.dur]}`; break;
    case 'costMod': {
      const whose = e.target.ref === 'this' ? "this card's cost" : e.target.ref || e.target.all ? `the cost of ${tgt}` : many ? 'their cost' : 'its cost';
      out = `${pick}${e.amount < 0 ? `reduce ${whose} by ${-e.amount}` : `increase ${whose} by ${e.amount}`}${e.per ? ` for each ${describeCount(e.per)}` : ''}${DUR[e.dur]}`;
      break;
    }
    case 'search': {
      const dest = e.dest ?? 'hand';
      out = `look at ${e.fromBottom ? `the bottom ${e.look === 1 ? 'card' : plural(e.look, 'card')}` : `${plural(e.look, 'card')} from the top`} of your deck, ${e.eachOption ? `reveal ${e.options.map((f) => `up to 1 ${describeFilter(f)}`).join(' and ')}` : `reveal up to ${e.take} ${list(e.options.map((f) => describeFilter(f)))}`} and ${dest === 'play' ? `play it${e.rested ? ' in Rest Mode' : ''}${e.negate ? ` with its ${e.negate === 'onPlay' ? '[On Play] skills' : 'skills'} negated for the turn` : ''}` : `add it to your ${dest === 'hand' ? 'hand' : dest === 'drop' ? 'Drop' : 'life'}`}. Place the rest ${e.rest === 'drop' ? 'into your Drop' : e.rest === 'top' ? 'on top of your deck' : e.rest === 'hand' ? 'into your hand' : 'at the bottom of your deck in a random order'}`;
      break;
    }
    case 'dropToHand': out = e.per
      ? `add a number of ${list(e.options.map((f) => describeFilter(f)))}s up to the number of ${describeCount(e.per)}${e.distinctCosts ? ', with different costs,' : ''} from your Drop to your hand`
      : e.distinctNames || e.totalCostLE !== undefined
        ? `add up to ${e.each} ${list(e.options.map((f) => describeFilter(f, 'card', true)))}${[e.distinctNames ? ' with different card names' : '', e.totalCostLE !== undefined ? ` whose costs add up to ${e.totalCostLE} or less` : ''].join(e.distinctNames && e.totalCostLE !== undefined ? ' and' : '')} from your Drop to your hand`
        : `add ${list(e.options.map((f) => `up to ${e.each} ${describeFilter(f)}`), 'and')}${e.distinctCosts ? ' with different costs' : ''} from your Drop to your hand`; break;
    case 'playFrom': {
      const what = e.each?.length ? list(e.each.map((f) => `up to 1 ${describeFilter(f)}`), 'and') : `up to ${e.n} ${describeFilter(e.filter)}`;
      const extra = [e.distinctNames ? 'with different card names' : '', e.totalCostLE !== undefined ? `with a combined cost of ${e.totalCostLE} or less` : ''].filter(Boolean).join(' and ');
      const from = e.from === 'drop' ? 'from your Drop' : e.from === 'life' ? 'from your life (look through your life, then shuffle it)' : e.from === 'lifeTop' ? 'from the top of your life (reveal it)' : `from your ${e.from}`;
      out = `play ${what}${e.each?.length && Object.keys(e.filter).length ? ` (${describeFilter(e.filter)})` : ''}${extra ? ` ${extra}` : ''} ${from}${e.rested ? ' in Rest Mode' : ''}${e.negate ? ` with its ${e.negate === 'onPlay' ? '[On Play] skills' : 'skills'} negated for the turn` : ''}`;
      break;
    }
    case 'energyFromDeck': out = `add the top ${plural(e.n, 'card')} of your deck to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromDrop': out = `add up to ${e.n} ${describeFilter(e.filter)} from your Drop to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromLife': out = `add ${plural(e.n, 'card')} from your life to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'energyFromHand': out = `add up to ${e.n} ${describeFilter(e.filter ?? {})} from your hand to your energy${e.rested ? ' in Rest Mode' : ''}`; break;
    case 'activateEnergy': out = `switch up to ${e.n} of your Rest Mode energy to Active Mode`; break;
    case 'discard': out = `discard ${plural(e.n, 'card')} from your hand`; break;
    case 'oppDiscard': out = `your opponent discards ${plural(e.n, 'card')} from their hand`; break;
    case 'mill': out = `place the top ${plural(e.n, 'card')} of your deck into your Drop`; break;
    case 'costReduce': out = e.n >= 99 && !e.per ? 'you can play this card from your hand without paying its cost' : `reduce the cost of this card in your hand by ${e.n}${e.per ? ` for each ${describeCount(e.per)}` : ''}`; break;
    case 'cantBlock': out = "your opponent can't activate [Blocker] during this battle"; break;
    case 'damageLeader': out = `deal ${e.n} damage to your opponent`; break;
    case 'flipLeader': out = 'flip this card over'; break;
    case 'ki': out = `${pick}${subj} ${many ? 'get' : 'gets'} +${e.n} Ki${e.per ? ` for each ${describeCount(e.per)}` : ''}`; break;
    case 'placeMarker': out = `you place ${e.n} energy marker`; break;
    case 'lifeFromDeck': out = e.until !== undefined ? `add cards from the top of your deck to your life until you have ${e.until} life` : `add the top ${plural(e.n, 'card')} of your deck to your life`; break;
    case 'handToLife': out = `add ${e.upTo ? 'up to ' : ''}${plural(e.n, 'card')} from your hand to ${e.pos === 'bottom' ? 'the bottom of your life' : e.pos === 'topOrBottom' ? 'the top or bottom of your life' : 'your life'}`; break;
    case 'handToDeck': out = `place ${plural(e.n, 'card')} from your hand ${e.bottom ? 'at the bottom' : 'on top'} of your deck`; break;
    case 'self': out = { hand: "return this card to its owner's hand", drop: 'place this card into your Drop', energy: `add this card to your energy${e.rested ? ' in Rest Mode' : ''}`, deckBottom: 'place this card at the bottom of your deck', life: 'add this card from your Battle Area to your life', play: `play this card from where it is (your Drop)${e.rested ? ' in Rest Mode' : ''}` }[e.to]; break;
    case 'nextDiscount': out = `during this turn, the next time you use ${describeFilter(e.filter).replace(/^(?=[A-Z<])/, 'a ').replace(/^a (?=Extra)/, 'an ')} from your hand, ${e.amount === 'free' ? "you don't have to pay the cost" : `reduce the cost by ${e.amount}`}`; break;
    case 'cantPlay': out = `${e.opp ? "your opponent can't" : "you can't"} ${e.extras ? 'use' : 'play'} ${describeFilter(e.filter, e.extras ? 'Extra' : 'Battle Card')}${DUR[e.dur]}`; break;
    case 'oppTax': out = `add ${e.amount} to the cost of ${describeFilter(e.filter ?? {}, 'card', true)} your opponent uses ${e.dur === 'turn' ? 'for the turn' : 'until the end of their next turn'}`; break;
    case 'oppPlayRested': out = `until the end of your opponent's next turn, their ${describeFilter(e.filter, 'Battle Card', true)} are played in Rest Mode`; break;
    case 'placeUnder': out = e.untilUnder !== undefined
      ? `place any number of ${list(e.filters.map((f) => describeFilter(f)))} from your ${e.from === 'handOrBattle' ? 'hand or Battle Area' : e.from === 'drop' ? 'Drop' : e.from} under ${describeTarget(e.target)} until it has ${e.untilUnder} or fewer cards under it`
      : `place ${list(e.filters.map((f) => `up to ${e.n} ${describeFilter(f)}`), 'and')} from your ${e.from === 'drop' ? 'Drop' : e.from === 'handOrBattle' ? 'hand or Battle Area' : e.from} under ${describeTarget(e.target)}`; break;
    case 'choose': out = `choose one — ${e.options.map((o, i) => `(${i + 1}) ${o.map(describeEffect).join('. Then, ')}`).join(' ')}`; break;
    case 'comboFrom': out = `${e.per ? `for each ${describeCount(e.per)}, ` : ''}use up to ${e.n} ${describeFilter(e.filter, 'Battle Card')} from your ${e.from === 'drop' ? 'Drop' : 'deck top'} in a combo`; break;
    case 'atEndOfTurn': out = `at the end of the turn, ${e.effects.map(describeEffect).join(', then ')}`; break;
    case 'lockSkill': out = `you can't activate the [${e.timing === 'activateMain' ? 'Activate: Main' : 'Activate: Battle'}] of ${list(e.names.map((n) => `<${n}>`))}${DUR[e.dur]}`; break;
    case 'dropToDeck': out = e.bottom ? "place all cards from your Drop at the bottom of their owner's deck in a random order" : "return all cards from your Drop to your deck in a random order"; break;
    case 'lifeToDeck': out = `look through your life and place ${plural(e.n, 'card')} on top of your deck`; break;
    case 'negate': out = `${pick}negate ${e.target.ref === 'this' ? "this card's" : 'its'} ${e.scope === 'onPlay' ? '[On Play] skills' : 'skills'}${DUR[e.dur]}`; break;
    case 'winGame': out = 'you win the game'; break;
    case 'atEndOfBattle': out = `at the end of the battle, ${e.effects.map(describeEffect).join(', then ')}`; break;
    case 'oppMarker': out = `your opponent places ${e.n} energy marker`; break;
    case 'selfDamage': out = `you take ${e.n} damage`; break;
    case 'energyToDrop': out = `place ${plural(e.n, 'card')} from your energy into your Drop`; break;
    case 'redirect': out = `${pick}switch the attack target to ${e.target.ref || e.target.all ? tgt : 'it'}`; break;
    case 'reveal': out = { deckTop: 'reveal the top card of your deck', oppDeckTop: "reveal the top card of your opponent's deck", oppHand: "choose 1 card from your opponent's hand and reveal it", lifeTop: 'reveal the top card of your life' }[e.from]; break;
    case 'pick': out = `choose ${tgt}`; break;
    case 'attackRule': out = describeAttackRule(e); break;
    case 'damageCap': out = `you only take up to ${e.n} damage in each battle`; break;
    case 'shield': out = `negate the next damage you take${DUR[e.dur]}`; break;
    case 'cantLose': out = `you will not lose the game${DUR[e.dur]}`; break;
    case 'oppLife': out = `place ${plural(e.n, 'card')} of your opponent's life into its owner's ${e.to === 'drop' ? 'Drop' : `energy${e.rested ? ' in Rest Mode' : ''}`}`; break;
    case 'oppMill': out = `place the top ${plural(e.n, 'card')} of your opponent's deck into their owner's Drop`; break;
    case 'delayed': {
      const who = `your ${e.filter ? describeFilter(e.filter) : 'card'}`;
      if (e.on === 'usesExtra') { out = `during this turn, if you use ${e.filter ? aCard(describeFilter(e.filter, 'Extra')) : 'an Extra'}, ${e.effects.map(describeEffect).join(', then ')}`; break; }
      const when = e.on === 'dealsDamage' ? `${who} inflicts damage to your opponent in battle` : e.on === 'koInBattle' ? `${who} KO's your opponent's Battle Card in battle` : `${who} attacks ${e.targetFilter ? `your opponent's ${describeFilter(e.targetFilter, 'Battle Card')}` : 'a card'}`;
      out = `during this turn, ${e.once ? 'the next time' : 'when'} ${when}, ${e.effects.map(describeEffect).join(', then ')}`;
      break;
    }
    case 'handCostMod': out = `${e.once ? 'once per turn, ' : ''}${e.amount === 'free' ? `you can use ${describeFilter(e.filter)} in your hand without paying its cost` : `${e.amount < 0 ? 'reduce' : 'increase'} the cost of ${describeFilter(e.filter, 'card', true)} in your hand by ${Math.abs(e.amount)}`}`; break;
    case 'altCost': out = `${e.inBattle ? 'during a battle, ' : ''}when you would pay the cost of ${e.filter ? `${describeFilter(e.filter)} from your hand${e.costLEv ? ` with a cost less than or equal to ${describeVal(e.costLEv)}` : ''}` : 'this card in your hand'}, ${e.once ? 'once per turn, ' : ''}you may ${e.costs.map(describeCost).join(' and ')}${e.scaleN ? ' (as many as that card\'s cost)' : ''} instead`; break;
    case 'dropCost': out = e.filter
      ? `the cost of ${describeFilter(e.filter)} in your Drop ${e.set !== undefined ? `becomes ${e.set}` : `${(e.amount ?? 0) < 0 ? 'is reduced' : 'is increased'} by ${Math.abs(e.amount ?? 0)}`}`
      : `${e.set !== undefined ? `the cost of this card in its owner's Drop becomes ${e.set}` : `${(e.amount ?? 0) < 0 ? 'reduce' : 'increase'} the cost of this card in its owner's Drop by ${Math.abs(e.amount ?? 0)}`}`; break;
    case 'setBasePower': out = `${pick}${subj === 'it' ? "its" : `${subj}'s`} original power becomes ${typeof e.value === 'number' ? e.value : describeVal(e.value)}${DUR[e.dur]}`; break;
    case 'evolveDiscount': out = `during this turn, reduce the cost of the next [Evolve] skill you activate for ${describeFilter(e.filter)} in your hand by ${e.amount}`; break;
    case 'evolveFromUnder': out = `[Evolve] on ${describeFilter(e.filter)} from your hand can choose a card from under this card`; break;
    case 'toCombo': out = `${pick ? pick + 'place it' : `place ${tgt}`} into its owner's Combo Area`; break;
    case 'oppNoActivate': out = "your opponent's cards can't be switched to Active Mode by skills"; break;
    case 'repeatExtra': out = `during this turn, the next time you use ${describeFilter(e.filter, 'Extra')}, after activating the skill, activate that Extra's skill again`; break;
    case 'skillDiscount': out = `during this turn, the next time you activate a skill on ${describeFilter(e.filter)}, reduce the skill cost by ${e.amount}`; break;
    case 'unflipLeader': out = 'flip your Leader to its front side'; break;
    case 'swapBattler': out = `${pick}change your card that's in a battle to ${e.target.ref === 'this' ? 'this card' : 'the chosen card'}`; break;
    case 'extraTurn': out = 'take an extra turn after this one'; break;
    case 'copyOnPlay': out = `choose up to ${e.n} ${describeFilter(e.filter, 'card', true)} under this card and activate their [On Play] skills with no skill cost as though this card had them`; break;
    case 'useDropSkill': out = `choose up to 1 ${describeFilter(e.filter)} in your Drop and activate its [${TIMING[e.timing] ?? e.timing}] skill. Then, place that card at the bottom of its owner's deck`; break;
    case 'energyToHand': out = `add up to ${e.n} ${describeFilter(e.filter)} from your energy to your hand`; break;
    case 'energyRedirect': out = "if you would add a card to its owner's energy during this turn, place that card into its owner's Drop instead"; break;
    case 'lockEnergy': out = `choose up to ${e.n} of your opponent's Rest Mode energy, and it can't switch to Active Mode during your opponent's next turn`; break;
    case 'restOppEnergy': out = e.n !== undefined ? `choose up to ${e.n} card${e.n === 1 ? '' : 's'} in your opponent's energy and switch ${e.n === 1 ? 'it' : 'them'} to Rest Mode` : `switch all ${describeFilter(e.filter, 'card', true)} in your opponent's energy to Rest Mode`; break;
    case 'optionalCost': out = `you may ${e.costs.map(describeCost).join(' and ')}` + (e.effects.length ? `. If you do, ${e.effects.map(describeEffect).join(', then ')}` : ''); break;
    case 'group': out = e.effects.map(describeEffect).join('. Then, '); break;
    case 'evolveOnto': out = 'play the card chosen by this skill on top of this card'; break;
    case 'noop': out = e.note; break;
  }
  return e.cond?.length ? `if ${e.cond.map(describeCond).join(' and ')}, ${out}` : out;
}

/** "a card with ...", "an Extra ...", "a <Son Goku> card". */
const aCard = (d: string) => (/^(a|an|the|all|non-)\b/i.test(d) ? d : `${/^[AEIOU]/i.test(d.replace(/^[<≪[]/, '')) ? 'an' : 'a'} ${d}`);

function describeAttackRule(e: Extract<Effect, { t: 'attackRule' }>): string {
  const parts: string[] = [];
  const who = e.attacker ? `using ${describeFilter(e.attacker, 'Battle Card', true)}` : '';
  if (e.noBlock) parts.push("your opponent can't activate [Blocker]");
  if (e.restTax) parts.push(`your opponent can't attack with a Battle Card unless they switch ${e.restTax} of their Active Mode cards to Rest Mode`);
  if (e.onlyAgainst) parts.push(`your opponent can only attack ${describeFilter(e.onlyAgainst, 'card', true)}`);
  if (e.againstThis) parts.push(`this card can't be attacked${e.attacker ? ` by ${describeFilter(e.attacker, 'card', true)}` : ''}`);
  else if (e.against || e.againstZone) parts.push(`your opponent can't attack ${e.againstZone === 'leader' ? (e.against ? describeFilter(e.against, 'Leader', true) : 'Leaders') : `${describeFilter(e.against ?? {}, 'Battle Card', true)} in your Battle Area`}${who ? ` ${who}` : ''}`);
  else if (!e.noBlock && !e.restTax && !e.onlyAgainst) parts.push(`your opponent can't attack ${who}`.trim());
  return parts.join(', and ') + DUR[e.dur];
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
    case 'battleCount': {
      const who = c.side === 'self' ? ['you have', "you don't have", 'your'] : ['your opponent has', "your opponent doesn't have", 'their'];
      if (c.op === 'none') return `${who[1]} a ${describeFilter(c.filter, 'Battle Card')} in ${who[2]} Battle Area`;
      return c.n <= 1 ? `${who[0]} a ${describeFilter(c.filter, 'Battle Card')} in ${who[2]} Battle Area` : `${who[0]} ${c.n} or more ${describeFilter(c.filter, 'Battle Card', true)} in ${who[2]} Battle Area`;
    }
    case 'count': {
      const one = c.op === 'ge' && c.n === 1;
      const qty = c.op === 'none' ? 'no' : one ? 'a' : c.op === 'ge' ? `${c.n} or more` : c.op === 'le' ? `${c.n} or fewer` : `exactly ${c.n}`;
      return `there ${one || (c.op === 'eq' && c.n === 1) ? 'is' : 'are'} ${qty} ${describeCount(c.what, !one && !(c.op === 'eq' && c.n === 1))}`;
    }
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
    case 'prevMatches': return Object.keys(c.filter).length ? `the chosen card is ${aCard(describeFilter(c.filter))}` : 'a card was chosen';
    case 'yourTurn': return c.yes ? "it's your turn" : "it's your opponent's turn";
    case 'not': return `not (${describeCond(c.c)})`;
    case 'or': return c.any.map(describeCond).join(' or ');
    case 'and': return `(${c.all.map(describeCond).join(' and ')})`;
    case 'thisHasUnder': return c.yes ? 'there are cards under this card' : 'there are no cards under this card';
    case 'attacking': return `attacking ${describeFilter(c.filter)}`;
    case 'koedThisTurn': return `your ${c.filter ? describeFilter(c.filter) : 'card'} has KO'd one of your opponent's Battle Cards during this turn`;
    case 'playedByLeaderSkill': return "this card was played by your Leader's skill";
    case 'leaderInBattle': return 'your Leader is in a battle';
    case 'removedOwnThisTurn': return 'your Battle Card was removed from a Battle Area by one of your skills during this turn';
    case 'attackedThisTurn': return c.yes ? 'this card has attacked this turn' : "this card hasn't attacked this turn";
    case 'comboFromDropThisTurn': return 'you used a card from your Drop in a combo during this turn';
    case 'removedBySkillThisTurn': return `${c.filter ? `a ${describeFilter(c.filter, 'Battle Card')}` : 'your Battle Card'} was removed from your Battle Area by a skill during this turn`;
    case 'markerUsedThisTurn': return 'your energy marker was removed during this turn';
    case 'oppHasMarker': return c.yes ? 'your opponent has an energy marker' : "your opponent doesn't have an energy marker";
    case 'markerPaid': return 'you removed an energy marker to use this card (or for this skill)';
    case 'thisMatches': return `this card is ${aCard(describeFilter(c.filter, 'card'))}`;
    case 'extraUsedThisTurn': return c.filter ? `you used ${describeFilter(c.filter, 'Extra')} during this turn` : 'you used an Extra with an original cost of 1 or more during this turn';
    case 'lifeLeftThisTurn': return 'a card was removed from your life during this turn';
    case 'playedByEvolve': return 'this card was played by an [Evolve] skill';
    case 'playedBySkill': return 'this card was played by a skill';
    case 'energyLeftThisTurn': return 'a card was removed from your energy during this turn';
    case 'battleTotalCost': return `${c.only ? `you only have ${describeFilter(c.only, 'card', true)} in your Battle Area and their` : 'the cards in your Battle Area have a'} total cost is ${c.n} or more`;
    case 'bouncedThisTurn': return "a Battle Card in your Battle Area was returned to its owner's hand during this turn";
    case 'comboFromFieldThisTurn': return 'you used a card from your Battle Area in a combo during this turn';
    case 'kiRemovedThisTurn': return 'any Ki have been removed from your cards during this turn';
    case 'inBattleWith': return `${c.leader ? 'your Leader' : 'this card'} is in a battle with your opponent's ${describeFilter(c.filter, 'card')}`;
    case 'revealedMatches': return `the revealed card is ${aCard(describeFilter(c.filter))}`;
    case 'causedByLeader': return `it was caused by your ${c.filter ? describeFilter(c.filter, 'Leader') : 'Leader'}'s skill`;
    case 'thisKiUpThisTurn': return "this card's Ki has increased during this turn";
  }
}

export function describeCost(c: Cost): string {
  switch (c.t) {
    case 'discard': return `discard ${c.n} ${c.filter ? describeFilter(c.filter) : plural(c.n, 'card').replace(/^\d+ /, '')} from your hand`;
    case 'energyToDrop': return `place ${c.n} ${c.filter ? describeFilter(c.filter) : 'card'}${c.n === 1 ? '' : 's'} from your energy into your Drop`;
    case 'restSelf': return 'switch this card to Rest Mode';
    case 'restEnergy': return `pay ${c.n} energy`;
    case 'selfToDrop': return 'place this card into your Drop';
    case 'selfToHand': return "return this card to its owner's hand";
    case 'selfToDeckBottom': return 'place this card at the bottom of your deck';
    case 'koSelf': return 'KO this card';
    case 'lifeToHand': return c.all ? 'add all of your life to your hand' : `add ${plural(c.n, 'card')} from your life to your hand`;
    case 'lifeToDrop': return `place ${plural(c.n, 'card')} from your life into your Drop`;
    case 'takeDamage': return `you take ${c.n} damage`;
    case 'reduceKi': if (c.max) return `remove ${c.max >= 99 ? `all ${c.n > 1 ? `${c.n} or more ` : ''}` : `${c.n} or more (up to ${c.max}) `}Ki from ${c.scope === 'this' ? 'this card' : c.scope === 'leader' ? 'your Leader' : c.scope === 'battle' ? 'your Battle Area' : 'your cards'}`;
      return `reduce ${c.scope === 'this' ? "this card's" : c.scope === 'leader' ? "your Leader's" : c.scope === 'battle' ? 'the' : 'your'} Ki${c.scope === 'battle' ? ' of your Battle Area' : ''} by ${c.n}`;
    case 'koOwn': return `KO ${c.n} ${describeFilter(c.filter, 'Battle Card')} in your Battle Area`;
    case 'restOwn': return `switch ${c.orLeader ? 'your Leader or ' : ''}${c.n} ${describeFilter(c.filter, 'card')} in your Battle Area to Rest Mode`;
    case 'dropOwn': return `place ${c.n} ${describeFilter(c.filter, 'card')} from your Battle Area into your Drop`;
    case 'bounceOwn': return `return ${c.n} ${describeFilter(c.filter, 'card')} from your Battle Area to your hand`;
    case 'bottomOwn': return c.all ? `place all ${describeFilter(c.filter, 'Battle Card', true)} in your Battle Area at the bottom of their owner's deck` : `place ${c.n} ${describeFilter(c.filter, 'Battle Card')} from your Battle Area at the bottom of your deck`;
    case 'removeMarker': return `remove ${c.n} of your energy markers`;
    case 'energyToHand': return `return ${c.n} ${describeFilter(c.filter)} from your energy to your hand`;
    case 'handOrBattleToBottom': return `place ${list(c.filters.map((f) => `1 ${describeFilter(f)}`), 'and')} from your hand or your Battle Area at the bottom of your deck`;
    case 'energyToDeckBottom': return `place ${c.n} of your energy at the bottom of your deck`;
    case 'pickUnder': return `choose 1 ${describeFilter(c.filter)} under ${describeFilter(c.onto)} in your Battle Area`;
    case 'toComboOwn': return `place 1 ${describeFilter(c.filter, 'Battle Card')} from your Battle Area in your Combo Area`;
    case 'handToDeckTop': return `place ${plural(c.n, 'card')} from your hand on top of your deck`;
    case 'mill': return `place the top ${plural(c.n, 'card')} of your deck into your Drop`;
    case 'reveal': return `reveal 1 ${describeFilter(c.filter)} from your hand`;
    case 'dropToDeck': return `place ${c.n} ${describeFilter(c.filter ?? {}, 'card', true)} from your Drop at the bottom of your deck`;
    case 'handToUnder': return `place 1 ${describeFilter(c.filter)} from your hand under ${describeFilter(c.onto)} in your Battle Area`;
    case 'activateOwn': return `switch 1 ${describeFilter(c.filter)} in your Battle Area to Active Mode`;
    case 'underToDrop': return `place ${plural(c.n, 'card')} from under your ${c.filter ? describeFilter(c.filter) : 'cards'} into your Drop`;
  }
}

const TIMING: Record<string, string> = {
  onPlay: 'On Play', whenAttacking: 'When Attacking', whenAttacked: 'When Attacked', whenKOd: "When KO'd", whenBlocking: 'When Blocking',
  activateMain: 'Activate: Main', activateBattle: 'Activate: Battle', counter: 'Counter', permanent: 'Permanent', endOfYourTurn: 'End of Your Turn',
  startOfYourTurn: 'Start of Your Turn', awaken: 'Awaken', comboFromHand: 'Auto: when used in a combo from your hand',
  comboFromField: 'Auto: when used in a combo from the Battle Area', whenDamaged: 'Auto: when you take damage',
  whenAllyPlayed: 'Auto: when your card is played', whenMilled: 'Auto: when placed from your deck into your Drop',
  gameStart: 'Auto: when placed in your Leader Area', whenWinsBattle: 'Auto: when this card wins a battle', whenDealsDamage: 'Auto: when this card inflicts damage with an attack', whenKOsInBattle: "Auto: when this card KO's an opponent's Battle Card in battle", whenAllyKOd: "Auto: when your card is KO'd", comboFromDrop: 'Auto: when this card is used in a combo from your Drop', whenAllyAttacks: 'Auto: when your card attacks', whenComboInBattle: 'Auto: when you use a card in a combo while this card is in a battle',
  whenOppAttacks: "Auto: when an opponent's card attacks", whenAllyRemovedBySelf: 'Auto: when your card is removed from the Battle Area by one of your skills',
  whenAllyRemovedByOpp: 'Auto: when your card is removed from the Battle Area by your opponent',
  whenOppBounced: "Auto: when an opponent's Battle Card is returned to their hand by one of your skills",
  whenEnergyToDrop: 'Auto: when a card is placed in your Drop from your energy', whenOppPlays: 'Auto: when your opponent plays a Battle Card',
  whenActivated: 'Auto: when this card is switched to Active Mode by a skill', whenAllyActivated: 'Auto: when your Battle Card is switched to Active Mode by a skill',
  whenFieldComboInBattle: 'Auto: when a card is used in a combo from your Battle Area while this card is in a battle',
  whenDiscardBySkill: 'Auto: when you discard a card from your hand using a skill', whenAllyDealsDamage: 'Auto: when your card deals damage',
  whenAllyKOsInBattle: "Auto: when your card KO's your opponent's Battle Card in battle", whenRestedBySelf: 'Auto: when this card is switched to Rest Mode by one of your skills',
  replace: 'Permanent', auto: 'Auto',
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export function describeAbility(a: Ability): string {
  const tags = [`[${TIMING[a.timing] ?? a.timing}]`];
  if (a.turn) tags.push(a.turn === 'your' ? '[Your Turn]' : "[Opponent's Turn]");
  if (a.once) tags.push('[Once per turn]');
  let body = '';
  if (a.timing === 'whenAllyAttacks' && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} attacks, `;
  if (a.timing === 'whenAllyKOd' && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} is KO'd, `;
  if (a.timing === 'whenAllyPlayed' && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} is played, `;
  if ((a.timing === 'whenAllyRemovedBySelf' || a.timing === 'whenAllyRemovedByOpp') && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} is removed, `;
  if (a.timing === 'whenOppPlays' && a.trigger) body += `When your opponent plays ${describeFilter(a.trigger, 'Battle Card')}, `;
  if (a.timing === 'whenAllyActivated' && a.trigger) body += `When your ${describeFilter(a.trigger, 'Battle Card')} is switched to Active Mode by a skill, `;
  if (a.timing === 'whenOppAttacks' && a.trigger) body += `When your opponent's ${describeFilter(a.trigger, 'Battle Card')} attacks, `;
  if (a.timing === 'whenDiscardBySkill' && a.trigger) body += `When you discard using the skill of ${describeFilter(a.trigger)}, `;
  if ((a.timing === 'whenAllyDealsDamage' || a.timing === 'whenAllyKOsInBattle') && a.trigger) body += `When your ${describeFilter(a.trigger)} ${a.timing === 'whenAllyDealsDamage' ? 'deals damage' : "KO's an opponent's Battle Card in battle"}, `;
  if (a.timing === 'replace' && a.replace) {
    const r = a.replace;
    const what = r.what === 'this' ? 'this card' : `your ${describeFilter(r.filter ?? {}, 'Battle Card')}`;
    const by = r.by === 'opp' ? ' by your opponent' : r.by === 'oppSkill' ? " by your opponent's skill" : '';
    const lose = r.lose ? 'If you would lose the game due to your life becoming 0, or i' : 'I';
    const pay = [...a.cost.map(describeCost), ...a.effects.map(describeEffect)].join(' and ');
    if (a.cond.length) body += `If ${a.cond.map(describeCond).join(' and ')}: `;
    body += `${lose}f ${what} would be ${r.ko ? "KO'd" : 'removed from the Battle Area'}${by}, you may ${pay} instead`;
    return `${tags.join('')} ${cap(body.trim())}.`;
  }
  if (a.cost.length) body += a.cost.map(describeCost).join(', ') + ': ';
  if (a.cond.length) body += `If ${a.cond.map(describeCond).join(' and ')}, `;
  let effects = a.effects.map(describeEffect).join('. Then, ');
  // A [Permanent] holds continuously, so "until the end of your opponent's next turn" doesn't apply.
  if (a.timing === 'permanent') effects = effects.replace(/^until the end of your opponent's next turn, their/, "your opponent's");
  body += effects;
  if (a.unparsed.length) body += ` [not understood: ${a.unparsed.join(' / ')}]`;
  return `${tags.join('')} ${cap(body.trim())}.`.replace(/\.\./g, '.');
}

export function describeEvolve(ev: EvolveSpec): string {
  const bases = ev.from.map((f) => describeFilter(f));
  const pay = `pay ${ev.cost} energy${ev.extraCost?.length ? `, ${ev.extraCost.map(describeCost).join(', ')}` : ''}`;
  if (ev.from.length === 2) return `[Fusion Evolve] ${pay}: ${bases.join(' and ')}${ev.baseMode === 'rested' ? ' in Rest Mode' : ''} with equal power${ev.equalPowerGE ? ` of ${ev.equalPowerGE} or more` : ''}.`;
  return `[Evolve] ${pay}: ${list([bases[0], ...(ev.orFrom ?? []).map((f) => describeFilter(f))])}.`;
}

/** The whole card as the engine understands it. */
export function describeCompiled(c: CompiledCard): string {
  const lines: string[] = [];
  const kwLines = (set: Iterable<string>) => {
    const named = [...set].filter((k) => KW_NAME[k]).map((k) => KW_NAME[k]);
    const rules = [...set].filter((k) => !KW_NAME[k]).map((k) => `[Permanent] This card ${KW_RULE[k] ?? KW[k] ?? `has [${k}]`}.`);
    return [...(named.length ? [named.join(' ')] : []), ...rules];
  };
  lines.push(...kwLines(c.keywords));
  if (c.aliases?.length) lines.push(`[Permanent] This card's name is also treated as ${list(c.aliases.map((n) => `<${n}>`), 'and')} in all areas.`);
  if (c.evolve) lines.push(describeEvolve(c.evolve));
  for (const a of c.abilities) lines.push(describeAbility(a));
  if (c.backAbilities) {
    lines.push('— Awakened side —');
    if (c.backKeywords?.size) lines.push(...kwLines(c.backKeywords));
    for (const a of c.backAbilities) lines.push(describeAbility(a));
  }
  if (c.needs?.length) lines.push(`Needs engine support for: ${c.needs.join(', ')}`);
  return lines.join('\n');
}
