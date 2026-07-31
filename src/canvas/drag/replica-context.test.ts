// replica-context.test.ts — Tests for ReplicaContext routing logic.
//
// Covers all 4 routing combinations:
//   1. Page primary (desktop)
//   2. Page replica (tablet)
//   3. Component primary (desktop on component file)
//   4. Component replica (variant-1)

import { describe, test, expect, vi } from 'vitest';
import { getReplicaContext } from './replica-context';

// Mock trace to prevent side effects
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

// Mock isPrimaryViewport — mirrors real logic: 'desktop' and 'default' are primary
vi.mock('@/canvas/node-ops', () => ({
  isPrimaryViewport: (vpId: string) => vpId === 'desktop' || vpId === 'default',
}));

// Mock isComponentFilePath — mirrors real logic: starts with 'components/'
vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (path: string) => path.startsWith('components/'),
}));

// Mock projectFS — returns empty source so parseVariantConfig fails and
// the test exercises the vpWidths-based fallback for `allVariants`.
vi.mock('@/code/project/project-fs', () => ({
  projectFS: { readFile: () => '' },
}));

// Mock parseVariantConfig to return [] (no variantConfig parsed) so
// replica-context uses the vpWidths-keys fallback.
vi.mock('@/code/variants/variant-config', () => ({
  parseVariantConfig: () => [],
}));

// Mock node store helpers used by hideInThis + deleteUpdate. A vi.fn so
// individual tests can stub a node's hiddenOnVariants set.
vi.mock('@/code/stores/store', () => ({
  getNodeFromCache: vi.fn(() => null),
}));
import { getNodeFromCache } from '@/code/stores/store';

// ─── Common fixtures ────────────────────────────────────────────────────────

const PAGE_WIDTHS: Record<string, number> = {
  desktop: 1440,
  tablet: 768,
  mobile: 375,
};

const COMPONENT_WIDTHS: Record<string, number> = {
  default: 400,
  'variant-1': 400,
  'variant-2': 400,
};

const PAGE_PATH = 'app/page.tsx';
const COMPONENT_PATH = 'components/Card.tsx';

// ─── 1. Page Primary (desktop) ──────────────────────────────────────────────

describe('Page Primary (desktop)', () => {
  const ctx = getReplicaContext('desktop', PAGE_PATH, PAGE_WIDTHS);

  test('flags are correct', () => {
    expect(ctx.isPrimary).toBe(true);
    expect(ctx.isComponent).toBe(false);
    expect(ctx.vpId).toBe('desktop');
    expect(ctx.variantName).toBeNull();
    expect(ctx.vpWidth).toBe(1440);
  });

  test('styleUpdate returns inline style only', () => {
    const updates = ctx.styleUpdate('node-1', { color: 'red' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      nodeId: 'node-1',
      type: 'style',
      styles: { color: 'red' },
    });
  });

  test('hideInThis hides via updateContainerStyle', () => {
    const update = ctx.hideInThis('node-1');
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 1440,
      styles: { display: 'none' },
    });
  });

  test('hideInAllOthers hides tablet + mobile', () => {
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(2);

    const tabletUpdate = updates.find(u => u.maxWidth === 768);
    const mobileUpdate = updates.find(u => u.maxWidth === 375);

    expect(tabletUpdate).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 768,
      styles: { display: 'none' },
    });
    expect(mobileUpdate).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 375,
      styles: { display: 'none' },
    });
  });

  test('deleteUpdate returns remove', () => {
    const contentEl = document.createElement('div');
    const updates = ctx.deleteUpdate('node-1', contentEl);
    expect(updates).toEqual([{ nodeId: 'node-1', type: 'remove' }]);
  });
});

// ─── 2. Page Replica (tablet) ───────────────────────────────────────────────

describe('Page Replica (tablet)', () => {
  const ctx = getReplicaContext('tablet', PAGE_PATH, PAGE_WIDTHS);

  test('flags are correct', () => {
    expect(ctx.isPrimary).toBe(false);
    expect(ctx.isComponent).toBe(false);
    expect(ctx.vpId).toBe('tablet');
    expect(ctx.variantName).toBeNull();
    expect(ctx.vpWidth).toBe(768);
  });

  test('styleUpdate returns updateContainerStyle', () => {
    const updates = ctx.styleUpdate('node-1', { fontSize: '16px' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 768,
      styles: { fontSize: '16px' },
    });
  });

  test('width/height on a PAGE stay updateContainerStyle (conditional split is component-only)', () => {
    // The size→ternary routing must NOT touch pages — only component variants do
    // the layout-FLIP coordination; pages use @media/@container responsive size.
    const updates = ctx.styleUpdate('node-1', { width: '375px', height: '462px' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 768,
      styles: { width: '375px', height: '462px' },
    });
  });

  test('hideInThis returns updateContainerStyle with display:none', () => {
    const update = ctx.hideInThis('node-1');
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'updateContainerStyle',
      maxWidth: 768,
      styles: { display: 'none' },
    });
  });

  test('hideInAllOthers hides desktop + mobile', () => {
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(2);

    const desktopUpdate = updates.find(u => u.maxWidth === 1440);
    const mobileUpdate = updates.find(u => u.maxWidth === 375);

    expect(desktopUpdate).toBeDefined();
    expect(mobileUpdate).toBeDefined();
  });

  test('deleteUpdate: base visible on primary → hide only (no DOM probe needed)', () => {
    // Base style has no display:none → the node renders on the primary → hide here.
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: {} } as any);
    const updates = ctx.deleteUpdate('node-1', document.createElement('div'));
    expect(updates).toEqual([{
      nodeId: 'node-1', type: 'updateContainerStyle', maxWidth: 768, styles: { display: 'none' },
    }]);
  });

  test('deleteUpdate: COMPONENT INSTANCE with no findable DOM in other tiles → still HIDE (the bug)', () => {
    // The reported bug: a component instance's wrapper isn't reachable via the parent-frame
    // querySelector, so the old DOM probe counted 0 visible → full-removed the WHOLE instance.
    // Now we trust metadata: base visible (no display:none) → hide on this replica only.
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: { position: 'absolute' }, componentFile: '@/components/PaMaJo' } as any);
    const updates = ctx.deleteUpdate('frame-x', document.createElement('div')); // empty DOM
    expect(updates).toEqual([{
      nodeId: 'frame-x', type: 'updateContainerStyle', maxWidth: 768, styles: { display: 'none' },
    }]);
  });

  test('deleteUpdate: base hidden on primary AND no other replica → full remove', () => {
    // Only when the base itself is display:none (so the primary doesn't show it) and no
    // other replica shows it does a replica delete fall through to a full remove.
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: { display: 'none' } } as any);
    const updates = ctx.deleteUpdate('node-1', document.createElement('div')); // no replica els
    expect(updates).toEqual([{ nodeId: 'node-1', type: 'remove' }]);
  });

  test('deleteUpdate: base hidden on primary BUT visible on another replica → hide only', () => {
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: { display: 'none' } } as any);
    const contentEl = document.createElement('div');
    const mobileEl = document.createElement('div');
    mobileEl.setAttribute('data-node-id', 'mobile-node-1');
    contentEl.appendChild(mobileEl);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ display: 'block' } as CSSStyleDeclaration);
    const updates = ctx.deleteUpdate('node-1', contentEl);
    expect(updates).toEqual([{
      nodeId: 'node-1', type: 'updateContainerStyle', maxWidth: 768, styles: { display: 'none' },
    }]);
    vi.mocked(window.getComputedStyle).mockRestore();
  });
});

// ─── 3. Component Primary (desktop on component file) ───────────────────────

describe('Component Primary (default)', () => {
  const ctx = getReplicaContext('default', COMPONENT_PATH, COMPONENT_WIDTHS);

  test('flags are correct', () => {
    expect(ctx.isPrimary).toBe(true);
    expect(ctx.isComponent).toBe(true);
    expect(ctx.vpId).toBe('default');
    expect(ctx.variantName).toBeNull();
    expect(ctx.vpWidth).toBe(400);
  });

  test('styleUpdate returns inline + variantStyle("default")', () => {
    const updates = ctx.styleUpdate('node-1', { opacity: '0.5' });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({
      nodeId: 'node-1',
      type: 'style',
      styles: { opacity: '0.5' },
    });
    expect(updates[1]).toEqual({
      nodeId: 'node-1',
      type: 'updateVariantStyle',
      variantName: 'default',
      styles: { opacity: '0.5' },
    });
  });

  test('component INSTANCE: skips the plain `style` write (only updateVariantStyle) so it cannot clobber inline ternaries', () => {
    // An instance stores per-variant styles as inline `prop: variant === 'v' ? …`
    // ternaries; a plain `style` write would overwrite the whole expression and
    // wipe sibling-variant overrides (moving on the default tile erased the
    // variant-1 position). Only the default-branch update should be emitted.
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: {}, isCodeComponent: true } as any);
    const updates = ctx.styleUpdate('vector-1', { left: '54px', top: '88px' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      nodeId: 'vector-1',
      type: 'updateVariantStyle',
      variantName: 'default',
      styles: { left: '54px', top: '88px' },
    });
    // No plain `type: 'style'` (the clobbering write).
    expect(updates.some(u => u.type === 'style')).toBe(false);
  });

  test('component instance (isComponentInstance flag) also skips the plain write', () => {
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ styles: {}, isComponentInstance: true } as any);
    const updates = ctx.styleUpdate('inst-1', { left: '10px' });
    expect(updates).toHaveLength(1);
    expect(updates[0].type).toBe('updateVariantStyle');
  });

  test('hideInThis emits setVariantVisibility adding "default" to hidden set', () => {
    const update = ctx.hideInThis('node-1');
    expect(update.type).toBe('setVariantVisibility');
    expect(update.nodeId).toBe('node-1');
    expect(update.hiddenVariants).toContain('default');
  });

  test('hideInAllOthers emits ONE setVariantVisibility with all non-current variants', () => {
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.type).toBe('setVariantVisibility');
    expect(u.hiddenVariants).toContain('variant-1');
    expect(u.hiddenVariants).toContain('variant-2');
    expect(u.hiddenVariants).not.toContain('default');
  });

  test('deleteUpdate returns remove', () => {
    const contentEl = document.createElement('div');
    const updates = ctx.deleteUpdate('node-1', contentEl);
    expect(updates).toEqual([{ nodeId: 'node-1', type: 'remove' }]);
  });
});

// ─── 4. Component Replica (variant-1) ───────────────────────────────────────

describe('Component Replica (variant-1)', () => {
  const ctx = getReplicaContext('variant-1', COMPONENT_PATH, COMPONENT_WIDTHS);

  test('flags are correct', () => {
    expect(ctx.isPrimary).toBe(false);
    expect(ctx.isComponent).toBe(true);
    expect(ctx.vpId).toBe('variant-1');
    expect(ctx.variantName).toBe('variant-1');
    expect(ctx.vpWidth).toBe(400);
  });

  test('styleUpdate returns updateVariantStyle', () => {
    const updates = ctx.styleUpdate('node-1', { backgroundColor: 'blue' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      nodeId: 'node-1',
      type: 'updateVariantStyle',
      variantName: 'variant-1',
      styles: { backgroundColor: 'blue' },
    });
  });

  test('width/height route to setConditionalStyle (ternary), NOT the variant object', () => {
    // A per-variant resize must ride the layout FLIP — so size is split out into
    // inline-style ternaries instead of value-tweening in the variants object.
    const updates = ctx.styleUpdate('node-1', { width: '375px', height: '462px' });
    const cond = updates.filter(u => u.type === 'setConditionalStyle');
    expect(cond).toHaveLength(2);
    expect(cond).toContainEqual({ nodeId: 'node-1', type: 'setConditionalStyle', variantName: 'variant-1', prop: 'width', value: '375px' });
    expect(cond).toContainEqual({ nodeId: 'node-1', type: 'setConditionalStyle', variantName: 'variant-1', prop: 'height', value: '462px' });
    // No updateVariantStyle for size.
    expect(updates.some(u => u.type === 'updateVariantStyle')).toBe(false);
  });

  test('a mixed write splits size→ternary, paint→variant object', () => {
    const updates = ctx.styleUpdate('node-1', { width: '375px', backgroundColor: 'blue' });
    expect(updates).toContainEqual({ nodeId: 'node-1', type: 'setConditionalStyle', variantName: 'variant-1', prop: 'width', value: '375px' });
    expect(updates).toContainEqual({ nodeId: 'node-1', type: 'updateVariantStyle', variantName: 'variant-1', styles: { backgroundColor: 'blue' } });
  });

  test('GROUP CHILD (nested svg): left/top → x/y translate DELTAS in the variant object (+legacy attrX clears)', () => {
    // Id-keyed mock (not call-ordered): styleUpdate now reads the cache more
    // than twice along this path, so a mockReturnValueOnce sequence drifts.
    vi.mocked(getNodeFromCache).mockImplementation(((id: string) =>
      id === 'child-1' ? ({ id, type: 'svg', parentId: 'group-1', attrs: {}, children: [], styles: {} } as any)
      : id === 'group-1' ? ({ id, type: 'svg', attrs: {}, children: [], styles: {} } as any)
      : undefined) as any);
    const updates = ctx.styleUpdate('child-1', { left: '-31px', top: '149px' });
    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    expect(vu).toBeTruthy();
    // x/y translate DELTAS from the base attrs (probe-verified live channel —
    // motion ignores attrX/attrY in variants on nested motion.svg). The mocked
    // child has no attrs, so base = 0 and delta = the drop position. attrX/
    // attrY are cleared so legacy absolute entries die on rewrite. Detachment
    // from primary moves is the orchestrator's delta compensation.
    expect(vu.styles).toEqual({ x: '-31', attrX: '', y: '149', attrY: '' });
    expect(vu.styles).not.toHaveProperty('left');
  });

  test('a NON-group child (svg in a frame) keeps left/top in the variant object', () => {
    vi.mocked(getNodeFromCache)
      .mockReturnValueOnce({ type: 'svg', parentId: 'frame-1' } as any)
      .mockReturnValueOnce({ type: 'div' } as any);
    const updates = ctx.styleUpdate('shape-1', { left: '5px', top: '6px' });
    const vu = updates.find(u => u.type === 'updateVariantStyle') as any;
    expect(vu.styles).toEqual({ left: '5px', top: '6px' });
  });

  test('hideInThis emits setVariantVisibility adding "variant-1" to hidden set', () => {
    const update = ctx.hideInThis('node-1');
    expect(update.type).toBe('setVariantVisibility');
    expect(update.nodeId).toBe('node-1');
    expect(update.hiddenVariants).toContain('variant-1');
  });

  test('hideInAllOthers emits ONE setVariantVisibility with default + variant-2', () => {
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(1);
    const u = updates[0];
    expect(u.type).toBe('setVariantVisibility');
    expect(u.hiddenVariants).toContain('default');
    expect(u.hiddenVariants).toContain('variant-2');
    expect(u.hiddenVariants).not.toContain('variant-1');
  });

  // Reverted: legacy assertions kept for snippet reuse — see new tests above
  test.skip('OLD hideInAllOthers placeholder', () => {
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(2);

    const defaultUpdate = updates.find(u => u.variantName === 'default');
    const v2Update = updates.find(u => u.variantName === 'variant-2');

    expect(defaultUpdate).toEqual({
      nodeId: 'node-1',
      type: 'updateVariantStyle',
      variantName: 'default',
      styles: { display: 'none' },
    });
    expect(v2Update).toEqual({
      nodeId: 'node-1',
      type: 'updateVariantStyle',
      variantName: 'variant-2',
      styles: { display: 'none' },
    });
  });

  test('deleteUpdate: node synced across variants (not in hiddenOnVariants) → hide only', () => {
    // Node visible in every variant (empty hiddenOnVariants). Variants are
    // default/variant-1/variant-2 (from COMPONENT_WIDTHS fallback). Deleting
    // from variant-1 still leaves it in default + variant-2 → hide here.
    vi.mocked(getNodeFromCache).mockReturnValueOnce({ hiddenOnVariants: new Set() } as any);

    const updates = ctx.deleteUpdate('node-1', document.createElement('div'));
    expect(updates).toHaveLength(1);
    expect(updates[0].type).toBe('setVariantVisibility');
    expect(updates[0].hiddenVariants).toContain('variant-1');
  });

  test('deleteUpdate: node solo to current variant (hidden in all others) → full remove', () => {
    // Already hidden in default + variant-2 → only visible in variant-1.
    // Deleting from variant-1 hides its LAST variant → full remove.
    vi.mocked(getNodeFromCache).mockReturnValueOnce(
      { hiddenOnVariants: new Set(['default', 'variant-2']) } as any,
    );

    const updates = ctx.deleteUpdate('node-1', document.createElement('div'));
    expect(updates).toEqual([{ nodeId: 'node-1', type: 'remove' }]);
  });
});

// ─── exitToCanvas ───────────────────────────────────────────────────────────

describe('exitToCanvas', () => {
  test('page primary: always returns move with canvasNode', () => {
    const ctx = getReplicaContext('desktop', PAGE_PATH, PAGE_WIDTHS);
    const update = ctx.exitToCanvas('node-1', { left: '100px', top: '200px' });
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'move',
      newParentId: null,
      canvasNode: true,
      styles: { left: '100px', top: '200px' },
    });
  });

  test('page replica: always returns move with canvasNode', () => {
    const ctx = getReplicaContext('tablet', PAGE_PATH, PAGE_WIDTHS);
    const update = ctx.exitToCanvas('node-1', { left: '50px', top: '100px' });
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'move',
      newParentId: null,
      canvasNode: true,
      styles: { left: '50px', top: '100px' },
    });
  });

  test('component primary: always returns move with canvasNode', () => {
    const ctx = getReplicaContext('default', COMPONENT_PATH, COMPONENT_WIDTHS);
    const update = ctx.exitToCanvas('node-1', { left: '0px', top: '0px' });
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'move',
      newParentId: null,
      canvasNode: true,
      styles: { left: '0px', top: '0px' },
    });
  });

  test('component replica: always returns move with canvasNode', () => {
    const ctx = getReplicaContext('variant-1', COMPONENT_PATH, COMPONENT_WIDTHS);
    const update = ctx.exitToCanvas('node-1', { width: '200px', height: '100px' });
    expect(update).toEqual({
      nodeId: 'node-1',
      type: 'move',
      newParentId: null,
      canvasNode: true,
      styles: { width: '200px', height: '100px' },
    });
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('vpWidth defaults to 0 when vpId not in vpWidths', () => {
    const ctx = getReplicaContext('unknown-vp', PAGE_PATH, PAGE_WIDTHS);
    expect(ctx.vpWidth).toBe(0);
  });

  test('single viewport: hideInAllOthers returns empty array', () => {
    const ctx = getReplicaContext('desktop', PAGE_PATH, { desktop: 1440 });
    const updates = ctx.hideInAllOthers('node-1');
    expect(updates).toHaveLength(0);
  });

  test('component with "desktop" vpId is primary (backward compat)', () => {
    const widths = { desktop: 800, 'variant-1': 800 };
    const ctx = getReplicaContext('desktop', COMPONENT_PATH, widths);
    expect(ctx.isPrimary).toBe(true);
    expect(ctx.isComponent).toBe(true);
    expect(ctx.variantName).toBeNull();
  });

  test('styleUpdate with empty styles object', () => {
    const ctx = getReplicaContext('desktop', PAGE_PATH, PAGE_WIDTHS);
    const updates = ctx.styleUpdate('node-1', {});
    expect(updates).toHaveLength(1);
    expect(updates[0].styles).toEqual({});
  });
});
