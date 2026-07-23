// Worker pool — true multithreading via N Web Workers, each with its own Pyodide.
// Static-host friendly (Vercel): no server, just the COOP/COEP headers in
// vercel.json. Boots worker 0 first so the CDN package download warms the HTTP
// cache, then boots the rest in parallel (avoids a thundering-herd re-download),
// then distributes jobs across all workers greedily.

import type { LayerJob, LayerResult } from "./types";

export type PoolEvents = {
  onProgress?: (msg: string) => void;
  onLayer?: (r: LayerResult) => void;
};

export function choosePoolSize(nLayers: number): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(cores - 1, 4, nLayers));
}

export class ComputePool {
  private workers: Worker[] = [];
  private booted = false;

  constructor(
    private pipelineSources: Record<string, string>,
    private pngs: Record<string, string>,
    private events: PoolEvents = {},
  ) {}

  private log(m: string) { this.events.onProgress?.(m); }

  private bootOne(w: Worker, pngs: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent) => {
        if (e.data.type === "booted") { w.removeEventListener("message", onMsg); resolve(e.data.ver); }
      };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", (e) => reject(new Error(e.message)), { once: true });
      w.postMessage({ cmd: "boot", pipelineSources: this.pipelineSources, pngs });
    });
  }

  async boot(size: number) {
    this.log(`spawning ${size} worker${size > 1 ? "s" : ""} (${size}× Pyodide)…`);
    for (let i = 0; i < size; i++) this.workers.push(new Worker("/compute.worker.js"));
    // Boot #0 fully (warms the CDN cache), then the rest in parallel.
    const ver = await this.bootOne(this.workers[0], this.pngs);
    this.log(`worker 1 ready (${ver}); booting ${size - 1} more from warm cache…`);
    await Promise.all(this.workers.slice(1).map((w) => this.bootOne(w, this.pngs)));
    this.booted = true;
    this.log(`pool ready: ${size} workers`);
  }

  // Greedy dispatch: each worker pulls the next job when it finishes its current one.
  async run(jobs: LayerJob[]): Promise<LayerResult[]> {
    if (!this.booted) throw new Error("pool not booted");
    const queue = [...jobs];
    const results: LayerResult[] = [];
    let done = 0;
    const total = jobs.length;

    const drive = (w: Worker): Promise<void> =>
      new Promise((resolve, reject) => {
        const next = () => {
          const job = queue.shift();
          if (!job) return resolve();
          const onMsg = (e: MessageEvent) => {
            const m = e.data;
            if (m.type === "result" && m.jobId === job.jobId) {
              w.removeEventListener("message", onMsg);
              const r: LayerResult = {
                name: m.name, d: m.d, nodes: m.nodes, iou: m.iou,
                mean: m.mean, identical: m.identical, secs: m.secs,
                cleanup: m.cleanup ?? [],
              };
              results.push(r);
              this.events.onLayer?.(r);
              const cleaned = m.cleanup?.length ? `, cleaned ${m.cleanup.length} subpath(s)` : "";
              this.log(`✓ ${m.name} (${++done}/${total}) — ${m.secs.toFixed(1)}s${m.identical === true ? ", byte-identical" : ""}${cleaned}`);
              next();
            } else if (m.type === "jobError" && m.jobId === job.jobId) {
              w.removeEventListener("message", onMsg);
              reject(new Error(`${m.name}: ${m.error}`));
            }
          };
          w.addEventListener("message", onMsg);
          w.postMessage({ cmd: "job", job });
        };
        next();
      });

    await Promise.all(this.workers.map(drive));
    // preserve the caller's layer order
    const order = new Map(jobs.map((j, i) => [j.name, i]));
    results.sort((a, b) => (order.get(a.name)! - order.get(b.name)!));
    return results;
  }

  terminate() { this.workers.forEach((w) => w.terminate()); this.workers = []; }
}
