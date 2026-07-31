// modify-file.test.ts — Tests for modifyProjectFile safe read-modify-write pipeline.

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('./project-fs', () => ({
  projectFS: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    listFiles: vi.fn(() => []),
    exists: vi.fn(() => false),
  },
}));

vi.mock('../mutation/mutation-queue', () => ({
  syncQueueCode: vi.fn(),
  flushNow: vi.fn(),
  queueMutation: vi.fn(),
  // modifyProjectFile now runs the framework auto-import pass on every
  // CHANGED .tsx/.jsx result (step 4 in modify-file.ts) — identity stub.
  syncImports: vi.fn((code: string) => code),
  // Gesture-window coherence (2026-07-28): queue-as-truth + stash supersede.
  getCurrentCode: vi.fn(() => ''),
  refreshDeferredFlushWithExternalWrite: vi.fn(),
}));

import { modifyProjectFile, setBumpVersion } from './modify-file';
import { projectFS } from './project-fs';
import { syncQueueCode, flushNow, syncImports, getCurrentCode, refreshDeferredFlushWithExternalWrite } from '../mutation/mutation-queue';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from './active-file-store';

const mockFS = vi.mocked(projectFS);
const mockSyncQueueCode = vi.mocked(syncQueueCode);
const mockFlushNow = vi.mocked(flushNow);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('modifyProjectFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset bump version to null so tests are independent
    setBumpVersion(() => {});
  });

  test('applies transform to current file content and writes result', () => {
    const originalCode = '<div data-id="root">Hello</div>';
    const expectedCode = '<div data-id="root">World</div>';

    mockFS.readFile.mockReturnValue(originalCode);

    const result = modifyProjectFile('app/page.tsx', (code) =>
      code.replace('Hello', 'World'),
    );

    expect(result).toBe(expectedCode);
    expect(mockFS.writeFile).toHaveBeenCalledWith('app/page.tsx', expectedCode);
    // Changed .tsx results pass through syncImports (auto-import pass) before the write.
    expect(syncImports).toHaveBeenCalledWith(expectedCode);
  });

  test('flushes mutation queue before reading', () => {
    const code = '<div>content</div>';

    const callOrder: string[] = [];
    mockFS.readFile.mockImplementation(() => {
      callOrder.push('readFile');
      return code;
    });
    mockSyncQueueCode.mockImplementation(() => callOrder.push('syncQueueCode'));
    mockFlushNow.mockImplementation(() => callOrder.push('flushNow'));

    // Queue sync is gated on filePath === activeFilePath ('app/page.client.tsx'
    // by default since the page-pair migration) — non-active files flush but
    // never touch the queue's currentCode. Use the active page path.
    modifyProjectFile('app/page.client.tsx', (c) => c + '!');

    // Pipeline: read (pre-flush) -> sync -> flush -> read (post-flush) -> transform -> write -> read -> sync
    expect(callOrder[0]).toBe('readFile');       // pre-flush read
    expect(callOrder[1]).toBe('syncQueueCode');  // sync queue
    expect(callOrder[2]).toBe('flushNow');       // flush
    expect(callOrder[3]).toBe('readFile');       // post-flush read (fresh code)
  });

  test('does not write when transform returns same code (no-op)', () => {
    const code = '<div>unchanged</div>';
    mockFS.readFile.mockReturnValue(code);

    const result = modifyProjectFile('app/page.tsx', (c) => c);

    expect(result).toBe(code);
    expect(mockFS.writeFile).not.toHaveBeenCalled();
  });

  test('calls version bump after writing changed code', () => {
    const bumpFn = vi.fn();
    setBumpVersion(bumpFn);

    mockFS.readFile.mockReturnValue('<div>old</div>');

    modifyProjectFile('app/page.tsx', () => '<div>new</div>');

    expect(bumpFn).toHaveBeenCalledTimes(1);
  });

  test('does not call version bump for no-op transforms', () => {
    const bumpFn = vi.fn();
    setBumpVersion(bumpFn);

    const code = '<div>same</div>';
    mockFS.readFile.mockReturnValue(code);

    modifyProjectFile('app/page.tsx', (c) => c);

    expect(bumpFn).not.toHaveBeenCalled();
  });

  test('returns null when file does not exist', () => {
    mockFS.readFile.mockReturnValue(null);

    const result = modifyProjectFile('missing.tsx', (c) => c + '!');

    expect(result).toBeNull();
    expect(mockFS.writeFile).not.toHaveBeenCalled();
  });

  test('syncs queue to new code after write', () => {
    let callCount = 0;
    mockFS.readFile.mockImplementation(() => {
      callCount++;
      // First two calls return original, third (after write) returns transformed
      if (callCount <= 2) return '<div>original</div>';
      return '<div>transformed</div>';
    });

    // Must be the ACTIVE file — queue sync only runs when filePath === activeFilePath.
    modifyProjectFile('app/page.client.tsx', () => '<div>transformed</div>');

    // syncQueueCode should be called twice:
    // 1. Before flush (with pre-flush code)
    // 2. After write (with fresh code)
    expect(mockSyncQueueCode).toHaveBeenCalledTimes(2);
    // The second sync should be with the fresh post-write code
    expect(mockSyncQueueCode).toHaveBeenLastCalledWith('<div>transformed</div>');
  });

  test('returns null when transform throws an error', () => {
    mockFS.readFile.mockReturnValue('<div>code</div>');

    const result = modifyProjectFile('app/page.tsx', () => {
      throw new Error('transform broke');
    });

    expect(result).toBeNull();
    expect(mockFS.writeFile).not.toHaveBeenCalled();
  });
});

// ─── Gesture-window write coherence (2026-07-28) ─────────────────────────────
// During a drag/resize the deferred-drag-flush stashes the setCode fan-out —
// ProjectFS LAGS the queue. modifyProjectFile used to seed the queue BACKWARDS
// from the stale FS (throwing away applied mutations: the svg resize bake) and
// its result was later clobbered by the stale stash (resize reverted, drag
// flashed). Now: queue is truth in the window, FS reconciled up before the
// transaction, and the result is routed back through the flush channel.
describe('modifyProjectFile — gesture window (dragState active)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBumpVersion(() => {});
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  test('reconciles FS up from the queue and does NOT seed the queue backwards', () => {
    dragStateOps.set(true);
    try {
      const staleFs = '<div data-id="root">stale</div>';
      const queueFresh = '<div data-id="root">fresh-from-queue</div>';
      let fsContent = staleFs;
      mockFS.readFile.mockImplementation(() => fsContent);
      mockFS.writeFile.mockImplementation((_p: string, c: string) => { fsContent = c; });
      vi.mocked(getCurrentCode).mockReturnValue(queueFresh);

      const result = modifyProjectFile('app/page.client.tsx', (code) => code.replace('fresh-from-queue', 'transformed'));

      // Backward seed skipped — the stale FS never overwrote the queue.
      expect(mockSyncQueueCode).not.toHaveBeenCalledWith(staleFs);
      // The transaction ran on the QUEUE's code (reconciled into FS first).
      expect(result).toBe('<div data-id="root">transformed</div>');
      expect(fsContent).toBe('<div data-id="root">transformed</div>');
      // The fresh result superseded the deferred stash.
      expect(vi.mocked(refreshDeferredFlushWithExternalWrite)).toHaveBeenCalledWith('<div data-id="root">transformed</div>');
    } finally {
      dragStateOps.set(false);
    }
  });

  test('outside a gesture the legacy order is unchanged (FS seeds the queue)', () => {
    const fsCode = '<div data-id="root">a</div>';
    mockFS.readFile.mockReturnValue(fsCode);
    modifyProjectFile('app/page.client.tsx', (code) => code.replace('a', 'b'));
    expect(mockSyncQueueCode).toHaveBeenCalledWith(fsCode);
  });
});
