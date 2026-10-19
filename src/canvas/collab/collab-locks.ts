// collab-locks.ts — Gesture locks for live collaboration.
//
// Two people dragging one element each commit their own position, and before
// ordered file-sync the room ended up showing it in two places (user report
// 2026-10-19). Ordering makes the room converge; this makes the conflict not
// happen in the first place: while someone drags / resizes / rotates a node,
// everyone else's canvas refuses to start a gesture on it and outlines it in
// that person's colour.
//
// A lock lives exactly as long as the gesture — never as long as a selection:
// select something and walk away, and a selection lock would hold it forever.
// The holder re-announces every LOCK_HEARTBEAT_MS; receivers drop a lock that
// goes quiet for LOCK_TTL_MS (a crashed tab), and on `user-left`.
//
// Leaf module: no canvas imports, so DragCoordinator / ResizeManager /
// RotateManager / commands can all ask `lockHolder` without a cycle.

import { atom, getDefaultStore } from 'jotai';
import { toast } from 'sonner';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { trace } from '@/shared/debug-trace';

export const LOCK_HEARTBEAT_MS = 2500;
export const LOCK_TTL_MS = 8000;

export interface RemoteLock {
  /** Keyed per socket: one person in two tabs holds two independent locks. */
  socketId: string;
  userId: string;
  name: string;
  color: string;
  nodeIds: string[];
  page?: string;
  at: number;
}

// ─── Remote side ────────────────────────────────────────────────────────────

const remoteLocks = new Map<string, RemoteLock>();

/** Bumped on every change so overlays re-render (the map itself is mutable). */
export const remoteLocksVersionAtom = atom(0);

function bump(): void {
  const store = getDefaultStore();
  store.set(remoteLocksVersionAtom, store.get(remoteLocksVersionAtom) + 1);
}

/** A collaborator's `interacting` packet: empty `nodeIds` = released. */
export function setRemoteLock(lock: Omit<RemoteLock, 'at'>, now = Date.now()): void {
  if (lock.nodeIds.length === 0) {
    if (!remoteLocks.delete(lock.socketId)) return;
  } else {
    remoteLocks.set(lock.socketId, { ...lock, at: now });
  }
  bump();
}

export function clearRemoteLock(socketId: string): void {
  if (remoteLocks.delete(socketId)) bump();
}

export function clearAllRemoteLocks(): void {
  if (remoteLocks.size === 0) return;
  remoteLocks.clear();
  bump();
}

/** Forget locks whose heartbeat stopped (a crashed tab that hasn't timed out
 *  of the room yet). The overlay's poll calls this, so a dead lock's outline
 *  goes away on its own. */
export function pruneExpiredRemoteLocks(now = Date.now()): void {
  let changed = false;
  for (const [socketId, lock] of remoteLocks) {
    if (now - lock.at > LOCK_TTL_MS) {
      remoteLocks.delete(socketId);
      changed = true;
    }
  }
  if (changed) bump();
}

/** Live locks (heartbeat within the TTL), optionally only those on `page`. */
export function getRemoteLocks(page?: string | null, now = Date.now()): RemoteLock[] {
  const out: RemoteLock[] = [];
  for (const lock of remoteLocks.values()) {
    if (now - lock.at > LOCK_TTL_MS) continue;
    if (page && lock.page && lock.page !== page) continue;
    out.push(lock);
  }
  return out;
}

/** The collaborator holding any of `nodeIds` on the active page, or null.
 *  Gesture starts call this and bail on a hit. */
export function lockHolder(nodeIds: string[], now = Date.now()): RemoteLock | null {
  if (remoteLocks.size === 0 || nodeIds.length === 0) return null;
  const page = getDefaultStore().get(activeFilePathAtom);
  for (const lock of getRemoteLocks(page, now)) {
    if (nodeIds.some((id) => lock.nodeIds.includes(id))) return lock;
  }
  return null;
}

/** Gate for a gesture / destructive command: true (and a toast saying who)
 *  when a collaborator holds any of `nodeIds`. */
export function refusedByCollaboratorLock(nodeIds: string[], action: string): boolean {
  const lock = lockHolder(nodeIds);
  if (!lock) return false;
  trace.action('collab:blocked-by-lock', { action, nodeIds, holder: lock.userId });
  toast(`${lock.name} is editing this element right now`, { id: 'collab-lock' });
  return true;
}

// ─── Local side ─────────────────────────────────────────────────────────────

let localTargets: string[] = [];
const localListeners = new Set<() => void>();
let detachEndListeners: (() => void) | null = null;

function notifyLocal(): void {
  for (const fn of localListeners) fn();
}

/** A gesture on `nodeIds` started here. Ends on its own: pointer release,
 *  window blur, or the drag flag dropping (Escape-cancel has no pointerup). */
export function beginLocalInteraction(nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  localTargets = [...nodeIds];
  trace.action('collab:local-interaction-begin', { nodeIds: localTargets });
  notifyLocal();
  if (detachEndListeners || typeof window === 'undefined') return;
  const end = () => endLocalInteraction();
  const onDragState = () => { if (!dragStateOps.get()) end(); };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('mouseup', end, true);
  window.addEventListener('blur', end);
  const unsubDrag = dragStateOps.subscribe(onDragState);
  detachEndListeners = () => {
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('mouseup', end, true);
    window.removeEventListener('blur', end);
    unsubDrag();
  };
}

export function endLocalInteraction(): void {
  detachEndListeners?.();
  detachEndListeners = null;
  if (localTargets.length === 0) return;
  localTargets = [];
  trace.action('collab:local-interaction-end', {});
  notifyLocal();
}

export function getLocalInteraction(): string[] {
  return localTargets;
}

export function subscribeLocalInteraction(fn: () => void): () => void {
  localListeners.add(fn);
  return () => { localListeners.delete(fn); };
}
