// Every row is a LINK, and each kind of thing opens where that kind of thing
// lives. Driven through the real component over the real in-memory ProjectFS.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

const switched = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/code/project/active-file-store', async (orig) => ({
  ...(await orig<typeof import('@/code/project/active-file-store')>()),
  switchActiveFile: vi.fn((_from: string | null, to: string) => { switched.calls.push(to); }),
}));
vi.mock('@/canvas/node-ops', () => ({ getContentRoot: () => null }));
vi.mock('@/canvas/transform', () => ({ zoomToFitSelection: vi.fn() }));
vi.mock('@/code/mutation/mutation-queue', () => ({ syncQueueCode: vi.fn(), flushNow: vi.fn() }));
vi.mock('@/code/mutation/history', () => ({ undo: vi.fn(() => true), redo: vi.fn(() => true), getHistoryState: () => ({ canUndo: true, canRedo: true }) }));

import ChangesCard, { type ChangedFile } from './ChangesCard';
import { resetProjectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { cmsEditorOpenAtom, cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { undo, redo } from '@/code/mutation/history';

const store = getDefaultStore();

const CODE_COMPONENT = `'use client';
/** @label "Galaxy" */
/** @comment "x" */
/** @defaultWidth 600 */
/** @defaultHeight 400 */
/** @controls { "speed": { "type": "slider", "label": "Speed", "default": 1 } } */
export default function Galaxy(props: any) { return <div {...props} />; }
`;

const FILES: ChangedFile[] = [
  { path: '_meta/page-camera.json' },
  { path: 'app/page.client.tsx', addedIds: ['hero', 'cta'], changedIds: ['nav'] },
  { path: 'components/Header.tsx', changedIds: Array.from({ length: 32 }, (_, i) => `n${i}`) },
  { path: 'components/Galaxy.tsx' },
  { path: 'app/globals.css', parts: [{ unit: 'style', group: 'color', count: 1, names: ['color-link'] }] },
  { path: 'cms/blog.schema.json', parts: [{ unit: 'field', count: 3, names: [] }] },
  { path: 'cms/blog.json', parts: [{ unit: 'item', count: 8, names: [] }] },
];

beforeEach(() => {
  cleanup();
  switched.calls = [];
  resetProjectFS(new Map([
    ['app/page.client.tsx', 'export default function P(){return <div data-id="hero"/>}'],
    ['app/about/page.client.tsx', 'x'],
    ['components/Header.tsx', 'export default function Header(){return <div data-id="n0"/>}'],
    ['components/Galaxy.tsx', CODE_COMPONENT],
    ['app/globals.css', ':root { --color-link: #00f; }'],
    ['cms/blog.schema.json', JSON.stringify({ name: 'Blog Posts', slug: 'blog', fields: [{ id: 'title', name: 'Title', type: 'text' }] })],
    ['cms/blog.json', '[]'],
  ]));
  act(() => {
    store.set(activeFilePathAtom, 'app/about/page.client.tsx');
    store.set(leftPanelAtom, 'layers');
    store.set(componentEditorFileAtom, null);
    store.set(cmsEditorOpenAtom, false);
    store.set(cmsEditorCollectionAtom, null);
  });
});

describe('what the card shows', () => {
  it('names each thing in its own unit, and never lists editor bookkeeping', () => {
    render(<ChangesCard files={FILES} canRevert />);
    const text = document.body.textContent ?? '';
    for (const expected of ['Home', '3 Layers', 'Header', '32 Layers', 'Galaxy', 'Code', 'color-link', '1 Style', 'Blog Posts', '8 Items · 3 Fields']) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toContain('page-camera');
    expect(text).not.toContain('globals.css');
    expect(text).not.toContain('blog.json');
  });
});

describe('where each row takes you', () => {
  it('a page → that page', () => {
    render(<ChangesCard files={FILES} />);
    fireEvent.click(screen.getByText('Home'));
    expect(switched.calls).toEqual(['app/page.client.tsx']);
  });

  it('a design component → INSIDE the component', () => {
    render(<ChangesCard files={FILES} />);
    fireEvent.click(screen.getByText('Header'));
    expect(switched.calls).toEqual(['components/Header.tsx']);
  });

  it('a code component → its editor, not the canvas', () => {
    render(<ChangesCard files={FILES} />);
    fireEvent.click(screen.getByText('Galaxy'));
    expect(store.get(componentEditorFileAtom)).toBe('components/Galaxy.tsx');
    expect(switched.calls).toEqual([]);
  });

  it('styles → the Styles panel', () => {
    render(<ChangesCard files={FILES} />);
    fireEvent.click(screen.getByText('color-link'));
    expect(store.get(leftPanelAtom)).toBe('presets');
  });

  it('a collection → the CMS, on that collection', () => {
    render(<ChangesCard files={FILES} />);
    fireEvent.click(screen.getByText('Blog Posts'));
    expect(store.get(cmsEditorOpenAtom)).toBe(true);
    expect(store.get(cmsEditorCollectionAtom)).toBe('blog');
    expect(store.get(leftPanelAtom)).toBe('cms');
  });

  it('something the run DELETED is listed but goes nowhere', () => {
    render(<ChangesCard files={[{ path: 'components/Gone.tsx', removedIds: ['a'] }, { path: 'cms/old.json' }]} />);
    for (const label of ['Gone', 'old']) {
      expect((screen.getByText(label).closest('button') as HTMLButtonElement).disabled, label).toBe(true);
    }
  });
});

describe('undo / redo', () => {
  it('Undo is a button; Redo lives behind "More"', async () => {
    render(<ChangesCard files={FILES} canRevert />);
    fireEvent.click(screen.getByText('Undo'));
    expect(undo).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('More'));
    fireEvent.click(await screen.findByText('Redo'));
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it('an OLDER turn\'s card offers neither — history is a stack', () => {
    render(<ChangesCard files={FILES} />);
    expect(screen.queryByText('Undo')).toBeNull();
    expect(screen.queryByLabelText('More')).toBeNull();
  });
});
