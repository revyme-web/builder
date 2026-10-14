// autosave.outcome.test.ts — a save that failed must SAY so.
//
// flushSaveNow() used to resolve the same way whether the PUT landed or not,
// so the MCP bridge answered `committed: true` for writes the backend had
// refused for two days (2026-10-14). And a stale tab's save — refused 409
// because another tab saved newer work — must stop, not retry into the wall.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import {
  cancelPendingAutosave, flushSaveNow, getSaveConflict, hasUnsavedChanges,
  overwriteAfterConflict, triggerAutosave,
} from './autosave';
import { backend } from './index';
import { saveStatusAtom } from './save-store';
import { SaveConflictError } from './types';
import { getBaseRevision, resetSaveRevisionForTest, setLoadedRevision } from './save-revision';

vi.mock('./index', () => ({
  backend: { saveProject: vi.fn(async () => {}) },
}));
vi.mock('./project-id', () => ({
  getProjectId: () => 'site-1',
}));

const save = backend.saveProject as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  resetSaveRevisionForTest();
});

afterEach(async () => {
  // Leave no conflict behind for the next test.
  save.mockImplementation(async () => {});
  if (getSaveConflict()) await overwriteAfterConflict();
  cancelPendingAutosave();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('save outcome', () => {
  it('a landed save reports ok', async () => {
    expect(await flushSaveNow()).toEqual({ ok: true });
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a failed save reports the reason, and the work counts as unsaved', async () => {
    save.mockRejectedValueOnce(new Error('Save failed: 500 Server has closed the connection'));
    const outcome = await flushSaveNow();
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('500');
    expect(hasUnsavedChanges()).toBe(true);
    expect(getDefaultStore().get(saveStatusAtom)).toBe('error');
  });
});

describe('save conflict (stale tab)', () => {
  it('a 409 stops saving: no retries, later edits do not hit the backend', async () => {
    setLoadedRevision(3);
    save.mockRejectedValueOnce(new SaveConflictError(7));
    const outcome = await flushSaveNow();
    expect(outcome).toMatchObject({ ok: false, conflict: true });
    expect(getDefaultStore().get(saveStatusAtom)).toBe('conflict');

    save.mockClear();
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(save).not.toHaveBeenCalled();
    expect(await flushSaveNow()).toMatchObject({ ok: false, conflict: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('overwrite — the user\'s explicit choice — saves against the row\'s current revision', async () => {
    setLoadedRevision(3);
    save.mockRejectedValueOnce(new SaveConflictError(7));
    await flushSaveNow();
    save.mockClear();
    expect(await overwriteAfterConflict()).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(getBaseRevision()).toBe(7);
    expect(getSaveConflict()).toBeNull();
  });
});

describe('save conflict that is only a race (two in-sync tabs)', () => {
  it('a 409 for an in-sync tab waits for the room\'s save event, adopts it and saves again', async () => {
    const rev = await import('./save-revision');
    rev.setLoadedRevision(3);
    rev.noteRoomJoined(3);
    save.mockRejectedValueOnce(new SaveConflictError(4));
    const pending = flushSaveNow();
    // The other tab's project-saved event arrives a moment later.
    await vi.advanceTimersByTimeAsync(200);
    rev.noteRemoteSaved(4, true);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(2);
    expect(getSaveConflict()).toBeNull();
  });
});
