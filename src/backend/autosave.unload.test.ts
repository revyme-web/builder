// autosave.unload.test.ts — the unload safety net and failure retry.
//
// A hard navigation (dashboard is the separate cloud app) is a full page
// unload: the debounced fetch PUT dies with the page, and sendBeacon has a
// ~64KB quota — any real project overflows it and sendBeacon returns false
// WITHOUT sending. The unload path must therefore (a) act even while a save
// is in flight (that fetch is about to be cancelled), and (b) fall back to
// the native leave-confirmation when the beacon can't carry the payload —
// the "imported from Figma, went to dashboard, came back blank" loss
// (2026-08-07).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerAutosave, cancelPendingAutosave, setAutosaveHeld } from './autosave';
import { backend } from './index';

vi.mock('./index', () => ({
  backend: { saveProject: vi.fn(async () => {}) },
}));
vi.mock('./project-id', () => ({
  getProjectId: () => 'site-1',
}));
vi.mock('@/shared/cloud-flag', () => ({ CLOUD_ENABLED: true }));

const sendBeacon = vi.fn(() => true);
Object.defineProperty(navigator, 'sendBeacon', {
  value: sendBeacon, configurable: true, writable: true,
});

function fireBeforeUnload(): Event {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(backend.saveProject).mockReset().mockResolvedValue(undefined);
  sendBeacon.mockReset().mockReturnValue(true);
});

afterEach(async () => {
  setAutosaveHeld(false);
  cancelPendingAutosave();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('beforeunload beacon', () => {
  it('beacon sent → no leave-confirmation dialog', () => {
    triggerAutosave(); // pendingSave, debounce not yet fired
    const e = fireBeforeUnload();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
  });

  it('beacon over quota (returns false) → native dialog + immediate save if the user stays', async () => {
    sendBeacon.mockReturnValue(false);
    triggerAutosave();
    const e = fireBeforeUnload();
    expect(e.defaultPrevented).toBe(true);
    // The user cancelled the navigation — the kicked save persists for real.
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.saveProject).toHaveBeenCalledTimes(1);
  });

  it('fires even while a save is IN FLIGHT (that fetch dies with the page)', async () => {
    let resolveSave: (() => void) | undefined;
    vi.mocked(backend.saveProject).mockImplementation(
      () => new Promise<void>((r) => { resolveSave = r; }),
    );
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(2000); // debounce fires → save starts, hangs
    expect(backend.saveProject).toHaveBeenCalledTimes(1);

    const e = fireBeforeUnload();
    expect(sendBeacon).toHaveBeenCalledTimes(1); // old code skipped here
    expect(e.defaultPrevented).toBe(false); // beacon carried it — no dialog

    resolveSave?.();
    await vi.advanceTimersByTimeAsync(1);
  });

  it('does nothing with no pending changes', () => {
    const e = fireBeforeUnload();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('failed-save retry', () => {
  it('a failed save auto-retries and succeeds', async () => {
    vi.mocked(backend.saveProject)
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValueOnce(undefined);
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(2000); // first attempt fails
    expect(backend.saveProject).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // retry lands
    expect(backend.saveProject).toHaveBeenCalledTimes(2);
  });

  it('retries are bounded — a permanently failing save stops after the budget', async () => {
    vi.mocked(backend.saveProject).mockRejectedValue(new Error('413'));
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(2000); // initial attempt
    await vi.advanceTimersByTimeAsync(60_000); // far past all retry windows
    // 1 initial + 3 retries, then silence.
    expect(backend.saveProject).toHaveBeenCalledTimes(4);
  });
});
