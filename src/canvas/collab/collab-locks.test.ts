import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import {
  LOCK_TTL_MS,
  setRemoteLock,
  clearRemoteLock,
  clearAllRemoteLocks,
  lockHolder,
  refusedByCollaboratorLock,
  pruneExpiredRemoteLocks,
  getRemoteLocks,
  beginLocalInteraction,
  endLocalInteraction,
  getLocalInteraction,
  subscribeLocalInteraction,
} from './collab-locks';
import { collectCollabBoxes } from './CollaboratorSelections';
import type { ActiveUser } from './types';

const PAGE = 'app/page.tsx';
const lock = (nodeIds: string[], extra: Partial<Parameters<typeof setRemoteLock>[0]> = {}) => ({
  socketId: 's1', userId: 'u1', name: 'Bachuki', color: '#f00', nodeIds, page: PAGE, ...extra,
});

describe('collab-locks — remote gesture locks', () => {
  beforeEach(() => {
    clearAllRemoteLocks();
    getDefaultStore().set(activeFilePathAtom, PAGE);
  });

  it('a node a collaborator is dragging is held; others are free', () => {
    setRemoteLock(lock(['blue']));
    expect(lockHolder(['blue'])?.name).toBe('Bachuki');
    expect(lockHolder(['pink'])).toBeNull();
    expect(lockHolder(['pink', 'blue'])?.userId).toBe('u1'); // any of a multi-selection
  });

  it('refusedByCollaboratorLock gates the gesture', () => {
    setRemoteLock(lock(['blue']));
    expect(refusedByCollaboratorLock(['blue'], 'drag')).toBe(true);
    expect(refusedByCollaboratorLock(['pink'], 'drag')).toBe(false);
  });

  it('released (empty ids), user-left and disconnect all free it', () => {
    setRemoteLock(lock(['blue']));
    setRemoteLock(lock([]));
    expect(lockHolder(['blue'])).toBeNull();
    setRemoteLock(lock(['blue']));
    clearRemoteLock('s1');
    expect(lockHolder(['blue'])).toBeNull();
    setRemoteLock(lock(['blue']));
    clearAllRemoteLocks();
    expect(lockHolder(['blue'])).toBeNull();
  });

  it('a lock whose heartbeat stopped expires (crashed tab)', () => {
    const t0 = 1_000_000;
    setRemoteLock(lock(['blue']), t0);
    expect(lockHolder(['blue'], t0 + LOCK_TTL_MS - 1)).not.toBeNull();
    expect(lockHolder(['blue'], t0 + LOCK_TTL_MS + 1)).toBeNull();
    pruneExpiredRemoteLocks(t0 + LOCK_TTL_MS + 1);
    expect(getRemoteLocks(null, t0)).toHaveLength(0);
  });

  it('a lock on ANOTHER page does not block this one', () => {
    setRemoteLock(lock(['blue'], { page: 'app/about/page.tsx' }));
    expect(lockHolder(['blue'])).toBeNull();
  });

  it('two tabs of one person hold independent locks (keyed by socket)', () => {
    setRemoteLock(lock(['blue'], { socketId: 'tabA' }));
    setRemoteLock(lock(['pink'], { socketId: 'tabB' }));
    clearRemoteLock('tabA');
    expect(lockHolder(['blue'])).toBeNull();
    expect(lockHolder(['pink'])).not.toBeNull();
  });
});

describe('collab-locks — local interaction', () => {
  afterEach(() => { endLocalInteraction(); dragStateOps.set(false); });

  it('ends on pointer release and notifies', () => {
    const seen: string[][] = [];
    const unsub = subscribeLocalInteraction(() => seen.push(getLocalInteraction()));
    beginLocalInteraction(['blue']);
    window.dispatchEvent(new PointerEvent('pointerup'));
    unsub();
    expect(seen).toEqual([['blue'], []]);
  });

  it('ends when the drag flag drops (Escape-cancel has no pointerup)', () => {
    dragStateOps.set(true);
    beginLocalInteraction(['blue']);
    dragStateOps.set(false);
    expect(getLocalInteraction()).toEqual([]);
  });
});

describe('collectCollabBoxes — what the overlay draws', () => {
  const users = [{ id: 'u1', name: 'Bachuki', color: '#f00' }, { id: 'u2', name: 'Kiera', color: '#0f0' }] as ActiveUser[];
  const rects: Record<string, { left: number; top: number; width: number; height: number }> = {
    'desktop:blue': { left: 10, top: 10, width: 100, height: 50 },
    'tablet:blue': { left: 500, top: 10, width: 80, height: 50 },
    'desktop:pink': { left: 200, top: 10, width: 100, height: 50 },
  };
  const rectOf = (id: string, vp: string) => rects[`${vp}:${id}`] ?? null;

  it('outlines a remote selection on every tile, name on the first box only', () => {
    const boxes = collectCollabBoxes(PAGE, [{ userId: 'u2', nodeIds: ['blue'], page: PAGE }], users, [], ['desktop', 'tablet'], rectOf);
    expect(boxes.map((b) => [b.left, b.label, b.locked])).toEqual([[10, 'Kiera', false], [500, null, false]]);
  });

  it('a locked node draws as the lock, not also as that person\'s selection', () => {
    const locks = [{ ...lock(['blue']), at: Date.now() }];
    const boxes = collectCollabBoxes(PAGE, [{ userId: 'u1', nodeIds: ['blue', 'pink'], page: PAGE }], users, locks, ['desktop'], rectOf);
    expect(boxes.map((b) => [b.left, b.label, b.locked])).toEqual([[10, 'Bachuki · editing', true], [200, 'Bachuki', false]]);
  });

  it('skips selections on another page and users who left', () => {
    const boxes = collectCollabBoxes(PAGE, [
      { userId: 'u2', nodeIds: ['blue'], page: 'app/about/page.tsx' },
      { userId: 'gone', nodeIds: ['pink'], page: PAGE },
    ], users, [], ['desktop'], rectOf);
    expect(boxes).toEqual([]);
  });
});
