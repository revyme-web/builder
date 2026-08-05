// reparent-utils.test.ts — Tests for shared drag reparent utilities.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { applyLayoutEdgeMagnet, calculateLayoutInsertIndexById, computeLayoutInsertOrderUpdates, computeReorderAssignments, computeReplicaOrderMirrorUpdates, flexForFlowChildEnteringFlex } from './reparent-utils';

// Mock trace to prevent side effects
vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() },
}));

// applyLayoutEdgeMagnet calls into node-ops + types. Mock those — the test
// only needs to drive the magnet decision tree.
vi.mock('@/canvas/node-ops', () => ({
  getNodeId: vi.fn(),
  patchElementStyles: vi.fn(),
  findChildRects: vi.fn(() => []),
  findVisibleChildRects: vi.fn(() => []),
  findNodeRect: vi.fn(() => new DOMRect(0, 0, 1000, 1000)),
  getViewportPrefix: vi.fn(() => ''),
  findNodeComputedStyle: vi.fn(() => 'flex'),
}));
// Flow-order sorting reads inline `order` from the node cache.
const mockNodeStyles = new Map<string, Record<string, string>>();
vi.mock('@/code/stores/store', () => ({
  getNodeFromCache: (id: string) => (mockNodeStyles.has(id) ? { styles: mockNodeStyles.get(id) } : undefined),
}));
vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: vi.fn(() => ({})),
}));
vi.mock('./types', () => ({
  detectParentLayoutById: vi.fn(),
  getFlexDirectionById: vi.fn(),
}));
import { detectParentLayoutById, getFlexDirectionById } from './types';
import { findNodeRect, findVisibleChildRects } from '@/canvas/node-ops';

// ─── Helper: create mock HTMLElement ──────────────────────────────────────

function mockEl(attrs: Record<string, string> = {}, style: Record<string, string> = {}, rect?: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const [k, v] of Object.entries(style)) (el.style as any)[k] = v;
  if (rect) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: rect.left ?? 0, top: rect.top ?? 0,
      right: (rect.left ?? 0) + (rect.width ?? 100),
      bottom: (rect.top ?? 0) + (rect.height ?? 100),
      width: rect.width ?? 100, height: rect.height ?? 100,
      x: rect.left ?? 0, y: rect.top ?? 0,
      toJSON: () => ({}),
    });
  }
  return el;
}





// ─── applyLayoutEdgeMagnet ────────────────────────────────────────────────

// A node dropped into a display:flex container with no explicit flex defaults
// to `0 1 auto` (shrink 1) and collapses to ~0 — the "disappears on drop into a
// flex layout" bug the user hit dragging a canvas node / layer row into a flex
// child. flexForFlowChildEnteringFlex pins it to `0 0 auto` unless it already
// sizes itself.
describe('flexForFlowChildEnteringFlex', () => {
  test("injects '0 0 auto' entering a flex parent with no flex", () => {
    expect(flexForFlowChildEnteringFlex({ position: 'relative' }, 'flex')).toBe('0 0 auto');
    expect(flexForFlowChildEnteringFlex(undefined, 'flex')).toBe('0 0 auto');
    expect(flexForFlowChildEnteringFlex({ order: '1' }, 'flex')).toBe('0 0 auto'); // the reported node
  });

  test('does NOT inject for non-flex parents (block / grid / null)', () => {
    expect(flexForFlowChildEnteringFlex({}, 'block')).toBeNull();
    expect(flexForFlowChildEnteringFlex({}, 'grid')).toBeNull();
    expect(flexForFlowChildEnteringFlex({}, null)).toBeNull();
    expect(flexForFlowChildEnteringFlex({}, undefined)).toBeNull();
  });

  test('does NOT clobber a node that already sizes itself', () => {
    expect(flexForFlowChildEnteringFlex({ flex: '1 0 0px' }, 'flex')).toBeNull();   // Fill
    expect(flexForFlowChildEnteringFlex({ flex: '0 0 auto' }, 'flex')).toBeNull();  // already Fixed
    expect(flexForFlowChildEnteringFlex({ flexGrow: '1' }, 'flex')).toBeNull();
    expect(flexForFlowChildEnteringFlex({ flexShrink: '0' }, 'flex')).toBeNull();
    expect(flexForFlowChildEnteringFlex({ flexBasis: '200px' }, 'flex')).toBeNull();
  });
});

describe('applyLayoutEdgeMagnet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findNodeRect).mockReturnValue(new DOMRect(0, 0, 1000, 1000));
  });

  // Build a "section" rect/best with a parent in the node map.
  function makeBest(parentLayout: 'flex' | 'grid' | 'none', dir: 'row' | 'column' = 'column') {
    const nodes = new Map<string, any>();
    nodes.set('section-A', { parentId: 'page' });
    nodes.set('page', {});
    vi.mocked(detectParentLayoutById).mockReturnValue(parentLayout as any);
    vi.mocked(getFlexDirectionById).mockReturnValue(dir);
    const best = { id: 'section-A', rect: new DOMRect(0, 100, 800, 200) }; // top=100, bottom=300
    return { best, nodes };
  }

  test('promotes to parent when cursor is within edgePx of bottom edge (column)', () => {
    const { best, nodes } = makeBest('flex', 'column');
    // Cursor at y=294 → distEnd = 6, within 12px edge
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 294 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('page');
  });

  test('promotes to parent when cursor is within edgePx of top edge (column)', () => {
    const { best, nodes } = makeBest('flex', 'column');
    // Cursor at y=105 → distStart = 5, within 12px edge
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 105 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('page');
  });

  test('keeps best when cursor is in the middle of the frame', () => {
    const { best, nodes } = makeBest('flex', 'column');
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 200 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('section-A');
  });

  test('keeps best when parent is not a layout container', () => {
    const { best, nodes } = makeBest('none', 'column');
    // Even at the edge — parent is non-layout, no magnet.
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 295 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('section-A');
  });

  test('row-flex parent magnets on left/right edges, not top/bottom', () => {
    const { best, nodes } = makeBest('flex', 'row');
    // best rect is x=[0..800]. Cursor y=295 (near bottom) but parent runs row,
    // so distance is measured along x — y near the bottom is irrelevant.
    const farMid = applyLayoutEdgeMagnet(best, { x: 400, y: 295 }, nodes, 'desktop', 12);
    expect(farMid?.id).toBe('section-A');
    // Cursor near right edge — magnet promotes.
    const nearRight = applyLayoutEdgeMagnet(best, { x: 794, y: 200 }, nodes, 'desktop', 12);
    expect(nearRight?.id).toBe('page');
  });

  test('returns null when given null', () => {
    expect(applyLayoutEdgeMagnet(null, { x: 0, y: 0 }, new Map(), 'desktop')).toBeNull();
  });

  test('keeps best when cursor sits outside the frame on the layout axis', () => {
    const { best, nodes } = makeBest('flex', 'column');
    // Cursor at y=50, outside [100..300]. distStart = -50, regular hit-test owns it.
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 50 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('section-A');
  });

  test('promotes to root when root is a layout container (viewport itself)', () => {
    // The viewport itself lives in NodeMap as id='root'. Sections with
    // parentId='root' MUST be allowed to promote so the drop-line shows
    // between sections in the viewport.
    const nodes = new Map<string, any>();
    nodes.set('section-A', { parentId: 'root' });
    nodes.set('root', {});
    vi.mocked(detectParentLayoutById).mockReturnValue('flex' as any);
    vi.mocked(getFlexDirectionById).mockReturnValue('column');
    const best = { id: 'section-A', rect: new DOMRect(0, 0, 800, 100) };
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 95 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('root');
  });

  test('keeps best when parentId is missing', () => {
    const nodes = new Map<string, any>();
    nodes.set('section-A', {}); // no parentId at all
    const best = { id: 'section-A', rect: new DOMRect(0, 0, 800, 100) };
    const out = applyLayoutEdgeMagnet(best, { x: 400, y: 95 }, nodes, 'desktop', 12);
    expect(out?.id).toBe('section-A');
  });
});

// ─── computeLayoutInsertOrderUpdates ──────────────────────────────────────

describe('computeLayoutInsertOrderUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses VISIBLE child set so insertIndex matches calculateLayoutInsertIndexById', () => {
    // Repro of the bug: a hidden sibling at JSX position 0 inflates the
    // unfiltered list. The drop-line ran on the visible-only list and
    // returned insertIndex=2 (between 'features' and 'youtube'). If the
    // renumber reads the unfiltered list, the same insertIndex points
    // at "between 'hero' and 'features'" instead.
    vi.mocked(findVisibleChildRects).mockReturnValue([
      { id: 'hero',     rect: new DOMRect(0, 0,   100, 100) }, // top:0
      { id: 'features', rect: new DOMRect(0, 100, 100, 100) }, // top:100
      { id: 'youtube',  rect: new DOMRect(0, 200, 100, 100) }, // top:200
      { id: 'how',      rect: new DOMRect(0, 300, 100, 100) }, // top:300
    ]);

    const out = computeLayoutInsertOrderUpdates(
      'root',
      'desktop',
      2, // visible-list "between features and youtube"
      ['dragged'],
      'column',
      (id) => (id === 'hero' ? '0'
            : id === 'features' ? '1'
            : id === 'youtube' ? '2'
            : id === 'how' ? '3'
            : undefined),
    );

    // Must place 'dragged' at order 2 — between features and youtube.
    const draggedEntry = out.find(o => o.nodeId === 'dragged');
    expect(draggedEntry?.order).toBe(2);
    // Sanity: youtube and how get pushed by 1.
    expect(out.find(o => o.nodeId === 'youtube')?.order).toBe(3);
    expect(out.find(o => o.nodeId === 'how')?.order).toBe(4);
  });

  // Previously this returned [] — leaving every child of a fresh flex parent
  // with no `order`. Drag-to-reorder then snapped them around (the engine drives
  // `order`, and a child without one sits in the order:0 group), and the oracle
  // bounced FLEX_CHILD_MISSING_ORDER on components built entirely in the editor.
  // Stamping the CURRENT flow sequence is visually identical — with no explicit
  // order, flow order IS DOM order.
  test('stamps sequential order when no sibling has one yet', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([
      { id: 'a', rect: new DOMRect(0, 0,   100, 100) },
      { id: 'b', rect: new DOMRect(0, 100, 100, 100) },
    ]);

    const out = computeLayoutInsertOrderUpdates(
      'root', 'desktop', 1, ['dragged'], 'column',
      () => undefined, // no explicit order anywhere
    );
    // The drawn slot is honoured, and the existing children keep their sequence.
    expect(out).toEqual([
      { nodeId: 'a', order: 0 },
      { nodeId: 'dragged', order: 1 },
      { nodeId: 'b', order: 2 },
    ]);
  });
});

describe('negative-margin overlap (flow order beats geometry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNodeStyles.clear();
  });

  test('calculateLayoutInsertIndexById walks flow order with monotonic midpoints', () => {
    // Repro of the section-reorder bug: `title` has marginTop:-614px and is
    // pulled OVER (and geometrically ABOVE) the shorter `glass` section that
    // precedes it in flow. Sorting by rect.top used to invert them and the
    // midpoint scan flapped. DOM/flow order: glass (order 1) → title (order 2).
    vi.mocked(findVisibleChildRects).mockReturnValue([
      { id: 'hero',  rect: new DOMRect(0, 0,    1000, 800) },
      { id: 'glass', rect: new DOMRect(0, 800,  1000, 500) }, // bottom 1300
      { id: 'title', rect: new DOMRect(0, 686,  1000, 700) }, // -614 margin → starts ABOVE glass
      { id: 'works', rect: new DOMRect(0, 1386, 1000, 900) },
    ]);
    mockNodeStyles.set('hero', { order: '0' });
    mockNodeStyles.set('glass', { order: '1' });
    mockNodeStyles.set('title', { order: '2' });
    mockNodeStyles.set('works', { order: '3' });

    // pointer above hero's midpoint → slot 0
    expect(calculateLayoutInsertIndexById({ x: 500, y: 100 }, 'root', 'desktop', 'column')).toBe(0);
    // pointer between hero and glass midpoints → slot 1
    expect(calculateLayoutInsertIndexById({ x: 500, y: 700 }, 'root', 'desktop', 'column')).toBe(1);
    // OVERLAP ZONE: glass mid = 1050, title raw mid = 1036 — the raw mids are
    // NON-MONOTONIC (title's is above glass's). The clamped walk resolves
    // deterministically: below glass's mid → slot 1; past both (title's mid
    // clamps to just above glass's) → slot 3. Slot 2 stays reachable in the
    // sliver between the clamped boundaries — and, critically, the answer for
    // a given pointer can never flap between slots anymore.
    expect(calculateLayoutInsertIndexById({ x: 500, y: 1040 }, 'root', 'desktop', 'column')).toBe(1);
    expect(calculateLayoutInsertIndexById({ x: 500, y: 1050.5 }, 'root', 'desktop', 'column')).toBe(2);
    expect(calculateLayoutInsertIndexById({ x: 500, y: 1060 }, 'root', 'desktop', 'column')).toBe(3);
    // far below everything → end slot
    expect(calculateLayoutInsertIndexById({ x: 500, y: 3000 }, 'root', 'desktop', 'column')).toBe(4);
  });

  test('computeLayoutInsertOrderUpdates renumbers in flow order, not rect order', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([
      { id: 'glass', rect: new DOMRect(0, 800, 1000, 500) },
      { id: 'title', rect: new DOMRect(0, 686, 1000, 700) }, // geometrically above glass
      { id: 'works', rect: new DOMRect(0, 1386, 1000, 900) },
    ]);
    const orders: Record<string, string> = { glass: '0', title: '1', works: '2' };
    const out = computeLayoutInsertOrderUpdates(
      'root', 'desktop', 1, ['dragged'], 'column', (id) => orders[id],
    );
    // Insert at flow slot 1 = between glass and title. A rect.top sort would
    // have treated [title, glass, …] as the sequence and produced
    // title:0 dragged:1 glass:2 — shuffling sections the user never touched.
    expect(out).toEqual([
      { nodeId: 'glass', order: 0 },
      { nodeId: 'dragged', order: 1 },
      { nodeId: 'title', order: 2 },
      { nodeId: 'works', order: 3 },
    ]);
  });
});

describe('computeReorderAssignments', () => {
  test('no children-slot → plain sequential 0,1,2…', () => {
    expect(computeReorderAssignments(['a', 'b', 'c'])).toEqual([
      { nodeId: 'a', order: 0 },
      { nodeId: 'b', order: 1 },
      { nodeId: 'c', order: 2 },
    ]);
  });

  test('children-slot FIRST → slot excluded, others positive', () => {
    // slot pinned at 0; sections after it get 1,2…
    expect(computeReorderAssignments(['children-slot', 'a', 'b'])).toEqual([
      { nodeId: 'a', order: 1 },
      { nodeId: 'b', order: 2 },
    ]);
  });

  test('children-slot in MIDDLE → negative before, positive after, slot excluded', () => {
    // The exact regression: a section dropped ABOVE {children} must persist as a
    // NEGATIVE order (slot is unwritable, pinned at 0) so it survives re-parse.
    expect(computeReorderAssignments(['a', 'children-slot', 'b'])).toEqual([
      { nodeId: 'a', order: -1 },
      { nodeId: 'b', order: 1 },
    ]);
  });

  test('section moved to the very top, above the slot', () => {
    expect(computeReorderAssignments(['cta', 'children-slot', 'footer'])).toEqual([
      { nodeId: 'cta', order: -1 },
      { nodeId: 'footer', order: 1 },
    ]);
  });
});

// ─── The template `{children}` slot as a drop sibling ───────────────────────
//
// Editing a template (LayoutClient): the placeholder IS a real flow sibling —
// findVisibleChildRects includes it there (2026-07-27). Before that, the
// drop-line math was blind to it: dragging a canvas node over the placeholder
// landed the line at its CENTER (the header↔footer midpoint boundary), and a
// slot-only template showed no line at all. These tests pin the slot-aware
// behaviour of the index calc + the anchor-relative order writes.
describe('template {children} slot as a drop sibling', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const HEADER = { id: 'KaFiBi-1', rect: new DOMRect(0, 200, 800, 48) };
  const SLOT   = { id: 'children-slot', rect: new DOMRect(0, 248, 800, 164) };
  const FOOTER = { id: 'KaPoJo-3', rect: new DOMRect(0, 412, 800, 170) };

  test('dragging over the placeholder resolves BEFORE/AFTER it, never the middle', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([HEADER, SLOT, FOOTER]);
    vi.mocked(detectParentLayoutById).mockReturnValue('flex' as any);
    vi.mocked(getFlexDirectionById).mockReturnValue('column');
    // Mouse above the slot's midpoint (330) → before the slot (index 1).
    expect(calculateLayoutInsertIndexById({ x: 100, y: 300 }, 'root', 'desktop', 'column')).toBe(1);
    // Below the midpoint → after the slot (index 2). The 2026-07-27 trace
    // showed mousePos 352 resolving against [header, footer] mids only —
    // the line rendered mid-placeholder.
    expect(calculateLayoutInsertIndexById({ x: 100, y: 352 }, 'root', 'desktop', 'column')).toBe(2);
  });

  test('a slot-only template still yields drop positions (before=0 / after=1)', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([SLOT]);
    vi.mocked(detectParentLayoutById).mockReturnValue('flex' as any);
    vi.mocked(getFlexDirectionById).mockReturnValue('column');
    expect(calculateLayoutInsertIndexById({ x: 100, y: 260 }, 'root', 'desktop', 'column')).toBe(0);
    expect(calculateLayoutInsertIndexById({ x: 100, y: 400 }, 'root', 'desktop', 'column')).toBe(1);
  });

  test('insert orders are ANCHOR-relative: slot pinned at 0, no write targets it', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([HEADER, SLOT, FOOTER]);
    // Drop between slot and footer (visual index 2).
    const out = computeLayoutInsertOrderUpdates(
      'root', 'desktop', 2, ['dragged'], 'column', () => undefined,
    );
    // The slot is a JSX expression — an order write to it vanishes on
    // re-parse. computeReorderAssignments pins it at 0 and numbers the rest
    // relative to it.
    expect(out.find(o => o.nodeId === 'children-slot')).toBeUndefined();
    expect(out).toEqual([
      { nodeId: 'KaFiBi-1', order: -1 },
      { nodeId: 'dragged', order: 1 },
      { nodeId: 'KaPoJo-3', order: 2 },
    ]);
  });

  test('dropping BEFORE the slot gives the dragged a negative order', () => {
    vi.mocked(findVisibleChildRects).mockReturnValue([HEADER, SLOT, FOOTER]);
    const out = computeLayoutInsertOrderUpdates(
      'root', 'desktop', 1, ['dragged'], 'column', () => undefined,
    );
    expect(out).toEqual([
      { nodeId: 'KaFiBi-1', order: -2 },
      { nodeId: 'dragged', order: -1 },
      { nodeId: 'KaPoJo-3', order: 1 },
    ]);
  });
});

describe('computeReplicaOrderMirrorUpdates', () => {
  // Tablet carries an independent order map (band `order: !important` per
  // section); a primary drop wrote base orders only, so on tablet the new
  // node's base order was evaluated inside a foreign numbering and landed
  // anywhere ("tablet jumped way above Capabilities", 2026-08-05). The
  // mirror inserts the node after the SAME predecessor in the band's own
  // sequence and renumbers that band 0..N. Mobile (no order band) is
  // skipped and keeps inheriting base.
  // Base (desktop) visual order after the drop: hero, robot, services, NEW, about, marquee
  const desired = ['hero', 'robot', 'services', 'new-section', 'about', 'marquee'];
  const baseStyles: Record<string, Record<string, string>> = {
    hero: { order: '0' }, robot: { order: '1' }, services: { order: '2' },
    about: { order: '4' }, marquee: { order: '5' },
  };
  // Tablet band (max-width 768): INDEPENDENT arrangement — marquee moved up.
  // vpId->width map with a mobile vp that has NO order band.
  const overrides = new Map([
    ['hero', new Map([[768, new Map([['order', '0']])]])],
    ['marquee', new Map([[768, new Map([['order', '1']])]])],
    ['robot', new Map([[768, new Map([['order', '2']])]])],
    ['services', new Map([[768, new Map([['order', '3']])]])],
    ['about', new Map([[768, new Map([['order', '4']])]])],
  ]);
  const vpWidths = { desktop: 1440, tablet: 768, mobile: 375 };

  test('inserts after the same predecessor in the band sequence and renumbers 0..N', () => {
    const updates = computeReplicaOrderMirrorUpdates({
      draggedIds: ['new-section'],
      desiredVisualOrder: desired,
      getNodeStyles: (id: string) => baseStyles[id],
      overrides,
      vpWidths,
      dropVpId: 'desktop',
    });
    // Only the tablet band gets writes (mobile has no order map).
    expect(updates.every((u: any) => u.maxWidth === 768)).toBe(true);
    const byId = Object.fromEntries(updates.map((u: any) => [u.nodeId, u.styles.order]));
    // Tablet sequence was [hero, marquee, robot, services, about]; predecessor
    // on desktop is `services` → new lands right after services THERE:
    // [hero, marquee, robot, services, new-section, about] → 0..5
    expect(byId).toEqual({
      hero: '0', marquee: '1', robot: '2', services: '3', 'new-section': '4', about: '5',
    });
    expect(updates.every((u: any) => u.type === 'updateContainerStyle')).toBe(true);
  });

  test('a viewport with no order band emits nothing (stays base-synced)', () => {
    const updates = computeReplicaOrderMirrorUpdates({
      draggedIds: ['new-section'],
      desiredVisualOrder: desired,
      getNodeStyles: (id: string) => baseStyles[id],
      overrides: new Map(),
      vpWidths,
      dropVpId: 'desktop',
    });
    expect(updates).toEqual([]);
  });

  test('drop at the very top anchors before the successor', () => {
    const updates = computeReplicaOrderMirrorUpdates({
      draggedIds: ['new-section'],
      desiredVisualOrder: ['new-section', 'hero', 'robot', 'services', 'about', 'marquee'],
      getNodeStyles: (id: string) => baseStyles[id],
      overrides,
      vpWidths,
      dropVpId: 'desktop',
    });
    const byId = Object.fromEntries(updates.map((u: any) => [u.nodeId, u.styles.order]));
    // Successor = hero → new lands before hero in the tablet sequence.
    expect(byId['new-section']).toBe('0');
    expect(byId['hero']).toBe('1');
  });

  test('template-merge ids are skipped from the writes', () => {
    const updates = computeReplicaOrderMirrorUpdates({
      draggedIds: ['new-section'],
      desiredVisualOrder: ['layout::header', 'hero', 'new-section', 'about'],
      getNodeStyles: (id: string) => baseStyles[id],
      overrides: new Map([['hero', new Map([[768, new Map([['order', '0']])]])]]),
      vpWidths: { tablet: 768 },
      dropVpId: 'desktop',
    });
    expect(updates.some((u: any) => u.nodeId.startsWith('layout::'))).toBe(false);
    expect(updates.some((u: any) => u.nodeId === 'new-section')).toBe(true);
  });
});
