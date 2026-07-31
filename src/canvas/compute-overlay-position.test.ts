// computeOverlayPosition — the single source of truth for relative-overlay
// placement, shared by the portal renderer (commit) and ResizeManager (live
// resize). These tests pin the geometry so live and final can never diverge.

import { describe, it, expect, beforeEach } from 'vitest';
import { computeOverlayPosition } from './renderer/overlay-portals';

const trigger = { left: 100, top: 100, right: 300, bottom: 150, width: 200, height: 50 };
const root = { left: 0, top: 0, width: 1440, height: 900 };
const base = { side: 'bottom', align: 'start', offsetX: 0, offsetY: 0, collision: 'none' as const };

describe('computeOverlayPosition', () => {
  it('bottom/start: top edge sits gap below trigger, left edges align', () => {
    const p = computeOverlayPosition(base, 200, 100, trigger, root, 1);
    expect(p).toEqual({ top: 158, left: 100 }); // trigger.bottom + 8
  });

  it('bottom/center: overlay centered on trigger center regardless of width', () => {
    const cfg = { ...base, align: 'center' };
    const narrow = computeOverlayPosition(cfg, 100, 100, trigger, root, 1);
    const wide = computeOverlayPosition(cfg, 300, 100, trigger, root, 1);
    // Centers identical: left + w/2 === trigger center (200)
    expect(narrow.left + 50).toBe(200);
    expect(wide.left + 150).toBe(200);
  });

  it('bottom/end: right edge pinned to trigger right regardless of width', () => {
    const cfg = { ...base, align: 'end' };
    const narrow = computeOverlayPosition(cfg, 100, 100, trigger, root, 1);
    const wide = computeOverlayPosition(cfg, 250, 100, trigger, root, 1);
    expect(narrow.left + 100).toBe(300);
    expect(wide.left + 250).toBe(300);
  });

  it('right/center: vertical centering on the trigger', () => {
    const cfg = { ...base, side: 'right', align: 'center' };
    const p = computeOverlayPosition(cfg, 100, 80, trigger, root, 1);
    expect(p.left).toBe(308); // trigger.right + 8
    expect(p.top + 40).toBe(125); // trigger v-center
  });

  it('applies offsets after side/align', () => {
    const p = computeOverlayPosition({ ...base, offsetX: 30, offsetY: -5 }, 200, 100, trigger, root, 1);
    expect(p).toEqual({ top: 153, left: 130 });
  });

  it('divides by canvas scale (screen rects → portal CSS px)', () => {
    const p = computeOverlayPosition(base, 200, 100, trigger, root, 2);
    expect(p).toEqual({ top: 83, left: 50 }); // (150/2)+8, 100/2
  });

  it('collision auto clamps into the root with padding', () => {
    const cfg = { ...base, align: 'end', offsetX: 5000, collision: 'auto' as const, collisionPadding: 20 };
    const p = computeOverlayPosition(cfg, 200, 100, trigger, root, 1);
    expect(p.left).toBe(1440 - 200 - 20);
  });

  it('collision none positions purely from config', () => {
    const cfg = { ...base, offsetX: 5000 };
    const p = computeOverlayPosition(cfg, 200, 100, trigger, root, 1);
    expect(p.left).toBe(5100);
  });
});

describe('computeOverlayPosition — trigger IS the root (design-component master root overlay)', () => {
  // When an overlay's trigger is the variant-root, the renderer passes the SAME
  // rect for trigger and root (rootEl is the trigger). It must still place the
  // overlay UNDER the root, centered — NOT at 0,0 (the old null-trigger bailout).
  const sq = { left: 0, top: 0, right: 418, bottom: 432, width: 418, height: 432 };
  const sqRoot = { left: 0, top: 0, width: 418, height: 432 };

  it('bottom/center with collision:none → centered, just below the root', () => {
    const p = computeOverlayPosition({ side: 'bottom', align: 'center', offsetX: 0, offsetY: 0, collision: 'none' }, 200, 100, sq, sqRoot, 1);
    expect(p.top).toBe(440);          // root.bottom (432) + gap (8)
    expect(p.left).toBe(109);         // centered: 418/2 - 200/2
    expect(p).not.toEqual({ top: 0, left: 0 });
  });

  it('bottom/center with collision:auto → clamped inside the artboard bottom (not 0,0)', () => {
    const p = computeOverlayPosition({ side: 'bottom', align: 'center', offsetX: 0, offsetY: 0 }, 200, 100, sq, sqRoot, 1);
    // clamped to rootH - h - pad = 432 - 100 - 20 = 312
    expect(p.top).toBe(312);
    expect(p.left).toBe(109);
  });
});

describe('computeOverlayPosition — clamp=false (design-component master, overflow over canvas)', () => {
  const sq = { left: 0, top: 0, right: 418, bottom: 432, width: 418, height: 432 };
  const sqRoot = { left: 0, top: 0, width: 418, height: 432 };

  it('collision:auto but clamp=false → overlay sits FULLY below the root (not clamped inside)', () => {
    // 7th positional arg `clamp=false` — a master artboard isn't a real viewport,
    // so the overlay overflows over the canvas exactly as on the live page.
    const p = computeOverlayPosition({ side: 'bottom', align: 'center', offsetX: 0, offsetY: 0 }, 200, 100, sq, sqRoot, 1, false);
    expect(p.top).toBe(440);   // root.bottom + gap — NOT clamped to 312
    expect(p.left).toBe(109);
  });

  it('clamp=true (page viewport) still clamps inside the frame', () => {
    const p = computeOverlayPosition({ side: 'bottom', align: 'center', offsetX: 0, offsetY: 0 }, 200, 100, sq, sqRoot, 1, true);
    expect(p.top).toBe(312);   // clamped: 432 - 100 - 20
  });
});

// ─── collectOverlayElsForRoot ───────────────────────────────────────────────
// A relative overlay is MOVED into the portal on the render that first sees it,
// so from the next render on it is no longer a descendant of the viewport root.
// The portal loop used to look only under the root, find nothing, and bail the
// whole viewport — so `positionOverlayInPortal` never ran again and the overlay
// kept its first placement. Reorder or drag its trigger and the overlay stayed
// behind until some unrelated structural render rebuilt it under the root ("I
// have to re-drag or re-render for it to calibrate"); a replica that never got a
// first placement just sat at its portal's origin, pinned to the top of the
// tile. Live find 2026-07-25.
import { collectOverlayElsForRoot } from './renderer/overlay-portals';

function el(tag: string, attrs: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

describe('collectOverlayElsForRoot', () => {
  it('returns overlays still under the viewport root', () => {
    const root = el('div', { 'data-node-id': 'root' });
    const ov = el('div', { 'data-node-id': 'ov1', 'data-overlay-node': 'true' });
    root.appendChild(ov);
    expect(collectOverlayElsForRoot(root, null)).toEqual([ov]);
  });

  it('ALSO returns overlays already living in the portal (the regression)', () => {
    const root = el('div', { 'data-node-id': 'root' });
    const portal = el('div', { 'data-overlay-portal': 'desktop' });
    const ov = el('div', { 'data-node-id': 'ov1', 'data-overlay-node': 'true' });
    portal.appendChild(ov); // moved out by an earlier render
    const got = collectOverlayElsForRoot(root, portal);
    expect(got).toEqual([ov]); // previously []: the caller bailed and never repositioned
  });

  it('de-duplicates by data-node-id, preferring the freshly-reconciled copy', () => {
    const root = el('div', { 'data-node-id': 'root' });
    const portal = el('div', { 'data-overlay-portal': 'desktop' });
    const fresh = el('div', { 'data-node-id': 'ov1', 'data-overlay-node': 'true' });
    const stale = el('div', { 'data-node-id': 'ov1', 'data-overlay-node': 'true' });
    root.appendChild(fresh);
    portal.appendChild(stale);
    const got = collectOverlayElsForRoot(root, portal);
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(fresh);
  });

  it('collects every viewport replica in the portal, not just the first', () => {
    const root = el('div', { 'data-node-id': 'tablet-root' });
    const portal = el('div', { 'data-overlay-portal': 'tablet' });
    const a = el('div', { 'data-node-id': 'tablet-ov1', 'data-overlay-node': 'true' });
    const b = el('div', { 'data-node-id': 'tablet-ov2', 'data-overlay-node': 'true' });
    portal.append(a, b);
    expect(collectOverlayElsForRoot(root, portal)).toEqual([a, b]);
  });

  it('empty when neither holds an overlay', () => {
    expect(collectOverlayElsForRoot(el('div', {}), el('div', {}))).toEqual([]);
  });
});

// ─── Replayable placement (gesture-end recalculation) ───────────────────────
// A layout drag (reorder / reparent) commits IMPERATIVELY and deliberately SKIPS
// the resulting re-render, so the Renderer's portal pass never runs on mouseup
// and a relative overlay kept the position it had when the gesture started
// ("the overlay stays stuck where I had it on mouse up"). The sandbox replays the
// last render's placement inputs at gesture end — same math, no render.
// Live find 2026-07-25.
import { rememberOverlayPlacements, replayOverlayPlacements } from './renderer/overlay-portals';

/** jsdom has no layout — stub the rects the placement math reads. */
function withRect(e: HTMLElement, r: { left: number; top: number; width: number; height: number }): HTMLElement {
  e.getBoundingClientRect = () => ({
    left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height,
    width: r.width, height: r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
  Object.defineProperty(e, 'offsetWidth', { get: () => r.width, configurable: true });
  Object.defineProperty(e, 'offsetHeight', { get: () => r.height, configurable: true });
  return e;
}

describe('replayOverlayPlacements', () => {
  let container: HTMLElement, root: HTMLElement, portal: HTMLElement, trigger: HTMLElement, overlay: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    root = withRect(el('div', { 'data-node-id': 'root', 'data-viewport': 'desktop' }), { left: 0, top: 0, width: 1440, height: 6000 });
    portal = el('div', { 'data-overlay-portal': 'desktop' });
    trigger = withRect(el('div', { 'data-node-id': 'btn' }), { left: 100, top: 500, width: 200, height: 100 });
    overlay = withRect(el('div', { 'data-node-id': 'ov1', 'data-overlay-node': 'true' }), { left: 0, top: 0, width: 200, height: 100 });
    root.appendChild(trigger);
    portal.appendChild(overlay); // already portaled by an earlier render
    container.append(root, portal);
    document.body.appendChild(container);
    rememberOverlayPlacements([{
      overlayNodeId: 'ov1', triggerNodeId: 'btn', rootNodeId: 'root',
      config: { side: 'bottom', align: 'start', offsetX: 0, offsetY: 10 }, clamp: true,
    }]);
  });

  it('re-derives the position from the trigger\'s CURRENT rect', () => {
    expect(replayOverlayPlacements(container)).toBe(1);
    // bottom + gap(8) + offsetY(10) = 500 + 100 + 18
    expect(overlay.style.top).toBe('618px');
    expect(overlay.style.left).toBe('100px');
  });

  it('follows the trigger after a reorder moved it (the stuck-overlay bug)', () => {
    replayOverlayPlacements(container);
    const before = overlay.style.top;
    withRect(trigger, { left: 100, top: 2000, width: 200, height: 100 }); // reordered down
    expect(replayOverlayPlacements(container)).toBe(1);
    expect(overlay.style.top).not.toBe(before);
    expect(overlay.style.top).toBe('2118px');
  });

  it('skips an entry whose overlay is gone, without throwing', () => {
    overlay.remove();
    expect(replayOverlayPlacements(container)).toBe(0);
  });

  it('skips an entry whose root is gone', () => {
    root.remove();
    expect(replayOverlayPlacements(container)).toBe(0);
  });

  it('an empty remember() clears the cache (last overlay deleted)', () => {
    rememberOverlayPlacements([]);
    expect(replayOverlayPlacements(container)).toBe(0);
  });

  it('treats an empty triggerNodeId as "the root IS the trigger"', () => {
    rememberOverlayPlacements([{
      overlayNodeId: 'ov1', triggerNodeId: '', rootNodeId: 'root',
      config: { side: 'bottom', align: 'start', offsetX: 0, offsetY: 0 }, clamp: false,
    }]);
    expect(replayOverlayPlacements(container)).toBe(1);
    expect(overlay.style.top).toBe('6008px'); // root bottom + gap, unclamped
  });
});

// ─── classifyPortalChild ────────────────────────────────────────────────────
// Dragging an overlay's trigger out of a viewport extracts BOTH to `canvasNodes`,
// where `patchCanvasNodes` builds a fresh element at the content root and
// `positionCanvasNodeOverlays` places it under the trigger. The stale-cleanup only
// asked "is it still an overlay?" — which stays true — so the viewport PORTAL copy
// survived and the page ended up with TWO elements sharing one `data-id`: the
// stranded one that appears to "stay in the viewport", and the canvas one under the
// dragged node. That pair is the DOUBLE overlay. Live find 2026-07-25.
import { classifyPortalChild } from './renderer/overlay-portals';
import type { CanvasNode } from '@/code/parsing/parser';

function nodeMap(entries: Array<[string, Partial<CanvasNode>]>): Map<string, CanvasNode> {
  return new Map(entries.map(([id, n]) => [id, { id, tag: 'div', children: [], styles: {}, ...n } as CanvasNode]));
}
const OV_ATTR = { 'data-overlay': '{"type":"relative","triggerId":"btn","side":"bottom","align":"center"}' };

describe('classifyPortalChild', () => {
  it('keeps a child re-portaled by this render', () => {
    expect(classifyPortalChild('ov1', '', nodeMap([]), new Set(['ov1']))).toBe('keep-active');
  });

  it('keeps a live overlay the render skipped (subtree patch-skip)', () => {
    const nodes = nodeMap([['ov1', { attrs: OV_ATTR }]]);
    expect(classifyPortalChild('ov1', '', nodes, new Set())).toBe('keep-valid');
  });

  it('reaps a child whose source node is gone', () => {
    expect(classifyPortalChild('ov1', '', nodeMap([]), new Set())).toBe('reap-not-overlay');
  });

  it('reaps a child whose node no longer carries data-overlay', () => {
    const nodes = nodeMap([['ov1', { attrs: {} }]]);
    expect(classifyPortalChild('ov1', '', nodes, new Set())).toBe('reap-not-overlay');
  });

  it('reaps a node that became a CANVAS overlay (isCanvasNode)', () => {
    const nodes = nodeMap([['ov1', { attrs: OV_ATTR, isCanvasNode: true }]]);
    expect(classifyPortalChild('ov1', '', nodes, new Set())).toBe('reap-canvas-node');
  });

  it('reaps a node that became a CANVAS overlay (data-canvas-node attr)', () => {
    const nodes = nodeMap([['ov1', { attrs: { ...OV_ATTR, 'data-canvas-node': 'true' } }]]);
    expect(classifyPortalChild('ov1', '', nodes, new Set())).toBe('reap-canvas-node');
  });

  it('strips the viewport prefix before looking the source node up', () => {
    const nodes = nodeMap([['ov1', { attrs: OV_ATTR, isCanvasNode: true }]]);
    expect(classifyPortalChild('tablet-ov1', 'tablet-', nodes, new Set())).toBe('reap-canvas-node');
    // …and the same id without the prefix stripped would look like a missing node.
    expect(classifyPortalChild('tablet-ov1', '', nodes, new Set())).toBe('reap-not-overlay');
  });

  it('a canvas overlay is reaped even on the primary viewport (no prefix)', () => {
    const nodes = nodeMap([['overlay-frame-x-1', { attrs: { ...OV_ATTR, 'data-canvas-node': 'true' } }]]);
    expect(classifyPortalChild('overlay-frame-x-1', '', nodes, new Set())).toBe('reap-canvas-node');
  });
});

// ─── Canvas overlays exist exactly once ─────────────────────────────────────
// A canvas overlay has no viewport replicas and is never portaled, so any other
// element carrying its `data-id` is a leftover from when it lived in a viewport.
// Neither sweep catches those — `patchCanvasNodes` only scans DIRECT children of
// the container, the portal cleanup only sees its own children — so the leftover
// renders as the "ghost" twin beside the real, selectable one, and never moves
// (the positioning pass resolves a single element). Live find 2026-07-25.
import { positionCanvasNodeOverlays } from './renderer/overlay-portals';

describe('positionCanvasNodeOverlays — stray copy reaping', () => {
  const OV_CFG = '{"type":"relative","triggerId":"cv-trigger","side":"bottom","align":"start","offsetX":0,"offsetY":0}';

  function scene() {
    const container = document.createElement('div');
    const viewportRoot = el('div', { 'data-node-id': 'root', 'data-viewport': 'desktop' });
    const portal = el('div', { 'data-overlay-portal': 'desktop', 'data-viewport': 'desktop' });
    const trigger = el('div', { 'data-id': 'cv-trigger', 'data-node-id': 'cv-trigger', 'data-canvas-node': 'true' });
    const canvasCopy = el('div', { 'data-id': 'cv-ov', 'data-node-id': 'cv-ov', 'data-canvas-node': 'true' });
    container.append(viewportRoot, portal, trigger, canvasCopy);
    document.body.appendChild(container);
    const nodes = nodeMap([
      ['cv-trigger', { isCanvasNode: true, parentId: null, styles: { left: '100px', top: '200px', width: '80px', height: '40px' } }],
      ['cv-ov', { isCanvasNode: true, parentId: null, attrs: { 'data-overlay': OV_CFG }, styles: { left: '0px', top: '0px', width: '200px', height: '100px' } }],
    ]);
    return { container, viewportRoot, portal, canvasCopy, nodes };
  }

  it('removes a twin stranded in the overlay portal', () => {
    const s = scene();
    const ghost = el('div', { 'data-id': 'cv-ov', 'data-node-id': 'cv-ov' });
    s.portal.appendChild(ghost);
    positionCanvasNodeOverlays(s.container, [], s.nodes);
    expect(ghost.isConnected).toBe(false);
    expect(s.canvasCopy.isConnected).toBe(true); // the content-root copy survives
  });

  it('removes a twin stranded inside a viewport root', () => {
    const s = scene();
    const ghost = el('div', { 'data-id': 'cv-ov', 'data-node-id': 'cv-ov' });
    s.viewportRoot.appendChild(ghost);
    positionCanvasNodeOverlays(s.container, [], s.nodes);
    expect(ghost.isConnected).toBe(false);
    expect(s.canvasCopy.isConnected).toBe(true);
  });

  it('removes a prefixed replica twin (canvas overlays have no replicas)', () => {
    const s = scene();
    const ghost = el('div', { 'data-id': 'cv-ov', 'data-node-id': 'tablet-cv-ov' });
    s.portal.appendChild(ghost);
    positionCanvasNodeOverlays(s.container, [], s.nodes);
    expect(ghost.isConnected).toBe(false);
    expect(s.canvasCopy.isConnected).toBe(true);
  });

  it('leaves a lone canvas overlay alone', () => {
    const s = scene();
    positionCanvasNodeOverlays(s.container, [], s.nodes);
    expect(s.canvasCopy.isConnected).toBe(true);
    expect(s.container.querySelectorAll('[data-id="cv-ov"]')).toHaveLength(1);
  });
});
