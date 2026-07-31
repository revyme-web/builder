// viewer-mode-store.ts — read-only flag for the editor.
//
// The editor is read-only ("viewer mode") in two situations:
//   1. ROLE    — the user's role on this website is `viewer`. Set once
//                at project load (ProjectLoader.tsx) from the fetched
//                role.
//   2. OFFLINE — the user's network is down. Edits can't be persisted
//                or synced, so editing is locked until they reconnect.
//                Set by the OfflineWatcher in App.tsx.
//
// Both collapse to the SAME read-only behaviour — `isViewerMode()`
// returning true drives every write gate and every disabled-UI surface
// identically. They differ only in MESSAGING: a viewer sees the
// "View only" banner, an offline user sees the reconnect toast.
// `getViewerReason()` exposes which one is active.
//
// Read by:
//   * mutation-queue.ts and node-ops.ts — gate writes (no-op when true)
//   * the whole editor UI — hide/disable write affordances
//   * App.tsx — banner (role) vs toast (offline) via getViewerReason()
//
// Not a Jotai atom on purpose. The mutation queue runs in non-React
// contexts (drag handlers, debug traces, etc.) where `getDefaultStore()`
// returns the wrong store under the editor's `<Provider>`. Module-level
// state + `useSyncExternalStore` keeps reads consistent everywhere.

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';

/** Why the editor is read-only right now. `null` = fully editable. */
export type ViewerReason = 'viewer' | 'offline' | null;

let _isViewerRole = false;
let _isOffline = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Read viewer mode from imperative code (mutation-queue, node-ops,
 *  drag/resize handlers). True when the user is a viewer by role OR
 *  currently offline — every reader sees the same value. */
export function isViewerMode(): boolean {
  return _isViewerRole || _isOffline;
}

/** Why the editor is locked — drives banner vs toast. Role wins: a
 *  viewer who also goes offline still sees the "View only" banner
 *  (they couldn't edit either way, so the reconnect toast is moot). */
function getViewerReason(): ViewerReason {
  if (_isViewerRole) return 'viewer';
  if (_isOffline) return 'offline';
  return null;
}

/** Imperative read of the OFFLINE flag specifically (ignores the role
 *  flag). Use this — not `getViewerReason() === 'offline'` — for things
 *  that must be gated by connectivity regardless of role, e.g. hiding
 *  the comment tool (a role-viewer may comment, but nobody may comment
 *  offline since the comment can't be persisted/synced). */
export function isOffline(): boolean {
  return _isOffline;
}

/** Set the role flag. Called once from ProjectLoader after the role is
 *  fetched, then on any subsequent reload. Idempotent. */
export function setViewerMode(next: boolean): void {
  if (_isViewerRole === next) return;
  _isViewerRole = next;
  trace.action('viewer-mode:set-role', { isViewer: next });
  emit();
}

/** Set the offline flag. Called by the OfflineWatcher when the browser
 *  network status changes. Idempotent. */
export function setOfflineMode(next: boolean): void {
  if (_isOffline === next) return;
  _isOffline = next;
  trace.action('viewer-mode:set-offline', { isOffline: next });
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook — reactive read of viewer mode (viewer role OR offline).
 *  Re-renders when either flag flips. Use everywhere in UI code. */
export function useIsViewer(): boolean {
  return useSyncExternalStore(subscribe, isViewerMode, isViewerMode);
}

/** React hook — the reason the editor is read-only, or null. Use for
 *  messaging (the "View only" banner vs the offline toast). */
export function useViewerReason(): ViewerReason {
  return useSyncExternalStore(subscribe, getViewerReason, getViewerReason);
}

/** React hook — reactive read of the OFFLINE flag specifically. See
 *  `isOffline()` for when to use this over `useViewerReason()`. */
export function useIsOffline(): boolean {
  return useSyncExternalStore(subscribe, isOffline, isOffline);
}
