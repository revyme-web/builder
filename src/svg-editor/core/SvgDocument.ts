/**
 * SvgDocument — Manages multiple shapes inside one SVG.
 *
 * Parses an SVG's child elements (<path>, <line>, <circle>, <rect>, <polyline>, <polygon>)
 * into an array of ShapeEntry objects, each with its own PathModel + original attributes
 * (fill, stroke, etc.).
 *
 * Supports:
 * - Multiple <path> elements
 * - <line>, <circle>, <rect>, <ellipse>, <polyline>, <polygon> → converted to path d
 * - Preserving original stroke/fill/opacity per shape
 * - Serializing back to SVG child elements
 */

import { PathModel } from './PathModel';
import type { Anchor } from './types';

/** A single shape inside the SVG. */
export interface ShapeEntry {
  /** Index in the original SVG children list */
  index: number;
  /** Original SVG tag name */
  tag: string;
  /** The path model for editing */
  path: PathModel;
  /** Original SVG attributes (fill, stroke, stroke-width, etc.) — preserved on serialize */
  attrs: Record<string, string>;
  /** Whether this shape is visible (for toggling) */
  visible: boolean;
}

/** Convert a non-path SVG element to a path d string. */
/**
 * Parse a coord attribute value, resolving SVG percentages against the
 * given viewBox dimension. e.g. parseCoord("50%", 200) → 100.
 *
 * Why this matters: shape creators commonly emit ellipses / circles with
 * percentage attrs like `<ellipse cx="50%" cy="50%" rx="50%" ry="50%"/>`
 * so the shape auto-fits the wrapper SVG's viewBox. A naive
 * `parseFloat("50%")` returns 50 — which then gets treated as
 * absolute viewBox units, producing a path that paints in the upper-left
 * quadrant. The browser renders the ellipse correctly (it resolves
 * percentages per SVG spec) so the visible shape and the editor's
 * derived path geometry diverge: anchors cluster small in the corner
 * while the painted ellipse fills the wrapper. Resolve here so the
 * derived path matches what the browser actually paints.
 */
function parseCoord(value: string | undefined, vbDimension: number): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed.endsWith('%')) {
    const pct = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * vbDimension : 0;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : 0;
}

function elementToD(tag: string, attrs: Record<string, string>, viewBox?: { width: number; height: number }): string {
  // Default viewBox dims fall back to 100 (the SVG default) when the
  // caller doesn't pass one — keeps the function backwards-compatible
  // for any non-percentage geometry. The diagonal is used as a single
  // reference for `r` on circles per SVG spec (the closest equivalent
  // to "50% of viewport" for a uniform-radius shape).
  const vbW = viewBox?.width ?? 100;
  const vbH = viewBox?.height ?? 100;
  const vbDiag = Math.sqrt(vbW * vbW + vbH * vbH) / Math.SQRT2; // (sqrt(w² + h²) / √2)
  switch (tag) {
    case 'line': {
      const x1 = parseCoord(attrs.x1, vbW), y1 = parseCoord(attrs.y1, vbH);
      const x2 = parseCoord(attrs.x2, vbW), y2 = parseCoord(attrs.y2, vbH);
      return `M${x1},${y1} L${x2},${y2}`;
    }

    case 'rect': {
      const x = parseCoord(attrs.x, vbW);
      const y = parseCoord(attrs.y, vbH);
      const w = parseCoord(attrs.width, vbW);
      const h = parseCoord(attrs.height, vbH);
      const rx = parseCoord(attrs.rx, vbW);
      const ry = parseCoord(attrs.ry, vbH) || rx;
      if (rx === 0 && ry === 0) {
        return `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`;
      }
      // Rounded rect
      const r = Math.min(rx, w / 2, h / 2);
      return [
        `M${x + r},${y}`,
        `L${x + w - r},${y}`,
        `Q${x + w},${y} ${x + w},${y + r}`,
        `L${x + w},${y + h - r}`,
        `Q${x + w},${y + h} ${x + w - r},${y + h}`,
        `L${x + r},${y + h}`,
        `Q${x},${y + h} ${x},${y + h - r}`,
        `L${x},${y + r}`,
        `Q${x},${y} ${x + r},${y}`,
        'Z',
      ].join(' ');
    }

    case 'circle': {
      const cx = parseCoord(attrs.cx, vbW);
      const cy = parseCoord(attrs.cy, vbH);
      // `r` is uniform — per SVG spec percentages resolve against the
      // sqrt of (w²+h²)/2 ("normalized diagonal") so a circle stays
      // circular under non-uniform viewBoxes.
      const r = parseCoord(attrs.r, vbDiag);
      if (r === 0) return '';
      // 4 cubic bezier arcs
      const k = r * 0.5522848;
      return [
        `M${cx},${cy - r}`,
        `C${cx + k},${cy - r} ${cx + r},${cy - k} ${cx + r},${cy}`,
        `C${cx + r},${cy + k} ${cx + k},${cy + r} ${cx},${cy + r}`,
        `C${cx - k},${cy + r} ${cx - r},${cy + k} ${cx - r},${cy}`,
        `C${cx - r},${cy - k} ${cx - k},${cy - r} ${cx},${cy - r}`,
        'Z',
      ].join(' ');
    }

    case 'ellipse': {
      const cx = parseCoord(attrs.cx, vbW);
      const cy = parseCoord(attrs.cy, vbH);
      const rx = parseCoord(attrs.rx, vbW);
      const ry = parseCoord(attrs.ry, vbH);
      if (rx === 0 || ry === 0) return '';
      const kx = rx * 0.5522848;
      const ky = ry * 0.5522848;
      return [
        `M${cx},${cy - ry}`,
        `C${cx + kx},${cy - ry} ${cx + rx},${cy - ky} ${cx + rx},${cy}`,
        `C${cx + rx},${cy + ky} ${cx + kx},${cy + ry} ${cx},${cy + ry}`,
        `C${cx - kx},${cy + ry} ${cx - rx},${cy + ky} ${cx - rx},${cy}`,
        `C${cx - rx},${cy - ky} ${cx - kx},${cy - ry} ${cx},${cy - ry}`,
        'Z',
      ].join(' ');
    }

    case 'polygon': {
      const points = (attrs.points || '').trim();
      if (!points) return '';
      const pairs = points.split(/[\s,]+/);
      const parts: string[] = [];
      for (let i = 0; i < pairs.length - 1; i += 2) {
        parts.push(i === 0 ? `M${pairs[i]},${pairs[i + 1]}` : `L${pairs[i]},${pairs[i + 1]}`);
      }
      parts.push('Z');
      return parts.join(' ');
    }

    case 'polyline': {
      const points = (attrs.points || '').trim();
      if (!points) return '';
      const pairs = points.split(/[\s,]+/);
      const parts: string[] = [];
      for (let i = 0; i < pairs.length - 1; i += 2) {
        parts.push(i === 0 ? `M${pairs[i]},${pairs[i + 1]}` : `L${pairs[i]},${pairs[i + 1]}`);
      }
      return parts.join(' ');
    }

    default:
      return '';
  }
}

/** Attributes to skip when preserving (they're in the path model or not relevant) */
const SKIP_ATTRS = new Set([
  'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'points', 'xmlns',
]);

export class SvgDocument {
  private _shapes: ShapeEntry[] = [];
  private _viewBox = { x: 0, y: 0, width: 100, height: 100 };
  private _svgAttrs: Record<string, string> = {};

  constructor() {}

  // ── Parsing ──────────────────────────────────────────────────────────────

  /** Parse SVG markup string into shapes. */
  parseSvg(svgMarkup: string): void {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgMarkup, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    if (!svg) return;

    // Read viewBox
    const vb = svg.getAttribute('viewBox');
    if (vb) {
      const parts = vb.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        this._viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
      }
    } else {
      const w = parseFloat(svg.getAttribute('width') || '100');
      const h = parseFloat(svg.getAttribute('height') || '100');
      this._viewBox = { x: 0, y: 0, width: w, height: h };
    }

    // Preserve SVG-level attributes
    this._svgAttrs = {};
    for (const attr of Array.from(svg.attributes)) {
      if (attr.name !== 'xmlns') {
        this._svgAttrs[attr.name] = attr.value;
      }
    }

    // Parse child elements
    this._shapes = [];
    const children = svg.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i] as Element;
      const tag = el.tagName.toLowerCase();

      // Skip non-shape elements
      if (['defs', 'title', 'desc', 'style', 'metadata', 'g'].includes(tag)) continue;
      // TODO: handle <g> groups by flattening

      let d: string;
      if (tag === 'path') {
        d = el.getAttribute('d') || '';
      } else {
        const elAttrs: Record<string, string> = {};
        for (const attr of Array.from(el.attributes)) {
          elAttrs[attr.name] = attr.value;
        }
        // Pass the parsed viewBox so percentage geometry attrs (e.g.
        // `<ellipse cx="50%" cy="50%" rx="50%" ry="50%"/>` from the
        // shape creators) resolve against the same dimensions the
        // browser uses to paint them. Without this, percentages got
        // parsed as bare numbers (50% → 50) and produced anchors at a
        // fraction of the actual painted area.
        d = elementToD(tag, elAttrs, { width: this._viewBox.width, height: this._viewBox.height });
      }

      if (!d) continue;

      // Collect visual attributes (fill, stroke, etc.)
      const attrs: Record<string, string> = {};
      for (const attr of Array.from(el.attributes)) {
        if (!SKIP_ATTRS.has(attr.name)) {
          attrs[attr.name] = attr.value;
        }
      }

      const path = new PathModel(d);
      this._shapes.push({
        index: i,
        tag,
        path,
        attrs,
        visible: true,
      });
    }
  }

  /** Parse a single d attribute (wraps one PathModel). */
  parsePath(d: string, viewBox?: { x: number; y: number; width: number; height: number }): void {
    if (viewBox) this._viewBox = viewBox;
    this._shapes = [{
      index: 0,
      tag: 'path',
      path: new PathModel(d),
      attrs: {},
      visible: true,
    }];
  }

  /** Add a new empty shape. Returns its index. */
  addShape(attrs: Record<string, string> = {}): number {
    const idx = this._shapes.length;
    this._shapes.push({
      index: idx,
      tag: 'path',
      path: new PathModel(''),
      attrs: { ...attrs },
      visible: true,
    });
    return idx;
  }

  /** Remove a shape by index. */
  removeShape(shapeIndex: number): void {
    if (shapeIndex >= 0 && shapeIndex < this._shapes.length) {
      this._shapes.splice(shapeIndex, 1);
    }
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  get shapes(): readonly ShapeEntry[] { return this._shapes; }
  get viewBox() { return this._viewBox; }
  get shapeCount(): number { return this._shapes.length; }

  /** Get all anchors across all shapes, tagged with their shape index. */
  getAllAnchors(): Array<{ shapeIndex: number; anchorIndex: number; anchor: Anchor }> {
    const result: Array<{ shapeIndex: number; anchorIndex: number; anchor: Anchor }> = [];
    for (let s = 0; s < this._shapes.length; s++) {
      const anchors = this._shapes[s].path.anchors;
      for (let a = 0; a < anchors.length; a++) {
        result.push({ shapeIndex: s, anchorIndex: a, anchor: anchors[a] });
      }
    }
    return result;
  }

  /** Get a specific shape's PathModel. */
  getShape(shapeIndex: number): ShapeEntry | null {
    return this._shapes[shapeIndex] ?? null;
  }

  // ── Serialization ────────────────────────────────────────────────────────

  /** Serialize back to SVG child elements (without the outer <svg> tag). */
  serializeChildren(): string {
    return this._shapes.map(shape => {
      const d = shape.path.serialize();
      const attrStr = Object.entries(shape.attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<path d="${d}"${attrStr ? ' ' + attrStr : ''}/>`;
    }).join('\n  ');
  }

  /** Serialize to full SVG markup. */
  serializeSvg(): string {
    const vb = `${this._viewBox.x} ${this._viewBox.y} ${this._viewBox.width} ${this._viewBox.height}`;
    const svgAttrs = Object.entries(this._svgAttrs)
      .filter(([k]) => k !== 'viewBox')
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    const children = this.serializeChildren();
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"${svgAttrs ? ' ' + svgAttrs : ''}>\n  ${children}\n</svg>`;
  }

  /** Get all d attributes (one per shape). */
  serializePaths(): string[] {
    return this._shapes.map(s => s.path.serialize());
  }
}
