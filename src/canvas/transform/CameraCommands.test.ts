// CameraCommands.test.ts — getNodeBounds variant-tile scoping.
//
// Component-master variants are framer-motion states: every variant TILE
// shares the same root data-id, distinguished only by viewport prefix in the
// rect cache ('' desktop, 'variant-1-', 'variant-2-'). A bare-dataId selection
// therefore matches EVERY tile. "Fit Selection" must fit just the tile in the
// interacting viewport, not the union of all variants. These tests pin that.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import { interactingViewportIdAtom } from '@/code/stores/viewport-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';

// Controllable bridge: rectCache holds the keys (`vpPrefix:dataId`), getRect
// returns the matching rect. Tests populate both before calling getNodeBounds.
const rectCache = new Map<string, DOMRect>();
const rects = new Map<string, DOMRect>(); // `${vpPrefix}|${dataId}` → rect

vi.mock('@/canvas/canvas-bridge', () => ({
  getCanvasBridge: () => ({
    rectCache,
    getRect: (dataId: string, vpPrefix: string) => rects.get(`${vpPrefix}|${dataId}`) ?? null,
  }),
}));

// Identity transform / zero offset / pass-through screen→canvas so assertions
// can use the raw rects we feed in.
vi.mock('./TransformManager', () => ({
  transformManager: { getTransform: () => ({ x: 0, y: 0, scale: 1 }) },
}));
// The current page's node map — the yardstick the stale-cache guard uses.
const currentNodes = new Map<string, unknown>();
vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: () => currentNodes,
}));

vi.mock('@/canvas/drag/helpers/coords', () => ({
  getIframeOffset: () => ({ x: 0, y: 0 }),
  screenRectToCanvas: (r: { left: number; top: number; width: number; height: number }) =>
    ({ left: r.left, top: r.top, width: r.width, height: r.height }),
}));

import { getNodeBounds, getContentBounds } from './CameraCommands';

const ROOT = 'frame-root';

function rect(left: number, width: number): DOMRect {
  return { left, top: 0, width, height: 148, right: left + width, bottom: 148, x: left, y: 0, toJSON() {} } as DOMRect;
}

const COMPONENT = 'components/Tiles.tsx';

/** The component file whose `variantConfig` DECLARES the three tiles below.
 *  `interactingViewportIdAtom` clamps to a viewport that actually exists, so
 *  seeding rects alone is not enough — without the file the store would fall
 *  the id back to the primary and every variant assertion would read desktop. */
function seedVariantFile() {
  projectFS.writeFile(COMPONENT, `
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 1480, y: 0 },
  { name: 'variant-2', label: 'V2', x: 2288, y: 0 },
];
export default function Tiles() { return <div data-id="frame-root" /> }
`);
  const store = getDefaultStore();
  store.set(activeFilePathAtom, COMPONENT);
  store.set(projectVersionAtom, (v) => v + 1);
}

/** Three variant tiles sharing ROOT id: desktop@0(1440), variant-1@1480(768), variant-2@2288(375). */
function seedThreeVariants() {
  seedVariantFile();
  rectCache.clear();
  rects.clear();
  const tiles: Array<[string, number, number]> = [
    ['', 0, 1440],
    ['variant-1-', 1480, 768],
    ['variant-2-', 2288, 375],
  ];
  for (const [prefix, left, width] of tiles) {
    rectCache.set(`${prefix}:${ROOT}`, rect(left, width));
    rects.set(`${prefix}|${ROOT}`, rect(left, width));
  }
}

describe('getNodeBounds — variant-tile scoping', () => {
  beforeEach(() => {
    seedThreeVariants();
    getDefaultStore().set(interactingViewportIdAtom, 'desktop');
  });

  it('fits ONLY the desktop tile when interacting=desktop (bare root selection)', () => {
    getDefaultStore().set(interactingViewportIdAtom, 'desktop');
    expect(getNodeBounds(null as any, [ROOT])).toEqual({ minX: 0, minY: 0, maxX: 1440, maxY: 148 });
  });

  it('fits ONLY variant-1 when interacting=variant-1 — does NOT union the desktop tile', () => {
    // Regression: desktop prefix is '' so its fullKey collapses to the bare
    // dataId. A naive `wanted.has(fullKey)` pulled desktop into scope here,
    // unioning [0..2248] and fitting two tiles. Must be variant-1 alone.
    getDefaultStore().set(interactingViewportIdAtom, 'variant-1');
    expect(getNodeBounds(null as any, [ROOT])).toEqual({ minX: 1480, minY: 0, maxX: 2248, maxY: 148 });
  });

  it('fits ONLY variant-2 when interacting=variant-2', () => {
    getDefaultStore().set(interactingViewportIdAtom, 'variant-2');
    expect(getNodeBounds(null as any, [ROOT])).toEqual({ minX: 2288, minY: 0, maxX: 2663, maxY: 148 });
  });

  it('honors an explicitly-prefixed selection regardless of interacting viewport', () => {
    getDefaultStore().set(interactingViewportIdAtom, 'desktop');
    // Selecting the prefixed id targets variant-2's tile even though we're
    // "interacting" with desktop.
    expect(getNodeBounds(null as any, [`variant-2-${ROOT}`])).toEqual({ minX: 2288, minY: 0, maxX: 2663, maxY: 148 });
  });

  it('falls back to the union when the interacting viewport has no matching rect', () => {
    // Node is desktop-only but interacting is a viewport where it is absent.
    rectCache.clear();
    rects.clear();
    rectCache.set(`:${ROOT}`, rect(0, 1440));
    rects.set(`|${ROOT}`, rect(0, 1440));
    getDefaultStore().set(interactingViewportIdAtom, 'variant-9'); // no rect at this prefix
    expect(getNodeBounds(null as any, [ROOT])).toEqual({ minX: 0, minY: 0, maxX: 1440, maxY: 148 });
  });
});

// ─── getContentBounds — stale rect-cache guard ─────────────────────────────
//
// Reported (2026-07-26): create a new page (New Page / 404 / CMS Index / CMS
// Detail — all four call `fitAllOnNextRender`) while panned far down a long Home
// page, and the new page lands off-screen at 10% zoom; you have to pan to it by
// hand. The rect cache is only replaced wholesale by an `allRects` sweep, which
// the sandbox emits AFTER `revyme:render-complete` — so the first
// render-complete still holds the PREVIOUS page's rects. `fitAllNow` fit those
// and reported success, so the retry loop ("cache not ready — wait for the next
// render-complete") never got a chance to run.

describe('getContentBounds — ignores rects from the page we just left', () => {
  beforeEach(() => {
    rectCache.clear();
    rects.clear();
    currentNodes.clear();
  });

  function seed(dataId: string, left: number, width: number) {
    rectCache.set(`:${dataId}`, rect(left, width));
    rects.set(`|${dataId}`, rect(left, width));
  }

  it('returns null when EVERY cached rect belongs to the old page', () => {
    // The state right after a page switch: cache = old page, nodes = new page.
    seed('home-hero', 0, 1440);
    seed('home-footer', 0, 1440);
    currentNodes.set('detail-root', {});
    expect(getContentBounds(document.documentElement)).toBeNull();
  });

  it('fits ONLY the new page once its rects land', () => {
    seed('detail-root', 100, 900);
    currentNodes.set('detail-root', {});
    expect(getContentBounds(document.documentElement)).toEqual({
      minX: 100, minY: 0, maxX: 1000, maxY: 148,
    });
  });

  it('drops leftover old-page rects from a MIXED cache', () => {
    // A partial sweep: the new page measured, the old page's entries not yet
    // evicted. Including them would blow the bounds up and zoom way out.
    seed('detail-root', 100, 900);
    seed('home-hero', 50000, 1440);
    currentNodes.set('detail-root', {});
    expect(getContentBounds(document.documentElement)).toEqual({
      minX: 100, minY: 0, maxX: 1000, maxY: 148,
    });
  });

  it('returns null when the node map is empty (parse not landed yet)', () => {
    seed('anything', 0, 100);
    expect(getContentBounds(document.documentElement)).toBeNull();
  });

  it('returns null on an empty cache (unchanged behaviour)', () => {
    currentNodes.set('detail-root', {});
    expect(getContentBounds(document.documentElement)).toBeNull();
  });

  it('unions every viewport tile of the current page', () => {
    // Desktop + tablet replicas share the data-id under different prefixes —
    // both are live, so the fit must cover the pair.
    rectCache.set(`:root`, rect(0, 1440));
    rects.set(`|root`, rect(0, 1440));
    rectCache.set(`tablet-:root`, rect(1500, 768));
    rects.set(`tablet-|root`, rect(1500, 768));
    currentNodes.set('root', {});
    expect(getContentBounds(document.documentElement)).toEqual({
      minX: 0, minY: 0, maxX: 2268, maxY: 148,
    });
  });

  it('skips zero-size rects', () => {
    currentNodes.set('detail-root', {});
    currentNodes.set('collapsed', {});
    seed('detail-root', 100, 900);
    rectCache.set(`:collapsed`, rect(0, 0));
    rects.set(`|collapsed`, { ...rect(0, 0), width: 0, height: 0 } as DOMRect);
    expect(getContentBounds(document.documentElement)).toEqual({
      minX: 100, minY: 0, maxX: 1000, maxY: 148,
    });
  });
});
