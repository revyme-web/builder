// autosave.ts — Debounced project save triggered after mutation queue flush.
// Uses getDefaultStore() to update saveStatusAtom outside of React.

import { getDefaultStore } from 'jotai';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { backend } from './index';
import { getProjectId } from './project-id';
import { saveStatusAtom } from './save-store';
import type { ProjectData } from './types';
import { PROJECT_FORMAT } from './types';
import { projectFS } from '../code/project/project-fs';
import { trace } from '@/shared/debug-trace';

const DEBOUNCE_MS = 2000;
/** Bounded auto-retry after a failed save. Without it, `pendingSave` stayed
 *  true but nothing ever re-armed the timer — with no further edits the
 *  project silently never persisted (and there is no visible save status). */
const RETRY_MS = 5000;
const MAX_RETRIES = 3;
let saveFailures = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave = false;
let isSaving = false;
let currentSave: Promise<void> | null = null;

function getStore() {
  return getDefaultStore();
}

async function performSave(): Promise<void> {
  const store = getStore();
  const id = getProjectId();
  // An unresolved project id means this client never finished booting into a
  // real website (or is a stale HMR generation from before the id resolved) —
  // its PUT /api/websites/local can only 401 or, worse, clobber. Never ship it.
  if (CLOUD_ENABLED && id === 'local') {
    trace.action('autosave:skipped-unresolved-project-id', { id });
    return;
  }
  const snapshot = projectFS.getSnapshot();
  const data: ProjectData = {
    format: PROJECT_FORMAT,
    files: Object.fromEntries(snapshot),
  };

  store.set(saveStatusAtom, 'saving');
  isSaving = true;
  trace.action('autosave:start', { id, fileCount: snapshot.size });

  try {
    await backend.saveProject(id, data);
    store.set(saveStatusAtom, 'saved');
    pendingSave = false;
    saveFailures = 0;
    trace.action('autosave:success', { id });
  } catch (err) {
    store.set(saveStatusAtom, 'error');
    debounceTimer = null;
    trace.error('autosave:error', err);
    saveFailures++;
    if (saveFailures <= MAX_RETRIES && !_disposed && !isHeld) {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        startSave();
      }, RETRY_MS);
      trace.action('autosave:retry-scheduled', { attempt: saveFailures, inMs: RETRY_MS });
    }
  } finally {
    isSaving = false;
  }
}

/** Start a save and track its promise so `flushSaveNow` can await it. */
function startSave(): Promise<void> {
  const p = performSave().finally(() => {
    if (currentSave === p) currentSave = null;
  });
  currentSave = p;
  return p;
}

/** Flush any pending save NOW and resolve once the backend row holds this
 *  tab's CURRENT projectFS snapshot. Publish MUST await this first: the
 *  publish route builds from the stored DB json, so a publish fired inside
 *  the 2s autosave debounce (or while a save snapshotted BEFORE the newest
 *  edit is still in flight) deploys the PREVIOUS save — the "I added a
 *  frame, hit Publish, and the live site doesn't have it" report. The final
 *  save runs UNCONDITIONALLY (not gated on pendingSave): a redundant save
 *  is harmless, and it also covers a non-leader collab tab (whose
 *  triggerAutosave early-returns without ever setting pendingSave). */
export async function flushSaveNow(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (currentSave) {
    try { await currentSave; } catch { /* status handled in performSave */ }
  }
  trace.action('autosave:flush-now');
  await startSave();
}

/** Save-leader gate. CollaborationProvider calls `setIsSaveLeader()` on
 *  every `save-leader` socket event. Non-leaders broadcast their
 *  changes via `file-sync` but DON'T persist to the backend — the
 *  leader is the single writer. Default `true` so editors without a
 *  cloud session (no socket connected) still persist normally. */
let isSaveLeader = true;
export function setIsSaveLeader(leader: boolean): void {
  if (isSaveLeader === leader) return;
  isSaveLeader = leader;
  trace.action('autosave:leader-changed', { isSaveLeader: leader });
}

/** Trigger a debounced save. Called from Canvas.tsx onAfterFlush.
 *  `force` bypasses the save-leader gate for authoritative writes that
 *  originate from this client directly (manual Ctrl+S, MCP/bridge file &
 *  CMS commits) rather than from a collaboration peer — those MUST persist
 *  regardless of leader election, otherwise bridge-created content silently
 *  never reaches the backend on a non-leader tab. */
// HMR KILL-SWITCH: a stale hot-update generation of this module holds a
// STALE projectFS in its closures — if its debounced timer (or a late
// trigger) fires after disposal it would persist day-old project state over
// the live tab's (the reverting-component clobber, 2026-07-22). Disposed
// generations refuse to save, and their pending timer is cancelled.
let _disposed = false;
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    _disposed = true;
    if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (typeof window !== 'undefined' && (window as any)['__revymeAutosaveUnloadHook'] === onBeforeUnloadSave) {
      window.removeEventListener('beforeunload', onBeforeUnloadSave);
      delete (window as any)['__revymeAutosaveUnloadHook'];
    }
    trace.action('autosave:hmr-disposed', {});
  });
}

/** While held, saves are deferred instead of scheduled. Used by the
 *  fresh-site template prompt: the boot machinery writes into projectFS
 *  even with zero user edits (the initial fit-all persists
 *  `_meta/page-camera.json` and rides the autosave), and that PUT fills
 *  the still-empty backend row — which the remix-into endpoint refuses
 *  to overwrite. Holding keeps the row at `'{}'` for the whole decision
 *  window; release re-schedules anything deferred. */
let isHeld = false;
export function setAutosaveHeld(held: boolean): void {
  if (isHeld === held) return;
  isHeld = held;
  trace.action('autosave:held-changed', { held, pendingSave });
  if (!held && pendingSave && !_disposed) {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startSave();
    }, DEBOUNCE_MS);
  }
}

export function triggerAutosave(opts?: { force?: boolean }): void {
  if (_disposed) { trace.action('autosave:skipped-disposed-generation'); return; }
  if (isHeld) {
    // Remember that something wants saving, but don't schedule — the
    // release path re-arms the debounce.
    pendingSave = true;
    getStore().set(saveStatusAtom, 'unsaved');
    trace.action('autosave:deferred-while-held');
    return;
  }
  // Cloud AND local mode both persist through the backend singleton —
  // LocalBackend writes localStorage, RevymeBackend PUTs the API. (An old
  // `VITE_REVYME_CLOUD` gate here made local mode silently never save:
  // this is the only call path to backend.saveProject, so refreshing the
  // tab lost all work in standalone mode.)
  // Skip when this client isn't the save-leader. Avoids two clients
  // racing to PUT /api/websites/:id with conflicting versions of the
  // project, which would either lose work or clobber it on reload.
  // The leader's broadcasts already populate our projectFS in real
  // time via `file-sync`, so our local view of the project IS the
  // canonical version — we just don't write it ourselves.
  if (!isSaveLeader && !opts?.force) {
    trace.action('autosave:skipped-non-leader');
    return;
  }

  pendingSave = true;
  saveFailures = 0; // fresh user intent — a new edit re-earns the retry budget
  getStore().set(saveStatusAtom, 'unsaved');

  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    startSave();
  }, DEBOUNCE_MS);

  trace.action('autosave:queued', { debounceMs: DEBOUNCE_MS });
}

/** Drop any queued save WITHOUT running it. Used right before a deliberate
 *  full reload after the backend row was rewritten server-side (template
 *  apply into a fresh website): a debounced save or the unload beacon would
 *  PUT this tab's stale empty scaffold OVER the freshly applied template
 *  files. */
export function cancelPendingAutosave(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingSave = false;
  trace.action('autosave:cancelled-pending');
}

// Register beforeunload handler to flush any pending save synchronously.
// navigator.sendBeacon is used because fetch() is cancelled on unload.
//
// SINGLETON ACROSS HMR GENERATIONS: this used to be an anonymous listener —
// every hot update stacked ANOTHER copy holding its dead generation's STALE
// projectFS snapshot, and a failed save (401 'local' PUTs) left that
// generation's pendingSave=true forever. On tab close/reload EVERY zombie
// listener fired its beacon, so the LAST beacon to land persisted day-old
// project state (the clobber-on-exit reverts, 2026-07-22). The window slot
// guarantees exactly one live listener; dispose also detaches ours.
const UNLOAD_HOOK_KEY = '__revymeAutosaveUnloadHook';
function onBeforeUnloadSave(e: BeforeUnloadEvent): void {
    if (_disposed) return;
    // isSaving counts as unsaved: the in-flight fetch DIES with the page
    // (no keepalive), so "a save is already running" is precisely when the
    // unload path must still act. The old skip here + fetch cancellation
    // lost every import whose PUT was mid-flight when the user clicked
    // Dashboard ("went back and the design was gone", 2026-08-07).
    if (!pendingSave && !isSaving) return;
    if (isHeld) {
      // Held = the fresh-site prompt is still deciding. The only deferred
      // content is the boot scaffold (a reload reseeds it identically) —
      // beaconing it would fill the row the remix-into endpoint needs empty.
      trace.action('autosave:beacon-skipped', { reason: 'held for template prompt' });
      return;
    }

    const id = getProjectId();
    if (CLOUD_ENABLED && id === 'local') {
      trace.action('autosave:beacon-skipped', { reason: 'unresolved project id' });
      return;
    }
    const snapshot = projectFS.getSnapshot();
    const data: ProjectData = {
      format: PROJECT_FORMAT,
      files: Object.fromEntries(snapshot),
    };

    if (!CLOUD_ENABLED) {
      // Local mode: LocalBackend's saveProject is a synchronous
      // localStorage.setItem under the hood, so a fire-and-forget call
      // completes before the tab unloads. No beacon transport needed.
      void backend.saveProject(id, data);
      trace.action('autosave:unload-local-save', { id });
      return;
    }

    // Cloud mode: sendBeacon — fetch() gets cancelled on unload.
    // Hono backend expects `{ json: <JSON-encoded ProjectData> }`.
    // Earlier this beacon sent the legacy Next.js `{ data, sourceWebsiteId }`
    // shape which got silently dropped, losing pending changes on tab close.
    const payload = JSON.stringify({ json: JSON.stringify(data) });
    const blob = new Blob([payload], { type: 'application/json' });
    const sent = navigator.sendBeacon(`/api/websites/${id}`, blob);
    trace.action('autosave:beacon', { id, sent, bytes: blob.size });
    if (!sent) {
      // sendBeacon has a ~64KB quota and returns false WITHOUT sending when
      // the payload exceeds it — which any real project does. There is no
      // unload-safe transport for a multi-MB body (fetch keepalive shares
      // the same quota), so the only remaining protection is the browser's
      // native leave-confirmation. It appears ONLY in the would-lose-work
      // case; choosing to stay kicks an immediate real save.
      e.preventDefault();
      e.returnValue = '';
      setTimeout(() => {
        if (!_disposed && pendingSave && !isSaving && !isHeld) void startSave();
      }, 0);
    }
}
if (typeof window !== 'undefined') {
  const prev = (window as any)[UNLOAD_HOOK_KEY] as (() => void) | undefined;
  if (prev) window.removeEventListener('beforeunload', prev);
  (window as any)[UNLOAD_HOOK_KEY] = onBeforeUnloadSave;
  window.addEventListener('beforeunload', onBeforeUnloadSave);
}
