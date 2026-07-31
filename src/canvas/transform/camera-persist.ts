// camera-persist.ts — Persist EVERY file's camera (pan x/y + zoom) to
// `_meta/page-camera.json` so it survives a browser reload.
//
// `cameraStash` (camera-stash.ts) is the in-memory live cache used on every
// file switch; on its own it's SESSION-scoped (a reload tears down the module
// → empty Map). This layer mirrors the stash to ProjectFS metadata so the
// camera comes back after a reload.
//
// `_meta/` is editor metadata: it rides the project snapshot (autosaved to the
// backend + restored on load) but is EXCLUDED from publish/export — exactly
// like `_meta/comments.json`. So persisting the camera here never reaches the
// live site, and it doesn't push undo entries (history only snapshots on code
// mutation flushes).
//
// EVERY file type is persisted (pages, templates, design components, icon /
// vector sets) — each remembers its own camera. The breadcrumb
// "back to page" + `enterComponentFile` pre-zoom still OVERRIDE the restored
// camera when you navigate INTO a file, which is the desired behaviour.
//
// We do NOT write per pan frame: the transform subscriber DEBOUNCES, so the
// camera is only captured after it settles. `triggerAutosave` then rides the
// existing 2s debounce + the `beforeunload` beacon, so the file reaches the
// backend even on a quick reload.

import { getDefaultStore } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { triggerAutosave } from '@/backend/autosave';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { cameraStash } from './camera-stash';
import { fitAllIfCacheReady, fitAllOnNextRender } from './CameraCommands';
import { transformManager } from './TransformManager';
import type { Transform } from './TransformManager';
import { trace } from '@/shared/debug-trace';

const CAMERA_FILE = '_meta/page-camera.json';
/** How long after the camera stops moving before we capture it into the stash.
 *  Kept short (~0.2s) so the value is saved almost immediately — switching pages
 *  right after a pan/zoom still restores the camera you just left. During a
 *  continuous gesture the timer keeps resetting, so we still never write mid-pan. */
const SETTLE_MS = 200;
/** Coalesce multiple stash writes (settle capture + switch-away saves) into one
 *  JSON write + autosave. Small so a quick reload still gets the beacon. */
const WRITE_MS = 250;

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let unsubTransform: (() => void) | null = null;
let unsubStash: (() => void) | null = null;
// True while we're loading the file INTO the stash, so the resulting stash
// notifications don't immediately write the file straight back.
let hydrating = false;

function isValidTransform(t: unknown): t is Transform {
  return !!t && typeof (t as Transform).x === 'number'
    && typeof (t as Transform).y === 'number'
    && typeof (t as Transform).scale === 'number';
}

function readFile(): Record<string, Transform> {
  try {
    const raw = projectFS.readFile(CAMERA_FILE);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, Transform> : {};
  } catch (e) {
    trace.error('camera-persist:read-failed', e);
    return {};
  }
}

/** Write the current stash to `_meta/page-camera.json` (debounced) + autosave.
 *  Prunes entries for files that no longer exist so renames/deletes don't leave
 *  phantom cameras behind. */
function scheduleWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const map = cameraStash.entries();
    const out: Record<string, Transform> = {};
    for (const [path, t] of map) {
      if (projectFS.exists(path) && isValidTransform(t)) out[path] = t;
    }
    projectFS.writeFile(CAMERA_FILE, JSON.stringify(out));
    triggerAutosave();
    trace.action('camera-persist:write', { count: Object.keys(out).length });
  }, WRITE_MS);
}

/** Load saved cameras into the in-memory stash. Call ONCE after the project
 *  snapshot is hydrated (ProjectLoader). Skips files that no longer exist.
 *  Then restores the ACTIVE file's saved camera on the first render so the
 *  initial load lands where you left it (initial load doesn't go through
 *  `switchActiveFile`, so `applyPageCameraForSwitch` wouldn't run). */
export function hydrateCameras(): void {
  hydrating = true;
  const map = readFile();
  let n = 0;
  for (const [path, t] of Object.entries(map)) {
    if (!isValidTransform(t) || !projectFS.exists(path)) continue;
    cameraStash.save(path, t);
    n++;
  }
  hydrating = false;
  trace.action('camera-persist:hydrate', { count: n });

  // Apply the active file's saved camera on the first render — read the active
  // file at FIRE time (it may change between here and the first paint, e.g. a
  // `?page=` restore), so we always restore the file actually shown.
  if (typeof window === 'undefined') return;
  const onFirstRender = () => {
    window.removeEventListener('revyme:render-complete', onFirstRender);
    const active = getDefaultStore().get(activeFilePathAtom);
    const saved = cameraStash.get(active);
    if (saved) {
      transformManager.setTransform({ ...saved });
      trace.fn('camera-persist:restore-initial', { active, saved });
    } else {
      // FRESH project / first-ever open of this page: no saved camera —
      // without an explicit fit the canvas boots at the transform manager's
      // hardcoded default, which leaves the primary viewport sitting
      // top-right of the canvas area instead of centered (user report
      // 2026-07-29, new cloud website). Fit-all immediately — this handler
      // runs on render-complete, so the rect cache is fresh; if it somehow
      // isn't usable yet, arm the standard next-render fit as fallback.
      const fitted = fitAllIfCacheReady();
      if (!fitted) fitAllOnNextRender();
      trace.fn('camera-persist:initial-fit', { active, immediate: fitted });
    }
  };
  window.addEventListener('revyme:render-complete', onFirstRender);
}

/**
 * Start mirroring the live camera to disk. Idempotent — safe to call from a
 * mount effect (returns a teardown). Two subscriptions:
 *   - transformManager → debounced SETTLE capture: after the camera stops
 *     moving, save the ACTIVE file's transform into the stash.
 *   - cameraStash → debounced WRITE: any stash change (settle capture OR a
 *     switch-away `savePageCamera` / `enterComponentFile` save) flushes the
 *     whole stash to `_meta/page-camera.json` + autosave.
 */
export function initCameraPersist(): () => void {
  unsubTransform?.();
  unsubStash?.();

  unsubTransform = transformManager.subscribe(() => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const active = getDefaultStore().get(activeFilePathAtom);
      if (!active) return;
      // Save the ACTIVE file's settled camera. cameraStash.save notifies the
      // stash subscriber below → debounced file write. Captures the
      // reload-on-current-file case (no switch needed).
      cameraStash.save(active, transformManager.getTransform());
    }, SETTLE_MS);
  });

  unsubStash = cameraStash.subscribe(() => {
    if (hydrating) return; // loading the file in — don't write it straight back
    scheduleWrite();
  });

  return () => {
    unsubTransform?.(); unsubTransform = null;
    unsubStash?.(); unsubStash = null;
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
    if (writeTimer !== null) { clearTimeout(writeTimer); writeTimer = null; }
  };
}
