// A component master's CHILD must follow the primary's position on the variant
// tiles DURING a resize or a Position-panel scrub — not only on release.
//
// The mirror skipped left/top/right/bottom for every commit-time write in a
// component file. That skip exists for the master ROOT, whose tiles each sit at
// their own variantConfig x/y, but it was applied to children too: mid-gesture
// they kept stale insets while their size changed, so the replicas grew around
// the wrong anchor, drifted off, and snapped into place on mouse-up (user
// report 2026-09-20).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() },
}));
vi.mock('@/code/svg/refit-group', () => ({
  moveChildAndRefitGroup: vi.fn(() => null), refitGroupChain: vi.fn(), normalizeGroupOnResize: vi.fn(),
}));
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(), flushNow: vi.fn(), setForceRender: vi.fn(),
}));
vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (p: string) => p.startsWith('components/'),
  getLayoutForPage: () => null, isLayoutFile: () => false,
}));
vi.mock('@/code/project/project-fs', () => ({ projectFS: { readFile: () => '' } }));
vi.mock('@/code/variants/variant-config', () => ({ parseVariantConfig: () => [] }));

import { updateNodeStyles, setStyleContext } from './node-ops';
import { setActiveBridge } from './canvas-bridge';
import { injectNodeIntoCache } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';

const patchStyles = vi.fn();
const rectCache = new Map<string, DOMRect>();
const stubBridge = {
  getRect: () => null, getChildRects: () => [], getComputedValue: () => '',
  getComputedValues: () => ({}), getContainerRect: () => null,
  getElementIdsAtPoint: () => [], patchAttrsAndStyles: vi.fn(),
  injectCSS: vi.fn(), removeCSS: vi.fn(), patchStyles, rectCache,
} as any;

const CHILD = 'frame-child-1';
const ROOT = 'frame-root-1';

function seed() {
  injectNodeIntoCache({
    id: ROOT, type: 'div', name: 'Frame', parentId: null, children: [CHILD],
    styles: { width: '807px', height: '474px' }, textContent: '', attrs: {},
    motionVariants: { 'variant-1': {} },
  } as unknown as CanvasNode);
  injectNodeIntoCache({
    id: CHILD, type: 'div', name: 'Frame', parentId: ROOT, children: [],
    styles: { position: 'absolute', left: '361px', top: '72px', width: '239px', height: '248px' },
    textContent: '', attrs: {}, motionVariants: { 'variant-1': {} },
  } as unknown as CanvasNode);
}

/** Styles fanned to the variant-1 tile, or null if it wasn't patched. */
function variantPatch(): Record<string, string> | null {
  const call = patchStyles.mock.calls.find(([, prefix]: any[]) => prefix === 'variant-1-');
  return call ? call[2] : null;
}

const contentEl = document.createElement('div');

beforeEach(() => {
  vi.clearAllMocks();
  rectCache.clear();
  setActiveBridge(stubBridge);
  setStyleContext('components/DaBiZa.tsx', 'desktop', 1440);
});

describe('position mirroring to a component master variant tile', () => {
  beforeEach(() => {
    seed();
    rectCache.set(`:${CHILD}`, new DOMRect(0, 0, 239, 248));
    rectCache.set(`variant-1-:${CHILD}`, new DOMRect(0, 0, 239, 248));
    rectCache.set(`:${ROOT}`, new DOMRect(0, 0, 807, 474));
    rectCache.set(`variant-1-:${ROOT}`, new DOMRect(0, 0, 807, 474));
  });

  it('mirrors a CHILD position on a commit-time write', () => {
    updateNodeStyles({ id: CHILD, styles: { left: '400px', top: '90px', width: '200px' }, contentEl });
    const patch = variantPatch();
    expect(patch).toBeTruthy();
    expect(patch!.left, 'the replica must follow the primary, not lag to mouse-up').toBe('400px');
    expect(patch!.top).toBe('90px');
    expect(patch!.width).toBe('200px');
  });

  it('mirrors a CHILD position on a live tick too', () => {
    updateNodeStyles({ id: CHILD, styles: { left: '400px' }, contentEl, domOnly: true });
    expect(variantPatch()?.left).toBe('400px');
  });

  // The reason the skip exists: each tile's ROOT sits at its own variantConfig
  // x/y, so fanning the primary's insets yanks every tile onto the primary.
  it('never mirrors the master ROOT position on a commit write', () => {
    updateNodeStyles({ id: ROOT, styles: { left: '400px', top: '90px', width: '900px' }, contentEl });
    const patch = variantPatch();
    if (patch) {
      expect(patch.left, 'root insets must not fan out').toBeUndefined();
      expect(patch.top).toBeUndefined();
      expect(patch.width).toBe('900px');   // size still mirrors
    }
  });

  it('still drops a key the variant owns', () => {
    injectNodeIntoCache({
      id: CHILD, type: 'div', name: 'Frame', parentId: ROOT, children: [],
      styles: { position: 'absolute', left: '361px', top: '72px' },
      textContent: '', attrs: {}, motionVariants: { 'variant-1': { left: '10px' } },
    } as unknown as CanvasNode);
    updateNodeStyles({ id: CHILD, styles: { left: '400px', top: '90px' }, contentEl });
    const patch = variantPatch();
    if (patch) {
      expect(patch.left, "the variant's own left must survive").toBeUndefined();
      expect(patch.top).toBe('90px');
    }
  });
});
