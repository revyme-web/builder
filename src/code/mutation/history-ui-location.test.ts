// history-ui-location.test.ts — undo puts the editor CHROME back too.
//
// `activeFile` already restores the page an edit belongs to, so the user sees
// it un-done. An edit typed in the Manage Translations overlay has the same
// problem one level up: undo would restore the right page with the overlay
// gone, so the change reverted somewhere invisible (user report 2026-08-09).

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initHistory, pushHistory, pushHistoryImmediate, undo, redo, finishPendingRestore,
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
