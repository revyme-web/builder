import { describe, it, expect } from 'vitest';
import { exportVectorSvg, type VectorExportEnv, type RectLike } from './vector-svg-export';
import { isHtmlOnlySvg, svgHasDrawableContent } from './svg-sanitize';

// A fake layout engine: rects + computed styles per element, so the walk is
// checked exactly (jsdom has no layout).
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULTS: Record<string, string> = {
  display: 'block', visibility: 'visible', transform: 'none', rotate: 'none', scale: 'none',
  overflow: 'visible', 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none',
  'box-shadow': 'none', filter: 'none', 'backdrop-filter': 'none', 'clip-path': 'none',
  'mask-image': 'none', 'mix-blend-mode': 'normal', opacity: '1', position: 'relative', 'z-index': 'auto',
  content: 'none',
};

function fakeEnv(rects: Map<Element, RectLike>, styles: Map<Element, Record<string, string>>): VectorExportEnv {
  return {
    rect: (el) => rects.get(el) ?? { left: 0, top: 0, width: 0, height: 0 },
    style: (el, pseudo) => ({
      getPropertyValue: (p: string) => (pseudo ? (p === 'content' ? 'none' : '') : (styles.get(el)?.[p] ?? DEFAULTS[p] ?? '')),
    }) as Pick<CSSStyleDeclaration, 'getPropertyValue'>,
  };
}

function html(tag: string, size: { w: number; h: number }): HTMLElement {
  const el = document.createElement(tag);
  Object.defineProperty(el, 'offsetWidth', { value: size.w });
  Object.defineProperty(el, 'offsetHeight', { value: size.h });
  return el;
}

/** The reported case: a logo frame (white, rounded) holding an <svg> logo
 *  whose path paints from a CSS variable. */
function logoFrame(zoom = 1) {
  const rects = new Map<Element, RectLike>();
  const styles = new Map<Element, Record<string, string>>();
  const frame = html('div', { w: 210, h: 70 });
  frame.setAttribute('data-id', 'frame-1');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-id', 'logo');
  svg.setAttribute('viewBox', '0 0 100 25');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('style', 'width: 200px; height: 50px; overflow: visible');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M0 0 L100 0 L100 25 Z');
  path.setAttribute('fill', 'var(--color-black)');
  path.setAttribute('data-id', 'logo-g0');
  svg.appendChild(path);
  frame.appendChild(svg);
  const at = (x: number, y: number, w: number, h: number) => ({ left: 300 + x * zoom, top: 100 + y * zoom, width: w * zoom, height: h * zoom });
  rects.set(frame, at(0, 0, 210, 70));
  rects.set(svg, at(5, 10, 200, 50));
  styles.set(frame, { 'background-color': 'rgb(255, 255, 255)', 'border-top-left-radius': '8px', 'border-top-right-radius': '8px', 'border-bottom-right-radius': '8px', 'border-bottom-left-radius': '8px' });
  styles.set(svg, { overflow: 'visible' });
  styles.set(path, { fill: 'rgb(0, 0, 0)', 'fill-rule': 'nonzero' });
  return { frame, svg, path, env: fakeEnv(rects, styles), rects, styles };
}

describe('exportVectorSvg — HTML frame with svg graphics → real vectors', () => {
  it('writes the frame as a rect and the logo as a positioned group, paint resolved', () => {
    const { frame, env } = logoFrame();
    const r = exportVectorSvg(frame, env);
    expect('svg' in r).toBe(true);
    const svg = (r as { svg: string }).svg;
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="210" height="70" viewBox="0 0 210 70"/);
    expect(svg).toContain('<rect x="0" y="0" width="210" height="70" rx="8" fill="rgb(255, 255, 255)"/>');
    // viewBox 100×25 → 200×50 box at (5,10), preserveAspectRatio none
    expect(svg).toContain('<g transform="matrix(2 0 0 2 5 10)">');
    expect(svg).toContain('fill="rgb(0, 0, 0)"');
    expect(svg).not.toContain('var(--');
    expect(svg).not.toContain('data-id');
    expect(svg).not.toContain('foreignObject');
  });

  it('the canvas zoom does not leak into the file', () => {
    const { frame, env } = logoFrame(2.5);
    const svg = (exportVectorSvg(frame, env) as { svg: string }).svg;
    expect(svg).toContain('width="210" height="70"');
    expect(svg).toContain('<g transform="matrix(2 0 0 2 5 10)">');
  });

  it('preserveAspectRatio meet centres the graphic like the browser does', () => {
    const { frame, svg, env } = logoFrame();
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('viewBox', '0 0 50 50'); // square art in a 200×50 box → scale 1, centred
    const out = (exportVectorSvg(frame, env) as { svg: string }).svg;
    expect(out).toContain('<g transform="matrix(1 0 0 1 80 10)">');
  });

  it('overflow hidden on the frame clips its children', () => {
    const { frame, env, styles } = logoFrame();
    styles.set(frame, { ...styles.get(frame), overflow: 'hidden', 'overflow-x': 'hidden', 'overflow-y': 'hidden' });
    const out = (exportVectorSvg(frame, env) as { svg: string }).svg;
    expect(out).toContain('<clipPath id="rv-clip-1"><rect x="0" y="0" width="210" height="70" rx="8"/></clipPath>');
    expect(out).toContain('<g clip-path="url(#rv-clip-1)">');
  });

  it('html-to-image style `transform: none` on shapes is accepted; a real CSS transform is not', () => {
    const { frame, path, env } = logoFrame();
    path.setAttribute('style', 'fill: rgb(0, 0, 0); transform: none; rotate: none;');
    expect('svg' in exportVectorSvg(frame, env)).toBe(true);
    path.setAttribute('style', 'transform: rotate(10deg);');
    expect(exportVectorSvg(frame, env)).toEqual({ reason: 'svg-css-transform' });
  });

  it('text has no vector form → reason, so the caller keeps the HTML snapshot', () => {
    const { frame, env } = logoFrame();
    const p = document.createElement('p');
    p.textContent = 'BOOTS EMPIRE';
    frame.appendChild(p);
    expect(exportVectorSvg(frame, env)).toEqual({ reason: 'text' });
  });

  it('shadows / images bail too', () => {
    const a = logoFrame();
    a.styles.set(a.frame, { ...a.styles.get(a.frame), 'box-shadow': '0 2px 4px black' });
    expect(exportVectorSvg(a.frame, a.env)).toEqual({ reason: 'box-box-shadow' });
    const b = logoFrame();
    b.frame.appendChild(document.createElement('img'));
    expect(exportVectorSvg(b.frame, b.env)).toEqual({ reason: 'html-img' });
  });
});

describe('exportVectorSvg — an <svg> selection exports as itself', () => {
  it('keeps its viewBox, gains xmlns + size, drops editor attributes', () => {
    const { svg, env, rects } = logoFrame();
    rects.set(svg, { left: 0, top: 0, width: 200, height: 50 });
    const env2: VectorExportEnv = { ...env, style: (el, p) => (el === svg && !p ? { getPropertyValue: (k: string) => ({ width: '200px', height: '50px', overflow: 'visible' } as Record<string, string>)[k] ?? DEFAULTS[k] ?? '' } as Pick<CSSStyleDeclaration, 'getPropertyValue'> : env.style(el, p)) };
    const out = (exportVectorSvg(svg, env2) as { svg: string }).svg;
    expect(out).toMatch(/^<svg[^>]*viewBox="0 0 100 25"/);
    expect(out).toContain('width="200"');
    expect(out).toContain('height="50"');
    expect(out).toContain('fill="rgb(0, 0, 0)"');
    expect(out).not.toContain('data-id');
    expect(out).not.toContain('style=');
  });
});

describe('svg-sanitize — spotting an HTML snapshot', () => {
  const SNAPSHOT = '<svg xmlns="http://www.w3.org/2000/svg" width="210" height="70" viewBox="0 0 210 70"><foreignObject x="0" y="0" width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></div></foreignObject></svg>';
  it('a foreignObject-only file is an HTML snapshot, even with vectors nested inside it', () => {
    expect(svgHasDrawableContent(SNAPSHOT)).toBe(false);
    expect(isHtmlOnlySvg(SNAPSHOT)).toBe(true);
  });
  it('a normal drawing is not', () => {
    expect(isHtmlOnlySvg('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>')).toBe(false);
    expect(isHtmlOnlySvg('<svg><path d="M0 0h1"/><foreignObject><div/></foreignObject></svg>')).toBe(false);
  });
});
