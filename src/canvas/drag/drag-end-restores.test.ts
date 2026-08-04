// drag-end-restores.test.ts — whole-gesture restore registry semantics.
// A mid-drag strategy handoff registers restores here; the DragCoordinator's
// drag-end reset runs them exactly once.

import { describe, it, expect, vi } from 'vitest';
import { registerDragEndRestore, runDragEndRestores } from './drag-end-restores';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

describe('drag-end restores', () => {
  it('runs each registered restore exactly once and clears the registry', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerDragEndRestore(a);
    registerDragEndRestore(b);
    runDragEndRestores();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    runDragEndRestores(); // second drag-end: nothing left
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('a throwing restore does not block the others', () => {
    const ok = vi.fn();
    registerDragEndRestore(() => { throw new Error('boom'); });
    registerDragEndRestore(ok);
    expect(() => runDragEndRestores()).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('running with nothing registered is a no-op', () => {
    expect(() => runDragEndRestores()).not.toThrow();
  });
});
