// read-handlers.ts — synchronous DOM read handlers for the sandbox API
// (rects, computed styles, hit-testing, bbox, element capture). Extracted
// verbatim from bridge-sandbox.ts (Phase 7 split).

import type { RectLike, ChildRect, CornersLike } from '../sandbox-api';
import { getScreenCorners } from '@/canvas/resize/geometry-utils';
import { toKebab } from '@/shared/css-utils';
import { findElByNodeId } from '../sandbox-dom-utils';
import { contentRoot } from './sandbox-state';
import { trace } from '@/shared/debug-trace';

export function getRect(nodeId: string, vpPrefix: string): (RectLike & { culled?: boolean }) | null {
    if (!contentRoot) return null;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // A CULLED element (or a child of one) measures 0×0 — its display:none
    // placeholder swap means the live rect can never agree with the host's
    // PROJECTED cache entry. Flag it so live-vs-cached verifiers (the stale
    // reveal gate) can trust the cache instead of waiting forever: offscreen
    // canvas nodes (slot-connected marquee cards) legitimately STAY culled.
    // Zero-size required: a stale data-culled attr on a VISIBLE node must
    // still measure live (mirror of measure.ts's rule).
    const culled = r.width === 0 && r.height === 0 && !!el.closest('[data-culled]');
    if (culled) trace.action('sandbox:getRect-culled', { nodeId, vpPrefix });
    return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.x, y: r.y, right: r.right, bottom: r.bottom, ...(culled ? { culled: true } : {}) };
}

export function getChildRects(parentId: string, vpPrefix: string): ChildRect[] {
    if (!contentRoot) return [];
    const parent = findElByNodeId(contentRoot, vpPrefix, parentId);
    if (!parent) return [];
    const results: ChildRect[] = [];
    for (const child of Array.from(parent.children)) {
      const id = (child as HTMLElement).getAttribute('data-id');
      if (id) {
        const r = (child as HTMLElement).getBoundingClientRect();
        results.push({ id, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
      }
    }
    return results;
}

export function getComputedValues(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    if (!contentRoot) return {};
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return {};
    const cs = getComputedStyle(el);
    const result: Record<string, string> = {};
    // Callers pass camelCase (`fontSize`) for ergonomics, but
    // CSSStyleDeclaration.getPropertyValue requires kebab-case
    // (`font-size`). Read via direct property access (which accepts
    // camelCase), and fall back to kebab via getPropertyValue.
    // Synthetic `__parentClient*` keys read from parentElement directly —
    // CSS has no equivalent property. Mirrored in the per-render emit
    // (see render() above) so the host's sync read from cache works.
    for (const p of props) {
      if (p === '__parentClientWidth') {
        result[p] = String(el.parentElement?.clientWidth ?? 0);
        continue;
      }
      if (p === '__parentClientHeight') {
        result[p] = String(el.parentElement?.clientHeight ?? 0);
        continue;
      }
      if (p === '__offsetWidth') {
        result[p] = String(el.offsetWidth);
        continue;
      }
      if (p === '__offsetHeight') {
        result[p] = String(el.offsetHeight);
        continue;
      }
      const direct = (cs as any)[p];
      if (typeof direct === 'string' && direct !== '') {
        result[p] = direct;
      } else {
        const kebab = toKebab(p);
        result[p] = cs.getPropertyValue(kebab);
      }
    }
    return result;
}

export function getContainerRect(): RectLike | null {
    if (!contentRoot) return null;
    const r = contentRoot.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.x, y: r.y, right: r.right, bottom: r.bottom };
}

export function getElementIdsAtPoint(x: number, y: number): string[] {
    const elements = document.elementsFromPoint(x, y);
    const ids: string[] = [];
    for (const el of elements) {
      const id = (el as HTMLElement).getAttribute('data-id');
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

export function getTransformedCorners(nodeId: string, vpPrefix: string): CornersLike | null {
    if (!contentRoot) return null;
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) return null;
    return getScreenCorners(el);
}

export function getBBox(nodeId: string, vpPrefix: string): { x: number; y: number; width: number; height: number } | null {
    if (!contentRoot) return null;
    const el = findElByNodeId<Element>(contentRoot, vpPrefix, nodeId);
    if (!el) return null;
    // Only SVGGraphicsElement implements getBBox. Duck-type the check
    // because `instanceof SVGGraphicsElement` isn't reliable across
    // realms (iframe and parent each have their own globals).
    if (typeof (el as any).getBBox !== 'function') return null;
    try {
      const b = (el as SVGGraphicsElement).getBBox();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    } catch {
      return null;
    }
}

  // ─── Timeline preview ──────────────────────────────────────────────────

/**
 * Capture options that make the export map 1:1 to the element's border box.
 *
 * `html-to-image` renders a standalone CLONE of the node, but the clone keeps
 * the node's own placement styles — an absolutely-positioned node with
 * `left: 18px; top: 15px` (or a margin / transform) renders SHIFTED inside the
 * capture canvas: whitespace on the top/left edges, content clipped off the
 * bottom/right (live find 2026-07-16: exporting the hero dashboard stage).
 * Neutralize the clone's placement and pin the canvas to the border box.
 */
export function buildCaptureNormalization(el: Element): {
    width?: number;
    height?: number;
    style: Record<string, string>;
  } {
    const style: Record<string, string> = {
      position: 'relative',
      left: '0px',
      top: '0px',
      right: 'auto',
      bottom: 'auto',
      margin: '0px',
      transform: 'none',
    };
    const he = el as HTMLElement;
    const width = typeof he.offsetWidth === 'number' && he.offsetWidth > 0 ? he.offsetWidth : undefined;
    const height = typeof he.offsetHeight === 'number' && he.offsetHeight > 0 ? he.offsetHeight : undefined;
    return { width, height, style };
}

export async function captureElement(
    nodeId: string,
    vpPrefix: string,
    opts: { format: 'png' | 'jpeg' | 'svg'; pixelRatio: number; backgroundColor?: string },
  ): Promise<string | null> {
    if (!contentRoot) return null;
    // The element lives in THIS (iframe) document — `html-to-image` runs
    // here so it can clone the real subtree + inline its fonts/images.
    // The parent frame's `document.querySelector` can't reach it at all.
    const el = findElByNodeId(contentRoot, vpPrefix, nodeId);
    if (!el) {
      trace.action('canvas-sandbox:captureElement:not-found', { nodeId, vpPrefix });
      return null;
    }
    try {
      const htmlToImage = await import('html-to-image');
      // `html-to-image` clones the node and renders the clone standalone,
      // so the canvas pan/zoom transform on `contentRoot` does NOT scale
      // the capture — it's always at the element's natural CSS size ×
      // pixelRatio. The normalization pins the canvas to the border box and
      // zeroes the clone's own placement so the pixels fill it exactly.
      const norm = buildCaptureNormalization(el);
      trace.action('canvas-sandbox:captureElement', { nodeId, vpPrefix, format: opts.format, width: norm.width, height: norm.height });
      const base = {
        pixelRatio: opts.pixelRatio,
        cacheBust: true,
        backgroundColor: opts.backgroundColor,
        width: norm.width,
        height: norm.height,
        style: norm.style as Partial<CSSStyleDeclaration>,
      };
      if (opts.format === 'svg') return await htmlToImage.toSvg(el, base);
      if (opts.format === 'jpeg') return await htmlToImage.toJpeg(el, { ...base, quality: 0.95 });
      return await htmlToImage.toPng(el, base);
    } catch (err) {
      trace.error('canvas-sandbox:captureElement-failed', err);
      return null;
    }
}
