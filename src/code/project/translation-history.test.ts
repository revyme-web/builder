// translation-history.test.ts — translation edits are undoable.
//
// Nothing subscribes ProjectFS to history: a write becomes an undo entry only
// if something calls `pushHistory` after it, and the only routine caller is the
// mutation-queue flush. Translation writes never reach the queue — they touch
// `messages/*.json`, not the page's JSX — so Cmd+Z skipped past them entirely
// (user report 2026-08-09).
//
// The second, quieter half is the one the last test here pins: the unrecorded
// diff did not disappear. `commitPendingHistory` diffs the WHOLE FS against the
// last committed snapshot, so an unrecorded write silently glued itself onto
// whatever entry came next, and undoing an unrelated edit reverted the
// translation with it.
//
// Real ProjectFS and real history (only `modify-file` is stubbed, since it
// flushes the mutation queue in the app).

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

vi.mock('./modify-file', async () => {
  const { projectFS } = await import('./project-fs');
  return {
    modifyProjectFile: vi.fn((path: string, fn: (code: string) => string) => {
      projectFS.writeFile(path, fn(projectFS.readFile(path) ?? ''));
    }),
  };
});

import { projectFS } from './project-fs';
import { initHistory, undo, redo, pushHistory, finishPendingRestore, getHistoryState } from '@/code/mutation/history';
import { commitTranslationText, commitTranslationAttr } from './translation-ops';

// Selection reselect + version bump are deferred after undo/redo; tests assert
// synchronously, so apply the pending finish the way the app's timer does.
const undoNow = () => { const r = undo(); finishPendingRestore(); return r; };
const redoNow = () => { const r = redo(); finishPendingRestore(); return r; };

const FILE = 'app/page.client.tsx';   // filePathToSlug → namespace 'home'

// Already transformed: the words live in messages, the JSX carries {t('intro')}.
const PAGE = `'use client';
import { useTranslations } from 'next-intl';
export default function Page() {
  const t = useTranslations('home');
  return (
    <div data-id="root">
      <p data-id="intro">{t('intro')}</p>
      <input data-id="email" placeholder="jane@x.com" type="email" />
    </div>
  );
}
`;

const EN_BEFORE = JSON.stringify({ home: { intro: 'Painter' } });

/** Pre-seed everything `ensureIntlScaffold` would create, so the scaffold is a
 *  no-op and each entry's diff contains only what the commit itself wrote. */
const seed = () => new Map<string, string>([
  [FILE, PAGE],
  ['messages/en.json', EN_BEFORE],
  ['messages/fr.json', '{}'],
  ['messages/es.json', '{}'],
  ['i18n/config.json', JSON.stringify({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] })],
]);

const msg = (locale: string) => JSON.parse(projectFS.readFile(`messages/${locale}.json`) ?? '{}');

beforeEach(() => {
  vi.useFakeTimers();
  projectFS.loadSnapshot(seed());
  initHistory(PAGE, () => {}, () => FILE);
});

afterEach(() => { vi.useRealTimers(); });

describe('translation edits are undoable', () => {
  test('a default-locale text commit becomes an undo entry', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'en', defaultLocale: 'en', text: 'Sculptor' });
    expect(msg('en').home.intro).toBe('Sculptor');

    // The push is DEBOUNCED — it seals when the group closes.
    vi.advanceTimersByTime(300);
    expect(getHistoryState().canUndo).toBe(true);

    expect(undoNow()).toBe(true);
    expect(msg('en').home.intro).toBe('Painter');
  });

  test('redo re-applies it', () => {
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'en', defaultLocale: 'en', text: 'Sculptor' });
    vi.advanceTimersByTime(300);
    undoNow();
    expect(redoNow()).toBe(true);
    expect(msg('en').home.intro).toBe('Sculptor');
  });

  test('an attr commit is recorded too', () => {
    commitTranslationAttr({
      filePath: FILE, nodeId: 'email', attr: 'placeholder',
      locale: 'en', defaultLocale: 'en', text: 'you@example.com', transformed: false,
    });
    vi.advanceTimersByTime(300);
    expect(undoNow()).toBe(true);
    expect(projectFS.readFile(FILE)).toContain('jane@x.com');
  });

  test('one undo reverts every file a single commit touched', () => {
    // A first translation into a NON-default locale writes three things: the
    // JSX transform, the seeded default message, and the locale message. They
    // are one user action and must be one entry — which the whole-FS snapshot
    // diff gives for free once something pushes.
    commitTranslationText({
      filePath: FILE, nodeId: 'email', locale: 'fr', defaultLocale: 'en',
      text: 'Bonjour', fallbackDefaultText: 'Hello',
    });
    vi.advanceTimersByTime(300);
    const changed = projectFS.readFile(FILE);

    undoNow();
    expect(projectFS.readFile(FILE)).toBe(PAGE);
    expect(msg('fr')).toEqual({});
    expect(changed).not.toBe(PAGE);   // the undo actually reverted something
  });

  test('a bulk translate seals as ONE entry, not one per row', () => {
    // AI Translate / MCP write_texts commit row by row. 55 rows must undo in
    // one step, which is why the push is debounced rather than immediate.
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'fr', defaultLocale: 'en', text: 'Peintre' });
    commitTranslationText({ filePath: FILE, nodeId: 'email', locale: 'fr', defaultLocale: 'en', text: 'Courriel' });
    vi.advanceTimersByTime(300);

    expect(getHistoryState().undoSize).toBe(1);
    undoNow();
    expect(msg('fr')).toEqual({});
    expect(getHistoryState().canUndo).toBe(false);
  });

  test('a translation does NOT ride along on the next unrelated edit', () => {
    // The quiet half of the bug. Before the push existed, the messages diff sat
    // between `lastSnapshot` and the live FS until some LATER edit pushed, and
    // then belonged to that entry — so undoing the later edit silently reverted
    // the translation as well.
    commitTranslationText({ filePath: FILE, nodeId: 'intro', locale: 'en', defaultLocale: 'en', text: 'Sculptor' });
    vi.advanceTimersByTime(300);

    // …an unrelated edit, well outside the translation's debounce group.
    projectFS.writeFile(FILE, PAGE.replace('data-id="root"', 'data-id="root" data-x="1"'));
    pushHistory('');
    vi.advanceTimersByTime(300);

    expect(getHistoryState().undoSize).toBe(2);
    undoNow();
    expect(projectFS.readFile(FILE)).toBe(PAGE);          // the page edit is gone…
    expect(msg('en').home.intro).toBe('Sculptor');        // …the translation stays.
  });
});
