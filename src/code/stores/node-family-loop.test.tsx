import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';

const traceError = vi.fn();
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: (...a: unknown[]) => traceError(...a) },
}));

// The failure mode this file pins down: `useNodesComputed` memoises its
// selectAtom on `deps`, and jotai's `useAtomValue` re-subscribes AND calls its
// own rerender() whenever the atom IDENTITY changes (its effect deps are
// [store, atom]). So a dep that is a fresh object every render turns the hook
// into a self-feeding render loop — no throw, no warning, just a component
// spinning at ~10k renders/second. That is what froze the canvas and blanked
// the properties panel when dragging a node out of a component variant
// (2026-08-02): ControlProvider's `baseStyles` fell back to a fresh `{}`
// whenever the selection didn't resolve to a node.
describe('useNodesComputed — dep stability', () => {
  const PAGE = `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="a" style={{ position: 'absolute', left: '10px' }}></div>
    </div>
  );
}`;

  const STABLE_DEP = { stable: true };

  it('a STABLE dep costs O(1) renders', async () => {
    const { getDefaultStore } = await import('jotai');
    const { codeAtom } = await import('./store');
    const { useNodesComputed } = await import('./node-family');
    getDefaultStore().set(codeAtom, PAGE);
    traceError.mockClear();

    let renders = 0;
    function Probe() {
      renders++;
      if (renders > 100) throw new Error(`render loop: ${renders}`);
      useNodesComputed(() => null, [STABLE_DEP]);
      return null;
    }
    render(<Probe />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    expect(renders).toBeLessThanOrEqual(3);
    // (Other trace.error calls can come from the parse — only the tripwire matters.)
    expect(traceError.mock.calls.map((c) => c[0])).not.toContain('node-family:selector-rebuilt-every-render');
  });

  it('an UNSTABLE dep loops — and the tripwire names it in the trace', async () => {
    const { useNodesComputed } = await import('./node-family');
    traceError.mockClear();

    let renders = 0;
    function Probe() {
      renders++;
      // Fresh object per render (the ControlProvider bug's shape) for the first
      // 60 renders, then stable so the loop terminates and the test can assert.
      const dep = renders < 60 ? { fresh: renders } : STABLE_DEP;
      useNodesComputed(() => null, [dep]);
      return null;
    }
    render(<Probe />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // The loop is real: the component re-rendered far more than the ~2 renders
    // a stable dep costs, purely because the selector was rebuilt each time.
    expect(renders).toBeGreaterThan(25);
    expect(traceError).toHaveBeenCalledWith(
      'node-family:selector-rebuilt-every-render',
      expect.any(Error),
    );
  });
});
