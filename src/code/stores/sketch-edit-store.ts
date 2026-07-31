// sketch-edit-store.ts — Jotai atoms for freehand sketch edit mode.
// Mirrors `shape-edit-store.ts` (shape-edit lives in vertex-editing land,
// sketch-edit lives in brush-stroke land — different overlay, same lifecycle
// shape: an `<svg data-id="..." data-sketch="true">` wrapper is "entered"
// for drawing, leaves cleanly on Escape / outside-click / tool switch).
//
// One sketch wrapper open at a time: nested sketches don't make sense (a
// stroke goes IN the active wrapper), and the BottomToolbar's `'sketch'`
// tool mode + this atom together cover entry / exit / "I am drawing now".

import { atom } from 'jotai';

/**
 * `data-id` of the SVG sketch wrapper currently in drawing mode.
 * `null` = no sketch open; `'foo'` = the `<svg data-id="foo" data-sketch="true">`
 * wrapper is mounted on the canvas and the brush-stroke overlay is active.
 *
 * Set by `SketchCreator` when the user finishes the drag-to-create gesture
 * (immediate edit-mode entry, mirrors how a user expects to start drawing
 * the moment the canvas is sized). Set by `Canvas.tsx` on double-click of
 * an existing sketch wrapper to re-enter edit mode for further strokes.
 * Cleared by Escape, click on canvas background, or tool switch.
 */
export const sketchEditingIdAtom = atom<string | null>(null);

/**
 * Brush configuration applied to the next stroke. Lives at module level
 * because brush settings are global to the pencil tool, not per-sketch:
 * the user picks a size + color in a floating panel (future) and every
 * subsequent stroke uses those values until they change them. Strokes
 * are stored verbatim once committed (size baked into the SVG path
 * geometry, color into the `fill` attribute), so changing the brush
 * doesn't retroactively alter past strokes.
 *
 * Defaults match a "marker pen" feel — dark, medium thickness, smooth.
 * Tunable via the brush options panel (later).
 */
/** Easing preset names. Resolved to a `(t: number) => number` function
 *  by `easingByName()` at the getStroke call site. Mirrors the subset
 *  the perfect-freehand demo exposes — covers the curves users
 *  actually want without flooding the dropdown. */
export type EasingName =
  | 'linear'
  | 'easeInQuad' | 'easeOutQuad' | 'easeInOutQuad'
  | 'easeInCubic' | 'easeOutCubic' | 'easeInOutCubic'
  | 'easeInQuart' | 'easeOutQuart' | 'easeInOutQuart'
  | 'easeInSine' | 'easeOutSine' | 'easeInOutSine';

/** Resolve an easing preset name to a `(t) => number` function. Used
 *  when building the perfect-freehand options object. Falls back to
 *  `linear` for unknown names so the brush never breaks on a stale
 *  config value. */
function easingByName(name: EasingName): (t: number) => number {
  switch (name) {
    case 'linear': return t => t;
    case 'easeInQuad': return t => t * t;
    case 'easeOutQuad': return t => t * (2 - t);
    case 'easeInOutQuad': return t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    case 'easeInCubic': return t => t * t * t;
    case 'easeOutCubic': return t => (--t) * t * t + 1;
    case 'easeInOutCubic': return t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
    case 'easeInQuart': return t => t * t * t * t;
    case 'easeOutQuart': return t => 1 - (--t) * t * t * t;
    case 'easeInOutQuart': return t => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t;
    case 'easeInSine': return t => 1 - Math.cos((t * Math.PI) / 2);
    case 'easeOutSine': return t => Math.sin((t * Math.PI) / 2);
    case 'easeInOutSine': return t => -(Math.cos(Math.PI * t) - 1) / 2;
    default: return t => t;
  }
}

export interface BrushConfig {
  /** Brush size in canvas-space px. Maps to perfect-freehand's `size`. */
  size: number;
  /** Stroke fill color. Each finished stroke becomes a `<path fill="..." />`. */
  color: string;
  /** -1 to 1, how much pressure thins the stroke. 0 = uniform width. */
  thinning: number;
  /** 0–1, jitter reduction. Higher = smoother but laggier feel. */
  streamline: number;
  /** 0–1, point smoothing applied to the outline. */
  smoothing: number;
  /** Easing applied to the pressure→thickness curve (perfect-freehand's
   *  top-level `easing`). Picks the personality of the brush — easeOutCubic
   *  feels like a marker, linear like a uniform pen. */
  easing: EasingName;
  /** Distance over which the start of the stroke tapers from 0 to full
   *  width. 0 = no taper (square start). Maps to start.taper. */
  taperStart: number;
  /** Cap the start of the stroke (rounded). Maps to start.cap. */
  capStart: boolean;
  /** Easing for the start taper curve. Maps to start.easing. */
  easingStart: EasingName;
  /** Distance over which the end of the stroke tapers to 0. 0 = no taper. */
  taperEnd: number;
  /** Cap the end of the stroke. Maps to end.cap. */
  capEnd: boolean;
  /** Easing for the end taper curve. Maps to end.easing. */
  easingEnd: EasingName;
  /** Outline stroke color drawn AROUND the filled brush stroke.
   *  Maps to the `<path stroke="...">` attribute. Empty string = no
   *  outline (skip the stroke attr entirely so the SVG is minimal). */
  strokeColor: string;
  /** Outline stroke width in canvas-space px. 0 = no outline. Maps to
   *  `<path stroke-width="...">` and is only emitted when > 0. */
  strokeWidth: number;
}

const DEFAULT_BRUSH: BrushConfig = {
  size: 8,
  color: '#000000',
  thinning: 0.5,
  streamline: 0.5,
  smoothing: 0.5,
  // Defaults mirror the perfect-freehand demo "marker pen" preset —
  // easeOutCubic pressure curve + a soft end taper give the natural
  // graffiti / ink-pen look the user is asking for. capStart/capEnd
  // both true so endpoints render as rounded caps, not flat squares.
  easing: 'easeOutCubic',
  taperStart: 0,
  capStart: true,
  easingStart: 'linear',
  taperEnd: 0,
  capEnd: true,
  easingEnd: 'linear',
  strokeColor: '#000000',
  strokeWidth: 0,
};

/** Build the options object passed to `getStroke()`. Centralized so all
 *  call sites (live preview during creation, live preview during edit,
 *  committed stroke) feed perfect-freehand the same shape. `sizeOverride`
 *  lets the screen-space preview path pass a zoom-scaled size while
 *  canvas-space commit paths use the brush's native size — same brush
 *  config, different size domain. */
export function buildStrokeOptions(brush: BrushConfig, sizeOverride?: number) {
  return {
    size: sizeOverride ?? brush.size,
    thinning: brush.thinning,
    streamline: brush.streamline,
    smoothing: brush.smoothing,
    easing: easingByName(brush.easing),
    start: {
      cap: brush.capStart,
      taper: brush.taperStart,
      easing: easingByName(brush.easingStart),
    },
    end: {
      cap: brush.capEnd,
      taper: brush.taperEnd,
      easing: easingByName(brush.easingEnd),
    },
  };
}

export const brushConfigAtom = atom<BrushConfig>(DEFAULT_BRUSH);

// ─── Stroke input-point persistence ───────────────────────────────────────────
//
// Each `<path data-points="..." />` inside a sketch wrapper stores the raw
// pointer samples that produced its outline. We need them for two reasons:
//   1. Live re-sync — when the user drags the brush size slider during
//      sketch-edit mode, ALL existing strokes regenerate with the new
//      params (matching perfect-freehand demo's behaviour). That requires
//      the original points, not just the final `d` polygon.
//   2. Future export / undo of brush changes — the outline is lossy w.r.t.
//      the input curve, so persisting points keeps the stroke editable.
//
// Storage format is hand-tuned for compactness: space-separated triples
// `x,y,p` with 2-decimal precision. A 200-point stroke serializes to ~3 KB,
// well inside what's reasonable to live in source code attributes. Pressure
// defaults to 0.5 when missing (Apple Pencil emits real values; mice don't).

/** Serialize input points to a `data-points` attribute string. */
export function pointsToAttr(points: number[][]): string {
  return points.map(p => {
    const x = (p[0] ?? 0).toFixed(2);
    const y = (p[1] ?? 0).toFixed(2);
    const pr = (p[2] ?? 0.5).toFixed(2);
    return `${x},${y},${pr}`;
  }).join(' ');
}

/** Parse a `data-points` attribute string back into `[x, y, pressure][]`. */
export function pointsFromAttr(attr: string | undefined | null): number[][] {
  if (!attr) return [];
  return attr.split(/\s+/).filter(Boolean).map(s => {
    const parts = s.split(',');
    const x = parseFloat(parts[0]);
    const y = parseFloat(parts[1]);
    const pr = parts[2] != null ? parseFloat(parts[2]) : 0.5;
    return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(pr) ? pr : 0.5];
  });
}

/** Read a hyphenated SVG/HTML attribute from a parsed `node.attrs` map,
 *  accepting either its kebab (`data-points`) or camelCase
 *  (`dataPoints`) form. Babel's JSX round-trip and historical
 *  `replaceSvgInnerInCode` runs would occasionally flip hyphenated
 *  attributes to camelCase — stranding readers that only checked one
 *  form. Use this anywhere a sketch consumer needs to look up
 *  `data-points`, `data-sketch`, `stroke-width`, etc.
 *
 *  Single source of truth for the "kebab-or-camel" lookup pattern;
 *  previously duplicated inline in `sketch-live-sync.ts` and
 *  `SketchCreator.ts` autoFit. */
export function readSvgAttr(
  attrs: Record<string, string> | undefined,
  kebab: string,
): string | undefined {
  if (!attrs) return undefined;
  if (attrs[kebab] !== undefined) return attrs[kebab];
  // 'stroke-width' → 'strokeWidth', 'data-points' → 'dataPoints'
  const camel = kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return attrs[camel];
}
