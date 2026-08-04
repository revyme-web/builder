import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import React from 'react';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

// An UNRESOLVABLE selection (selected id not in the node map) is a legitimate,
// recurring state: mid-drag the variant-exit path selects a clone whose
// addCanvasNode mutation is still queued, and cross-file navigation can leave a
// foreign id selected for a frame. The panel renders its empty shell then — but
// it must cost ONE render, not thousands.
//
// The regression this guards (user report 2026-08-02, "canvas freezes + right
// panel goes blank when dragging an absolute node out of a component REPLICA
// variant"): with no node, `baseStyles` fell back to a FRESH `{}` literal every
// render → the `styles` memo re-ran → `effectiveStyles`' useNodesComputed deps
// changed → a NEW selectAtom every render → jotai's useAtomValue effect (deps
// [store, atom]) re-subscribed and called its rerender() → unbounded render
// loop (~10k renders/s, measured in the saved trace).
describe('ControlProvider — unresolvable selection', () => {
  const PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="a" data-name="A" style={{ position: 'absolute', left: '10px' }}></div>
    </div>
  );
}`;

  async function countRenders(selectedIds: string[]): Promise<number> {
    const { codeAtom, selectedIdsAtom } = await import('@/code/stores/store');
    const { ControlProvider, useControl } = await import('./ControlProvider');

    const store = createStore();
    store.set(codeAtom, PAGE);
    store.set(selectedIdsAtom, selectedIds);

    let renders = 0;
    function Probe() {
      renders++;
      // Blow up loudly instead of hanging the suite if the loop ever returns.
      if (renders > 200) throw new Error(`ControlProvider render loop: ${renders} renders`);
      useControl();
      return null;
    }

    render(
      <Provider store={store}>
        <ControlProvider><Probe /></ControlProvider>
      </Provider>,
    );
    // Let every passive effect (and any it schedules) settle.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    return renders;
  }

  it('settles instead of looping when the selected id is not in the node map', async () => {
    const renders = await countRenders(['detach-clone-not-yet-parsed']);
    expect(renders).toBeLessThanOrEqual(4);
  });

  it('settles for a resolvable selection too (control)', async () => {
    const renders = await countRenders(['a']);
    expect(renders).toBeLessThanOrEqual(4);
  });

  it('settles with no selection at all', async () => {
    const renders = await countRenders([]);
    expect(renders).toBeLessThanOrEqual(4);
  });
});
