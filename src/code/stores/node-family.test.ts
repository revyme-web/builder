import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// End-to-end through the REAL atoms: codeAtom write → nodesAtom re-parse (with
// identity preservation) → per-node selectAtom notification. This is the
// contract the whole per-node subscription refactor rests on: a commit that
// doesn't touch a node must NOT notify that node's subscribers.
describe('node-family — per-node subscriptions', () => {
  const PAGE = (leftPx: number) => `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="stable-node" data-name="Keep" style={{ position: 'relative', width: '100px' }}></div>
      <div data-id="moving-node" data-name="Change" style={{ position: 'relative', left: '${leftPx}px' }}></div>
    </div>
  );
}`;

  it('notifies ONLY the subscriber of the changed node', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('./store');
    const { nodeAtom } = await import('./node-family');
    const store = getDefaultStore();

    store.set(codeAtom, PAGE(10));
    // Prime both selectors (selectAtom derives lazily on first read).
    expect(store.get(nodeAtom('stable-node'))?.styles.width).toBe('100px');
    expect(store.get(nodeAtom('moving-node'))?.styles.left).toBe('10px');

    let stableFires = 0;
    let movingFires = 0;
    const unsubStable = store.sub(nodeAtom('stable-node'), () => { stableFires++; });
    const unsubMoving = store.sub(nodeAtom('moving-node'), () => { movingFires++; });

    // Commit that touches ONLY moving-node.
    store.set(codeAtom, PAGE(99));

    expect(store.get(nodeAtom('moving-node'))?.styles.left).toBe('99px');
    expect(movingFires).toBeGreaterThan(0);       // changed node → notified
    expect(stableFires).toBe(0);                  // untouched node → SKIPPED
    unsubStable();
    unsubMoving();
  });

  it('useNode(null) resolves to undefined without a real subscription target', async () => {
    const { getDefaultStore } = await import('jotai');
    const { nodeAtom } = await import('./node-family');
    const store = getDefaultStore();
    // The sentinel id never matches a node.
    expect(store.get(nodeAtom(' __no-node__'))).toBeUndefined();
  });

  it('returns the same atom instance per id (stable identity for hooks)', async () => {
    const { nodeAtom } = await import('./node-family');
    expect(nodeAtom('some-id')).toBe(nodeAtom('some-id'));
    expect(nodeAtom('some-id')).not.toBe(nodeAtom('other-id'));
  });
});
