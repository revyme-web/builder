import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { createDeferredDragFlush } from './deferred-drag-flush';

// The flush fan-out (setCode → whole-file Babel re-parse → full sandbox
// re-render) must NOT run per mid-drag reparent flush — only once, with the
// LATEST code, when the gesture ends (the 8fps big-import drag find).

describe('createDeferredDragFlush', () => {
  it('applies immediately when no drag is in progress', () => {
    const apply = vi.fn();
    const d = createDeferredDragFlush({ isDragging: () => false, apply });
    d.onFlush('code-1');
    expect(apply).toHaveBeenCalledExactlyOnceWith('code-1');
  });

  it('stashes mid-drag flushes and applies only the LATEST at drag end', () => {
    let dragging = true;
    const apply = vi.fn();
    const d = createDeferredDragFlush({ isDragging: () => dragging, apply });
    d.onFlush('enter-commit');
    d.onFlush('exit-commit');
    d.onFlush('final-move-commit');
    expect(apply).not.toHaveBeenCalled();
    dragging = false;
    d.onDragEnd();
    expect(apply).toHaveBeenCalledExactlyOnceWith('final-move-commit');
  });

  it('drag end with nothing stashed is a no-op', () => {
    const apply = vi.fn();
    const d = createDeferredDragFlush({ isDragging: () => false, apply });
    d.onDragEnd();
    expect(apply).not.toHaveBeenCalled();
  });

  it('a post-drag flush supersedes a stale stash', () => {
    let dragging = true;
    const apply = vi.fn();
    const d = createDeferredDragFlush({ isDragging: () => dragging, apply });
    d.onFlush('mid-drag');
    dragging = false;
    d.onFlush('end-commit');
    expect(apply).toHaveBeenCalledExactlyOnceWith('end-commit');
    d.onDragEnd();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('flushPending applies the stash on teardown', () => {
    const apply = vi.fn();
    const d = createDeferredDragFlush({ isDragging: () => true, apply });
    d.onFlush('stashed');
    d.flushPending();
    expect(apply).toHaveBeenCalledExactlyOnceWith('stashed');
  });

  it('drag end routes the stash through deferApply when it accepts', () => {
    let dragging = true;
    const apply = vi.fn();
    const deferApply = vi.fn(() => true);
    const d = createDeferredDragFlush({ isDragging: () => dragging, apply, deferApply });
    d.onFlush('mid-drag-commit');
    dragging = false;
    d.onDragEnd();
    expect(deferApply).toHaveBeenCalledExactlyOnceWith('mid-drag-commit');
    expect(apply).not.toHaveBeenCalled();
    // The stash is consumed — a later teardown flush must not re-apply it.
    d.flushPending();
    expect(apply).not.toHaveBeenCalled();
  });

  it('drag end falls back to synchronous apply when deferApply declines', () => {
    let dragging = true;
    const apply = vi.fn();
    const deferApply = vi.fn(() => false);
    const d = createDeferredDragFlush({ isDragging: () => dragging, apply, deferApply });
    d.onFlush('mid-drag-commit');
    dragging = false;
    d.onDragEnd();
    expect(deferApply).toHaveBeenCalledExactlyOnceWith('mid-drag-commit');
    expect(apply).toHaveBeenCalledExactlyOnceWith('mid-drag-commit');
  });

  it('deferApply is not consulted when nothing is stashed', () => {
    const apply = vi.fn();
    const deferApply = vi.fn(() => true);
    const d = createDeferredDragFlush({ isDragging: () => false, apply, deferApply });
    d.onDragEnd();
    expect(deferApply).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});
