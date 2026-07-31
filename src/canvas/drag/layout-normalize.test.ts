import { describe, test, expect } from 'vitest';
import { normalizeLayoutDescriptor } from './layout-normalize';
import type { NewNodeDescriptor } from '@/shared/types';

const n = (tag: string, styles: Record<string, string>, children?: NewNodeDescriptor[]): NewNodeDescriptor =>
  ({ tag, styles, children });

describe('normalizeLayoutDescriptor — host guarantees compliance for naive plugin trees', () => {
  test('adds position:relative when missing, preserves author-set position', () => {
    const r = normalizeLayoutDescriptor(n('div', {}, [n('div', { position: 'absolute' })]));
    expect(r.styles.position).toBe('relative');
    expect(r.children![0].styles.position).toBe('absolute');
  });

  test('swaps transparent → rgba(0, 0, 0, 0), then moves the solid to backgroundColor', () => {
    const r = normalizeLayoutDescriptor(n('button', { background: 'transparent', color: '#000' }));
    expect(r.styles.background).toBeUndefined();
    expect(r.styles.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(r.styles.color).toBe('#000');
  });

  test('moves a solid background → backgroundColor (Fill panel reads backgroundColor)', () => {
    const hex = normalizeLayoutDescriptor(n('div', { background: '#0a0c11' }));
    expect(hex.styles.background).toBeUndefined();
    expect(hex.styles.backgroundColor).toBe('#0a0c11');
    const rgba = normalizeLayoutDescriptor(n('div', { background: 'rgba(255,255,255,0.1)' }));
    expect(rgba.styles.backgroundColor).toBe('rgba(255,255,255,0.1)');
  });

  test('leaves gradients / images on background (not a solid colour)', () => {
    const grad = normalizeLayoutDescriptor(n('div', { background: 'linear-gradient(#fff, #000)' }));
    expect(grad.styles.background).toBe('linear-gradient(#fff, #000)');
    expect(grad.styles.backgroundColor).toBeUndefined();
  });

  test('does not clobber an existing backgroundColor', () => {
    const r = normalizeLayoutDescriptor(n('div', { background: '#111', backgroundColor: '#222' }));
    expect(r.styles.backgroundColor).toBe('#222');
    expect(r.styles.background).toBeUndefined();
  });

  test('strips forbidden alignItems stretch/baseline', () => {
    expect(normalizeLayoutDescriptor(n('div', { display: 'flex', alignItems: 'stretch' })).styles.alignItems).toBeUndefined();
    expect(normalizeLayoutDescriptor(n('div', { display: 'flex', alignItems: 'baseline' })).styles.alignItems).toBeUndefined();
    expect(normalizeLayoutDescriptor(n('div', { display: 'flex', alignItems: 'center' })).styles.alignItems).toBe('center');
  });

  test('padded div with no layout gets display:flex + column', () => {
    const r = normalizeLayoutDescriptor(n('div', { padding: '40px' }));
    expect(r.styles.display).toBe('flex');
    expect(r.styles.flexDirection).toBe('column');
  });
  test('zero padding does NOT force a layout', () => {
    expect(normalizeLayoutDescriptor(n('div', { padding: '0px' })).styles.display).toBeUndefined();
  });

  test('assigns sequential quoted order to flex/grid flow children', () => {
    const r = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [n('p', {}), n('p', {}), n('button', {})]));
    expect(r.children!.map((c) => c.styles.order)).toEqual(['0', '1', '2']);
  });

  test('absolute children are exempt from order (and do not consume an index)', () => {
    const r = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [
      n('div', { position: 'absolute' }), n('p', {}), n('p', {}),
    ]));
    expect(r.children![0].styles.order).toBeUndefined();
    expect(r.children![1].styles.order).toBe('0');
    expect(r.children![2].styles.order).toBe('1');
  });

  test('forces flex-shrink 0 (Hug for no flex, keeps grow for Fill)', () => {
    const r = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [
      n('p', {}),                       // no flex → Hug
      n('div', { flex: '1 1 0px' }),    // Fill w/ shrink → shrink 0
      n('div', { flex: '1' }),          // single grow → Fill
    ]));
    expect(r.children![0].styles.flex).toBe('0 0 auto');
    expect(r.children![1].styles.flex).toBe('1 0 0px');
    expect(r.children![2].styles.flex).toBe('1 0 0px');
  });

  test('grid children get order but NOT a shrink rewrite', () => {
    const r = normalizeLayoutDescriptor(n('div', { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' }, [n('div', {}), n('div', {})]));
    expect(r.children!.map((c) => c.styles.order)).toEqual(['0', '1']);
    expect(r.children![0].styles.flex).toBeUndefined();
  });
});

// POSITION_OFFSET_REQUIRES_ABSOLUTE — the module defaults a position-less node
// to 'relative' (NODE_MISSING_POSITION), which silently turned any left/top the
// descriptor carried into dead CSS. Dead is not harmless: '0px' matches the
// Position tool's pin detector, so the panel shows a pin that places nothing and
// the first drag rewrites it (user report 2026-07-26 — a page carrying 39).
describe('POSITION_OFFSET_REQUIRES_ABSOLUTE', () => {
  test('drops offsets when the node defaults to relative', () => {
    const r = normalizeLayoutDescriptor(n('div', { left: '0px', top: '0px', width: '32px' }));
    expect(r.styles!.position).toBe('relative');
    expect(r.styles!.left).toBeUndefined();
    expect(r.styles!.top).toBeUndefined();
  });

  test('drops offsets on an author-declared relative too', () => {
    const r = normalizeLayoutDescriptor(n('div', { position: 'relative', left: '24px', bottom: '8px' }));
    expect(r.styles!.left).toBeUndefined();
    expect(r.styles!.bottom).toBeUndefined();
  });

  test('KEEPS offsets on absolute / fixed / sticky — there they do the placing', () => {
    for (const position of ['absolute', 'fixed', 'sticky']) {
      const r = normalizeLayoutDescriptor(n('div', { position, left: '10px', top: '20px' }));
      expect(r.styles!.position).toBe(position);
      expect(r.styles!.left).toBe('10px');
      expect(r.styles!.top).toBe('20px');
    }
  });
});

// ─── SVG subtrees: textContent IS markup, never entity-escaped ────────────────
// A brand-logo plugin drops a native vector via `{ tag:'svg', textContent:
// '<path …/>' }` (same inner-markup contract as assets.addSvg). Escaping `<`
// there corrupts the shape into literal text (live find 2026-07-28); text
// elements outside svg keep the escape (raw `<`/`{` would emit unparseable JSX).
describe('svg inner markup', () => {
  test('svg root textContent is NOT escaped', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg',
      styles: { width: '96px', height: '96px' },
      textContent: '<path d="M0 0h24v24H0z" fill="#111"/>',
    } as NewNodeDescriptor);
    expect(r.textContent).toBe('<path d="M0 0h24v24H0z" fill="#111"/>');
  });

  test('descendants inside an svg keep raw markup too', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg',
      styles: {},
      children: [{ tag: 'g', styles: {}, textContent: '<path d="M1 1"/>' } as NewNodeDescriptor],
    } as NewNodeDescriptor);
    expect(r.children![0].textContent).toBe('<path d="M1 1"/>');
  });

  test('non-svg textContent still escapes JSX specials', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'p',
      styles: {},
      textContent: '<50ms {fast}',
    } as NewNodeDescriptor);
    expect(r.textContent).toBe('&lt;50ms &#123;fast&#125;');
  });
});

// ─── SVG shape-dialect 1:1 normalization on drop ─────────────────────────────
// The editor's svg system (resize geometry baking, shape edit) assumes
// `viewBox === 0 0 W H` in px. A dropped foreign vector keeping its source
// space (0 0 116 48 in a 155×64 box) mangles on first resize (2026-07-28).
describe('svg 1:1 geometry normalization', () => {
  test('flat-path markup is rescaled into the px box', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg',
      attrs: { viewBox: '0 0 116 48' },
      styles: { position: 'relative', width: '155px', height: '64px' },
      textContent: '<path fill="#244C4E" d="M0 0 L116 48"/>',
    } as NewNodeDescriptor);
    expect(r.attrs!.viewBox).toBe('0 0 155 64');
    // 116 * (155/116) = 155, 48 * (64/48) = 64 — end point lands on the box corner.
    expect(r.textContent).toContain('d="M 0 0 L 155 64"');
  });

  test('markup with its own transforms keeps the source viewBox (safe bail)', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg',
      attrs: { viewBox: '0 0 116 48' },
      styles: { position: 'relative', width: '155px', height: '64px' },
      textContent: '<g transform="translate(-76,-142)"><path d="M0 0 L10 10"/></g>',
    } as NewNodeDescriptor);
    expect(r.attrs!.viewBox).toBe('0 0 116 48');
    expect(r.textContent).toContain('translate(-76,-142)');
  });
});

// ─── SVG drop → native shape grammar (Figma-import parity) ───────────────────
// A dropped multi-shape vector must become the builder's group grammar so
// every letterform is double-click editable with vertices (user report
// 2026-07-28: dropped wordmark showed NO vertices — flat markup renders but
// isn't shape-editable).
describe('svg drop decomposition into shape grammar', () => {
  const TWO_PATHS = '<path fill="#FF7A00" d="M0 0 L58 24 L0 24 Z"/><path fill="#0044FF" d="M58 0 L116 48 L58 48 Z"/>';

  test('multi-shape svg with an id becomes nested per-shape svgs + path children', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop1', name: 'Ahrefs',
      attrs: { viewBox: '0 0 116 48' },
      styles: { position: 'relative', width: '232px', height: '96px' },
      textContent: TWO_PATHS,
    } as NewNodeDescriptor);
    expect(r.textContent).toBeUndefined();
    expect(r.attrs!.viewBox).toBe('0 0 232 96');
    expect(r.attrs!.preserveAspectRatio).toBe('none');
    expect(r.styles!.overflow).toBe('visible');
    expect(r.children!.length).toBe(2);
    const s0 = r.children![0];
    expect(s0.tag).toBe('svg');
    expect(s0.id).toBe('svg-drop1-s0');
    expect(s0.name).toBe('Ahrefs 1');
    // BBOX-FITTED child (the groupSvgs/refit convention): the first path's
    // scaled bbox is 0,0 → 116×48, so the child svg IS that box, 1:1.
    expect(s0.attrs!.x).toBe('0');
    expect(s0.attrs!.width).toBe('116');
    expect(s0.attrs!.height).toBe('48');
    expect(s0.attrs!.viewBox).toBe('0 0 116 48');
    const p0 = s0.children![0];
    expect(p0.tag).toBe('path');
    expect(p0.id).toBe('svg-drop1-s0-g0');
    expect(p0.attrs!.fill).toBe('#FF7A00');
    // 2× scale: 58,24 → 116,48 (local coords — bbox origin is 0,0 here)
    expect(p0.attrs!.d).toContain('116');
    // Second shape sits at its own offset with LOCAL path coords.
    const s1 = r.children![1];
    expect(s1.attrs!.x).toBe('116');
    expect(s1.children![0].attrs!.d.startsWith('M 0 0')).toBe(true);
    // Grammar children stay CSS-clean (no injected position/flex).
    expect(Object.keys(s0.styles ?? {})).toEqual([]);
    expect(Object.keys(p0.styles ?? {})).toEqual([]);
  });

  test('single-shape svg gets one path child directly', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop2',
      attrs: { viewBox: '0 0 24 24' },
      styles: { position: 'relative', width: '96px', height: '96px' },
      textContent: '<path fill="#111" d="M0 0 H24 V24 Z"/>',
    } as NewNodeDescriptor);
    expect(r.children!.length).toBe(1);
    expect(r.children![0].tag).toBe('path');
    expect(r.children![0].id).toBe('svg-drop2-g0');
    expect(r.attrs!.viewBox).toBe('0 0 96 96');
  });

  test('id-less pass (bridge) leaves textContent for the strategy pass', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg',
      attrs: { viewBox: '0 0 24 24' },
      styles: { position: 'relative', width: '96px', height: '96px' },
      textContent: '<path fill="#111" d="M0 0 H24 V24 Z"/>',
    } as NewNodeDescriptor);
    expect(r.children ?? []).toEqual([]);
    expect(r.textContent).toContain('<path');
  });

  test('gradient markup bails to source viewBox (no decompose, no rescale)', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop3',
      attrs: { viewBox: '0 0 24 24' },
      styles: { position: 'relative', width: '96px', height: '96px' },
      textContent: '<defs><linearGradient id="g"><stop stop-color="#f00"/></linearGradient></defs><path fill="url(#g)" d="M0 0 H24"/>',
    } as NewNodeDescriptor);
    expect(r.attrs!.viewBox).toBe('0 0 24 24');
    expect(r.textContent).toContain('linearGradient');
  });

  test('a FULL-CANVAS clipPath wrapper is stripped and the svg still decomposes (Ahrefs shape)', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop4', name: 'Ahrefs',
      attrs: { viewBox: '0 0 806 206' },
      styles: { position: 'relative', width: '403px', height: '103px' },
      textContent: '<clipPath id="a"><path d="m0 0h806v206h-806z"/></clipPath><g clip-path="url(#a)"><path fill="#f80" d="M0 0 L806 206"/><g fill="#054ada"><path d="M10 10 L20 20"/><path d="M30 30 L40 40"/></g></g>',
    } as NewNodeDescriptor);
    expect(r.textContent).toBeUndefined();
    expect(r.children!.length).toBe(3);           // 3 paths → 3 shape svgs
    expect(r.attrs!.viewBox).toBe('0 0 403 103'); // 1:1 with the px box
    const fills = r.children!.map((c) => c.children![0].attrs!.fill);
    expect(fills).toEqual(['#f80', '#054ada', '#054ada']); // group fill inherited
  });

  test('RELATIVE-command paths (svgl exports) get truly LOCAL coords per child', () => {
    // First `m` of a path is spec-absolute even lowercase — the translation
    // must shift it or the child's declared box and its painted geometry
    // disagree and a later group refit scatters the letters (2026-07-28).
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop6',
      attrs: { viewBox: '0 0 100 50' },
      styles: { position: 'relative', width: '100px', height: '50px' },
      textContent: '<path fill="#f80" d="m 10 10 h 20 v 20 h -20 z"/><path fill="#054ada" d="m 60 5 l 30 40 h -30 z"/>',
    } as NewNodeDescriptor);
    expect(r.children!.length).toBe(2);
    const s1 = r.children![1];
    expect(s1.attrs!.x).toBe('60');
    expect(s1.attrs!.y).toBe('5');
    // Local space: the first moveto lands at 0 0 inside the child's own box.
    expect(s1.children![0].attrs!.d.startsWith('m 0 0')).toBe(true);
  });

  test('a REAL (partial) clipPath still bails to flat markup', () => {
    const r = normalizeLayoutDescriptor({
      tag: 'svg', id: 'svg-drop5',
      attrs: { viewBox: '0 0 100 100' },
      styles: { position: 'relative', width: '100px', height: '100px' },
      textContent: '<clipPath id="c"><path d="m0 0h50v50h-50z"/></clipPath><g clip-path="url(#c)"><path fill="#111" d="M0 0 H100"/></g>',
    } as NewNodeDescriptor);
    expect(r.textContent).toContain('clipPath');
    expect(r.children ?? []).toEqual([]);
  });
});
