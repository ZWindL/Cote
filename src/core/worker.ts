import { parentPort, workerData } from 'node:worker_threads';
import { resolveAnchor } from './engine';
parentPort?.postMessage(resolveAnchor(workerData));
