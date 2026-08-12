// modify-file.ts — Safe read-modify-write for ProjectFS files.
//
// Lives in its own file to avoid circular dependency:
//   project-fs.ts cannot import mutation-queue.ts (store.ts → project-fs.ts → mutation-queue.ts → cycle)
//   But this file CAN import both since nothing imports this file at module load time.

import { getDefaultStore } from 'jotai';
import { projectFS } from './project-fs';
import { activeFilePathAtom } from './active-file-store';
import { syncQueueCode, flushNow, syncImports, getCurrentCode, refreshDeferredFlushWithExternalWrite } from '../mutation/mutation-queue';
import { parseJSX } from '../parsing/ast-utils';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { trace } from '@/shared/debug-trace';

// Callback to bump projectVersionAtom after writing.
// Set from Canvas.tsx (which has access to the Jotai store via useSetAtom).
let _bumpVersion: (() => void) | null = null;
export function setBumpVersion(fn: () => void): void { _bumpVersion = fn; }

/** A gesture-window transaction skipped its version bump (bumping mid-gesture
 *  makes nodesAtom re-parse + the renderer REBUILD the canvas between the live
 *  drag state and the commit's final patches — the "mouse-up jump"; its late
 *  fan-out even landed during the NEXT drag's first ticks and reset the live
 *  DOM — the "jump at re-drag start", 2026-07-28). The lifecycle's drag-end
 *  subscriber consumes this and bumps ONCE after the gesture. */
let _gestureBumpPending = false;
export function consumeGestureVersionBump(): boolean {
  const b = _gestureBumpPending;
  _gestureBumpPending = false;
  return b;
}
/** Public helper for stores that mutate ProjectFS directly (without
 *  going through `modifyProjectFile` because the file isn't JSX — e.g.
 *  `_meta/comments.json`). Triggers the same projectVersionAtom bump
 *  that JSX writes do, so derived atoms re-read. No-op until Canvas.tsx
 *  has wired `setBumpVersion`, same as the internal call site. */
export function bumpProjectVersion(): void { _bumpVersion?.(); }

/**
 * Safe read-modify-write for ProjectFS files.
 *
 * Handles the full pipeline:
 *   1. Flush pending mutation queue (so we read code with ALL canvas changes applied)
 *   2. Read the file
 *   3. Apply the transform
 *   4. Write the result back
 *   5. Sync the mutation queue to the new code (so future mutations apply to fresh base)
 *
 * USE THIS instead of raw `projectFS.readFile → modify → projectFS.writeFile`.
 * That pattern is a trap — forgetting to flush the mutation queue causes silent data loss.
 *
 * Returns the transformed code, or null if the file doesn't exist.
 */
export function modifyProjectFile(
  filePath: string,
  transform: (code: string) => string,
  opts?: {
    /** Bypass the parse gate. ONLY for the in-app code editor (admin tool),
     *  where a human deliberately saves work-in-progress code — a GENERATOR
     *  must never pass this. */
    skipParseGate?: boolean;
  },
): string | null {
  // The mutation queue's `currentCode` represents the ACTIVE PAGE's
  // source — it's the in-memory base that pending JSX mutations
  // apply against, and `flushNow()` writes the result to the queue's
  // tracked active-file path. Syncing this with ANY other file's
  // content is actively harmful:
  //   - JSON/CSS bodies (`_meta/*.json`, `tokens.css`): overwriting
  //     `currentCode` with their text injects them into the active
  //     page TSX on next flush.
  //   - Other `.tsx` files (component masters, icon-set masters,
  //     plugin source): the queue then applies any pending mutation
  //     to the WRONG base and writes the frankensteined result back
  //     to the active page. Symptom we hit: editing a Tier 2 plugin
  //     in the in-browser editor replaced the active page's source
  //     with the plugin's code, crashing the canvas.
  // Gate every queue sync on `filePath === activeFilePath` — a strict
  // identity check, not just a file-extension check. Other .tsx files
  // still flush (so any pending mutations on the active page commit
  // before the new write happens) but DON'T touch `currentCode`.
  const activeFilePath = getDefaultStore().get(activeFilePathAtom);
  const isQueueOwned = filePath === activeFilePath;
  const isJsxFile = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');

  // 1. Flush pending mutations so ProjectFS has the latest code.
  //    Only sync the queue's `currentCode` when modifying the ACTIVE
  //    PAGE — other files don't own the queue's base.
  const preFlushCode = projectFS.readFile(filePath);
  if (!preFlushCode) return null;
  if (isQueueOwned && dragStateOps.get()) {
    // GESTURE WINDOW: the queue's `currentCode` — not ProjectFS — is the
    // source of truth. The deferred-drag-flush stashes every flush's
    // setCode fan-out (and with it the codeAtom→FS mirror) until the
    // gesture ends, so FS LAGS the queue by every already-applied mutation.
    // The old unconditional `syncQueueCode(preFlushCode)` seeded the queue
    // BACKWARDS from the stale FS, throwing those mutations away — an svg
    // resize's viewBox/geometry bake vanished, the group-child box write
    // transacted on a stale base, and the stash clobbered the result on
    // mouse-up (the "resize reverts" / "drag flashes old position" report,
    // 2026-07-28). Flush, then bring FS up to the queue before transacting.
    flushNow();
    const queueCode = getCurrentCode();
    if (queueCode && queueCode !== projectFS.readFile(filePath)) {
      projectFS.writeFile(filePath, queueCode);
    }
  } else {
    if (isQueueOwned) syncQueueCode(preFlushCode);
    flushNow();
  }

  // 2. Read fresh code (now includes all flushed mutations)
  const code = projectFS.readFile(filePath);
  if (!code) return null;

  // 3. Apply transform
  let result: string;
  try {
    result = transform(code);
  } catch (err) {
    trace.error('modify-file:transform-failed', { filePath, error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  // 4. Sync imports — close the gap where files mutated through THIS
  //    path (rather than the canvas mutation queue) never see the
  //    framework auto-import pass. The queue's per-flush syncImports
  //    only runs when the active page is the file being mutated;
  //    master files (icon-set, components) edited via
  //    `modifyProjectFile` would otherwise be left with `motion.svg`
  //    references and no `import { motion } from 'framer-motion'`,
  //    which crashes the live preview at first render. Only runs on
  //    .tsx/.jsx files — JSON / CSS / asset writes pass through
  //    unchanged.
  let finalResult = result;
  if (isJsxFile && finalResult !== code) {
    finalResult = syncImports(finalResult);
  }

  // 4b. PARSE GATE — a programmatic transform must never turn a parseable
  //     file unparseable. This path is the write door for every op OUTSIDE
  //     the mutation queue (variant ops, template ops, panel features), and
  //     none of them validated: Add Variant's brace-blind entry clone wrote
  //     an unparseable Top Nav component, every templated page rendered
  //     blank, and the user's attempts to dig out destroyed the project
  //     (Wisp, 2026-08-12). One parse on a changed file is imperceptible
  //     here — these are one-shot user actions, not the gesture-hot queue
  //     path (which has its own gates).
  //
  //     Same only-block-new-damage semantics as the queue's flushNow syntax
  //     gate: a file that was ALREADY broken passes through — reverting
  //     would refuse every subsequent action and lock the user out of
  //     repairing it — and is traced loudly instead.
  if (isJsxFile && finalResult !== code && !opts?.skipParseGate && !parseJSX(finalResult)) {
    if (parseJSX(code)) {
      trace.error('modify-file:parse-gate-revert', { filePath });
      return null;
    }
    trace.error('modify-file:parse-gate-preexisting-invalid', { filePath });
  }

  // 5. Write back + bump version so codeAtom re-reads from ProjectFS
  if (finalResult !== code) {
    projectFS.writeFile(filePath, finalResult);
    if (isQueueOwned && dragStateOps.get()) {
      // GESTURE WINDOW: defer the version bump to gesture end. Bumping here
      // makes nodesAtom re-parse and the renderer REBUILD the whole canvas
      // BETWEEN the live drag state and this commit's final bridge patches
      // (the mouse-up jump); worse, that fan-out could land during the NEXT
      // drag's first ticks and reset the live DOM (the re-drag start jump).
      _gestureBumpPending = true;
      // Supersede the deferred-drag-flush STASH: it holds the pre-transaction
      // flush output, and applying that at gesture end would setCode →
      // FS-mirror the STALE code right over this write (the second half of
      // the 2026-07-28 revert/flash). Routing the fresh result through the
      // flush channel replaces the stash so the gesture-end apply carries
      // exactly this state.
      refreshDeferredFlushWithExternalWrite(finalResult);
    } else {
      _bumpVersion?.();
      if (isQueueOwned) refreshDeferredFlushWithExternalWrite(finalResult);
    }
  }

  // 6. Sync queue so future mutations apply to the new code — but
  //    only when this file IS the active page. Modifications to
  //    other files (component masters, plugin sources,
  //    icon sets, anything else) must not touch the queue's
  //    `currentCode` — see the comment at the top of this function.
  if (isQueueOwned) {
    const freshCode = projectFS.readFile(filePath);
    if (freshCode) syncQueueCode(freshCode);
  }

  trace.fn('modifyProjectFile', { filePath, changed: finalResult !== code, isQueueOwned, isJsxFile });
  return finalResult;
}
