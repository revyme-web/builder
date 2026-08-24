// Drawing an absolutely-positioned node inside a STATIC parent.
//
// Reported 2026-08-24: a frame drawn inside a chart bar jumped to the card's
// top-left. The measured `left: 23px / top: 17px` were correct — relative to
// the bar — but CSS resolves an absolute child's offsets against the nearest
// POSITIONED ancestor, and the bar carried `order`/`flex`/`width`/`height` with
// no `position` at all. So the offsets were handed to an ancestor several
// levels up.
//
// Every node is supposed to carry an explicit position
// ([[feedback_always_position_on_nodes]]), but template and AI-authored content
// predates that rule — so the creators, which DEPEND on the parent being a
// containing block, have to guarantee it themselves.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queueMutation = vi.hoisted(() => vi.fn());
vi.mock('@/code/mutation/mutation-queue', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  queueMutation,
}));

import { needsRelativeForAbsChild, ensureAbsChildContainingBlock } from './creator-utils';
import { setActiveBridge } from '@/canvas/canvas-bridge';
import type { CanvasBridge } from '@/canvas/canvas-bridge';

describe('needsRelativeForAbsChild', () => {
  it('THE BUG: a static parent needs it', () => {
    // The reported bar, as authored: flex/order/size, no position.
    expect(needsRelativeForAbsChild({ position: 'static' })).toBe(true);
  });

  it('a parent that is already positioned does not', () => {
    for (const position of ['relative', 'absolute', 'fixed', 'sticky']) {
      expect(needsRelativeForAbsChild({ position }), position).toBe(false);
    }
  });

  it('a TRANSFORM makes a static parent a containing block on its own', () => {
    // Rewriting the source to say what the element already does would be a
    // pointless mutation of the user's file.
    expect(needsRelativeForAbsChild({ position: 'static', transform: 'matrix(1, 0, 0, 1, 0, 40)' })).toBe(false);
  });

  it('so do filter, perspective and contain', () => {
    expect(needsRelativeForAbsChild({ position: 'static', filter: 'blur(4px)' })).toBe(false);
    expect(needsRelativeForAbsChild({ position: 'static', perspective: '800px' })).toBe(false);
    expect(needsRelativeForAbsChild({ position: 'static', contain: 'paint' })).toBe(false);
  });

  it('their NONE values are not containing blocks — the common computed case', () => {
    // getComputedStyle returns 'none' for every unset one of these, so reading
    // them naively as truthy would disable the fix everywhere.
    expect(needsRelativeForAbsChild({
      position: 'static', transform: 'none', filter: 'none', perspective: 'none', contain: 'none',
    })).toBe(true);
  });
});

describe('ensureAbsChildContainingBlock — the source write', () => {
  /** A bridge that answers computed-style reads with `styles`. */
  function bridgeWith(styles: Record<string, string>) {
    setActiveBridge({
      getComputedValues: (_id: string, _p: string, props: string[]) =>
        Object.fromEntries(props.map((k) => [k, styles[k] ?? ''])),
      getComputedValue: (_id: string, _p: string, prop: string) => styles[prop] ?? '',
    } as unknown as CanvasBridge);
  }

  beforeEach(() => queueMutation.mockClear());

  it('queues position: relative on a static parent', () => {
    bridgeWith({ position: 'static', transform: 'none' });
    expect(ensureAbsChildContainingBlock('c2-b2', 'desktop', null)).toBe(true);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 'c2-b2', styles: { position: 'relative' },
    });
  });

  it('writes NOTHING when the parent is already positioned', () => {
    bridgeWith({ position: 'relative', transform: 'none' });
    expect(ensureAbsChildContainingBlock('c2-b2', 'desktop', null)).toBe(false);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('writes NOTHING on a cold cache — an empty read is not "static"', () => {
    // findNodeComputedStyles returns '' for every prop before the bridge has
    // measured. Treating that as static would rewrite the user's source on a
    // guess, on any parent, every time a creator ran early.
    bridgeWith({});
    expect(ensureAbsChildContainingBlock('c2-b2', 'desktop', null)).toBe(false);
    expect(queueMutation).not.toHaveBeenCalled();
  });
});
