// src/canvas/hooks/useMutationQueueLifecycle.ts
//
// Owns initHistory + initMutationQueue + setBumpVersion wiring. The history
// restore callback writes back to codeAtom; the mutation queue flush callback
// pushes to history. onError surfaces a banner via the caller's setter.

import { useEffect } from 'react';
import { useAtom, useSetAtom, useStore } from 'jotai';
import { codeAtom, selectedIdsAtom, updatingFromCanvasAtom } from '@/code/stores/store';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import { activeFilePathAtom, switchActiveFile, setSwitchCameraHandler } from '@/code/project/active-file-store';
import { applyPageCameraForSwitch, initCameraPersist } from '@/canvas/transform';
import { setBumpVersion, consumeGestureVersionBump } from '@/code/project/modify-file';
import { initHistory, pushHistory, syncHistoryCode } from '@/code/mutation/history';
import { seedNodesForCode, getCachedNodesMap, nodeStylesVersionAtom, nodeTreeStructureVersionAtom } from '@/code/stores/store';
import { patchCanvasRender } from '@/canvas/node-ops';
import {
  initMutationQueue, syncQueueCode, flushNow, consumeForceRender, scheduleQueueFanOut, hasPendingDeferredFanOut,
  scheduleDragEndFanOut,
  type MutationErrorDetail,
} from '@/code/mutation/mutation-queue';
import { decideFlushRenderGate } from '@/code/mutation/render-resolved-mutations';
import { triggerAutosave } from '@/backend/autosave';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { createDeferredDragFlush } from './deferred-drag-flush';
import { trace } from '@/shared/debug-trace';
import { refreshCanvasTokens } from '../node-ops';
import { getCanvasRenderer } from '../CanvasRenderer';

export function useMutationQueueLifecycle({
  onError,
}: {
  onError: (detail: MutationErrorDetail | null) => void;
}) {
  const [code, setCode] = useAtom(codeAtom);
  const bumpVersion = useSetAtom(projectVersionAtom);
  // Contextual Jotai store (main.tsx binds <Provider> to the default store).
  // Used to read/write selection from history's imperative undo/redo path.
  const store = useStore();

  // One-shot init on mount.
  useEffect(() => {
    trace.action('useMutationQueueLifecycle:init', { codeLength: code.length });
    const renderer = getCanvasRenderer();

    // Initialize history with code apply callback + active file tracking + version bump
    initHistory(
      code,
      (restoredCode) => {
        trace.action('useMutationQueueLifecycle:history-restore', { codeLength: restoredCode.length });
        // CANVAS-FIRST restore (same architecture as drops):
        // 1. Sync the queue's code (fences + later fan-out read this).
        syncQueueCode(restoredCode);
        // 2. Derive the restored node map NOW (imperative — no codeAtom
        //    touch) and seed the nodesAtom memo, so the deferred fan-out's
        //    later read is a pure memo HIT (single parse per restore).
        const restoredNodes = seedNodesForCode(restoredCode, 1); // +1: the deferred restore-finish bumps projectVersion
        // 3. Ship the iframe's diff-PATCH render immediately with the derived
        //    nodes — posted before ANY parent React work, so the canvas
        //    reverts at the first yield instead of trailing the whole panel
        //    cascade (~300ms on a big page).
        patchCanvasRender(restoredNodes, restoredCode);
        // 4. Wake the LIVE cache-first readers (Properties panel via
        //    useLiveNode, PositionTool) NOW — the seed replaced the cache
        //    wholesale but doesn't bump the version signals updateNodeInCache
        //    does. Without this the panel waited for the deferred fan-out's
        //    React pass (and its trailing tasks) — the "panel catches up
        //    0.5s after the node moves on undo" report. This pass is small
        //    (selection-keyed controls only) and reads the seeded cache.
        store.set(nodeStylesVersionAtom, (v) => v + 1);
        store.set(nodeTreeStructureVersionAtom, (v) => v + 1);
        // 5. Defer the React fan-out (setCode → panels/atoms) through the
        //    FENCED queue mechanism — applied early by any empty-queue flush,
        //    cancelled by a file switch, forced by the next undo/redo.
        scheduleQueueFanOut();
        // Re-inject CSS tokens from restored tokens.css (undo may have changed them)
        refreshCanvasTokens();
      },
      // Atom-accurate active file (not the node-ops ref, which lags a
      // render behind a switch) — used to STAMP each history entry's page
      // and to compare against the target on undo/redo.
      () => store.get(activeFilePathAtom),
      () => bumpVersion(v => v + 1),
      // Selection + navigation coordination — undo/redo navigate to the page
      // the change belongs to, then reselect a node that exists in the
      // restored state (clearing a selection whose node was removed).
      // `getNodeIds` reads the IMPERATIVE cache — seeded with the RESTORED
      // map by seedNodesForCode in the onApply callback above. It must NOT
      // read nodesAtom here: the restore defers setCode (canvas-first), so
      // codeAtom is still the PRE-undo code at this point and the atom getter
      // would re-parse the wrong code AND clobber the seeded cache.
      {
        get: () => store.get(selectedIdsAtom),
        set: (ids) => store.set(selectedIdsAtom, ids),
        getNodeIds: () => new Set(getCachedNodesMap().keys()),
        // Undo/redo navigate here when the change lives on another page, so
        // the user actually SEES it un/redone. Returns false (no switch) when
        // already on the page or the target no longer exists in ProjectFS.
        navigateToFile: (to: string): boolean => {
          const from = store.get(activeFilePathAtom);
          if (!to || to === from || projectFS.readFile(to) == null) return false;
          switchActiveFile(from, to, {
            setActiveFile: (p) => store.set(activeFilePathAtom, p),
            setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
            setUpdatingFromCanvas: (v) => store.set(updatingFromCanvasAtom, v),
          }, { syncQueueCode, flushNow });
          // Mirror the same-file restore for the now-active file: push the
          // restored code into codeAtom, sync the queue, refresh tokens.
          const newCode = projectFS.readFile(to) ?? '';
          setCode(newCode);
          syncQueueCode(newCode);
          refreshCanvasTokens();
          return true;
        },
      },
    );

    // Wire modifyProjectFile's version bump to the Jotai store
    setBumpVersion(() => bumpVersion(v => v + 1));

    // Wire per-page camera memory into the central file-switch path. Runs
    // BEFORE the new page renders, so a saved camera applies synchronously
    // and the page renders at the right pan/zoom from frame one (no flash).
    setSwitchCameraHandler(applyPageCameraForSwitch);

    // Mirror the live camera to `_meta/page-camera.json` (debounced) so each
    // file's pan/zoom survives a reload — the in-memory cameraStash alone is
    // session-scoped. Hydration happens in ProjectLoader; this only writes.
    const teardownCameraPersist = initCameraPersist();

    // While an ELEMENT DRAG is in progress, flushes still apply their string
    // mutations synchronously (the queue's code string stays authoritative)
    // but the setCode fan-out — Babel re-parse + full sandbox re-render, the
    // expensive part — is stashed and applied ONCE when the drag ends. Mid-
    // drag enter/exit reparents on large trees otherwise re-parse the whole
    // file per transition and the drag drops to single-digit fps.
    const deferredFlush = createDeferredDragFlush({
      isDragging: () => dragStateOps.get(),
      apply: (newCode) => {
        setCode(newCode);
        // Push to history stack (debounced for rapid changes)
        pushHistory(newCode);
      },
      // Drag END: don't pay the setCode cascade synchronously at mouseup —
      // arm the queue's fenced 32ms fan-out (same as reposition drops); its
      // timer routes back through onFlush → apply above with the drag over.
      deferApply: (newCode) => scheduleDragEndFanOut(newCode),
    });
    const unsubDragState = dragStateOps.subscribe(() => {
      if (!dragStateOps.get()) {
        deferredFlush.onDragEnd();
        // A gesture-window modifyProjectFile transaction (group refit, svg
        // bake) deferred its projectVersionAtom bump — bumping mid-gesture
        // rebuilt the canvas between the live state and the commit's final
        // patches (mouse-up jump / re-drag start jump, 2026-07-28). Bump
        // ONCE now that the gesture is over.
        if (consumeGestureVersionBump()) bumpVersion(v => v + 1);
      }
    });

    initMutationQueue(
      code,
      // onFlush: called when mutations are applied and ready to commit
      (newCode) => {
        trace.action('useMutationQueueLifecycle:queue-flush', { codeLength: newCode.length });
        deferredFlush.onFlush(newCode);
      },
      // onBeforeFlush — set flag so render effect skips on next nodes change
      // (but NOT after text edit commit — the DOM was cleared and needs rebuild,
      // NOT after a structural change — the iframe needs the new tree, and
      // NOT when the flush carries a RENDER-RESOLVED style mutation: replica
      // @media overrides are baked into render-time @container CSS and variant
      // values are the `resolveVariantStyles` merge, so a reset (rule/entry
      // removal) is only visible through a render — marking it away left the
      // DOM stale until a page switch ("reset override does nothing", live find
      // 2026-07-19; the SET direction was masked by the live !important inline
      // patch).
      //
      // The type list is `RENDER_RESOLVED_MUTATIONS` (mutation-queue.ts) —
      // ONE source of truth shared with `forceRenderAfterExternalEdit` in
      // node-ops. It used to be an inline two-type check here, which left every
      // variant / locale / pseudo / hover / conditional reset uncovered — the
      // "works one time out of two" report (2026-07-25).
      (mutationTypes) => {
        // INVERTED 2026-07-25: skip only when the whole flush was already
        // applied to the DOM imperatively. It used to skip by DEFAULT and
        // render only for an allow-list, so every mutation type nobody
        // remembered to add landed in the code but never on the canvas until a
        // page switch — the recurring "re-render issue" reports. See
        // `flushIsFullyImperative`.
        const gate = decideFlushRenderGate({
          mutationTypes,
          isTextEditing: renderer.isTextEditing(),
          isStructuralPending: renderer.isStructuralPending(),
          consumeForceRender,
        });
        if (gate === 'arm-skip') renderer.markCanvasUpdate();
        // DISARM. Arming isn't the only way the flag gets set: the imperative
        // style path (`node-ops.updateNodeStyles` → the
        // `setUpdatingFromCanvasFlagger` hook in Canvas.tsx) marks it directly
        // when it patches the DOM. A flush carrying something that CAN'T be
        // expressed by that patch then gets eaten by the flag a style write
        // armed moments earlier — the render is dropped with
        // `CanvasRenderer:skip-canvasUpdating` and the change only shows after a
        // page switch. Live case: applying a background video queues
        // `setVideoFill` AND an `updateStyles` clearing the competing fills; the
        // style write armed the skip and the render carrying the new `<video>`
        // child was skipped (user trace 2026-07-26). Deciding to arm without
        // being willing to disarm left the inversion only half-effective.
        else if (gate === 'disarm-skip') renderer.clearCanvasUpdate();
      },
      // onAfterFlush — trigger debounced autosave (cloud)
      () => { triggerAutosave(); },
      // onError — show banner with full detail, auto-dismiss after 10s, log to file via Vite
      (detail) => {
        trace.error('canvas:mutation-error', {
          message: detail.message,
          mutationTypes: detail.mutationTypes,
          codeExcerpt: detail.codeExcerpt,
        });
        onError(detail);
        setTimeout(() => onError(null), 10000);
        // Write to debug_output/mutation-errors/ via Vite dev server — fire and forget
        fetch(`${ (import.meta as any).env?.BASE_URL ?? '/' }__mutation_error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...detail, recentTrace: trace.getRecentEntries() }),
        }).catch(() => {});
      },
    );
    return () => { teardownCameraPersist(); unsubDragState(); deferredFlush.flushPending(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep queue + history in sync when code changes from outside (Monaco)
  useEffect(() => {
    // While a deferred restore/drop fan-out is armed, the queue's currentCode
    // is INTENTIONALLY ahead of codeAtom — this effect can fire late with a
    // PREVIOUS code value (React replays the pending pass from the fence's
    // synchronous apply) and would regress the queue to an old state; the
    // armed fan-out then writes that old state over the restored file and
    // wipes the redo stack. Skip; the fan-out's own setCode re-runs this
    // effect with the right value once it lands.
    if (hasPendingDeferredFanOut()) {
      trace.action('useMutationQueueLifecycle:code-sync-skip-pending-fan-out', { codeLength: code.length });
      return;
    }
    trace.action('useMutationQueueLifecycle:code-sync', { codeLength: code.length });
    syncQueueCode(code);
    syncHistoryCode(code);
  }, [code]);
}
