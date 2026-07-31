// local-backend.test.ts — Verifies the localStorage-backed adapter satisfies
// the ProjectBackend contract. Each test uses a fresh in-memory localStorage.
// (Auth flows and the websites index moved out of ProjectBackend — the
// dashboard owns those in cloud mode; local mode has a single project.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from './local-backend';
import { PROJECT_FORMAT } from './types';

class MemStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(k: string) {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  key(i: number) {
    return Array.from(this.store.keys())[i] ?? null;
  }
}

describe('LocalBackend', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemStorage());
    backend = new LocalBackend();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ─── Session ──────────────────────────────────────────────────────────────

  it('returns the local user from getUser()', async () => {
    const user = await backend.getUser();
    expect(user?.id).toBe('local');
  });

  // ─── Project load/save ────────────────────────────────────────────────────

  it('round-trips a project snapshot', async () => {
    const data = {
      format: PROJECT_FORMAT,
      files: { 'app/page.tsx': 'a', 'components/X.tsx': 'b' },
    };
    await backend.saveProject('local', data);
    expect(await backend.loadProject('local')).toEqual(data);
  });

  it('returns null for a missing project', async () => {
    expect(await backend.loadProject('missing')).toBeNull();
  });

  it('rejects snapshots with the wrong format tag', async () => {
    localStorage.setItem(
      'revyme-project-local',
      JSON.stringify({ format: 'old-format', files: {} }),
    );
    expect(await backend.loadProject('local')).toBeNull();
  });

  // ─── Format tag: current + legacy ──────────────────────────────────────────
  // The stored tag was renamed canvas-poc-v1 -> revyme-v1 and the data was
  // migrated in place. Reads must still accept the legacy tag so a blob that
  // predates the migration (old export, hand-restored backup) still hydrates
  // rather than silently loading as an empty project.

  it('saves with the current format tag', async () => {
    await backend.saveProject('local', {
      format: PROJECT_FORMAT,
      files: { 'app/page.tsx': 'a' },
    });
    const raw = JSON.parse(localStorage.getItem('revyme-project-local')!);
    expect(raw.format).toBe('revyme-v1');
  });

  it.each([['revyme-v1'], ['canvas-poc-v1']])(
    'loads a snapshot tagged %s',
    async (tag) => {
      localStorage.setItem(
        'revyme-project-local',
        JSON.stringify({ format: tag, files: { 'app/page.tsx': 'hello' } }),
      );
      const loaded = await backend.loadProject('local');
      expect(loaded).not.toBeNull();
      expect(loaded!.files['app/page.tsx']).toBe('hello');
    },
  );

  it('returns null for corrupt (non-JSON) snapshots instead of throwing', async () => {
    localStorage.setItem('revyme-project-local', 'not json {');
    expect(await backend.loadProject('local')).toBeNull();
  });

  // ─── Cloud-shaped methods degrade gracefully in local mode ────────────────

  it('renameWebsite is a no-op (chip localStorage is the source of truth)', async () => {
    await expect(backend.renameWebsite('local', 'New Name')).resolves.toBeUndefined();
  });

  it('getWebsiteName returns null so the chip name is not overridden', async () => {
    expect(await backend.getWebsiteName('local')).toBeNull();
  });

  it('always reports the owner role', async () => {
    expect(await backend.getWebsiteRole('local')).toBe('owner');
  });

  it('has no workspace, credits, or workspace fonts', async () => {
    expect(await backend.getWebsiteWorkspaceId('local')).toBeNull();
    expect(await backend.getCredits('any')).toBeNull();
    expect(await backend.listWorkspaceFonts('any')).toEqual([]);
  });

  // ─── Assets ───────────────────────────────────────────────────────────────

  it('uploadAsset returns a data: URL that survives reloads (not blob:)', async () => {
    const file = new File(['hello'], 'a.txt', { type: 'text/plain' });
    const url = await backend.uploadAsset('local', file);
    expect(url.startsWith('data:')).toBe(true);
    expect(atob(url.split(',')[1])).toBe('hello');
  });
});

// flushSaveNow — publish-path save flush. A publish clicked inside the 2s
// autosave debounce must NOT deploy the previous save: flushSaveNow cancels
// the debounce, awaits any in-flight save (whose snapshot predates the
// newest edit), then saves unconditionally.
import { describe as _fd, it as _fit, expect as _fe, vi as _fvi } from 'vitest';
import { triggerAutosave, flushSaveNow } from './autosave';
import { backend as _backend } from './index';
import { projectFS as _pfs } from '../code/project/project-fs';

_fd('flushSaveNow', () => {
  // The autosave guard drops cloud saves whose project id never resolved
  // ('local' in a CLOUD_ENABLED session = a half-booted or zombie client).
  // These tests exercise the flush machinery itself, so run them as a
  // properly-booted builder session.
  beforeEach(() => window.history.replaceState(null, '', '/builder/test-site'));

  _fit('cancels the debounce and persists the CURRENT snapshot before resolving', async () => {
    const calls: Array<Record<string, string>> = [];
    const spy = _fvi.spyOn(_backend, 'saveProject').mockImplementation(async (_id, data) => {
      calls.push({ ...(data.files as Record<string, string>) });
    });
    try {
      _pfs.writeFile('app/x.tsx', 'v1');
      triggerAutosave();               // starts the 2s debounce
      _pfs.writeFile('app/x.tsx', 'v2'); // newest edit, still inside debounce
      await flushSaveNow();            // publish path
      _fe(calls.length).toBeGreaterThan(0);
      _fe(calls[calls.length - 1]['app/x.tsx']).toBe('v2');
    } finally {
      spy.mockRestore();
    }
  });

  _fit('waits out an in-flight save then saves again with the newer snapshot', async () => {
    const calls: string[] = [];
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let n = 0;
    const spy = _fvi.spyOn(_backend, 'saveProject').mockImplementation(async (_id, data) => {
      n++;
      if (n === 1) await gate; // first save hangs (snapshot = v1)
      calls.push((data.files as Record<string, string>)['app/y.tsx']);
    });
    try {
      _pfs.writeFile('app/y.tsx', 'v1');
      triggerAutosave();
      await _fvi.waitFor(() => {});
      // Fire the debounced save immediately by flushing — it snapshots v1 and hangs.
      const firstFlush = flushSaveNow();
      _pfs.writeFile('app/y.tsx', 'v2');
      releaseFirst();
      await firstFlush;
      // Now the publish-time flush must land v2.
      await flushSaveNow();
      _fe(calls[calls.length - 1]).toBe('v2');
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Regression: an unknown format tag must NEVER discard a real project ─────
// Rejecting on the tag made ProjectLoader seed an empty starter, which
// autosave then wrote back over the user's files. Two projects were lost to
// this. Files present = load it, whatever the tag says.
describe('LocalBackend — format tag is a hint, not a gate', () => {
  let backend: LocalBackend;
  beforeEach(() => { localStorage.clear(); backend = new LocalBackend(); });

  it('loads a project with an UNKNOWN format tag when it has files', async () => {
    localStorage.setItem('revyme-project-local', JSON.stringify({
      format: 'some-future-tag-v9',
      files: { 'app/page.tsx': 'real work' },
    }));
    const loaded = await backend.loadProject('local');
    expect(loaded).not.toBeNull();
    expect(loaded!.files['app/page.tsx']).toBe('real work');
  });

  it('loads a project with NO format tag at all when it has files', async () => {
    localStorage.setItem('revyme-project-local', JSON.stringify({
      files: { 'app/page.tsx': 'real work' },
    }));
    expect((await backend.loadProject('local'))!.files['app/page.tsx']).toBe('real work');
  });

  it('still returns null for a genuinely fileless row', async () => {
    localStorage.setItem('revyme-project-local', JSON.stringify({ format: 'revyme-v1', files: {} }));
    expect(await backend.loadProject('local')).toBeNull();
  });
});
