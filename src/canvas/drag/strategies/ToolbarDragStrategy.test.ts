import { describe, it, test, expect } from 'vitest';
import { ToolbarDragStrategy } from './ToolbarDragStrategy';
import type { ToolbarItem } from '../toolbar-item-config';
import type { DragContext } from '../types';

const makeItem = (overrides: Partial<ToolbarItem> = {}): ToolbarItem => ({
  id: 'frame',
  elementType: 'div',
  defaultStyles: { width: '200px', height: '200px' },
  ghostSize: { width: 200, height: 200 },
  ...overrides,
});

const makeContext = (overrides: Partial<DragContext> = {}): DragContext => ({
  draggedNodes: [],
  startMouse: { x: 500, y: 300 },
  transform: { x: 0, y: 0, scale: 1 },
  containerRect: { left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080 } as DOMRect,
  contentEl: document.createElement('div'),
  code: '',
  nodes: new Map(),
  selectedIds: [],
  modifiers: { alt: false, shift: false, ctrl: false },
  viewportPrefix: '',
  ...overrides,
});

describe('ToolbarDragStrategy', () => {
  it('canHandle always returns false', () => {
    const strategy = new ToolbarDragStrategy();
    expect(strategy.canHandle()).toBe(false);
  });

  it('has name "toolbar"', () => {
    const strategy = new ToolbarDragStrategy();
    expect(strategy.name).toBe('toolbar');
  });

  it('onEnd returns empty array when no item set', () => {
    const strategy = new ToolbarDragStrategy();
    const result = strategy.onEnd(makeContext());
    expect(result).toEqual([]);
  });

  it('onEnd returns add update with absolute position when over canvas without parent', () => {
    const strategy = new ToolbarDragStrategy();
    const item = makeItem();
    strategy.setToolbarItem(item);
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: true, dropParentId: null });
    const updates = strategy.onEnd(makeContext());
    expect(updates.length).toBe(1);
    expect(updates[0].type).toBe('add');
    expect(updates[0].descriptor).toBeDefined();
    expect(updates[0].descriptor!.tag).toBe('div');
    expect(updates[0].descriptor!.styles.position).toBe('absolute');
  });

  it('onEnd returns add update with parent when dropping into container', () => {
    const strategy = new ToolbarDragStrategy();
    const item = makeItem({ id: 'button', elementType: 'button', textContent: 'Click me' });
    strategy.setToolbarItem(item);
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: true, dropParentId: 'parent-1', dropIndex: 2 });
    const updates = strategy.onEnd(makeContext());
    expect(updates.length).toBe(1);
    expect(updates[0].type).toBe('add');
    expect(updates[0].newParentId).toBe('parent-1');
    expect(updates[0].newIndex).toBe(2);
    expect(updates[0].descriptor!.tag).toBe('button');
    expect(updates[0].descriptor!.textContent).toBe('Click me');
    // Should NOT have position:absolute when dropping into a container — it
    // joins the parent's flow. It IS explicitly 'relative': the drop now runs
    // through `normalizeLayoutDescriptor` (the same normaliser the plugin path
    // uses), and the oracle's NODE_MISSING_POSITION requires every node to
    // declare a position — a position-less node reads as unset in the Position
    // tool and has nothing to transfer if it is later extracted into a component.
    expect(updates[0].descriptor!.styles.position).toBe('relative');
  });

  it('onEnd returns empty array when outside canvas (cancelled)', () => {
    const strategy = new ToolbarDragStrategy();
    strategy.setToolbarItem(makeItem());
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: false, dropParentId: null });
    const updates = strategy.onEnd(makeContext());
    expect(updates).toEqual([]);
  });

  describe('replica drop — page replica viewport (tablet/mobile)', () => {
    // Mirrors the create-on-replica pattern in FrameCreator/etc. and the
    // canvas-drag entry-into-replica path. Pinned here so a future toolbar
    // refactor doesn't silently regress to "drop into tablet shows on
    // desktop too".
    //
    // Setup uses the in-module setters (`setStyleContext`,
    // `syncViewportWidths`) — no jotai store needed.
    test('drop into a non-primary viewport emits inline display:none + hide-others + unhide-this', async () => {
      const { setStyleContext } = await import('@/canvas/node-ops');
      const { syncViewportWidths } = await import('@/code/stores/viewport-store');

      setStyleContext('app/page.tsx', 'desktop', 1440);
      syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });

      const strategy = new ToolbarDragStrategy();
      strategy.setToolbarItem(makeItem());
      strategy.onStart(makeContext());
      strategy._setTestState({
        isOverCanvas: true,
        dropParentId: 'parent-1',
        currentVpId: 'tablet',
      });

      const updates = strategy.onEnd(makeContext());

      // 1. The `add` carries inline display:none — the primary viewport has
      //    no @container rule for this node, so the inline is what keeps
      //    desktop empty.
      const addUpdate = updates.find(u => u.type === 'add')!;
      expect(addUpdate.descriptor!.styles.display).toBe('none');

      // 2. hideInAllOthers writes display:none for desktop AND mobile —
      //    every viewport EXCEPT the entered (tablet).
      const containerHides = updates.filter(
        u => u.type === 'updateContainerStyle' && u.styles?.display === 'none',
      );
      const hideMaxWidths = new Set(containerHides.map(u => u.maxWidth));
      expect(hideMaxWidths.has(1440)).toBe(true); // desktop
      expect(hideMaxWidths.has(375)).toBe(true);  // mobile
      expect(hideMaxWidths.has(768)).toBe(false); // tablet — NOT hidden

      // 3. The entered viewport (tablet @ 768px) gets display:unset so the
      //    new node actually shows there, overriding the inline hide.
      const tabletUnhide = updates.find(
        u => u.type === 'updateContainerStyle' && u.maxWidth === 768 && u.styles?.display === 'unset',
      );
      expect(tabletUnhide).toBeDefined();
    });

    test('component instance drop into a replica does NOT set inline display:none', async () => {
      // Component instances merge inline `style` onto their inner root via
      // expandComponent. If we set inline display:none here, the inner root
      // would be hidden and the @media display:unset on the wrapper data-id
      // wouldn't reach the inner root → the embed renders blank in every
      // viewport. Instead the per-viewport @media hide rules cover the
      // primary range on their own.
      const { setStyleContext } = await import('@/canvas/node-ops');
      const { syncViewportWidths } = await import('@/code/stores/viewport-store');

      setStyleContext('app/page.tsx', 'desktop', 1440);
      syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });

      const strategy = new ToolbarDragStrategy();
      // Uppercase elementType = component instance (e.g. <YouTubeEmbed/>).
      strategy.setToolbarItem(makeItem({ elementType: 'YouTubeEmbed' }));
      strategy.onStart(makeContext());
      strategy._setTestState({
        isOverCanvas: true,
        dropParentId: 'parent-1',
        currentVpId: 'tablet',
      });

      const updates = strategy.onEnd(makeContext());

      // 1. Inline display is NOT set on the descriptor — the entire point.
      const addUpdate = updates.find(u => u.type === 'add')!;
      expect(addUpdate.descriptor!.styles.display).toBeUndefined();

      // 2. Hide rules still emitted for desktop + mobile (primary range
      //    covered by the bounded @media rule, no inline needed).
      const containerHides = updates.filter(
        u => u.type === 'updateContainerStyle' && u.styles?.display === 'none',
      );
      const hideMaxWidths = new Set(containerHides.map(u => u.maxWidth));
      expect(hideMaxWidths.has(1440)).toBe(true);
      expect(hideMaxWidths.has(375)).toBe(true);

      // 3. Tablet does NOT get the `display: 'unset'` unhide. The wrapper
      //    renders as a `<div>` (Renderer.VALID_TAGS fallback) with default
      //    `display: block`. Writing `display: 'unset' !important` here
      //    would force `display: inline` (initial value beats UA stylesheet
      //    under !important author rule) and the embed would render at 0×0.
      const tabletUnhide = updates.find(
        u => u.type === 'updateContainerStyle' && u.maxWidth === 768 && u.styles?.display === 'unset',
      );
      expect(tabletUnhide).toBeUndefined();
    });

    test('replica drop emits hide/unhide CSS updates BEFORE the add', async () => {
      // Why: the `add` triggers a renderer rebuild that paints the new node
      // on every viewport's DOM. If the `@media display:'none'` rules
      // aren't in the iframe <style> by then, the primary briefly shows
      // the element and the user sees a frame of layout shift before the
      // CSS arrives. Inserting CSS first means the rule already matches
      // when the element first hits the DOM. Pin the order explicitly so
      // a future "let's tidy the array" refactor doesn't reintroduce the
      // flash.
      const { setStyleContext } = await import('@/canvas/node-ops');
      const { syncViewportWidths } = await import('@/code/stores/viewport-store');

      setStyleContext('app/page.tsx', 'desktop', 1440);
      syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });

      const strategy = new ToolbarDragStrategy();
      strategy.setToolbarItem(makeItem());
      strategy.onStart(makeContext());
      strategy._setTestState({
        isOverCanvas: true,
        dropParentId: 'parent-1',
        currentVpId: 'tablet',
      });

      const updates = strategy.onEnd(makeContext());
      const addIndex = updates.findIndex(u => u.type === 'add');
      const containerIndices = updates
        .map((u, i) => u.type === 'updateContainerStyle' ? i : -1)
        .filter(i => i >= 0);
      // Every CSS update precedes the add.
      expect(addIndex).toBeGreaterThan(0);
      expect(containerIndices.every(i => i < addIndex)).toBe(true);
    });

    test('drop into the primary viewport (desktop) does NOT emit hide/unhide writes', async () => {
      const { setStyleContext } = await import('@/canvas/node-ops');
      const { syncViewportWidths } = await import('@/code/stores/viewport-store');

      setStyleContext('app/page.tsx', 'desktop', 1440);
      syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });

      const strategy = new ToolbarDragStrategy();
      strategy.setToolbarItem(makeItem());
      strategy.onStart(makeContext());
      strategy._setTestState({
        isOverCanvas: true,
        dropParentId: 'parent-1',
        currentVpId: 'desktop',
      });

      const updates = strategy.onEnd(makeContext());

      // Single `add` update — no replica machinery for primary drops.
      expect(updates).toHaveLength(1);
      expect(updates[0].type).toBe('add');
      expect(updates[0].descriptor!.styles.display).toBeUndefined();
    });
  });

  describe('replica drop — component master variant', () => {
    test('drop into a non-default variant emits inline display:none + variant hide/unhide', async () => {
      const { setStyleContext } = await import('@/canvas/node-ops');
      const { syncViewportWidths } = await import('@/code/stores/viewport-store');

      // Component-master heuristic is `path.startsWith('components/') && endsWith('.tsx')`
      // (per isComponentFilePath in active-file-store).
      setStyleContext('components/Hero.tsx', 'default', 1440);
      // Seed the master file: getAllVariantNames parses variantConfig from
      // the REAL file now (vpWidths is only a last-resort fallback), and a
      // missing file parses to just ['default'].
      const { projectFS } = await import('@/code/project/project-fs');
      projectFS.writeFile('components/Hero.tsx', `
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Variant 1', x: 0, y: 400 },
  { name: 'variant-2', label: 'Variant 2', x: 0, y: 800 },
];
function Hero() { return <div data-id="hero-root" />; }
export default Hero;
`);
      // Component master: each variant renders at the same width; the values
      // here don't drive selection (variants do). Provide them anyway so
      // getReplicaContext doesn't crash on lookup.
      syncViewportWidths({ default: 1440, 'variant-1': 1440, 'variant-2': 1440 });

      const strategy = new ToolbarDragStrategy();
      strategy.setToolbarItem(makeItem());
      strategy.onStart(makeContext());
      strategy._setTestState({
        isOverCanvas: true,
        dropParentId: 'hero-root',
        currentVpId: 'variant-1',
      });

      const updates = strategy.onEnd(makeContext());

      // Inline hide on the descriptor.
      const addUpdate = updates.find(u => u.type === 'add')!;
      expect(addUpdate.descriptor!.styles.display).toBe('none');

      // Variant visibility moved from per-variant display:none/unset writes
      // to ONE setVariantVisibility (the hiddenOnVariants AnimatePresence-
      // conditional model): hidden = every variant except the entered one.
      const vis = updates.find(u => u.type === 'setVariantVisibility') as any;
      expect(vis).toBeDefined();
      expect(new Set(vis.hiddenVariants)).toEqual(new Set(['default', 'variant-2']));
      expect(new Set(vis.allVariants)).toEqual(new Set(['default', 'variant-1', 'variant-2']));
      // Entered variant still gets the display:unset override (beats the
      // descriptor's inline display:none on this variant only).
      const enteredUnhide = updates.find(
        u => u.type === 'updateVariantStyle' && u.variantName === 'variant-1' && u.styles?.display === 'unset',
      );
      expect(enteredUnhide).toBeDefined();
      // But no per-variant display:none hides remain (replaced by setVariantVisibility).
      expect(updates.some(u => u.type === 'updateVariantStyle' && u.styles?.display === 'none')).toBe(false);
    });
  });

  it('onMove sets isOverCanvas=false when cursor is over a [data-editor-panel] surface', () => {
    // Repro: user drags from the Insert panel's secondary sidebar but
    // releases while the cursor is still over that sidebar. Without the
    // panel-aware hit test, mouseup committed the drop because the
    // sidebar overlays the canvas containerRect. Now: the strategy
    // reads back isOverCanvas=false and onEnd returns [] (cancelled).
    //
    // Setup uses the parent-frame DOM (jsdom) — `elementFromPoint`
    // walks the real document, so we mount a marker div at known coords.
    const panel = document.createElement('div');
    panel.setAttribute('data-editor-panel', 'left-secondary');
    Object.defineProperty(panel, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, right: 308, bottom: 1080, width: 308, height: 1080, x: 0, y: 0, toJSON: () => ({}) }),
    });
    document.body.appendChild(panel);

    // jsdom's elementFromPoint requires the test to wire it manually —
    // override with a stub that returns the panel for in-bounds coords.
    const originalEFP = document.elementFromPoint;
    document.elementFromPoint = (x: number, y: number) =>
      (x >= 0 && x <= 308 && y >= 0 && y <= 1080) ? panel : null;

    try {
      const strategy = new ToolbarDragStrategy();
      strategy.setToolbarItem(makeItem());
      const ctx = makeContext();
      strategy.onStart(ctx);
      // Cursor at (200, 500) — well inside the secondary panel.
      strategy.onMove(ctx, { x: 200, y: 500 });

      // onEnd should now refuse the drop.
      const updates = strategy.onEnd(ctx);
      expect(updates).toEqual([]);
    } finally {
      document.elementFromPoint = originalEFP;
      document.body.removeChild(panel);
    }
  });

  it('onCancel resets state so onEnd returns nothing', () => {
    const strategy = new ToolbarDragStrategy();
    strategy.setToolbarItem(makeItem());
    strategy.onStart(makeContext());
    strategy.onCancel();
    const updates = strategy.onEnd(makeContext());
    expect(updates).toEqual([]);
  });

  it('descriptor includes attrs for image element', () => {
    const strategy = new ToolbarDragStrategy();
    const item = makeItem({
      id: 'image',
      elementType: 'img',
      defaultStyles: { width: '200px', height: '150px' },
      defaultAttrs: { src: '', alt: '' },
    });
    strategy.setToolbarItem(item);
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: true, dropParentId: 'parent-1' });
    const updates = strategy.onEnd(makeContext());
    expect(updates[0].descriptor!.attrs).toEqual({ src: '', alt: '' });
  });

  it('generates unique node IDs with element type prefix', () => {
    const strategy = new ToolbarDragStrategy();
    strategy.setToolbarItem(makeItem({ elementType: 'button' }));
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: true, dropParentId: 'p1' });
    const updates1 = strategy.onEnd(makeContext());

    strategy.setToolbarItem(makeItem({ elementType: 'div' }));
    strategy.onStart(makeContext());
    strategy._setTestState({ isOverCanvas: true, dropParentId: 'p1' });
    const updates2 = strategy.onEnd(makeContext());

    expect(updates1[0].nodeId).toContain('button');
    expect(updates2[0].nodeId).toContain('frame'); // div maps to 'frame' prefix
    expect(updates1[0].nodeId).not.toBe(updates2[0].nodeId);
  });
});
