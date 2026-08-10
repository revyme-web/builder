// camera-move-store.test.ts — the signal that tells a camera pan/zoom apart
// from a node gesture.
//
// `canvasInteractingAtom` can't: it flips true for both, which is why a
// two-finger scroll left a blue `<InteractionOutline/>` floating over the
// design with no handles (user report 2026-08-10). The space-bar/hand-tool pan
// already hid everything via `panHighlightAtom`; wheel and trackpad had no
// equivalent until this.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cameraMoveOps } from './camera-move-store';

beforeEach(() => cameraMoveOps.set(false));

describe('cameraMoveOps', () => {
  it('reports the camera state', () => {
    expect(cameraMoveOps.get()).toBe(false);
    cameraMoveOps.set(true);
    expect(cameraMoveOps.get()).toBe(true);
  });

  it('notifies subscribers on change', () => {
    const fn = vi.fn();
    const off = cameraMoveOps.subscribe(fn);
    cameraMoveOps.set(true);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    cameraMoveOps.set(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT notify when the value is unchanged', () => {
    // The transform subscriber fires on EVERY pan/zoom tick — re-notifying at
    // 60fps would re-render every consumer for nothing.
    cameraMoveOps.set(true);
    const fn = vi.fn();
    const off = cameraMoveOps.subscribe(fn);
    cameraMoveOps.set(true);
    cameraMoveOps.set(true);
    expect(fn).not.toHaveBeenCalled();
    off();
  });

  it('is a stable getSnapshot reference (useSyncExternalStore safety)', () => {
    // Passing a fresh closure would make React loop; `get` must be the same fn.
    expect(cameraMoveOps.get).toBe(cameraMoveOps.get);
  });
});
