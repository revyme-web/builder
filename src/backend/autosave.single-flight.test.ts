// autosave.single-flight.test.ts — one tab must never race its own saves.
//
// A 51 MB project takes seconds to encode and upload. Saves were started
// whenever asked — the 2s debounce timer, every bridge write's flushSaveNow,
// the retry timer — so two of the SAME tab's saves were in flight at once,
// both based on the same row revision. The first landed and bumped the
// revision; the backend refused the second as a stale tab (409), the single
// raced-retry raced again, and the tab latched "saved from another tab or
// device" with no other tab open. Every MCP write after that was lost on
// reload (customer report, 2026-10-30: 17 refusals in one afternoon, each
// base exactly one behind).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelPendingAutosave, flushSaveNow, getSaveConflict, overwriteAfterConflict, triggerAutosave,
} from './autosave';
import { backend } from './index';
import { SaveConflictError } from './types';
import { getBaseRevision, noteSaved, resetSaveRevisionForTest, setLoadedRevision } from './save-revision';

vi.mock('./index', () => ({
  backend: { saveProject: vi.fn(async () => {}) },
}));
vi.mock('./project-id', () => ({
  getProjectId: () => 'site-1',
}));

const save = backend.saveProject as unknown as ReturnType<typeof vi.fn>;

/** The backend's optimistic concurrency, with a slow upload: the base is read
 *  when the save starts (as RevymeBackend.saveProject does) and checked when
 *  the request lands. */
function slowServer(startRevision: number, uploadMs: number) {
  let revision = startRevision;
  let inFlight = 0;
  let maxInFlight = 0;
  save.mockImplementation(async () => {
    const base = getBaseRevision();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, uploadMs));
      if (base !== revision) throw new SaveConflictError(revision);
      revision++;
      noteSaved(revision);
    } finally {
      inFlight--;
    }
  });
  return { get maxInFlight() { return maxInFlight; }, get revision() { return revision; } };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSaveRevisionForTest();
});

afterEach(async () => {
  save.mockImplementation(async () => {});
  if (getSaveConflict()) await overwriteAfterConflict();
  cancelPendingAutosave();
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('saves from one tab are single-flight', () => {
  it('a debounced save that comes due while a save is uploading waits for it', async () => {
    setLoadedRevision(10);
    const server = slowServer(10, 5_000);
    const first = flushSaveNow();
    // An edit lands while the first save uploads; its 2s debounce comes due
    // long before the upload finishes.
    await vi.advanceTimersByTimeAsync(500);
    triggerAutosave();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toEqual({ ok: true });
    expect(server.maxInFlight).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(getSaveConflict()).toBeNull();
    expect(server.revision).toBe(12);
  });

  it('parallel flushes during an upload coalesce into ONE follow-up save', async () => {
    setLoadedRevision(10);
    const server = slowServer(10, 5_000);
    const first = flushSaveNow();
    await vi.advanceTimersByTimeAsync(100);
    // Parallel agent tool calls each await their own flush.
    const parallel = [flushSaveNow(), flushSaveNow(), flushSaveNow()];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toEqual({ ok: true });
    for (const p of parallel) expect(await p).toEqual({ ok: true });
    expect(server.maxInFlight).toBe(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(getSaveConflict()).toBeNull();
  });

  it('a flush asked for during an upload is answered by a save that started after it', async () => {
    setLoadedRevision(10);
    slowServer(10, 5_000);
    const first = flushSaveNow();
    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    const second = flushSaveNow().then((o) => { settled = true; return o; });
    // The first upload finishing must not answer the second flush: its
    // snapshot predates whatever the second caller just wrote.
    await vi.advanceTimersByTimeAsync(5_000);
    await first;
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toEqual({ ok: true });
  });

  it('a burst of edits, debounces and flushes never latches a conflict', async () => {
    setLoadedRevision(2740);
    const server = slowServer(2740, 3_000);
    const asked: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      triggerAutosave();
      if (i % 3 === 0) asked.push(flushSaveNow());
      await vi.advanceTimersByTimeAsync(2_100);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    for (const p of asked) expect(await p).toEqual({ ok: true });
    expect(server.maxInFlight).toBe(1);
    expect(getSaveConflict()).toBeNull();
  });
});
