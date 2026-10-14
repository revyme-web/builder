// autosave.ts — Debounced project save triggered after mutation queue flush.
// Uses getDefaultStore() to update saveStatusAtom outside of React.

import { getDefaultStore } from 'jotai';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { backend } from './index';
import { getProjectId } from './project-id';
import { saveErrorAtom, saveStatusAtom } from './save-store';
import { SaveConflictError, type ProjectData } from './types';
import { adoptForOverwrite, getBaseRevision, isRevisionInSync, setLoadedRevision } from './save-revision';
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
let currentSave: Promise<SaveOutcome> | null = null;

/**
 * What a save attempt came to. Callers that report a write as done — the MCP
 * bridge (`committed`), agent tools, Publish — MUST read this: a save can fail
 * (backend down, a payload the database refuses, a stale tab) and the editor
 * keeps the change only in memory, gone on reload. Returning void here is how
 * `committed: true` came back for writes that never reached the server
 * (2026-10-14).
 */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; error: string; conflict?: boolean };
let lastOutcome: SaveOutcome = { ok: true };

/** Set while the backend refuses this tab's saves as stale (409). Saving
 *  stops — every retry would be refused the same way — until the user
 *  reloads or chooses to overwrite (`overwriteAfterConflict`). */
let conflict: { serverRevision: number | null } | null = null;

export const SAVE_CONFLICT_MESSAGE =
  'This project was saved from another tab or device after this tab loaded it, so this tab\'s copy is out of date. '
  + 'Nothing from this tab was saved. Reload the editor tab to get the latest version (or overwrite it with this tab\'s copy).';

/** The sentence an agent tool returns when its write did not persist. Written
 *  for a model: what happened, that it is NOT done, and what to do. */
export function describeSaveFailure(outcome: { error: string; conflict?: boolean }): string {
  if (outcome.conflict) {
    return `NOT SAVED: ${outcome.error} Stop and tell the user — reload the Revyme editor tab, then redo this change.`;
  }
  return `The change was applied in the editor but saving it to the server FAILED (${outcome.error}). `
    + 'It is NOT persisted and will be lost when the editor tab reloads. Do not report this as done — tell the user saving is failing.';
}

function record(outcome: SaveOutcome): SaveOutcome {
  lastOutcome = outcome;
  return outcome;
}

/** The last save attempt's outcome. */
export function getLastSaveOutcome(): SaveOutcome {
  return lastOutcome;
}

/** Is there work this tab has not (successfully) saved? */
export function hasUnsavedChanges(): boolean {
  return pendingSave || debounceTimer !== null || isSaving || !lastOutcome.ok;
}

/**
 * Local (non-remote) ProjectFS writes since load. A caller that must persist
 * what an operation wrote compares this before/after: `hasUnsavedChanges`
 * alone misses a non-leader tab, whose flush-triggered autosave is skipped
 * without marking anything pending.
 */
let localWrites = 0;
// `projectFS` is a live binding that `resetProjectFS` replaces (debug
// toolbar, harnesses): follow the current instance.
let countedFS: typeof projectFS | null = null;
let stopCounting: (() => void) | null = null;
export function localWriteCount(): number {
  if (countedFS !== projectFS && typeof projectFS?.subscribeWrites === 'function') {
    stopCounting?.();
    countedFS = projectFS;
    stopCounting = projectFS.subscribeWrites((e) => { if (e.origin !== 'remote') localWrites++; });
  }
  return localWrites;
}

export function getSaveConflict(): { serverRevision: number | null } | null {
  return conflict;
}

function getStore() {
  return getDefaultStore();
}

/**
 * The ProjectData envelope for the current project state. MAIN's files are
 * `files` — the publish / export / backup truth — and non-main branches ride
 * beside them (`toEnvelope`: v1 while there is no branch, so a project
 * without branches saves byte-identically to before branching; v2 once one
 * exists). This is NOT `getSnapshot()`: that is the ACTIVE branch's map, and
 * saving it as `files` while sitting on a branch wrote the branch OVER main
 * in the DB and dropped every branch on reload (found 2026-09-22 — the port
 * had the envelope but nothing called it).
 */
export function buildProjectData(): ProjectData {
  return projectFS.toEnvelope();
}

/** A 409 for an IN-SYNC tab is usually a race, not a stale copy: a room
 *  member's save landed a moment before ours and its `project-saved` event
 *  (which we would adopt) is still in flight. Wait briefly for it. */
const ADOPTION_WAIT_MS = 1500;
async function waitForAdoption(serverRevision: number): Promise<boolean> {
  const until = Date.now() + ADOPTION_WAIT_MS;
  while (Date.now() < until) {
    const base = getBaseRevision();
    if (base !== null && base >= serverRevision) return true;
    if (!isRevisionInSync()) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function performSave(attempt = 0): Promise<SaveOutcome> {
  const store = getStore();
  const id = getProjectId();
  // An unresolved project id means this client never finished booting into a
  // real website (or is a stale HMR generation from before the id resolved) —
  // its PUT /api/websites/local can only 401 or, worse, clobber. Never ship it.
  if (CLOUD_ENABLED && id === 'local') {
    trace.action('autosave:skipped-unresolved-project-id', { id });
    return record({ ok: false, error: 'The editor has not resolved this project yet — nothing was saved.' });
  }
  if (conflict) {
    store.set(saveStatusAtom, 'conflict');
    trace.action('autosave:skipped-conflict', { id });
    return record({ ok: false, conflict: true, error: SAVE_CONFLICT_MESSAGE });
  }
  const data = buildProjectData();

  store.set(saveStatusAtom, 'saving');
  isSaving = true;
  trace.action('autosave:start', { id, fileCount: Object.keys(data.files).length, branches: data.branches ? Object.keys(data.branches).length : 0 });

  try {
    await backend.saveProject(id, data);
    store.set(saveStatusAtom, 'saved');
    store.set(saveErrorAtom, null);
    pendingSave = false;
    saveFailures = 0;
    trace.action('autosave:success', { id });
    return record({ ok: true });
  } catch (err) {
    debounceTimer = null;
    if (err instanceof SaveConflictError && attempt === 0 && err.serverRevision !== null
      && isRevisionInSync() && await waitForAdoption(err.serverRevision)) {
      trace.action('autosave:conflict-raced-adopted', { id, serverRevision: err.serverRevision });
      return performSave(1);
    }
    if (err instanceof SaveConflictError) {
      // Stale tab: retrying cannot succeed and must not be attempted — the
      // user decides (SaveProblemBanner). The edit stays pending.
      conflict = { serverRevision: err.serverRevision };
      pendingSave = true;
      store.set(saveStatusAtom, 'conflict');
      store.set(saveErrorAtom, SAVE_CONFLICT_MESSAGE);
      trace.error('autosave:conflict', { id, serverRevision: err.serverRevision });
      return record({ ok: false, conflict: true, error: SAVE_CONFLICT_MESSAGE });
    }
    const message = String((err as Error)?.message ?? err);
    store.set(saveStatusAtom, 'error');
    store.set(saveErrorAtom, message);
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
    return record({ ok: false, error: message });
  } finally {
    isSaving = false;
  }
}

/** Start a save and track its promise so `flushSaveNow` can await it. */
function startSave(): Promise<SaveOutcome> {
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
export async function flushSaveNow(): Promise<SaveOutcome> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (currentSave) {
    try { await currentSave; } catch { /* status handled in performSave */ }
  }
  trace.action('autosave:flush-now');
  return startSave();
}

/**
 * Conflict resolution — keep THIS tab's copy: base it on the row's current
 * revision and save, replacing what the other tab / device saved. Only ever
 * on the user's explicit choice.
 */
export async function overwriteAfterConflict(): Promise<SaveOutcome> {
  if (!conflict) return lastOutcome;
  if (conflict.serverRevision !== null) adoptForOverwrite(conflict.serverRevision);
  else setLoadedRevision(null); // backend gave no revision: save unconditionally
  conflict = null;
  saveFailures = 0;
  trace.action('autosave:conflict-overwrite');
  return startSave();
}

/** Conflict resolution — take the newer version: drop this tab's unsaved
 *  copy (so the unload guard does not offer to keep it) and reload. */
export function reloadAfterConflict(): void {
  cancelPendingAutosave();
  trace.action('autosave:conflict-reload');
  window.location.reload();
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
  if (conflict) {
    // Stale tab — saving would be refused; remember the edit, show the state.
    pendingSave = true;
    getStore().set(saveStatusAtom, 'conflict');
    trace.action('autosave:deferred-conflict');
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
    if (conflict) {
      // A stale copy must not be beaconed over the newer row — but the user
      // still gets the leave-confirmation for the work only this tab holds.
      trace.action('autosave:beacon-skipped', { reason: 'save conflict' });
      e.preventDefault();
      e.returnValue = '';
      return;
    }
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
    const data = buildProjectData();

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
