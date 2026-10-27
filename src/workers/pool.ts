import { Card } from '../data/types';
import { MatchJob, MatchResult, runMatch } from '../builder/evaluate';
import { Replay, RecordOpts, findReplay } from '../builder/replay';

declare const __WORKER_SOURCE__: string;

/** One blob URL for the worker script (the build inlines the source at each use, so use it once). */
let workerUrl: string | null = null;
const getWorkerUrl = () => (workerUrl ??= URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' })));

/**
 * Runs match jobs on a pool of Web Workers (one per spare CPU core).
 * Falls back to the main thread if workers cannot start.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: MatchJob; resolve: (r: MatchResult) => void; reject: (e: any) => void }[] = [];
  private pending = new Map<number, { resolve: (r: MatchResult) => void; reject: (e: any) => void; w: Worker }>();
  private nextId = 1;
  private cards: Record<string, Card> = {};
  readonly size: number;
  private fallback = false;

  constructor(size?: number) {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.size = Math.max(1, Math.min(size ?? cores - 1, 12));
    try {
      const url = getWorkerUrl();
      for (let i = 0; i < this.size; i++) {
        const w = new Worker(url);
        w.onmessage = (ev) => this.onMessage(w, ev.data);
        w.onerror = (ev) => this.onCrash(w, ev);
        this.workers.push(w);
        this.idle.push(w);
      }
    } catch {
      this.fallback = true;
    }
  }

  get usingWorkers() {
    return !this.fallback;
  }

  setCards(cards: Record<string, Card>) {
    this.cards = cards;
    for (const w of this.workers) w.postMessage({ type: 'init', cards });
  }

  run(jobs: MatchJob[], onEach?: (r: MatchResult) => void): Promise<MatchResult[]> {
    if (this.fallback) {
      // Yield between jobs so the page stays responsive.
      return jobs.reduce<Promise<MatchResult[]>>(
        (acc, job) => acc.then(async (out) => { await new Promise((r) => setTimeout(r, 0)); const r = runMatch(this.cards, job); onEach?.(r); out.push(r); return out; }),
        Promise.resolve([]),
      );
    }
    return Promise.all(jobs.map((job) => new Promise<MatchResult>((resolve, reject) => {
      this.queue.push({ job, resolve: (r) => { onEach?.(r); resolve(r); }, reject });
      this.pump();
    })));
  }

  cancelQueued() {
    const q = this.queue.splice(0);
    for (const item of q) item.reject(new Error('cancelled'));
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const item = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { resolve: item.resolve, reject: item.reject, w });
      w.postMessage({ type: 'job', id, job: item.job });
    }
  }

  private onMessage(w: Worker, msg: any) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.idle.push(w);
    if (msg.type === 'result') p.resolve(msg.result);
    else p.reject(new Error(msg.error));
    this.pump();
  }

  private onCrash(w: Worker, ev: ErrorEvent) {
    for (const [id, p] of this.pending) if (p.w === w) { this.pending.delete(id); p.reject(new Error(ev.message)); }
    if (!this.idle.includes(w)) this.idle.push(w);
    this.pump();
  }
}

/**
 * Record one game for the viewer on a worker of its own, so it neither waits
 * behind a running search nor freezes the page. Falls back to the main thread.
 */
export function recordReplay(cards: Record<string, Card>, opts: RecordOpts & { want: 'any' | 'win' | 'loss'; tries?: number }): { done: Promise<Replay>; cancel: () => void } {
  let w: Worker | null = null;
  try {
    w = new Worker(getWorkerUrl());
  } catch {
    w = null;
  }
  if (!w) {
    return { done: new Promise((r) => setTimeout(() => r(findReplay(cards, opts)), 0)), cancel: () => {} };
  }
  const worker = w;
  let reject: (e: any) => void = () => {};
  const done = new Promise<Replay>((resolve, rej) => {
    reject = rej;
    worker.onmessage = (ev) => {
      worker.terminate();
      if (ev.data.type === 'replay') resolve(ev.data.replay);
      else rej(new Error(ev.data.error));
    };
    worker.onerror = (ev) => { worker.terminate(); rej(new Error(ev.message)); };
  });
  worker.postMessage({ type: 'init', cards });
  worker.postMessage({ type: 'replay', opts });
  return { done, cancel: () => { worker.terminate(); reject(new Error('cancelled')); } };
}
