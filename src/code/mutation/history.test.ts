// history.test.ts — Tests for the ProjectFS-based undo/redo system.
// Tests the full cycle: push snapshots, undo restores files, redo re-applies.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { initHistory, pushHistory, pushHistoryImmediate, undo, redo, getHistoryState, syncHistoryCode, finishPendingRestore, sealPendingHistory, pushHistoryFileOp } from './history';

// Selection reselect + version bump are DEFERRED ~34ms after undo/redo
// (canvas-first restore — see finishPendingRestore in history.ts). Tests
// assert synchronously, so wrap undo/redo to apply the pending finish the
// way the timer does in the app.
const undoNow = (): boolean => { const r = undo(); finishPendingRestore(); return r; };
const redoNow = (): boolean => { const r = redo(); finishPendingRestore(); return r; };
import { projectFS } from '../project/project-fs';

describe('history', () => {
  let appliedCode: string | null;

  beforeEach(() => {
    vi.useFakeTimers();
    appliedCode = null;
    // Reset ProjectFS with a test file
    projectFS.loadSnapshot(new Map([['app/page.tsx', 'initial code']]));
    initHistory('initial code', (code) => { appliedCode = code; }, () => 'app/page.tsx');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('initial state: cannot undo or redo', () => {
    const state = getHistoryState();
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.undoSize).toBe(0);
    expect(state.redoSize).toBe(0);
  });

  test('pushHistoryImmediate adds to undo stack', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistoryImmediate('code v2');
    const state = getHistoryState();
    expect(state.canUndo).toBe(true);
    expect(state.undoSize).toBe(1);
    expect(state.canRedo).toBe(false);
  });

  test('undo restores previous file contents', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistoryImmediate('code v2');
    const result = undoNow();
    expect(result).toBe(true);
    expect(projectFS.readFile('app/page.tsx')).toBe('initial code');
    expect(getHistoryState().canUndo).toBe(false);
    expect(getHistoryState().canRedo).toBe(true);
  });

  test('redo restores next file contents', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistoryImmediate('code v2');
    undoNow();
    const result = redoNow();
    expect(result).toBe(true);
    expect(projectFS.readFile('app/page.tsx')).toBe('code v2');
    expect(getHistoryState().canUndo).toBe(true);
    expect(getHistoryState().canRedo).toBe(false);
  });

  test('undo returns false when stack is empty', () => {
    expect(undoNow()).toBe(false);
    expect(appliedCode).toBe(null);
  });

  test('redo returns false when stack is empty', () => {
    expect(redoNow()).toBe(false);
    expect(appliedCode).toBe(null);
  });

  test('new change after undo clears redo stack', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistoryImmediate('code v2');
    projectFS.writeFile('app/page.tsx', 'code v3');
    pushHistoryImmediate('code v3');
    undoNow(); // back to v2
    projectFS.writeFile('app/page.tsx', 'code v4');
    pushHistoryImmediate('code v4'); // branch — redo should be gone
    expect(getHistoryState().canRedo).toBe(false);
    expect(getHistoryState().undoSize).toBe(2); // initial + v2
  });

  test('pushHistoryImmediate skips when no files changed', () => {
    // Don't change any files
    pushHistoryImmediate('initial code');
    expect(getHistoryState().undoSize).toBe(0);
  });

  test('pushHistory is debounced — groups rapid changes', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistory('code v2');
    projectFS.writeFile('app/page.tsx', 'code v3');
    pushHistory('code v3');
    projectFS.writeFile('app/page.tsx', 'code v4');
    pushHistory('code v4');

    // Before debounce fires, undo stack should still be empty
    expect(getHistoryState().undoSize).toBe(0);

    // After debounce (300ms), only one entry (initial → v4)
    vi.advanceTimersByTime(350);
    expect(getHistoryState().undoSize).toBe(1);

    // Undo should go back to initial
    undoNow();
    expect(projectFS.readFile('app/page.tsx')).toBe('initial code');
  });

  test('pushHistory flushes pending on undo', () => {
    projectFS.writeFile('app/page.tsx', 'code v2');
    pushHistory('code v2');
    // Don't wait for debounce — undo should flush the pending change first
    undoNow();
    expect(projectFS.readFile('app/page.tsx')).toBe('initial code');
  });

  test('multiple undo/redo cycle', () => {
    projectFS.writeFile('app/page.tsx', 'v2');
    pushHistoryImmediate('v2');
    projectFS.writeFile('app/page.tsx', 'v3');
    pushHistoryImmediate('v3');
    projectFS.writeFile('app/page.tsx', 'v4');
    pushHistoryImmediate('v4');

    expect(getHistoryState().undoSize).toBe(3);

    undoNow(); // → v3
    expect(projectFS.readFile('app/page.tsx')).toBe('v3');

    undoNow(); // → v2
    expect(projectFS.readFile('app/page.tsx')).toBe('v2');

    redoNow(); // → v3
    expect(projectFS.readFile('app/page.tsx')).toBe('v3');

    redoNow(); // → v4
    expect(projectFS.readFile('app/page.tsx')).toBe('v4');

    expect(getHistoryState().canRedo).toBe(false);
  });

  // ─── Multi-file tests (new: presets, pages, components) ──────────────────

  test('undo restores multiple files changed in one step', () => {
    // Simulate creating a preset + updating page code
    projectFS.writeFile('app/page.tsx', 'code with var(--brand)');
    projectFS.writeFile('app/globals.css', ':root { --brand: #6366f1; }');
    pushHistoryImmediate('code with var(--brand)');

    expect(projectFS.readFile('app/globals.css')).toBe(':root { --brand: #6366f1; }');

    undoNow();
    expect(projectFS.readFile('app/page.tsx')).toBe('initial code');
    expect(projectFS.readFile('app/globals.css')).toBe(null); // file didn't exist before
  });

  test('undo restores deleted files', () => {
    // Add a component file first
    projectFS.writeFile('components/Button.tsx', 'export function Button() {}');
    pushHistoryImmediate('');

    // Delete it
    projectFS.deleteFile('components/Button.tsx');
    pushHistoryImmediate('');

    expect(projectFS.readFile('components/Button.tsx')).toBe(null);

    // Undo should restore the file
    undoNow();
    expect(projectFS.readFile('components/Button.tsx')).toBe('export function Button() {}');
  });

  test('undo restores newly created files by deleting them', () => {
    // Create a new page
    projectFS.writeFile('app/about/page.tsx', 'export default function About() {}');
    pushHistoryImmediate('');

    expect(projectFS.exists('app/about/page.tsx')).toBe(true);

    // Undo should remove the file
    undoNow();
    expect(projectFS.exists('app/about/page.tsx')).toBe(false);
  });

  test('preset token changes are undoable', () => {
    projectFS.writeFile('app/globals.css', ':root { --a: red; }');
    pushHistoryImmediate('');

    projectFS.writeFile('app/globals.css', ':root { --a: blue; }');
    pushHistoryImmediate('');

    undoNow();
    expect(projectFS.readFile('app/globals.css')).toBe(':root { --a: red; }');

    redoNow();
    expect(projectFS.readFile('app/globals.css')).toBe(':root { --a: blue; }');
  });

  test('syncHistoryCode calls pushHistory for different code', () => {
    projectFS.writeFile('app/page.tsx', 'external edit');
    syncHistoryCode('external edit');
    vi.advanceTimersByTime(350);
    expect(getHistoryState().undoSize).toBe(1);
  });

  test('syncHistoryCode ignores when no files changed', () => {
    syncHistoryCode('initial code');
    vi.advanceTimersByTime(350);
    expect(getHistoryState().undoSize).toBe(0);
  });
});

// ─── Selection coordination ─────────────────────────────────────────────────

describe('history — selection on undo/redo', () => {
  let selection: string[];
  let nodeIds: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    selection = [];
    nodeIds = new Set();
    projectFS.loadSnapshot(new Map([['app/page.tsx', 'v0']]));
    initHistory('v0', () => {}, () => 'app/page.tsx', undefined, {
      get: () => selection,
      set: (ids) => { selection = ids; },
      getNodeIds: () => nodeIds,
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  /** Simulate a paste via the real flow: flush pushes history (debounced)
   *  BEFORE the post-flush `setSelectedIds`, then selection updates, then
   *  the debounce finalizes. */
  function simulatePaste(fileAfter: string, newId: string, preSelection: string[]) {
    selection = preSelection;                 // selection before the op
    nodeIds = new Set([...preSelection, newId]);
    projectFS.writeFile('app/page.tsx', fileAfter);
    pushHistory(fileAfter);                   // captures selBefore = preSelection
    selection = [newId];                      // post-flush setSelectedIds([newId])
    vi.advanceTimersByTime(350);              // finalize → selAfter = [newId]
  }

  test('undo of a paste reselects the node selected BEFORE the paste', () => {
    simulatePaste('v0 + img', 'img-1', ['hero-sub']);
    expect(selection).toEqual(['img-1']);

    // The paste's node is gone after undo — mirror that in the node map.
    nodeIds = new Set(['hero-sub']);
    undoNow();
    expect(projectFS.readFile('app/page.tsx')).toBe('v0');
    expect(selection).toEqual(['hero-sub']);
  });

  test('redo of the paste reselects the re-created node', () => {
    simulatePaste('v0 + img', 'img-1', ['hero-sub']);
    nodeIds = new Set(['hero-sub']);
    undoNow();
    expect(selection).toEqual(['hero-sub']);

    nodeIds = new Set(['hero-sub', 'img-1']); // node exists again after redo
    redoNow();
    expect(selection).toEqual(['img-1']);
  });

  test('a removed node never leaves a stale selection — drops to []', () => {
    simulatePaste('v0 + img', 'img-1', []); // nothing was selected before
    expect(selection).toEqual(['img-1']);

    nodeIds = new Set(); // both pre-selection ([]) and the node are gone
    undoNow();
    expect(selection).toEqual([]);          // stale 'img-1' cleared, not left dangling
  });

  test('selection-only change creates NO history entry (nothing to undo)', () => {
    // User selects 5 elements but makes no document change.
    selection = ['a', 'b', 'c', 'd', 'e'];
    pushHistory('v0');               // identical code → no diff
    vi.advanceTimersByTime(350);
    expect(getHistoryState().undoSize).toBe(0);
    expect(undoNow()).toBe(false);      // nothing to undo
    expect(selection).toEqual(['a', 'b', 'c', 'd', 'e']); // selection untouched
  });

  test('pushHistoryImmediate refreshes selAfter after the sync op (microtask)', async () => {
    selection = ['old'];
    nodeIds = new Set(['old', 'frame-1']);
    projectFS.writeFile('app/page.tsx', 'v1');
    pushHistoryImmediate('v1');      // selBefore = ['old']
    selection = ['frame-1'];         // creator's post-flush selection
    await Promise.resolve();         // drain the queued microtask → selAfter = ['frame-1']

    nodeIds = new Set(['old']);
    undoNow();
    expect(selection).toEqual(['old']);

    nodeIds = new Set(['old', 'frame-1']);
    redoNow();
    expect(selection).toEqual(['frame-1']); // proves the microtask captured selAfter
  });
});

// ─── Cross-page navigation ──────────────────────────────────────────────────

describe('history — navigates to the page a change belongs to', () => {
  let activeFile: string;
  const navTargets: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    activeFile = 'app/A/page.tsx';
    navTargets.length = 0;
    projectFS.loadSnapshot(new Map([
      ['app/A/page.tsx', 'A0'],
      ['app/B/page.tsx', 'B0'],
    ]));
    initHistory('A0', () => {}, () => activeFile, undefined, {
      get: () => [],
      set: () => {},
      getNodeIds: () => new Set(),
      // Simulate the editor switching pages: record + flip the active file.
      navigateToFile: (to) => {
        if (to === activeFile || projectFS.readFile(to) == null) return false;
        navTargets.push(to);
        activeFile = to;
        return true;
      },
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  function edit(file: string, content: string, onPage: string) {
    activeFile = onPage;
    projectFS.writeFile(file, content);
    pushHistoryImmediate(content);   // stamps entry.activeFile = onPage
  }

  test('undo of a page-A change made while now on page B navigates back to A', () => {
    edit('app/A/page.tsx', 'A1', 'app/A/page.tsx');   // edit on A
    edit('app/B/page.tsx', 'B1', 'app/B/page.tsx');   // then edit on B (now on B)
    expect(activeFile).toBe('app/B/page.tsx');

    undoNow(); // undo the B edit — already on B, no navigation
    expect(activeFile).toBe('app/B/page.tsx');
    expect(projectFS.readFile('app/B/page.tsx')).toBe('B0');

    undoNow(); // undo the A edit — MUST navigate back to A
    expect(activeFile).toBe('app/A/page.tsx');
    expect(navTargets).toEqual(['app/A/page.tsx']);
    expect(projectFS.readFile('app/A/page.tsx')).toBe('A0');
  });

  test('redo navigates to the page the redone change belongs to', () => {
    edit('app/A/page.tsx', 'A1', 'app/A/page.tsx');
    edit('app/B/page.tsx', 'B1', 'app/B/page.tsx');
    undoNow(); // B → B0 (on B)
    undoNow(); // A → A0 (navigates to A)
    expect(activeFile).toBe('app/A/page.tsx');
    navTargets.length = 0;

    redoNow(); // re-apply A1 — on A already, no nav
    expect(activeFile).toBe('app/A/page.tsx');
    expect(projectFS.readFile('app/A/page.tsx')).toBe('A1');

    redoNow(); // re-apply B1 — navigate to B
    expect(activeFile).toBe('app/B/page.tsx');
    expect(navTargets).toEqual(['app/B/page.tsx']);
    expect(projectFS.readFile('app/B/page.tsx')).toBe('B1');
  });

  test('no navigation when the change is on the current page', () => {
    edit('app/A/page.tsx', 'A1', 'app/A/page.tsx');
    edit('app/A/page.tsx', 'A2', 'app/A/page.tsx');
    undoNow();
    undoNow();
    expect(navTargets).toEqual([]); // never left page A
    expect(activeFile).toBe('app/A/page.tsx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FS-level operations (template create/assign, page moves) — recorded as ONE
// entry via sealPendingHistory + pushHistoryFileOp.
//
// These ops write ProjectFS directly, so no queue flush ever pushed history
// for them. Live symptom (2026-07-27): create a template → Cmd+Z does nothing
// to it and instead undoes the edit BEFORE it; the creation's diff silently
// glued itself onto the next entry.
// ─────────────────────────────────────────────────────────────────────────────
describe('history — discrete FS operations', () => {
  let navigatedTo: string[];
  let setActive: (p: string) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    navigatedTo = [];
    projectFS.loadSnapshot(new Map([['app/page.tsx', 'page code']]));
    let active = 'app/page.tsx';
    setActive = (p: string) => { active = p; };
    initHistory('page code', () => {}, () => active, undefined, {
      get: () => [], set: () => {}, getNodeIds: () => new Set<string>(),
      navigateToFile: (to: string) => {
        if (projectFS.readFile(to) == null) return false;
        navigatedTo.push(to);
        active = to;
        return true;
      },
    });
  });

  afterEach(() => { vi.useRealTimers(); });

  /** The template-create shape: new layout files + the page moved into the
   *  group + the editor now active on the MOVED page (applyTemplate's
   *  setActiveFile). */
  const createTemplateOnDisk = () => {
    projectFS.writeFile('app/(Body)/layout.tsx', 'layout');
    projectFS.writeFile('app/(Body)/LayoutClient.tsx', 'client');
    const pageCode = projectFS.readFile('app/page.tsx')!;
    projectFS.deleteFile('app/page.tsx');
    projectFS.writeFile('app/(Body)/page.tsx', pageCode);
    setActive('app/(Body)/page.tsx');
  };

  test('create+apply lands as ONE entry; undo removes it and navigates to the pre-op page', () => {
    sealPendingHistory();
    createTemplateOnDisk();
    pushHistoryFileOp('app/page.tsx');
    expect(getHistoryState().undoSize).toBe(1);

    expect(undoNow()).toBe(true);
    expect(projectFS.exists('app/(Body)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.exists('app/(Body)/layout.tsx')).toBe(false);
    expect(projectFS.exists('app/(Body)/page.tsx')).toBe(false);
    expect(projectFS.readFile('app/page.tsx')).toBe('page code');
    // Undo navigated to the PRE-op path — not the post-op activeFile, which
    // doesn't exist in the restored state.
    expect(navigatedTo).toContain('app/page.tsx');
  });

  test('redo re-applies the whole operation', () => {
    sealPendingHistory();
    createTemplateOnDisk();
    pushHistoryFileOp('app/page.tsx');
    undoNow();
    expect(redoNow()).toBe(true);
    expect(projectFS.readFile('app/(Body)/LayoutClient.tsx')).toBe('client');
    expect(projectFS.exists('app/page.tsx')).toBe(false);
    expect(projectFS.readFile('app/(Body)/page.tsx')).toBe('page code');
    // An undo after the redo still works (activeFileBefore carried through).
    expect(undoNow()).toBe(true);
    expect(projectFS.readFile('app/page.tsx')).toBe('page code');
    expect(projectFS.exists('app/(Body)/page.tsx')).toBe(false);
  });

  test('pending edits seal SEPARATELY — undo peels the op first, then the edit', () => {
    // An ordinary debounced edit, still pending…
    projectFS.writeFile('app/page.tsx', 'edited code');
    pushHistory('edited code');
    // …then the discrete op. Without the seal, both merged into one entry.
    sealPendingHistory();
    createTemplateOnDisk();
    pushHistoryFileOp('app/page.tsx');
    expect(getHistoryState().undoSize).toBe(2);

    undoNow();  // 1st: the template op only
    expect(projectFS.exists('app/(Body)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.readFile('app/page.tsx')).toBe('edited code');
    undoNow();  // 2nd: the edit
    expect(projectFS.readFile('app/page.tsx')).toBe('page code');
  });

  test('a no-diff file op pushes nothing and corrupts no prior entry', () => {
    projectFS.writeFile('app/page.tsx', 'v2');
    pushHistoryImmediate('v2');            // a normal prior entry
    sealPendingHistory();
    pushHistoryFileOp('app/somewhere.tsx'); // nothing changed since
    expect(getHistoryState().undoSize).toBe(1);
    // The prior entry's undo target must be untouched: undo restores and does
    // NOT navigate to 'app/somewhere.tsx'.
    undoNow();
    expect(navigatedTo).not.toContain('app/somewhere.tsx');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Editor-state files never enter history. `_meta/page-camera.json` mirrors the
// camera (debounced) after every pan/zoom — as a history participant each
// settled write became its OWN entry, so Cmd+Z needed 2–3 presses before
// anything visible undid (the first ones silently restored camera JSON —
// user report 2026-07-27, right after the template-create flow's navigation).
// ─────────────────────────────────────────────────────────────────────────────
describe('history — camera persist is editor state, not content', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    projectFS.loadSnapshot(new Map([
      ['app/page.tsx', 'page code'],
      ['_meta/page-camera.json', '{"app/page.tsx":{"x":0,"y":0,"scale":1}}'],
    ]));
    initHistory('page code', () => {}, () => 'app/page.tsx');
  });
  afterEach(() => { vi.useRealTimers(); });

  test('a camera-only change produces NO history entry', () => {
    projectFS.writeFile('_meta/page-camera.json', '{"app/page.tsx":{"x":100,"y":50,"scale":0.5}}');
    pushHistoryImmediate('');
    expect(getHistoryState().undoSize).toBe(0);
    // The debounced path too:
    pushHistory('page code');
    vi.advanceTimersByTime(400);
    expect(getHistoryState().undoSize).toBe(0);
  });

  test('a real edit alongside a camera write records ONLY the edit — undo leaves the camera alone', () => {
    projectFS.writeFile('_meta/page-camera.json', '{"moved":true}');
    projectFS.writeFile('app/page.tsx', 'edited code');
    pushHistoryImmediate('edited code');
    expect(getHistoryState().undoSize).toBe(1);

    undoNow();
    expect(projectFS.readFile('app/page.tsx')).toBe('page code');
    // Camera stays where the user left it — undo never yanks the viewport.
    expect(projectFS.readFile('_meta/page-camera.json')).toBe('{"moved":true}');
  });
});
