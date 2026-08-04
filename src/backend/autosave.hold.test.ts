// autosave.hold.test.ts — the template-prompt hold: while held, triggers
// are deferred (no PUT reaches the backend, keeping a fresh website's row
// empty for remix-into); releasing the hold re-schedules the deferred save.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triggerAutosave, setAutosaveHeld, cancelPendingAutosave } from './autosave';
import { backend } from './index';

vi.mock('./index', () => ({
  backend: { saveProject: vi.fn(async () => {}) },
}));
vi.mock('./project-id', () => ({
  getProjectId: () => 'site-1',
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain any pending debounce and reset module state between tests.
  setAutosaveHeld(false);
  cancelPendingAutosave();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('autosave hold (fresh-site template prompt)', () => {
  it('defers saves while held and does not hit the backend', async () => {
    setAutosaveHeld(true);
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.saveProject).not.toHaveBeenCalled();
  });

  it('release re-schedules the deferred save', async () => {
    setAutosaveHeld(true);
    triggerAutosave();
    setAutosaveHeld(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.saveProject).toHaveBeenCalledTimes(1);
  });

  it('release without a deferred save schedules nothing', async () => {
    setAutosaveHeld(true);
    setAutosaveHeld(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.saveProject).not.toHaveBeenCalled();
  });
});
