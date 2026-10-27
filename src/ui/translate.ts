import { Card } from '../data/types';
import { CardScript } from '../effects/types';
import { LANGUAGE_REFERENCE } from '../effects/reference';
import { expandScript, textHash, validateScript } from '../effects/script';
import { fromScript, parseCard } from '../effects/parse';
import { describeCompiled } from '../effects/describe';
import { ScriptDoc } from './store';

/** Cards the engine can't fully read and that have no translation yet, newest sets first. */
export function untranslated(cards: Record<string, Card>, reviews: Record<string, ScriptDoc>): Card[] {
  return Object.values(cards)
    .filter((c) => !reviews[c.id] && !(c.script && c.script.textHash === textHash(c)) && parseCard(c).coverage < 1)
    .sort((a, b) => b.id.localeCompare(a.id));
}

export const cardBrief = (c: Card) => ({
  id: c.id, name: c.name, type: c.type, colors: c.colors, cost: c.cost, power: c.power, traits: c.traits,
  text: c.text, ...(c.back ? { back: c.back.text } : {}),
});

export interface TranslateResult {
  id: string;
  doc?: ScriptDoc;
  errors?: string[];
}

export type Sampler = ((input: string, opts?: any) => Promise<{ text: string }>) & { json: (input: string, opts?: any) => Promise<any> };

const pickJSON = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Turn a model answer into a stored script, or the reasons it was refused. */
export function acceptScript(card: Card, raw: unknown): { script?: CardScript; errors: string[] } {
  if (!raw || typeof raw !== 'object') return { errors: ['no translation returned'] };
  let script: CardScript;
  try {
    const body = expandScript(raw) as CardScript;
    script = { ...body, source: 'claude', unparsed: body.unparsed ?? [], textHash: textHash(card) };
  } catch (e: any) {
    return { errors: [String(e?.message ?? e)] };
  }
  const errors = validateScript(script);
  return errors.length ? { errors } : { script, errors: [] };
}

/**
 * Translate a batch: one call to translate, one call to repair anything the
 * validator refused, one call for an independent check of the English reading.
 * Never more than three calls per batch, whatever happens.
 */
export async function translateBatch(sample: Sampler, batch: Card[], onStep: (msg: string) => void, signal?: AbortSignal): Promise<TranslateResult[]> {
  const opts = { modelTier: 'complex' as const, signal, cache: false };
  onStep(`Translating ${batch.length} cards…`);
  const answer = pickJSON(await sample.json(
    `${LANGUAGE_REFERENCE}\n\nTranslate each of these cards. Answer with one JSON object mapping each card id to its SCRIPT.\n\n${JSON.stringify(batch.map(cardBrief))}`,
    opts,
  ));
  const results = new Map<string, TranslateResult>();
  const scripts = new Map<string, CardScript>();
  const retry: { card: Card; raw: unknown; errors: string[] }[] = [];
  for (const card of batch) {
    const r = acceptScript(card, answer[card.id]);
    if (r.script) scripts.set(card.id, r.script);
    else retry.push({ card, raw: answer[card.id], errors: r.errors });
  }

  if (retry.length) {
    onStep(`Fixing ${retry.length} translation${retry.length === 1 ? '' : 's'} the validator refused…`);
    const fixed = pickJSON(await sample.json(
      `${LANGUAGE_REFERENCE}\n\nThese translations were refused by the validator. Correct each one. Answer with one JSON object mapping each card id to its corrected SCRIPT.\n\n${JSON.stringify(retry.map((x) => ({ card: cardBrief(x.card), translation: x.raw, errors: x.errors })))}`,
      opts,
    ));
    for (const x of retry) {
      const r = acceptScript(x.card, fixed[x.card.id]);
      if (r.script) scripts.set(x.card.id, r.script);
      else results.set(x.card.id, { id: x.card.id, errors: r.errors });
    }
  }

  const readings = batch.filter((c) => scripts.has(c.id)).map((c) => ({ id: c.id, printed: c.text + (c.back ? `\nAWAKENED SIDE: ${c.back.text}` : ''), engineReading: describeCompiled(fromScript(scripts.get(c.id)!)) }));
  let checks: Record<string, { ok?: boolean; issues?: string }> = {};
  if (readings.length) {
    onStep(`Checking ${readings.length} readings against the printed text…`);
    checks = pickJSON(await sample.json(
      `You audit a card game simulator. For each card, compare the printed card text with the simulator's English reading of it. ` +
      `Report ok:false if the reading adds, drops or changes any effect, cost, condition, target, number, duration or choice. Wording differences are fine. ` +
      `Answer with one JSON object mapping each id to {"ok": boolean, "issues": "short description, empty if ok"}.\n\n${JSON.stringify(readings)}`,
      { ...opts, modelTier: 'default' },
    ));
  }

  const now = new Date().toISOString();
  for (const c of batch) {
    const script = scripts.get(c.id);
    if (!script) continue;
    const ck = checks[c.id];
    results.set(c.id, { id: c.id, doc: { textHash: script.textHash, script, status: 'unreviewed', updated: now, ...(ck ? { check: { ok: !!ck.ok, issues: String(ck.issues ?? '') } } : {}) } });
  }
  return batch.map((c) => results.get(c.id) ?? { id: c.id, errors: ['no translation returned'] });
}
