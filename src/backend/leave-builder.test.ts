// leave-builder.test.ts — an in-app exit must not hand the user a browser
// "Leave site?" dialog.
//
// User report 2026-08-08: the dialog appeared on EVERY way out of the builder,
// including "Go to Dashboard". The exits called `flushNow()` — the mutation
// queue flush — which commits the edit into projectFS and marks the project
// dirty. That is precisely the state autosave's beforeunload guard watches for,
// so the guard fired on the way out every single time.
//
// The fix is not to silence the guard: it's the last line of defence against
// losing a Figma import, and reload / tab-close still need it. It's to actually
// SAVE before leaving, so there is nothing pending left to warn about.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const flushNow = vi.fn();
const flushSaveNow = vi.fn(async () => {});
const traceError = vi.fn();

vi.mock('@/code/mutation/mutation-queue', () => ({ flushNow: () => flushNow() }));
vi.mock('./autosave', () => ({ flushSaveNow: () => flushSaveNow() }));
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: (...a: unknown[]) => traceError(...a) },
}));

import { leaveBuilderTo } from './leave-builder';

let href = '';
beforeEach(() => {
  flushNow.mockClear();
  flushSaveNow.mockClear().mockResolvedValue(undefined);
  traceError.mockClear();
  href = '';
  Object.defineProperty(window, 'location', {
    value: { get href() { return href; }, set href(v: string) { href = v; } },
    configurable: true, writable: true,
  });
});

describe('leaveBuilderTo', () => {
  it('flushes the mutation queue AND the save before navigating', async () => {
    await leaveBuilderTo('/dashboard', 'test');
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(flushSaveNow).toHaveBeenCalledTimes(1);
    expect(href).toBe('/dashboard');
  });

  it('does not navigate until the save has resolved', async () => {
    // THE BUG: the old exits fired the navigation synchronously after the
    // queue flush, so the page unloaded with the save still pending.
    let release!: () => void;
    flushSaveNow.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const nav = leaveBuilderTo('/dashboard', 'test');
    await Promise.resolve();
    expect(href).toBe('');          // still here…
    release();
    await nav;
    expect(href).toBe('/dashboard'); // …and only now
  });

  it('queue flush happens BEFORE the save, not alongside it', async () => {
    const order: string[] = [];
    flushNow.mockImplementation(() => { order.push('queue'); });
    flushSaveNow.mockImplementation(async () => { order.push('save'); });
    await leaveBuilderTo('/dashboard', 'test');
    // Reversed, the save would ship a snapshot taken before the last edit.
    expect(order).toEqual(['queue', 'save']);
  });

  it('still leaves when the save fails — never traps the user in a dead project', async () => {
    flushSaveNow.mockRejectedValue(new Error('offline'));
    await leaveBuilderTo('/dashboard', 'test');
    expect(href).toBe('/dashboard');
    expect(traceError).toHaveBeenCalled();
  });

  it('carries the full URL including query params', async () => {
    await leaveBuilderTo('/dashboard?ws=abc&view=settings:account', 'account');
    expect(href).toBe('/dashboard?ws=abc&view=settings:account');
  });
});
