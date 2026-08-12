// svg-drop-shapes.ts — decompose dropped SVG markup into the builder's native
// shape GRAMMAR — the exact structure the Figma import emits for vectors:
//   • single shape → wrapper svg (1:1 viewBox) + one `<path>` child (`-g0`)
//   • multi shape  → wrapper svg + nested per-shape svg children (`-s<i>`,
//     full-size viewBox, preserveAspectRatio none, overflow visible), each
//     holding one `<path>` (`-s<i>-g0`) with its paint attributes.
// That structure is what makes a dropped logo behave like a builder vector:
// double-click enters the group, every letterform is its own editable shape
// with vertices, and the Fill/Stroke panel binds per shape. Flat inner markup
// (`textContent`) renders but is NOT shape-editable — a dropped wordmark
// showed no vertices at all (user report 2026-07-28).
//
// Parsing + safety policy come from the Figma import's `parseFigmaSvg`:
// primitives (rect/circle/…) become path `d` strings, pure-translate <g>
// wrappers are baked into coordinates, and anything the dialect can't express
// (masks, filters, gradients, non-translate transforms, <use>, text/images)
// returns null — the caller keeps its current flat-markup behaviour.

import { parseFigmaSvg } from '@/code/import/figma/convert';
import { scalePathD, translatePathD, pathPoints, geometryBBox } from '@/shared/svg-geometry';
import { splitDisjointSubpathsD } from '@/code/svg/svg-import';
import type { NewNodeDescriptor } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip FULL-CANVAS clip paths — the `<clipPath><path d="m0 0h806v206h-806z"/>
 *  </clipPath>` + `<g clip-path="url(#a)">` pattern vector tools export around
 *  the whole drawing. It clips NOTHING (the rect equals the viewBox) yet its
 *  mere presence trips the complexity bail and blocks shape decomposition
 *  (live find 2026-07-28: the Ahrefs wordmark). Non-trivial clips stay — the
 *  decompose then falls back like it should. */
function stripFullCanvasClips(svg: string, vbW: number, vbH: number): string {
  const fullIds: string[] = [];
  const covers = (x0: number, y0: number, x1: number, y1: number) =>
    x0 <= 1 && y0 <= 1 && x1 >= vbW - 1 && y1 >= vbH - 1;
  let out = svg.replace(/<clipPath\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/clipPath>/gi, (whole, id: string, content: string) => {
    let full = false;
    const rect = content.match(/<rect\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"/i);
    if (rect) full = covers(0, 0, parseFloat(rect[1]), parseFloat(rect[2]));
    const d = content.match(/\sd="([^"]*)"/)?.[1];
    if (!full && d) {
      try {
        const pts = pathPoints(d);
        if (pts.length >= 4) {
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          full = covers(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
        }
      } catch { /* not a full-canvas clip */ }
    }
    if (!full) return whole;
    fullIds.push(id);
    return '';
  });
  for (const id of fullIds) {
    out = out.replace(new RegExp(`\\s(?:clip-path|clipPath)="url\\(#${escRe(id)}\\)"`, 'g'), '');
  }
  if (fullIds.length) out = out.replace(/<defs>\s*<\/defs>/gi, '');
  return out;
}

export interface DecomposedSvgDrop {
  /** Wrapper attrs — 1:1 viewBox for the SHRINK-WRAPPED px box. */
  attrs: Record<string, string>;
  children: NewNodeDescriptor[];
  /** Painted box after shrink-wrapping — the caller must adopt it as the
   *  wrapper's width/height styles. Icon packs pad their glyphs (a burger
   *  paints 36×24 inside a 48×48 viewBox); keeping the padded target box
   *  left an invisible margin around every dropped icon until the first
   *  shape-edit commit normalized it away. */
  box: { w: number; h: number };
}

export function decomposeSvgDropToShapes(
  fullSvg: string,
  baseId: string,
  name: string,
  targetW: number,
  targetH: number,
): DecomposedSvgDrop | null {
  if (!(targetW > 0) || !(targetH > 0)) return null;
  // Pre-simplify: a whole-drawing clip wrapper is decoration, not geometry.
  const vb = fullSvg.match(/viewBox="[\d.\s,eE+-]*?([\d.]+)[\s,]+([\d.]+)"\s*/)?.slice(1);
  const vbW = parseFloat(vb?.[0] ?? '0');
  const vbH = parseFloat(vb?.[1] ?? '0');
  const simplified = vbW > 0 && vbH > 0 ? stripFullCanvasClips(fullSvg, vbW, vbH) : fullSvg;
  const parsed = parseFigmaSvg(simplified);
  if (!parsed || parsed.complex || parsed.shapes.length === 0) return null;

  const sx = targetW / parsed.viewBox.w;
  const sy = targetH / parsed.viewBox.h;
  const identity = Math.abs(sx - 1) < 1e-6 && Math.abs(sy - 1) < 1e-6;

  const scaleShape = (shape: { d: string; paint: Record<string, string> }) => {
    const d = identity ? shape.d : scalePathD(shape.d, sx, sy);
    if (!d) return null;
    const paint = { ...shape.paint };
    const sw = parseFloat(paint['stroke-width'] ?? '');
    if (Number.isFinite(sw)) paint['stroke-width'] = String(+(sw * (sx + sy) / 2).toFixed(3));
    return { d, paint };
  };

  const pathDesc = (pid: string, shape: { d: string; paint: Record<string, string> }): NewNodeDescriptor => {
    const attrs: Record<string, string> = { d: shape.d, ...shape.paint };
    if (attrs.fill == null && attrs.stroke == null) attrs.fill = '#000000';
    return { tag: 'path', id: pid, styles: {}, attrs };
  };

  const r2 = (v: number) => +v.toFixed(2);

  // Scale every parsed shape into the target box…
  const scaled: { d: string; paint: Record<string, string> }[] = [];
  for (const shape of parsed.shapes) {
    const s = scaleShape(shape);
    if (!s) return null;
    scaled.push(s);
  }
  // …then SPLIT merged subpaths. Icon packs fold whole glyphs into ONE
  // <path> with N `M…Z` subpaths (a burger menu is one element carrying
  // three bars); the shape editor works one geometry per wrapper. Disjoint
  // subpaths become separate shapes (holes/counters stay merged — the
  // split refuses overlapping bboxes; see splitDisjointSubpathsD).
  const shapes: { d: string; paint: Record<string, string> }[] = [];
  for (const s of scaled) {
    const parts = splitDisjointSubpathsD(s.d);
    if (parts) for (const pd of parts) shapes.push({ d: pd, paint: { ...s.paint } });
    else shapes.push(s);
  }

  // SHRINK-WRAP: rebase everything to the union of the painted bboxes so the
  // wrapper hugs the glyph — no pack padding (see DecomposedSvgDrop.box).
  let ux = Infinity, uy = Infinity, ux1 = -Infinity, uy1 = -Infinity;
  for (const s of shapes) {
    const b = geometryBBox('path', { d: s.d });
    if (!b) return null;
    if (b.x < ux) ux = b.x;
    if (b.y < uy) uy = b.y;
    if (b.x + b.width > ux1) ux1 = b.x + b.width;
    if (b.y + b.height > uy1) uy1 = b.y + b.height;
  }
  if (!Number.isFinite(ux) || !Number.isFinite(uy)) return null;
  const ox = r2(ux), oy = r2(uy);
  const W = Math.max(r2(ux1 - ux), 0.01);
  const H = Math.max(r2(uy1 - uy), 0.01);
  if (ox !== 0 || oy !== 0) {
    for (let i = 0; i < shapes.length; i++) {
      const rebased = translatePathD(shapes[i].d, -ox, -oy);
      if (!rebased) return null;
      shapes[i] = { d: rebased, paint: shapes[i].paint };
    }
  }

  const rootAttrs: Record<string, string> = { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' };
  const box = { w: W, h: H };

  if (shapes.length === 1) {
    trace.action('svg-drop:decompose', { baseId, shapes: 1, W, H });
    return { attrs: rootAttrs, children: [pathDesc(`${baseId}-g0`, shapes[0])], box };
  }

  // Multi-shape → the EXACT child convention `groupSvgs`/`refitGroupBounds`
  // operate on: every nested shape svg is positioned AND sized to its OWN
  // bbox inside the wrapper (x/y/width/height = the shape's painted box),
  // its viewBox 1:1 with that box, and its path translated to LOCAL 0,0.
  // Full-size children (x=0, width=W) render identically but lie to the
  // group math — moving one letter then scattered the whole mark (live
  // find 2026-07-28: refit unions the DECLARED boxes).
  const children: NewNodeDescriptor[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const bbox = geometryBBox('path', { d: s.d });
    if (!bbox) return null;
    const bx = r2(bbox.x);
    const by = r2(bbox.y);
    const bw = Math.max(r2(bbox.width), 0.01);
    const bh = Math.max(r2(bbox.height), 0.01);
    const localD = translatePathD(s.d, -bx, -by);
    if (!localD) return null;
    const sid = `${baseId}-s${i}`;
    children.push({
      tag: 'svg',
      id: sid,
      name: `${name || 'Shape'} ${i + 1}`,
      styles: {},
      attrs: {
        x: String(bx), y: String(by), width: String(bw), height: String(bh),
        viewBox: `0 0 ${bw} ${bh}`, overflow: 'visible',
      },
      children: [pathDesc(`${sid}-g0`, { d: localD, paint: s.paint })],
    });
  }
  trace.action('svg-drop:decompose', { baseId, shapes: children.length, W, H });
  return { attrs: rootAttrs, children, box };
}
