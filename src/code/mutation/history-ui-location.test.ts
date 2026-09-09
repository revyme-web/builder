// history-ui-location.test.ts — undo puts the editor CHROME back too.
//
// `activeFile` already restores the page an edit belongs to, so the user sees
// it un-done. An edit typed in the Manage Translations overlay has the same
// problem one level up: undo would restore the right page with the overlay
// gone, so the change reverted somewhere invisible (user report 2026-08-09).

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initHistory, pushHistory, pushHistoryImmediate, pushHistoryNavigation, undo, redo, finishPendingRestore,
  type UiLocation,
} from './history';
import { projectFS } from '../project/project-fs';

const undoNow = () => { const r = undo(); finishPendingRestore(); return r; };
const redoNow = () => { const r = redo(); finishPendingRestore(); return r; };

const FILE = 'app/page.tsx';

describe('history restores where the user was', () => {
  /** The live editor chrome, as the app's getter/setter would see it. */
  let ui: UiLocation;

  const wire = () => initHistory(
    'v1', () => {}, () => FILE, undefined, undefined,
    { get: () => ({ ...ui }), set: (loc) => { ui = { ...loc }; } },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    ui = { localizationLocale: null };
    projectFS.loadSnapshot(new Map([[FILE, 'v1']]));
    wire();
  });

  afterEach(() => { vi.useRealTimers(); });

  test('an edit made in the overlay reopens it on undo', () => {
    ui = { localizationLocale: 'fr' };            // user opened Manage Translations
    projectFS.writeFile('messages/fr.json', '{"home":{"a":"Bonjour"}}');
    pushHistory('');
    vi.advanceTimersByTime(300);

    ui = { localizationLocale: null };            // …then closed it, back to canvas
    undoNow();
    expect(ui).toEqual({ localizationLocale: 'fr' });
  });

  test('and redo puts it back there as well', () => {
    ui = { localizationLocale: 'fr' };
    projectFS.writeFile('messages/fr.json', '{"a":1}');
    pushHistory('');
    vi.advanceTimersByTime(300);

    ui = { localizationLocale: null };
    undoNow();
    ui = { localizationLocale: null };
    redoNow();
    expect(ui).toEqual({ localizationLocale: 'fr' });
  });

  test('an edit made on the canvas CLOSES an overlay opened since', () => {
    // The mirror case, and the reason this restores rather than only opens:
    // undoing a canvas edit while the overlay happens to be up must return the
    // user to the canvas, or the change reverts behind the overlay.
    projectFS.writeFile(FILE, 'v2');
    pushHistory('');
    vi.advanceTimersByTime(300);

    ui = { localizationLocale: 'fr' };
    undoNow();
    expect(ui).toEqual({ localizationLocale: null });
  });

  test('the location is captured at the START of the debounce group', () => {
    // A group that begins in the overlay and seals after it closes still
    // belongs to the overlay — same rule as `activeFile`.
    ui = { localizationLocale: 'fr' };
    projectFS.writeFile('messages/fr.json', '{"a":1}');
    pushHistory('');
    ui = { localizationLocale: null };
    projectFS.writeFile('messages/fr.json', '{"a":2}');
    pushHistory('');
    vi.advanceTimersByTime(300);

    undoNow();
    expect(ui).toEqual({ localizationLocale: 'fr' });
  });

  test('each entry carries its own location', () => {
    projectFS.writeFile(FILE, 'v2');                 // on the canvas
    pushHistory(''); vi.advanceTimersByTime(300);

    ui = { localizationLocale: 'fr' };               // in the overlay
    projectFS.writeFile('messages/fr.json', '{"a":1}');
    pushHistory(''); vi.advanceTimersByTime(300);

    undoNow();
    expect(ui).toEqual({ localizationLocale: 'fr' });   // …undoes the overlay edit
    undoNow();
    expect(ui).toEqual({ localizationLocale: null });   // …then back to the canvas
  });

  test('immediate pushes record it too', () => {
    ui = { localizationLocale: 'fr' };
    projectFS.writeFile('messages/fr.json', '{"a":1}');
    pushHistoryImmediate('');
    ui = { localizationLocale: null };
    undoNow();
    expect(ui).toEqual({ localizationLocale: 'fr' });
  });

  test('undo works when the app never wired a UI location', () => {
    // Headless / test callers pass no `ui` pair at all. The restore must be a
    // no-op rather than a crash — and the rest of the entry still applies.
    initHistory('v1', () => {}, () => FILE);        // no ui pair
    projectFS.writeFile(FILE, 'v2');
    pushHistoryImmediate('');
    expect(undoNow()).toBe(true);
    expect(projectFS.readFile(FILE)).toBe('v1');
  });
});

describe('component breadcrumb trail travels with undo/redo', () => {
  let ui: UiLocation;
  const wire = () => initHistory(
    'v1', () => {}, () => FILE, undefined, undefined,
    { get: () => ({ ...ui, breadcrumb: [...(ui.breadcrumb ?? [])] }), set: (loc) => { ui = { ...loc }; } },
  );
  beforeEach(() => {
    vi.useFakeTimers();
    ui = { localizationLocale: null, breadcrumb: ['app/page.client.tsx'] };
    projectFS.loadSnapshot(new Map([[FILE, 'v1'], ['components/Header.tsx', 'h1']]));
    wire();
  });
  afterEach(() => { vi.useRealTimers(); });

  test('nested Make Component: undo restores the pre-op trail, redo the post-op trail', () => {
    // Inside Header (trail = [page]); the op creates Nested.tsx and the app
    // navigates into it (trail = [page, Header]) BEFORE the group seals.
    projectFS.writeFile('components/Nested.tsx', 'n1');
    projectFS.writeFile('components/Header.tsx', 'h2');
    pushHistory('');
    ui = { localizationLocale: null, breadcrumb: ['app/page.client.tsx', 'components/Header.tsx'] };
    vi.advanceTimersByTime(300);

    undoNow();
    expect(ui.breadcrumb).toEqual(['app/page.client.tsx']);

    // Simulate the stale hand-pushed stack drifting, then redo must land on
    // the post-op trail, not the pre-op one and not the drifted one.
    ui = { localizationLocale: null, breadcrumb: ['app/page.client.tsx', 'components/Header.tsx', 'components/Header.tsx'] };
    redoNow();
    expect(ui.breadcrumb).toEqual(['app/page.client.tsx', 'components/Header.tsx']);

    // And a second undo goes back to the pre-op trail again.
    undoNow();
    expect(ui.breadcrumb).toEqual(['app/page.client.tsx']);
  });

  test('immediate push refreshes the post-op trail on the next microtask', async () => {
    projectFS.writeFile('components/Nested.tsx', 'n1');
    pushHistoryImmediate('');
    ui = { localizationLocale: null, breadcrumb: ['app/page.client.tsx', 'components/Header.tsx'] };
    await Promise.resolve();
    undoNow();
    expect(ui.breadcrumb).toEqual(['app/page.client.tsx']);
    redoNow();
    expect(ui.breadcrumb).toEqual(['app/page.client.tsx', 'components/Header.tsx']);
  });
});

// ─── Breadcrumb navigation is its own history step ────────────────────────
// Clicking a breadcrumb segment changes NO file, so the diff-based pushes
// record nothing and Cmd+Z sailed past the navigation into an unrelated edit
// (user report 2026-09-09). A navigation entry carries no diffs at all: undo
// restores the side the user came from, redo the side they went to.
describe('navigation history', () => {
  let ui: UiLocation;
  let activeFile: string;
  let selection: string[];
  const navigated: string[] = [];

  const wire = () => initHistory(
    'v1', () => {}, () => activeFile, () => {},
    {
      get: () => selection,
      set: (ids: string[]) => { selection = ids; },
      // The node map of whatever file is now open — a real restore validates
      // the remembered selection against it.
      getNodeIds: () => new Set(['card-root', 'hero']),
      navigateToFile: (path: string) => { navigated.push(path); activeFile = path; return true; },
    },
    { get: () => ({ ...ui }), set: (loc) => { ui = { ...loc }; } },
  );

  beforeEach(() => {
    vi.useFakeTimers();
    navigated.length = 0;
    activeFile = 'components/Card.tsx';
    ui = { breadcrumb: ['app/page.client.tsx'] };
    selection = ['card-root'];
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', 'v1'], ['components/Card.tsx', 'v1']]));
    wire();
  });

  afterEach(() => { vi.useRealTimers(); });

  /** The user clicks the page segment: the app navigates, then records it. */
  const clickBreadcrumbToPage = () => {
    const from = { activeFile, uiLocation: { ...ui }, selection: [...selection] };
    activeFile = 'app/page.client.tsx';
    ui = { breadcrumb: [] };
    selection = [];
    pushHistoryNavigation(from);
  };

  test('undo walks back to the file, breadcrumb and selection the user left', () => {
    clickBreadcrumbToPage();

    expect(undoNow()).toBe(true);
    expect(activeFile).toBe('components/Card.tsx');
    expect(ui).toEqual({ breadcrumb: ['app/page.client.tsx'] });
    expect(selection).toEqual(['card-root']);
  });

  test('redo returns to where the click went', () => {
    clickBreadcrumbToPage();
    undoNow();

    expect(redoNow()).toBe(true);
    expect(activeFile).toBe('app/page.client.tsx');
    expect(ui).toEqual({ breadcrumb: [] });
  });

  test('a navigation that goes nowhere records nothing', () => {
    const from = { activeFile, uiLocation: { ...ui }, selection: [...selection] };
    pushHistoryNavigation(from);          // same file, same breadcrumb
    expect(undoNow()).toBe(false);
  });

  test('it changes no files — undoing a navigation leaves the project untouched', () => {
    projectFS.writeFile('components/Card.tsx', 'v2');
    pushHistoryImmediate('');             // a real edit lands first
    clickBreadcrumbToPage();

    undoNow();                            // undoes only the navigation
    expect(projectFS.readFile('components/Card.tsx')).toBe('v2');
    expect(activeFile).toBe('components/Card.tsx');

    undoNow();                            // now the edit itself
    expect(projectFS.readFile('components/Card.tsx')).toBe('v1');
  });
});
