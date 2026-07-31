import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { canvasInteractingAtom } from '@/code/stores/store';
import { initMutationQueue, queueMutation, getCurrentCode } from './mutation-queue';

// FPS: while a slider/drag is live (`canvasInteractingAtom`), the expensive
// `updateScrollAnim` regen must be DEFERRED (held, coalesced to the latest per
// node) and applied ONCE the interaction ends — otherwise every tick reparses
// the file + cascades a full re-render. When NOT interacting, it applies live.

const SCROLL_CODE = `import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="cube" style={{ position: 'absolute' }} />
    </div>
  );
}`;

const cfg = (rotate: string) =>
  ({
    nodeId: 'cube',
    trigger: 'onScroll' as const,
    stops: [{ progress: 0, props: { rotate } }, { progress: 1, props: { rotate: '0' } }],
  });

describe('mutation-queue — defer updateScrollAnim during interaction', () => {
  const store = getDefaultStore();
  let rafCbs: FrameRequestCallback[];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;

  const realIdle = globalThis.requestIdleCallback;
  const realCancelIdle = globalThis.cancelIdleCallback;

  beforeEach(() => {
    rafCbs = [];
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    // The store-flush (and `isProcessing = false`) runs inside requestIdleCallback —
    // fire it synchronously so the queue is reusable between assertions.
    globalThis.requestIdleCallback = ((cb: IdleRequestCallback) => { cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline); return 0; }) as typeof requestIdleCallback;
    globalThis.cancelIdleCallback = (() => {}) as typeof cancelIdleCallback;
    store.set(canvasInteractingAtom, false);
    initMutationQueue(SCROLL_CODE, () => {}, () => {}, () => {});
  });
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
    globalThis.requestIdleCallback = realIdle;
    globalThis.cancelIdleCallback = realCancelIdle;
    store.set(canvasInteractingAtom, false);
  });

  // Drain pending RAF callbacks (each may schedule the next generation).
  const pump = (n = 1) => { for (let i = 0; i < n; i++) { const cbs = rafCbs; rafCbs = []; cbs.forEach((cb) => cb(0)); } };
  const settle = () => { for (let i = 0; i < 6 && !getCurrentCode().includes('useTransform'); i++) pump(); };
  const settleUntil = (s: string) => { for (let i = 0; i < 6 && !getCurrentCode().includes(s); i++) pump(); };

  it('applies updateScrollAnim immediately when NOT interacting', () => {
    queueMutation({ type: 'updateScrollAnim', config: cfg('45') });
    pump();
    expect(getCurrentCode()).toContain('useTransform');
    expect(getCurrentCode()).toContain('[45, 0]');
  });

  it('holds the regen while interacting, applies the LATEST once on release', () => {
    store.set(canvasInteractingAtom, true);

    queueMutation({ type: 'updateScrollAnim', config: cfg('30') });
    queueMutation({ type: 'updateScrollAnim', config: cfg('115') });
    pump(); // processQueue → both deferred + coalesced to the latest, no apply

    expect(getCurrentCode()).not.toContain('useTransform'); // nothing committed mid-drag

    store.set(canvasInteractingAtom, false); // release
    settle();

    expect(getCurrentCode()).toContain('useTransform');
    expect(getCurrentCode()).toContain('[115, 0]');  // latest value won
    expect(getCurrentCode()).not.toContain('[30, 0]'); // intermediate dropped (coalesced)
  });

  it('still applies non-scroll mutations live during interaction', () => {
    store.set(canvasInteractingAtom, true);
    queueMutation({ type: 'updateStyles', nodeId: 'cube', styles: { left: '42px' } });
    pump();
    expect(getCurrentCode()).toContain('42px'); // non-scroll edit lands live, even mid-drag
  });

  // The defer is generalized to all slider-driven animation regens — hover/tap
  // (updateMotionProp) is the same story as scroll, and must coalesce per propName.
  it('defers a hover (updateMotionProp) regen while dragging, applies on release', () => {
    store.set(canvasInteractingAtom, true);
    queueMutation({ type: 'updateMotionProp', nodeId: 'cube', propName: 'whileHover', props: { opacity: '0.5' } });
    pump();
    expect(getCurrentCode()).not.toContain('whileHover'); // held mid-drag

    store.set(canvasInteractingAtom, false);
    settleUntil('whileHover');
    expect(getCurrentCode()).toContain('whileHover');
  });

  it('coalesces repeated hover ticks to the latest value', () => {
    store.set(canvasInteractingAtom, true);
    queueMutation({ type: 'updateMotionProp', nodeId: 'cube', propName: 'whileHover', props: { rotate: '20' } });
    queueMutation({ type: 'updateMotionProp', nodeId: 'cube', propName: 'whileHover', props: { rotate: '90' } });
    pump();
    store.set(canvasInteractingAtom, false);
    settleUntil('whileHover');
    expect(getCurrentCode()).toContain('90');
    expect(getCurrentCode()).not.toContain('20'); // intermediate dropped
  });

  it('does NOT coalesce different propNames — hover and tap both survive', () => {
    store.set(canvasInteractingAtom, true);
    queueMutation({ type: 'updateMotionProp', nodeId: 'cube', propName: 'whileHover', props: { opacity: '0.4' } });
    queueMutation({ type: 'updateMotionProp', nodeId: 'cube', propName: 'whileTap', props: { scale: '0.9' } });
    pump();
    store.set(canvasInteractingAtom, false);
    settleUntil('whileTap');
    expect(getCurrentCode()).toContain('whileHover'); // distinct coalesce keys → both kept
    expect(getCurrentCode()).toContain('whileTap');
  });
});
