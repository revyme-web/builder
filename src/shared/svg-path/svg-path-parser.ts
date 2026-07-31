// svg-path-parser.ts — SVG path `d` attribute tokenizer.
// Ported from Yqnn/svg-path-editor (Apache 2.0).
// Parses a path string into structured command arrays.

import { trace } from '@/shared/debug-trace';

// ─── Regex tokens ─────────────────────────────────────────────────────────────

const kCommandTypeRegex = /^[\t\n\f\r ]*([MLHVZCSQTAmlhvzcsqta])[\t\n\f\r ]*/;
const kFlagRegex = /^[01]/;
const kNumberRegex = /^[+-]?(([0-9]*\.[0-9]+)|([0-9]+\.)|([0-9]+))([eE][+-]?[0-9]+)?/;
const kCommaWsp = /^(([\t\n\f\r ]+,?[\t\n\f\r ]*)|(,[\t\n\f\r ]*))/;

// ─── Grammar ──────────────────────────────────────────────────────────────────

// Each command letter maps to the sequence of regex patterns for one parameter set.
const kGrammar: Record<string, RegExp[]> = {
  M: [kNumberRegex, kNumberRegex],
  L: [kNumberRegex, kNumberRegex],
  H: [kNumberRegex],
  V: [kNumberRegex],
  Z: [],
  C: [kNumberRegex, kNumberRegex, kNumberRegex, kNumberRegex, kNumberRegex, kNumberRegex],
  S: [kNumberRegex, kNumberRegex, kNumberRegex, kNumberRegex],
  Q: [kNumberRegex, kNumberRegex, kNumberRegex, kNumberRegex],
  T: [kNumberRegex, kNumberRegex],
  A: [kNumberRegex, kNumberRegex, kNumberRegex, kFlagRegex, kFlagRegex, kNumberRegex, kNumberRegex],
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse one or more parameter sets for a command type starting at `cursor`.
 * Returns an array of commands (each is [letter, ...params]) and the new cursor position.
 */
function parseComponents(
  type: string,
  path: string,
  cursor: number,
): { commands: string[][]; cursor: number } {
  const grammar = kGrammar[type.toUpperCase()];
  const commands: string[][] = [];

  // Z has no params — emit one command and return.
  if (grammar.length === 0) {
    commands.push([type]);
    return { commands, cursor };
  }

  // Try to consume repeated parameter sets (e.g. `L 0,0 100,100` → two L commands).
  while (cursor <= path.length) {
    const params: string[] = [];
    let tempCursor = cursor;
    let success = true;

    for (let i = 0; i < grammar.length; i++) {
      // Before each param (except the first in the first set), consume optional comma/whitespace.
      if (i > 0 || commands.length > 0) {
        const wsMatch = kCommaWsp.exec(path.slice(tempCursor));
        if (wsMatch) {
          tempCursor += wsMatch[0].length;
        }
      }

      const paramMatch = grammar[i].exec(path.slice(tempCursor));
      if (!paramMatch) {
        success = false;
        break;
      }
      params.push(paramMatch[0]);
      tempCursor += paramMatch[0].length;
    }

    if (!success) break;

    // For M/m, after the first parameter set subsequent sets become implicit L/l.
    const cmdLetter = commands.length === 0
      ? type
      : type === 'M' ? 'L' : type === 'm' ? 'l' : type;

    commands.push([cmdLetter, ...params]);
    cursor = tempCursor;
  }

  return { commands, cursor };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an SVG path `d` attribute string into structured command arrays.
 *
 * Each inner array starts with the command letter followed by string parameter values.
 *
 * @example
 * parseSvgPath('M0,0 L100,100 Z')
 * // => [['M','0','0'], ['L','100','100'], ['Z']]
 */
export function parseSvgPath(d: string): string[][] {
  trace.fn('parseSvgPath', { d });

  const result: string[][] = [];
  let cursor = 0;

  // Skip leading whitespace.
  const leadingWs = /^[\t\n\f\r ]*/.exec(d);
  if (leadingWs) cursor += leadingWs[0].length;

  while (cursor < d.length) {
    const cmdMatch = kCommandTypeRegex.exec(d.slice(cursor));
    if (!cmdMatch) {
      trace.error('parseSvgPath', { message: 'unexpected character', cursor, char: d[cursor] });
      break;
    }

    const type = cmdMatch[1];
    cursor += cmdMatch[0].length;

    const { commands, cursor: newCursor } = parseComponents(type, d, cursor);
    cursor = newCursor;

    for (const cmd of commands) {
      result.push(cmd);
    }
  }

  trace.fn('parseSvgPath:result', { commandCount: result.length });
  return result;
}

// ─── Element → d conversion helpers ──────────────────────────────────────────

/** Convert any SVG shape element's attributes to a path d string. */
export function elementToD(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') return el.getAttribute('d') || '';
  if (tag === 'polygon') return polygonToD(el.getAttribute('points') || '');
  if (tag === 'polyline') return polylineToD(el.getAttribute('points') || '');
  if (tag === 'line') return lineToD(el);
  if (tag === 'rect') return rectToD(el);
  if (tag === 'circle') return circleToD(el);
  if (tag === 'ellipse') return ellipseToD(el);
  return '';
}

function polygonToD(points: string): string {
  const pts = points.trim().split(/[\s,]+/);
  if (pts.length < 4) return '';
  let d = `M${pts[0]},${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) {
    d += ` L${pts[i]},${pts[i + 1]}`;
  }
  return d + ' Z';
}

function polylineToD(points: string): string {
  const pts = points.trim().split(/[\s,]+/);
  if (pts.length < 4) return '';
  let d = `M${pts[0]},${pts[1]}`;
  for (let i = 2; i < pts.length; i += 2) {
    d += ` L${pts[i]},${pts[i + 1]}`;
  }
  return d;
}

function lineToD(el: Element): string {
  const x1 = el.getAttribute('x1') || '0';
  const y1 = el.getAttribute('y1') || '0';
  const x2 = el.getAttribute('x2') || '0';
  const y2 = el.getAttribute('y2') || '0';
  return `M${x1},${y1} L${x2},${y2}`;
}

function rectToD(el: Element): string {
  const x = parseFloat(el.getAttribute('x') || '0');
  const y = parseFloat(el.getAttribute('y') || '0');
  const w = parseFloat(el.getAttribute('width') || '0');
  const h = parseFloat(el.getAttribute('height') || '0');
  return `M${x},${y} L${x + w},${y} L${x + w},${y + h} L${x},${y + h} Z`;
}

function circleToD(el: Element): string {
  const cx = parseFloat(el.getAttribute('cx') || '0');
  const cy = parseFloat(el.getAttribute('cy') || '0');
  const r = parseFloat(el.getAttribute('r') || '0');
  // Approximate circle as 4 cubic bezier arcs
  const k = r * 0.5522847498; // magic number for circle approximation
  return `M${cx - r},${cy} C${cx - r},${cy - k} ${cx - k},${cy - r} ${cx},${cy - r} C${cx + k},${cy - r} ${cx + r},${cy - k} ${cx + r},${cy} C${cx + r},${cy + k} ${cx + k},${cy + r} ${cx},${cy + r} C${cx - k},${cy + r} ${cx - r},${cy + k} ${cx - r},${cy} Z`;
}

function ellipseToD(el: Element): string {
  const cx = parseFloat(el.getAttribute('cx') || '0');
  const cy = parseFloat(el.getAttribute('cy') || '0');
  const rx = parseFloat(el.getAttribute('rx') || '0');
  const ry = parseFloat(el.getAttribute('ry') || '0');
  const kx = rx * 0.5522847498;
  const ky = ry * 0.5522847498;
  return `M${cx - rx},${cy} C${cx - rx},${cy - ky} ${cx - kx},${cy - ry} ${cx},${cy - ry} C${cx + kx},${cy - ry} ${cx + rx},${cy - ky} ${cx + rx},${cy} C${cx + rx},${cy + ky} ${cx + kx},${cy + ry} ${cx},${cy + ry} C${cx - kx},${cy + ry} ${cx - rx},${cy + ky} ${cx - rx},${cy} Z`;
}

// ─── CSS `d` property (per-tile geometry overrides) ──────────────────────────
// A shape's BASE geometry stays the `d` ATTRIBUTE (`<path d="M…">`) so it always
// renders. A PER-TILE override (per variant / per viewport) is carried as the CSS
// `d` PROPERTY (`d: path("M…")`) so it rides the same variants-object / @media
// rails as width/height/rotation — see the per-tile shape-edit plan.

/** Wrap a raw path `d` string into a CSS `d` property value: `path("…")`.
 *  Empty in → empty out (so it round-trips a "no override" reset). */
export function pathDToCss(d: string): string {
  const clean = d.trim();
  return clean ? `path("${clean}")` : '';
}

/** Inverse of `pathDToCss`: pull the raw `d` out of a CSS `path("…")` value.
 *  Passes a bare `M…` d through unchanged. */
export function cssDToPath(value: string): string {
  const v = value.trim();
  const m = v.match(/^path\(\s*(['"])([\s\S]*?)\1\s*\)$/);
  return m ? m[2] : v;
}
