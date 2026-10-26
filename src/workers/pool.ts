import { Card } from '../data/types';
import { MatchJob, MatchResult, runMatch } from '../builder/evaluate';

declare const __WORKER_SOURCE__: string;

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
      const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
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

  run(jobs: MatchJob[]): Promise<MatchResult[]> {
    if (this.fallback) {
      // Yield between jobs so the page stays responsive.
      return jobs.reduce<Promise<MatchResult[]>>(
        (acc, job) => acc.then(async (out) => { await new Promise((r) => setTimeout(r, 0)); out.push(runMatch(this.cards, job)); return out; }),
        Promise.resolve([]),
      );
    }
    return Promise.all(jobs.map((job) => new Promise<MatchResult>((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.pump(); })));
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
