// vector-svg-export.ts — "Export as SVG" that produces VECTORS.
//
// html-to-image's `toSvg` wraps a serialized copy of the HTML in a
// <foreignObject>: a picture of the page, not vector art. Browsers render it,
// but it isn't editable anywhere — and dropped back into Revyme, every SVG
// importer (and the server's upload sanitizer) strips <foreignObject> as
// active content, leaving an empty vector (user report 2026-10-19: exported
// a logo frame, dropped the file back as a vector set, got a blank 210×70).
//
// This writes real SVG when everything in the exported subtree has a vector
// equivalent:
//   • <svg> graphics — serialized as they are, with every paint value
//     (fill/stroke from CSS variables, currentColor) resolved to a literal so
//     the file stands alone; placed via a <g transform> that reproduces the
//     viewBox + preserveAspectRatio mapping (more importers read a group
//     transform than a nested <svg>);
//   • boxes — solid background, uniform radius, uniform solid border,
//     opacity, overflow clipping.
// Anything else — text, images, gradients, shadows, filters, pseudo-element
// decorations, rotated or scaled boxes — has no faithful vector form here, so
// the export reports why and the caller keeps html-to-image.

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface RectLike { left: number; top: number; width: number; height: number }

/** Layout + style reads, injectable so the walk is testable without a
 *  layout engine. Defaults read the live DOM. */
export interface VectorExportEnv {
  rect(el: Element): RectLike;
  style(el: Element, pseudo?: string): Pick<CSSStyleDeclaration, 'getPropertyValue'>;
}

const domEnv: VectorExportEnv = {
  rect: (el) => el.getBoundingClientRect(),
  style: (el, pseudo) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el, pseudo ?? null),
};

export type VectorExportResult = { svg: string } | { reason: string };

/** Shape-level paint, resolved from computed style onto attributes. */
const SHAPE_PAINT = [
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule',
];
const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'use']);
/** SVG content with no standalone vector form (FIT-text wrappers embed HTML). */
const NON_VECTOR_SVG = 'foreignObject, image, video, iframe, canvas';
/** HTML elements that are pixels or widgets, never vectors. */
const NON_VECTOR_HTML = new Set(['img', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'input', 'textarea', 'select']);

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const px = (v: string) => parseFloat(v) || 0;

function isTransparent(color: string): boolean {
  const c = color.trim();
  if (!c || c === 'transparent') return true;
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return false;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length === 4 && parseFloat(parts[3]) === 0;
}

/** True when the element's own transform keeps it axis-aligned at 1:1 —
 *  a bounding rect then IS its box. Translation is fine (the rect has it). */
function axisAligned(cs: Pick<CSSStyleDeclaration, 'getPropertyValue'>): boolean {
  const rotate = cs.getPropertyValue('rotate').trim();
  const scale = cs.getPropertyValue('scale').trim();
  if (rotate && rotate !== 'none' && px(rotate) !== 0) return false;
  if (scale && scale !== 'none' && scale.split(/\s+/).some((s) => parseFloat(s) !== 1)) return false;
  const t = cs.getPropertyValue('transform').trim();
  if (!t || t === 'none') return true;
  const m = t.match(/^matrix\(([^)]+)\)$/);
  if (!m) return false;
  const [a, b, c, d] = m[1].split(',').map((s) => parseFloat(s));
  return a === 1 && b === 0 && c === 0 && d === 1;
}

/** Corner radius as one (rx, ry) for all four corners; null = they differ. */
function uniformRadius(cs: Pick<CSSStyleDeclaration, 'getPropertyValue'>, w: number, h: number): { rx: number; ry: number } | null {
  const corners = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']
    .map((k) => {
      const parts = (cs.getPropertyValue(k).trim() || '0px').split(/\s+/);
      const toPx = (v: string, size: number) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : px(v));
      return { rx: toPx(parts[0], w), ry: toPx(parts[1] ?? parts[0], h) };
    });
  const [first] = corners;
  if (!corners.every((c) => Math.abs(c.rx - first.rx) < 0.01 && Math.abs(c.ry - first.ry) < 0.01)) return null;
  return { rx: Math.min(first.rx, w / 2), ry: Math.min(first.ry, h / 2) };
}

function radiusAttrs(r: { rx: number; ry: number }): string {
  if (r.rx <= 0 && r.ry <= 0) return '';
  return r.rx === r.ry ? ` rx="${r3(r.rx)}"` : ` rx="${r3(r.rx)}" ry="${r3(r.ry)}"`;
}

/** A ::before / ::after that draws something (Revyme's border overlay is an
 *  ::after) — can't be read back as geometry. */
function pseudoPaints(env: VectorExportEnv, el: Element, pseudo: '::before' | '::after'): boolean {
  const ps = env.style(el, pseudo);
  const content = ps.getPropertyValue('content').trim();
  if (!content || content === 'none' || content === 'normal') return false;
  const border = ['top', 'right', 'bottom', 'left'].some((s) =>
    px(ps.getPropertyValue(`border-${s}-width`)) > 0 && ps.getPropertyValue(`border-${s}-style`).trim() !== 'none');
  return border || !isTransparent(ps.getPropertyValue('background-color'))
    || (ps.getPropertyValue('background-image').trim() || 'none') !== 'none'
    || (content !== '""' && content !== "''");
}

interface Walk {
  env: VectorExportEnv;
  originX: number;
  originY: number;
  kx: number;
  ky: number;
  defs: string[];
  clipSeq: number;
}

function boxOf(w: Walk, el: Element) {
  const r = w.env.rect(el);
  return {
    x: r3((r.left - w.originX) / w.kx),
    y: r3((r.top - w.originY) / w.ky),
    w: r3(r.width / w.kx),
    h: r3(r.height / w.ky),
  };
}

function addClip(w: Walk, x: number, y: number, width: number, height: number, radius: { rx: number; ry: number }): string {
  const id = `rv-clip-${++w.clipSeq}`;
  w.defs.push(`<clipPath id="${id}"><rect x="${x}" y="${y}" width="${width}" height="${height}"${radiusAttrs(radius)}/></clipPath>`);
  return id;
}

/** viewBox + preserveAspectRatio → the affine a nested <svg> applies. */
function viewBoxTransform(
  box: { x: number; y: number; w: number; h: number },
  viewBox: string | null,
  par: string | null,
): { sx: number; sy: number; tx: number; ty: number } | null {
  if (!viewBox) return { sx: 1, sy: 1, tx: box.x, ty: box.y };
  const [vx, vy, vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number);
  if (![vx, vy, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) return null;
  const [align = 'xMidYMid', mode = 'meet'] = (par ?? '').trim().split(/\s+/).filter(Boolean);
  let sx = box.w / vw;
  let sy = box.h / vh;
  let ox = 0, oy = 0;
  if (align !== 'none') {
    const s = mode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
    const fx = align.includes('xMid') ? 0.5 : align.includes('xMax') ? 1 : 0;
    const fy = align.includes('YMid') ? 0.5 : align.includes('YMax') ? 1 : 0;
    ox = (box.w - vw * s) * fx;
    oy = (box.h - vh * s) * fy;
  }
  return { sx, sy, tx: box.x + ox - vx * sx, ty: box.y + oy - vy * sy };
}

/** Clone an <svg> graphic with every paint value resolved to a literal and
 *  editor-only attributes dropped. Null + reason when it isn't pure vector. */
function cleanSvgClone(w: Walk, svg: Element): { el: Element } | { reason: string } {
  if (svg.querySelector(NON_VECTOR_SVG)) return { reason: 'svg-embeds-non-vector' };
  const clone = svg.cloneNode(true) as Element;
  const origs = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let i = 0; i < origs.length; i++) {
    const o = origs[i];
    const c = clones[i];
    const tag = o.tagName.toLowerCase();
    const inline = o.getAttribute('style') ?? '';
    // A CSS transform on SVG content uses CSS box/origin rules the transform
    // ATTRIBUTE doesn't — no faithful rewrite; Revyme keeps rotations in the
    // attribute, so this only bails on hand-authored content.
    // (`transform: none` is fine — html-to-image snapshots copy every computed
    // property inline, so its files carry it on every element.)
    if (i > 0 && /(?:^|;)\s*(?:transform|rotate|scale|translate)\s*:(?!\s*none\s*(?:;|$))/i.test(inline)) return { reason: 'svg-css-transform' };
    const cs = w.env.style(o);
    if (cs.getPropertyValue('display').trim() === 'none') { c.remove(); continue; }
    if (SHAPE_TAGS.has(tag)) {
      for (const prop of SHAPE_PAINT) {
        const v = cs.getPropertyValue(prop).trim();
        if (v) c.setAttribute(prop, v);
      }
    }
    if (tag === 'stop') {
      for (const prop of ['stop-color', 'stop-opacity']) {
        const v = cs.getPropertyValue(prop).trim();
        if (v) c.setAttribute(prop, v);
      }
    }
    const opacity = cs.getPropertyValue('opacity').trim();
    if (i > 0 && opacity && parseFloat(opacity) !== 1) c.setAttribute('opacity', opacity);
    if (i > 0 && tag === 'svg') {
      const ov = cs.getPropertyValue('overflow').trim();
      if (ov) c.setAttribute('overflow', ov === 'visible' ? 'visible' : 'hidden');
    }
    for (const a of Array.from(c.attributes)) {
      if (a.name === 'style' || a.name === 'class' || a.name.startsWith('data-')) c.removeAttribute(a.name);
    }
  }
  return { el: clone };
}

function serializeChildren(el: Element): string {
  const s = new XMLSerializer();
  return Array.from(el.childNodes).map((n) => s.serializeToString(n)).join('');
}

/** An <svg> graphic inside an exported HTML subtree → a positioned group. */
function svgGraphic(w: Walk, svg: Element): string | { reason: string } {
  const cs = w.env.style(svg);
  if (cs.getPropertyValue('display').trim() === 'none') return '';
  if (!axisAligned(cs)) return { reason: 'svg-rotated' };
  if ((cs.getPropertyValue('filter').trim() || 'none') !== 'none') return { reason: 'svg-filter' };
  const box = boxOf(w, svg);
  const m = viewBoxTransform(box, svg.getAttribute('viewBox'), svg.getAttribute('preserveAspectRatio'));
  if (!m) return { reason: 'svg-bad-viewbox' };
  const cleaned = cleanSvgClone(w, svg);
  if ('reason' in cleaned) return cleaned;
  let body = `<g transform="matrix(${r3(m.sx)} 0 0 ${r3(m.sy)} ${r3(m.tx)} ${r3(m.ty)})">${serializeChildren(cleaned.el)}</g>`;
  if (cs.getPropertyValue('overflow').trim() !== 'visible') {
    body = `<g clip-path="url(#${addClip(w, box.x, box.y, box.w, box.h, { rx: 0, ry: 0 })})">${body}</g>`;
  }
  const opacity = parseFloat(cs.getPropertyValue('opacity')) ;
  return Number.isFinite(opacity) && opacity < 1 ? `<g opacity="${opacity}">${body}</g>` : body;
}

/** CSS paint order between siblings: negative z, in-flow, positioned, positive z. */
function stackKey(cs: Pick<CSSStyleDeclaration, 'getPropertyValue'>): number {
  const pos = cs.getPropertyValue('position').trim();
  const z = cs.getPropertyValue('z-index').trim();
  const zi = z && z !== 'auto' ? parseInt(z, 10) : 0;
  if (zi < 0) return -1e6 + zi;
  if (!pos || pos === 'static') return 0;
  return 1 + Math.max(zi, 0);
}

function htmlBox(w: Walk, el: Element): string | { reason: string } {
  const cs = w.env.style(el);
  if (cs.getPropertyValue('display').trim() === 'none' || cs.getPropertyValue('visibility').trim() === 'hidden') return '';
  const tag = el.tagName.toLowerCase();
  if (NON_VECTOR_HTML.has(tag)) return { reason: `html-${tag}` };
  if (!axisAligned(cs)) return { reason: 'box-rotated' };
  for (const [prop, ok] of [
    ['background-image', 'none'], ['box-shadow', 'none'], ['filter', 'none'], ['backdrop-filter', 'none'],
    ['clip-path', 'none'], ['mask-image', 'none'], ['mix-blend-mode', 'normal'],
  ] as const) {
    const v = cs.getPropertyValue(prop).trim();
    if (v && v !== ok) return { reason: `box-${prop}` };
  }
  if (pseudoPaints(w.env, el, '::before') || pseudoPaints(w.env, el, '::after')) return { reason: 'box-pseudo-element' };

  const box = boxOf(w, el);
  const radius = uniformRadius(cs, box.w, box.h);
  const parts: string[] = [];

  const bg = cs.getPropertyValue('background-color').trim();
  const sides = ['top', 'right', 'bottom', 'left'].map((s) => ({
    width: px(cs.getPropertyValue(`border-${s}-width`)),
    style: cs.getPropertyValue(`border-${s}-style`).trim() || 'none',
    color: cs.getPropertyValue(`border-${s}-color`).trim(),
  }));
  const visibleBorder = sides.filter((s) => s.width > 0 && s.style !== 'none' && s.style !== 'hidden' && !isTransparent(s.color));
  const paintsSelf = !isTransparent(bg) || visibleBorder.length > 0;
  if (paintsSelf && !radius) return { reason: 'box-uneven-radius' };
  const r = radius ?? { rx: 0, ry: 0 };
  if (!isTransparent(bg)) {
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"${radiusAttrs(r)} fill="${bg}"/>`);
  }
  if (visibleBorder.length > 0) {
    const [b0] = sides;
    const uniform = visibleBorder.length === 4 && sides.every((s) => s.width === b0.width && s.style === 'solid' && s.color === b0.color);
    if (!uniform) return { reason: 'box-border' };
    const half = b0.width / 2;
    parts.push(`<rect x="${r3(box.x + half)}" y="${r3(box.y + half)}" width="${r3(box.w - b0.width)}" height="${r3(box.h - b0.width)}"${radiusAttrs({ rx: Math.max(r.rx - half, 0), ry: Math.max(r.ry - half, 0) })} fill="none" stroke="${b0.color}" stroke-width="${b0.width}"/>`);
  }

  const kids: { key: number; order: number; out: string }[] = [];
  let order = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      if ((node.textContent ?? '').trim()) return { reason: 'text' };
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    const isSvg = child.namespaceURI === SVG_NS && child.tagName.toLowerCase() === 'svg';
    const out = isSvg ? svgGraphic(w, child) : htmlBox(w, child);
    if (typeof out !== 'string') return out;
    if (out) kids.push({ key: stackKey(w.env.style(child)), order: order++, out });
  }
  kids.sort((a, b) => a.key - b.key || a.order - b.order);
  let inner = kids.map((k) => k.out).join('');
  const ox = cs.getPropertyValue('overflow-x').trim() || cs.getPropertyValue('overflow').trim();
  const oy = cs.getPropertyValue('overflow-y').trim() || cs.getPropertyValue('overflow').trim();
  if (inner && ((ox && ox !== 'visible') || (oy && oy !== 'visible'))) {
    inner = `<g clip-path="url(#${addClip(w, box.x, box.y, box.w, box.h, r)})">${inner}</g>`;
  }
  let out = parts.join('') + inner;
  const opacity = parseFloat(cs.getPropertyValue('opacity'));
  if (out && Number.isFinite(opacity) && opacity < 1) out = `<g opacity="${opacity}">${out}</g>`;
  return out;
}

/** The exported element as a standalone vector SVG document, or why not. */
export function exportVectorSvg(root: Element, env: VectorExportEnv = domEnv): VectorExportResult {
  const cs = env.style(root);
  if (!axisAligned(cs)) return { reason: 'root-rotated' };
  const rect = env.rect(root);
  const he = root as HTMLElement;
  const cssW = typeof he.offsetWidth === 'number' && he.offsetWidth > 0 ? he.offsetWidth : px(cs.getPropertyValue('width'));
  const cssH = typeof he.offsetHeight === 'number' && he.offsetHeight > 0 ? he.offsetHeight : px(cs.getPropertyValue('height'));
  if (!(cssW > 0) || !(cssH > 0) || !(rect.width > 0) || !(rect.height > 0)) return { reason: 'root-zero-size' };
  // The canvas zoom is a transform on an ANCESTOR, so every rect is scaled
  // by it; the root's CSS size tells us by how much.
  const w: Walk = { env, originX: rect.left, originY: rect.top, kx: rect.width / cssW, ky: rect.height / cssH, defs: [], clipSeq: 0 };
  const W = r3(cssW), H = r3(cssH);

  const isSvgRoot = root.namespaceURI === SVG_NS && root.tagName.toLowerCase() === 'svg';
  if (isSvgRoot) {
    // The graphic IS the document: keep its own viewBox / aspect handling.
    const cleaned = cleanSvgClone(w, root);
    if ('reason' in cleaned) return cleaned;
    const el = cleaned.el;
    for (const a of ['x', 'y']) el.removeAttribute(a);
    el.setAttribute('xmlns', SVG_NS);
    el.setAttribute('width', String(W));
    el.setAttribute('height', String(H));
    if (!el.getAttribute('viewBox')) el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ov = cs.getPropertyValue('overflow').trim();
    if (ov === 'visible') el.setAttribute('overflow', 'visible');
    return { svg: new XMLSerializer().serializeToString(el) };
  }

  const body = htmlBox(w, root);
  if (typeof body !== 'string') return body;
  if (!body) return { reason: 'nothing-to-draw' };
  const defs = w.defs.length ? `<defs>${w.defs.join('')}</defs>` : '';
  return { svg: `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">${defs}${body}</svg>` };
}
