// async-parser.ts — Parses JSX in a Web Worker, returns results via callback.
// Main thread never blocks on Babel parse.

import type { CanvasNode } from './parser';
import { trace } from '@/shared/debug-trace';

type ParseCallback = (nodes: Map<string, CanvasNode>) => void;

let worker: Worker | null = null;
let requestId = 0;
const requestCallbacks = new Map<number, ParseCallback>();

function getWorker(): Worker {
  if (!worker) {
    // @ts-ignore — Vite handles ?worker imports
    worker = new Worker(new URL('./parser-worker.ts', import.meta.url), { type: 'module' });
    worker!.onmessage = (e: MessageEvent<{ id: number; entries: [string, any][]; duration: number }>) => {
      const { id, entries, duration } = e.data;

      // Look up callback by request id
      const callback = requestCallbacks.get(id);
      if (!callback) {
        trace.fn('asyncParser:staleResult', { requestId: id, note: 'no callback found (already consumed or discarded)' });
        return;
      }

      // Clean up the callback
      requestCallbacks.delete(id);

      const nodes = new Map<string, CanvasNode>();
      for (const [nodeId, node] of entries) {
        nodes.set(nodeId, node);
      }

      trace.fn('asyncParser:workerResult', { requestId: id, nodeCount: nodes.size, duration: `${duration.toFixed(1)}ms` });
      callback(nodes);
    };
  }
  return worker!;
}

/**
 * Parse JSX code in a background Web Worker.
 * Only the latest request's result will be delivered (stale results are ignored).
 */
export function parseAsync(code: string, callback: ParseCallback): void {
  const id = ++requestId;
  requestCallbacks.set(id, callback);
  trace.fn('asyncParser.parseAsync:dispatch', { requestId: id, codeLength: code.length, pendingCallbacks: requestCallbacks.size });
  getWorker().postMessage({ code, id });
}

// terminateParser() removed — worker lives for the lifetime of the app
