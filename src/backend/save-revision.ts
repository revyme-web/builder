// save-revision.ts — the optimistic-concurrency token of the project row.
//
// Every save replaces the WHOLE project (`websites.json`), so a tab that loaded
// the project an hour ago and saves now writes its hour-old copy over whatever
// other tabs / devices saved since — the stale-tab clobber (a laptop woken from
// sleep, a desktop tab opened while an agent's tab was working; 2026-10-14).
// The backend keeps a `revision` counter on the row: a save names the revision
// it is based on, and a save based on an older one is refused (409) instead of
// silently winning.
//
// Live collaboration complicates "based on": tabs in the same realtime room
// receive each other's file writes (`file-sync`), so when ANOTHER room member
// saves, this tab already holds that content and may adopt the new revision as
// its base. That is only true while this tab has been in the room the whole
// time — a tab that dropped off missed relays, and one that joined after the
// row moved never saw the writes in between. So adoption is gated:
//   · on join, the room tells us the row's revision — equal to ours ⇒ in sync;
//   · any disconnect ⇒ out of sync until our own save succeeds;
//   · a save announced by an out-of-sync saver ⇒ we are behind it too.
// An out-of-sync tab keeps its base; its next save conflicts and the user
// chooses (reload, or overwrite with this tab's copy).

import { trace } from '@/shared/debug-trace';

/** null = unknown (local mode, or a backend that predates revisions):
 *  saves then carry no base and behave exactly as before. */
let baseRevision: number | null = null;
/** May this tab adopt a revision another room member saved? */
let inSync = false;
/** Is the realtime room connected right now? */
let roomConnected = false;

/** Boot: the revision the project was loaded at. */
export function setLoadedRevision(revision: number | null | undefined): void {
  baseRevision = typeof revision === 'number' && Number.isFinite(revision) ? revision : null;
  inSync = false;
  trace.action('save-revision:loaded', { baseRevision });
}

export function getBaseRevision(): number | null {
  return baseRevision;
}

/** Sent with each save so the room knows whether the saver's copy holds
 *  every relayed write (see the header). */
export function isRevisionInSync(): boolean {
  return inSync;
}

/** Our own save landed at `revision`. The row now equals this tab's copy. */
export function noteSaved(revision: number | null | undefined): void {
  if (typeof revision === 'number' && Number.isFinite(revision)) baseRevision = revision;
  inSync = roomConnected;
  trace.action('save-revision:saved', { baseRevision, inSync });
}

/** Joined (or re-joined) the realtime room; `serverRevision` is the row's
 *  revision at join time. */
export function noteRoomJoined(serverRevision: number | null | undefined): void {
  roomConnected = true;
  inSync = typeof serverRevision === 'number' && serverRevision === baseRevision;
  trace.action('save-revision:room-joined', { serverRevision, baseRevision, inSync });
}

export function noteRoomLeft(): void {
  roomConnected = false;
  inSync = false;
  trace.action('save-revision:room-left', {});
}

/**
 * Another room member saved the row at `revision`. Adopt it when both sides
 * were in sync; otherwise this tab is now behind and must not adopt.
 * Returns whether the revision was adopted.
 */
export function noteRemoteSaved(revision: number, saverInSync: boolean): boolean {
  if (baseRevision === null || !Number.isFinite(revision) || revision <= baseRevision) return false;
  if (inSync && saverInSync) {
    baseRevision = revision;
    trace.action('save-revision:adopted', { baseRevision });
    return true;
  }
  inSync = false;
  trace.action('save-revision:behind', { remote: revision, baseRevision });
  return false;
}

/** Overwrite chosen after a conflict: base this tab on the row's current
 *  revision so its next save replaces it. */
export function adoptForOverwrite(serverRevision: number): void {
  baseRevision = serverRevision;
  trace.action('save-revision:overwrite-adopt', { baseRevision });
}

/** Test-only reset. */
export function resetSaveRevisionForTest(): void {
  baseRevision = null;
  inSync = false;
  roomConnected = false;
}
