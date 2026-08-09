// node-family-drop-lag.test.tsx — the overlay must not paint the pre-drop node.
//
// Dropping an auto/auto container onto the canvas bakes it to fixed px. The
// commit lands in the IMPERATIVE cache synchronously, but the parsed `nodesAtom`
// only catches up after the deferred fan-out — measured ~90ms on a 115-node
// page, longer on a big one. Overlays that decide what to DRAW from the node's
// size therefore painted the auto state on the mouseup frame and swapped a
// tenth of a second later: no resize circles, then circles; padding handles,
// then none (user report 2026-08-09).
//
// `useNode` rides the parsed map and lags. `useLiveNode` reads the cache. These
// pin the difference, because "which hook" is the entire fix in PaddingHandles
// and the SelectionOverlay poll.

import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

const PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="box" data-name="Box" style={{ width: 'auto', height: 'auto' }}></div>
    </div>
  );
}`;

/** What the drop writes: the measured px that replace auto/auto. */
const BAKED = { width: '580px', height: '374px' };

async function setup() {
  const { getDefaultStore } = await import('jotai');
  const { codeAtom, nodesAtom, updateNodeInCache } = await import('./store');
  const { useNode, useLiveNode } = await import('./node-family');
  const store = getDefaultStore();
  store.set(codeAtom, PAGE);
  store.get(nodesAtom); // populate the imperative cache from the parse

  const seen: { parsed?: string; live?: string } = {};
  function Probe() {
    seen.parsed = useNode('box')?.styles.width;
    seen.live = useLiveNode('box')?.styles.width;
    return null;
  }
  render(<Probe />);
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  return { seen, commitDrop: async () => { await act(async () => { updateNodeInCache('box', BAKED); }); } };
}

describe('a drop that bakes auto → px', () => {
  it('reaches the LIVE reader on the commit frame', async () => {
    const { seen, commitDrop } = await setup();
    expect(seen.live).toBe('auto');
    await commitDrop();
    expect(seen.live).toBe('580px');
  });

  it('has NOT reached the parsed reader yet — the lag this fix exists for', async () => {
    // No re-parse has run: `nodesAtom` still holds the pre-drop node. An overlay
    // reading it would draw the auto-state handles here.
    const { seen, commitDrop } = await setup();
    await commitDrop();
    expect(seen.parsed).toBe('auto');
  });

  it('and both agree once the parse catches up', async () => {
    // The cache is not a divergent second truth — it is the same value early.
    const { getDefaultStore } = await import('jotai');
    const { codeAtom, nodesAtom } = await import('./store');
    const { seen, commitDrop } = await setup();
    await commitDrop();
    await act(async () => {
      getDefaultStore().set(codeAtom, PAGE.replace("width: 'auto', height: 'auto'", "width: '580px', height: '374px'"));
      getDefaultStore().get(nodesAtom);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(seen.parsed).toBe('580px');
    expect(seen.live).toBe('580px');
  });
});
