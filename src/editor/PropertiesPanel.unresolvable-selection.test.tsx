import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import React from 'react';

// End-to-end guard on the SYMPTOM the user saw: drag an absolute node out of a
// design-component REPLICA VARIANT and the canvas freezes + the right panel
// goes blank until mouseup. The variant-exit path (AbsoluteInFrameStrategy)
// selects a CLONE whose `addCanvasNode` mutation is still queued, so for the
// rest of the drag the selected id resolves to nothing and the panel renders
// its empty shell. That state is legitimate — but it used to cost ~9,600
// renders in 900ms (measured: `properties-panel:unresolvable-selection-shell`
// was 9,630 of 14,038 trace entries in the saved repro), which starved the drag
// loop. It must cost O(1). Root cause + mechanism live in
// ControlProvider.unresolved-selection.test.tsx and node-family-loop.test.tsx.
//
// Real `trace` on purpose: the trace entry IS the render counter here. It also
// doubles as the circuit breaker — a regressed loop never lets `act()` settle,
// so without a cap this test would hang the worker instead of failing.
describe('PropertiesPanel — unresolvable selection renders once', () => {
  it('does not storm the shell branch when the selected id is not in the node map', async () => {
    const { trace } = await import('@/shared/debug-trace');
    const { codeAtom, selectedIdsAtom } = await import('@/code/stores/store');
    const PropertiesPanel = (await import('./PropertiesPanel')).default;

    const store = createStore();
    store.set(codeAtom, `'use client';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <div data-id="a" data-name="A" style={{ position: 'absolute', left: '10px' }}></div>
    </div>
  );
}`);
    // The shape a component-variant exit leaves behind: a clone id that no
    // parse has produced yet.
    store.set(selectedIdsAtom, ['detach-clone-not-yet-parsed']);

    let shellRenders = 0;
    const realAction = trace.action.bind(trace);
    trace.action = ((category: string, data?: unknown) => {
      if (category === 'properties-panel:unresolvable-selection-shell') {
        shellRenders++;
        if (shellRenders > 50) throw new Error(`render loop: shell rendered ${shellRenders}x`);
      }
      realAction(category, data);
    }) as typeof trace.action;

    let thrown: unknown = null;
    try {
      render(
        <Provider store={store}>
          <PropertiesPanel />
        </Provider>,
      );
      await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    } catch (err) {
      thrown = err;
    } finally {
      trace.action = realAction;
    }

    expect(thrown).toBeNull();
    expect(shellRenders).toBeGreaterThan(0);    // it IS the shell branch
    expect(shellRenders).toBeLessThanOrEqual(4); // …and it settles
    // Generous timeout: mounting the real panel pulls in the ENTIRE tool stack
    // (~40 modules), which costs a few seconds of transform under a parallel
    // suite run. The assertions themselves settle in ~100ms.
  }, 30_000);
});
