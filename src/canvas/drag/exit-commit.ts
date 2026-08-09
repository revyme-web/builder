/**
 * Exit-to-canvas commit choreography — the shared core of the six
 * "element leaves its parent and becomes a floating canvas node" commit
 * sites across CanvasDragStrategy / AbsoluteInFrameStrategy /
 * LayoutLiftedStrategy.
 *
 * ORDER MATTERS — do not reorder the statements in these helpers.
 *
 * The full sequence is:
 *
 *   queueMutation(clearContainerStyles)
 *   queueMutation(move → newParentId:null, canvasNode:true)
 *   [site-specific extra mutations]
 *   patchNodeStyles / moveNodeInCache / updateNodeInCache
 *   flushNow()
 *   forceCanvasRender()
 *
 * Why mutations are QUEUED + FLUSHED SYNCHRONOUSLY here (not returned as
 * PendingUpdates from onEnd): flushNow() sync-writes codeAtom so nodesAtom
 * re-derives BEFORE SelectionOverlay un-hides on mouseup. Without it, the
 * overlay would un-hide on the same React tick as canvasInteracting
 * flipping false, reading stale `nodes` from before the queue flushed —
 * it paints stale "layout child" state (auto height, L/R-only handles,
 * gap handles offset wrong) for ~100-200ms and then visibly jumps to the
 * canvas-node final form when the queue eventually flushes.
 *
 * Why clearContainerStyles always precedes the move: canvas nodes are
 * independent of viewport context — any leftover `@media (max-width: X)
 * { [data-id="…"] { display: none } }` (from a prior canvas-node-into-
 * replica entry, or a manual override) would silently re-hide the element
 * when the iframe's width crosses the breakpoint, and would resurrect the
 * hide if the user later drags the canvas node back into a viewport tree.
 */

import { queueMutation, flushNowDeferredDuringDrag, type Mutation } from '@/code/mutation/mutation-queue';
import { moveNodeInCache, updateNodeInCache, getNodeFromCache } from '@/code/stores/store';
import { patchNodeStyles, forceCanvasRender, forceCanvasRenderDeferredDuringDrag } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { repositionSignalOps } from '@/canvas/drag/reposition-signal';
import { trace } from '@/shared/debug-trace';

export interface ExitCommitPatch {
  contentEl: HTMLElement;
  vpPrefix: string;
  /** Styles patched imperatively on the live element (bridge). */
  styles: Record<string, string>;
  /** Where the imperative patch sits in the choreography:
   *  - 'before-cache' — Canvas/AbsoluteInFrame ordering: the patch clears
   *    the per-frame drag translate atomically with the reparent commit
   *    (typically `{ transform: orig }`), BEFORE the cache sync.
   *  - 'after-cache' — LayoutLifted drop ordering: the FULL exit styles
   *    are patched onto the element AFTER the cache sync. */
  when: 'before-cache' | 'after-cache';
}

export interface ExitCommitOptions {
  nodeId: string;
  /** Exit styles committed to the move mutation AND the imperative node cache. */
  styles: Record<string, string>;
  /** Source variant name (component masters) — lets `moveNodeInCode`'s strip
   *  walker resolve variant-conditional text (`{variant === 'X' ? 'A' : 'B'}`)
   *  into a plain JSXText for the canvas-rooted node. */
  sourceVariant?: string;
  /** Source viewport width (page replicas) — lets the move generator unwrap
   *  `{useResponsiveText(...)}` calls into the source vp's plain text. */
  sourceVpWidth?: number;
  /** Site-specific mutations queued right after the move (before the
   *  imperative patch/cache sync) — e.g. AbsoluteInFrame's
   *  `data-pinned`/`data-replica-solo` attr clear. */
  extraMutations?: Mutation[];
  /** Imperative live-element patch; omit to skip (LayoutLifted mid-drag exit). */
  patch?: ExitCommitPatch;
}

/**
 * Per-node exit-to-canvas commit: queue `clearContainerStyles` + the
 * canvas-root `move`, then sync the imperative caches (and optionally the
 * live element). Does NOT flush — callers batch N nodes then call
 * `flushExitToCanvas()` (or their own site-specific flush block).
 */
export function commitExitToCanvas(opts: ExitCommitOptions): void {
  const { nodeId, styles, sourceVariant, sourceVpWidth, extraMutations, patch } = opts;
  trace.action('exit-commit:commit', { nodeId, sourceVariant, sourceVpWidth, patchWhen: patch?.when ?? null });

  // Wipe stale @media/@container rules so the canvas node doesn't inherit
  // display:none (see module comment).
  queueMutation({ type: 'clearContainerStyles', nodeId });

  // REPLICA-SOLO teardown — the OTHER half of the same hide.
  //
  // A node added directly on a replica is stored as THREE things
  // (node-ops.ts): inline `display: 'none'`, a `display: 'unset'` band for the
  // viewport it actually lives on, and `data-replica-solo="<vpId>"`. The clear
  // above drops the band and the call sites drop the attribute — but the inline
  // `display: 'none'` was left, so the node exited to the canvas already
  // hidden. Dropping it into the primary then produced a node at the right
  // parent and the right position that simply never painted, and only when the
  // drag STARTED on a replica (user report 2026-08-09). Clearing the band alone
  // reads like it should be enough, which is exactly why this survived: the
  // solo contract inverts the usual polarity — base hides, band reveals.
  //
  // Scoped to solo nodes: a node the user deliberately hid keeps its `display`.
  const cached = getNodeFromCache(nodeId);
  const exitStyles = cached?.attrs?.['data-replica-solo'] && cached?.styles?.display === 'none'
    ? { ...styles, display: '' }
    : styles;
  if (exitStyles !== styles) {
    trace.action('exit-commit:solo-display-cleared', { nodeId, solo: cached?.attrs?.['data-replica-solo'] });
  }

  queueMutation({
    type: 'move',
    nodeId,
    newParentId: null,
    canvasNode: true,
    styles: exitStyles,
    sourceVpWidth,
    sourceVariant,
  });
  if (extraMutations) {
    for (const m of extraMutations) queueMutation(m);
  }
  if (patch && patch.when === 'before-cache') {
    // IMPERATIVE-FIRST RE-HOME (mid-drag exits). The Renderer skips
    // drag-locked nodes entirely (central drag locks), so the flush-render
    // can no longer move the element to the content root: the old copy
    // would stay (overflow-clipped) inside the old parent while
    // patchCanvasNodes builds a locked duplicate at the root, and every
    // per-frame write lands on the stale deep copy — the "glitches out and
    // offsets on unparent" bug. Re-home NOW (drops replica copies, lifts
    // the element to the content root, applies the exit styles + cleared
    // transform); the locked render then correctly leaves it alone.
    getCanvasBridge().reparentLive?.(nodeId, patch.vpPrefix, null, 0, { ...styles, ...patch.styles });
    trace.action('exit-commit:imperative-reparent', { nodeId, vpPrefix: patch.vpPrefix });
    patchNodeStyles(patch.contentEl, nodeId, patch.vpPrefix, patch.styles);
  }
  // Sync the imperative cache so overlays / subsequent onMove ticks read
  // the node as a top-level canvas node at its committed position.
  moveNodeInCache(nodeId, null);
  updateNodeInCache(nodeId, exitStyles);
  if (patch && patch.when === 'after-cache') {
    // IMPERATIVE RE-HOME for the drop-time exit too. This branch used to
    // rely on the drag-end drain's SYNCHRONOUS setCode → render to move the
    // element out of its old parent — safe only because that cascade blocked
    // paint until the render landed. With the drag-end fan-out DEFERRED
    // (DragCoordinator, 2026-07-19), the mouseup frame paints immediately —
    // and an element still parked inside its old flex parent with canvas-
    // root left/top resolves against the WRONG containing block: the node
    // visibly snapped back to its original slot for ~150ms, then jumped to
    // the canvas position when the deferred render reparented it. Re-home
    // NOW (drops replica copies, lifts to the content root, applies the
    // final styles) so the first painted frame is already the final state;
    // the deferred render then reconciles a no-op.
    getCanvasBridge().reparentLive?.(nodeId, patch.vpPrefix, null, 0, { ...styles, ...patch.styles });
    trace.action('exit-commit:imperative-reparent', { nodeId, vpPrefix: patch.vpPrefix, when: 'after-cache' });
    patchNodeStyles(patch.contentEl, nodeId, patch.vpPrefix, patch.styles);
  }

  // FADE THE OVERLAY BACK IN, same as a drop-inside-parent reorder.
  //
  // LayoutLiftedStrategy pulses this for reorders and deliberately skipped
  // exit-to-canvas, reasoning that a canvas drop has no snap-back jump. True
  // for POSITION — the imperative re-home lands the element at its final spot
  // on the mouseup frame. But an exit changes the node's KIND, and the overlay
  // decides WHICH HANDLES EXIST from node state that only reaches React after
  // the deferred parse (~90ms): a container dropped on the canvas showed grip
  // and gap handles inherited from its layout-child past, then dropped them
  // once the parse landed. Cache-first reads fixed the size-driven handles; the
  // fade covers the rest of that window instead of chasing each handle
  // separately (user report 2026-08-09).
  //
  // Pulsed in the shared CORE, not the six call sites, and not in
  // `flushExitToCanvas` — only three of the six exits call that, so half of
  // them would have silently missed the fade.
  repositionSignalOps.signal();
  trace.action('exit-commit:reposition-signal', { nodeId });
}

/**
 * Flush the queued exit commit(s) synchronously + force the iframe
 * re-render so the DOM parent actually changes BEFORE SelectionOverlay's
 * first post-mouseup frame (see module comment for the un-hide race).
 */
export function flushExitToCanvas(): void {
  trace.action('exit-commit:flush', {});
  flushNowDeferredDuringDrag();
  forceCanvasRenderDeferredDuringDrag();
}
