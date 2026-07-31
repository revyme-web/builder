// deferred-drag-flush.ts — defer the flush's EXPENSIVE consumers while an
// element drag is in progress.
//
// A mutation-queue flush has two costs: applying the string mutations
// (~3ms, must stay synchronous — the queue's code string is the source of
// truth for subsequent mutations) and the `setCode` fan-out (codeAtom →
// nodesAtom Babel RE-PARSE of the whole file → full sandbox re-render).
// During a drag, enter/exit reparents flush per transition; on a big
// imported tree each fan-out costs 100ms+ and the drag drops to ~8fps (the
// live find 2026-07-15: 527-node Figma import, 3 mid-drag parses + full
// renders). The canvas doesn't need the fan-out mid-gesture — strategies
// patch the sandbox DOM imperatively and keep the node cache consistent
// (moveNodeInCache/updateNodeInCache) — so the LATEST flushed code is
// stashed and applied ONCE when the drag ends.
//
// LIVE LAYERS mid-drag do NOT need this fan-out either: LayersPanel derives
// its tree from the imperative node cache via `nodeTreeStructureVersionAtom`
// (bumped by moveNodeInCache), so rows re-nest at the reparent moment with
// zero parse. (An earlier attempt routed structural flushes PAST this
// deferral instead — that re-introduced the 100ms+ mid-drag parse the
// deferral exists to kill.)
//
// Bonus: the whole gesture lands as a single history entry.

import { trace } from '@/shared/debug-trace';

export interface DeferredDragFlush {
  /** Route a flushed code string: applies immediately when no drag is in
   *  progress, stashes it otherwise. */
  onFlush(code: string): void;
  /** Call when the drag-in-progress signal turns OFF — applies the stash. */
  onDragEnd(): void;
  /** Apply any stash unconditionally (teardown safety). */
  flushPending(): void;
}

export function createDeferredDragFlush(opts: {
  isDragging: () => boolean;
  apply: (code: string) => void;
  /** Optional drag-END defer: given the stashed code, arm a deferred fan-out
   *  (the mutation queue's fenced 32ms timer) instead of applying
   *  synchronously. Return true when armed — the timer's onFlush loops back
   *  through onFlush() → apply() with drag over. Applying synchronously at
   *  mouseup costs a full parse + React cascade in one task pile-up (~330ms
   *  without a frame on a big page) while the canvas DOM is already correct. */
  deferApply?: (code: string) => boolean;
}): DeferredDragFlush {
  let pending: string | null = null;

  const flushPending = () => {
    if (pending == null) return;
    const code = pending;
    pending = null;
    trace.action('deferred-drag-flush:applied', { codeLength: code.length });
    opts.apply(code);
  };

  return {
    onFlush(code: string) {
      if (opts.isDragging()) {
        pending = code;
        trace.action('deferred-drag-flush:stashed', { codeLength: code.length });
        return;
      }
      // A non-drag flush supersedes any stale stash (e.g. a drag that ended
      // without the subscription firing first).
      pending = null;
      opts.apply(code);
    },
    onDragEnd() {
      if (pending != null && opts.deferApply) {
        const code = pending;
        if (opts.deferApply(code)) {
          pending = null;
          trace.action('deferred-drag-flush:deferred-to-fan-out', { codeLength: code.length });
          return;
        }
      }
      flushPending();
    },
    flushPending,
  };
}
