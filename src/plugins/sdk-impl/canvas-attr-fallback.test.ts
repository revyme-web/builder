// canvas-attr-fallback.test.ts — `canvas.getNodesWithAttribute` must find a
// JUST-DROPPED node by its data marker even while the parsed model lags the
// code. The imperative-first drop path injects the new node into the cache
// with EMPTY attrs and defers the parse fan-out, so a plugin's post-drop
// marker poll (Brand Logos repair) came back empty forever and the repair
// never applied (live find 2026-07-28). The handler now falls back to
// scanning the ACTIVE FILE's code.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
vi.mock('@/canvas/node-ops', () => ({
  findNodeRect: vi.fn(), getContentRoot: vi.fn(), removeNode: vi.fn(),
  updateNodeStyles: vi.fn(), getViewportPrefix: vi.fn(() => ''),
}));
vi.mock('@/canvas/transform', () => ({ zoomToFitNodes: vi.fn() }));
vi.mock('@/code/project/modify-file', () => ({ modifyProjectFile: vi.fn() }));
vi.mock('@/code/generation/generator-crud', () => ({ addNodeInCode: vi.fn(), moveNodeInCode: vi.fn() }));
vi.mock('@/code/stores/viewport-store', async () => {
  const { atom } = await import('jotai');
  return { interactingViewportIdAtom: atom<string | null>(null) };
});
vi.mock('@/code/stores/store', async () => {
  const { atom } = await import('jotai');
  return {
    selectedIdsAtom: atom<string[]>([]),
    // The just-dropped node as the imperative cache holds it: attrs EMPTY —
    // the marker only exists in the code.
    nodesAtom: atom(new Map([
      ['fresh-1', { id: 'fresh-1', type: 'div', name: 'Aliexpress', attrs: {}, styles: {}, children: [] }],
    ])),
  };
});
vi.mock('@/code/project/active-file-store', async () => {
  const { atom } = await import('jotai');
  return { activeFilePathAtom: atom('app/page.client.tsx') };
});
vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: vi.fn(() =>
      `const canvasNodes = (<>
        <div data-id="fresh-1" data-name="Aliexpress" data-brandlogo="bl-test-1" data-canvas-node="true" style={{ width: '200px' }} />
      </>);`),
  },
}));

import { canvasHandlers } from './canvas';

const ctx = { manifest: { id: 't', name: 't', version: '1', entry: '/', sdkVersion: '^1.0.0', mode: 'panel', permissions: [] } } as never;

describe('canvas.getNodesWithAttribute — code fallback for the just-dropped window', () => {
  it('finds the marker in the CODE when the model node has empty attrs', async () => {
    const ids = await canvasHandlers['canvas.getNodesWithAttribute']({ attr: 'data-brandlogo', value: 'bl-test-1' }, ctx);
    expect(ids).toEqual(['fresh-1']);
  });

  it('an unknown marker still returns []', async () => {
    const ids = await canvasHandlers['canvas.getNodesWithAttribute']({ attr: 'data-brandlogo', value: 'bl-nope' }, ctx);
    expect(ids).toEqual([]);
  });

  it('value-less lookups stay model-only (no code scan)', async () => {
    const ids = await canvasHandlers['canvas.getNodesWithAttribute']({ attr: 'data-brandlogo' }, ctx);
    expect(ids).toEqual([]);
  });
});
