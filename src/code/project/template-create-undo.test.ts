// template-create-undo.test.ts — the full create→undo→re-create cycle at the
// store level: TemplatePicker.handleCreateAndApply's exact call sequence,
// undo() navigation via activeFileBefore, and a clean re-create afterwards.
// Born from the 2026-07-27 report where re-creating a template right after an
// undo rendered the full landing page inside the template view — the STORE
// side proved clean (this test), which localized the bug to the renderer's
// dropped file-switch forceRender (see CanvasRenderer.forceRender's return).
import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import { projectFS, projectVersionAtom } from '../../code/project/project-fs';
import { activeFilePathAtom, switchActiveFile } from '../../code/project/active-file-store';
import { codeAtom, nodesAtom, selectedIdsAtom, updatingFromCanvasAtom } from '../../code/stores/store';
import { createTemplate, assignTemplate } from '../../code/project/template-ops';
import { initHistory, undo, finishPendingRestore, sealPendingHistory, pushHistoryFileOp } from '../../code/mutation/history';
import { initMutationQueue, syncQueueCode, flushNow, setActiveFilePath as setQueueActiveFile, hasPendingDeferredFanOut } from '../../code/mutation/mutation-queue';
import { syncHistoryCode } from '../../code/mutation/history';

const PAGE_CLIENT = `'use client';
/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }, { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 }], "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1600, "y": 0 } } } */
import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div data-id="hero-1" data-name="Hero" style={{ order: '0', flex: '0 0 auto', display: 'flex', position: 'relative', flexDirection: 'column' }}>
        <p data-id="p-hero" data-name="Title" style={{ order: '0', flex: '0 0 auto', position: 'relative' }}>Save more and get visibility</p>
      </div>
    </div>
  );
}
`;
const PAGE_SERVER = `import PageClient from './page.client';
export default function Page() { return <PageClient />; }
`;
const HEADER = `'use client';
/** @name "Header" */
import React from 'react';
export default function KaFiBi() {
  return (<div data-id="kafibi-root" data-name="Header" style={{ display: 'flex', position: 'relative', width: '100%' }}></div>);
}
`;

const store = getDefaultStore();

/** The two lifecycle effects, run after each "commit". */
function runLifecycleEffects() {
  setQueueActiveFile(store.get(activeFilePathAtom));
  if (!hasPendingDeferredFanOut()) {
    const code = store.get(codeAtom);
    syncQueueCode(code);
    syncHistoryCode(code);
  }
}

/** Mirror of TemplatePicker.handleCreateAndApply after the fix. */
function createAndApply(name: string): { clientPath: string; newPagePath: string } {
  const filePath = store.get(activeFilePathAtom);
  flushNow();
  sealPendingHistory();
  const clientPath = createTemplate(name)!;
  expect(clientPath).toBeTruthy();
  store.set(projectVersionAtom, (v) => v + 1);
  const createdName = clientPath.match(/^app\/\(([^)]+)\)\//)![1];
  // applyTemplate body:
  flushNow();
  sealPendingHistory();
  const newPagePath = assignTemplate(filePath, createdName);
  store.set(activeFilePathAtom, newPagePath);
  store.set(projectVersionAtom, (v) => v + 1);
  pushHistoryFileOp(filePath);
  // switch into the template:
  switchActiveFile(newPagePath, clientPath,
    {
      setActiveFile: (p) => store.set(activeFilePathAtom, p),
      setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
      setUpdatingFromCanvas: (v) => store.set(updatingFromCanvasAtom, v),
    },
    { syncQueueCode, flushNow },
  );
  runLifecycleEffects();
  return { clientPath, newPagePath };
}

describe('template create → undo → re-create', () => {
  beforeEach(() => {
    projectFS.loadSnapshot(new Map([
      ['app/page.tsx', PAGE_SERVER],
      ['app/page.client.tsx', PAGE_CLIENT],
      ['components/KaFiBi.tsx', HEADER],
      ['app/globals.css', 'body {}'],
    ]));
    store.set(activeFilePathAtom, 'app/page.client.tsx');
    store.set(projectVersionAtom, (v) => v + 1);
    initMutationQueue(store.get(codeAtom), () => {}, undefined, () => {});
    initHistory(store.get(codeAtom), () => {}, () => store.get(activeFilePathAtom), () => store.set(projectVersionAtom, v => v + 1), {
      get: () => store.get(selectedIdsAtom),
      set: (ids) => store.set(selectedIdsAtom, ids),
      getNodeIds: () => new Set(store.get(nodesAtom).keys()),
      navigateToFile: (to: string) => {
        const from = store.get(activeFilePathAtom);
        if (!to || to === from || projectFS.readFile(to) == null) return false;
        switchActiveFile(from, to, {
          setActiveFile: (p) => store.set(activeFilePathAtom, p),
          setSelectedIds: (ids) => store.set(selectedIdsAtom, ids),
          setUpdatingFromCanvas: (v) => store.set(updatingFromCanvasAtom, v),
        }, { syncQueueCode, flushNow });
        const newCode = projectFS.readFile(to) ?? '';
        store.set(codeAtom, newCode);
        syncQueueCode(newCode);
        return true;
      },
    });
    runLifecycleEffects();
  });

  const assertTemplateView = (label: string) => {
    const active = store.get(activeFilePathAtom);
    const code = store.get(codeAtom);
    const nodes = store.get(nodesAtom);
    const ids = [...nodes.keys()];
    console.log(`[${label}] active=${active} codeLen=${code.length} nodeIds=${ids.join(',')}`);
    expect(active).toBe('app/(Body)/LayoutClient.tsx');
    expect(code).toContain('LayoutClient');
    // THE BUG: page nodes leaking into the template view.
    expect(ids).not.toContain('hero-1');
    expect(ids).not.toContain('p-hero');
    expect(ids).toContain('children-slot');
  };

  it('create #1 → template view is clean', () => {
    createAndApply('Body');
    assertTemplateView('create1');
  });

  it('create → undo → re-create → template view is STILL clean', () => {
    createAndApply('Body');
    assertTemplateView('create1');

    // Cmd+Z
    expect(undo()).toBe(true);
    finishPendingRestore();
    runLifecycleEffects();
    console.log('[after-undo] active=', store.get(activeFilePathAtom), 'templateExists=', projectFS.exists('app/(Body)/LayoutClient.tsx'));
    expect(store.get(activeFilePathAtom)).toBe('app/page.client.tsx');
    expect(projectFS.exists('app/(Body)/LayoutClient.tsx')).toBe(false);
    expect(projectFS.exists('app/page.client.tsx')).toBe(true);

    // Re-create
    createAndApply('Body');
    assertTemplateView('create2');
  });
});
