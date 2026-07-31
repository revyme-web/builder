// overlay-follow.ts — Keep open overlays glued to their trigger LIVE while the
// trigger is being dragged OR resized, across EVERY viewport, not just on
// mouse-up.
//
// The overlay is positioned from its trigger's rect (trigger + offset). On a
// full render `positionOverlayInPortal` recomputes that, but during an
// interaction the trigger is patched imperatively and the overlay would only
// catch up on the commit re-render.
//
// Mechanism: every `bridge.patchStyles` / `patchMultipleStyles` re-emits the
// patched element's fresh `rectUpdate` — for EACH viewport it's patched in (the
// drag/resize fan-out mirrors the trigger to all replicas). So the trigger's
// live rect (already including any snap or size change) is in `rectCache`
// ~1 frame later, in every viewport. We just re-read it each frame and re-run
// `computeOverlayPosition` per viewport — the SINGLE source of truth for overlay
// placement — so every tile's overlay tracks its own trigger, with the correct
// per-viewport resolved config. No snap/delta math needed: the cached rect
// already reflects where the (snapped/resized) trigger actually is.
//
// Follows ANY overlay whose `triggerId` is among the interacting nodes
// (repositioning a hidden overlay is a harmless no-op).

import { getDefaultStore } from 'jotai';
import type { NodeMap, OverlayConfig } from '@/shared/types';
import { findNodeRect, patchNodeStyles, isPrimaryViewport, getContentRootRect, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { computeOverlayPosition } from '@/canvas/renderer/overlay-portals';
import { resolveOverlayConfig } from '@/code/parsing/overlay-parser';
import { visibleViewportsAtom } from '@/code/stores/viewport-store';
import { nodesAtom } from '@/code/stores/store';
import { transformManager } from '@/canvas/transform';
import { trace } from '@/shared/debug-trace';

/** A top-level canvas node OR a descendant of one (e.g. a trigger nested inside
 *  a canvas frame). Mirrors the Renderer's same-named check. */
function isCanvasRooted(nodeId: string, nodes: NodeMap): boolean {
  let cur = nodes.get(nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    if (cur.isCanvasNode) return true;
    seen.add(cur.id);
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return false;
}

interface FollowVp {
  vpPrefix: string;
  vpId: string;
  config: OverlayConfig; // resolved for this viewport's width
}

interface FollowEntry {
  overlayId: string;
  triggerId: string;
  baseConfig: OverlayConfig; // raw (unresolved) config — used for the canvas-space follow
  rootId: string; // top-level ancestor of the trigger — the positioning origin
  perVp: FollowVp[];
}

/** Top-level (parentless) ancestor of `nodeId` — the overlay's positioning
 *  origin. A PAGE's is `root`; a COMPONENT's is its variant-root element id
 *  (e.g. `frame-xxx`), which is what the portal positions overlays against. */
function topLevelAncestor(nodeId: string, nodes: NodeMap): string {
  let cur = nodes.get(nodeId);
  const seen = new Set<string>();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = nodes.get(cur.parentId);
    if (!next) break;
    cur = next;
  }
  return cur?.id ?? nodeId;
}

let entries: FollowEntry[] = [];
let followContentEl: HTMLElement | null = null;

/** Begin following any open overlay whose trigger is in `triggerIds`. */
export function beginOverlayFollow(nodes: NodeMap, triggerIds: string[], contentEl: HTMLElement): void {
  entries = [];
  followContentEl = contentEl;
  // ACTIVE viewports — page viewports OR component VARIANTS (so a variant
  // overlay follows in every variant card, the variant=replica analog). Variants
  // report width 0 → resolveOverlayConfigForWidth falls back to the base config.
  const vps = getDefaultStore().get(visibleViewportsAtom);
  const triggerSet = new Set(triggerIds);

  for (const [id, node] of nodes) {
    const attr = node.attrs?.['data-overlay'];
    if (!attr) continue;
    let cfg: OverlayConfig;
    try { cfg = JSON.parse(attr); } catch { continue; }
    if (cfg.type === 'fixed') continue;
    if (!cfg.triggerId || !triggerSet.has(cfg.triggerId)) continue;

    // Both viewport AND canvas-node overlays are tracked. `updateOverlayFollow`
    // re-checks the LIVE trigger node each frame: while the trigger lives in a
    // viewport it uses the per-viewport path; the instant it becomes a canvas
    // node (already-canvas, or extracted mid-drag) it switches to the canvas-
    // space path — so the overlay never freezes (the old `continue` skip left
    // canvas overlays un-followed → "stuck until mouse-up").
    const perVp: FollowVp[] = vps.map(vp => ({
      vpPrefix: isPrimaryViewport(vp.id) ? '' : `${vp.id}-`,
      vpId: vp.id,
      config: resolveOverlayConfig(cfg, vp.id, vp.width ?? 0),
    }));
    entries.push({ overlayId: id, triggerId: cfg.triggerId, baseConfig: cfg, rootId: topLevelAncestor(cfg.triggerId, nodes), perVp });
  }

  if (entries.length) trace.action('overlay-follow:begin', { count: entries.length, triggerIds });
}

/**
 * Reposition every followed overlay in every viewport from its trigger's
 * current (cached, ~1-frame-fresh) rect. Safe to call on every drag/resize
 * move; a no-op when nothing is being followed.
 */
export function updateOverlayFollow(): void {
  if (!entries.length || !followContentEl) return;
  const scale = transformManager.getTransform().scale;
  const nodes = getDefaultStore().get(nodesAtom);
  for (const e of entries) {
    // Canvas-ROOTED → follow in CONTENT-CONTAINER space (the space the overlay's
    // own left/top live in), collision OFF (the canvas has no bounds). Mirrors
    // `Renderer.positionCanvasNodeOverlays` exactly, so the committed render
    // places the overlay where the live follow left it — no snap.
    // "Rooted" (not just `isCanvasNode`) so when a trigger reparents INTO a
    // canvas frame mid-drag (becoming a child, isCanvasNode=false) we don't fall
    // through to the viewport path and yank the overlay into a viewport.
    //
    // We check the OVERLAY too, not just the trigger: a canvas overlay is a
    // single '' -prefix element whose left/top are content-container px. When a
    // canvas node is dragged INTO a variant, the TRIGGER reparents (no longer
    // canvas-rooted) while the overlay element is still a canvas node until the
    // mouseup commit. Without the overlay check we'd take the per-viewport path,
    // patch a non-existent `variant-1-` overlay element with viewport-relative
    // px, and the overlay would snap to the variant root's 0,0 (the bug). The
    // canvas follow keeps tracking the trigger's live screen rect wherever it
    // moved.
    if (isCanvasRooted(e.triggerId, nodes) || isCanvasRooted(e.overlayId, nodes)) {
      followCanvasOverlay(e, scale, nodes);
      continue;
    }
    // Positioning origin: the trigger's top-level ancestor (page root, or a
    // component's variant root, e.g. frame-xxx). Recompute it LIVE from the
    // current node tree each frame — NOT the cached e.rootId. When a canvas node
    // with an open overlay is dragged INTO a viewport/variant, the entry flush
    // rehydrates the overlay (canvas → fixed) and reparents the trigger, so its
    // top-level ancestor changes from the canvas node ITSELF (what e.rootId
    // captured at begin) to the entered root. A stale e.rootId === triggerId made
    // root === trig → trigger-relative-to-root = 0,0 → the overlay snapped to the
    // root's top-left corner (the regression, in BOTH pages and components).
    const liveRootId = topLevelAncestor(e.triggerId, nodes);
    for (const vp of e.perVp) {
      const trig = findNodeRect(e.triggerId, vp.vpId);
      const root = findNodeRect(liveRootId, vp.vpId)
        ?? findNodeRect('layout::root', vp.vpId) ?? findNodeRect('root', vp.vpId);
      const ov = findNodeRect(e.overlayId, vp.vpId);
      if (!trig || !root || !ov) continue;
      const pos = computeOverlayPosition(
        vp.config, ov.width / scale, ov.height / scale,
        { left: trig.left, top: trig.top, width: trig.width, height: trig.height,
          right: trig.left + trig.width, bottom: trig.top + trig.height },
        { left: root.left, top: root.top, width: root.width, height: root.height },
        scale,
        // Component master: overlay overflows over the canvas, not clamped to the variant tile.
        !isComponentFilePath(getActiveFilePath()),
      );
      patchNodeStyles(followContentEl, e.overlayId, vp.vpPrefix, {
        left: `${Math.round(pos.left)}px`,
        top: `${Math.round(pos.top)}px`,
      });
    }
  }
}

/**
 * Live-follow for a canvas-node overlay: reposition it in content-container px
 * from its (canvas-node) trigger's CURRENT screen rect. The trigger is dragged
 * via a CSS `transform`, so its `rectCache` screen rect already reflects the
 * live position; converting through `computeOverlayPosition` with the content
 * container's screen rect as the origin yields content-container px (the unit of
 * a canvas node's left/top). Collision is OFF — the canvas has no viewport frame.
 */
/** The trigger's current live screen rect. Canvas-rooted → the primary canvas
 *  prefix. Otherwise it reparented into a viewport/variant mid-drag: scan the
 *  active viewports and prefer a non-primary (variant/replica) hit with a real
 *  (non-zero) rect — that's where it entered — falling back to the primary. */
function pickLiveTriggerRect(triggerId: string, nodes: NodeMap) {
  if (isCanvasRooted(triggerId, nodes)) return findNodeRect(triggerId, 'desktop');
  const vps = getDefaultStore().get(visibleViewportsAtom);
  let primaryHit: ReturnType<typeof findNodeRect> = null;
  for (const vp of vps) {
    const r = findNodeRect(triggerId, vp.id);
    if (!r || r.width <= 0 || r.height <= 0) continue;
    if (isPrimaryViewport(vp.id)) { primaryHit = r; continue; }
    return r;
  }
  return primaryHit ?? findNodeRect(triggerId, 'desktop');
}

function followCanvasOverlay(e: FollowEntry, scale: number, nodes: NodeMap): void {
  // The trigger's live screen rect lives under the primary ('desktop') prefix
  // WHILE it is a canvas node. But a canvas node dragged INTO a variant reparents
  // to that variant's prefix mid-drag (code-first entry flush), so the 'desktop'
  // rect goes stale/hidden. When the trigger is no longer canvas-rooted, find its
  // rect wherever it actually renders now — preferring a non-primary (variant /
  // replica) viewport, since that's where it just entered — so the overlay keeps
  // tracking it instead of freezing at its old canvas spot or the variant 0,0.
  const trig = pickLiveTriggerRect(e.triggerId, nodes);
  const ov = findNodeRect(e.overlayId, 'desktop');
  // ORIGIN = the overlay's OFFSET PARENT, in screen space. A canvas overlay at
  // the canvas root → the content container. One nested inside a canvas FRAME
  // (its left/top are then frame-LOCAL) → that frame's rect — else positioning in
  // content-container space writes coords the frame reads frame-relative, flinging
  // it off-screen / behind the frame mid-drag (the "disappears during drag" bug,
  // matching the same offset-parent fix in `Renderer.positionCanvasNodeOverlays`).
  const overlayNode = nodes.get(e.overlayId);
  const origin = (overlayNode?.parentId ? findNodeRect(overlayNode.parentId, 'desktop') : null)
    ?? getContentRootRect();
  if (!trig || !ov || !origin) return;
  const pos = computeOverlayPosition(
    { ...e.baseConfig, collision: 'none' },
    ov.width / scale, ov.height / scale,
    { left: trig.left, top: trig.top, width: trig.width, height: trig.height,
      right: trig.left + trig.width, bottom: trig.top + trig.height },
    { left: origin.left, top: origin.top, width: origin.width, height: origin.height },
    scale,
  );
  patchNodeStyles(followContentEl!, e.overlayId, '', {
    left: `${Math.round(pos.left)}px`,
    top: `${Math.round(pos.top)}px`,
  });
}

export function endOverlayFollow(): void {
  entries = [];
  followContentEl = null;
}
