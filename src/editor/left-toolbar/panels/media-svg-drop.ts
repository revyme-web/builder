// media-svg-drop.ts — an SVG in the Media panel drops as a NATIVE VECTOR, not
// as a picture.
//
// Uploads keep the .svg (the API passes SVG through untouched), but the panel
// dropped every image tile as a frame with the file as a `background-image`:
// a flat, cropped picture the shape editor can't touch (user report
// 2026-10-15). An SVG tile now inserts the vector itself, through the full
// import pass (svg-import.ts `convertSvgToDropVector`): transforms baked, the
// source's `<g>` structure as nested GROUPS, every leaf an editable path — the
// same tree the vector-set import builds, so the svg editor drills into it
// group by group.
//
// A drag starts synchronously, so the markup is fetched AHEAD: when the gallery
// lists an SVG, and seeded straight from the File on upload. R2 answers with
// `access-control-allow-origin: *`; the media proxy is the fallback.

import { convertSvgToDropVector, SVG_DROP_MAX_SIDE, SVG_DROP_MIN_SIDE } from '@/code/svg/svg-import';
import { stripActiveSvgContent } from '@/shared/svg-sanitize';
import { generateNodeId } from '@/shared/id-utils';
import { backend } from '@/backend';
import { trace } from '@/shared/debug-trace';
import type { ToolbarItem } from '@/canvas/drag/toolbar-item-config';

/** Is this media URL an SVG file? A `.svg` path (query/hash ignored) — or a
 *  `data:image/svg+xml` URL, which is what the no-cloud backend stores. */
export function isSvgMediaUrl(url: string): boolean {
  return /^data:image\/svg\+xml[;,]/i.test(url) || /\.svg$/i.test(url.split(/[?#]/)[0]);
}

const resolved = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

const looksLikeSvg = (text: string) => /<svg[\s>]/i.test(text);

/** The markup, if it has already arrived (null = fetched, but not an SVG). */
export function getPrefetchedSvgMarkup(url: string): string | null | undefined {
  return resolved.get(url);
}

/** Seed from bytes already in hand (the File just uploaded). */
export function seedSvgMarkup(url: string, markup: string): void {
  resolved.set(url, looksLikeSvg(markup) ? markup : null);
}

/** Fetch (once) and cache an SVG's markup. Never throws. */
export function prefetchSvgMarkup(url: string): Promise<string | null> {
  if (resolved.has(url)) return Promise.resolve(resolved.get(url) ?? null);
  const inflight = pending.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    let text: string | null = null;
    try {
      const res = await fetch(url);
      if (res.ok) text = await res.text();
    } catch { /* CORS / network — try the proxy */ }
    if (text === null) {
      try { text = await (await backend.fetchMediaBytes(url)).text(); } catch { /* give up */ }
    }
    const markup = text && looksLikeSvg(text) ? text : null;
    resolved.set(url, markup);
    pending.delete(url);
    trace.action('media-svg:prefetched', { url, ok: markup !== null, bytes: markup?.length ?? 0 });
    return markup;
  })();
  pending.set(url, p);
  return p;
}

/** Source box from the root tag: viewBox, else width/height. */
function sourceBox(markup: string): { viewBox: string; w: number; h: number } | null {
  const open = markup.match(/<svg\b([^>]*)>/i)?.[1] ?? '';
  const vb = open.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  const parts = (vb ?? '').trim().split(/[\s,]+/).map(Number);
  if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { viewBox: vb!.trim(), w: parts[2], h: parts[3] };
  const w = parseFloat(open.match(/(?:^|\s)width\s*=\s*["']([^"']+)["']/i)?.[1] ?? '');
  const h = parseFloat(open.match(/(?:^|\s)height\s*=\s*["']([^"']+)["']/i)?.[1] ?? '');
  return w > 0 && h > 0 ? { viewBox: `0 0 ${w} ${h}`, w, h } : null;
}

/**
 * The drag item for an SVG media tile. Preferred: the full vector pass —
 * shrink-wrapped root `<svg>` whose children are the nested groups/paths, ids
 * derived from the dropped root's. When the SVG holds what the shape model
 * can't express (gradients, masks, text, <use>, >60 shapes) it still drops as
 * an inline SVG: the drop pipeline's own decompose → 1:1 → verbatim chain
 * (layout-normalize.ts) takes the markup, active content stripped. Null only
 * when the markup isn't a usable SVG at all — the caller drops the picture.
 */
export function buildSvgMediaDragItem(
  url: string,
  markup: string,
  ghostSize: { width: number; height: number },
  name = 'Vector',
): ToolbarItem | null {
  const vector = convertSvgToDropVector(markup, name);
  if (vector) {
    trace.action('media-svg:drag-vector', { url, shapes: vector.shapeCount, groups: vector.groupCount });
    return {
      id: `media-svg:${url}`,
      elementType: 'svg',
      name,
      defaultStyles: { width: `${vector.box.w}px`, height: `${vector.box.h}px`, overflow: 'visible' },
      defaultAttrs: vector.attrs,
      children: (rootId) => vector.children(rootId ?? generateNodeId('svg')),
      ghostSize,
    };
  }
  const box = sourceBox(markup);
  if (!box) return null;
  const inner = stripActiveSvgContent(markup)
    .replace(/^[\s\S]*?<svg\b[^>]*>/i, '')
    .replace(/<\/svg>[\s\S]*$/i, '');
  if (!inner.trim()) return null;
  const longest = Math.max(box.w, box.h);
  const scale = Math.min(SVG_DROP_MAX_SIDE, Math.max(SVG_DROP_MIN_SIDE, longest)) / longest;
  trace.action('media-svg:drag-inline-fallback', { url });
  return {
    id: `media-svg:${url}`,
    elementType: 'svg',
    name,
    defaultStyles: {
      width: `${Math.round(box.w * scale)}px`,
      height: `${Math.round(box.h * scale)}px`,
      overflow: 'visible',
    },
    defaultAttrs: { viewBox: box.viewBox, xmlns: 'http://www.w3.org/2000/svg' },
    textContent: inner,
    ghostSize,
  };
}

/** Test-only. */
export function resetSvgMarkupCacheForTest(): void {
  resolved.clear();
  pending.clear();
}
