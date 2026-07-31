import { describe, test, expect, afterEach } from 'vitest';
import { rectsOverlap, getIntersectingNodeIds, getMarqueeSelection, marqueeSelectionSig, type BoxRect } from './SelectionBox';
import { setActiveBridge, resetActiveBridge, type CanvasBridge } from '../canvas-bridge';
import { vpIdFromPrefix } from '../node-ops';

// ─── helpers ──────────────────────────────────────────────────────────────────────────

function makeDOMRect(r: Partial<DOMRect>): DOMRect {
  const left = r.left ?? 0;
  const top = r.top ?? 0;
  const width = r.width ?? 0;
  const height = r.height ?? 0;
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
// ─── rectsOverlap ───────────────────────────────────────────────────────────

describe('rectsOverlap', () => {
  test('overlapping rects returns true', () => {
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 100 };
    const b = makeDOMRect({ left: 50, top: 50, width: 100, height: 100 });
    expect(rectsOverlap(a, b)).toBe(true);
  });

  test('non-overlapping rects returns false', () => {
    const a: BoxRect = { x: 0, y: 0, width: 50, height: 50 };
    const b = makeDOMRect({ left: 200, top: 200, width: 50, height: 50 });
    expect(rectsOverlap(a, b)).toBe(false);
  });

  test('adjacent rects (touching edge) returns false', () => {
    // a right edge = 100, b left edge = 100 — touching but not overlapping
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 100 };
    const b = makeDOMRect({ left: 100, top: 0, width: 100, height: 100 });
    expect(rectsOverlap(a, b)).toBe(false);
  });

  test('adjacent rects (touching bottom) returns false', () => {
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 100 };
    const b = makeDOMRect({ left: 0, top: 100, width: 100, height: 100 });
    expect(rectsOverlap(a, b)).toBe(false);
  });

  test('one rect inside another returns true', () => {
    const a: BoxRect = { x: 0, y: 0, width: 200, height: 200 };
    const b = makeDOMRect({ left: 50, top: 50, width: 20, height: 20 });
    expect(rectsOverlap(a, b)).toBe(true);
  });

  test('zero-width selection rect at edge returns false', () => {
    // Zero-width at x=0 touching b.left=0: a.x+width (0) > b.left (0) fails
    const a: BoxRect = { x: 0, y: 0, width: 0, height: 100 };
    const b = makeDOMRect({ left: 0, top: 0, width: 200, height: 200 });
    expect(rectsOverlap(a, b)).toBe(false);
  });

  test('zero-height selection rect at edge returns false', () => {
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 0 };
    const b = makeDOMRect({ left: 0, top: 0, width: 200, height: 200 });
    expect(rectsOverlap(a, b)).toBe(false);
  });

  test('zero-size DOMRect point inside selection still overlaps', () => {
    // A zero-size DOMRect at (50,50) has left=right=50, top=bottom=50.
    // a.x (0) < b.right (50) = true, a.x+width (100) > b.left (50) = true => overlaps
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 100 };
    const b = makeDOMRect({ left: 50, top: 50, width: 0, height: 0 });
    expect(rectsOverlap(a, b)).toBe(true);
  });

  test('zero-size DOMRect at edge returns false', () => {
    // Point at (100,100) — on the boundary, strict < means no overlap
    const a: BoxRect = { x: 0, y: 0, width: 100, height: 100 };
    const b = makeDOMRect({ left: 100, top: 50, width: 0, height: 0 });
    expect(rectsOverlap(a, b)).toBe(false);
  });
});

// ─── getIntersectingNodeIds ─────────────────────────────────────────────────────────
//
// Product change (iframe bridge architecture): getIntersectingNodeIds no longer
// walks the content element's DOM — canvas content renders in a sandboxed
// iframe the parent frame can't measure. It iterates the bridge rectCache
// (keys `${vpPrefix}:${nodeId}`, populated by the sandbox's allRects events)
// and overlap-tests bridge.getRect(). The contentEl argument is unused.

describe('getIntersectingNodeIds', () => {
  // Ignored by the product — kept only to satisfy the signature.
  const contentEl = document.createElement('div');

  /** Install a fake bridge whose rectCache serves the given `${vpPrefix}:${nodeId}` entries. */
  function installBridge(entries: Record<string, Partial<DOMRect>>): void {
    const rectCache = new Map<string, DOMRect>();
    for (const [key, rect] of Object.entries(entries)) rectCache.set(key, makeDOMRect(rect));
    const bridge: CanvasBridge & { rectCache: Map<string, DOMRect> } = {
      rectCache,
      getRect: (nodeId, vpPrefix) => rectCache.get(`${vpPrefix}:${nodeId}`) ?? null,
      getChildRects: () => [],
      getComputedValue: () => '',
      getComputedValues: () => ({}),
      getContainerRect: () => null,
      getElementIdsAtPoint: () => [],
      patchStyles: () => {},
      patchAttrsAndStyles: () => {},
      setInnerHTML: () => {},
      setAttribute: () => {},
      injectCSS: () => {},
      removeCSS: () => {},
      getIframeDocument: () => null,
      loadFontInIframe: () => {},
    };
    setActiveBridge(bridge);
  }

  afterEach(() => {
    resetActiveBridge();
  });

  test('bridge without a rectCache (NullBridge) returns empty array', () => {
    // Default bridge is the NullBridge — no rectCache property → guard returns [].
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(ids).toEqual([]);
  });

  test('empty rectCache returns empty array', () => {
    installBridge({});
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(ids).toEqual([]);
  });

  test('nodes outside selection returns empty array', () => {
    installBridge({
      ':a': { left: 500, top: 500, width: 50, height: 50 },
      ':b': { left: 600, top: 600, width: 50, height: 50 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 100, height: 100 });
    expect(ids).toEqual([]);
  });

  test('nodes inside selection returns their node ids', () => {
    // Was DOM data-id reads — ids now come from the rectCache keys.
    installBridge({
      ':hero': { left: 10, top: 10, width: 80, height: 40 },
      ':footer': { left: 10, top: 60, width: 80, height: 30 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 200, height: 200 });
    expect(ids).toContain('hero');
    expect(ids).toContain('footer');
    expect(ids).toHaveLength(2);
  });

  test("the 'root' entry is skipped (never selected)", () => {
    // Was “viewport roots are skipped”: the DOM data-viewport check is gone —
    // the page root is cached under the id 'root' and skipped by id instead.
    installBridge({
      ':root': { left: 0, top: 0, width: 500, height: 500 },
      ':node1': { left: 10, top: 10, width: 50, height: 50 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(ids).toEqual(['node1']);
  });

  test('nested nodes are selected too (rectCache is flat)', () => {
    // Was “only top-level nodes selected (deeply nested skipped)”: the DOM walk
    // that stopped at a viewport's direct children is gone — the rectCache is a
    // flat map, so every intersecting node id is returned, nested or not.
    installBridge({
      ':top': { left: 10, top: 10, width: 80, height: 80 },
      ':deep': { left: 20, top: 20, width: 30, height: 30 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 200, height: 200 });
    expect(ids).toContain('top');
    expect(ids).toContain('deep');
    expect(ids).toHaveLength(2);
  });

  test('replica entries are real marquee targets — same node in two viewports dedupes to one id', () => {
    // Replicas are first-class marquee targets (same as replica CLICKS).
    // The selection model stores plain ids, so a node hit in both the
    // primary and a replica appears once.
    installBridge({
      ':hero': { left: 10, top: 10, width: 50, height: 50 },
      'tablet-:hero': { left: 10, top: 200, width: 50, height: 50 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(ids).toEqual(['hero']);
  });

  test('a sweep over ONLY a replica selects its nodes (was: skipped entirely)', () => {
    installBridge({
      ':hero': { left: 10, top: 10, width: 50, height: 50 },
      'tablet-:hero': { left: 500, top: 10, width: 50, height: 50 },
      'tablet-:about': { left: 500, top: 80, width: 50, height: 50 },
    });
    // Marquee covers only the tablet column.
    const sel = getMarqueeSelection(contentEl, { x: 480, y: 0, width: 200, height: 500 });
    expect(sel.ids.sort()).toEqual(['about', 'hero']);
  });

  test('viewportsByNode records EVERY viewport a node was swept in (drives per-artboard outlines)', () => {
    installBridge({
      ':hero': { left: 10, top: 10, width: 50, height: 50 },
      'tablet-:hero': { left: 500, top: 10, width: 50, height: 50 },
      'mobile-:hero': { left: 700, top: 10, width: 50, height: 50 },
      'tablet-:about': { left: 500, top: 80, width: 50, height: 50 },
    });
    const sel = getMarqueeSelection(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(sel.viewportsByNode['hero']!.sort()).toEqual(
      [vpIdFromPrefix(''), vpIdFromPrefix('mobile-'), vpIdFromPrefix('tablet-')].sort(),
    );
    expect(sel.viewportsByNode['about']).toEqual([vpIdFromPrefix('tablet-')]);
    // Signature helper is order-insensitive — pairs the spread with the selection.
    expect(marqueeSelectionSig(['b', 'a'])).toBe(marqueeSelectionSig(['a', 'b']));
  });

  test('dominant viewport: replica-only sweep resolves to the replica; ties prefer primary', () => {
    installBridge({
      ':hero': { left: 10, top: 10, width: 50, height: 50 },
      'tablet-:hero': { left: 500, top: 10, width: 50, height: 50 },
      'tablet-:about': { left: 500, top: 80, width: 50, height: 50 },
    });
    // Only the tablet column → dominant is the tablet viewport.
    const replicaSweep = getMarqueeSelection(contentEl, { x: 480, y: 0, width: 200, height: 500 });
    expect(replicaSweep.vpId).toBe(vpIdFromPrefix('tablet-'));
    // Everything (primary 1 hit vs tablet 2 hits) → tablet dominates.
    const wideSweep = getMarqueeSelection(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(wideSweep.vpId).toBe(vpIdFromPrefix('tablet-'));
    // Equal hits (primary hero vs tablet hero only) → primary wins the tie.
    const tieSweep = getMarqueeSelection(contentEl, { x: 0, y: 0, width: 1000, height: 70 });
    expect(tieSweep.vpId).toBe(vpIdFromPrefix(''));
  });

  test('ghost entries (`__N` suffix) are skipped', () => {
    // CMS/.map() ghost copies are cached with a `__N` suffix (isGhostNodeId)
    // and must never be marquee-selected — only the template row is.
    installBridge({
      ':card': { left: 5, top: 5, width: 40, height: 40 },
      ':card__1': { left: 5, top: 50, width: 40, height: 40 },
      ':card__2': { left: 5, top: 95, width: 40, height: 40 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 200, height: 200 });
    expect(ids).toEqual(['card']);
  });

  test('template chrome (`layout::` ids + children-slot) is never marquee-selected', () => {
    // On a templated page the merge prefixes every template node (header /
    // footer / nav and their WHOLE subtrees) with `layout::` and inserts the
    // `children-slot` placeholder. A marquee over the top of the page must
    // select only PAGE content — sweeping the template header into the
    // selection was the bug (same exclusion deleteNode applies).
    installBridge({
      ':layout::header': { left: 0, top: 0, width: 500, height: 60 },
      ':layout::header-logo': { left: 10, top: 10, width: 40, height: 40 },
      ':layout::footer': { left: 0, top: 400, width: 500, height: 60 },
      ':children-slot': { left: 0, top: 60, width: 500, height: 340 },
      ':hero': { left: 10, top: 80, width: 200, height: 100 },
      ':about': { left: 10, top: 200, width: 200, height: 100 },
    });
    const ids = getIntersectingNodeIds(contentEl, { x: 0, y: 0, width: 1000, height: 1000 });
    expect(ids).toContain('hero');
    expect(ids).toContain('about');
    expect(ids).toHaveLength(2);
  });
});

// ─── dropMatchedDescendants — marquee must not select parent AND child ──────
// EMPIRICAL PIN, live find 2026-07-29: marquee-selecting sketches also
// swept their inner <path> children (a child rect always overlaps when its
// ancestor's does) — the all-svg Group gate then saw `type: 'path'` entries,
// so Group vanished from the context menu and Cmd+G silently bailed, while
// shift-click (wrappers only) worked. Marquee keeps only the TOPMOST matched
// node per chain, matching Cmd+A's "parent covers subtree" rule.
import { dropMatchedDescendants } from './SelectionBox';

describe('dropMatchedDescendants', () => {
  const nodesMap = (edges: Record<string, string | null>) =>
    new Map(Object.entries(edges).map(([id, parentId]) => [id, { parentId }]));

  test('sketch wrapper + its path child → wrapper only (the Group repro)', () => {
    const nodes = nodesMap({ 'sk-1': null, 'sk-1-path': 'sk-1', 'sk-2': null, 'sk-2-path': 'sk-2' });
    const out = dropMatchedDescendants(new Set(['sk-1', 'sk-1-path', 'sk-2', 'sk-2-path']), nodes);
    expect(out.sort()).toEqual(['sk-1', 'sk-2']);
  });

  test('deep descendant chains collapse to the topmost matched ancestor', () => {
    const nodes = nodesMap({ frame: null, inner: 'frame', leaf: 'inner' });
    expect(dropMatchedDescendants(new Set(['frame', 'inner', 'leaf']), nodes)).toEqual(['frame']);
  });

  test('siblings all survive', () => {
    const nodes = nodesMap({ a: 'root', b: 'root', c: 'root', root: null });
    expect(dropMatchedDescendants(new Set(['a', 'b', 'c']), nodes).sort()).toEqual(['a', 'b', 'c']);
  });

  test('a child whose ancestor is NOT matched survives', () => {
    const nodes = nodesMap({ frame: null, child: 'frame' });
    expect(dropMatchedDescendants(new Set(['child']), nodes)).toEqual(['child']);
  });

  test('ids missing from the map are kept (never silently shrink the selection)', () => {
    expect(dropMatchedDescendants(new Set(['ghostish']), nodesMap({}))).toEqual(['ghostish']);
  });
});
