// group-resize.ts — live SVG group-resize baking + group auto-refit handlers
// for the sandbox API. Extracted verbatim from bridge-sandbox.ts (Phase 7
// split). Keeps the per-drag bake snapshots as module state here.

import { computeScaledChildPatches, parseRotateTransform, type GroupResizeSnapshot, type GroupChildSnapshot } from '@/code/svg/group-resize-bake';
import { findElByNodeId } from '../sandbox-dom-utils';
import { firstSvgShapeChild, liveRefitGroupChainEl } from '../shape-edit-host';
import { contentRoot, emit } from './sandbox-state';
import { cornersForElement, emitSubtreeRefresh } from './rect-emit';

// Active live group-resize bakes, keyed by groupId. Each holds the ORIGINAL
// children snapshot + direct element refs so every frame's bake (group box +
// viewBox + child geometry) is applied SYNCHRONOUSLY in one task → atomic, no
// shear/jitter, and identical to the commit. Cleared on `clearGroupResizeBake`.
interface ActiveGroupBake {
  groupEl: SVGSVGElement;
  snap: GroupResizeSnapshot;
  childEls: SVGSVGElement[];
  geomEls: (SVGElement | null)[];
  /** Per-child: is this child itself a GROUP (contains nested `<svg>`)? A group
   *  child's viewBox is kept UNSCALED during the live bake so the browser scales
   *  its nested content via the viewBox→box mapping (recursively, for free) —
   *  matching the recursive baked commit (`scaleGroupChildrenSource`). */
  isGroupChild: boolean[];
}
const activeGroupBakes = new Map<string, ActiveGroupBake>();

  /** Live group-resize baking. First call snapshots the group's ORIGINAL
   *  children (element refs); every call re-bakes from that snapshot at the new
   *  scale and applies group box + viewBox + child geometry SYNCHRONOUSLY (one
   *  task → atomic, no shear, no jitter), identical to the commit. */
export function bakeGroupResize(groupId: string, vpPrefix: string, scaleX: number, scaleY: number): void {
    if (!contentRoot) return;
    let active = activeGroupBakes.get(groupId);
    if (!active) {
      const groupEl = findElByNodeId<SVGSVGElement>(contentRoot, vpPrefix, groupId);
      if (!groupEl || groupEl.tagName.toLowerCase() !== 'svg') return;
      const gvb = (groupEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      const origVbW = gvb[2], origVbH = gvb[3];
      if (!(origVbW > 0) || !(origVbH > 0)) return;
      const childEls: SVGSVGElement[] = [];
      const geomEls: (SVGElement | null)[] = [];
      const isGroupChild: boolean[] = [];
      const children: GroupChildSnapshot[] = [];
      const GEOM_KEYS = ['d', 'points', 'x', 'y', 'width', 'height', 'cx', 'cy', 'rx', 'ry', 'r', 'x1', 'y1', 'x2', 'y2'];
      for (const child of Array.from(groupEl.children)) {
        if (child.tagName.toLowerCase() !== 'svg') continue;
        const cs = child as SVGSVGElement;
        const cvb = (cs.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (!(cvb[2] > 0) || !(cvb[3] > 0)) continue;
        const geomEl = firstSvgShapeChild(cs) as SVGElement | null;
        // A GROUP child has nested `<svg>` children (not a direct shape). Its
        // nested content scales via the viewBox mapping during the live bake.
        const childIsGroup = !geomEl && Array.from(cs.children).some(g => g.tagName.toLowerCase() === 'svg');
        const geomAttrs: Record<string, string> = {};
        let geomTag = '';
        let rotate: GroupChildSnapshot['rotate'] = null;
        if (geomEl) {
          geomTag = geomEl.tagName.toLowerCase();
          for (const k of GEOM_KEYS) { const v = geomEl.getAttribute(k); if (v != null) geomAttrs[k] = v; }
          rotate = parseRotateTransform(geomEl.getAttribute('transform') || undefined);
        }
        childEls.push(cs);
        geomEls.push(geomEl);
        isGroupChild.push(childIsGroup);
        children.push({
          childId: '', x: parseFloat(cs.getAttribute('x') || '0') || 0, y: parseFloat(cs.getAttribute('y') || '0') || 0,
          width: parseFloat(cs.getAttribute('width') || '0') || 0, height: parseFloat(cs.getAttribute('height') || '0') || 0,
          vbx: cvb[0] || 0, vby: cvb[1] || 0, vbw: cvb[2], vbh: cvb[3],
          geomId: '', geomTag, geomAttrs, rotate,
        });
      }
      if (children.length === 0) return;
      // HEAL a box≠viewBox divergence to 1:1 BEFORE the first bake frame. A
      // nested group's box (width/height ATTRS) can drift away from its viewBox
      // if an earlier resize updated only the box — then the bake (which keeps
      // the group 1:1 by setting box = viewBox·scale) would JUMP the box to the
      // viewBox size on the first frame ("jumps the moment I start resizing").
      // Scale the children into box space + set viewBox = box, synchronously in
      // the DOM, and fold it into the snapshot so the rest of the bake is 1:1.
      // The commit (normalizeGroupOnResize) produces the same 1:1 source.
      let snapVbW = origVbW, snapVbH = origVbH;
      const groupIsNested = groupEl.parentElement?.tagName.toLowerCase() === 'svg';
      const boxW = groupIsNested
        ? parseFloat(groupEl.getAttribute('width') || '0')
        : parseFloat(groupEl.style.width || '0');
      const boxH = groupIsNested
        ? parseFloat(groupEl.getAttribute('height') || '0')
        : parseFloat(groupEl.style.height || '0');
      if (boxW > 0 && boxH > 0 && (Math.abs(boxW - origVbW) > 0.5 || Math.abs(boxH - origVbH) > 0.5)) {
        const healPatches = computeScaledChildPatches({ origVbW, origVbH, children }, boxW / origVbW, boxH / origVbH);
        for (let i = 0; i < healPatches.length; i++) {
          const p = healPatches[i], c = children[i];
          if (childEls[i]) for (const [k, v] of Object.entries(p.childAttrs)) childEls[i].setAttribute(k, v);
          if (geomEls[i]) for (const [k, v] of Object.entries(p.geomAttrs)) geomEls[i]!.setAttribute(k, v);
          // Fold the scaled values back into the snapshot so the live bake's
          // own scaling starts from the healed (1:1) geometry.
          if (p.childAttrs.x != null) c.x = parseFloat(p.childAttrs.x);
          if (p.childAttrs.y != null) c.y = parseFloat(p.childAttrs.y);
          if (p.childAttrs.width != null) c.width = parseFloat(p.childAttrs.width);
          if (p.childAttrs.height != null) c.height = parseFloat(p.childAttrs.height);
          const nvb = (p.childAttrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
          if (nvb.length === 4) { c.vbx = nvb[0]; c.vby = nvb[1]; c.vbw = nvb[2]; c.vbh = nvb[3]; }
          Object.assign(c.geomAttrs, p.geomAttrs);
          if (p.geomAttrs.transform) c.rotate = parseRotateTransform(p.geomAttrs.transform);
        }
        groupEl.setAttribute('viewBox', `0 0 ${boxW} ${boxH}`);
        snapVbW = boxW; snapVbH = boxH;
      }
      active = { groupEl, snap: { origVbW: snapVbW, origVbH: snapVbH, children }, childEls, geomEls, isGroupChild };
      activeGroupBakes.set(groupId, active);
    }
    // Group box + viewBox stay 1:1 (box == origVb·scale, which is exactly the
    // width the parent's resize computes) so the group's CSS scale never shears
    // its children. Set width/height here too so box+viewBox+children are atomic.
    const bw = Math.round(active.snap.origVbW * scaleX * 1000) / 1000;
    const bh = Math.round(active.snap.origVbH * scaleY * 1000) / 1000;
    // A NESTED group (its parent is also `<svg>`) is sized by its `width`/
    // `height` ATTRIBUTES, NOT CSS — the browser ignores `style.width` on a
    // nested `<svg>`, so the live resize wouldn't track. Write attributes for
    // nested; style for a top-level group.
    const groupIsNested = active.groupEl.parentElement?.tagName.toLowerCase() === 'svg';
    if (groupIsNested) {
      active.groupEl.setAttribute('width', `${bw}`);
      active.groupEl.setAttribute('height', `${bh}`);
      // A ROTATED nested group rotates via `transform="rotate(θ cx cy)"` (pivot
      // in PARENT space). As its box resizes, move the pivot to the new box
      // centre LIVE — else it rotates about a stale point and orbits during the
      // drag (then snaps on the commit's pivot update). Matches normalizeGroupOnResize.
      const tr = active.groupEl.getAttribute('transform');
      if (tr && tr.includes('rotate(')) {
        const gx = parseFloat(active.groupEl.getAttribute('x') || '0') || 0;
        const gy = parseFloat(active.groupEl.getAttribute('y') || '0') || 0;
        const pcx = Math.round((gx + bw / 2) * 1000) / 1000;
        const pcy = Math.round((gy + bh / 2) * 1000) / 1000;
        active.groupEl.setAttribute('transform', tr.replace(
          /rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/,
          (_m, a) => `rotate(${a} ${pcx} ${pcy})`,
        ));
      }
    } else {
      active.groupEl.style.width = `${bw}px`;
      active.groupEl.style.height = `${bh}px`;
    }
    active.groupEl.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
    const patches = computeScaledChildPatches(active.snap, scaleX, scaleY);
    for (let i = 0; i < patches.length; i++) {
      const cEl = active.childEls[i];
      if (cEl) for (const [k, v] of Object.entries(patches[i].childAttrs)) {
        // GROUP child: scale its box (x/y/width/height) but KEEP its viewBox so
        // the browser scales its nested content via the viewBox→box mapping
        // (recursively — handles group-in-group-in-group for free), matching
        // the recursive baked commit. Scaling the viewBox too would keep it 1:1
        // and the nested content would NOT scale live (then jump on mouseup).
        if (active.isGroupChild[i] && k === 'viewBox') continue;
        cEl.setAttribute(k, v);
      }
      // A MOTION child's rotation pivots at a parent-space PX carrier origin —
      // re-pin it to the scaled box centre each frame (the commit does the same
      // via setMotionOriginToBoxCentre) or the rotated child orbits the stale
      // pivot during the drag and snaps on mouseup.
      if (cEl && /-?[\d.]+px\s+-?[\d.]+px/.test(cEl.style.transformOrigin || '')) {
        const nx = parseFloat(cEl.getAttribute('x') || '0') || 0;
        const ny = parseFloat(cEl.getAttribute('y') || '0') || 0;
        const nw = parseFloat(cEl.getAttribute('width') || '0') || 0;
        const nh = parseFloat(cEl.getAttribute('height') || '0') || 0;
        cEl.style.transformOrigin = `${Math.round((nx + nw / 2) * 1000) / 1000}px ${Math.round((ny + nh / 2) * 1000) / 1000}px`;
      }
      const gEl = active.geomEls[i];
      if (gEl) for (const [k, v] of Object.entries(patches[i].geomAttrs)) gEl.setAttribute(k, v);
    }
    // Resizing a NESTED group grows/shrinks the box its ANCESTOR groups must
    // wrap — refit the ancestor chain LIVE so a flex-layout top-level group
    // reflows each frame (not just on mouseup). Starts from the PARENT (the
    // resized group keeps its user-set size), gated internally to the in-layout
    // case (no-op on the canvas). Do this BEFORE emitting corners so the
    // outline reflects the reflowed ancestors.
    if (groupIsNested) {
      const parentGroup = active.groupEl.parentElement;
      if (parentGroup && parentGroup.tagName.toLowerCase() === 'svg') {
        liveRefitGroupChainEl(parentGroup as unknown as SVGSVGElement);
      }
    }
    // Keep the group's selection outline tracking the freshly-baked content.
    emit({ type: 'cornersUpdate', nodeId: groupId, vpPrefix, corners: cornersForElement(active.groupEl), decoupled: true });
    // A nested group's resize changes the PARENT group's painted bounds — keep
    // every ancestor group's outline (ParentHighlight) live too.
    if (groupIsNested) emitSubtreeRefresh(active.groupEl as unknown as HTMLElement, emit);
    // Live-sync the parent caches too — a normal-frame resize patches via the
    // bridge (which emits these), but a baked group skips that patch, so without
    // these the Dimensions panel's width/height only updated on mouseup.
    emit({ type: 'computedUpdate', nodeId: groupId, vpPrefix, styles: { width: `${bw}px`, height: `${bh}px` } });
    const gr = active.groupEl.getBoundingClientRect();
    emit({ type: 'rectUpdate', nodeId: groupId, vpPrefix, rect: { left: gr.left, top: gr.top, width: gr.width, height: gr.height } });
}

export function clearGroupResizeBake(groupId: string): void {
    activeGroupBakes.delete(groupId);
}

  /** Live group auto-fit — re-fit a FLEX group to its children's PAINTED bounds
   *  (rotated bbox for rotated children) SYNCHRONOUSLY, each frame, WITHOUT
   *  re-basing the children. Instead of shifting every child by `-minX` (which
   *  accumulates on the non-interacted siblings each tick → exponential drift),
   *  move the group's viewBox ORIGIN to the content min and resize the box.
   *  Children keep their x/y, so the op is idempotent. The paint is identical to
   *  the commit (`moveChildAndRefitGroup` re-bases to origin 0 — same mapping of
   *  content→box), so there's no mouseup snap; the next render normalizes the
   *  origin back to 0. Gated to flex groups: an ABSOLUTE group needs left/top
   *  compensation against a snapshot baseline (follow-up) and stays on the
   *  commit-time refit. */
export function liveRefitGroup(groupId: string, vpPrefix: string): void {
    if (!contentRoot) return;
    const groupEl = findElByNodeId<SVGSVGElement>(contentRoot, vpPrefix, groupId);
    if (!groupEl) return;
    // Refit the WHOLE `<svg>`-group ancestor chain (nested groups via attrs, the
    // top-level flex group via style) — so manipulating a deeply-nested child
    // reflows the flex layout LIVE at every level. Internally a no-op when the
    // top-level group is absolute (canvas) → commit-time refit only.
    if (!liveRefitGroupChainEl(groupEl)) return;
    emit({ type: 'cornersUpdate', nodeId: groupId, vpPrefix, corners: cornersForElement(groupEl), decoupled: true });
    const r = groupEl.getBoundingClientRect();
    emit({ type: 'rectUpdate', nodeId: groupId, vpPrefix, rect: { left: r.left, top: r.top, width: r.width, height: r.height } });
    // Ancestor groups changed too — refresh their corners/rects so every level's
    // selection outline tracks the live reflow.
    emitSubtreeRefresh(groupEl as unknown as HTMLElement, emit);
}
