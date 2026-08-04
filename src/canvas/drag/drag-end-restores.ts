// drag-end-restores.ts — visual restores that must run when the DRAG ends,
// not when a strategy ends.
//
// A mid-drag strategy switch (layout-lifted → canvas on entering a new
// parent) tears the old strategy down while the gesture is still live. Any
// hide that covers the WHOLE gesture — the synced-replica hides from lift —
// must survive that handoff: restoring them in the old strategy's cleanup
// made the dragged node's other-viewport twin pop back visible mid-drag and
// shadow the rest of the gesture as a duplicate (replica → primary drag-out,
// 2026-08-05). Strategies register the restore here instead; the
// DragCoordinator runs the registry in its drag-end reset (mouseup, cancel,
// and detach all funnel through it).

import { trace } from '@/shared/debug-trace';

type Restore = () => void;

const restores: Restore[] = [];

/** Defer a restore to the end of the CURRENT drag gesture. */
export function registerDragEndRestore(fn: Restore): void {
  restores.push(fn);
}

/** Run + clear every deferred restore. Idempotent; safe on drags that never
 *  registered any. One failing restore must not block the rest. */
export function runDragEndRestores(): void {
  if (restores.length === 0) return;
  trace.action('drag:end-restores', { count: restores.length });
  while (restores.length > 0) {
    const fn = restores.pop()!;
    try {
      fn();
    } catch (err) {
      trace.error('drag:end-restore-failed', { error: String(err) });
    }
  }
}
