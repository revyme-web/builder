// convert.test.ts — the figma→dialect transformation rules, one by one.
// The converter EMBEDS the dialect rulebook (the same morals the oracle
// verifies on AI submissions): explicit position/width/height everywhere,
// flex parents → relative children with quoted order + non-shrinking flex,
// no-layout parents → pinned absolute children, padded frames declare a
// layout, no transform strings, images as background frames, dialect svg.

import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { convertFigmaPayload, parseFigmaSvg, resolveCssVars } from './convert';
import type { FigmaPayload, FigmaPayloadNode } from './payload-types';

const payload = (nodes: FigmaPayloadNode[], roots?: string[]): FigmaPayload => ({
  version: '5.0',
  source: 'figma-plugin',
  nodes,
  rootNodeIds: roots ?? [nodes[nodes.length - 1].id],
});

const byId = (data: ReturnType<typeof convertFigmaPayload>, id: string) => {
  const n = data.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`node ${id} missing: ${data.nodes.map((x) => x.id).join(', ')}`);
  return n;
};

describe('convertFigmaPayload — layout frames (auto-layout)', () => {
  const AUTO = payload([
    { id: 't1', name: 'Title', kind: 'text', styles: { color: '#111111', fontSize: '24px' }, text: 'Hello' },
    { id: 't2', name: 'Sub', kind: 'text', styles: { color: '#333333' }, text: 'World' },
    { id: 'frame', name: 'Card', kind: 'div', children: ['t1', 't2'], styles: {
      display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px',
      width: '400px', height: '300px', background: '#ffffff',
    } },
  ]);

  it('flex children become relative flow children with quoted order + non-shrinking flex', () => {
    const data = convertFigmaPayload(AUTO);
    const t1 = byId(data, 't1');
    const t2 = byId(data, 't2');
    expect(t1.styles.position).toBe('relative');
    expect(t1.styles.flex).toBe('0 0 auto');
    expect(t1.styles.order).toBe('0');
    expect(t2.styles.order).toBe('1');
    expect(t1.attrs?.['data-pinned']).toBeUndefined();
  });

  it('figma flex-grow children normalize to the Fill form 1 0 0px', () => {
    const p = payload([
      { id: 'a', name: 'A', kind: 'div', children: [], styles: { flex: '1 0 0', width: '10px', height: '10px' } },
      { id: 'row', name: 'Row', kind: 'div', children: ['a'], styles: { display: 'flex', width: '100px', height: '20px' } },
    ]);
    expect(byId(convertFigmaPayload(p), 'a').styles.flex).toBe('1 0 0px');
  });

  it('short-lined multi-line text (headings) becomes ONE <p> with real <br/> breaks \u2014 typography stays on the text node', () => {
    const p = payload([
      { id: 't', name: 'T', kind: 'text', styles: { width: '461px', fontSize: '82px' }, text: 'Virtual          Reality\n   Augmented\nEducation.' },
    ]);
    const data = convertFigmaPayload(p);
    const t = byId(data, 't');
    // NOT the old flex-column wrapper + <p>-per-line shape: that carried
    // every text style on a div the builder's text tools can't edit.
    expect(t.type).toBe('p');
    expect(t.children.length).toBe(0);
    expect(t.styles.fontSize).toBe('82px'); // ON the text node, not a wrapper
    expect(t.styles.whiteSpace).toBe('nowrap'); // a fallback font must never re-wrap a line
    // space RUNS become NBSP (JSX collapses plain whitespace at render);
    // authored newlines become structural <br/> elements.
    expect(t.textContent).toBe(
      'Virtual' + '\u00A0'.repeat(10) + 'Reality<br/>' + '\u00A0'.repeat(3) + 'Augmented<br/>Education.',
    );
  });

  it('long-lined multi-line text (paragraphs) keeps pre-wrap so it can soft-wrap', () => {
    const long = 'This is a long paragraph line that soft wraps well past forty characters\nand a second long paragraph line that also exceeds the heading threshold';
    const p = payload([
      { id: 't', name: 'T', kind: 'text', styles: { width: '300px' }, text: long },
    ]);
    expect(byId(convertFigmaPayload(p), 't').styles.whiteSpace).toBe('pre-wrap');
  });

  it('text nodes are <p> with margin 0 and explicit sizing', () => {
    const t1 = byId(convertFigmaPayload(AUTO), 't1');
    expect(t1.type).toBe('p');
    expect(t1.textContent).toBe('Hello');
    expect(t1.styles.margin).toBe('0px');
    expect(t1.styles.width).toBe('max-content');
    expect(t1.styles.height).toBe('auto');
  });

  it('a plain background paint splits to backgroundColor', () => {
    const frame = byId(convertFigmaPayload(AUTO), 'frame');
    expect(frame.styles.backgroundColor).toBe('#ffffff');
    expect(frame.styles.background).toBeUndefined();
  });
});

describe('convertFigmaPayload — freeform frames (no auto-layout)', () => {
  const FREE = payload([
    { id: 'chip', name: 'Chip', kind: 'div', children: [], styles: {
      width: '80px', height: '32px', left: '24px', top: '40px', background: '#ff0000',
    } },
    { id: 'frame', name: 'Hero', kind: 'div', children: ['chip'], styles: {
      width: '1440px', height: '800px', background: '#fafafa',
    } },
  ]);

  it('children of a no-layout parent become pinned absolutes with explicit offsets', () => {
    const chip = byId(convertFigmaPayload(FREE), 'chip');
    expect(chip.styles.position).toBe('absolute');
    expect(chip.styles.left).toBe('24px');
    expect(chip.styles.top).toBe('40px');
    expect(chip.attrs?.['data-pinned']).toBe('true');
  });

  it('roots are absolute with computedDimensions for canvas placement', () => {
    const frame = byId(convertFigmaPayload(FREE), 'frame');
    expect(frame.styles.position).toBe('absolute');
    expect(frame.computedDimensions).toEqual({ width: '1440px', height: '800px' });
    expect(frame.parentId).toBeNull();
  });
});

describe('convertFigmaPayload — style sanitizing', () => {
  it('padded frame with no layout gains display flex (padding needs a layout)', () => {
    const p = payload([
      { id: 'f', name: 'F', kind: 'div', children: [], styles: { padding: '20px', width: '100px', height: '100px' } },
    ]);
    const f = byId(convertFigmaPayload(p), 'f');
    expect(f.styles.display).toBe('flex');
    expect(f.styles.flexDirection).toBe('column');
  });

  it('alignItems stretch/baseline are dropped; inline-flex normalizes', () => {
    const p = payload([
      { id: 'f', name: 'F', kind: 'div', children: [], styles: {
        display: 'inline-flex', alignItems: 'stretch', width: '10px', height: '10px',
      } },
    ]);
    const f = byId(convertFigmaPayload(p), 'f');
    expect(f.styles.display).toBe('flex');
    expect(f.styles.alignItems).toBeUndefined();
  });

  it('rotated absolutes get top-left→center origin compensation', () => {
    const p = payload([
      { id: 'r', name: 'R', kind: 'div', children: [], styles: {
        transform: 'rotate(90deg)', width: '100px', height: '50px', left: '200px', top: '100px',
      } },
      { id: 'wrap', name: 'W', kind: 'div', children: ['r'], styles: { width: '800px', height: '600px' } },
    ]);
    const r = byId(convertFigmaPayload(p), 'r');
    // Emitted as the builder's REAL rotation form (bare `rotate: '90'` is
    // invalid CSS — browsers dropped it and imports lost their rotations live).
    expect(r.styles.transform).toBe('rotate(90deg)');
    expect(r.styles.rotate).toBeUndefined();
    expect(r.styles.left).toBe('125.00px');
    expect(r.styles.top).toBe('125.00px');
  });

  it('a bare fontFamily gains a sans-serif fallback (unknown fonts must not serif-default)', () => {
    const p = payload([
      { id: 't', name: 'T', kind: 'text', styles: { fontFamily: 'General Sans', width: '100px' }, text: 'Hi' },
    ]);
    expect(byId(convertFigmaPayload(p), 't').styles.fontFamily).toBe('General Sans, Inter, sans-serif');
  });

  it('figma absolute-position child of an auto-layout frame stays out of flow (pin preserved)', () => {
    const p = payload([
      { id: 'badge', name: 'Ellipse 6', kind: 'div', children: [], styles: {
        width: '120px', height: '120px', position: 'absolute', right: '200px', fill: '#FE8B4A', borderRadius: '50%',
      } },
      { id: 'title', name: 'Title', kind: 'text', text: 'Help', styles: { width: '492px' } },
      { id: 'frame', name: 'Frame 3', kind: 'div', children: ['badge', 'title'], styles: {
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', width: '960px', height: '110px',
      } },
    ]);
    const nodes = convertFigmaPayload(p);
    const badge = byId(nodes, 'badge');
    expect(badge.styles.position).toBe('absolute');
    expect(badge.styles.right).toBe('200px');
    expect(badge.styles.left).toBeUndefined(); // right pin must not fight a synthesized left
    expect(badge.styles.top).toBe('0px');      // no vertical pin at all → default
    expect(badge.styles.flex).toBeUndefined();
    expect(badge.styles.order).toBeUndefined();
    expect(badge.attrs?.['data-pinned']).toBe('true');
    expect(badge.styles.backgroundColor).toBe('#FE8B4A'); // fill → paint
    expect(badge.styles.fill).toBeUndefined();
    // The title is the FIRST flow child — the absolute badge consumed no slot.
    const title = byId(nodes, 'title');
    expect(title.styles.order).toBe('0');
    expect(title.styles.position).toBe('relative');
  });

  it('flow children of a layout parent are stripped of stray right/bottom pins', () => {
    const p = payload([
      { id: 'kid', name: 'K', kind: 'div', children: [], styles: { width: '10px', height: '10px', right: '30px', bottom: '4px' } },
      { id: 'row', name: 'R', kind: 'div', children: ['kid'], styles: { display: 'flex', width: '100px', height: '20px' } },
    ]);
    const kid = byId(convertFigmaPayload(p), 'kid');
    expect(kid.styles.position).toBe('relative');
    expect(kid.styles.right).toBeUndefined();
    expect(kid.styles.bottom).toBeUndefined();
  });

  it('fill maps to color on text and gradient fill maps to backgroundImage on divs', () => {
    const p = payload([
      { id: 't', name: 'T', kind: 'text', text: 'hi', styles: { fill: '#123456', width: '10px' } },
      { id: 'g', name: 'G', kind: 'div', children: [], styles: { fill: 'linear-gradient(90deg, #000 0%, #fff 100%)', width: '10px', height: '10px' } },
      { id: 'wrap', name: 'W', kind: 'div', children: ['t', 'g'], styles: { width: '100px', height: '100px' } },
    ]);
    const nodes = convertFigmaPayload(p);
    expect(byId(nodes, 't').styles.color).toBe('#123456');
    expect(byId(nodes, 't').styles.fill).toBeUndefined();
    expect(byId(nodes, 'g').styles.backgroundImage).toBe('linear-gradient(90deg, #000 0%, #fff 100%)');
    expect(byId(nodes, 'g').styles.fill).toBeUndefined();
  });

  it('premium fonts get a metric-close Google alias; Google fonts stay bare', () => {
    const p = payload([
      { id: 'a', name: 'A', kind: 'text', text: 'hi', styles: { fontFamily: 'Aeonik', width: '10px' } },
      { id: 'b', name: 'B', kind: 'text', text: 'yo', styles: { fontFamily: 'Manrope', width: '10px' } },
      { id: 'w', name: 'W', kind: 'div', children: ['a', 'b'], styles: { width: '100px', height: '100px' } },
    ]);
    const nodes = convertFigmaPayload(p);
    expect(byId(nodes, 'a').styles.fontFamily).toBe('Aeonik, Inter, sans-serif');
    expect(byId(nodes, 'b').styles.fontFamily).toBe('Manrope, sans-serif');
  });

  it('figma variable paints resolve to their fallback (the vanished yellow CTA)', () => {
    const p = payload([
      { id: 'card', name: 'Frame 52', kind: 'div', children: [], styles: {
        background: 'var(--goled-10, #FEDC98)', width: '757px', height: '234px',
      } },
    ]);
    const card = byId(convertFigmaPayload(p), 'card');
    expect(card.styles.backgroundColor).toBe('#FEDC98');
    expect(card.styles.background).toBeUndefined();
  });

  it('resolveCssVars handles nested parens and multiple vars', () => {
    expect(resolveCssVars('var(--a, rgba(0, 0, 0, 0.5))')).toBe('rgba(0, 0, 0, 0.5)');
    expect(resolveCssVars('1px solid var(--edge, #111)')).toBe('1px solid #111');
    expect(resolveCssVars('var(--x, var(--y, #222))')).toBe('#222');
    expect(resolveCssVars('var(--no-fallback)')).toBe('');
  });

  it('low-opacity texture fills become an overlay child (the grainy-noise find)', () => {
    const p = payload([
      { id: 'sec', name: 'Background Noise', kind: 'img', src: 'data:image/png;base64,AAA=',
        srcScaleMode: 'TILE', srcOpacity: 0.04, srcTileSize: '256px 256px',
        styles: { width: '1440px', height: '1090px', backgroundColor: '#F5F5F3' } },
    ]);
    const data = convertFigmaPayload(p);
    const sec = byId(data, 'sec');
    expect(sec.styles.backgroundImage).toBeUndefined(); // image moved to the overlay
    expect(sec.styles.backgroundColor).toBe('#F5F5F3');
    expect(sec.children.length).toBe(1);
    const overlay = byId(data, sec.children[0]);
    expect(overlay.styles.backgroundImage).toBe('url(data:image/png;base64,AAA=)');
    expect(overlay.styles.opacity).toBe('0.04');
    expect(overlay.styles.backgroundRepeat).toBe('repeat');
    expect(overlay.styles.backgroundSize).toBe('256px 256px');
    expect(overlay.styles.position).toBe('absolute');
    expect(overlay.styles.width).toBe('100%');
    expect(overlay.attrs?.['data-pinned']).toBe('true');
  });

  it('faint texture fills drop the node backdrop-filter (figma blurs through fill alpha)', () => {
    const p = payload([
      { id: 'noise', name: 'Background Noise', kind: 'img', src: 'data:image/png;base64,AAA=',
        srcScaleMode: 'TILE', srcOpacity: 0.04,
        styles: { width: '1440px', height: '1090px', backdropFilter: 'blur(32px)' } },
      { id: 'glass', name: 'Glass', kind: 'img', src: 'data:image/png;base64,DDD=',
        srcOpacity: 0.5,
        styles: { width: '100px', height: '100px', backdropFilter: 'blur(10px)' } },
    ], ['noise', 'glass']);
    const data = convertFigmaPayload(p);
    expect(byId(data, 'noise').styles.backdropFilter).toBeUndefined();
    expect(byId(data, 'glass').styles.backdropFilter).toBe('blur(10px)'); // half-strength fill = real glass, keep
  });

  it('blend-mode fills map to css mix-blend-mode on the overlay', () => {
    const p = payload([
      { id: 'n', name: 'N', kind: 'img', src: 'data:image/png;base64,BBB=',
        srcBlendMode: 'SOFT_LIGHT', styles: { width: '10px', height: '10px' } },
    ]);
    const data = convertFigmaPayload(p);
    const overlay = byId(data, byId(data, 'n').children[0]);
    expect(overlay.styles.mixBlendMode).toBe('soft-light');
    expect(overlay.styles.opacity).toBeUndefined();
  });

  it('full-opacity image fills keep the plain inline background path', () => {
    const p = payload([
      { id: 'photo', name: 'P', kind: 'img', src: 'data:image/png;base64,CCC=',
        srcScaleMode: 'FILL', srcOpacity: 1, styles: { width: '10px', height: '10px' } },
    ]);
    const photo = byId(convertFigmaPayload(p), 'photo');
    expect(photo.styles.backgroundImage).toBe('url(data:image/png;base64,CCC=)');
    expect(photo.children.length).toBe(0);
  });

  it('lineHeight percent + comment debris normalizes to a unitless ratio', () => {
    const p = payload([
      { id: 't', name: 'T', kind: 'text', text: 'Hi', styles: {
        width: '100px', lineHeight: '110% /* 79.2px */', fontSize: '72px /* huge */',
      } },
    ]);
    const node = byId(convertFigmaPayload(p), 't');
    expect(node.styles.lineHeight).toBe('1.1');
    expect(node.styles.fontSize).toBe('72px'); // comment stripped everywhere
  });

  it('background shorthand debris extracts the real color layer', () => {
    const p = payload([
      { id: 'f', name: 'F', kind: 'div', children: [], styles: {
        background: 'lightgray 50% / cover no-repeat, #D9D9D9', width: '10px', height: '10px',
      } },
    ]);
    const f = byId(convertFigmaPayload(p), 'f');
    expect(f.styles.backgroundColor).toBe('#D9D9D9');
    expect(f.styles.background).toBeUndefined();
  });

  it('complex-svg fallback drops the CSS rotate (export bakes it) and sizes to the rotated AABB', () => {
    const p = payload([
      { id: 'card', name: 'Card', kind: 'svg', styles: {
        transform: 'rotate(90deg)', width: '100px', height: '50px', left: '200px', top: '100px',
      }, svg: '<svg viewBox="0 0 120 120"><rect width="100" height="50" transform="rotate(90 10 10)" fill="#FBD7C1"/></svg>' },
      { id: 'wrap', name: 'W', kind: 'div', children: ['card'], styles: { width: '800px', height: '600px' } },
    ]);
    const card = byId(convertFigmaPayload(p), 'card');
    expect(card.styles.rotate).toBeUndefined();
    expect(card.styles.width).toBe('50.00px');
    expect(card.styles.height).toBe('100.00px');
    expect(card.styles.left).toBe('150.00px');
    expect(card.styles.top).toBe('100.00px');
    expect(card.styles.backgroundImage).toMatch(/^url\(data:image\/svg\+xml/);
  });

  it('transform rotate → transform rotate(Ndeg); transparent keyword → rgba', () => {
    const p = payload([
      { id: 'f', name: 'F', kind: 'div', children: [], styles: {
        transform: 'rotate(15deg)', backgroundColor: 'transparent', width: '10px', height: '10px',
      } },
    ]);
    const f = byId(convertFigmaPayload(p), 'f');
    expect(f.styles.transform).toBe('rotate(15deg)');
    expect(f.styles.rotate).toBeUndefined();
    expect(f.styles.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('every emitted node has explicit position, width and height', () => {
    const p = payload([
      { id: 'bare', name: 'Bare', kind: 'div', children: [], styles: {} },
    ]);
    const f = byId(convertFigmaPayload(p), 'bare');
    expect(f.styles.position).toBe('absolute');
    expect(f.styles.width).toBe('auto');
    expect(f.styles.height).toBe('auto');
  });
});

describe('convertFigmaPayload — images and vectors', () => {
  it('a div frame with an image fill keeps its solid AND gains the image layer', () => {
    const p = payload([
      { id: 'band', name: 'Subscribe Band', kind: 'div', src: 'data:image/png;base64,BBB', srcScaleMode: 'TILE',
        children: [], styles: { width: '757px', height: '234px', background: '#f5d78e' } },
    ]);
    const band = byId(convertFigmaPayload(p, { resolveAssetUrl: () => 'https://cdn/waves.png' }), 'band');
    expect(band.styles.backgroundColor).toBe('#f5d78e');
    expect(band.styles.backgroundImage).toBe('url(https://cdn/waves.png)');
    expect(band.styles.backgroundRepeat).toBe('repeat');
  });

  it('FIT scale mode maps to contain; default FILL to cover', () => {
    const p = payload([
      { id: 'a', name: 'A', kind: 'img', src: 'data:x', srcScaleMode: 'FIT', styles: { width: '10px', height: '10px' } },
      { id: 'b', name: 'B', kind: 'img', src: 'data:x', styles: { width: '10px', height: '10px' } },
      { id: 'w', name: 'W', kind: 'div', children: ['a', 'b'], styles: { display: 'flex', width: '20px', height: '10px' } },
    ]);
    const data = convertFigmaPayload(p);
    expect(byId(data, 'a').styles.backgroundSize).toBe('contain');
    expect(byId(data, 'b').styles.backgroundSize).toBe('cover');
  });

  it('image fills become background frames, never <img>', () => {
    const p = payload([
      { id: 'pic', name: 'Photo', kind: 'img', src: 'data:image/png;base64,AAA', styles: { width: '200px', height: '120px' } },
    ]);
    const pic = byId(convertFigmaPayload(p, { resolveAssetUrl: () => 'https://cdn/x.png' }), 'pic');
    expect(pic.type).toBe('div');
    expect(pic.styles.backgroundImage).toBe('url(https://cdn/x.png)');
    expect(pic.styles.backgroundSize).toBe('cover');
  });

  it('a flat path svg becomes a dialect shape: 1:1 wrapper + -g<i> paths', () => {
    const p = payload([
      { id: 'star', name: 'Star', kind: 'svg', styles: { width: '48px', height: '48px' },
        svg: '<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 0 L30 17 L48 17 Z" fill="#FFD43B" stroke="#201A2C" stroke-width="2"/></svg>' },
    ]);
    const data = convertFigmaPayload(p);
    const star = byId(data, 'star');
    expect(star.type).toBe('svg');
    expect(star.attrs?.viewBox).toBe('0 0 48 48');
    expect(star.attrs?.preserveAspectRatio).toBe('none');
    expect(star.styles.width).toBe('48px');
    expect(star.styles.overflow).toBe('visible');
    const path = byId(data, 'star-g0');
    expect(path.type).toBe('path');
    expect(path.attrs?.d).toBe('M24 0 L30 17 L48 17 Z');
    expect(path.attrs?.fill).toBe('#FFD43B');
    expect(path.parentId).toBe('star');
  });

  it('complex svg (gradients/primitives) falls back to a background frame', () => {
    const p = payload([
      { id: 'v', name: 'V', kind: 'svg', styles: { width: '40px', height: '40px' },
        svg: '<svg viewBox="0 0 40 40"><mask id="m"><rect width="40" height="40"/></mask><path d="M0 0 L4 4" mask="url(#m)"/></svg>' },
    ]);
    const v = byId(convertFigmaPayload(p), 'v');
    expect(v.type).toBe('div');
    expect(v.styles.backgroundImage).toMatch(/^url\(data:image\/svg\+xml/);
  });
});

describe('parseFigmaSvg', () => {
  it('reads viewBox and path attrs', () => {
    const parsed = parseFigmaSvg('<svg viewBox="0 0 20 10"><path d="M0 0 L20 10" stroke="#000" stroke-width="2" fill="none"/></svg>');
    expect(parsed).not.toBeNull();
    expect(parsed!.viewBox).toEqual({ w: 20, h: 10 });
    expect(parsed!.shapes).toHaveLength(1);
    expect(parsed!.shapes[0].paint.stroke).toBe('#000');
    expect(parsed!.complex).toBe(false);
  });

  it('BAKES pure-translate groups into path coordinates (best-effort resolve)', () => {
    const parsed = parseFigmaSvg('<svg viewBox="0 0 10 10"><g transform="translate(2,3)"><path d="M0 0 L4 4" stroke="#000"/></g></svg>');
    expect(parsed!.complex).toBe(false);
    expect(parsed!.shapes[0].d.replace(/\s+/g, ' ')).toContain('M 2 3');
  });

  it('converts primitives (circle/rect) to editable paths', () => {
    const parsed = parseFigmaSvg('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#f00"/><rect x="1" y="1" width="4" height="4" fill="#0f0"/></svg>');
    expect(parsed!.complex).toBe(false);
    expect(parsed!.shapes).toHaveLength(2);
    expect(parsed!.shapes[0].d).toMatch(/[CAca]/);
    expect(parsed!.shapes[0].paint.fill).toBe('#f00');
  });

  it('marks rotate transforms and gradient paint complex (image fallback)', () => {
    expect(parseFigmaSvg('<svg viewBox="0 0 10 10"><g transform="rotate(20)"><path d="M0 0 L1 1"/></g></svg>')!.complex).toBe(true);
    expect(parseFigmaSvg('<svg viewBox="0 0 10 10"><path d="M0 0 L1 1" stroke="url(#g)"/></svg>')!.complex).toBe(true);
  });

  it('a multi-shape svg emits the GROUP grammar: nested single-path shape svgs', () => {
    const p = payload([
      { id: 'ic', name: 'Icon', kind: 'svg', styles: { width: '20px', height: '20px' },
        svg: '<svg viewBox="0 0 20 20"><path d="M0 0 L5 5" fill="#111"/><path d="M10 10 L15 15" fill="#222"/></svg>' },
    ]);
    const data = convertFigmaPayload(p);
    const group = byId(data, 'ic');
    expect(group.type).toBe('svg');
    expect(group.children).toEqual(['ic-s0', 'ic-s1']);
    const s0 = byId(data, 'ic-s0');
    expect(s0.type).toBe('svg');
    expect(s0.attrs?.x).toBe('0');
    expect(s0.attrs?.viewBox).toBe('0 0 20 20');
    expect(s0.attrs?.preserveAspectRatio).toBe('none');
    const g0 = byId(data, 'ic-s0-g0');
    expect(g0.type).toBe('path');
    expect(g0.attrs?.fill).toBe('#111');
    expect(g0.parentId).toBe('ic-s0');
  });
});

describe('convertFigmaPayload — ids', () => {
  it('dedupes colliding ids and keeps them kebab-safe', () => {
    const p = payload([
      { id: 'Frame 1', name: 'A', kind: 'div', children: [], styles: { width: '10px', height: '10px' } },
      { id: 'frame-1', name: 'B', kind: 'div', children: [], styles: { width: '10px', height: '10px' } },
      { id: 'wrap', name: 'Wrap', kind: 'div', children: ['Frame 1', 'frame-1'], styles: { display: 'flex', width: '20px', height: '20px' } },
    ]);
    const data = convertFigmaPayload(p);
    const ids = data.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_-]*$/);
  });
});

describe('convertFigmaPayload — ghost frames', () => {
  const section = (children: string[]): FigmaPayloadNode => ({
    id: 'sec', name: 'Section', kind: 'div', children, styles: {
      display: 'flex', flexDirection: 'column', width: '1440px', height: '800px', background: '#000000',
    },
  });

  it('drops an empty invisible auto-sized frame (the ghost-sibling shape)', () => {
    const data = convertFigmaPayload(payload([
      { id: 'ghost', name: 'Frame', kind: 'div', children: [], styles: {
        backgroundColor: 'rgba(0, 0, 0, 0)', overflow: 'visible',
      } },
      { id: 'real', name: 'Card', kind: 'div', children: [], styles: {
        width: '200px', height: '100px', background: '#ffffff',
      } },
      section(['ghost', 'real']),
    ], ['sec']));
    expect(data.nodes.find((n) => n.id === 'ghost')).toBeUndefined();
    const sec = byId(data, 'sec');
    expect(sec.children).toEqual(['real']);
    // The surviving sibling takes flow slot 0 — no gap left by the ghost.
    expect(byId(data, 'real').styles.order).toBe('0');
  });

  it('keeps an empty GROWING frame (auto-layout spacer)', () => {
    const data = convertFigmaPayload(payload([
      { id: 'spacer', name: 'Spacer', kind: 'div', children: [], styles: { flex: '1 0 0px' } },
      section(['spacer']),
    ], ['sec']));
    expect(data.nodes.find((n) => n.id === 'spacer')).toBeTruthy();
  });

  it('keeps an empty frame that paints (background color)', () => {
    const data = convertFigmaPayload(payload([
      { id: 'dot', name: 'Dot', kind: 'div', children: [], styles: {
        width: '8px', height: '8px', backgroundColor: '#ff0000',
      } },
      section(['dot']),
    ], ['sec']));
    expect(data.nodes.find((n) => n.id === 'dot')).toBeTruthy();
  });

  it('keeps a deliberately pasted empty ROOT frame', () => {
    const data = convertFigmaPayload(payload([
      { id: 'lonely', name: 'Frame', kind: 'div', children: [], styles: {
        backgroundColor: 'rgba(0, 0, 0, 0)',
      } },
    ], ['lonely']));
    expect(data.nodes.find((n) => n.id === 'lonely')).toBeTruthy();
  });
});

describe('convertFigmaPayload — gradient text → native builder dialect', () => {
  it('normalizes the figma gradient-text shape (backgroundImage + opaque fallback color)', () => {
    const p = payload([
      { id: 't', name: 'Heading', kind: 'text', text: 'Old world meets new tech', styles: {
        backgroundImage: 'linear-gradient(90deg, rgba(255, 255, 255, 0.40) 1.56%, #FFF 24.99%)',
        backgroundClip: 'text', WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'rgba(0, 0, 0, 0)',
        color: '#B5B2B1', // figma's flattened fallback — poisons solid-run detection
        fontSize: '80px',
      } },
    ]);
    const t = byId(convertFigmaPayload(p), 't');
    // Native dialect: SHORTHAND background, no longhand, transparent paint.
    expect(t.styles.background).toContain('linear-gradient(90deg');
    expect(t.styles.backgroundImage).toBeUndefined();
    expect(t.styles.backgroundClip).toBe('text');
    expect(t.styles.WebkitBackgroundClip).toBe('text');
    expect(t.styles.WebkitTextFillColor).toBe('rgba(0, 0, 0, 0)');
    expect(t.styles.color).toBe('rgba(0, 0, 0, 0)');
    // KEY ORDER: the `background` shorthand resets background-clip, so it
    // must be INSERTED before the clip keys (React applies in object order).
    const keys = Object.keys(t.styles);
    expect(keys.indexOf('background')).toBeLessThan(keys.indexOf('backgroundClip'));
    expect(keys.indexOf('background')).toBeLessThan(keys.indexOf('WebkitBackgroundClip'));
  });

  it('leaves plain (non-clipped) text colors alone', () => {
    const p = payload([
      { id: 't', name: 'T', kind: 'text', text: 'Plain', styles: { color: '#B5B2B1' } },
    ]);
    const t = byId(convertFigmaPayload(p), 't');
    expect(t.styles.color).toBe('#B5B2B1');
    expect(t.styles.background).toBeUndefined();
  });
});
