// DOM-settle observer — any subtree mutation after the render must re-arm the
// debounced remeasure so overlays recalc WITHOUT a camera move (the
// "drag from canvas into viewport breaks every overlay until I pan" find:
// framer-motion layout glides settle AFTER the render-time measure).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { startSettleObserver, scheduleRemeasureAllRects } from './rect-emit';
import { setContentRoot } from './sandbox-state';
import { setSandboxDndInteracting } from '../sandbox-dnd-host';
import { trace } from '@/shared/debug-trace';

function flushObserver(): Promise<void> {
  // MutationObserver callbacks are microtasks — one macrotask hop drains them.
  return new Promise((r) => setTimeout(r, 0));
}

describe('startSettleObserver', () => {
  let root: HTMLElement;
  let child: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    child = document.createElement('div');
    child.setAttribute('data-node-id', 'desktop-a');
    root.appendChild(child);
    document.body.appendChild(root);
    setContentRoot(root);
    setSandboxDndInteracting(false);
    startSettleObserver();
  });

  it('a style mutation schedules a remeasure once the DOM goes quiet', async () => {
    const spy = vi.spyOn(trace, 'action');
    child.style.transform = 'translateX(10px)';
    await flushObserver();
    // The debounced timer (150ms) + rAF land the sweep.
    await new Promise((r) => setTimeout(r, 220));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const swept = spy.mock.calls.some(([cat]) => cat === 'sandbox:remeasure-all-rects');
    spy.mockRestore();
    expect(swept).toBe(true);
  });

  it('mid-drag mutations do not schedule (gesture-end reconcile owns it)', async () => {
    setSandboxDndInteracting(true);
    const spy = vi.spyOn(trace, 'action');
    child.style.transform = 'translateX(20px)';
    await flushObserver();
    await new Promise((r) => setTimeout(r, 220));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const swept = spy.mock.calls.some(([cat]) => cat === 'sandbox:remeasure-all-rects');
    spy.mockRestore();
    setSandboxDndInteracting(false);
    expect(swept).toBe(false);
  });

  it('culling attribute flips are ignored (no self-triggered loop)', async () => {
    const spy = vi.spyOn(trace, 'action');
    child.setAttribute('data-culled', 'true');
    child.style.display = 'none';
    await flushObserver();
    await new Promise((r) => setTimeout(r, 220));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const swept = spy.mock.calls.some(([cat]) => cat === 'sandbox:remeasure-all-rects');
    spy.mockRestore();
    expect(swept).toBe(false);
  });
});
