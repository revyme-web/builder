// svg-import.ts — Transpile a FOREIGN SVG (dropped file, pasted markup) into
// the editor's NATIVE shape format so every imported icon is fully
// shape-editable, exactly like hand-drawn shapes.
//
// The shape system's canonical structures (see group-svgs.ts /
// ShapeCreator / the shape-edit host):
//
//   SHAPE  — `<svg data-id data-name viewBox="0 0 W H"
//             preserveAspectRatio="none" style={{ position:'absolute',
//             left, top, width: 'Wpx', height: 'Hpx', overflow:'visible' }}>
//               <path d="…px-space coords, origin 0,0…" fill … />
//             </svg>`
//            viewBox 1:1 with the px box; geometry ONLY as path/polygon/
//            polyline (the shape editor's GEOMETRY_SELECTOR) with NO
//            transform attrs.
//
//   GROUP  — same wrapper, but children are NESTED `<svg x y width height
//            viewBox … overflow="visible">` elements (group-edit
//            isolation drills into them recursively on double-click).
//
// A foreign SVG is none of that: geometry hides behind `transform`
// chains, primitives (rect/circle/ellipse), shorthand path commands and
// arcs, and presentation inherits through `<g>` wrappers. This module
// RESOLVES all of it:
//
//   • transforms (translate/scale/rotate/matrix/skew) are BAKED into the
//     coordinates — output paths carry no transform at all,
//   • every primitive + every path command is normalized to absolute
//     M/L/C/Z (arcs → cubics via center parameterization, Q/S/T → C,
//     rounded-rect corners → kappa cubics — same convention as the
//     system's own ellipsePathD),
//   • presentation (fill/stroke/…) is resolved per LEAF with SVG
//     inheritance + `style=""` declarations, `currentColor` pinned,
//   • `<g>` structure becomes editor groups — groups in groups, matching
//     buildGroupedSvg's nested-svg markup byte-for-byte in shape.
//
// When the SVG uses features the shape system can't represent (masks,
// gradients, clip paths, <use>, <text>, filters…) the converter returns
// null and the caller falls back to the opaque `data-graphic` wrapper —
// still pixel-correct on canvas, just not vertex-editable.

import { parseSvgPath, elementToD } from '@/shared/svg-path/svg-path-parser';
import type { Affine6 } from '@/shared/svg-geometry';
import { r3 } from './group-resize-bake';
import { trace } from '@/shared/debug-trace';

// ─── Types ────────────────────────────────────────────────────────────────

/** Absolute normalized command: ['M',x,y] | ['L',x,y] | ['C',c1x,c1y,c2x,c2y,x,y] | ['Z'] */
type Cmd = [string, ...number[]];

interface Box { x: number; y: number; w: number; h: number }

interface Presentation {
  fill: string;
  fillRule: string | null;
  fillOpacity: string | null;
  stroke: string | null;
  strokeWidth: number;
  strokeLinecap: string | null;
  strokeLinejoin: string | null;
  strokeDasharray: string | null;
  strokeOpacity: string | null;
  opacity: number;
}

interface ImportedShape {
  kind: 'shape';
  name: string;
  cmds: Cmd[];
  paint: Presentation;
  bbox: Box;
}
interface ImportedGroup {
  kind: 'group';
  name: string;
  children: ImportedItem[];
  bbox: Box;
}
type ImportedItem = ImportedShape | ImportedGroup;

export interface SvgImportOptions {
  /** Unique per-icon prefix for generated data-ids (e.g. 'icon-3'). */
  iconId: string;
  /** data-name for a multi-shape icon's root group. */
  displayName: string;
  /** Target box the source viewBox maps into (the icon card). */
  cardW: number;
  cardH: number;
}

export interface SvgImportResult {
  /** JSX for the icon card's content — ONE shape or group `<svg>` wrapper. */
  jsx: string;
  shapeCount: number;
  groupCount: number;
}

/** Feature outside the native shape model — bail to the graphic fallback. */
class UnsupportedSvgError extends Error {}

// ─── Transform parsing ────────────────────────────────────────────────────

const IDENTITY: Affine6 = [1, 0, 0, 1, 0, 0];

/** `A · B` for SVG affines (apply B first, then A). */
function mulAffine(A: Affine6, B: Affine6): Affine6 {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function applyAffine(m: Affine6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Average absolute scale of an affine — used to scale stroke widths. */
function affineScale(m: Affine6): number {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return Math.sqrt(det) || 1;
}

/** Parse an SVG `transform` list into one affine. Unknown functions bail. */
export function parseTransformList(transform: string | null): Affine6 {
  if (!transform || !transform.trim()) return IDENTITY;
  let m: Affine6 = IDENTITY;
  const fnRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = fnRe.exec(transform)) !== null) {
    consumed += match[0].length;
    const fn = match[1];
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (args.some(n => !Number.isFinite(n))) throw new UnsupportedSvgError(`bad transform args: ${match[0]}`);
    let t: Affine6;
    switch (fn) {
      case 'translate': t = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]; break;
      case 'scale': t = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = ((args[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        const cx = args[1] ?? 0, cy = args[2] ?? 0;
        // rotate(a cx cy) = translate(cx cy)·rotate(a)·translate(-cx -cy)
        t = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'matrix':
        if (args.length !== 6) throw new UnsupportedSvgError('matrix() needs 6 args');
        t = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case 'skewX': t = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': t = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
      default: throw new UnsupportedSvgError(`unsupported transform: ${fn}`);
    }
    m = mulAffine(m, t);
  }
  // A transform attr that parsed into NOTHING (garbage text) → treat as identity.
  void consumed;
  return m;
}

// ─── Path normalization: any d → absolute M/L/C/Z ─────────────────────────

/** Elliptical arc → cubic segments (F.6.5 center parameterization, ≤90° per
 *  segment). Returns flat [c1x,c1y,c2x,c2y,x,y] runs. Exact under any affine
 *  once converted — the reason ALL arcs become cubics on import. */
export function arcToCubics(
  x1: number, y1: number,
  rxIn: number, ryIn: number, phiDeg: number,
  largeArc: number, sweep: number,
  x2: number, y2: number,
): number[][] {
  if (rxIn === 0 || ryIn === 0 || (x1 === x2 && y1 === y2)) {
    return [[x1, y1, x2, y2, x2, y2]]; // degenerate: straight line
  }
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const theta1 = ang(1, 0, ux, uy);
  let dTheta = ang(ux, uy, vx, vy) % (2 * Math.PI);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const point = (th: number): [number, number] => [
    cx + rx * Math.cos(th) * cosP - ry * Math.sin(th) * sinP,
    cy + rx * Math.cos(th) * sinP + ry * Math.sin(th) * cosP,
  ];
  const deriv = (th: number): [number, number] => [
    -rx * Math.sin(th) * cosP - ry * Math.cos(th) * sinP,
    -rx * Math.sin(th) * sinP + ry * Math.cos(th) * cosP,
  ];
  const out: number[][] = [];
  for (let i = 0; i < segs; i++) {
    const th = theta1 + i * delta;
    const [px, py] = point(th);
    const [nx, ny] = point(th + delta);
    const [d1x, d1y] = deriv(th);
    const [d2x, d2y] = deriv(th + delta);
    out.push([px + t * d1x, py + t * d1y, nx - t * d2x, ny - t * d2y, nx, ny]);
  }
  return out;
}

/** Parse + normalize any path `d` to absolute M/L/C/Z commands. */
export function normalizePathD(d: string): Cmd[] {
  const raw = parseSvgPath(d);
  const out: Cmd[] = [];
  let cx = 0, cy = 0;         // current point
  let sx = 0, sy = 0;         // subpath start (for Z)
  let prevC: [number, number] | null = null; // last cubic ctrl2 (for S)
  let prevQ: [number, number] | null = null; // last quad ctrl (for T)

  const quadToCubic = (qx: number, qy: number, x: number, y: number): Cmd => {
    const c1x = cx + (2 / 3) * (qx - cx), c1y = cy + (2 / 3) * (qy - cy);
    const c2x = x + (2 / 3) * (qx - x), c2y = y + (2 / 3) * (qy - y);
    return ['C', c1x, c1y, c2x, c2y, x, y];
  };

  for (const cmd of raw) {
    const type = cmd[0];
    const abs = type === type.toUpperCase();
    const T = type.toUpperCase();
    const n = cmd.slice(1).map(Number);
    const ox = abs ? 0 : cx, oy = abs ? 0 : cy;
    let keepC = false, keepQ = false;
    switch (T) {
      case 'M':
        cx = ox + n[0]; cy = oy + n[1];
        sx = cx; sy = cy;
        out.push(['M', cx, cy]);
        break;
      case 'L':
        cx = ox + n[0]; cy = oy + n[1];
        out.push(['L', cx, cy]);
        break;
      case 'H':
        cx = ox + n[0];
        out.push(['L', cx, cy]);
        break;
      case 'V':
        cy = oy + n[0];
        out.push(['L', cx, cy]);
        break;
      case 'C': {
        const c1x = ox + n[0], c1y = oy + n[1], c2x = ox + n[2], c2y = oy + n[3];
        cx = ox + n[4]; cy = oy + n[5];
        out.push(['C', c1x, c1y, c2x, c2y, cx, cy]);
        prevC = [c2x, c2y]; keepC = true;
        break;
      }
      case 'S': {
        const c1x = prevC ? 2 * cx - prevC[0] : cx;
        const c1y = prevC ? 2 * cy - prevC[1] : cy;
        const c2x = ox + n[0], c2y = oy + n[1];
        cx = ox + n[2]; cy = oy + n[3];
        out.push(['C', c1x, c1y, c2x, c2y, cx, cy]);
        prevC = [c2x, c2y]; keepC = true;
        break;
      }
      case 'Q': {
        const qx = ox + n[0], qy = oy + n[1];
        const x = ox + n[2], y = oy + n[3];
        out.push(quadToCubic(qx, qy, x, y));
        cx = x; cy = y;
        prevQ = [qx, qy]; keepQ = true;
        break;
      }
      case 'T': {
        // Explicit annotations: TS's loop narrowing otherwise sees
        // qx → prevQ=[qx,qy] → prevQ[0] → qx as a circular inference (TS7022).
        const qx: number = prevQ ? 2 * cx - prevQ[0] : cx;
        const qy: number = prevQ ? 2 * cy - prevQ[1] : cy;
        const x = ox + n[0], y = oy + n[1];
        out.push(quadToCubic(qx, qy, x, y));
        cx = x; cy = y;
        prevQ = [qx, qy]; keepQ = true;
        break;
      }
      case 'A': {
        const x = ox + n[5], y = oy + n[6];
        for (const seg of arcToCubics(cx, cy, n[0], n[1], n[2], n[3], n[4], x, y)) {
          out.push(['C', seg[0], seg[1], seg[2], seg[3], seg[4], seg[5]]);
        }
        cx = x; cy = y;
        break;
      }
      case 'Z':
        cx = sx; cy = sy;
        out.push(['Z']);
        break;
      default:
        throw new UnsupportedSvgError(`unknown path command: ${type}`);
    }
    if (!keepC) prevC = null;
    if (!keepQ) prevQ = null;
  }
  return out;
}

function transformCmds(cmds: Cmd[], m: Affine6): Cmd[] {
  return cmds.map((cmd): Cmd => {
    const [type, ...nums] = cmd;
    const mapped: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const [x, y] = applyAffine(m, nums[i] as number, nums[i + 1] as number);
      mapped.push(x, y);
    }
    return [type, ...mapped] as Cmd;
  });
}

function cmdsBBox(cmds: Cmd[]): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cmd of cmds) {
    const nums = cmd.slice(1) as number[];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]);
      minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function unionBox(boxes: Box[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function serializeCmds(cmds: Cmd[], dx: number, dy: number): string {
  return cmds.map(cmd => {
    const [type, ...nums] = cmd;
    if (type === 'Z') return 'Z';
    const pts: string[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pts.push(`${r3((nums[i] as number) + dx)} ${r3((nums[i + 1] as number) + dy)}`);
    }
    return `${type}${pts.join(' ')}`;
  }).join('');
}

// ─── Rounded rect (elementToD's rectToD ignores rx) ───────────────────────

const KAPPA = 0.5522847498;

function roundedRectToCmds(x: number, y: number, w: number, h: number, rxIn: number, ryIn: number): Cmd[] {
  let rx = Math.min(Math.abs(rxIn), w / 2);
  let ry = Math.min(Math.abs(ryIn), h / 2);
  if (rx === 0 || ry === 0) {
    return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
  }
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    ['M', x + rx, y],
    ['L', x + w - rx, y],
    ['C', x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry],
    ['L', x + w, y + h - ry],
    ['C', x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h],
    ['L', x + rx, y + h],
    ['C', x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry],
    ['L', x, y + ry],
    ['C', x, y + ry - ky, x + rx - kx, y, x + rx, y],
    ['Z'],
  ];
}

// ─── Presentation resolution ───────────────────────────────────────────────

const DEFAULT_PAINT: Presentation = {
  fill: '#000000', fillRule: null, fillOpacity: null,
  stroke: null, strokeWidth: 1,
  strokeLinecap: null, strokeLinejoin: null, strokeDasharray: null, strokeOpacity: null,
  opacity: 1,
};

/** Read a presentation value: inline `style=""` wins over the attribute. */
function presValue(el: Element, name: string): string | null {
  const styleAttr = el.getAttribute('style');
  if (styleAttr) {
    for (const decl of styleAttr.split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      if (decl.slice(0, idx).trim() === name) {
        const v = decl.slice(idx + 1).trim();
        if (v) return v;
      }
    }
  }
  const attr = el.getAttribute(name);
  return attr !== null && attr !== '' ? attr : null;
}

function resolvePaintColor(value: string): string {
  const v = value.trim();
  if (v === 'currentColor') return '#000000'; // pin — no CSS color context in a shape file
  if (/^url\(/i.test(v)) throw new UnsupportedSvgError('paint server reference (gradient/pattern)');
  if (v === 'transparent') return 'none';
  return v;
}

function inheritPresentation(el: Element, parent: Presentation): Presentation {
  const next: Presentation = { ...parent };
  const fill = presValue(el, 'fill');
  if (fill !== null) next.fill = resolvePaintColor(fill);
  const stroke = presValue(el, 'stroke');
  if (stroke !== null) {
    const resolved = resolvePaintColor(stroke);
    next.stroke = resolved === 'none' ? null : resolved;
  }
  const sw = presValue(el, 'stroke-width');
  if (sw !== null) {
    const parsed = parseFloat(sw);
    if (Number.isFinite(parsed)) next.strokeWidth = parsed;
  }
  const fr = presValue(el, 'fill-rule');
  if (fr !== null) next.fillRule = fr;
  const fo = presValue(el, 'fill-opacity');
  if (fo !== null) next.fillOpacity = fo;
  const so = presValue(el, 'stroke-opacity');
  if (so !== null) next.strokeOpacity = so;
  const lc = presValue(el, 'stroke-linecap');
  if (lc !== null) next.strokeLinecap = lc;
  const lj = presValue(el, 'stroke-linejoin');
  if (lj !== null) next.strokeLinejoin = lj;
  const da = presValue(el, 'stroke-dasharray');
  if (da !== null) next.strokeDasharray = da === 'none' ? null : da;
  // Group opacity doesn't inherit per spec (it composites) — multiplying it
  // down is the standard flattening approximation and is exact for
  // non-overlapping children (the common icon case).
  const op = presValue(el, 'opacity');
  if (op !== null) {
    const parsed = parseFloat(op);
    if (Number.isFinite(parsed)) next.opacity = parent.opacity * parsed;
  }
  return next;
}

// ─── <style> class inlining (plain .class rules only) ─────────────────────

function applyStyleElements(root: Element, doc: Document): void {
  const styleEls = Array.from(root.querySelectorAll('style'));
  if (styleEls.length === 0) return;
  const rules = new Map<string, string>(); // class → decl text
  for (const styleEl of styleEls) {
    const css = styleEl.textContent ?? '';
    // strip comments
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const part of clean.split('}')) {
      const idx = part.indexOf('{');
      if (idx === -1) continue;
      const selector = part.slice(0, idx).trim();
      if (!selector) continue;
      const decls = part.slice(idx + 1).trim();
      for (const sel of selector.split(',').map(s => s.trim())) {
        const m = sel.match(/^\.([\w-]+)$/);
        if (!m) throw new UnsupportedSvgError(`non-class CSS selector: ${sel}`);
        const existing = rules.get(m[1]);
        rules.set(m[1], existing ? `${existing};${decls}` : decls);
      }
    }
    styleEl.remove();
  }
  if (rules.size === 0) return;
  for (const el of Array.from(root.querySelectorAll('[class]'))) {
    const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const merged: string[] = [];
    for (const cls of classes) {
      const r = rules.get(cls);
      if (r) merged.push(r);
    }
    if (merged.length > 0) {
      const existing = el.getAttribute('style');
      // class rules sit UNDER the element's own inline style in the cascade
      el.setAttribute('style', existing ? `${merged.join(';')};${existing}` : merged.join(';'));
    }
    el.removeAttribute('class');
  }
  void doc;
}

// ─── DOM walk ──────────────────────────────────────────────────────────────

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const SKIP_TAGS = new Set(['title', 'desc', 'metadata', 'defs', 'style']);
const UNSUPPORTED_TAGS = new Set([
  'use', 'text', 'tspan', 'textpath', 'image', 'pattern', 'filter',
  'foreignobject', 'switch', 'symbol', 'marker', 'lineargradient',
  'radialgradient', 'mask', 'clippath', 'svg', 'animate', 'animatetransform',
  'animatemotion', 'script',
]);

const SHAPE_NAME_BY_TAG: Record<string, string> = {
  path: 'Path', rect: 'Rectangle', circle: 'Ellipse', ellipse: 'Ellipse',
  line: 'Line', polyline: 'Line', polygon: 'Polygon',
};

function elementCmds(el: Element): Cmd[] {
  const tag = el.tagName.toLowerCase();
  if (tag === 'rect') {
    const x = parseFloat(el.getAttribute('x') || '0');
    const y = parseFloat(el.getAttribute('y') || '0');
    const w = parseFloat(el.getAttribute('width') || '0');
    const h = parseFloat(el.getAttribute('height') || '0');
    const rxAttr = el.getAttribute('rx'), ryAttr = el.getAttribute('ry');
    const rx = rxAttr !== null ? parseFloat(rxAttr) : (ryAttr !== null ? parseFloat(ryAttr) : 0);
    const ry = ryAttr !== null ? parseFloat(ryAttr) : rx;
    if (!(w > 0) || !(h > 0)) return [];
    return roundedRectToCmds(x, y, w, h, rx || 0, ry || 0);
  }
  const d = elementToD(el); // path verbatim; circle/ellipse → kappa cubics; poly/line → M/L
  if (!d) return [];
  return normalizePathD(d);
}

function walkElement(el: Element, ctm: Affine6, paint: Presentation): ImportedItem[] {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return [];
  if (UNSUPPORTED_TAGS.has(tag)) throw new UnsupportedSvgError(`unsupported element: <${tag}>`);

  // Clip/mask/filter ATTRS can't be represented on native shapes.
  for (const attr of ['clip-path', 'mask', 'filter']) {
    if (presValue(el, attr)) throw new UnsupportedSvgError(`unsupported attribute: ${attr}`);
  }

  const localMatrix = mulAffine(ctm, parseTransformList(el.getAttribute('transform')));

  if (tag === 'g') {
    const childPaint = inheritPresentation(el, paint);
    const children: ImportedItem[] = [];
    for (const child of Array.from(el.children)) {
      children.push(...walkElement(child, localMatrix, childPaint));
    }
    if (children.length === 0) return [];
    if (children.length === 1) return children; // collapse single-child groups
    return [{ kind: 'group', name: 'Group', children, bbox: unionBox(children.map(c => c.bbox)) }];
  }

  if (!SHAPE_TAGS.has(tag)) {
    throw new UnsupportedSvgError(`unsupported element: <${tag}>`);
  }

  const shapePaint = inheritPresentation(el, paint);
  const cmds = transformCmds(elementCmds(el), localMatrix);
  if (cmds.length === 0) return [];
  const bbox = cmdsBBox(cmds);
  if (!bbox) return [];
  // Open strokes (line/polyline) have zero-area bboxes — keep them, they
  // paint via stroke; pad the box below at emit time instead.
  shapePaint.strokeWidth = r3(shapePaint.strokeWidth * affineScale(localMatrix));
  // line/polyline default: SVG paints them with stroke only; a fill would
  // fill the implied polygon. elementToD keeps them open — force fill none
  // when the source didn't explicitly set one.
  if ((tag === 'line' || tag === 'polyline') && presValue(el, 'fill') === null) {
    shapePaint.fill = 'none';
  }
  return [{ kind: 'shape', name: SHAPE_NAME_BY_TAG[tag] ?? 'Path', cmds, paint: shapePaint, bbox }];
}

// ─── JSX emission (canonical shape/group markup) ───────────────────────────

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function paintAttrs(p: Presentation): string {
  // Match ShapeCreator's conventions: always emit fill + stroke + stroke-width
  // (stroke-width 0 when strokeless) so the right-panel controls have concrete
  // values to read.
  const stroke = p.stroke ?? '#000000';
  const strokeWidth = p.stroke ? r3(p.strokeWidth) : 0;
  let attrs = ` fill="${escapeAttr(p.fill)}" stroke="${escapeAttr(stroke)}" stroke-width="${strokeWidth}"`;
  if (p.fillRule) attrs += ` fill-rule="${escapeAttr(p.fillRule)}"`;
  if (p.fillOpacity) attrs += ` fill-opacity="${escapeAttr(p.fillOpacity)}"`;
  if (p.strokeOpacity) attrs += ` stroke-opacity="${escapeAttr(p.strokeOpacity)}"`;
  if (p.strokeLinecap) attrs += ` stroke-linecap="${escapeAttr(p.strokeLinecap)}"`;
  if (p.strokeLinejoin) attrs += ` stroke-linejoin="${escapeAttr(p.strokeLinejoin)}"`;
  if (p.strokeDasharray) attrs += ` stroke-dasharray="${escapeAttr(p.strokeDasharray)}"`;
  if (p.opacity !== 1) attrs += ` opacity="${r3(p.opacity)}"`;
  return attrs;
}

/** Integer-rounded box with a minimum 1px extent (open strokes have
 *  zero-area geometric bboxes; the wrapper still needs a real box). */
function intBox(b: Box): { x: number; y: number; w: number; h: number } {
  const x = Math.round(b.x), y = Math.round(b.y);
  return { x, y, w: Math.max(1, Math.round(b.x + b.w) - x), h: Math.max(1, Math.round(b.y + b.h) - y) };
}

interface IdGen { next(prefix: string): string }

/** Inner content of an item's wrapper svg (geometry for a shape, nested
 *  child svgs for a group) — shared by the top-level and nested emitters. */
function itemInner(item: ImportedItem, origin: { x: number; y: number }, ids: IdGen): string {
  if (item.kind === 'shape') {
    const d = serializeCmds(item.cmds, -origin.x, -origin.y);
    return `<path d="${d}"${paintAttrs(item.paint)} />`;
  }
  return item.children.map(child => {
    const cb = intBox(child.bbox);
    const inner = itemInner(child, { x: cb.x, y: cb.y }, ids);
    const id = ids.next(child.kind === 'group' ? 'vector' : 'shape');
    // Same nested-child markup as buildGroupedSvg (group-svgs.ts) — x/y in
    // the parent's 1:1 viewBox space, own 1:1 viewBox, overflow visible.
    return `<svg data-id="${id}" data-name="${escapeAttr(child.name)}" x="${cb.x - origin.x}" y="${cb.y - origin.y}" width="${cb.w}" height="${cb.h}" viewBox="0 0 ${cb.w} ${cb.h}" preserveAspectRatio="none" overflow="visible">${inner}</svg>`;
  }).join('');
}

function emitTopLevel(item: ImportedItem, ids: IdGen): string {
  const b = intBox(item.bbox);
  const inner = itemInner(item, { x: b.x, y: b.y }, ids);
  const id = ids.next(item.kind === 'group' ? 'vector' : 'shape');
  return `<svg data-id="${id}" data-name="${escapeAttr(item.name)}" viewBox="0 0 ${b.w} ${b.h}" preserveAspectRatio="none" style={{ position: "absolute", left: "${b.x}px", top: "${b.y}px", width: "${b.w}px", height: "${b.h}px", overflow: "visible" }}>${inner}</svg>`;
}

function countItems(items: ImportedItem[]): { shapes: number; groups: number } {
  let shapes = 0, groups = 0;
  for (const item of items) {
    if (item.kind === 'shape') shapes++;
    else {
      groups++;
      const sub = countItems(item.children);
      shapes += sub.shapes; groups += sub.groups;
    }
  }
  return { shapes, groups };
}

// ─── Entry point ───────────────────────────────────────────────────────────

/** Hard cap — a 900-path illustration would flood the node tree and the
 *  layers panel. Past this, the graphic fallback is the better trade. */
export const MAX_IMPORT_SHAPES = 60;

export function convertSvgToEditableShapes(rawSvg: string, opts: SvgImportOptions): SvgImportResult | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    const doc = new DOMParser().parseFromString(rawSvg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      trace.action('svg-import:parse-error', { iconId: opts.iconId });
      return null;
    }
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') return null;

    // Source coordinate box: viewBox, else width/height attrs.
    let vbX = 0, vbY = 0, vbW = 0, vbH = 0;
    const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      [vbX, vbY, vbW, vbH] = vb;
    } else {
      vbW = parseFloat(root.getAttribute('width') || '0');
      vbH = parseFloat(root.getAttribute('height') || '0');
    }
    if (!(vbW > 0) || !(vbH > 0)) return null;

    applyStyleElements(root, doc);

    // Root affine: source viewBox space → card px space, uniform scale,
    // centered (letterboxes when the card aspect was clamped).
    const s = Math.min(opts.cardW / vbW, opts.cardH / vbH);
    const rootM: Affine6 = [
      s, 0, 0, s,
      (opts.cardW - vbW * s) / 2 - vbX * s,
      (opts.cardH - vbH * s) / 2 - vbY * s,
    ];

    const items: ImportedItem[] = [];
    const rootPaint = inheritPresentation(root, DEFAULT_PAINT);
    for (const child of Array.from(root.children)) {
      items.push(...walkElement(child, mulAffine(rootM, parseTransformList(null)), rootPaint));
    }
    if (items.length === 0) return null;

    const { shapes, groups } = countItems(items);
    if (shapes === 0) return null;
    if (shapes > MAX_IMPORT_SHAPES) {
      trace.action('svg-import:too-many-shapes', { iconId: opts.iconId, shapes });
      return null;
    }

    let counter = 0;
    const ids: IdGen = { next: (prefix) => `${prefix}-${opts.iconId}-${++counter}` };

    // ONE top item → it IS the icon (positioned at its bbox in the card).
    // Several → wrap in a root group named after the icon so the card holds
    // a single selectable vector.
    const top: ImportedItem = items.length === 1
      ? items[0]
      : { kind: 'group', name: opts.displayName, children: items, bbox: unionBox(items.map(i => i.bbox)) };
    if (top.kind === 'group') top.name = opts.displayName;

    const jsx = emitTopLevel(top, ids);
    trace.action('svg-import:converted', { iconId: opts.iconId, shapes, groups });
    return { jsx, shapeCount: shapes, groupCount: groups };
  } catch (err) {
    if (err instanceof UnsupportedSvgError) {
      trace.action('svg-import:fallback-to-graphic', { iconId: opts.iconId, reason: err.message });
      return null;
    }
    trace.error('svg-import:failed', { iconId: opts.iconId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
