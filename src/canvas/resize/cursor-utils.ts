// cursor-utils.ts — Rotation-aware resize and rotate cursors.
//
// Native CSS cursors (ns-resize, nesw-resize, …) only come in 45° steps, so a rotated
// element needs a custom cursor that matches its actual angle. These are inline SVG data
// URIs rotated to `rotationDeg + the handle's base angle`.

import type { Direction } from './geometry-utils';

// ─── Base rotations per direction ──────────────────────────────────────────

const RESIZE_BASE_ROTATION: Record<Direction, number> = {
  top: 90,
  bottom: 90,
  left: 0,
  right: 0,
  topLeft: 45,
  topRight: -45,
  bottomLeft: -45,
  bottomRight: 45,
};

const ROTATE_BASE_ROTATION: Record<string, number> = {
  TL: -135,
  TR: -45,
  BR: 45,
  BL: 135,
};

// ─── Standard cursors (for unrotated elements) ─────────────────────────────

const STANDARD_CURSORS: Record<Direction, string> = {
  top: 'ns-resize',
  bottom: 'ns-resize',
  left: 'ew-resize',
  right: 'ew-resize',
  topLeft: 'nwse-resize',
  topRight: 'nesw-resize',
  bottomLeft: 'nesw-resize',
  bottomRight: 'nwse-resize',
};

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get a resize cursor for a given direction and element rotation.
 */
export function getResizeCursor(direction: Direction, rotationDeg: number): string {
  if (Math.abs(rotationDeg) < 5) return STANDARD_CURSORS[direction];
  const totalRotation = rotationDeg + RESIZE_BASE_ROTATION[direction];
  return makeResizeCursor(totalRotation);
}

/**
 * Get a rotation cursor for a given corner and element rotation.
 */
export function getRotateCursor(corner: string = 'TR', rotationDeg: number = 0): string {
  const baseRotation = ROTATE_BASE_ROTATION[corner] ?? -45;
  const totalRotation = rotationDeg + baseRotation;
  return makeRotateCursor(totalRotation);
}

/** Double-headed arrow: shaft with a triangular head at each end. */
const RESIZE_ARROW = 'M4 12 L8.5 7.5 V10.25 H15.5 V7.5 L20 12 L15.5 16.5 V13.75 H8.5 V16.5 Z';

/** A shallow ~150 degree arc with a tangential arrowhead at each end. Deliberately not a
 *  near-closed ring: at 24px a 250 degree band curls into itself and reads as a spiral rather
 *  than a rotation. Arcs are sampled to a polyline every 4 degrees — indistinguishable from a
 *  true arc at this size, and it avoids SVG arc-flag direction bugs in a band-with-heads
 *  outline. Radius is larger than the ring version so the arc stays long while curving less. */
const ROTATE_RING = 'M11.37 4.83 L15.48 2.94 L15.01 4.16 L15.56 4.39 L16.09 4.67 L16.61 4.98 L17.09 5.32 L17.56 5.7 L17.99 6.11 L18.4 6.55 L18.77 7.02 L19.1 7.52 L19.41 8.03 L19.67 8.57 L19.89 9.13 L20.08 9.7 L20.22 10.28 L20.32 10.87 L20.38 11.46 L20.4 12.06 L20.37 12.66 L20.31 13.25 L20.2 13.84 L20.04 14.42 L19.85 14.99 L19.62 15.54 L19.35 16.07 L20.48 16.7 L16.13 17.9 L16.11 14.28 L17.25 14.91 L17.44 14.53 L17.61 14.13 L17.75 13.73 L17.85 13.32 L17.93 12.9 L17.98 12.47 L18.0 12.04 L17.99 11.62 L17.95 11.19 L17.87 10.77 L17.77 10.35 L17.64 9.95 L17.48 9.55 L17.29 9.17 L17.07 8.8 L16.83 8.45 L16.57 8.11 L16.28 7.79 L15.97 7.5 L15.64 7.23 L15.29 6.98 L14.92 6.76 L14.54 6.57 L14.15 6.4 L13.68 7.61 Z';

// ─── SVG cursor generators ──────────────────────────────────────────────────
//
// ORIGINAL artwork — drawn on a 24×24 grid with whole/half coordinates and a plain CSS
// drop-shadow. Deliberately NOT traced from any other product: an inspected-and-copied
// cursor is still a copy of a copyrighted asset, DOM inspection grants no licence, and a
// public repo makes the path data trivially diffable. Simple geometry like this (an arrow,
// a ring with two heads) is also low enough in originality that no one can claim ours.
//
// Both share the same treatment so they read at 24px on any background: a white body with
// a dark outline, plus a soft shadow. Hotspot is the centre, 12 12.

/** Black body with a white outline + soft shadow — the standard cursor treatment, legible
 *  on light and dark canvases alike. `paint-order='stroke'` puts the white halo BEHIND the
 *  fill so it reads as an outline instead of eating half the glyph's width. */
const CURSOR_PAINT = "fill='%23000' stroke='%23fff' stroke-width='1.5' stroke-linejoin='round' paint-order='stroke'";
const CURSOR_SHADOW = "<filter id='s' x='-50%25' y='-50%25' width='200%25' height='200%25'>"
  + "<feDropShadow dx='0' dy='0.5' stdDeviation='0.6' flood-color='%23000' flood-opacity='0.35'/></filter>";

function cursorSvg(path: string, totalRotation: number): string {
  return `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>`
    + `<defs>${CURSOR_SHADOW}</defs>`
    + `<g filter='url(%23s)' transform='rotate(${totalRotation} 12 12)'>`
    + `<path d='${path}' ${CURSOR_PAINT}/></g></svg>`;
}

/** Double-headed arrow, pointing along the resize axis. */
function makeResizeCursor(totalRotation: number): string {
  return `url("data:image/svg+xml,${cursorSvg(RESIZE_ARROW, totalRotation)}") 12 12, auto`;
}

/** Open ring with a head at each end — the standard rotate affordance. */
function makeRotateCursor(totalRotation: number): string {
  return `url("data:image/svg+xml,${cursorSvg(ROTATE_RING, totalRotation)}") 12 12, auto`;
}
