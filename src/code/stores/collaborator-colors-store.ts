// collaborator-colors-store.ts — per-website collaborator color identity.
//
// Every website stores a color per person (owner + each collaborator) —
// the colored dots the owner picks in the CollaboratorsModal. That color
// is the single source of truth for how a person is drawn everywhere:
//   * live cursors
//   * comment-thread avatars (incl. OFFLINE authors — the reason this is
//     a persisted lookup, not the live-socket user list)
//   * the bottom-left-menu CollaboratorsSection circles
//
// Seeded once on editor load from `listCollaborators(websiteId)`, then
// kept in sync by:
//   * the CollaboratorsModal when the owner changes a color
//   * the `color-change` socket event (a remote peer changed theirs)
//
// Not a Jotai atom — read from non-React contexts (the comment renderer
// runs fine in React, but keeping the same module-level + useSyncExternalStore
// pattern as viewer-mode-store avoids the editor's `<Provider>` store
// mismatch and lets imperative code read colors too).

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';

export interface CollaboratorIdentity {
  /** Hex color the owner assigned to this person on THIS website. */
  color: string;
  name: string;
  /** Profile picture URL — when set, UIs show the image and ignore color. */
  avatar?: string | null;
}

let _colors = new Map<string, CollaboratorIdentity>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Replace the whole map — used to seed from `listCollaborators`. */
export function setCollaboratorColors(
  entries: { userId: string; color: string; name: string; avatar?: string | null }[],
): void {
  const next = new Map<string, CollaboratorIdentity>();
  for (const e of entries) {
    next.set(e.userId, { color: e.color, name: e.name, avatar: e.avatar });
  }
  _colors = next;
  trace.action('collaborator-colors:seed', { count: next.size });
  emit();
}

/** Update one person's color in place — used by the modal color picker
 *  and the `color-change` socket handler. No-op if the user isn't in
 *  the map (e.g. color event for someone not yet seeded). */
export function updateCollaboratorColor(userId: string, color: string): void {
  const existing = _colors.get(userId);
  if (!existing || existing.color === color) return;
  const next = new Map(_colors);
  next.set(userId, { ...existing, color });
  _colors = next;
  trace.action('collaborator-colors:update', { userId, color });
  emit();
}

/** Resolve a person's CURRENT avatar URL for comment-thread display.
 *  Live sources (the signed-in user, the seeded collaborator list) win
 *  over the avatar frozen onto a message/comment at creation time — so
 *  adding or changing a profile picture retroactively updates every
 *  past comment by the same author. `storedAvatar` is the last-resort
 *  fallback for authors no longer in the collaborator list (legacy
 *  data, removed people). */
export function resolveCollaboratorAvatar(
  colors: Map<string, CollaboratorIdentity>,
  userId: string,
  storedAvatar?: string | null,
  currentUser?: { id: string; image?: string } | null,
): string | null {
  if (currentUser && userId === currentUser.id) return currentUser.image ?? null;
  const collab = colors.get(userId);
  if (collab) return collab.avatar ?? null;
  return storedAvatar ?? null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): Map<string, CollaboratorIdentity> {
  return _colors;
}

/** React hook — the whole color map, reactive. Re-renders on any seed
 *  or per-user update. Consumers usually just `.get(userId)?.color`. */
export function useCollaboratorColors(): Map<string, CollaboratorIdentity> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
