import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { ResolveInput, Resolution, unresolved } from './model';

let active = 0;
const waiting: Array<() => void> = [];
function drain() { while (active < 2 && waiting.length) waiting.shift()!(); }

export function recover(input: ResolveInput, signal?: AbortSignal, budgetMs = 2000): Promise<Resolution> {
  if (signal?.aborted) return Promise.resolve(unresolved('recovery-cancelled'));
  return new Promise(resolve => {
    let worker: Worker | undefined, started = false, done = false;
    const finish = (result: Resolution) => {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel); void worker?.terminate();
      if (started) active--;
      const queued = waiting.indexOf(start); if (queued >= 0) waiting.splice(queued, 1);
      resolve(result); drain();
    };
    const cancel = () => finish(unresolved('recovery-cancelled'));
    const timer = setTimeout(() => finish(unresolved('recovery-budget-exceeded')), budgetMs);
    signal?.addEventListener('abort', cancel, { once: true });
    const start = () => {
      if (done) return;
      active++; started = true;
      try {
        worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: input });
        worker.once('message', finish);
        worker.once('error', () => finish(unresolved('recovery-worker-failed')));
        worker.once('exit', () => { if (!done) finish(unresolved('recovery-worker-failed')); });
      } catch { finish(unresolved('recovery-worker-failed')); }
    };
    waiting.push(start); drain();
  });
}
