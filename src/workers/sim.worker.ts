/// <reference lib="webworker" />
import { Card } from '../data/types';
import { MatchJob, runMatch } from '../builder/evaluate';
import { clearCompileCache } from '../effects/parse';
import { clearValueCache } from '../ai/heuristics';

let cards: Record<string, Card> = {};

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    cards = msg.cards;
    clearCompileCache();
    clearValueCache();
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
