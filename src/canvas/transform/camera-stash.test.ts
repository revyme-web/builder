import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cameraStash } from './camera-stash';

describe('cameraStash', () => {
  beforeEach(() => {
    cameraStash.clear();
  });

  it('returns null for an unknown file path', () => {
    expect(cameraStash.get('app/missing.tsx')).toBeNull();
  });

  it('stores and returns a transform for a file', () => {
    cameraStash.save('app/page.tsx', { x: 100, y: 200, scale: 1.5 });
    expect(cameraStash.get('app/page.tsx')).toEqual({ x: 100, y: 200, scale: 1.5 });
  });

  it('overwrites an existing entry on re-save', () => {
    cameraStash.save('app/page.tsx', { x: 1, y: 1, scale: 1 });
    cameraStash.save('app/page.tsx', { x: 9, y: 9, scale: 2 });
    expect(cameraStash.get('app/page.tsx')).toEqual({ x: 9, y: 9, scale: 2 });
  });

  it('isolates entries between different files', () => {
    cameraStash.save('app/page.tsx', { x: 1, y: 1, scale: 1 });
    cameraStash.save('app/other.tsx', { x: 99, y: 99, scale: 3 });
    expect(cameraStash.get('app/page.tsx')).toEqual({ x: 1, y: 1, scale: 1 });
    expect(cameraStash.get('app/other.tsx')).toEqual({ x: 99, y: 99, scale: 3 });
  });

  it('drops a single file via forget', () => {
    cameraStash.save('app/page.tsx', { x: 1, y: 1, scale: 1 });
    cameraStash.save('app/keep.tsx', { x: 9, y: 9, scale: 2 });
    cameraStash.forget('app/page.tsx');
    expect(cameraStash.get('app/page.tsx')).toBeNull();
    expect(cameraStash.get('app/keep.tsx')).toEqual({ x: 9, y: 9, scale: 2 });
  });

  it('returns a fresh object so callers can\'t mutate the stash', () => {
    cameraStash.save('app/page.tsx', { x: 5, y: 5, scale: 1 });
    const t1 = cameraStash.get('app/page.tsx')!;
    t1.x = 999; // accidental write
    const t2 = cameraStash.get('app/page.tsx')!;
    expect(t2.x).toBe(5);
  });

  it('notifies subscribers on save / forget / clear', () => {
    const fn = vi.fn();
    const unsub = cameraStash.subscribe(fn);
    cameraStash.save('a.tsx', { x: 0, y: 0, scale: 1 });
    cameraStash.forget('a.tsx');
    cameraStash.save('b.tsx', { x: 1, y: 1, scale: 1 });
    cameraStash.clear();
    expect(fn).toHaveBeenCalledTimes(4);
    unsub();
    cameraStash.save('c.tsx', { x: 0, y: 0, scale: 1 });
    expect(fn).toHaveBeenCalledTimes(4); // no notify after unsub
  });

  it('does not notify when forgetting a missing key', () => {
    const fn = vi.fn();
    cameraStash.subscribe(fn);
    cameraStash.forget('never-existed.tsx');
    expect(fn).not.toHaveBeenCalled();
  });

  it('does not notify when clearing an already-empty stash', () => {
    const fn = vi.fn();
    cameraStash.subscribe(fn);
    cameraStash.clear();
    expect(fn).not.toHaveBeenCalled();
  });

  it('entries() returns every stashed camera as fresh [path, transform] pairs', () => {
    cameraStash.save('app/page.tsx', { x: 1, y: 2, scale: 1 });
    cameraStash.save('components/Hero.tsx', { x: 3, y: 4, scale: 2 });
    const entries = cameraStash.entries();
    expect(Object.fromEntries(entries)).toEqual({
      'app/page.tsx': { x: 1, y: 2, scale: 1 },
      'components/Hero.tsx': { x: 3, y: 4, scale: 2 },
    });
    // Fresh copies — mutating a returned entry doesn't corrupt the stash.
    entries[0][1].x = 999;
    expect(cameraStash.get('app/page.tsx')!.x).toBe(1);
  });
});
