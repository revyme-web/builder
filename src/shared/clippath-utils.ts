// clippath-utils.ts — Parse, format, and preset definitions for CSS clip-path.
// Supports: polygon(), circle(), ellipse(), inset().

import { trace } from '@/shared/debug-trace';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClipPathType = 'polygon' | 'circle' | 'ellipse' | 'inset';

/** A single coordinate value with its CSS unit preserved for round-tripping. */
export type CSSVal = { v: number; unit: '%' | 'px' | '' };

export interface ClipPathData {
  type: ClipPathType;
  // Polygon: array of [xVal, yVal] pairs with units
  points: [CSSVal, CSSVal][];
  // Circle
  radius: number;      // %
  centerX: number;     // %
  centerY: number;     // %
  // Ellipse
  radiusX: number;     // %
  radiusY: number;     // %
  // Inset
  top: number;         // %
  right: number;       // %
  bottom: number;      // %
  left: number;        // %
  round: number;       // px (border-radius for inset)
}

/** Convenience: create a percentage CSSVal */
export function pct(v: number): CSSVal { return { v, unit: '%' }; }
/** Convenience: create a px CSSVal */
export function px(v: number): CSSVal { return { v, unit: 'px' }; }

// ─── Defaults ────────────────────────────────────────────────────────────────

export function createDefaultClipPath(type: ClipPathType = 'polygon'): ClipPathData {
  const base: ClipPathData = {
    type,
    points: [],
    radius: 50, centerX: 50, centerY: 50,
    radiusX: 50, radiusY: 40,
    top: 10, right: 10, bottom: 10, left: 10, round: 0,
  };
  if (type === 'polygon') {
    base.points = [[pct(50), pct(0)], [pct(0), pct(100)], [pct(100), pct(100)]]; // triangle
  }
  return base;
}

// ─── Presets (polygon only) ──────────────────────────────────────────────────

export interface ClipPathPreset {
  name: string;
  points: [number, number][]; // raw numbers, always %
}

/** Convert raw preset [number, number][] to CSSVal pairs (all %) */
export function presetToPoints(pts: [number, number][]): [CSSVal, CSSVal][] {
  return pts.map(([x, y]) => [pct(x), pct(y)]);
}

export const CLIPPATH_PRESETS: ClipPathPreset[] = [
  { name: 'Triangle', points: [[50, 0], [0, 100], [100, 100]] },
  { name: 'Diamond', points: [[50, 0], [100, 50], [50, 100], [0, 50]] },
  { name: 'Pentagon', points: [[50, 0], [100, 38], [82, 100], [18, 100], [0, 38]] },
  { name: 'Hexagon', points: [[25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]] },
  { name: 'Heptagon', points: [[50, 0], [90, 20], [100, 61], [75, 100], [25, 100], [0, 61], [10, 20]] },
  { name: 'Octagon', points: [[30, 0], [70, 0], [100, 30], [100, 70], [70, 100], [30, 100], [0, 70], [0, 30]] },
  { name: 'Star', points: [[50, 0], [61, 35], [98, 35], [68, 57], [79, 91], [50, 70], [21, 91], [32, 57], [2, 35], [39, 35]] },
  { name: 'Cross', points: [[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]] },
  { name: 'Arrow Right', points: [[0, 20], [60, 20], [60, 0], [100, 50], [60, 100], [60, 80], [0, 80]] },
  { name: 'Arrow Left', points: [[40, 0], [40, 20], [100, 20], [100, 80], [40, 80], [40, 100], [0, 50]] },
  { name: 'Chevron Right', points: [[0, 0], [75, 0], [100, 50], [75, 100], [0, 100], [25, 50]] },
  { name: 'Chevron Left', points: [[100, 0], [25, 0], [0, 50], [25, 100], [100, 100], [75, 50]] },
  { name: 'Parallelogram', points: [[25, 0], [100, 0], [75, 100], [0, 100]] },
  { name: 'Trapezoid', points: [[20, 0], [80, 0], [100, 100], [0, 100]] },
  { name: 'Rabbet', points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 75], [15, 75], [15, 25], [0, 25]] },
  { name: 'Message', points: [[0, 0], [100, 0], [100, 75], [75, 75], [75, 100], [50, 75], [0, 75]] },
  { name: 'Close', points: [[20, 0], [0, 20], [30, 50], [0, 80], [20, 100], [50, 70], [80, 100], [100, 80], [70, 50], [100, 20], [80, 0], [50, 30]] },
  { name: 'Frame', points: [[0, 0], [0, 100], [25, 100], [25, 25], [75, 25], [75, 75], [25, 75], [25, 100], [100, 100], [100, 0]] },
];

// ─── Parse ───────────────────────────────────────────────────────────────────

/** Parse a number value, stripping % or px suffix. Returns raw number. */
function parseNum(s: string): number {
  return parseFloat(s.replace(/%|px/g, '')) || 0;
}

/** Parse a CSS value string preserving its unit. */
function parseCSSVal(s: string): CSSVal {
  const trimmed = s.trim();
  const v = parseFloat(trimmed) || 0;
  if (trimmed.endsWith('px')) return { v, unit: 'px' };
  if (trimmed.endsWith('%')) return { v, unit: '%' };
  // No unit — treat as % (CSS spec default for clip-path percentages)
  return { v, unit: '%' };
}

/** Parse polygon(x y, x y, ...) preserving units per coordinate */
function parsePolygon(inner: string): [CSSVal, CSSVal][] {
  return inner.split(',').map(pair => {
    const parts = pair.trim().split(/\s+/);
    return [parseCSSVal(parts[0] || '0'), parseCSSVal(parts[1] || '0')];
  });
}

/** Parse circle(R% at X% Y%) or circle(R%) */
function parseCircle(inner: string): { radius: number; centerX: number; centerY: number } {
  const atIdx = inner.indexOf(' at ');
  if (atIdx >= 0) {
    const radiusPart = inner.slice(0, atIdx).trim();
    const posPart = inner.slice(atIdx + 4).trim().split(/\s+/);
    return {
      radius: parseNum(radiusPart),
      centerX: parseNum(posPart[0] || '50'),
      centerY: parseNum(posPart[1] || '50'),
    };
  }
  return { radius: parseNum(inner.trim()), centerX: 50, centerY: 50 };
}

/** Parse ellipse(Rx% Ry% at X% Y%) or ellipse(Rx% Ry%) */
function parseEllipse(inner: string): { radiusX: number; radiusY: number; centerX: number; centerY: number } {
  const atIdx = inner.indexOf(' at ');
  if (atIdx >= 0) {
    const radPart = inner.slice(0, atIdx).trim().split(/\s+/);
    const posPart = inner.slice(atIdx + 4).trim().split(/\s+/);
    return {
      radiusX: parseNum(radPart[0] || '50'),
      radiusY: parseNum(radPart[1] || '50'),
      centerX: parseNum(posPart[0] || '50'),
      centerY: parseNum(posPart[1] || '50'),
    };
  }
  const parts = inner.trim().split(/\s+/);
  return { radiusX: parseNum(parts[0] || '50'), radiusY: parseNum(parts[1] || '50'), centerX: 50, centerY: 50 };
}

/** Parse inset(T% R% B% L% round Npx) or shorthand variants */
function parseInset(inner: string): { top: number; right: number; bottom: number; left: number; round: number } {
  let round = 0;
  let valStr = inner;
  const roundIdx = inner.indexOf('round');
  if (roundIdx >= 0) {
    round = parseNum(inner.slice(roundIdx + 5).trim());
    valStr = inner.slice(0, roundIdx).trim();
  }
  const parts = valStr.split(/\s+/).map(parseNum);
  // CSS shorthand: 1 val = all, 2 = TB LR, 3 = T LR B, 4 = T R B L
  const top = parts[0] || 0;
  const right = parts.length >= 2 ? parts[1] : top;
  const bottom = parts.length >= 3 ? parts[2] : top;
  const left = parts.length >= 4 ? parts[3] : right;
  return { top, right, bottom, left, round };
}

/**
 * Parse a CSS clip-path value into ClipPathData.
 * Returns null if the value is empty, 'none', or unparseable.
 */
export function parseClipPath(raw: string | undefined): ClipPathData | null {
  if (!raw || raw === 'none') return null;
  trace.fn('parseClipPath', { raw: raw.slice(0, 80) });

  const base = createDefaultClipPath();

  // polygon(...)
  const polyMatch = raw.match(/polygon\s*\(([\s\S]*)\)/i);
  if (polyMatch) {
    base.type = 'polygon';
    base.points = parsePolygon(polyMatch[1]);
    return base;
  }

  // circle(...)
  const circleMatch = raw.match(/circle\s*\(([\s\S]*)\)/i);
  if (circleMatch) {
    base.type = 'circle';
    const parsed = parseCircle(circleMatch[1]);
    base.radius = parsed.radius;
    base.centerX = parsed.centerX;
    base.centerY = parsed.centerY;
    return base;
  }

  // ellipse(...)
  const ellipseMatch = raw.match(/ellipse\s*\(([\s\S]*)\)/i);
  if (ellipseMatch) {
    base.type = 'ellipse';
    const parsed = parseEllipse(ellipseMatch[1]);
    base.radiusX = parsed.radiusX;
    base.radiusY = parsed.radiusY;
    base.centerX = parsed.centerX;
    base.centerY = parsed.centerY;
    return base;
  }

  // inset(...)
  const insetMatch = raw.match(/inset\s*\(([\s\S]*)\)/i);
  if (insetMatch) {
    base.type = 'inset';
    const parsed = parseInset(insetMatch[1]);
    base.top = parsed.top;
    base.right = parsed.right;
    base.bottom = parsed.bottom;
    base.left = parsed.left;
    base.round = parsed.round;
    return base;
  }

  return null;
}

// ─── Format ──────────────────────────────────────────────────────────────────

/** Round to 2 decimal places, strip trailing zeros. */
function fmt(n: number): string {
  return parseFloat(n.toFixed(2)).toString();
}

/**
 * Format ClipPathData to a CSS clip-path value string.
 */
export function formatClipPath(data: ClipPathData): string {
  trace.fn('formatClipPath', { type: data.type });

  switch (data.type) {
    case 'polygon': {
      const fmtVal = (cv: CSSVal) => cv.unit === 'px' ? `${fmt(cv.v)}px` : `${fmt(cv.v)}%`;
      const pts = data.points.map(([x, y]) => `${fmtVal(x)} ${fmtVal(y)}`).join(', ');
      return `polygon(${pts})`;
    }
    case 'circle':
      return `circle(${fmt(data.radius)}% at ${fmt(data.centerX)}% ${fmt(data.centerY)}%)`;
    case 'ellipse':
      return `ellipse(${fmt(data.radiusX)}% ${fmt(data.radiusY)}% at ${fmt(data.centerX)}% ${fmt(data.centerY)}%)`;
    case 'inset': {
      const vals = `${fmt(data.top)}% ${fmt(data.right)}% ${fmt(data.bottom)}% ${fmt(data.left)}%`;
      if (data.round > 0) return `inset(${vals} round ${fmt(data.round)}px)`;
      return `inset(${vals})`;
    }
  }
}
