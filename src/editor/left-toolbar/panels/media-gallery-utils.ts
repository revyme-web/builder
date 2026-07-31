// media-gallery-utils.ts — pure helpers for the Media panel's delete +
// shift-sweep multi-select. Extracted from MediaGalleryPanel so the
// geometry/derivation logic is unit-testable without DOM plumbing.

import { trace } from '@/shared/debug-trace';

/** A tile's rect in the scroll container's CONTENT coordinate space
 *  (i.e. already offset by scrollTop/scrollLeft — stable while scrolling). */
export interface TileRect {
  key: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The R2 object key for an upload row — what the DELETE endpoint consumes.
 * The list endpoint returns `key` directly; rows appended right after an
 * upload only carry `url` (`${R2_PUBLIC_URL}/${key}`), so fall back to the
 * URL pathname. Null for non-http rows (standalone blob: URLs — undeletable).
 */
export function deriveUploadKey(item: { url: string; key?: string }): string | null {
  if (item.key) return item.key;
  try {
    const u = new URL(item.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const key = u.pathname.replace(/^\/+/, '');
    return key || null;
  } catch {
    return null;
  }
}

/**
 * Keys of every tile whose rect intersects the sweep rectangle spanned by
 * content-space points `a` (anchor) and `b` (current). Plain AABB overlap —
 * the sweep is a marquee over the 2-column grid.
 */
export function keysInSweep(
  tiles: TileRect[],
  a: { x: number; y: number },
  b: { x: number; y: number },
): string[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const hit = tiles
    .filter((t) => t.left < right && t.right > left && t.top < bottom && t.bottom > top)
    .map((t) => t.key);
  trace.action('media-sweep:hit-test', { tiles: tiles.length, hit: hit.length });
  return hit;
}

/**
 * Auto-scroll velocity for a sweep drag: px/frame to scroll when the pointer
 * sits within `edge` px of the container's top/bottom (negative = up). Speed
 * ramps linearly the closer to (or past) the edge the pointer is, capped at
 * `maxStep` — the "drag near the edge and it keeps scrolling" behavior.
 */
export function sweepAutoScrollStep(
  clientY: number,
  containerTop: number,
  containerBottom: number,
  edge = 32,
  maxStep = 18,
): number {
  if (clientY < containerTop + edge) {
    const over = containerTop + edge - clientY;
    return -Math.min(maxStep, Math.ceil((over / edge) * maxStep));
  }
  if (clientY > containerBottom - edge) {
    const over = clientY - (containerBottom - edge);
    return Math.min(maxStep, Math.ceil((over / edge) * maxStep));
  }
  return 0;
}

/** The delete-confirmation copy: single asset vs bulk. */
export function deleteConfirmMessage(count: number, noun: 'image' | 'video'): string {
  return count > 1
    ? `This will delete ${count} ${noun}s from the website. Continue?`
    : 'This will delete this asset from the website. Continue?';
}
