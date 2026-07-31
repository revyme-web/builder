// gradient-utils.ts — Gradient CSS parsing/formatting utilities for GradientEditor.
// Handles linear-gradient, radial-gradient, conic-gradient with stops and directions.

import { trace } from '@/shared/debug-trace';
import { splitStyleProps } from '@/shared/css-utils';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GradientStop {
  id: string;
  color: string;   // hex or rgba()
  position: number; // 0-100
}

type RadialShape = 'ellipse' | 'circle';
type RadialSize = 'custom' | 'closest-side' | 'closest-corner' | 'farthest-side' | 'farthest-corner';

export interface GradientData {
  type: 'linear' | 'radial' | 'conic';
  repeating: boolean;   // true = repeating-linear-gradient etc.
  direction: number;    // degrees (linear)
  centerX: number;      // 0-100% (radial/conic)
  centerY: number;      // 0-100% (radial/conic)
  radiusX: number;      // 0-100% (radial ellipse horizontal radius, used when radialSize='custom')
  radiusY: number;      // 0-100% (radial ellipse vertical radius, used when radialSize='custom')
  radialShape: RadialShape;  // circle or ellipse
  radialSize: RadialSize;    // sizing mode
  angle: number;        // degrees (conic from)
  stops: GradientStop[];
}

// ─── Parse ───────────────────────────────────────────────────────────────────

/**
 * Parse a CSS gradient string into GradientData.
 * Supports:
 *   linear-gradient(180deg, #ff0000 0%, #0000ff 100%)
 *   radial-gradient(circle at 50% 50%, #ff0000 0%, #0000ff 100%)
 *   conic-gradient(from 0deg at 50% 50%, #ff0000 0%, #0000ff 100%)
 * Returns null if parsing fails.
 */
export function parseGradient(css: string): GradientData | null {
  const trimmed = css.trim();
  trace.fn('parseGradient', { css: trimmed.slice(0, 120) });

  // Detect gradient type + repeating prefix
  let type: GradientData['type'];
  let inner: string;
  let repeating = false;

  if (trimmed.startsWith('repeating-linear-gradient(')) {
    type = 'linear'; repeating = true;
    inner = trimmed.slice('repeating-linear-gradient('.length, -1).trim();
  } else if (trimmed.startsWith('repeating-radial-gradient(')) {
    type = 'radial'; repeating = true;
    inner = trimmed.slice('repeating-radial-gradient('.length, -1).trim();
  } else if (trimmed.startsWith('repeating-conic-gradient(')) {
    type = 'conic'; repeating = true;
    inner = trimmed.slice('repeating-conic-gradient('.length, -1).trim();
  } else if (trimmed.startsWith('linear-gradient(')) {
    type = 'linear';
    inner = trimmed.slice('linear-gradient('.length, -1).trim();
  } else if (trimmed.startsWith('radial-gradient(')) {
    type = 'radial';
    inner = trimmed.slice('radial-gradient('.length, -1).trim();
  } else if (trimmed.startsWith('conic-gradient(')) {
    type = 'conic';
    inner = trimmed.slice('conic-gradient('.length, -1).trim();
  } else {
    trace.action('parseGradient:fail', { reason: 'unrecognized gradient type' });
    return null;
  }

  const result: GradientData = {
    type,
    repeating,
    direction: 180,
    centerX: 50,
    centerY: 50,
    radiusX: 50,
    radiusY: 50,
    radialShape: 'ellipse',
    radialSize: 'custom',
    angle: 0,
    stops: [],
  };

  // Split on commas, but respect parentheses (e.g. rgba(1,2,3,0.5))
  const parts = splitGradientParts(inner);
  if (parts.length < 2) {
    trace.action('parseGradient:fail', { reason: 'too few parts', parts: parts.length });
    return null;
  }

  let stopStartIdx = 0;

  if (type === 'linear') {
    // First part may be direction: "180deg" or "to right"
    const dirMatch = parts[0].match(/^\s*(-?[\d.]+)\s*deg\s*$/);
    const toMatch = parts[0].match(/^\s*to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?\s*$/);
    if (dirMatch) {
      result.direction = parseFloat(dirMatch[1]);
      stopStartIdx = 1;
    } else if (toMatch) {
      result.direction = toKeywordDeg(toMatch[1], toMatch[2]);
      stopStartIdx = 1;
    }
  } else if (type === 'radial') {
    // Parse radial shape, size, and center from first part
    const firstPart = parts[0].trim();

    // Detect shape: circle or ellipse
    if (firstPart.includes('circle')) result.radialShape = 'circle';
    else if (firstPart.includes('ellipse')) result.radialShape = 'ellipse';

    // Detect size keywords
    const sizeKeywords: RadialSize[] = ['closest-side', 'closest-corner', 'farthest-side', 'farthest-corner'];
    for (const kw of sizeKeywords) {
      if (firstPart.includes(kw)) { result.radialSize = kw; break; }
    }

    // Detect percentage/numeric radii: "46% 25% at ..." or "50px at ..."
    const sizeAtMatch = firstPart.match(/^\s*(-?[\d.]+)(%|px)?\s+(-?[\d.]+)(%|px)?\s+at\s+(-?[\d.]+)%?\s+(-?[\d.]+)%?/);
    const circleAtMatch = firstPart.match(/^\s*circle\s+(-?[\d.]+)(px)?\s+at\s+(-?[\d.]+)%?\s+(-?[\d.]+)%?/);
    const atMatch = firstPart.match(/at\s+(-?[\d.]+)%?\s+(-?[\d.]+)%?/);

    if (sizeAtMatch) {
      result.radiusX = parseFloat(sizeAtMatch[1]);
      result.radiusY = parseFloat(sizeAtMatch[3]);
      result.centerX = parseFloat(sizeAtMatch[5]);
      result.centerY = parseFloat(sizeAtMatch[6]);
      result.radialSize = 'custom';
      stopStartIdx = 1;
    } else if (circleAtMatch) {
      const r = parseFloat(circleAtMatch[1]);
      result.radiusX = r;
      result.radiusY = r;
      result.radialShape = 'circle';
      result.centerX = parseFloat(circleAtMatch[3]);
      result.centerY = parseFloat(circleAtMatch[4]);
      result.radialSize = 'custom';
      stopStartIdx = 1;
    } else if (atMatch) {
      result.centerX = parseFloat(atMatch[1]);
      result.centerY = parseFloat(atMatch[2]);
      stopStartIdx = 1;
    } else if (firstPart.includes('circle') || firstPart.includes('ellipse') || sizeKeywords.some(kw => firstPart.includes(kw))) {
      // Shape/size keyword without "at" — uses default center (50% 50%), skip this part for stops
      stopStartIdx = 1;
    }
  } else if (type === 'conic') {
    // First part: "from 90deg at 50% 50%" or "from 90deg"
    const fromMatch = parts[0].match(/from\s+(-?[\d.]+)\s*deg/);
    const atMatch = parts[0].match(/at\s+(-?[\d.]+)%?\s+(-?[\d.]+)%?/);
    if (fromMatch || atMatch) {
      if (fromMatch) result.angle = parseFloat(fromMatch[1]);
      if (atMatch) {
        result.centerX = parseFloat(atMatch[1]);
        result.centerY = parseFloat(atMatch[2]);
      }
      stopStartIdx = 1;
    }
  }

  // Parse color stops
  for (let i = stopStartIdx; i < parts.length; i++) {
    const stop = parseColorStop(parts[i].trim(), i - stopStartIdx);
    if (stop) result.stops.push(stop);
  }

  // Need at least 2 stops
  if (result.stops.length < 2) {
    trace.action('parseGradient:fail', { reason: 'fewer than 2 stops', count: result.stops.length });
    return null;
  }

  // Infer positions for stops without explicit values (-1 sentinel)
  // CSS distributes them evenly between the nearest defined positions (or 0%/100%)
  const stops = result.stops;
  if (stops[0].position === -1) stops[0].position = 0;
  if (stops[stops.length - 1].position === -1) stops[stops.length - 1].position = 100;
  // Fill gaps: find runs of -1 and distribute evenly
  let i = 0;
  while (i < stops.length) {
    if (stops[i].position !== -1) { i++; continue; }
    // Find the run of undefined positions
    const startIdx = i - 1; // last defined
    let endIdx = i;
    while (endIdx < stops.length && stops[endIdx].position === -1) endIdx++;
    // startIdx has a defined position, endIdx has a defined position (or is end)
    const startPos = stops[startIdx].position;
    const endPos = endIdx < stops.length ? stops[endIdx].position : 100;
    const count = endIdx - startIdx; // number of gaps
    for (let j = startIdx + 1; j < endIdx; j++) {
      stops[j].position = Math.round(startPos + ((endPos - startPos) * (j - startIdx)) / count);
    }
    i = endIdx;
  }

  trace.action('parseGradient:success', { type, stopCount: result.stops.length });
  return result;
}

/** Split gradient inner text on commas, respecting parentheses. */
const splitGradientParts = splitStyleProps;

/** Parse a single color stop like "#ff0000 50%" or "rgba(0,0,0,0.5) 25%" */
function parseColorStop(raw: string, index: number): GradientStop | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try to extract position from end: "... 50%"
  const posMatch = trimmed.match(/\s+(-?[\d.]+)%\s*$/);
  let color: string;
  let position: number;

  if (posMatch) {
    color = trimmed.slice(0, trimmed.length - posMatch[0].length).trim();
    position = parseFloat(posMatch[1]);
  } else {
    // No explicit position — will be inferred later
    color = trimmed;
    position = -1; // sentinel
  }

  return {
    id: `stop-${index}`,
    color,
    position,
  };
}

/** Convert "to top", "to right", "to bottom left" etc. to degrees */
function toKeywordDeg(first: string, second?: string): number {
  const keyword = second ? `${first} ${second}` : first;
  const map: Record<string, number> = {
    'top': 0, 'right': 90, 'bottom': 180, 'left': 270,
    'top right': 45, 'right top': 45,
    'bottom right': 135, 'right bottom': 135,
    'bottom left': 225, 'left bottom': 225,
    'top left': 315, 'left top': 315,
  };
  return map[keyword] ?? 180;
}

// ─── Format ──────────────────────────────────────────────────────────────────

/** Format GradientData back to a CSS gradient string. */
export function formatGradient(data: GradientData): string {
  trace.fn('formatGradient', { type: data.type, stopCount: data.stops.length, repeating: data.repeating });

  const prefix = data.repeating ? 'repeating-' : '';
  const stopsStr = data.stops
    .map(s => `${s.color} ${Math.round(s.position)}%`)
    .join(', ');

  switch (data.type) {
    case 'linear':
      return `${prefix}linear-gradient(${Math.round(data.direction)}deg, ${stopsStr})`;
    case 'radial': {
      // Build radial shape/size descriptor
      // CSS rules: circle takes length (px) or keyword, NOT percentage
      // ellipse takes two values (% or px) or keyword
      let sizeDesc: string;
      if (data.radialSize !== 'custom') {
        sizeDesc = `${data.radialShape} ${data.radialSize}`;
      } else if (data.radialShape === 'circle') {
        // Circle: just use keyword, size controlled by stops + center
        sizeDesc = 'circle';
      } else {
        // Ellipse: two percentage radii
        sizeDesc = `${Math.round(data.radiusX)}% ${Math.round(data.radiusY)}%`;
      }
      return `${prefix}radial-gradient(${sizeDesc} at ${Math.round(data.centerX)}% ${Math.round(data.centerY)}%, ${stopsStr})`;
    }
    case 'conic':
      return `${prefix}conic-gradient(from ${Math.round(data.angle)}deg at ${Math.round(data.centerX)}% ${Math.round(data.centerY)}%, ${stopsStr})`;
  }
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/** Create a default linear gradient from black to white, 180deg. */
export function createDefaultGradient(): GradientData {
  trace.action('createDefaultGradient');
  return {
    type: 'linear',
    repeating: false,
    direction: 180,
    centerX: 50,
    centerY: 50,
    radiusX: 50,
    radiusY: 50,
    radialShape: 'ellipse' as RadialShape,
    radialSize: 'custom' as RadialSize,
    angle: 0,
    stops: [
      { id: 'stop-0', color: '#000000', position: 0 },
      { id: 'stop-1', color: '#ffffff', position: 100 },
    ],
  };
}
