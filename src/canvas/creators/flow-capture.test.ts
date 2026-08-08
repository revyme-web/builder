// flow-capture.test.ts — drawing a frame over flow siblings must adopt them.
//
// User report 2026-08-08: drawing a frame fully over five texts inside a layout
// did nothing — the frame landed as a bare SIBLING and the texts stayed put.
// `createNode` inserts the frame into the parent's flow SYNCHRONOUSLY
// (`parentEl.insertBefore`), so by the time containment was tested every text
// had already been pushed down by the new frame's height. Measurement now runs
// BEFORE the insert; these pin both halves.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CanvasNode } from '@/code/parsing/parser';

const canvasRects = new Map<string, { left: number; top: number; width: number; height: number }>();
const childIds: string[] = [];

vi.mock('@/canvas/canvas-math', () => ({
  getAbsoluteCanvasRectById: (id: string) => canvasRects.get(id) ?? null,
}));
vi.mock('@/canvas/node-ops', () => ({
  findChildRects: () => childIds.map((id) => ({ id, rect: {} })),
  getNodeHitsAtPoint: () => [], findNodeComputedStyles: () => ({}), findRootHitAtPoint: () => null,
  findNodeRect: () => null, getActiveFilePath: () => '', getContentRoot: () => null,
  getViewportPrefix: () => '', vpIdFromPrefix: () => 'desktop', createNode: vi.fn(),
}));
const queued: any[] = [];
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (m: any) => queued.push(m),
  getCurrentCode: () => '',
  flushNow: vi.fn(),
}));

import { collectFlowCaptures, queueFlowCaptures } from './FrameCreator';

const node = (id: string, styles: Record<string, string> = {}): CanvasNode =>
  ({ id, type: 'p', name: id, parentId: 'layout', children: [], styles, textContent: 'x' }) as unknown as CanvasNode;

/** The reported scene: a 149×149 frame drawn over five stacked texts. */
function scene() {
  canvasRects.clear(); childIds.length = 0; queued.length = 0;
  const nodes = new Map<string, CanvasNode>();
  for (let i = 0; i < 5; i++) {
    const id = `text-${i}`;
    nodes.set(id, node(id, { position: 'relative', flex: '0 0 auto', order: String(i) }));
    childIds.push(id);
    canvasRects.set(id, { left: 220, top: 170 + i * 26, width: 100, height: 20 });
  }
  return nodes;
}

const drawn = { left: 200, top: 150, width: 149, height: 149 };

describe('collectFlowCaptures', () => {
  beforeEach(() => { scene(); });

  it('captures every fully-covered flow sibling', () => {
    const nodes = scene();
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    expect(caps.map((c) => c.id)).toEqual(['text-0', 'text-1', 'text-2', 'text-3', 'text-4']);
  });

  it('skips a sibling that sticks out of the drawn rect', () => {
    const nodes = scene();
    canvasRects.set('text-4', { left: 220, top: 170 + 4 * 26, width: 400, height: 20 }); // too wide
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    expect(caps.map((c) => c.id)).not.toContain('text-4');
  });

  it('leaves absolute siblings to the absolute path', () => {
    const nodes = scene();
    nodes.set('text-2', node('text-2', { position: 'absolute' }));
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    expect(caps.map((c) => c.id)).not.toContain('text-2');
  });
});

describe('queueFlowCaptures', () => {
  beforeEach(() => { scene(); });

  it('reparents every captured child into the new frame', () => {
    const nodes = scene();
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    const ids = queueFlowCaptures(caps, 'new-frame', drawn);
    expect(ids).toHaveLength(5);
    const moves = queued.filter((m) => m.type === 'move');
    expect(moves).toHaveLength(5);
    expect(moves.every((m) => m.newParentId === 'new-frame')).toBe(true);
    expect(moves.every((m) => m.styles.position === 'absolute')).toBe(true);
  });

  it('a MULTI capture keeps the composition — never stacks them on one point', () => {
    const nodes = scene();
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    queueFlowCaptures(caps, 'new-frame', drawn);
    const tops = queued.filter((m) => m.type === 'move').map((m) => m.styles.top);
    // Frame origin is (200,150); the texts sit at x=220, y=170,196,222,248,274.
    expect(tops).toEqual(['20px', '46px', '72px', '98px', '124px']);
    expect(new Set(tops).size).toBe(5); // the stacking bug would give 1
    expect(queued.filter((m) => m.type === 'move')[0].styles.left).toBe('20px');
  });

  it('a SINGLE capture still centres (the 2026-07-23 spec)', () => {
    const nodes = scene();
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    }).slice(0, 1);
    queued.length = 0;
    queueFlowCaptures(caps, 'new-frame', drawn);
    const m = queued.find((q) => q.type === 'move')!;
    expect(m.styles.left).toBe(`${Math.round((149 - 100) / 2)}px`);
    expect(m.styles.top).toBe(`${Math.round((149 - 20) / 2)}px`);
  });

  it('clears the flow props that belonged to the old layout parent', () => {
    const nodes = scene();
    const caps = collectFlowCaptures({
      newFrameId: 'new-frame', newFrameRect: drawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    queueFlowCaptures(caps, 'new-frame', drawn);
    const s = queued.find((m) => m.type === 'move')!.styles;
    // Margins still apply to an absolute box and would offset it off left/top.
    for (const k of ['flex', 'order', 'alignSelf', 'marginTop', 'margin']) expect(s[k]).toBe('');
  });
});

// The actual blocker (found on the second report): `useLocalSpace` is true for
// EVERY draw inside a parent — the map is built unconditionally and, for a plain
// parent, collapses to "axis-aligned at the PARENT's screen origin". So the
// drawn left/top were PARENT-LOCAL while the child rects are CANVAS-space: two
// different origins, and containment could essentially never hold.
describe('containment runs in ONE space', () => {
  beforeEach(() => { scene(); });

  it('a parent-local rect would miss what a canvas-space rect captures', () => {
    const nodes = scene();
    const canvasDrawn = { left: 200, top: 150, width: 149, height: 149 };
    // The same gesture expressed parent-local (parent origin at canvas 180,140).
    const localDrawn = { left: 20, top: 10, width: 149, height: 149 };

    const withCanvas = collectFlowCaptures({
      newFrameId: 'f', newFrameRect: canvasDrawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    const withLocal = collectFlowCaptures({
      newFrameId: 'f', newFrameRect: localDrawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    expect(withCanvas).toHaveLength(5);   // what the user drew
    expect(withLocal).toHaveLength(0);    // the shipped bug
  });

  it('placement converts canvas deltas into the FRAME\'s space under a scaled parent', () => {
    const nodes = scene();
    const canvasDrawn = { left: 200, top: 150, width: 200, height: 200 };
    const caps = collectFlowCaptures({
      newFrameId: 'f', newFrameRect: canvasDrawn, parentId: 'layout', vpId: 'desktop',
      nodes, transform: { x: 0, y: 0, scale: 1 } as any,
    });
    queued.length = 0;
    // Parent scaled 0.5 → the frame's own box is half its canvas footprint.
    queueFlowCaptures(caps, 'f', canvasDrawn, { width: 100, height: 100 });
    const first = queued.find((m) => m.type === 'move')!.styles;
    // Canvas delta (220-200, 170-150) = (20,20) → frame-local (10,10).
    expect(first.left).toBe('10px');
    expect(first.top).toBe('10px');
  });
});
