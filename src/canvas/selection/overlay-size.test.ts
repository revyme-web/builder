import { describe, it, expect } from 'vitest';
import { resolveOverlaySize } from './overlay-size';
import type { CanvasNode } from '@/code/parsing/parser';

// Repro of the reported bug: a component master frame whose height is overridden
// per-variant — `height: variant === 'variant-1' ? '311px' : 'min-content'` —
// parses to styles.height = 'min-content' (base) + conditionalStyles.height =
// { 'variant-1': '311px' }. The selection/padding overlays read raw
// node.styles.height ('min-content') and treated the 311px variant-1 replica as
// auto/fit → hid the vertical resize circles and drew padding handles. The
// resolver must return the ACTIVE branch for the artboard being shown.
describe('resolveOverlaySize — per-artboard variant size resolution', () => {
  const node = {
    id: 'frame-mr4v1jay-2',
    type: 'div',
    parentId: 'frame-1',
    children: [],
    styles: { display: 'flex', width: '100%', height: 'min-content' },
    conditionalStyles: {
      height: { 'variant-1': '311px' },
    },
    attrs: {},
    textContent: null,
  } as unknown as CanvasNode;

  // Component master viewport configs: primary artboard is 'desktop' (default
  // variant); the second artboard's id IS the variant name.
  const configs = [
    { id: 'desktop', width: 1440, isPrimary: true },
    { id: 'variant-1', width: 0, isPrimary: false },
  ];

  it('returns the px override on the variant-1 artboard (fixed → resize handles)', () => {
    const s = resolveOverlaySize(node, 'variant-1', configs, true);
    expect(s.height).toBe('311px');
    expect(s.width).toBe('100%');
  });

  it('returns the base min-content on the primary/default artboard (hug → padding handles)', () => {
    const s = resolveOverlaySize(node, 'desktop', configs, true);
    expect(s.height).toBe('min-content');
  });

  it('a plain page node (not a component file) resolves to its base styles', () => {
    const plain = {
      id: 'card',
      type: 'div',
      parentId: 'root',
      children: [],
      styles: { width: '320px', height: '480px' },
      conditionalStyles: null,
      attrs: {},
      textContent: null,
    } as unknown as CanvasNode;
    const s = resolveOverlaySize(plain, 'tablet', [{ id: 'tablet', width: 768, isPrimary: false }], false);
    expect(s.height).toBe('480px');
    expect(s.width).toBe('320px');
  });

  it('falls back to node.styles when the vpId matches no config', () => {
    const s = resolveOverlaySize(node, 'nonexistent', configs, true);
    // no vp → variantName = vpId ('nonexistent'), no matching conditional → base
    expect(s.height).toBe('min-content');
  });
});

// Page replicas: the @media band for the replica's width paints OVER the base
// inline styles, but lives in the page's <style> block — resolveVariantStyles
// can't see it. Repro of the mobile testimonial-card report: base height 729px,
// mobile band `height: auto !important` → the panel showed "auto" (override
// pill lit) while the overlay still drew top/bottom resize circles.
describe('resolveOverlaySize — page-replica @media overrides', () => {
  const carousel = {
    id: 'gw-carousel',
    type: 'div',
    parentId: 'root',
    children: [],
    styles: { display: 'flex', width: '100%', height: '729px' },
    conditionalStyles: null,
    attrs: {},
    textContent: null,
  } as unknown as CanvasNode;

  const configs = [
    { id: 'desktop', width: 1440, isPrimary: true },
    { id: 'tablet', width: 768, isPrimary: false },
    { id: 'mobile', width: 375, isPrimary: false },
  ];

  // node → maxWidth band → camelCase props (containerOverridesAtom shape)
  const overrides = new Map([
    ['gw-carousel', new Map([
      [375, new Map([['height', 'auto']])],
      [768, new Map([['width', '90%'], ['height', '520px']])],
    ])],
  ]);

  it('mobile replica: height auto override wins over the base px', () => {
    const s = resolveOverlaySize(carousel, 'mobile', configs, false, overrides);
    expect(s.height).toBe('auto');
    expect(s.width).toBe('100%'); // no width override in the 375 band → base
  });

  it('tablet replica: its own band resolves both axes', () => {
    const s = resolveOverlaySize(carousel, 'tablet', configs, false, overrides);
    expect(s.height).toBe('520px');
    expect(s.width).toBe('90%');
  });

  it('primary artboard ignores @media bands (base styles paint there)', () => {
    const s = resolveOverlaySize(carousel, 'desktop', configs, false, overrides);
    expect(s.height).toBe('729px');
  });

  it('replica with no band entry keeps base styles', () => {
    const other = { ...carousel, id: 'gw-intro' } as unknown as CanvasNode;
    const s = resolveOverlaySize(other, 'mobile', configs, false, overrides);
    expect(s.height).toBe('729px');
  });

  it('component files never consult @media bands (variants carry replica styles)', () => {
    const s = resolveOverlaySize(carousel, 'mobile', configs, true, overrides);
    expect(s.height).toBe('729px');
  });
});

// ─── resolveOverlaySpacing — the padding-handle drag baseline ────────────────
//
// Reported bug: on the MOBILE replica the panel read 12px on all four sides,
// but grabbing the top padding handle started the drag at 58 — the PRIMARY's
// inline `padding: '58px'` — so the first move jumped ~46px. Trace:
//   padding-handle:start {"nodeId":"div-ms0qgj6f-2","side":"top","currentValue":58}
// The baseline came from `resolveSpacingSides(node.styles)`, which only ever
// sees the base object (user report 2026-07-26).
import { resolveOverlaySpacing } from './overlay-size';
import type { ContainerOverrideMap } from '@/code/stores/container-query-store';

function overrideMap(
  entries: Record<string, Record<number, Record<string, string>>>,
): ContainerOverrideMap {
  const out = new Map<string, Map<number, Map<string, string>>>();
  for (const [nodeId, byWidth] of Object.entries(entries)) {
    const w = new Map<number, Map<string, string>>();
    for (const [width, props] of Object.entries(byWidth)) w.set(Number(width), new Map(Object.entries(props)));
    out.set(nodeId, w);
  }
  return out as ContainerOverrideMap;
}

describe('resolveOverlaySpacing — per-artboard padding resolution', () => {
  const PAGE_VPS = [
    { id: 'desktop', width: 1440, isPrimary: true },
    { id: 'tablet', width: 768, isPrimary: false },
    { id: 'mobile', width: 375, isPrimary: false },
  ];

  // The reported node, exactly: inline `padding: '58px'`, tablet band 21px,
  // mobile band 12px.
  const node = {
    id: 'div-ms0qgj6f-2',
    type: 'div',
    children: [],
    styles: { display: 'flex', padding: '58px', gap: '46px' },
    attrs: {},
    textContent: null,
  } as unknown as CanvasNode;

  const bands = overrideMap({
    'div-ms0qgj6f-2': {
      768: { padding: '21px' },
      375: { padding: '12px', gap: '46px' },
    },
  });

  it('reads the MOBILE band, not the primary (the reported baseline)', () => {
    expect(resolveOverlaySpacing(node, 'mobile', PAGE_VPS, false, 'padding', bands))
      .toEqual(['12px', '12px', '12px', '12px']);
  });

  it('reads the TABLET band on the tablet artboard', () => {
    expect(resolveOverlaySpacing(node, 'tablet', PAGE_VPS, false, 'padding', bands))
      .toEqual(['21px', '21px', '21px', '21px']);
  });

  it('reads the base on the PRIMARY artboard', () => {
    expect(resolveOverlaySpacing(node, 'desktop', PAGE_VPS, false, 'padding', bands))
      .toEqual(['58px', '58px', '58px', '58px']);
  });

  it('lets a band LONGHAND override just its side, base fills the rest', () => {
    const partial = overrideMap({ 'div-ms0qgj6f-2': { 375: { paddingTop: '78px' } } });
    // Band is !important → top is 78; the other three keep the base 58.
    expect(resolveOverlaySpacing(node, 'mobile', PAGE_VPS, false, 'padding', partial))
      .toEqual(['78px', '58px', '58px', '58px']);
  });

  it('applies band longhands AFTER a band shorthand (declaration order)', () => {
    // The post-drag band shape: shorthand first, then the dragged longhands.
    const mixed = overrideMap({
      'div-ms0qgj6f-2': { 375: { padding: '12px', paddingTop: '78px', paddingBottom: '78px' } },
    });
    expect(resolveOverlaySpacing(node, 'mobile', PAGE_VPS, false, 'padding', mixed))
      .toEqual(['78px', '12px', '78px', '12px']);
  });

  it('a band override OUT-RANKS the base even when the base holds the same key', () => {
    // The JS key-order trap: `paddingTop` already exists in the base object, so
    // re-setting it in place would keep the base's slot and be re-overwritten by
    // the base's LATER shorthand. It must move to the end.
    const legacyMix = {
      ...node,
      styles: { paddingTop: '134px', padding: '58px' },  // shorthand last → renders 58
    } as unknown as CanvasNode;
    const bandTop = overrideMap({ 'div-ms0qgj6f-2': { 375: { paddingTop: '78px' } } });
    expect(resolveOverlaySpacing(legacyMix, 'mobile', PAGE_VPS, false, 'padding', bandTop))
      .toEqual(['78px', '58px', '58px', '58px']);
  });

  it('honours the legacy shorthand/longhand mix on the PRIMARY (React key order)', () => {
    const legacyMix = {
      ...node,
      styles: { paddingTop: '134px', padding: '34px' },  // trailing shorthand wins
    } as unknown as CanvasNode;
    expect(resolveOverlaySpacing(legacyMix, 'desktop', PAGE_VPS, false, 'padding', bands))
      .toEqual(['34px', '34px', '34px', '34px']);
    // Reverse order → the longhand wins for top.
    const longhandLast = {
      ...node, styles: { padding: '34px', paddingTop: '134px' },
    } as unknown as CanvasNode;
    expect(resolveOverlaySpacing(longhandLast, 'desktop', PAGE_VPS, false, 'padding', bands))
      .toEqual(['134px', '34px', '34px', '34px']);
  });

  it('ignores bands belonging to a DIFFERENT node', () => {
    const other = overrideMap({ 'someone-else': { 375: { padding: '99px' } } });
    expect(resolveOverlaySpacing(node, 'mobile', PAGE_VPS, false, 'padding', other))
      .toEqual(['58px', '58px', '58px', '58px']);
  });

  it('ignores non-spacing band keys', () => {
    const noise = overrideMap({ 'div-ms0qgj6f-2': { 375: { gap: '46px', width: '100%' } } });
    expect(resolveOverlaySpacing(node, 'mobile', PAGE_VPS, false, 'padding', noise))
      .toEqual(['58px', '58px', '58px', '58px']);
  });

  it('resolves MARGIN through the same path', () => {
    const m = { ...node, styles: { margin: '10px' } } as unknown as CanvasNode;
    const mBand = overrideMap({ 'div-ms0qgj6f-2': { 375: { marginTop: '4px' } } });
    expect(resolveOverlaySpacing(m, 'mobile', PAGE_VPS, false, 'margin', mBand))
      .toEqual(['4px', '10px', '10px', '10px']);
  });

  it('COMPONENT variant tile: reads the per-variant padding, ignoring bands', () => {
    const master = {
      id: 'bar', type: 'div', children: [], attrs: {}, textContent: null,
      styles: { padding: '58px' },
      conditionalStyles: { padding: { 'variant-1': '8px' } },
    } as unknown as CanvasNode;
    const cfgs = [
      { id: 'desktop', width: 1440, isPrimary: true },
      { id: 'variant-1', width: 0, isPrimary: false },
    ];
    expect(resolveOverlaySpacing(master, 'variant-1', cfgs, true, 'padding'))
      .toEqual(['8px', '8px', '8px', '8px']);
    expect(resolveOverlaySpacing(master, 'desktop', cfgs, true, 'padding'))
      .toEqual(['58px', '58px', '58px', '58px']);
  });

  it('returns empty sides when nothing sets padding', () => {
    const bare = { ...node, styles: { display: 'flex' } } as unknown as CanvasNode;
    expect(resolveOverlaySpacing(bare, 'mobile', PAGE_VPS, false, 'padding', bands))
      .toEqual(['12px', '12px', '12px', '12px']);
    expect(resolveOverlaySpacing(bare, 'desktop', PAGE_VPS, false, 'padding', overrideMap({})))
      .toEqual(['', '', '', '']);
  });
});
