// CollaboratorSelections.tsx — What collaborators have selected, and what
// they are dragging / resizing right now, outlined on the canvas in their
// colour.
//
// Selections were broadcast and stored all along (useCollaborationSelection
// → CollaborationProvider.selections) but nothing drew them, so "watch each
// other's selections" — the old collision story — had nothing to watch. A
// gesture LOCK (collab-locks.ts) draws heavier, with "· editing", because
// that node refuses your drag / resize / delete until they let go.
//
// Geometry: the bridge's rect cache (parent-window coordinates, every
// viewport tile), polled at rAF while there is something to draw and only
// re-rendered when a box actually moved — the CollaboratorCursors pattern.
// Clipped to the canvas root so an outline never paints over the panels.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { previewModeAtom } from '@/code/stores/editor-store';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { findNodeRect } from '@/canvas/node-ops';
import { useCollaboration } from './CollaborationProvider';
import { getRemoteLocks, pruneExpiredRemoteLocks, remoteLocksVersionAtom, type RemoteLock } from './collab-locks';
import type { ActiveUser, RemoteSelection } from './types';

/** A select-all on a big page is thousands of nodes × tiles; outlining every
 *  one helps nobody and costs a frame. */
const MAX_BOXES = 300;

export interface CollabBox {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  /** Only the first box of each person carries their name. */
  label: string | null;
  locked: boolean;
}

type RectOf = (nodeId: string, vpId: string) => { left: number; top: number; width: number; height: number } | null;

/** Pure: who holds / has selected what on `page`, as screen boxes. A node
 *  someone is dragging shows once — as the lock, not also as a selection. */
export function collectCollabBoxes(
  page: string | null,
  selections: Iterable<RemoteSelection>,
  users: ActiveUser[],
  locks: RemoteLock[],
  vpIds: string[],
  rectOf: RectOf,
): CollabBox[] {
  const out: CollabBox[] = [];
  const shownAsLock = new Set<string>();
  const push = (key: string, nodeId: string, color: string, label: string | null, locked: boolean): boolean => {
    let placed = false;
    for (const vpId of vpIds) {
      if (out.length >= MAX_BOXES) return placed;
      const r = rectOf(nodeId, vpId);
      if (!r || (r.width <= 0 && r.height <= 0)) continue;
      out.push({ key: `${key}:${vpId}:${nodeId}`, left: r.left, top: r.top, width: r.width, height: r.height, color, label: placed || label === null ? null : label, locked });
      placed = true;
    }
    return placed;
  };
  for (const lock of locks) {
    let labelled = false;
    for (const id of lock.nodeIds) {
      shownAsLock.add(`${lock.userId}:${id}`);
      if (push(`lock:${lock.socketId}`, id, lock.color, labelled ? null : `${lock.name} · editing`, true)) labelled = true;
    }
  }
  const userById = new Map(users.map((u) => [u.id, u]));
  for (const sel of selections) {
    if (sel.page && page && sel.page !== page) continue;
    const user = userById.get(sel.userId);
    if (!user) continue;
    let labelled = false;
    for (const id of sel.nodeIds) {
      if (shownAsLock.has(`${sel.userId}:${id}`)) continue;
      if (push(`sel:${sel.userId}`, id, user.color, labelled ? null : user.name, false)) labelled = true;
    }
  }
  return out;
}

function signature(boxes: CollabBox[]): string {
  return boxes.map((b) => `${b.key}@${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}${b.label ?? ''}`).join('|');
}

export default function CollaboratorSelections() {
  const { isConnected, remoteUsers, selections } = useCollaboration();
  const activePage = useAtomValue(activeFilePathAtom);
  const isPreviewing = useAtomValue(previewModeAtom);
  const locksVersion = useAtomValue(remoteLocksVersionAtom);
  const [boxes, setBoxes] = useState<CollabBox[]>([]);
  const [clip, setClip] = useState<DOMRect | null>(null);

  const hasSomething = selections.size > 0 || getRemoteLocks(activePage).length > 0;

  useEffect(() => {
    if (!isConnected || isPreviewing || !hasSomething) {
      setBoxes((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    let raf = 0;
    let lastSig = '';
    let lastClip = '';
    const tick = () => {
      pruneExpiredRemoteLocks();
      const next = collectCollabBoxes(
        activePage,
        selections.values(),
        remoteUsers,
        getRemoteLocks(activePage),
        Object.keys(getViewportWidths()),
        findNodeRect,
      );
      const sig = signature(next);
      if (sig !== lastSig) { lastSig = sig; setBoxes(next); }
      const root = document.querySelector('[data-canvas-root]') as HTMLElement | null;
      const rect = root?.getBoundingClientRect() ?? null;
      const clipSig = rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : '';
      if (clipSig !== lastClip) { lastClip = clipSig; setClip(rect); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isConnected, isPreviewing, hasSomething, activePage, selections, remoteUsers, locksVersion]);

  if (!isConnected || isPreviewing || !clip || boxes.length === 0) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-[1] overflow-hidden"
      style={{ left: clip.left, top: clip.top, width: clip.width, height: clip.height }}
      data-collab-selections
    >
      {boxes.map((b) => (
        <div
          key={b.key}
          className="absolute"
          style={{
            left: b.left - clip.left,
            top: b.top - clip.top,
            width: b.width,
            height: b.height,
            boxShadow: `inset 0 0 0 ${b.locked ? 2 : 1}px ${b.color}`,
          }}
        >
          {b.label && (
            <div
              className="absolute left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-none text-white"
              style={{ bottom: '100%', marginBottom: 2, backgroundColor: b.color }}
            >
              {b.label}
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
