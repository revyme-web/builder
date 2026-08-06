import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStore } from 'jotai';
import { activeFilePathAtom } from '../project/active-file-store';
import { projectFS } from '../project/project-fs';
import { viewportsConfigAtom, viewportPositionsAtom } from './viewport-store';
import { registerExternalWriteRefresh, notifyExternalActiveFileWrite, isExternalWriteRefreshRegistered } from '../mutation/external-write-registry';

const PAGE = `'use client';

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1540, "y": 0 }, "mobile": { "x": 2408, "y": 0 } }
} */

export default function Page() { return <div data-id="root" /> }
`;

describe('@canvas config writes reach the mutation queue SYNCHRONOUSLY', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
    projectFS.writeFile('app/page.client.tsx', PAGE);
  });

  it('viewportsConfigAtom setter notifies the external-write registry in the same task', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    const spy = vi.fn();
    registerExternalWriteRefresh(spy);
    // The viewport-resize commit path: width 375 → 636. With the old
    // dynamic-import adopt this notification arrived a MICROTASK later —
    // after gesture-end cleanup — and the drag-end fan-out re-flushed the
    // pre-write code over it (mobile reverted 636→375 on file switch).
    store.set(viewportsConfigAtom, prev => prev.map(v => v.id === 'mobile' ? { ...v, width: 636 } : v));
    expect(spy).toHaveBeenCalledTimes(1);
    const written = spy.mock.calls[0][0] as string;
    expect(written).toContain('636');
    expect(store.get(viewportsConfigAtom).find(v => v.id === 'mobile')?.width).toBe(636);
  });

  it('viewportPositionsAtom setter notifies synchronously too (tile reposition commits)', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    const spy = vi.fn();
    registerExternalWriteRefresh(spy);
    store.set(viewportPositionsAtom, prev => ({ ...prev, mobile: { x: 999, y: 42 } }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0] as string).toContain('999');
  });

  it('composes on FRESH ProjectFS content, not the stale atom cache (the mid-gesture band-rewrite clobber)', () => {
    const store = createStore();
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    // Prime the activeCodeAtom cache (pre-transaction state).
    store.get(viewportsConfigAtom);
    // A mid-gesture modifyProjectFile transaction: writes ProjectFS but DEFERS
    // the version bump — the atom cache still holds the old string. This is
    // the resize commit's band rewrite (429 → 1461 in the real trace).
    const current = projectFS.readFile('app/page.client.tsx')!;
    projectFS.writeFile('app/page.client.tsx', current.replace('return <div data-id="root" />', 'return <div data-id="root" data-band-rewrite="done" />'));
    // The config write that follows in the same commit must compose ON TOP of
    // that transaction — pre-fix it read the stale cache and reverted it.
    store.set(viewportsConfigAtom, prev => prev.map(v => v.id === 'mobile' ? { ...v, width: 1461 } : v));
    const final = projectFS.readFile('app/page.client.tsx')!;
    expect(final).toContain('data-band-rewrite="done"');
    expect(final).toContain('1461');
  });

  it('mutation-queue registers its refresh on module load', async () => {
    await import('../mutation/mutation-queue');
    expect(isExternalWriteRefreshRegistered()).toBe(true);
  });

  it('notify is a safe no-op pass-through', () => {
    const spy = vi.fn();
    registerExternalWriteRefresh(spy);
    notifyExternalActiveFileWrite('abc');
    expect(spy).toHaveBeenCalledWith('abc');
  });
});
