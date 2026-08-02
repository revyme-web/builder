// LayerPreview.tsx — the small visual swatch at the head of a layer row.
//
// Figma shows a rendered thumbnail for EVERY layer. It can afford to: it owns
// its renderer, so a thumbnail is just re-rasterising a node's bounds into a
// texture on a code path it already runs every frame.
//
// We can't. The document is real DOM inside a sandboxed iframe, so DOM→image
// means html-to-image: deep-clone the subtree, inline every computed style,
// embed every asset, rasterise. `preview-sandbox/capture-thumbnail.ts` documents
// what that costs — ONE full-page capture froze the preview's main thread for
// seconds, which is why it's gated to preview-open, version-changed, home-page-
// only. Per layer it would be that cost times the layer count, on the iframe the
// user is actively editing. Two more blockers on top: off-screen nodes carry
// `data-culled` and aren't in the DOM to rasterise at all, and every edit would
// invalidate the node's thumbnail plus all its ancestors'.
//
// So this derives a preview from the node's ALREADY-PARSED props instead. No
// rasterisation, no cache, no invalidation, no interaction with culling. It
// covers exactly the layers where a swatch adds information the row name can't:
// you can't tell one "Image" from another, but a text layer's name already IS
// its content.

import React from 'react';
import type { CanvasNode } from '@/code/parsing/parser';
import type { PresetToken } from '@/shared/types';
import { resolvePresetColor } from '@/shared/css-utils';

export type SvgPart = { tag: string; attrs: Record<string, string> };

export type LayerPreviewSpec =
  | { kind: 'image'; src: string; radius?: number | string }
  | { kind: 'paint'; css: string; radius?: number | string }
  | { kind: 'svg'; viewBox: string; parts: SvgPart[] };

/** Cosmetic rounding when the node declares no radius of its own. */
const DEFAULT_RADIUS = 3;

/**
 * Map a node's borderRadius onto the swatch, so a pill reads as a pill and a
 * circular avatar reads as a circle.
 *
 * The exact figure can't be computed from styles alone — `364px` means "circle"
 * on a 400px frame and "slightly rounded" on a 2000px one, and width/height are
 * often `auto` or a percentage. So: use the real ratio when the box is known in
 * px, and fall back to the shape of the value itself otherwise. Pill idioms
 * (50%, 999px) are unambiguous either way, which is the case that matters —
 * those are the ones you can actually see at 18px.
 */
function deriveRadius(styles: Record<string, string>, size: number): number | string | undefined {
  const raw = styles.borderRadius;
  if (raw == null || raw === '') return undefined;
  // Shorthand can carry up to four values; the first corner is representative
  // enough at this size.
  const first = raw.trim().split(/\s+/)[0];

  if (first.endsWith('%')) {
    const pct = parseFloat(first);
    return Number.isFinite(pct) ? `${Math.min(pct, 50)}%` : undefined;
  }

  const px = parseFloat(first);
  if (!Number.isFinite(px)) return undefined;
  if (px <= 0) return 0;

  const w = parseFloat(styles.width ?? '');
  const h = parseFloat(styles.height ?? '');
  const known = [w, h].filter((v) => Number.isFinite(v) && v > 0);
  if (known.length) {
    // Real proportion. Capped at half — beyond that a box is just fully round.
    return Math.min(px / Math.min(...known), 0.5) * size;
  }

  // Box unknown. A very large radius is the "pill" idiom regardless of size.
  if (px >= 100) return size / 2;
  // Otherwise treat the value as a corner on a nominal ~96px box, which is
  // where ordinary 4-24px radii land visibly but not absurdly.
  return Math.min((px / 96) * size, size / 2);
}

// An icon is a handful of shapes; anything past this is a traced illustration
// whose detail is invisible at 18px anyway. Bounds the work per row.
const MAX_SVG_PARTS = 80;

// Geometry + presentation attributes only. The parser also stores data-id and
// friends, which React would warn about or pass through pointlessly.
const SVG_ATTRS = new Set([
  'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'transform', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap',
  'strokeLinejoin', 'strokeDasharray', 'fillRule', 'clipRule', 'opacity',
  'fillOpacity', 'strokeOpacity', 'offset', 'stopColor', 'stopOpacity', 'gradientUnits',
]);

/**
 * Flatten an <svg> node's subtree into renderable parts.
 *
 * The parser keeps SVG shape children as real nodes with their attributes
 * intact, so the icon can be rebuilt from data already in memory — no
 * rasterisation, no capture. Groups are walked through rather than emitted:
 * a <g> only carries transforms, and re-nesting them would mean tracking
 * inherited state for no visible gain at this size.
 */
function collectSvgParts(
  node: CanvasNode,
  nodes: Map<string, CanvasNode>,
  tokens: PresetToken[],
): SvgPart[] {
  const parts: SvgPart[] = [];
  const walk = (ids: string[]) => {
    for (const id of ids) {
      if (parts.length >= MAX_SVG_PARTS) return;
      const child = nodes.get(id);
      if (!child) continue;
      if (child.type === 'g' || child.type === 'defs') { walk(child.children ?? []); continue; }
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(child.attrs ?? {})) {
        if (!SVG_ATTRS.has(k)) continue;
        // A colour PRESET is stored as `var(--color-primary)`, and those custom
        // properties only exist on the canvas iframe's root — in the parent
        // document the var resolves to nothing and the shape paints black.
        // Resolve through the token list so the swatch matches the canvas.
        attrs[k] = (k === 'fill' || k === 'stroke' || k === 'stopColor')
          ? resolvePresetColor(v, tokens)
          : v;
      }
      if (Object.keys(attrs).length) parts.push({ tag: child.type, attrs });
      walk(child.children ?? []);
    }
  };
  walk(node.children ?? []);
  return parts;
}

const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/i;

/** Background values that mean "nothing painted" — not worth a swatch. */
const EMPTY_PAINT = new Set(['', 'none', 'transparent', 'initial', 'inherit', 'unset', 'auto']);

function isEmptyPaint(v: string | undefined): boolean {
  if (!v) return true;
  const t = v.trim().toLowerCase();
  if (EMPTY_PAINT.has(t)) return true;
  // rgba(...,0) / hsla(...,0) — fully transparent, so it would render as a
  // blank box and read as a bug rather than as "no fill".
  return /^(rgba|hsla)\([^)]*[,/]\s*0(\.0+)?\s*\)$/.test(t);
}

/**
 * Derive a preview from a node's parsed props. Returns null when the node has
 * nothing visual to show — the caller falls back to the type glyph.
 *
 * Order matters: a node can carry several of these at once (an <img> with a
 * background colour behind it), and the most specific wins.
 */
export function deriveLayerPreview(
  node: CanvasNode,
  nodes?: Map<string, CanvasNode>,
  size = 18,
  tokens: PresetToken[] = [],
): LayerPreviewSpec | null {
  const attrs = node.attrs ?? {};
  const styles = node.styles ?? {};

  // 0. A real <svg> — render the actual icon rather than a generic glyph.
  if (node.type === 'svg' && nodes) {
    const parts = collectSvgParts(node, nodes, tokens);
    if (parts.length) {
      return { kind: 'svg', viewBox: attrs.viewBox || '0 0 24 24', parts };
    }
  }

  // Radius rides along with every painted preview: a circular avatar or a pill
  // button should read as one in the tree.
  const radius = deriveRadius(styles, size);

  // 1. A real image element — the case this feature exists for.
  if (node.type === 'img' && attrs.src) return { kind: 'image', src: attrs.src, radius };

  // 2. Video: the poster is the only frame available without decoding.
  if (node.type === 'video' && attrs.poster) return { kind: 'image', src: attrs.poster, radius };

  // 3. backgroundImage covers BOTH a url() fill and a gradient. A url() is
  //    shown as an image so it gets object-fit and lazy loading; a gradient is
  //    passed through as CSS, which renders it exactly with zero cost.
  const bgImage = styles.backgroundImage;
  if (bgImage && !isEmptyPaint(bgImage)) {
    const m = URL_RE.exec(bgImage);
    if (m?.[2]) return { kind: 'image', src: m[2], radius };
    if (/gradient\(/i.test(bgImage)) return { kind: 'paint', css: bgImage, radius };
  }

  // 4. Plain fill — resolved for the same preset reason as the SVG attrs above.
  const bgColor = resolvePresetColor(styles.backgroundColor ?? '', tokens);
  if (!isEmptyPaint(bgColor)) return { kind: 'paint', css: bgColor, radius };

  return null;
}

interface Props {
  spec: LayerPreviewSpec;
  size: number;
  /** Swap to the type glyph when an image fails to load. */
  onError?: () => void;
}

export default function LayerPreview({ spec, size, onError }: Props) {
  const frame: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: spec.kind === 'svg' ? 0 : (spec.radius ?? DEFAULT_RADIUS),
    overflow: 'hidden',
    flexShrink: 0,
    // A hairline keeps a white or near-panel fill from dissolving into the row.
    boxShadow: 'inset 0 0 0 1px var(--control-border)',
  };

  if (spec.kind === 'paint') return <div style={{ ...frame, background: spec.css }} />;

  if (spec.kind === 'svg') {
    return (
      <div style={{ ...frame, boxShadow: 'none' }}>
        <svg width={size} height={size} viewBox={spec.viewBox} style={{ display: 'block' }}>
          {spec.parts.map((part, i) => React.createElement(part.tag, { key: i, ...part.attrs }))}
        </svg>
      </div>
    );
  }

  return (
    <div style={frame}>
      <img
        src={spec.src}
        alt=""
        draggable={false}
        // The panel renders EVERY row (no virtualisation), so a deep tree would
        // otherwise fetch every image at once. Lazy defers to scroll position.
        loading="lazy"
        decoding="async"
        onError={onError}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    </div>
  );
}
