// node-ops.test.ts — Tests for pure functions in node-ops.ts (no DOM needed).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getViewportPrefix,
  isPrimaryViewport,
  vpIdFromPrefix,
  parseRectCacheKey,
  findGhostsForTemplate,
  redirectToCollectionTemplate,
  redirectToComponentInstance,
  patchElementStyles,
  getNodeIdsAtPoint,
} from './node-ops';
import type { CanvasNode } from '@/code/parsing/parser';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { setActiveBridge } from './canvas-bridge';

// ─── patchElementStyles — CSS custom properties ─────────────────────────────
// An overlay-border variable on a component instance binds through a custom
// property (`--X` on the root, `border: var(--X)` in the `::after`). During the
// live border-width drag the props tool calls patchNodeStyles → patchElementStyles
// with `{ '--X': value }`. Bracket assignment (`el.style['--X'] = v`) is a SILENT
// no-op for custom props, so the drag-preview did nothing for the overlay and the
// border appeared to sit UNDER children until the commit re-parse. Must use
// setProperty/removeProperty. (No data-id on the el → skips the bridge forward.)
describe('patchElementStyles — CSS custom properties', () => {
  it('applies a custom property via setProperty', () => {
    const el = document.createElement('div');
    patchElementStyles(el, { '--azegazegzeg': '103px solid #000000' });
    expect(el.style.getPropertyValue('--azegazegzeg')).toBe('103px solid #000000');
  });

  it('removes a custom property when value is empty', () => {
    const el = document.createElement('div');
    el.style.setProperty('--azegazegzeg', '103px solid #000000');
    patchElementStyles(el, { '--azegazegzeg': '' });
    expect(el.style.getPropertyValue('--azegazegzeg')).toBe('');
  });

  it('still applies normal camelCase props', () => {
    const el = document.createElement('div');
    patchElementStyles(el, { backgroundColor: '#97cffc' });
    expect(el.style.backgroundColor).toBe('rgb(151, 207, 252)');
  });
});

// ─── getViewportPrefix ──────────────────────────────────────────────────────

describe('getViewportPrefix', () => {
  it('returns empty string for "desktop"', () => {
    expect(getViewportPrefix('desktop')).toBe('');
  });

  it('returns empty string for "default"', () => {
    expect(getViewportPrefix('default')).toBe('');
  });

  it('returns "tablet-" for "tablet"', () => {
    expect(getViewportPrefix('tablet')).toBe('tablet-');
  });

  it('returns "mobile-" for "mobile"', () => {
    expect(getViewportPrefix('mobile')).toBe('mobile-');
  });

  it('returns "custom-" for "custom"', () => {
    expect(getViewportPrefix('custom')).toBe('custom-');
  });

  it('returns "responsive-" for "responsive"', () => {
    expect(getViewportPrefix('responsive')).toBe('responsive-');
  });

  it('returns "hover-" for "hover" (variant ID)', () => {
    expect(getViewportPrefix('hover')).toBe('hover-');
  });
});

// ─── isPrimaryViewport ──────────────────────────────────────────────────────

describe('isPrimaryViewport', () => {
  it('returns true for "desktop"', () => {
    expect(isPrimaryViewport('desktop')).toBe(true);
  });

  it('returns true for "default"', () => {
    expect(isPrimaryViewport('default')).toBe(true);
  });

  it('returns false for "tablet"', () => {
    expect(isPrimaryViewport('tablet')).toBe(false);
  });

  it('returns false for "mobile"', () => {
    expect(isPrimaryViewport('mobile')).toBe(false);
  });

  it('returns false for arbitrary string', () => {
    expect(isPrimaryViewport('hover')).toBe(false);
    expect(isPrimaryViewport('custom-1')).toBe(false);
  });
});

// ─── isComponentFilePath ────────────────────────────────────────────────────

describe('isComponentFilePath', () => {
  it('returns true for component paths', () => {
    expect(isComponentFilePath('components/Hero.tsx')).toBe(true);
    expect(isComponentFilePath('components/Card.tsx')).toBe(true);
    expect(isComponentFilePath('components/nested/Button.tsx')).toBe(true);
  });

  it('returns false for page paths', () => {
    expect(isComponentFilePath('app/page.tsx')).toBe(false);
    expect(isComponentFilePath('pages/index.tsx')).toBe(false);
  });

  it('returns false for other paths', () => {
    expect(isComponentFilePath('src/utils.ts')).toBe(false);
    expect(isComponentFilePath('lib/helpers.ts')).toBe(false);
  });

  it('returns false for paths that contain "components" but do not start with it', () => {
    expect(isComponentFilePath('src/components/Hero.tsx')).toBe(false);
  });
});

// ─── vpIdFromPrefix ──────────────────────────────────────────────────────────

describe('vpIdFromPrefix', () => {
  it('returns "desktop" for empty string', () => {
    expect(vpIdFromPrefix('')).toBe('desktop');
  });

  it('returns "tablet" for "tablet-"', () => {
    expect(vpIdFromPrefix('tablet-')).toBe('tablet');
  });

  it('returns "mobile" for "mobile-"', () => {
    expect(vpIdFromPrefix('mobile-')).toBe('mobile');
  });

  it('returns "custom-1024" for "custom-1024-"', () => {
    expect(vpIdFromPrefix('custom-1024-')).toBe('custom-1024');
  });

  it('returns "desktop" for undefined-like falsy prefix', () => {
    // vpIdFromPrefix checks !prefix, so any falsy value → 'desktop'
    expect(vpIdFromPrefix('')).toBe('desktop');
  });

  it('handles prefix without trailing dash gracefully', () => {
    // If prefix is "tablet" without dash, just returns it as-is
    expect(vpIdFromPrefix('tablet')).toBe('tablet');
  });

  it('returns "hover" for "hover-"', () => {
    expect(vpIdFromPrefix('hover-')).toBe('hover');
  });
});



// (getViewportForElement removed in Phase 2 of the architecture refactor —
// no callers remained, viewport detection now uses bridge rectCache iteration
// and viewport prefix derived from DragContext.)

// ─── updateNodeStyles mutation routing ──────────────────────────────────────
// These tests verify the mutation queue receives the correct mutation TYPES.
// The critical regression: PendingUpdate uses 'style' but mutation queue expects 'updateStyles'.

import { updateNodeStyles, setStyleContext } from './node-ops';

// Capture mutations
const queuedMutations: any[] = [];
vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: (m: any) => { queuedMutations.push(m); },
  flushNow: vi.fn(),
  setForceRender: vi.fn(),
}));

vi.mock('@/code/stores/store', () => ({
  updateNodeInCache: vi.fn(),
  isComponentInstanceInCache: vi.fn(() => false),
  getNodeFromCache: vi.fn(() => undefined),
}));

vi.mock('@/code/project/active-file-store', () => ({
  isComponentFilePath: (p: string) => p.startsWith('components/'),
}));

vi.mock('@/code/project/project-fs', () => ({
  projectFS: { readFile: vi.fn(() => null) },
}));

function makeContentEl(nodeId: string, vpPrefix: string = ''): HTMLElement {
  const el = document.createElement('div');
  const child = document.createElement('div');
  child.setAttribute('data-id', nodeId);
  child.setAttribute('data-node-id', `${vpPrefix}${nodeId}`);
  child.style.width = '100px';
  el.appendChild(child);
  return el;
}

describe('updateNodeStyles mutation routing', () => {
  beforeEach(() => { queuedMutations.length = 0; });

  it('page primary: queues updateStyles, NOT "style"', () => {
    setStyleContext('app/page.tsx', 'desktop', 1440);
    updateNodeStyles({ id: 'n1', styles: { backgroundColor: 'red' }, contentEl: makeContentEl('n1') });

    expect(queuedMutations.some(m => m.type === 'updateStyles')).toBe(true);
    expect(queuedMutations.some(m => m.type === 'style')).toBe(false);
  });

  it('page replica: queues updateContainerStyle', () => {
    setStyleContext('app/page.tsx', 'tablet', 768);
    updateNodeStyles({ id: 'n1', styles: { width: '200px' }, contentEl: makeContentEl('n1', 'tablet-') });

    expect(queuedMutations.some(m => m.type === 'updateContainerStyle' && m.maxWidth === 768)).toBe(true);
  });

  it('component primary: queues updateStyles + updateVariantStyle(default)', () => {
    setStyleContext('components/Card.tsx', 'desktop', 0);
    updateNodeStyles({ id: 'n1', styles: { color: 'blue' }, contentEl: makeContentEl('n1') });

    expect(queuedMutations.some(m => m.type === 'updateStyles')).toBe(true);
    expect(queuedMutations.some(m => m.type === 'updateVariantStyle' && m.variantName === 'default')).toBe(true);
  });

  it('component replica: queues updateVariantStyle(variantName)', () => {
    setStyleContext('components/Card.tsx', 'variant-1', 0);
    updateNodeStyles({ id: 'n1', styles: { left: '50px' }, contentEl: makeContentEl('n1', 'variant-1-') });

    expect(queuedMutations.some(m => m.type === 'updateVariantStyle' && m.variantName === 'variant-1')).toBe(true);
  });

  it('domOnly: does NOT queue mutations', () => {
    setStyleContext('app/page.tsx', 'desktop', 1440);
    updateNodeStyles({ id: 'n1', styles: { width: '300px' }, contentEl: makeContentEl('n1'), domOnly: true });

    expect(queuedMutations).toHaveLength(0);
  });
});

// ─── replica override REMOVAL forces a render ───────────────────────────────
// A '' (remove-property) write routed into a page replica's @container rule is
// invisible to the instant DOM patch: clearing the inline value re-exposes the
// OLD baked `@container … !important` rule, which only a full render drops.
// The Transform ✕ on a replica did nothing until a page switch (2026-07-20).

import { setForceCanvasRender } from './node-ops';

describe('updateNodeStyles — replica override removal forces render', () => {
  const forceSpy = vi.fn();
  beforeEach(() => {
    queuedMutations.length = 0;
    forceSpy.mockClear();
    setForceCanvasRender(forceSpy);
  });
  afterEach(() => { setForceCanvasRender(null); });

  it('page replica REMOVAL ("" value → @container) forces a canvas render', () => {
    setStyleContext('app/page.tsx', 'tablet', 768);
    updateNodeStyles({ id: 'n1', styles: { transform: '' }, contentEl: makeContentEl('n1', 'tablet-') });

    expect(queuedMutations.some(m => m.type === 'updateContainerStyle' && m.styles?.transform === '')).toBe(true);
    expect(forceSpy).toHaveBeenCalled();
  });

  it('page replica SET does NOT force a render (inline important patch covers it)', () => {
    setStyleContext('app/page.tsx', 'tablet', 768);
    updateNodeStyles({ id: 'n1', styles: { transform: 'scale(0.4)' }, contentEl: makeContentEl('n1', 'tablet-') });

    expect(queuedMutations.some(m => m.type === 'updateContainerStyle')).toBe(true);
    expect(forceSpy).not.toHaveBeenCalled();
  });

  it('page PRIMARY removal does NOT force a render (inline clear is enough)', () => {
    setStyleContext('app/page.tsx', 'desktop', 1440);
    updateNodeStyles({ id: 'n1', styles: { transform: '' }, contentEl: makeContentEl('n1') });

    expect(queuedMutations.some(m => m.type === 'updateStyles')).toBe(true);
    expect(forceSpy).not.toHaveBeenCalled();
  });
});

// ─── getNodeHitsAtPoint — paint order beats depth/area ─────────────────────
// A full-bleed decorative backdrop (deep "Background Noise texture",
// 100%×100%) must NOT swallow hover/click/drop hits over a SHALLOWER sibling
// section that PAINTS above it (higher z-index, or simply later in DOM
// order). The old deepest-then-smallest sort picked the backdrop.

describe('getNodeHitsAtPoint — paint order', () => {
  function bridgeWithRects(rectEntries: Array<[string, DOMRect]>) {
    const rectCache = new Map<string, DOMRect>(rectEntries);
    return {
      rectCache,
      getRect: (nodeId: string, vpPrefix: string) => rectCache.get(`${vpPrefix}:${nodeId}`) ?? null,
      getCachedCorners: () => null,
      getChildRects: () => [],
      getComputedValue: () => '',
      getComputedValues: () => ({}),
      getContainerRect: () => null,
      getElementIdsAtPoint: () => [],
      patchStyles: () => {},
      injectCSS: () => {},
      removeCSS: () => {},
    } as any;
  }

  const seedCache = (withZ: boolean) => {
    const mk = (id: string, parentId: string | null, children: string[], styles: Record<string, string> = {}) =>
      ({ id, parentId, children, styles, attrs: {} }) as any;
    const cache = new Map<string, any>([
      ['section', mk('section', null, ['noise', 'trusted'])],
      ['noise', mk('noise', 'section', ['noise-texture'])],           // FIRST child — paints below
      ['noise-texture', mk('noise-texture', 'noise', [])],
      ['trusted', mk('trusted', 'section', ['trusted-label'], withZ ? { zIndex: '1' } : {})], // LATER sibling
      ['trusted-label', mk('trusted-label', 'trusted', [])],
    ]);
    vi.mocked(mockedGetNodeFromCache).mockImplementation((id: string) => cache.get(id));
  };

  const rects: Array<[string, DOMRect]> = [
    [':noise', new DOMRect(0, 0, 1440, 1090)],
    [':noise-texture', new DOMRect(0, 0, 1440, 1090)],   // deep + huge
    [':trusted', new DOMRect(0, 600, 1440, 140)],        // shallow sibling painted ABOVE
    [':trusted-label', new DOMRect(80, 640, 200, 20)],
  ];

  it('a later sibling section beats a deeper full-bleed backdrop (DOM order alone)', () => {
    seedCache(false);
    setActiveBridge(bridgeWithRects(rects));
    const ids = getNodeIdsAtPoint(700, 660); // over the trusted row, right of the label
    expect(ids[0]).toBe('trusted');
    expect(ids.indexOf('trusted')).toBeLessThan(ids.indexOf('noise-texture'));
  });

  it('explicit z-index on the section also wins', () => {
    seedCache(true);
    setActiveBridge(bridgeWithRects(rects));
    const ids = getNodeIdsAtPoint(700, 660);
    expect(ids[0]).toBe('trusted');
  });

  it('the label (descendant of the top-painted section) beats everything at its point', () => {
    seedCache(false);
    setActiveBridge(bridgeWithRects(rects));
    const ids = getNodeIdsAtPoint(120, 650); // over the label
    expect(ids[0]).toBe('trusted-label');
    expect(ids[1]).toBe('trusted');
  });

  it('descendants still beat their own ancestors (unchanged behaviour)', () => {
    seedCache(false);
    setActiveBridge(bridgeWithRects(rects));
    const ids = getNodeIdsAtPoint(300, 100); // only over the noise stack
    expect(ids[0]).toBe('noise-texture');
    expect(ids[1]).toBe('noise');
  });
});

// ─── findGhostsForTemplate ──────────────────────────────────────────────────
// Verifies the bridge-cache scan that powers MapGhostOverlay arrow connectors
// after the iframe-bridge migration. Ghost rects are stored under unique keys
// like `${vpPrefix}:${templateId}__N`; this helper extracts them sorted by index.

describe('findGhostsForTemplate', () => {
  function makeMockBridge(rectEntries: Array<[string, DOMRect]>) {
    const rectCache = new Map<string, DOMRect>(rectEntries);
    return {
      rectCache,
      getRect: (nodeId: string, vpPrefix: string) => rectCache.get(`${vpPrefix}:${nodeId}`) ?? null,
      getCachedCorners: () => null,
      // unused stubs to satisfy the CanvasBridge interface shape
      getChildRects: () => [],
      getComputedValue: () => '',
      getComputedValues: () => ({}),
      getContainerRect: () => null,
      getElementIdsAtPoint: () => [],
      patchStyles: () => {},
      injectCSS: () => {},
      removeCSS: () => {},
    } as any;
  }

  beforeEach(() => {
    setActiveBridge(makeMockBridge([]));
  });

  it('returns empty array when no ghosts match the template', () => {
    setActiveBridge(makeMockBridge([
      [':frame-other__1', new DOMRect(0, 0, 100, 100)],
    ]));
    expect(findGhostsForTemplate('frame-123', 'desktop')).toEqual([]);
  });

  it('returns ghosts sorted by index for primary viewport', () => {
    setActiveBridge(makeMockBridge([
      [':frame-123__2', new DOMRect(20, 0, 100, 100)],
      [':frame-123__1', new DOMRect(10, 0, 100, 100)],
      [':frame-123__3', new DOMRect(30, 0, 100, 100)],
      [':frame-123', new DOMRect(0, 0, 100, 100)], // template — should be excluded
    ]));
    const ghosts = findGhostsForTemplate('frame-123', 'desktop');
    expect(ghosts.map(g => g.ghostIndex)).toEqual([1, 2, 3]);
    expect(ghosts[0].rect.left).toBe(10);
    expect(ghosts[2].rect.left).toBe(30);
  });

  it('scopes to the requested viewport prefix', () => {
    setActiveBridge(makeMockBridge([
      [':frame-123__1', new DOMRect(10, 0, 100, 100)],
      ['tablet-:frame-123__1', new DOMRect(11, 0, 100, 100)],
      ['tablet-:frame-123__2', new DOMRect(22, 0, 100, 100)],
    ]));
    const desktopGhosts = findGhostsForTemplate('frame-123', 'desktop');
    expect(desktopGhosts).toHaveLength(1);
    expect(desktopGhosts[0].rect.left).toBe(10);

    const tabletGhosts = findGhostsForTemplate('frame-123', 'tablet');
    expect(tabletGhosts.map(g => g.ghostIndex)).toEqual([1, 2]);
    expect(tabletGhosts[0].rect.left).toBe(11);
  });

  it('ignores non-numeric suffixes that happen to contain __', () => {
    setActiveBridge(makeMockBridge([
      [':frame-123__abc', new DOMRect(0, 0, 100, 100)],
      [':frame-123__1', new DOMRect(1, 0, 100, 100)],
    ]));
    const ghosts = findGhostsForTemplate('frame-123', 'desktop');
    expect(ghosts.map(g => g.ghostIndex)).toEqual([1]);
  });

  it('returns empty array when bridge has no rectCache (DirectBridge)', () => {
    setActiveBridge({
      getRect: () => null,
      getChildRects: () => [],
      getComputedValue: () => '',
      getComputedValues: () => ({}),
      getContainerRect: () => null,
      getElementIdsAtPoint: () => [],
      patchStyles: () => {},
      patchAttrsAndStyles: () => {},
      setInnerHTML: () => {},
      setAttribute: () => {},
      getIframeDocument: () => null,
      loadFontInIframe: () => {},
      injectCSS: () => {},
      removeCSS: () => {},
    });
    expect(findGhostsForTemplate('frame-123', 'desktop')).toEqual([]);
  });
});

// ─── redirectToCollectionTemplate ───────────────────────────────────────────
// Strips a `__N` ghost suffix to give the canonical (template) id. Returns
// null when the input has no suffix. Used by handleNodeMouseDown after the
// iframe-bridge hit-test returns suffix-bearing ids.

describe('redirectToCollectionTemplate', () => {
  it('strips a single-digit ghost suffix', () => {
    expect(redirectToCollectionTemplate('card1__1')).toBe('card1');
    expect(redirectToCollectionTemplate('card1-title__2')).toBe('card1-title');
  });

  it('strips a multi-digit ghost suffix', () => {
    expect(redirectToCollectionTemplate('card1__42')).toBe('card1');
  });

  it('returns null when the id has no ghost suffix', () => {
    expect(redirectToCollectionTemplate('card1')).toBeNull();
    expect(redirectToCollectionTemplate('card1-title')).toBeNull();
    expect(redirectToCollectionTemplate('root')).toBeNull();
  });

  it('returns null for non-numeric trailing __ patterns', () => {
    expect(redirectToCollectionTemplate('card__title')).toBeNull();
    expect(redirectToCollectionTemplate('foo__1a')).toBeNull();
  });

  it('preserves embedded __ when only the trailing suffix matches', () => {
    // Hypothetical id with __ inside but a real ghost suffix at the end.
    expect(redirectToCollectionTemplate('foo__bar__3')).toBe('foo__bar');
  });
});

// ─── redirectToComponentInstance ────────────────────────────────────────────

describe('redirectToComponentInstance — nested instances climb to the OUTERMOST', () => {
  // Build a minimal CanvasNode for the tests below. Only the fields the
  // function actually reads are required; the rest of the type is filled
  // with empty defaults to satisfy TS.
  const mk = (partial: Partial<CanvasNode> & { id: string }): CanvasNode => ({
    type: 'div',
    name: 'Frame',
    parentId: null,
    children: [],
    styles: {},
    attrs: {},
    textContent: '',
    hasMixedContent: false,
    order: 0,
    isCanvasNode: false,
    componentFile: null,
    componentInstanceId: null,
    isComponentRoot: false,
    motionVariants: null,
    motionVariantsRef: null,
    responsiveVariantMap: null,
    conditionalStyles: null,
    motionProps: null,
    ...partial,
  } as CanvasNode);

  it('returns id unchanged when node is not inside an instance', () => {
    const nodes = new Map<string, CanvasNode>([
      ['plain', mk({ id: 'plain' })],
    ]);
    expect(redirectToComponentInstance('plain', nodes)).toBe('plain');
  });

  it('redirects a single-level instance child to the instance wrapper', () => {
    // <Outer>  ← outer-instance wrapper, no parent instance
    //   <div> ← child gets componentInstanceId = outer-instance
    const nodes = new Map<string, CanvasNode>([
      ['outer-instance', mk({ id: 'outer-instance', isComponentInstance: true })],
      ['inner-child', mk({ id: 'inner-child', componentInstanceId: 'outer-instance' })],
    ]);
    expect(redirectToComponentInstance('inner-child', nodes)).toBe('outer-instance');
  });

  it('redirects through a NESTED instance to the OUTER instance', () => {
    // Bug scenario: a page has <Outer> containing the JSX <Inner>.
    // After expandComponent runs twice:
    //   - Outer expansion stamps Inner's wrapper with `componentInstanceId
    //     = outer-instance` (Inner is part of Outer's expanded tree).
    //   - Inner expansion then sees the Inner wrapper as its own instance
    //     and stamps Inner's children with `componentInstanceId =
    //     inner-instance`.
    // Hovering a grandchild used to redirect to `inner-instance` only.
    // The user's intent ("instances are opaque") wants it to fold all
    // the way up to `outer-instance`.
    const nodes = new Map<string, CanvasNode>([
      ['outer-instance', mk({ id: 'outer-instance', isComponentInstance: true })],
      ['inner-instance', mk({
        id: 'inner-instance',
        isComponentInstance: true,
        componentInstanceId: 'outer-instance', // stamped by Outer's pass
      })],
      ['grandkid', mk({
        id: 'grandkid',
        componentInstanceId: 'inner-instance', // stamped by Inner's pass
      })],
    ]);
    // Hover over the grandkid → walks grandkid → inner-instance → outer-instance.
    expect(redirectToComponentInstance('grandkid', nodes)).toBe('outer-instance');
    // Hover over the nested-instance wrapper itself → folds up too.
    expect(redirectToComponentInstance('inner-instance', nodes)).toBe('outer-instance');
  });

  it('bounded — defends against accidental self-cycles', () => {
    // Cycle protection: if a future bug stamps componentInstanceId on
    // a node that points back at itself, the walk must NOT spin.
    const nodes = new Map<string, CanvasNode>([
      ['self-ref', mk({ id: 'self-ref', componentInstanceId: 'self-ref' })],
    ]);
    expect(redirectToComponentInstance('self-ref', nodes)).toBe('self-ref');
  });
});

import { zIndexAboveBackgroundLayer } from './node-ops';
import { getNodeFromCache as mockedGetNodeFromCache } from '@/code/stores/store';

describe('zIndexAboveBackgroundLayer (new node clears a positioned backdrop)', () => {
  const cache = new Map<string, any>();
  const put = (id: string, node: Partial<any>) =>
    cache.set(id, { id, children: [], styles: {}, ...node });

  beforeEach(() => {
    cache.clear();
    vi.mocked(mockedGetNodeFromCache).mockImplementation((id: string) => cache.get(id));
  });

  it('clears an absolute aura (z auto) → sits at the content layer', () => {
    put('parent', { children: ['aura', 'title'] });
    put('aura', { styles: { position: 'absolute' } });               // z auto → 0
    put('title', { styles: { position: 'relative', zIndex: '2' } });
    // max(maxBgZ+1=1, maxContentZ=2) = 2
    expect(zIndexAboveBackgroundLayer('parent')).toBe('2');
  });

  it('z:0 backdrop, no content z → "1" (the manual workaround, automated)', () => {
    put('parent', { children: ['aura', 'frame'] });
    put('aura', { styles: { position: 'absolute', zIndex: '0' } });
    put('frame', { styles: { position: 'relative' } });             // auto
    expect(zIndexAboveBackgroundLayer('parent')).toBe('1');
  });

  it('returns undefined with NO positioned backdrop', () => {
    put('parent', { children: ['a', 'b'] });
    put('a', { styles: { position: 'relative' } });
    put('b', { styles: { position: 'relative', zIndex: '2' } });
    expect(zIndexAboveBackgroundLayer('parent')).toBeUndefined();
  });

  it('ignores a high-z FOREGROUND overlay (z ≥ 1) — not a backdrop', () => {
    put('parent', { children: ['overlay'] });
    put('overlay', { styles: { position: 'absolute', zIndex: '10' } });
    expect(zIndexAboveBackgroundLayer('parent')).toBeUndefined();
  });

  it('returns undefined for an empty / unknown parent', () => {
    expect(zIndexAboveBackgroundLayer('missing')).toBeUndefined();
    put('empty', { children: [] });
    expect(zIndexAboveBackgroundLayer('empty')).toBeUndefined();
  });
});

// ─── parseRectCacheKey ───────────────────────────────────────────────────────
// The bridge rect-cache keys are `${vpPrefix}:${nodeId}`. The helper replaces
// ~20 inline indexOf(':')/slice copies (9.4d), so its contract must match them
// exactly: split on the FIRST colon, null when there is no colon at all.
describe('parseRectCacheKey', () => {
  it('splits a replica key into prefix + nodeId', () => {
    expect(parseRectCacheKey('tablet-:frame1')).toEqual({ vpPrefix: 'tablet-', nodeId: 'frame1' });
  });

  it('primary keys have an empty prefix (leading colon)', () => {
    expect(parseRectCacheKey(':frame1')).toEqual({ vpPrefix: '', nodeId: 'frame1' });
  });

  it('splits on the FIRST colon only (expanded instance ids keep theirs)', () => {
    expect(parseRectCacheKey('mobile-:inst1:child2')).toEqual({ vpPrefix: 'mobile-', nodeId: 'inst1:child2' });
  });

  it('keeps ghost suffixes on the nodeId part', () => {
    expect(parseRectCacheKey(':tpl__3')).toEqual({ vpPrefix: '', nodeId: 'tpl__3' });
  });

  it('returns null for a colon-less key (callers skip or fall back)', () => {
    expect(parseRectCacheKey('frame1')).toBeNull();
    expect(parseRectCacheKey('')).toBeNull();
  });
});

// ─── findVisibleChildRects — the {children} slot is context-dependent ───────
// PAGE views: the slot is never a drop sibling (and no such node exists in the
// merged map anyway). TEMPLATE editing (LayoutClient active): the slot IS a
// real flow sibling — blanket-excluding it made the drop-line math blind to
// the placeholder (line landed at its CENTER; slot-only templates showed no
// line at all — user report 2026-07-27).
describe('findVisibleChildRects — children-slot inclusion', () => {
  it('includes the slot when the active file is a LayoutClient, excludes it on pages', async () => {
    const { findVisibleChildRects, setStyleContext } = await import('./node-ops');
    // findChildRects walks the parent's CACHED children, then bridge.getRect.
    const kids: Record<string, DOMRect> = {
      'KaFiBi-1': new DOMRect(0, 0, 800, 48),
      'children-slot': new DOMRect(0, 48, 800, 164),
      'layout::nav': new DOMRect(0, 300, 800, 40),
    };
    vi.mocked(mockedGetNodeFromCache).mockImplementation(((id: string) =>
      id === 'root' ? { id: 'root', children: Object.keys(kids) } : undefined) as any);
    setActiveBridge({
      getRect: (id: string) => kids[id] ?? null,
      getComputedValue: () => '',   // display/position lookups → benign
    } as any);

    setStyleContext('app/(Body)/LayoutClient.tsx', 'desktop', 1440);
    expect(findVisibleChildRects('root', 'desktop').map(c => c.id))
      .toEqual(['KaFiBi-1', 'children-slot']);   // slot IN, template chrome still out

    setStyleContext('app/page.client.tsx', 'desktop', 1440);
    expect(findVisibleChildRects('root', 'desktop').map(c => c.id))
      .toEqual(['KaFiBi-1']);                     // slot OUT on pages
  });
});
