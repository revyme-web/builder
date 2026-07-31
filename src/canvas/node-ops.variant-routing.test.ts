// Pins the ISSUE-2 fix: updateNodeStyles on an svg GROUP CHILD must route the
// box (left/top/width/height) by interaction context —
//   • PRIMARY viewport  → shared x/y/width/height ATTRS via moveChildAndRefitGroup
//   • component VARIANT → variant entry via replica-context (updateVariantStyle
//     with width/height + x/y translate deltas); the shared redirect must NOT
//     hijack the write (isVariantTileBoxWrite bypass), and the group-normalize
//     path must not re-base the shared viewBox either.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/code/svg/refit-group', () => ({
  moveChildAndRefitGroup: vi.fn(() => null),
  refitGroupChain: vi.fn(),
  normalizeGroupOnResize: vi.fn(),
}));
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  // A variant-entry write that CLEARS a key (this test's `width: ''` /
  // `height: ''`) is an override REMOVAL — node-ops forces a render for it, so
  // the canvas falls back to the base merge instead of painting the property
  // as simply absent. See `render-resolved-mutations.ts`.
  setForceRender: vi.fn(),
}));
vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (p: string) => p.startsWith('components/'),
  getLayoutForPage: () => null,
  isLayoutFile: () => false,
}));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('@/code/variants/variant-config', () => ({ parseVariantConfig: () => [] }));

import { updateNodeStyles, setStyleContext } from './node-ops';
import { setActiveBridge } from './canvas-bridge';
import { getDefaultStore } from 'jotai';
import { nodesAtom } from '@/code/stores/store';
import { queueMutation, setForceRender } from '@/code/mutation/mutation-queue';
import { moveChildAndRefitGroup, normalizeGroupOnResize } from '@/code/svg/refit-group';
import type { CanvasNode } from '@/code/parsing/parser';

const mkNode = (partial: Partial<CanvasNode>): CanvasNode => ({
  id: '', type: 'div', name: '', parentId: null, children: [],
  styles: {}, attrs: {}, textContent: '', hasMixedContent: false,
  order: 0,
  ...partial,
} as unknown as CanvasNode);

const stubBridge = {
  getRect: () => null,
  getChildRects: () => [],
  getComputedValue: () => '',
  getComputedValues: () => ({}),
  getContainerRect: () => null,
  getElementIdsAtPoint: () => [],
  patchStyles: vi.fn(),
  patchAttrsAndStyles: vi.fn(),
  injectCSS: vi.fn(),
  removeCSS: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  setActiveBridge(stubBridge);
  const nodes = new Map<string, CanvasNode>();
  nodes.set('group-1', mkNode({
    id: 'group-1', type: 'svg', parentId: 'frame-1', children: ['shape-1'],
    attrs: { viewBox: '0 0 610 259' }, styles: { width: '610px', height: '259px' },
  }));
  nodes.set('shape-1', mkNode({
    id: 'shape-1', type: 'svg', parentId: 'group-1', children: [],
    attrs: { x: '0', y: '0', width: '199', height: '130', viewBox: '0 0 199 130' },
  }));
  nodes.set('frame-1', mkNode({ id: 'frame-1', type: 'div', children: ['group-1'] }));
  getDefaultStore().set(nodesAtom, nodes);
});

const contentEl = document.createElement('div');
const BOX = { width: '300px', height: '196px', left: '35px', top: '0px' };

describe('updateNodeStyles — svg group child box routing', () => {
  it('PRIMARY: routes through the shared attr redirect (moveChildAndRefitGroup)', () => {
    setStyleContext('components/Card.tsx', 'desktop', 1200);
    updateNodeStyles({ id: 'shape-1', styles: { ...BOX }, contentEl });
    expect(moveChildAndRefitGroup).toHaveBeenCalledWith(
      'components/Card.tsx', 'group-1', 'shape-1',
      expect.objectContaining({ width: '300', height: '196', x: '35', y: '0' }),
    );
    const variantWrites = vi.mocked(queueMutation).mock.calls
      .filter(([m]: any[]) => m.type === 'updateVariantStyle');
    expect(variantWrites).toHaveLength(0);
  });

  it('VARIANT: bypasses the redirect — box becomes scale + compensated deltas in the variant entry', async () => {
    setStyleContext('components/Card.tsx', 'variant-1', 1200);
    updateNodeStyles({ id: 'shape-1', styles: { ...BOX }, contentEl });
    // the folded preview coalesces same-task fragments and applies on a microtask
    await Promise.resolve();
    expect(moveChildAndRefitGroup).not.toHaveBeenCalled();
    const variantWrites = vi.mocked(queueMutation).mock.calls
      .map(([m]: any[]) => m)
      .filter((m: any) => m.type === 'updateVariantStyle' && m.variantName === 'variant-1');
    expect(variantWrites.length).toBeGreaterThan(0);
    const styles = Object.assign({}, ...variantWrites.map((m: any) => m.styles));
    // width/height → scaleX/scaleY vs the 199×130 base attrs; the dead CSS
    // channel is cleared (Chromium doesn't paint CSS size on nested svg).
    expect(parseFloat(styles.scaleX)).toBeCloseTo(300 / 199, 3);
    expect(parseFloat(styles.scaleY)).toBeCloseTo(196 / 130, 3);
    expect(styles.width).toBe('');
    expect(styles.height).toBe('');
    // left 35 with center-origin compensation: 35 + 199·(sx − 1)/2
    expect(parseFloat(styles.x)).toBeCloseTo(35 + 199 * (300 / 199 - 1) / 2, 2);
    // the view-box px carrier rides the same flush (pivot at the attr-box centre)
    const carrier = vi.mocked(queueMutation).mock.calls
      .map(([m]: any[]) => m)
      .find((m: any) => m.type === 'updateStyles' && m.styles?.transformBox === 'view-box');
    expect(carrier).toBeTruthy();
    expect(carrier.styles.transformOrigin).toBe('99.5px 65px');
    // instant per-tile visual: the FOLDED wrapper transform (the commit's own
    // paint channel) with the view-box carrier — attr patches would relocate
    // the box in the BASE frame under the existing fold.
    const previewCall = stubBridge.patchStyles.mock.calls.find(
      ([id, prefix, s]: any[]) => id === 'shape-1' && prefix === 'variant-1-' && s.transform,
    );
    expect(previewCall).toBeTruthy();
    expect(previewCall[2].transform).toContain('scaleX(');
    expect(previewCall[2].transform).toContain('translateX(');
    expect(previewCall[2].transformBox).toBe('view-box');
    expect(previewCall[2].transformOrigin).toBe('99.5px 65px');
    // The variant entry CLEARS width/height ('' = remove). A removal routed
    // into variant storage is invisible to the instant patch — clearing the
    // inline drops the property instead of falling back to the base merge — so
    // it must force a render. Guarding only `updateContainerStyle` (the old
    // behaviour) is why variant resets updated the code but not the canvas.
    expect(setForceRender).toHaveBeenCalled();
  });

  it('VARIANT preview: same-task box FRAGMENTS coalesce into ONE consistent folded patch', async () => {
    // ResizeManager patches height / left / top in separate calls within one
    // tick. Converting each fragment alone produced three contradictory
    // transforms per frame (trace 2026-06-12: {height}→scaleY 0.8794 then
    // {top}→scaleY 0.9548 in the same millisecond — "jumps in random areas").
    setStyleContext('components/Card.tsx', 'variant-1', 1200);
    const { patchNodeStyles } = await import('./node-ops');
    patchNodeStyles(contentEl, 'shape-1', 'variant-1-', { height: '175px' });
    patchNodeStyles(contentEl, 'shape-1', 'variant-1-', { left: '26px' });
    patchNodeStyles(contentEl, 'shape-1', 'variant-1-', { top: '52px' });
    await Promise.resolve();
    const transformPatches = stubBridge.patchStyles.mock.calls
      .filter(([id, prefix, s]: any[]) => id === 'shape-1' && prefix === 'variant-1-' && s.transform);
    expect(transformPatches).toHaveLength(1);
    const folded = transformPatches[0][2].transform as string;
    // merged conversion: sy = 175/130, y = (52 − 0) + 130·(sy − 1)/2,
    // x = (26 − 0) + 199·(prevSx=1 − 1)/2 = 26 — one self-consistent triple.
    expect(folded).toContain(`scaleY(${Math.round((175 / 130) * 10000) / 10000})`);
    expect(folded).toContain('translateX(26px)');
    expect(folded).toContain(`translateY(${Math.round((52 + 130 * (175 / 130 - 1) / 2) * 10000) / 10000}px)`);
  });

  it('VARIANT: group self-resize skips the shared normalize (per-variant box)', () => {
    setStyleContext('components/Card.tsx', 'variant-1', 1200);
    updateNodeStyles({ id: 'group-1', styles: { width: '700px', height: '300px' }, contentEl });
    expect(normalizeGroupOnResize).not.toHaveBeenCalled();
    const variantWrites = vi.mocked(queueMutation).mock.calls
      .map(([m]: any[]) => m)
      .filter((m: any) => m.type === 'updateVariantStyle' && m.variantName === 'variant-1');
    const styles = Object.assign({}, ...variantWrites.map((m: any) => m.styles));
    expect(styles.width).toBe('700px');
  });

  it('PRIMARY: group self-resize still normalizes the shared viewBox', () => {
    setStyleContext('components/Card.tsx', 'desktop', 1200);
    updateNodeStyles({ id: 'group-1', styles: { width: '700px', height: '300px' }, contentEl });
    expect(normalizeGroupOnResize).toHaveBeenCalled();
  });
});
