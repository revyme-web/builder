// A branch switch lands on the SAME thing when the other branch has it —
// page, master + breadcrumb, overlay, CMS collection / item, code component
// editor — and falls back piece by piece only where the thing is gone.

import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { resolveLocationOnBranch, captureEditorLocation, type EditorLocation, type BranchReader } from './location';
import { switchBranchFile, clearRememberedBranchFiles } from './switch-workspace';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { activeFilePathAtom, componentBreadcrumbAtom } from '@/code/project/active-file-store';
import { overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { cmsEditorOpenAtom, cmsEditorCollectionAtom, cmsEditorExpandedItemAtom, cmsOverlayOpenAtom, activeOverlayCollectionAtom } from '@/code/stores/cms-editor-store';
import { initMutationQueue, setActiveFilePath, syncQueueCode } from '@/code/mutation/mutation-queue';

const HOME = 'app/page.client.tsx';
const ABOUT = 'app/about/page.client.tsx';
const HERO = 'components/Hero.tsx';
const PAGE = (ids: string[]) => `export default function Page() { return <div data-id="root">${ids.map((i) => `<div data-id="${i}" />`).join('')}</div> }`;

const readerOf = (files: Record<string, string>): BranchReader => ({
  fileExists: (p) => p in files,
  readFile: (p) => files[p] ?? null,
});

const base: EditorLocation = {
  file: ABOUT,
  breadcrumb: [HOME],
  overlayEditingId: 'modal-1',
  componentEditorFile: 'components/Counter.tsx',
  cms: { editorOpen: true, editorCollection: 'journal', editorItem: 'j2', editorField: 'title', overlayOpen: false, overlayCollection: null },
};

describe('resolveLocationOnBranch', () => {
  it('keeps everything the branch has', () => {
    const r = readerOf({
      [ABOUT]: PAGE(['modal-1']), [HOME]: PAGE([]), 'components/Counter.tsx': 'x',
      'cms/journal.schema.json': '{}', 'cms/journal.json': JSON.stringify([{ _id: 'j1' }, { _id: 'j2' }]),
    });
    expect(resolveLocationOnBranch(base, r, HOME)).toEqual(base);
  });

  it('falls back to the given file when the page is gone, and drops what hung off it', () => {
    const r = readerOf({ [HOME]: PAGE([]), 'components/Counter.tsx': 'x' });
    const out = resolveLocationOnBranch(base, r, HOME);
    expect(out.file).toBe(HOME);
    expect(out.breadcrumb).toEqual([]);
    expect(out.overlayEditingId).toBeNull();
    // Independent pieces survive on their own.
    expect(out.componentEditorFile).toBe('components/Counter.tsx');
    expect(out.cms.editorOpen).toBe(false);
  });

  it('keeps the page but drops an overlay the branch deleted, and a breadcrumb with a missing ancestor', () => {
    const r = readerOf({ [ABOUT]: PAGE(['other']), 'cms/journal.schema.json': '{}' });
    const out = resolveLocationOnBranch({ ...base, breadcrumb: [HOME, HERO] }, r, HOME);
    expect(out.file).toBe(ABOUT);
    expect(out.overlayEditingId).toBeNull();
    expect(out.breadcrumb).toEqual([]);
  });

  it('CMS: keeps the collection but not an item the branch does not have; a field only with its item', () => {
    const r = readerOf({ [ABOUT]: PAGE([]), 'cms/journal.schema.json': '{}', 'cms/journal.json': JSON.stringify([{ _id: 'j1' }]) });
    const out = resolveLocationOnBranch(base, r, HOME);
    expect(out.cms).toEqual({ editorOpen: true, editorCollection: 'journal', editorItem: null, editorField: null, overlayOpen: false, overlayCollection: null });
  });

  it('CMS overlay: closed when its collection is gone', () => {
    const loc: EditorLocation = { ...base, cms: { editorOpen: false, editorCollection: null, editorItem: null, editorField: null, overlayOpen: true, overlayCollection: 'legal' } };
    const kept = resolveLocationOnBranch(loc, readerOf({ [ABOUT]: PAGE([]), 'cms/legal.schema.json': '{}' }), HOME);
    expect(kept.cms.overlayOpen).toBe(true);
    const gone = resolveLocationOnBranch(loc, readerOf({ [ABOUT]: PAGE([]) }), HOME);
    expect(gone.cms).toMatchObject({ overlayOpen: false, overlayCollection: null });
  });
});

describe('switchBranchFile carries the location', () => {
  const store = getDefaultStore();
  beforeEach(() => {
    resetProjectFS(new Map([[HOME, PAGE([])], [ABOUT, PAGE(['modal-1'])], [HERO, 'export default function Hero() { return <div data-id="hero" /> }'], ['cms/journal.schema.json', '{}'], ['cms/journal.json', JSON.stringify([{ _id: 'j1' }])]]));
    clearRememberedBranchFiles();
    initMutationQueue(PAGE([]), () => {});
    setActiveFilePath(HOME);
    syncQueueCode(PAGE([]));
    store.set(activeFilePathAtom, HOME);
    store.set(componentBreadcrumbAtom, []);
    store.set(overlayEditingIdAtom, null);
    store.set(componentEditorFileAtom, null);
    store.set(cmsEditorOpenAtom, false);
    store.set(cmsOverlayOpenAtom, false);
  });

  it('same page + overlay + CMS editor on the other branch when it has them', () => {
    projectFS.createBranch('b');
    store.set(activeFilePathAtom, ABOUT);
    store.set(overlayEditingIdAtom, 'modal-1');
    store.set(cmsEditorOpenAtom, true);
    store.set(cmsEditorCollectionAtom, 'journal');
    store.set(cmsEditorExpandedItemAtom, 'j1');
    expect(switchBranchFile('b')).toBeNull();
    expect(store.get(activeFilePathAtom)).toBe(ABOUT);
    expect(store.get(overlayEditingIdAtom)).toBe('modal-1');
    expect(store.get(cmsEditorOpenAtom)).toBe(true);
    expect(store.get(cmsEditorExpandedItemAtom)).toBe('j1');
  });

  it('the page was deleted on the other branch → lands on that branch\'s page, overlay closed', () => {
    projectFS.createBranch('b');
    projectFS.switchBranch('b');
    projectFS.deleteFile(ABOUT);
    projectFS.switchBranch(MAIN_BRANCH_ID);
    store.set(activeFilePathAtom, ABOUT);
    store.set(overlayEditingIdAtom, 'modal-1');
    expect(switchBranchFile('b')).toBeNull();
    expect(store.get(activeFilePathAtom)).toBe(HOME);
    expect(store.get(overlayEditingIdAtom)).toBeNull();
  });

  it('a master being edited, with its breadcrumb, stays open across the switch', () => {
    projectFS.createBranch('b');
    store.set(activeFilePathAtom, HERO);
    store.set(componentBreadcrumbAtom, [HOME]);
    expect(switchBranchFile('b')).toBeNull();
    expect(store.get(activeFilePathAtom)).toBe(HERO);
    expect(store.get(componentBreadcrumbAtom)).toEqual([HOME]);
    // …and the switch back keeps it too — the same location wins over the
    // remembered file.
    store.set(activeFilePathAtom, ABOUT);
    expect(switchBranchFile(MAIN_BRANCH_ID)).toBeNull();
    expect(store.get(activeFilePathAtom)).toBe(ABOUT);
  });
});
