/// <reference lib="webworker" />
import { Card } from '../data/types';
import { MatchJob, runMatch } from '../builder/evaluate';
import { clearCompileCache } from '../effects/parse';
import { clearValueCache } from '../ai/heuristics';
import { findReplay } from '../builder/replay';
import { PlayHost } from '../play/host';

let cards: Record<string, Card> = {};
let play: PlayHost | null = null;

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    cards = msg.cards;
    clearCompileCache();
    clearValueCache();
    return;
  }
  if (msg.type === 'replay') {
    try {
      (self as any).postMessage({ type: 'replay', replay: findReplay(cards, msg.opts) });
    } catch (e: any) {
      (self as any).postMessage({ type: 'error', error: String(e?.stack ?? e) });
    }
    return;
  }
  if (typeof msg.type === 'string' && msg.type.startsWith('play')) {
    try {
      let out: any;
      if (msg.type === 'playStart') { play = new PlayHost(cards, msg.opts); out = play.view(); }
      else if (!play) throw new Error('No game in progress.');
      else if (msg.type === 'playAct') out = play.act(msg.i);
      else if (msg.type === 'playAnswer') out = play.answer(msg.picks);
      else if (msg.type === 'playAI') out = play.aiStep();
      else if (msg.type === 'playRecord') out = play.record();
      else out = play.view();
      (self as any).postMessage({ type: 'play', id: msg.id, out });
    } catch (e: any) {
      (self as any).postMessage({ type: 'error', id: msg.id, error: String(e?.stack ?? e) });
    }
    return;
  }
  if (msg.type === 'job') {
    try {
      const result = runMatch(cards, msg.job as MatchJob);
      (self as any).postMessage({ type: 'result', id: msg.id, result });
    } catch (e: any) {
      (self as any).postMessage({ type: 'error', id: msg.id, error: String(e?.stack ?? e) });
    }
  }
};
