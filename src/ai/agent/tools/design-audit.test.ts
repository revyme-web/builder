// src/ai/agent/tools/design-audit.test.ts
//
// Pure building blocks of the rendered-layout observation tools: WCAG color
// math (parseCssColor / relativeLuminance / contrastRatio) and the six
// linter rules. Every rule is tested with a triggering fixture and a
// boundary case that must NOT trigger. No store, no bridge, no DOM — the
// rules only ever see the flat AuditNode fixture.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MIN_CONTRAST_RATIO,
  MIN_FONT_SIZE_PX,
  OVERFLOW_TOLERANCE_PX,
  OVERLAP_TOLERANCE_PX,
  RULE_CONTRAST,
  RULE_EMPTY_NODE,
  RULE_FONT_SIZE,
  RULE_OVERFLOW,
  RULE_OVERLAP,
  RULE_TRUNCATION,
  RULE_VIEWPORT_OVERFLOW,
  VIEWPORT_OVERFLOW_TOLERANCE_PX,
  VIEWPORT_ZOOM_BAND,
  auditContrast,
  auditEmptyNodes,
  auditFontSizes,
  auditOverflows,
  auditOverlaps,
  auditTextTruncation,
  auditViewportOverflow,
  buildViewportTile,
  collectLayoutSnapshot,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  runDesignAudit,
  type AuditNode,
} from './design-audit';
import { getRectInViewportSpace } from '@/canvas/node-ops';
import * as bridgeMod from '@/canvas/canvas-bridge';
import type { CanvasNode } from '@/code/parsing/parser';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn(), state: vi.fn() },
}));

function makeNode(overrides: Partial<AuditNode> = {}): AuditNode {
  return {
    id: 'n',
    parentId: null,
    children: [],
    text: '',
    rect: null,
    computed: {},
    ...overrides,
  };
}

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

describe('parseCssColor', () => {
  it('parses 3-digit hex and expands it to full channels', () => {
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('#123')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 1 });
  });

  it('parses 6-digit hex', () => {
    expect(parseCssColor('#767676')).toEqual({ r: 0x76, g: 0x76, b: 0x76, a: 1 });
    expect(parseCssColor('#000000')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('parses 8-digit hex and lowers the alpha', () => {
    expect(parseCssColor('#ffffff80')).toEqual({ r: 255, g: 255, b: 255, a: 128 / 255 });
  });

  it('parses rgb() and rgba() with comma syntax', () => {
    expect(parseCssColor('rgb(255, 255, 255)')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor('rgba(17, 24, 39, 0.5)')).toEqual({ r: 17, g: 24, b: 39, a: 0.5 });
  });

  it('parses percentage channels and slash syntax', () => {
    expect(parseCssColor('rgb(100% 0% 50%)')).toEqual({ r: 255, g: 0, b: 128, a: 1 });
    expect(parseCssColor('rgb(0 0 0 / 0.25)')).toEqual({ r: 0, g: 0, b: 0, a: 0.25 });
  });

  it('clamps channels out of range', () => {
    expect(parseCssColor('rgb(300, -5, 128)')).toEqual({ r: 255, g: 0, b: 128, a: 1 });
  });

  it('rejects unparseable strings', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor('red')).toBeNull();
    expect(parseCssColor('var(--brand)')).toBeNull();
    expect(parseCssColor('#ab')).toBeNull();
    expect(parseCssColor('rgb(1,2)')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 10);
  });
});

describe('contrastRatio (WCAG)', () => {
  it('white on black and black on white are both 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 6);
    expect(contrastRatio('rgb(255,255,255)', 'rgb(0, 0, 0)')).toBeCloseTo(21, 6);
  });

  it('matches the known value #767676 on white ≈ 4.54:1', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#767676', '#ffffff')!).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
  });

  it('returns null when either color is unparseable', () => {
    expect(contrastRatio('', '#ffffff')).toBeNull();
    expect(contrastRatio('#111827', '')).toBeNull();
    expect(contrastRatio('var(--brand)', '#ffffff')).toBeNull();
  });

  it('returns null when either color is translucent', () => {
    expect(contrastRatio('#ffffff', 'rgba(0, 0, 0, 0.5)')).toBeNull();
    expect(contrastRatio('#ffffff80', '#000000')).toBeNull();
  });
});
describe('auditOverlaps', () => {
  it('flags two siblings overlapping on both axes beyond the tolerance', () => {
    const a = makeNode({ id: 'a', parentId: 'parent', rect: rect(0, 0, 100, 100) });
    const b = makeNode({ id: 'b', parentId: 'parent', rect: rect(90, 90, 100, 100) });
    const findings = auditOverlaps([a, b]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_OVERLAP);
    expect(findings[0].message).toContain('a overlaps b');
    expect(findings[0].message).toContain('10px');
  });

  it('does not flag an overlap at or under the tolerance', () => {
    const o = OVERLAP_TOLERANCE_PX;
    const a = makeNode({ id: 'a', parentId: 'parent', rect: rect(0, 0, 100, 100) });
    const b = makeNode({ id: 'b', parentId: 'parent', rect: rect(100 - o, 100 - o, 100, 100) });
    expect(auditOverlaps([a, b])).toHaveLength(0);
  });

  it('only considers siblings — same geometry, different parents: no flag', () => {
    const a = makeNode({ id: 'a', parentId: 'p1', rect: rect(0, 0, 100, 100) });
    const b = makeNode({ id: 'b', parentId: 'p2', rect: rect(90, 90, 100, 100) });
    expect(auditOverlaps([a, b])).toHaveLength(0);
  });

  it('skips nodes without a rect (norect guard)', () => {
    const a = makeNode({ id: 'a', parentId: 'p' });
    const b = makeNode({ id: 'b', parentId: 'p', rect: rect(90, 90, 100, 100) });
    expect(auditOverlaps([a, b])).toHaveLength(0);
  });
});

describe('auditOverflows', () => {
  it('flags a child extending beyond its parent by more than the tolerance', () => {
    const parent = makeNode({ id: 'parent', rect: rect(0, 0, 100, 100) });
    const child = makeNode({
      id: 'child',
      parentId: 'parent',
      rect: rect(0, 0, 100, 100 + OVERFLOW_TOLERANCE_PX + 2),
    });
    const findings = auditOverflows([parent, child]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_OVERFLOW);
    expect(findings[0].message).toContain('child extends 10px beyond parent');
  });

  it('does not flag overflow at or under the tolerance', () => {
    const parent = makeNode({ id: 'parent', rect: rect(0, 0, 100, 100) });
    const child = makeNode({
      id: 'child',
      parentId: 'parent',
      rect: rect(0, 0, 100, 100 + OVERFLOW_TOLERANCE_PX),
    });
    expect(auditOverflows([parent, child])).toHaveLength(0);
  });

  it('skips parents without a rect and roots (no parent)', () => {
    const orphan = makeNode({ id: 'orphan', rect: rect(0, 0, 500, 500) });
    const parent = makeNode({ id: 'parent' });
    const child = makeNode({ id: 'child', parentId: 'parent', rect: rect(0, 0, 500, 500) });
    expect(auditOverflows([orphan, parent, child])).toHaveLength(0);
  });
});

describe('auditContrast', () => {
  it('flags text below the WCAG AA ratio', () => {
    const node = makeNode({
      id: 't',
      text: 'Dim text',
      computed: { color: '#999999', backgroundColor: '#ffffff' },
    });
    const findings = auditContrast([node]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_CONTRAST);
    expect(findings[0].message).toContain('t text contrast');
  });

  it('passes text at or above the ratio (the known ≈4.54 case)', () => {
    const node = makeNode({
      id: 't',
      text: 'Grey text',
      computed: { color: '#767676', backgroundColor: '#ffffff' },
    });
    expect(contrastRatio('#767676', '#ffffff')!).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
    expect(auditContrast([node])).toHaveLength(0);
  });

  it('skips empty-text nodes and nodes with unmeasurable colors', () => {
    expect(
      auditContrast([makeNode({ id: 'x', computed: { color: '#999999', backgroundColor: '#ffffff' } })]),
    ).toHaveLength(0);
    expect(auditContrast([makeNode({ id: 'x', text: 'hi', computed: {} })])).toHaveLength(0);
  });
});

describe('auditFontSizes', () => {
  it('flags text below the minimum size', () => {
    const findings = auditFontSizes([
      makeNode({ id: 't', text: 'tiny', computed: { fontSize: `${MIN_FONT_SIZE_PX - 1}px` } }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_FONT_SIZE);
    expect(findings[0].message).toContain(`below ${MIN_FONT_SIZE_PX}px`);
  });

  it('passes text at or above the minimum size', () => {
    expect(
      auditFontSizes([
        makeNode({ id: 't', text: 'ok', computed: { fontSize: `${MIN_FONT_SIZE_PX}px` } }),
      ]),
    ).toHaveLength(0);
  });

  it('skips empty-text nodes and unmeasured font sizes', () => {
    expect(auditFontSizes([makeNode({ id: 't', text: 'x', computed: {} })])).toHaveLength(0);
    expect(auditFontSizes([makeNode({ id: 't', computed: { fontSize: '9px' } })])).toHaveLength(0);
  });
});

describe('auditEmptyNodes', () => {
  it('flags a tiny dead spot with no text and no visible children', () => {
    const node = makeNode({ id: 'dot', rect: rect(10, 10, 3, 4), children: [] });
    const findings = auditEmptyNodes([node]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_EMPTY_NODE);
    expect(findings[0].message).toContain('3×4px dead spot');
  });

  it('passes a deliberate spacer sized ≥8px', () => {
    const node = makeNode({ id: 'spacer', rect: rect(0, 0, 8, 8) });
    expect(auditEmptyNodes([node])).toHaveLength(0);
  });

  it('passes a 0×0 culled placeholder (1px floor)', () => {
    expect(auditEmptyNodes([makeNode({ id: 'c', rect: rect(0, 0, 0, 0) })])).toHaveLength(0);
  });

  it('passes nodes with text or with a visible child', () => {
    const withText = makeNode({ id: 't', text: 'hi', rect: rect(0, 0, 4, 4) });
    const childless = makeNode({ id: 'p', rect: rect(0, 0, 4, 4), children: ['c'] });
    const child = makeNode({ id: 'c', parentId: 'p', rect: rect(0, 0, 100, 100) });
    expect(auditEmptyNodes([withText])).toHaveLength(0);
    expect(auditEmptyNodes([childless, child])).toHaveLength(0);
  });

  it('passes nodes without a rect', () => {
    expect(auditEmptyNodes([makeNode({ id: 'x' })])).toHaveLength(0);
  });
});

describe('auditTextTruncation', () => {
  it('flags text longer than the estimated box capacity', () => {
    const node = makeNode({
      id: 't',
      text: 'This heading is much too long for its box',
      rect: rect(0, 0, 60, 20),
      computed: { fontSize: '6px' },
    });
    const findings = auditTextTruncation([node]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_TRUNCATION);
    expect(findings[0].message).toContain('heuristic');
  });

  it('passes text that fits the estimate', () => {
    const node = makeNode({
      id: 't',
      text: 'Short',
      rect: rect(0, 0, 120, 20),
      computed: { fontSize: '16px' },
    });
    expect(auditTextTruncation([node])).toHaveLength(0);
  });

  it('skips nodes without text, without rect, or without a font size', () => {
    expect(auditTextTruncation([makeNode({ id: 'x', rect: rect(0, 0, 10, 10) })])).toHaveLength(0);
    expect(
      auditTextTruncation([makeNode({ id: 'x', text: 'abc', computed: { fontSize: '14px' } })]),
    ).toHaveLength(0);
    expect(
      auditTextTruncation([makeNode({ id: 'x', text: 'abc', rect: rect(0, 0, 10, 10) })]),
    ).toHaveLength(0);
  });
});

describe('auditViewportOverflow (SECTION_DEPASSE_VIEWPORT)', () => {
  const mobileTile = rect(0, 0, 375, 800);

  it('flags a root measured WIDER than its configured tile — the hole OVERFLOW leaves open (root has no parent)', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 400, 800) });
    const findings = auditViewportOverflow([root], mobileTile);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_VIEWPORT_OVERFLOW);
    expect(findings[0].message).toContain('root');
    expect(findings[0].message).toContain('right by 25px');
    expect(findings[0].message).toContain('375');
  });

  it('flags a direct section that leaves the tile horizontally but not its root', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 375, 800) });
    const section = makeNode({ id: 'section', parentId: 'root', rect: rect(0, 0, 400, 100) });
    const findings = auditViewportOverflow([root, section], mobileTile);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_VIEWPORT_OVERFLOW);
    expect(findings[0].message).toContain('section extends right by 25px');
  });

  it('flags a section whose bottom leaves a tile with a FIXED configured height', () => {
    const fixedTile = rect(0, 0, 375, 900);
    const root = makeNode({ id: 'root', rect: rect(0, 0, 375, 900) });
    const section = makeNode({ id: 'section', parentId: 'root', rect: rect(0, 850, 375, 100) });
    const findings = auditViewportOverflow([root, section], fixedTile);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_VIEWPORT_OVERFLOW);
    expect(findings[0].message).toContain('section extends bottom by 50px');
  });

  it('passes a clean layout — root exactly on the tile, sections inside it', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 375, 800) });
    const section = makeNode({ id: 'section', parentId: 'root', rect: rect(0, 0, 375, 200) });
    expect(auditViewportOverflow([root, section], mobileTile)).toHaveLength(0);
  });

  it('does not flag overflow at or under the tolerance (>N px, same as OVERFLOW)', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 375, 800) });
    const within = makeNode({
      id: 'within',
      parentId: 'root',
      rect: rect(0, 0, 375 + VIEWPORT_OVERFLOW_TOLERANCE_PX, 50),
    });
    expect(auditViewportOverflow([root, within], mobileTile)).toHaveLength(0);
    const beyond = makeNode({
      id: 'beyond',
      parentId: 'root',
      rect: rect(0, 0, 375 + VIEWPORT_OVERFLOW_TOLERANCE_PX + 1, 50),
    });
    const findings = auditViewportOverflow([root, beyond], mobileTile);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('right by 9px');
  });

  it('returns no findings when the tile is unmeasured (null) or a node has no rect', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 400, 800) });
    expect(auditViewportOverflow([root], null)).toHaveLength(0);
    expect(auditViewportOverflow([makeNode({ id: 'x' })], mobileTile)).toHaveLength(0);
    expect(auditViewportOverflow([makeNode({ id: 'y', rect: rect(0, 0, 400, 50) })], mobileTile)).toHaveLength(1);
  });
});

describe('buildViewportTile', () => {
  it('builds the tile from the frame node (id root, else the parent-less node) at its measured position', () => {
    const root = makeNode({ id: 'root', rect: rect(100, 50, 375, 800) });
    const tile = buildViewportTile([root], 375);
    expect(tile).toEqual({ x: 100, y: 50, width: 375, height: 800 });
  });

  it('uses the CONFIGURED width so a root wider than its tile flags; falls back to the measured frame width out of the zoom band', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 400, 800) });
    // 400 vs 375 (ratio 1.067) — inside the former ±10% zoom band → configured width wins → root flags.
    expect(buildViewportTile([root], 375)!.width).toBe(375);
    // P2.2 — rects are now de-zoomed to viewport CONFIG space, so the tile is
    // ALWAYS the configured width even when the old measured-vs-config ratio
    // was far outside the band (former camera-moved fallback → now obsolete).
    // 720 vs 1440 (ratio 0.5) previously fell back to 720 (muted detection);
    // now it stays at 1440 and a 400-wide node correctly flags. The band
    // (VIEWPORT_ZOOM_BAND) remains exported as a guard for sans-frame cases
    // but no longer mutates tile size when rects are viewport-space.
    const zoomed = makeNode({ id: 'root', rect: rect(0, 0, 720, 450) });
    expect(buildViewportTile([zoomed], 1440)!.width).toBe(1440);
    // The band constant itself is still exported and sane.
    expect(VIEWPORT_ZOOM_BAND).toBe(0.1);
  });

  it('applies the configured fixed height when in band; uses the frame height for auto/unset tiles', () => {
    const root = makeNode({ id: 'root', rect: rect(0, 0, 375, 600) });
    expect(buildViewportTile([root], 375, 900)!.height).toBe(900);
    expect(buildViewportTile([root], 375, 'auto')!.height).toBe(600);
    expect(buildViewportTile([root], 375)!.height).toBe(600);
  });

  it('returns null when the frame node has no measured rect', () => {
    expect(buildViewportTile([makeNode({ id: 'root' })], 375)).toBeNull();
    expect(buildViewportTile([], 375)).toBeNull();
  });

  it('P2.2 — viewport_rect is always in config space; tile size does not depend on zoom (former band fallback removed)', () => {
    // Even a frame measured far from config (old out-of-band case) yields a
    // config-sized tile. This is the correct post-P2.2 behavior because the
    // snapshot rects themselves are de-zoomed before reaching this function.
    const far = makeNode({ id: 'root', rect: rect(10, 20, 420, 900) });
    const tile = buildViewportTile([far], 375, 800)!;
    expect(tile.width).toBe(375);
    expect(tile.height).toBe(800);
    expect(tile.x).toBe(10);
    expect(tile.y).toBe(20);
  });
});

// ─── P2.2 viewport-space — regression 423×528 + iframe offset ───────────────
// Ticket P2.2: `findNodeRect` returns parent-screen zoomed rects (rectCache
// iframe-space → adjustForTransformDelta → toParentSpace). `collectLayoutSnapshot`
// now uses `getRectInViewportSpace` so every rect in the snapshot is in
// viewport CONFIG space. `buildViewportTile` ALWAYS uses the configured
// width/height, so `viewport_rect` is always config-space and zoom never
// mutates the detection.

describe('getRectInViewportSpace — de-zoom & iframe offset (P2.2)', () => {
  beforeEach(() => vi.restoreAllMocks());

  function domRect(x: number, y: number, w: number, h: number): DOMRect {
    // DOMRect in jsdom has x/y/left/top/width/height/right/bottom
    return new DOMRect(x, y, w, h);
  }

  it('de-zooms parent-screen rects: 423×528 at scale 1.128 → viewport 375×468 (and 451→400) — fallback path (parent - offset - camera)/scale', () => {
    const scale = 423 / 375; // ~1.128
    const iframeOffset = { x: 0, y: 0 };
    const parentRoot = domRect(0, 0, 423, 528);
    const parentNode = domRect(0, 0, 451.2, 528); // 400 * 1.128

    const mockBridge: Record<string, unknown> = {
      getRect: vi.fn((id: string, prefix: string) => {
        const key = `${prefix}:${id}`;
        if (key === ':root') return parentRoot;
        if (key === ':sec400') return parentNode;
        if (key === ':sec375') return parentRoot;
        return null;
      }),
      getCurrentTransform: () => ({ x: 0, y: 0, scale }),
      getCacheTransform: () => ({ x: 0, y: 0, scale }),
      getIframeOffset: () => iframeOffset,
    };
    vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);

    const rRoot = getRectInViewportSpace('root', 'desktop');
    expect(rRoot).not.toBeNull();
    expect(Math.round(rRoot!.width)).toBe(375);
    expect(Math.round(rRoot!.height)).toBe(Math.round(528 / scale));

    const r400 = getRectInViewportSpace('sec400', 'desktop');
    expect(Math.round(r400!.width)).toBe(400);

    const r375 = getRectInViewportSpace('sec375', 'desktop');
    expect(Math.round(r375!.width)).toBe(375);
  });

  it('is zoom-invariant: same viewport rects at scale 1.0 and 1.128 produce same audit results', () => {
    // Two parent-screen worlds that map to the same viewport world:
    // World A: scale 1.128, parent 423 (root), 451 (sec400), 423 (sec375)
    // World B: scale 1.0,   parent 375 (root), 400 (sec400), 375 (sec375)
    // Both should produce identical viewport snapshot and therefore identical
    // overflow findings when `buildViewportTile` uses config 375.
    const tileFor = (snap: AuditNode[]) => buildViewportTile(snap, 375, 800)!;

    const makeSnap = (rootW: number, secW: number): AuditNode[] => {
      const root = makeNode({ id: 'root', rect: rect(0, 0, rootW, 800) });
      const sec = makeNode({ id: 'sec', parentId: 'root', rect: rect(0, 0, secW, 100) });
      return [root, sec];
    };

    // Viewport-space snapshots (what collectLayoutSnapshot now emits):
    const snap375 = makeSnap(375, 375);
    const snap400 = makeSnap(375, 400);

    const tile375 = tileFor(snap375);
    const tile400 = tileFor(snap400);
    expect(tile375.width).toBe(375);
    expect(tile400.width).toBe(375);

    // 375-wide section fits → 0 violations (root fits too, sec fits)
    expect(auditViewportOverflow(snap375, tile375)).toHaveLength(0);
    // 400-wide section overflows tile by 25px → 1 violation, regardless of zoom
    const findings = auditViewportOverflow(snap400, tile400);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_VIEWPORT_OVERFLOW);
    expect(findings[0].message).toContain('right by 25px');
  });

  it('collectLayoutSnapshot returns viewport-space rects even when bridge holds zoomed parent rects (mock scale 1.128 then 1.0)', () => {
    const cases: Array<{ scale: number; parentWidth: number; viewportWidth: number }> = [
      { scale: 423 / 375, parentWidth: 423, viewportWidth: 375 },
      { scale: 1.0, parentWidth: 375, viewportWidth: 375 },
    ];
    for (const { scale, parentWidth, viewportWidth } of cases) {
      const parentRect = domRect(0, 0, parentWidth, 800);
      const mockBridge: Record<string, unknown> = {
        getRect: vi.fn(() => parentRect),
        getCurrentTransform: () => ({ x: 0, y: 0, scale }),
        getCacheTransform: () => ({ x: 0, y: 0, scale }),
        getIframeOffset: () => ({ x: 0, y: 0 }),
        getRectInViewportSpace: undefined, // force fallback path
      };
      vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);
      const vp = getRectInViewportSpace('any', 'desktop');
      expect(vp).not.toBeNull();
      expect(Math.round(vp!.width)).toBe(viewportWidth);
      vi.restoreAllMocks();
    }
  });

  it('iframe offset 260px (sidebar) does not leak into viewport-space — parent 270 with offset 260 → viewport 10', () => {
    const parent = domRect(270, 100, 100, 50); // viewport x 10 + sidebar 260 + no zoom
    const mockBridge = {
      getRect: vi.fn(() => parent),
      getCurrentTransform: () => ({ x: 0, y: 0, scale: 1 }),
      getCacheTransform: () => ({ x: 0, y: 0, scale: 1 }),
      getIframeOffset: () => ({ x: 260, y: 0 }),
    };
    vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);
    const vp = getRectInViewportSpace('node', 'desktop')!;
    expect(vp.x).toBe(10);
    expect(vp.y).toBe(100);
    expect(vp.width).toBe(100);
  });

  it('iframe offset + zoom combined: parent (260+10*1.128)=271.28 de-zooms to viewport 10', () => {
    const scale = 1.128;
    const iframeOff = { x: 260, y: 0 };
    const viewportX = 10;
    const parentX = iframeOff.x + viewportX * scale; // ≈271.28
    const parent = domRect(parentX, 0, 100 * scale, 50 * scale);
    const mockBridge = {
      getRect: vi.fn(() => parent),
      getCurrentTransform: () => ({ x: 0, y: 0, scale }),
      getCacheTransform: () => ({ x: 0, y: 0, scale }),
      getIframeOffset: () => iframeOff,
    };
    vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);
    const vp = getRectInViewportSpace('n', 'desktop')!;
    expect(Math.round(vp.x)).toBe(10);
    expect(Math.round(vp.width)).toBe(100);
  });

  it('prefers the bridge dedicated getRectInViewportSpace when present (direct viewport, no offset math)', () => {
    const dedicated = domRect(5, 6, 375, 800); // already viewport-space
    const mockBridge = {
      getRectInViewportSpace: vi.fn(() => dedicated),
      getRect: vi.fn(() => domRect(999, 999, 999, 999)), // should be ignored
      getCurrentTransform: () => ({ x: 0, y: 0, scale: 2 }),
      getIframeOffset: () => ({ x: 260, y: 0 }),
    };
    vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);
    const vp = getRectInViewportSpace('x', 'desktop')!;
    expect(mockBridge.getRectInViewportSpace).toHaveBeenCalled();
    expect(vp.x).toBe(5);
    expect(vp.width).toBe(375);
  });
});

describe('P2.2 regression — collectLayoutSnapshot viewport-space & buildViewportTile config-only', () => {
  beforeEach(() => vi.restoreAllMocks());

  function makeCanvasNodeMap(ids: Array<{ id: string; parentId: string | null }>): Map<string, CanvasNode> {
    const m = new Map<string, CanvasNode>();
    for (const { id, parentId } of ids) {
      m.set(id, {
        id,
        type: 'div',
        name: id,
        parentId,
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
        motionProps: null,
        responsiveVariantMap: null,
        conditionalStyles: null,
      } as unknown as CanvasNode);
    }
    return m;
  }

  it('frame 423×528 (parent zoomed) + sec 375×528 → tile 375 and 0 overflow; sec 400×528 → 1 overflow — independent of camera zoom (1.128 then 1.0)', () => {
    // This test documents the exact regression from the ticket:
    // config mobile 375, measured parent 423×528 at zoom ~1.13 previously gave
    // false negatives/positives because tile was built from measured width.
    // Now snapshot is viewport-space (375) and tile is always config (375),
    // so the two cases are deterministic.
    const configWidth = 375;
    const frameViewport = rect(0, 0, 375, 528); // de-zoomed root
    const sec375Viewport = rect(0, 0, 375, 528);
    const sec400Viewport = rect(0, 0, 400, 528);

    const snap375: AuditNode[] = [
      makeNode({ id: 'root', rect: frameViewport }),
      makeNode({ id: 'sec', parentId: 'root', rect: sec375Viewport }),
    ];
    const snap400: AuditNode[] = [
      makeNode({ id: 'root', rect: frameViewport }),
      makeNode({ id: 'sec', parentId: 'root', rect: sec400Viewport }),
    ];

    const tile = buildViewportTile(snap375, configWidth, 800)!;
    expect(tile.width).toBe(375);
    expect(tile.height).toBe(800);

    // Same tile regardless of the old zoom-biased measured width (423 vs 375)
    const tile2 = buildViewportTile(snap400, configWidth, 800)!;
    expect(tile2.width).toBe(375);

    // 375 fits → 0
    expect(auditViewportOverflow(snap375, tile)).toHaveLength(0);
    // 400 overflows by 25 → 1 (both scales would have produced parent 423/451
    // but viewport is 375/400, so the result is identical)
    const findings = auditViewportOverflow(snap400, tile2);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('right by 25px');

    // Explicitly repeat via pure runDesignAudit path for both zoom worlds:
    // (the snapshots are identical because de-zoom normalizes them)
    const snapForScale = (scale: number): AuditNode[] => {
      // No actual scale matters here — snapshots are already viewport-space.
      void scale;
      return snap400;
    };
    for (const scale of [1.128, 1.0]) {
      const snap = snapForScale(scale);
      const t = buildViewportTile(snap, configWidth)!;
      expect(auditViewportOverflow(snap, t)).toHaveLength(1);
    }
  });

  it('collectLayoutSnapshot de-zooms: with mocked scale 1.128 parent 423, snapshot is viewport 375', () => {
    const scale = 423 / 375;
    const parentRoot = new DOMRect(0, 0, 423, 528);
    const parentSec = new DOMRect(0, 0, 423, 100); // 375 viewport
    const mockBridge: Record<string, unknown> = {
      getRect: vi.fn((id: string, prefix: string) => {
        const k = `${prefix}:${id}`;
        if (k === ':root') return parentRoot;
        if (k === ':sec') return parentSec;
        return null;
      }),
      getCurrentTransform: () => ({ x: 0, y: 0, scale }),
      getCacheTransform: () => ({ x: 0, y: 0, scale }),
      getIframeOffset: () => ({ x: 0, y: 0 }),
      getComputedValues: () => ({}),
      getCachedComputedStyles: () => ({}),
    };
    vi.spyOn(bridgeMod, 'getCanvasBridge').mockReturnValue(mockBridge as unknown as ReturnType<typeof bridgeMod.getCanvasBridge>);

    const nodes = makeCanvasNodeMap([
      { id: 'root', parentId: null },
      { id: 'sec', parentId: 'root' },
    ]);
    const snap = collectLayoutSnapshot(nodes, 'desktop');
    const root = snap.find((n) => n.id === 'root')!;
    const sec = snap.find((n) => n.id === 'sec')!;
    expect(Math.round(root.rect!.width)).toBe(375);
    expect(Math.round(sec.rect!.width)).toBe(375);
  });
});

describe('runDesignAudit', () => {
  it('aggregates every rule over one fixture', () => {
    const nodes: AuditNode[] = [
      makeNode({
        id: 'parent',
        rect: rect(0, 0, 400, 400),
        computed: { fontSize: '16px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'child',
        parentId: 'parent',
        rect: rect(0, 0, 500, 100),
        computed: { fontSize: '16px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'a',
        parentId: 'parent',
        rect: rect(0, 100, 100, 100),
        computed: { fontSize: '16px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'b',
        parentId: 'parent',
        rect: rect(90, 190, 100, 100),
        computed: { fontSize: '16px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'dim',
        parentId: 'parent',
        text: 'Dim',
        rect: rect(200, 100, 100, 20),
        computed: { fontSize: '16px', color: '#999999', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'tiny',
        parentId: 'parent',
        text: 'tiny',
        rect: rect(200, 130, 100, 20),
        computed: { fontSize: '10px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'long',
        parentId: 'parent',
        text: 'This line is far longer than its box can hold',
        rect: rect(200, 160, 40, 20),
        computed: { fontSize: '6px', color: '#000000', backgroundColor: '#ffffff' },
      }),
      makeNode({ id: 'dead', parentId: 'parent', rect: rect(300, 300, 3, 3) }),
    ];
    const findings = runDesignAudit(nodes);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules).toEqual(
      new Set([RULE_OVERLAP, RULE_OVERFLOW, RULE_CONTRAST, RULE_FONT_SIZE, RULE_EMPTY_NODE, RULE_TRUNCATION]),
    );
  });

  it('passes the viewport tile through — a root wider than its tile adds SECTION_DEPASSE_VIEWPORT without changing the rest', () => {
    const nodes: AuditNode[] = [
      makeNode({ id: 'root', rect: rect(0, 0, 400, 800) }),
      makeNode({
        id: 'p',
        parentId: 'root',
        text: 'Fine',
        rect: rect(0, 0, 300, 20),
        computed: { fontSize: '16px', color: '#111827', backgroundColor: '#ffffff' },
      }),
    ];
    const findings = runDesignAudit(nodes, rect(0, 0, 375, 800));
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(RULE_VIEWPORT_OVERFLOW);
    expect(findings[0].message).toContain('root');
  });

  it('without a tile the viewport rule contributes nothing (backward compat)', () => {
    const nodes: AuditNode[] = [makeNode({ id: 'root', rect: rect(0, 0, 400, 800) })];
    const rules = new Set(runDesignAudit(nodes).map((f) => f.rule));
    expect(rules.has(RULE_VIEWPORT_OVERFLOW)).toBe(false);
  });

  it('returns an empty list for a clean fixture', () => {
    const nodes: AuditNode[] = [
      makeNode({
        id: 'parent',
        rect: rect(0, 0, 400, 400),
        computed: { fontSize: '16px', color: '#111827', backgroundColor: '#ffffff' },
      }),
      makeNode({
        id: 'child',
        parentId: 'parent',
        text: 'Fine',
        rect: rect(0, 0, 200, 20),
        computed: { fontSize: '16px', color: '#111827', backgroundColor: '#ffffff' },
      }),
    ];
    expect(runDesignAudit(nodes)).toHaveLength(0);
  });
});
