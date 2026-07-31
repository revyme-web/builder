// overlay-portals.ts — overlay position math (the single source of truth for
// where a relative overlay sits) + portal / canvas-node overlay placement.
// Extracted verbatim from Renderer.ts (Phase 7 split).

import type { CanvasNode } from '@/code/parsing/parser';
import { trace } from '@/shared/debug-trace';

/**
 * Position an overlay element relative to its trigger in the same viewport.
 * Reads trigger position via getBoundingClientRect, converts to root-relative coords.
 * Accepts config object, triggerEl, and rootEl directly (overlay may already be in portal).
 */
/** Pure overlay-position math — the SINGLE source of truth for where a
 *  relative overlay sits. Inputs are SCREEN-space rects (trigger + viewport
 *  root) plus the canvas scale; output is the overlay's left/top in the
 *  portal's CSS px. Used by the portal renderer AND by ResizeManager's live
 *  resize, so the mid-drag position can never drift from the committed one. */
export function computeOverlayPosition(
  config: { side?: string; align?: string; offsetX?: number; offsetY?: number; collision?: string; collisionPadding?: number },
  w: number,
  h: number,
  triggerRect: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  rootRect: { left: number; top: number; width: number; height: number },
  scale: number,
  clamp: boolean = true,
): { top: number; left: number } {
  const gap = 8;
  const ox = config.offsetX || 0;
  const oy = config.offsetY || 0;

  let top: number, left: number;
  switch (config.side || 'bottom') {
    case 'top':
      top = (triggerRect.top - rootRect.top) / scale - h - gap + oy;
      left = (triggerRect.left - rootRect.left) / scale + ox;
      break;
    case 'left':
      top = (triggerRect.top - rootRect.top) / scale + oy;
      left = (triggerRect.left - rootRect.left) / scale - w - gap + ox;
      break;
    case 'right':
      top = (triggerRect.top - rootRect.top) / scale + oy;
      left = (triggerRect.right - rootRect.left) / scale + gap + ox;
      break;
    case 'bottom': default:
      top = (triggerRect.bottom - rootRect.top) / scale + gap + oy;
      left = (triggerRect.left - rootRect.left) / scale + ox;
      break;
  }

  // Alignment — horizontal for top/bottom sides, vertical for left/right.
  if (config.side === 'top' || config.side === 'bottom' || !config.side) {
    if (config.align === 'center') left = (triggerRect.left - rootRect.left + triggerRect.width / 2) / scale - w / 2 + ox;
    else if (config.align === 'end') left = (triggerRect.right - rootRect.left) / scale - w + ox;
  } else {
    if (config.align === 'center') top = (triggerRect.top - rootRect.top + triggerRect.height / 2) / scale - h / 2 + oy;
    else if (config.align === 'end') top = (triggerRect.bottom - rootRect.top) / scale - h + oy;
  }

  // Collision — clamp into the viewport frame (the artboard stands in for the
  // browser window on canvas) with `collisionPadding` px of breathing room.
  // Mirrors the generated runtime's window-clamp (see overlay-gen.ts).
  // SKIPPED for design-component MASTERS (`clamp = false`): a master artboard is an
  // editing surface, NOT a real viewport — on the live page the component sits
  // somewhere and the overlay overflows freely under it, so clamping it inside the
  // variant tile here would misrepresent the live result. Clamp only models the
  // PAGE viewport (where the overlay really would be clamped to the window).
  if (clamp && config.collision !== 'none') {
    const pad = config.collisionPadding ?? 20;
    const rootW = rootRect.width / scale;
    const rootH = rootRect.height / scale;
    left = Math.min(Math.max(left, pad), Math.max(pad, rootW - w - pad));
    top = Math.min(Math.max(top, pad), Math.max(pad, rootH - h - pad));
  }

  return { top, left };
}

// ─── Replayable placement ───────────────────────────────────────────────────
// A layout drag (reorder / reparent) commits IMPERATIVELY and deliberately SKIPS
// the resulting re-render — the strategies already patched the DOM, so the
// Renderer's portal pass never runs on mouseup and a relative overlay keeps the
// position it had when the gesture started ("the overlay stays stuck where I had
// it on mouse up"). Recording each render's placement inputs lets the sandbox
// replay the SAME math at gesture end without a render, so there is exactly one
// source of truth for where an overlay sits. Live find 2026-07-25.

export interface OverlayPlacement {
  /** Prefixed `data-node-id` of the overlay element. */
  overlayNodeId: string;
  /** Prefixed `data-node-id` of the trigger; `''` when the trigger IS the root. */
  triggerNodeId: string;
  /** Prefixed `data-node-id` of the viewport root the overlay positions against. */
  rootNodeId: string;
  /** Already viewport-resolved (base + per-replica overrides). */
  config: { side?: string; align?: string; offsetX?: number; offsetY?: number; collision?: string; collisionPadding?: number };
  clamp: boolean;
}

let _placements: OverlayPlacement[] = [];

/** Called at the end of every render's portal pass with the placements it just
 *  performed. Ids (not element refs) so a later replay can't touch a detached
 *  element — everything is re-queried from the live DOM. */
export function rememberOverlayPlacements(list: OverlayPlacement[]): void {
  _placements = list;
}

/** Re-run the last render's placement math against the CURRENT DOM. Returns how
 *  many overlays were repositioned. Safe to call any time: entries whose overlay
 *  or root is gone are skipped, and `positionOverlayInPortal` itself no-ops on a
 *  missing/zero-rect trigger. */
export function replayOverlayPlacements(container: HTMLElement): number {
  let placed = 0;
  for (const p of _placements) {
    const el = container.querySelector<HTMLElement>(`[data-node-id="${p.overlayNodeId}"]`);
    if (!el?.isConnected) continue;
    const rootEl = container.querySelector<HTMLElement>(`[data-node-id="${p.rootNodeId}"]`);
    if (!rootEl) continue;
    const triggerEl = p.triggerNodeId
      ? rootEl.querySelector<HTMLElement>(`[data-node-id="${p.triggerNodeId}"]`)
      : rootEl;
    positionOverlayInPortal(el, p.config, triggerEl, rootEl, p.clamp);
    placed++;
  }
  return placed;
}

export type PortalChildVerdict =
  /** Re-portaled by THIS render — definitely live. */
  | 'keep-active'
  /** Not re-portaled (subtree patch-skip), but its source node is still a
   *  viewport overlay — the render just didn't rebuild it under the root. */
  | 'keep-valid'
  /** Source node is gone or no longer carries `data-overlay` (deleted / page switch). */
  | 'reap-not-overlay'
  /** Source node became a CANVAS node — the portal hosts viewport overlays only. */
  | 'reap-canvas-node';

/**
 * Should a child sitting in a viewport's overlay portal survive this render?
 *
 * `reap-canvas-node` is the case that was missing. Dragging an overlay's trigger
 * out of the viewport extracts BOTH to `canvasNodes`, where `patchCanvasNodes`
 * builds a fresh element at the content root and `positionCanvasNodeOverlays`
 * places it under the trigger. The old check only asked "is it still an overlay?"
 * — which stays true — so the viewport portal copy was kept and the page ended up
 * with TWO elements sharing one `data-id`: the stranded one that appears to "stay
 * in the viewport" after the drag-out, and the canvas one under the dragged node.
 * That pair is the DOUBLE overlay. Live find 2026-07-25.
 *
 * `keep-valid` must stay permissive for the opposite reason: a same-model
 * forceRender skips the root subtree, so `activeOverlayIds` is empty even though
 * the overlay is perfectly live — reaping on that alone made the overlay vanish
 * the moment you entered overlay mode (live find 2026-07-24).
 */
export function classifyPortalChild(
  childNodeId: string | null,
  vpPrefix: string,
  nodes: Map<string, CanvasNode>,
  activeOverlayIds: ReadonlySet<string>,
): PortalChildVerdict {
  if (childNodeId && activeOverlayIds.has(childNodeId)) return 'keep-active';
  const srcId = childNodeId && vpPrefix && childNodeId.startsWith(vpPrefix)
    ? childNodeId.slice(vpPrefix.length)
    : childNodeId;
  const srcNode = srcId ? nodes.get(srcId) : undefined;
  if (!srcNode?.attrs?.['data-overlay']) return 'reap-not-overlay';
  if (srcNode.isCanvasNode === true || srcNode.attrs?.['data-canvas-node'] === 'true') {
    return 'reap-canvas-node';
  }
  return 'keep-valid';
}

/**
 * The overlay elements to (re)place for one viewport root this render: the ones
 * the reconciler just rendered back under the root, PLUS the ones already living
 * in this viewport's portal from an earlier render. De-duplicated by
 * `data-node-id`, under-root copy winning (it's the freshly-reconciled one; the
 * caller removes the stale portal twin).
 *
 * The second half is the point. A relative overlay is MOVED into the portal on
 * the render that first sees it, so from the next render on it is no longer a
 * descendant of the viewport root — and the old `rootEl.querySelectorAll(…)`
 * came back empty and bailed the whole viewport. `positionOverlayInPortal` then
 * never ran again and the overlay kept whatever left/top it was given the first
 * time: reorder or drag its trigger and the overlay stayed behind until some
 * unrelated structural render happened to rebuild it under the root ("I have to
 * re-drag or re-render for it to calibrate"). A replica whose first placement
 * never landed a position at all just sat at its portal's origin — the tablet
 * overlay pinned to the top of the tile. Live find 2026-07-25.
 */
export function collectOverlayElsForRoot(
  rootEl: HTMLElement,
  portal: HTMLElement | null,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<string>();
  const push = (el: HTMLElement) => {
    const id = el.getAttribute('data-node-id') || '';
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    out.push(el);
  };
  for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>('[data-overlay-node]'))) push(el);
  if (portal) {
    for (const el of Array.from(portal.querySelectorAll<HTMLElement>('[data-overlay-node]'))) push(el);
  }
  return out;
}

export function positionOverlayInPortal(
  overlayEl: HTMLElement,
  config: { side?: string; align?: string; offsetX?: number; offsetY?: number; collision?: string; collisionPadding?: number },
  triggerEl: HTMLElement | null,
  rootEl: HTMLElement | null,
  clamp: boolean = true,
): void {
  if (!triggerEl || !rootEl) return;

  const triggerRect = triggerEl.getBoundingClientRect();
  const rootRect = rootEl.getBoundingClientRect();

  // Trigger HIDDEN in this viewport (display:none → zero rect): don't slam the
  // overlay to the artboard's 0,0 — hide it. Without this, hiding a replica
  // trigger (e.g. when it's detached to the canvas) flashes its overlay at the
  // viewport's top-left for a frame before the editing state catches up.
  // `visibility` (not `display`) so it still beats the overlay-mode show rule's
  // `display:block !important`. Self-heals: re-shown the moment the trigger is.
  if (triggerRect.width === 0 && triggerRect.height === 0) {
    overlayEl.style.visibility = 'hidden';
    return;
  }
  overlayEl.style.visibility = '';

  // Account for canvas scale (CSS px vs screen px)
  const scale = rootEl.offsetWidth > 0 ? rootRect.width / rootEl.offsetWidth : 1;
  const { top, left } = computeOverlayPosition(
    config,
    overlayEl.offsetWidth || 200,
    overlayEl.offsetHeight || 100,
    triggerRect,
    rootRect,
    scale,
    clamp,
  );

  overlayEl.style.position = 'absolute';
  overlayEl.style.top = `${Math.round(top)}px`;
  overlayEl.style.left = `${Math.round(left)}px`;
  overlayEl.style.zIndex = '50';
}

/**
 * Position canvas-node overlays relative to their (canvas-node) trigger.
 *
 * When a trigger is dragged out of a viewport, both it and its overlay become
 * free canvas nodes (see `extractOverlayToCanvasInCode`). To keep the reference
 * "overlay stays relative to the source" behavior, we recompute each such
 * overlay's left/top from its trigger's CANVAS position every render. Pure
 * canvas space — the canvas nodes' left/top are direct content-container px, so
 * we run `computeOverlayPosition` with the trigger's canvas rect, a zero-origin
 * root, scale 1, and collision OFF (the canvas has no viewport bounds).
 */
/** Resolve a CSS axis value (px OR `%`) to px. A percentage is taken against the
 *  parent's size on that axis (canvas children can carry `left:'37.8914%'`). */
function resolveAxisPx(val: string | undefined, parentSize: string | undefined): number {
  if (!val) return 0;
  const n = parseFloat(val) || 0;
  if (val.includes('%')) return (n / 100) * (parseFloat(parentSize || '0') || 0);
  return n;
}

/** Absolute content-container position of a CANVAS-ROOTED node — the node itself
 *  or any descendant of a top-level canvas node. Sums each ancestor's left/top up
 *  to the parentless canvas root, RESOLVING percentages against the parent's
 *  size. For a DIRECT canvas node this is just its own left/top. Returns null if
 *  the chain doesn't terminate at a canvas root (e.g. a viewport node). */
function canvasRootedAbsolutePos(
  nodeId: string,
  nodes: Map<string, CanvasNode>,
): { left: number; top: number; width: number; height: number } | null {
  const self = nodes.get(nodeId);
  if (!self) return null;
  const width = parseFloat(self.styles?.width || '0') || 0;
  const height = parseFloat(self.styles?.height || '0') || 0;
  let left = 0, top = 0;
  let cur: CanvasNode | undefined = self;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const par: CanvasNode | undefined = cur.parentId ? nodes.get(cur.parentId) : undefined;
    left += resolveAxisPx(cur.styles?.left, par?.styles?.width);
    top += resolveAxisPx(cur.styles?.top, par?.styles?.height);
    if (!cur.parentId) return cur.isCanvasNode ? { left, top, width, height } : null;
    cur = par;
  }
  return null;
}

export function positionCanvasNodeOverlays(
  container: HTMLElement,
  canvasRoots: CanvasNode[],
  nodes: Map<string, CanvasNode>,
): void {
  // STYLE-BASED — canvas nodes' left/top ARE content-container px, so run
  // `computeOverlayPosition` with the trigger's CANVAS position, zero-origin,
  // scale 1, collision OFF. (Rect-based off `offsetParent` was tried and flung
  // direct overlays away — the render context's offset-parent/scale wasn't the
  // content container.) `canvasRootedAbsolutePos` resolves percentage/nested
  // trigger positions; SIZES come from the rendered `offsetWidth/Height` (a
  // nested trigger may have no explicit width in `styles`, which read as 0 and
  // collapsed `align:center` to left-aligned).
  //
  // Iterate ALL nodes, not just top-level `canvasRoots`: when a canvas trigger
  // is dragged INTO a canvas FRAME, its overlay rides along and becomes a NESTED
  // canvas node (a child of that frame, NOT a canvas root). The old root-only
  // loop skipped it, so it never got repositioned — it kept its stale
  // canvas-ROOT left/top, which the frame then interprets frame-relative →
  // off-screen, clipped by the frame's overflow:hidden → the overlay vanished.
  // We position EACH overlay in its OWN offset-parent's space: subtract the
  // overlay parent's absolute canvas position so a root overlay stays absolute
  // (parent offset 0,0) and a frame-nested overlay gets frame-LOCAL coords.
  for (const [, node] of nodes) {
    const attr = node.attrs?.['data-overlay'];
    if (!attr) continue;
    let cfg: { type?: string; triggerId?: string; side?: string; align?: string; offsetX?: number; offsetY?: number };
    try { cfg = JSON.parse(attr); } catch { continue; }
    if (cfg.type === 'fixed' || !cfg.triggerId) continue;
    // CANVAS-rooted overlays only — a live VIEWPORT overlay (in the page return)
    // is positioned by the portal, not here; `canvasRootedAbsolutePos` returns
    // null for it (its ancestor chain hits a non-canvas root).
    if (!canvasRootedAbsolutePos(node.id, nodes)) continue;
    const trig = canvasRootedAbsolutePos(cfg.triggerId, nodes);
    if (!trig) continue;
    // A CANVAS overlay must exist EXACTLY ONCE, at the content root. It has no
    // viewport replicas and is never portaled, so ANY other element carrying its
    // `data-id` is a leftover from when it still lived in a viewport — a copy
    // stranded in a viewport root or an overlay portal by the extraction that
    // moved it out. Neither sweep catches those: `patchCanvasNodes` only scans
    // DIRECT children of the container, and the portal's stale-cleanup only sees
    // its own children. The leftover renders as the "ghost" twin next to the real,
    // selectable one — and because the positioning below resolves a single element,
    // the ghost also never moves. Reap by invariant rather than chasing each
    // subsystem that can strand one. Live find 2026-07-25.
    const copies = Array.from(container.querySelectorAll<HTMLElement>(`[data-id="${node.id}"]`));
    // Survivor = the content-root copy: not inside a viewport artboard and not
    // inside an overlay portal (both carry `data-viewport`).
    const el = copies.find(c => !c.closest('[data-viewport]')) ?? copies[0] ?? null;
    if (!el) continue;
    if (copies.length > 1) {
      for (const c of copies) if (c !== el) c.remove();
      trace.action('overlay-portals:reap-stray-canvas-overlay-copies', {
        overlayId: node.id, removed: copies.length - 1,
      });
    }
    const triggerEl = container.querySelector(`[data-node-id="${cfg.triggerId}"]`) as HTMLElement | null;
    // Overlay's offset-parent origin in canvas-absolute space (0,0 at root).
    const parentAbs = node.parentId
      ? (canvasRootedAbsolutePos(node.parentId, nodes) ?? { left: 0, top: 0 })
      : { left: 0, top: 0 };
    const tl = trig.left - parentAbs.left;
    const tt = trig.top - parentAbs.top;
    const tw = triggerEl?.offsetWidth || trig.width;
    const th = triggerEl?.offsetHeight || trig.height;
    const ow = el.offsetWidth || parseFloat(node.styles?.width || '0') || 0;
    const oh = el.offsetHeight || parseFloat(node.styles?.height || '0') || 0;

    const pos = computeOverlayPosition(
      { ...cfg, collision: 'none' }, ow, oh,
      { left: tl, top: tt, width: tw, height: th, right: tl + tw, bottom: tt + th },
      { left: 0, top: 0, width: 1_000_000, height: 1_000_000 },
      1,
    );
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
  }
}
