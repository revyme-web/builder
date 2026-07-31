// ParentHighlight.test.ts — Pure unit tests for the selection→parent
// derivation. The full component renders an overlay rect using the iframe
// bridge's rectCache (not present in jsdom), so we test the derivation
// function in isolation. The component is a thin shell over this function.

import { describe, test, expect, vi } from 'vitest';
import { deriveSelectionParentHighlight } from './ParentHighlight';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

// Component renders an SVG polygon from getScreenCornersById, which reads
// the bridge's cornersCache (not present in jsdom). The pure helper we
// test below doesn't touch corners at all — these mocks just keep the
// import graph happy when vitest pulls in the file.
vi.mock('@/canvas/resize/geometry-utils', async () => {
  const actual = await vi.importActual<typeof import('@/canvas/resize/geometry-utils')>(
    '@/canvas/resize/geometry-utils',
  );
  return { ...actual, getScreenCornersById: vi.fn(() => null) };
});

function makeNodes(entries: Array<{ id: string; parentId?: string | null }>) {
  return new Map(entries.map((e) => [e.id, { parentId: e.parentId ?? null }]));
}

const baseArgs = {
  vpId: 'desktop',
  isInteracting: false,
  isTextEditing: false,
  dragInfo: null,
};

describe('deriveSelectionParentHighlight', () => {
  test('returns the parent of the selected node', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'frame', parentId: 'root' },
      { id: 'cta', parentId: 'frame' },
    ]);
    const info = deriveSelectionParentHighlight({
      ...baseArgs,
      selectedId: 'cta',
      nodes,
    });
    expect(info).toEqual({ parentId: 'frame', vpId: 'desktop' });
  });

  test('returns null when nothing is selected', () => {
    expect(
      deriveSelectionParentHighlight({ ...baseArgs, selectedId: null, nodes: makeNodes([]) }),
    ).toBeNull();
  });

  test('returns null when viewport root is selected (no useful parent)', () => {
    const nodes = makeNodes([{ id: 'root', parentId: null }]);
    expect(
      deriveSelectionParentHighlight({ ...baseArgs, selectedId: 'root', nodes }),
    ).toBeNull();
  });

  test('returns null when selected node is missing from the map', () => {
    expect(
      deriveSelectionParentHighlight({
        ...baseArgs,
        selectedId: 'ghost',
        nodes: makeNodes([{ id: 'other', parentId: null }]),
      }),
    ).toBeNull();
  });

  test('returns null when the parent itself is missing (orphan)', () => {
    const nodes = makeNodes([{ id: 'cta', parentId: 'frame' }]);
    expect(
      deriveSelectionParentHighlight({ ...baseArgs, selectedId: 'cta', nodes }),
    ).toBeNull();
  });

  test('drag info preempts the selection-derived highlight', () => {
    // Drag strategies own the highlight while a drag is in flight — the
    // component reads the dragInfo path itself, but this guard ensures we
    // don't ALSO emit a selection-derived target that fights the drag one.
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'frame', parentId: 'root' },
      { id: 'cta', parentId: 'frame' },
    ]);
    expect(
      deriveSelectionParentHighlight({
        ...baseArgs,
        selectedId: 'cta',
        nodes,
        dragInfo: { parentId: 'somewhere-else', vpId: 'desktop' },
      }),
    ).toBeNull();
  });

  test('canvas interactions alone do NOT suppress the highlight (dragInfo does)', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'cta', parentId: 'root' },
    ]);
    // isInteracting no longer suppresses on its own — drags override via
    // dragInfo, and non-writing drags (SVG-group child) KEEP the outline.
    expect(
      deriveSelectionParentHighlight({
        ...baseArgs,
        selectedId: 'cta',
        nodes,
        isInteracting: true,
      }),
    ).toEqual({ parentId: 'root', vpId: 'desktop' });
  });

  test('text editing suppresses the highlight', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'cta', parentId: 'root' },
    ]);
    expect(
      deriveSelectionParentHighlight({
        ...baseArgs,
        selectedId: 'cta',
        nodes,
        isTextEditing: true,
      }),
    ).toBeNull();
  });

  test('passes through the active vpId so replicas highlight their own viewport', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'frame', parentId: 'root' },
      { id: 'cta', parentId: 'frame' },
    ]);
    const info = deriveSelectionParentHighlight({
      ...baseArgs,
      selectedId: 'cta',
      nodes,
      vpId: 'tablet',
    });
    expect(info?.vpId).toBe('tablet');
  });

  // Handle-resize: the dashed parent border hugs the box whose handles the user
  // is dragging, so it competes with them for exactly the region being
  // manipulated. Hidden for the gesture, restored on pointer-up (user request
  // 2026-07-26). The signal is `resizeLiveOps` — active between ResizeManager's
  // first pointermove and its pointerup.
  test('returns null while a handle-resize is in flight', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'frame', parentId: 'root' },
      { id: 'cta', parentId: 'frame' },
    ]);
    expect(
      deriveSelectionParentHighlight({ ...baseArgs, selectedId: 'cta', nodes, isResizing: true }),
    ).toBeNull();
  });

  test('comes back once the resize ends', () => {
    const nodes = makeNodes([
      { id: 'root', parentId: null },
      { id: 'frame', parentId: 'root' },
      { id: 'cta', parentId: 'frame' },
    ]);
    expect(
      deriveSelectionParentHighlight({ ...baseArgs, selectedId: 'cta', nodes, isResizing: false }),
    ).toEqual({ parentId: 'frame', vpId: 'desktop' });
  });
});
