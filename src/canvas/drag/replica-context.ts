// replica-context.ts — Centralized primary/replica routing logic.
//
// Encapsulates the 4 routing combinations (page/component × primary/replica)
// into a single ReplicaContext interface. Replaces 10+ scattered
// isPrimaryViewport/isComponentFilePath branches across the codebase.
//
// Usage:
//   const ctx = getReplicaContext(vpId, activeFilePath, vpWidths);
//   const updates = ctx.styleUpdate(nodeId, { color: 'red' });
//   const hideUpdates = ctx.hideInAllOthers(nodeId);

import type { PendingUpdate } from '@/shared/types';
import { PROJECTION_STYLE_PROPS } from '@/shared/constants';
import { scalePathD, translatePathD } from '@/shared/svg-geometry';
import { isPrimaryViewport } from '@/shared/constants';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { getNodeFromCache } from '@/code/stores/store';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { trace } from '@/shared/debug-trace';

// ─── Interface ──────────────────────────────────────────────────────────────

// Translate DELTAS are the ONLY live position channel — probe-verified
// (2026-06-11, motion-svg-variant-position.test.tsx): framer-motion IGNORES
// attrX/attrY from variants on a nested motion.svg, while plain x/y become
// `style.transform: translate(...)` on top of the untouched base attrs. The
// static canvas folds the same x/y via foldMotionTransforms — both renderers
// agree. Per-variant DETACHMENT (a primary move must not drag variants along)
// is handled at the PRIMARY commit instead: the orchestrator compensates every
// variant's delta by (oldAttrs − newAttrs) so each variant's absolute position
// stays fixed. (`attrX`/`attrY` clears ride along so legacy absolute entries
// die on rewrite.) Size conversion lives in the same function below.

const rr = (n: number): string => `${Math.round(n * 10000) / 10000}`;

/** The transform carrier for a GROUP CHILD's per-variant rotate/scale:
 *  `transformBox: 'view-box'` + a PX origin at the child's attr-box centre in
 *  the parent group's view-box units.
 *
 *  NOT fill-box: real-Chromium probe (2026-06-12, transform-box-probe) shows
 *  Chrome resolves fill-box on a nested <svg> WITHOUT the x/y attr offset —
 *  the pivot lands (x, y) off and the painting orbits (exactly the user's
 *  screenshot; children at x=0,y=0 coincidentally worked). view-box + px is
 *  pixel-exact in the same probe.
 *  The px origin is derived from the SHARED base attrs, so primary commits
 *  that move/resize the child must refresh it — `svgChildCarrierOrigin` is
 *  exported for those sites (orchestrator compensation, node-ops redirect). */
export function svgChildCarrierOrigin(
  childAttrs: Record<string, string> | undefined,
  parentViewBox: string | undefined,
): { transformBox: string; transformOrigin: string } {
  const x = parseFloat(childAttrs?.x ?? '0') || 0;
  const y = parseFloat(childAttrs?.y ?? '0') || 0;
  const w = parseFloat(childAttrs?.width ?? '0') || 0;
  const h = parseFloat(childAttrs?.height ?? '0') || 0;
  // Defensive: a non-normalized parent viewBox shifts the px origin space.
  const vb = (parentViewBox ?? '').trim().split(/[\s,]+/).map(Number);
  const ox = vb.length === 4 && Number.isFinite(vb[0]) ? vb[0] : 0;
  const oy = vb.length === 4 && Number.isFinite(vb[1]) ? vb[1] : 0;
  return {
    transformBox: 'view-box',
    transformOrigin: `${rr(ox + x + w / 2)}px ${rr(oy + y + h / 2)}px`,
  };
}

/** Convert a group child's per-variant BOX commit (left/top/width/height in
 *  the group's viewBox space) → per-variant MOTION values:
 *
 *    width/height → scaleX/scaleY  (relative to the shared base attr size)
 *    left/top     → x/y translate deltas, COMPENSATED for the center origin
 *
 *  Why scale and not width/height in the variant entry: CSS width/height on a
 *  NESTED <svg> are NOT painted by Chromium (probe 2026-06-12, real Chromium
 *  149: style.width/'!important' both ignored, only the ATTRIBUTE paints) —
 *  and motion applies variant width on a nested motion.svg as style.width
 *  (probe FACT 4), so that channel is silently dead on BOTH renderers.
 *  Transforms ARE painted (translate deltas are user-verified live), so size
 *  must ride scaleX/scaleY — which is also what the reference itself does to vectors.
 *
 *  Geometry: the scale carrier is `transformBox: fill-box` +
 *  `transformOrigin: 50% 50%` (SHARED with the per-variant rotation channel —
 *  one origin for the whole transform). With a center origin,
 *    painted_left = baseX + dx + baseW·(1 − sx)/2
 *  so position writes solve dx = (L − baseX) + baseW·(sx − 1)/2, and a
 *  width-only write (panel) keeps the painted left anchored by adjusting
 *  dx += baseW·(sx − prevSx)/2. Stale width/height px entries (the dead
 *  channel) are cleared on every conversion so old files self-heal.
 *
 *  ROTATED children take the GEOMETRY channel instead: motion's transform
 *  order is scale·rotate (scale in PARENT axes after the rotation), so any
 *  non-uniform scale on a rotated child paints a PARALLELOGRAM — no motion
 *  values can express rotate-then-scale (live find 2026-06-12, "it skews").
 *  Per-variant size therefore rides the inner geometry: each geometry child
 *  gets a per-variant `d` (the shape-morph channel — motion tweens it, the
 *  canvas applies it as an attribute via GEOMETRY_VARIANT_ATTRS) scaled from
 *  its BASE d about the wrapper's local centre, the wrapper entry stores
 *  width/height PX METADATA (not painted on a nested svg — readable by
 *  baselines and the panel), and rotate stays the only linear transform —
 *  rigid at every size. The outer box math is IDENTICAL (geometry scales
 *  about the centre exactly like the fill-box scale did). Migration is
 *  one-way: once metadata exists the child stays on the geometry channel
 *  even if rotation returns to 0.
 */
export interface GroupChildBoxConversion {
  styles: Record<string, string>;
  needsCarrier: boolean;
  /** Geometry-channel payload: per inner geometry child, the scaled
   *  per-variant `d` + the base `d` for the default (animate-back) entry. */
  innerGeometry: Array<{ nodeId: string; d: string; baseD: string }>;
  /** Which channel the size took ('scale' = fill-box scaleX/scaleY,
   *  'geometry' = per-variant d + metadata, null = no size in this write). */
  sizeChannel: 'scale' | 'geometry' | null;
}

/** Scale a path `d` about a pivot (local user units). */
function scaleDAboutCenter(d: string, sx: number, sy: number, cx: number, cy: number): string {
  return translatePathD(scalePathD(translatePathD(d, -cx, -cy), sx, sy), cx, cy);
}

export function groupChildBoxToMotion(
  styles: Record<string, string>,
  node: {
    children?: string[];
    attrs?: Record<string, string>;
    motionVariants?: Record<string, Record<string, string | number>>;
  } | null,
  variantName: string,
  opts?: { forceGeometry?: boolean },
): GroupChildBoxConversion {
  const attrs = node?.attrs ?? {};
  const baseX = parseFloat(attrs.x ?? '0') || 0;
  const baseY = parseFloat(attrs.y ?? '0') || 0;
  const baseW = parseFloat(attrs.width ?? '0') || 0;
  const baseH = parseFloat(attrs.height ?? '0') || 0;
  // INHERITANCE: an untouched variant paints the DEFAULT entry's motion
  // values — the first edit must anchor against those (responsive-style
  // detach-on-touch), not against neutral zeros.
  const prevDefault = (variantName !== 'default' ? node?.motionVariants?.default : undefined) ?? {};
  const prev = { ...prevDefault, ...(node?.motionVariants?.[variantName] ?? {}) };
  const prevSx = parseFloat(String(prev.scaleX ?? '1')) || 1;
  const prevSy = parseFloat(String(prev.scaleY ?? '1')) || 1;
  const prevDx = parseFloat(String(prev.x ?? '0')) || 0;
  const prevDy = parseFloat(String(prev.y ?? '0')) || 0;
  const prevRotate = parseFloat(String(prev.rotate ?? '0')) || 0;
  // Geometry-channel metadata from previous geometry-mode commits.
  const prevMetaW = parseFloat(String(prev.width ?? '')) || 0;
  const prevMetaH = parseFloat(String(prev.height ?? '')) || 0;

  // Geometry mode when the child is rotated (the skew hazard) or already
  // migrated (metadata present) — AND every geometry child has a `d` to scale
  // (a never-stamped polygon child falls back to the scale channel; the
  // rotate-commit stamps ids/converts polygons via ensureShapeChildIds so this
  // is transitional only).
  const innerChildren = (node?.children ?? [])
    .map(cid => ({ cid, child: getNodeFromCache(cid) }))
    .filter(c => !!c.child);
  const innerDs = innerChildren
    .map(c => ({
      nodeId: c.cid,
      baseD: c.child?.attrs?.d ?? '',
      // A SHAPE-EDITED variant carries its own independent `d` — the size
      // change must rescale THAT form, never re-derive from the base d
      // (which nuked the custom shape back to the primary's geometry).
      ownD: (c.child?.motionVariants?.[variantName]?.d as string | undefined) ?? '',
    }));
  const geometryCapable = innerDs.length > 0 && innerDs.every(c => !!c.baseD);
  const wantsGeometry = (Math.abs(prevRotate) > 0.001 || prevMetaW > 0 || prevMetaH > 0 || !!opts?.forceGeometry);
  const useGeometry = wantsGeometry && geometryCapable && baseW > 0 && baseH > 0;

  // Painted size BEFORE this write (the anchor baseline): metadata wins
  // (geometry mode), else the scale channel, else the base attrs.
  const paintedPrevW = prevMetaW > 0 ? prevMetaW : baseW * prevSx;
  const paintedPrevH = prevMetaH > 0 ? prevMetaH : baseH * prevSy;

  const hasW = styles.width !== undefined && styles.width !== '' && baseW > 0;
  const hasH = styles.height !== undefined && styles.height !== '' && baseH > 0;

  const out: Record<string, string> = {};
  const innerGeometry: GroupChildBoxConversion['innerGeometry'] = [];
  let needsCarrier = false;
  let sizeChannel: GroupChildBoxConversion['sizeChannel'] = null;

  // Effective absolute scale vs the BASE attrs after this write.
  let sx = paintedPrevW > 0 ? paintedPrevW / baseW : prevSx;
  let sy = paintedPrevH > 0 ? paintedPrevH / baseH : prevSy;
  if (hasW) sx = (parseFloat(styles.width) || baseW) / baseW;
  if (hasH) sy = (parseFloat(styles.height) || baseH) / baseH;

  if (useGeometry && (hasW || hasH || prevSx !== 1 || prevSy !== 1)) {
    // GEOMETRY channel: scale every inner d from its BASE about the wrapper's
    // local centre (absolute, idempotent), store px metadata, clear any CSS
    // scale (incl. migrating a pre-rotation scale into the geometry).
    //
    // The centre is in VIEWBOX units — the space `d` coordinates live in.
    // The wrapper's box can be NON-1:1 with its viewBox (a primary resize
    // writes attrs but keeps the shared viewBox): scaling about the BOX
    // centre (baseW/2) then shifted the shape's local centre as it grew and
    // the painted anchor crept ~7.5px during a replica resize (live repro
    // 2026-06-12, user file box 184×96 / viewBox 118×76). Box == viewBox
    // (every 1:1 fixture) made the two centres coincide and hid this.
    sizeChannel = 'geometry';
    const vbP = (attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
    const dCx = vbP.length === 4 && vbP[2] > 0 ? vbP[0] + vbP[2] / 2 : baseW / 2;
    const dCy = vbP.length === 4 && vbP[3] > 0 ? vbP[1] + vbP[3] / 2 : baseH / 2;
    // Painted scale BEFORE this write — a custom (shape-edited) own d is
    // rescaled RELATIVELY (new/prev); a derived d gives the identical result
    // to the absolute-from-base form (base·prev × new/prev = base·new).
    const prevPSx = paintedPrevW > 0 && baseW > 0 ? paintedPrevW / baseW : prevSx;
    const prevPSy = paintedPrevH > 0 && baseH > 0 ? paintedPrevH / baseH : prevSy;
    for (const { nodeId: gid, baseD, ownD } of innerDs) {
      innerGeometry.push({
        nodeId: gid,
        d: ownD
          ? scaleDAboutCenter(ownD, prevPSx > 0 ? sx / prevPSx : sx, prevPSy > 0 ? sy / prevPSy : sy, dCx, dCy)
          : scaleDAboutCenter(baseD, sx, sy, dCx, dCy),
        baseD,
      });
    }
    out.width = `${rr(baseW * sx)}px`;
    out.height = `${rr(baseH * sy)}px`;
    out.scaleX = '';
    out.scaleY = '';
    needsCarrier = true; // rotation pivot carrier (rotate rides the wrapper)
  } else {
    if (hasW) { out.scaleX = rr(sx); out.width = ''; needsCarrier = true; sizeChannel = 'scale'; }
    if (hasH) { out.scaleY = rr(sy); out.height = ''; needsCarrier = true; sizeChannel = 'scale'; }
    // Explicit size reset ('' = remove): clear the scale override too.
    if (styles.width === '') { out.scaleX = ''; out.width = ''; }
    if (styles.height === '') { out.scaleY = ''; out.height = ''; }
  }

  if (styles.left !== undefined) {
    out.x = rr((parseFloat(styles.left) || 0) - baseX + baseW * (sx - 1) / 2);
    out.attrX = '';
  } else if (hasW || (useGeometry && sizeChannel === 'geometry' && prevSx !== 1)) {
    // keep the painted left anchored when the width (or a migrating CSS
    // scale) changes: painted_left = baseX + dx + baseW·(1 − s)/2.
    const prevPaintedScaleX = paintedPrevW > 0 ? paintedPrevW / baseW : prevSx;
    out.x = rr(prevDx + baseW * (sx - prevPaintedScaleX) / 2);
    out.attrX = '';
  }
  if (styles.top !== undefined) {
    out.y = rr((parseFloat(styles.top) || 0) - baseY + baseH * (sy - 1) / 2);
    out.attrY = '';
  } else if (hasH || (useGeometry && sizeChannel === 'geometry' && prevSy !== 1)) {
    const prevPaintedScaleY = paintedPrevH > 0 ? paintedPrevH / baseH : prevSy;
    out.y = rr(prevDy + baseH * (sy - prevPaintedScaleY) / 2);
    out.attrY = '';
  }

  for (const [k, v] of Object.entries(styles)) {
    if (k === 'left' || k === 'top' || k === 'width' || k === 'height') continue;
    out[k] = v;
  }
  return { styles: out, needsCarrier, innerGeometry, sizeChannel };
}

export interface ReplicaContext {
  /** Whether this viewport/variant is the primary (desktop / default) */
  isPrimary: boolean;
  /** Whether we're editing a component file (vs a page file) */
  isComponent: boolean;
  /** The viewport/variant ID (e.g. 'desktop', 'tablet', 'default', 'variant-1') */
  vpId: string;
  /** For component replicas: the variant name (e.g. 'variant-1'). null for pages. */
  variantName: string | null;
  /** Width of this viewport in px */
  vpWidth: number;
  /** Map of all viewport/variant IDs → widths */
  allVpWidths: Record<string, number>;

  /** Hide the node in THIS viewport/variant only */
  hideInThis(nodeId: string): PendingUpdate;
  /** Hide the node in ALL OTHER viewports/variants (except this one) */
  hideInAllOthers(nodeId: string): PendingUpdate[];
  /** Route a style update through the correct mutation path */
  styleUpdate(nodeId: string, styles: Record<string, string>): PendingUpdate[];
  /** Move a node out to the canvas as a canvas node */
  exitToCanvas(nodeId: string, styles: Record<string, string>): PendingUpdate;
  /** Build delete updates: primary = remove, replica = hide or remove depending on visibility */
  deleteUpdate(nodeId: string, contentEl: HTMLElement): PendingUpdate[];
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a ReplicaContext for the given viewport/variant + file context.
 *
 * This is the single source of truth for routing style writes, hides,
 * and deletes based on primary/replica × page/component axes.
 */
/** Migrate a group child's per-variant CSS scale (scaleX/scaleY) into the
 *  GEOMETRY channel (per-variant inner `d` + px metadata) — required the
 *  moment a rotation joins the entry, because motion's scale·rotate order
 *  SKEWS a rotated non-uniform scale. Painted box is unchanged by the
 *  migration (the x/y compensation terms cancel). Returns [] when the child
 *  carries no scale or isn't geometry-capable (caller should have stamped
 *  inner ids via ensureShapeChildIds first). Used by RotateManager's variant
 *  rotate commit. */
export function groupChildScaleToGeometryUpdates(
  nodeId: string,
  variantName: string,
  activeFilePath: string,
): PendingUpdate[] {
  const node = getNodeFromCache(nodeId);
  const entry = node?.motionVariants?.[variantName];
  if (!node || !entry) return [];
  const sx = parseFloat(String(entry.scaleX ?? '1')) || 1;
  const sy = parseFloat(String(entry.scaleY ?? '1')) || 1;
  if (Math.abs(sx - 1) < 0.0001 && Math.abs(sy - 1) < 0.0001) return [];
  const conv = groupChildBoxToMotion({}, node as any, variantName, { forceGeometry: true });
  if (conv.sizeChannel !== 'geometry') {
    trace.action('replica-context:scale-to-geometry-skipped', { nodeId, variantName, reason: 'not-geometry-capable' });
    return [];
  }
  let allVariants: string[] = [variantName];
  try {
    const code = projectFS.readFile(activeFilePath) ?? '';
    const cfg = parseVariantConfig(code);
    if (cfg.length > 0) allVariants = cfg.map(v => v.name);
  } catch { /* fall back to just this variant */ }
  const updates: PendingUpdate[] = [];
  for (const ig of conv.innerGeometry) {
    updates.push({ nodeId: ig.nodeId, type: 'updateVariantStyle', variantName, styles: { d: ig.d } });
    const innerNode = getNodeFromCache(ig.nodeId);
    if (variantName !== 'default' && innerNode?.motionVariants?.default?.d == null) {
      updates.push({ nodeId: ig.nodeId, type: 'updateVariantStyle', variantName: 'default', styles: { d: ig.baseD } });
    }
  }
  updates.push({ nodeId, type: 'updateVariantStyle', variantName, styles: conv.styles });
  trace.action('replica-context:scale-to-geometry', {
    nodeId, variantName, innerCount: conv.innerGeometry.length, meta: { w: conv.styles.width, h: conv.styles.height },
  });
  return updates;
}

/** Do any children of this svg GROUP carry per-variant box/transform values
 *  (positions, scales, rotations, geometry `d`s, px size metadata)? When they
 *  do, SHARED-geometry rewrites (refit/re-base/normalize) must not run — the
 *  variant values are relative to that geometry. Shared between the drag
 *  commit (CanvasDragOrchestrator) and the resize commit paths. */
export function groupChildrenCarryVariantGeometry(groupId: string): boolean {
  const group = getNodeFromCache(groupId);
  for (const cid of group?.children ?? []) {
    const child = getNodeFromCache(cid);
    const sources = [child?.motionVariants, ...((child?.children ?? []).map(g => getNodeFromCache(g)?.motionVariants))];
    for (const mv of sources) {
      if (!mv) continue;
      for (const [vName, entry] of Object.entries(mv)) {
        if (vName === 'default' || !entry) continue;
        if (entry.attrX != null || entry.attrY != null || entry.x != null || entry.y != null
          || entry.scaleX != null || entry.scaleY != null || entry.rotate != null
          || entry.d != null || entry.width != null || entry.height != null) return true;
      }
    }
  }
  return false;
}

/** PRIMARY-resize detach compensation: a primary commit just rewrote the
 *  child's SHARED base box (attrs x/y/width/height) and possibly its base
 *  geometry. Every variant entry is RELATIVE to that base — rewrite each so
 *  the variant PAINTING stays exactly where the user put it:
 *    · x/y deltas: painted_left = base_x + dx + (base_w − painted_w)/2 is
 *      held invariant across the base change;
 *    · scale-channel entries: painted_w = base_w·sx → sx' = old_w·sx / new_w;
 *      (geometry-channel px metadata is ABSOLUTE — unchanged);
 *    · geometry `d` entries: re-derived from the NEW base d at the painted
 *      size (metadata / scale), about the new local centre;
 *    · the view-box carrier origin is refreshed from the new attrs.
 *  The mirror of the drag commit's delta compensation, extended for size. */
export function compensateGroupChildVariantsForBaseBox(
  nodeId: string,
  oldBox: { x: number; y: number; w: number; h: number },
  newBox: { x: number; y: number; w: number; h: number },
  newBaseDs: Record<string, string>,
): PendingUpdate[] {
  const node = getNodeFromCache(nodeId);
  if (!node?.motionVariants) return [];
  const parent = node.parentId ? getNodeFromCache(node.parentId) : null;
  const updates: PendingUpdate[] = [];
  for (const [vName, entry] of Object.entries(node.motionVariants)) {
    if (vName === 'default' || !entry) continue;
    const num = (v: unknown, dflt: number): number => {
      if (v == null || v === '') return dflt;
      const n = parseFloat(String(v));
      return Number.isFinite(n) ? n : dflt;
    };
    const dx = num(entry.x, 0);
    const dy = num(entry.y, 0);
    const sx = num(entry.scaleX, 1);
    const sy = num(entry.scaleY, 1);
    const metaW = num(entry.width, 0);
    const metaH = num(entry.height, 0);
    // INHERITANCE MODEL: compensate ONLY independently-touched channels.
    // Untouched position/size follows the base by construction (sparse entry
    // ⇒ no delta to go stale) — writing x/y here would pin the variant to the
    // OLD base box and permanently detach it from the primary.
    const xTouched = entry.x != null && entry.x !== '';
    const yTouched = entry.y != null && entry.y !== '';
    const sxTouched = entry.scaleX != null && entry.scaleX !== '';
    const syTouched = entry.scaleY != null && entry.scaleY !== '';
    const wTouched = metaW > 0;
    const hTouched = metaH > 0;
    if (!xTouched && !yTouched && !sxTouched && !syTouched && !wTouched && !hTouched) continue;
    const paintedW = metaW > 0 ? metaW : oldBox.w * sx;
    const paintedH = metaH > 0 ? metaH : oldBox.h * sy;
    const paintedLeft = oldBox.x + dx + (oldBox.w - paintedW) / 2;
    const paintedTop = oldBox.y + dy + (oldBox.h - paintedH) / 2;
    // Painted size in the NEW world per channel: a touched size keeps its
    // absolute painted px (metadata, or scale recomputed against the new
    // base); an UNTOUCHED size inherits the new base box.
    const newPaintedW = (wTouched || sxTouched) ? paintedW : newBox.w;
    const newPaintedH = (hTouched || syTouched) ? paintedH : newBox.h;
    const styles: Record<string, string> = {};
    if (xTouched) styles.x = rr(paintedLeft - newBox.x - (newBox.w - newPaintedW) / 2);
    if (yTouched) styles.y = rr(paintedTop - newBox.y - (newBox.h - newPaintedH) / 2);
    if (sxTouched && metaW === 0 && newBox.w > 0) {
      styles.scaleX = rr((oldBox.w * sx) / newBox.w);
    }
    if (syTouched && metaH === 0 && newBox.h > 0) {
      styles.scaleY = rr((oldBox.h * sy) / newBox.h);
    }
    if (Object.keys(styles).length > 0) {
      updates.push({ nodeId, type: 'updateVariantStyle', variantName: vName, styles });
    }
    // Geometry-channel d entries on the inner children: re-derive from the
    // NEW base d at the (absolute) painted size. The scaling centre is in
    // the `d`'s OWN coordinate space: a FRESH d (newBaseDs, from the bake —
    // which rewrites the viewBox 1:1 with the new box) is centred at
    // newBox/2; a CACHE d (plain attr write, viewBox untouched) is centred
    // at the cached VIEWBOX centre — the box can be non-1:1 with it (see the
    // groupChildBoxToMotion geometry branch for the drift this fixes).
    if ((metaW > 0 || metaH > 0) && newBox.w > 0 && newBox.h > 0) {
      const vbP = (node.attrs?.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
      const vbW = vbP.length === 4 && vbP[2] > 0 ? vbP[2] : oldBox.w;
      const vbH = vbP.length === 4 && vbP[3] > 0 ? vbP[3] : oldBox.h;
      const vbCx = vbP.length === 4 && vbP[2] > 0 ? vbP[0] + vbP[2] / 2 : oldBox.w / 2;
      const vbCy = vbP.length === 4 && vbP[3] > 0 ? vbP[1] + vbP[3] / 2 : oldBox.h / 2;
      for (const gid of node.children ?? []) {
        const inner = getNodeFromCache(gid);
        const curD = inner?.motionVariants?.[vName]?.d;
        if (curD == null) continue;
        const fresh = newBaseDs[gid];
        const baseD = fresh ?? inner?.attrs?.d ?? '';
        if (!baseD) continue;
        // PRESERVE THE VARIANT'S PAINTED GEOMETRY by rescaling its CURRENT
        // d — never re-derive from the base d: a SHAPE-EDITED variant form
        // was nuked back to the primary's geometry by a primary height
        // change (live report 2026-06-12, the squiggle → trapezoid). For a
        // resize-derived d the relative map gives the identical result
        // (base·meta/old × old/new = base·meta/new). Painted invariance:
        //   (d' − vbC') · box'/vb' = (d − vbC) · box/vb
        // — non-bake: vb unchanged → factor old/new about the vb centre;
        // — bake (fresh d): vb renormalized 1:1 to newBox → factor
        //   oldBox/oldVb about the old vb centre, then the centre maps to
        //   newBox/2.
        let dNew: string;
        if (fresh) {
          const f1x = vbW > 0 ? oldBox.w / vbW : 1;
          const f1y = vbH > 0 ? oldBox.h / vbH : 1;
          dNew = translatePathD(
            scaleDAboutCenter(String(curD), f1x, f1y, vbCx, vbCy),
            newBox.w / 2 - vbCx, newBox.h / 2 - vbCy,
          );
        } else {
          dNew = scaleDAboutCenter(String(curD), oldBox.w / newBox.w, oldBox.h / newBox.h, vbCx, vbCy);
        }
        updates.push({
          nodeId: gid, type: 'updateVariantStyle', variantName: vName,
          styles: { d: dNew },
        });
        // default keeps the (new) base d as the return path
        updates.push({ nodeId: gid, type: 'updateVariantStyle', variantName: 'default', styles: { d: baseD } });
      }
    }
  }
  // The carrier origin is keyed to BASE attrs — refresh it whenever the base
  // box changes, regardless of whether any variant needed delta compensation.
  // A rotate-only sparse variant has nothing to compensate but its rotation
  // still pivots at this origin; a stale origin makes it orbit the old centre.
  if (node.styles?.transformBox === 'view-box') {
    const carrier = svgChildCarrierOrigin(
      { x: `${newBox.x}`, y: `${newBox.y}`, width: `${newBox.w}`, height: `${newBox.h}` },
      parent?.attrs?.viewBox,
    );
    updates.push({ nodeId, type: 'updateStyles', styles: carrier as unknown as Record<string, string> });
  }
  if (updates.length > 0) {
    trace.action('replica-context:primary-resize-variant-compensate', {
      nodeId, oldBox, newBox, updateCount: updates.length,
    });
  }
  return updates;
}

export function getReplicaContext(
  vpId: string,
  activeFilePath: string,
  vpWidths: Record<string, number>,
): ReplicaContext {
  const isPrimary = isPrimaryViewport(vpId);
  const isComponent = isComponentFilePath(activeFilePath);
  const vpWidth = vpWidths[vpId] ?? 0;
  const variantName = (isComponent && !isPrimary) ? vpId : null;

  trace.fn('getReplicaContext', {
    vpId, activeFilePath, isPrimary, isComponent, vpWidth, variantName,
    allVpIds: Object.keys(vpWidths),
  });

  // ── Helpers ──

  /** Read full variant name list from the file's `variantConfig` array.
   *  Used to compute `allVariants` for `setVariantVisibility`. Falls back
   *  to `Object.keys(vpWidths)` (which on component files holds every
   *  variant name) when source parsing fails — keeps tests + edge cases
   *  working without depending on a readable file. */
  function getAllVariantNames(): string[] {
    try {
      const code = projectFS.readFile(activeFilePath) ?? '';
      const cfg = parseVariantConfig(code);
      if (cfg.length > 0) return cfg.map(v => v.name);
    } catch (e) {
      trace.error('replica-context:variant-cfg-parse-failed', { error: String(e) });
    }
    // Fallback — for component files, vpWidths keys are variant names
    // (e.g., 'default', 'variant-1', 'variant-2'). Map 'desktop' →
    // 'default' for the primary-variant case (variantConfig convention).
    return Object.keys(vpWidths).map(k => k === 'desktop' ? 'default' : k);
  }

  /** Build a `setVariantVisibility` mutation that sets the hidden list to
   *  the given variants. For COMPONENT contexts only — page contexts use
   *  `updateContainerStyle` (unchanged). */
  function buildSetVisibility(nodeId: string, hiddenVariants: string[]): PendingUpdate {
    return {
      nodeId,
      type: 'setVariantVisibility',
      hiddenVariants,
      allVariants: getAllVariantNames(),
    };
  }

  /** Page-context hide: write `display: 'none'` to the target vp's
   *  `@container` rule. Unchanged from the original behavior. */
  function buildPageHideUpdate(nodeId: string, targetVpId: string): PendingUpdate {
    const targetWidth = vpWidths[targetVpId] ?? 0;
    return {
      nodeId,
      type: 'updateContainerStyle',
      maxWidth: targetWidth,
      styles: { display: 'none' },
    };
  }

  // ── Context implementation ──

  const ctx: ReplicaContext = {
    isPrimary,
    isComponent,
    vpId,
    variantName,
    vpWidth,
    allVpWidths: vpWidths,

    hideInThis(nodeId: string): PendingUpdate {
      trace.action('replica-context:hideInThis', { nodeId, vpId, isComponent, isPrimary });
      if (isComponent) {
        const node = getNodeFromCache(nodeId);
        // CMS `.map()` ROW → hide via an inline display ternary (same as styleUpdate):
        // the hiddenOnVariants/`<AnimatePresence>` wrapper can't wrap a node inside a
        // `.map()` callback. So detaching a row out of a variant (which calls hideInThis
        // on the row) hides that list's rendered rows in THIS variant via display:none —
        // the Renderer resolves it for the template AND its ghost copies.
        const parent = node?.parentId ? getNodeFromCache(node.parentId) : null;
        const isCmsRow = !!parent?.collectionList
          && Object.values(parent.collectionList.templateIds ?? {}).includes(nodeId);
        if (isCmsRow) {
          return { nodeId, type: 'setConditionalStyle', variantName: isPrimary ? 'default' : vpId, prop: 'display', value: 'none' };
        }
        // Component variant: ADD this variant to the existing hidden
        // set (additive). Read existing state from the node cache so
        // we don't lose other variants that are already hidden.
        const current = new Set(node?.hiddenOnVariants ?? []);
        // Primary maps to 'default' in the variants object.
        const variantToHide = isPrimary ? 'default' : vpId;
        current.add(variantToHide);
        return buildSetVisibility(nodeId, Array.from(current));
      }
      return buildPageHideUpdate(nodeId, vpId);
    },

    hideInAllOthers(nodeId: string): PendingUpdate[] {
      if (isComponent) {
        // Component variant: emit ONE setVariantVisibility setting
        // hidden = all variants except the current one. REPLACE
        // semantics — used at canvas-node-into-variant entry where
        // the element should be solo on this variant.
        const allVariants = getAllVariantNames();
        const currentVariant = isPrimary ? 'default' : vpId;
        const hiddenVariants = allVariants.filter(v => v !== currentVariant);
        trace.action('replica-context:hideInAllOthers-component', {
          nodeId, vpId, currentVariant, hiddenVariants,
        });
        return [buildSetVisibility(nodeId, hiddenVariants)];
      }
      // Page replica: iterate per-vp `@container` hides (unchanged).
      const updates: PendingUpdate[] = [];
      for (const otherVpId of Object.keys(vpWidths)) {
        if (otherVpId === vpId) continue;
        updates.push(buildPageHideUpdate(nodeId, otherVpId));
      }
      trace.action('replica-context:hideInAllOthers-page', {
        nodeId, vpId, otherCount: updates.length,
      });
      return updates;
    },

    styleUpdate(nodeId: string, styles: Record<string, string>): PendingUpdate[] {
      trace.action('replica-context:styleUpdate', {
        nodeId, vpId, isPrimary, isComponent, styleKeys: Object.keys(styles),
      });

      // COMPONENT variant writes: split layout-affecting props out of the
      // framer-motion `variants` object and into inline `style` ternaries.
      // motion applies `variants` via its rAF loop AFTER React commits + after
      // the `layout` (FLIP) prop measured, so a layout prop in a variant SNAPS
      // and never animates. A `style` ternary is applied by React synchronously
      // → `layout` measures the new flow → it FLIP-animates. (Same reason
      // `order` lives in a ternary.) The Layout tool writes flexDirection/
      // align/justify/gap/wrap through here, so this is the central fix.
      const condUpdates: PendingUpdate[] = [];
      let rest = styles;
      // Single node-cache read, reused by BOTH the svg-size routing (split below)
      // and the instance plain-write guard (primary branch). A second
      // getNodeFromCache call would double-read (and break call-once test mocks).
      const cachedNode = isComponent ? getNodeFromCache(nodeId) : null;
      if (isComponent) {
        // SVG wrapper size animates via the motion `variants` OBJECT (a real
        // value-tween), NOT the inline `style` ternary that HTML children use.
        // `layout` (FLIP) projects via CSS transform, which motion does NOT
        // apply to an <svg> ROOT — so a width/height ternary on a motion.svg
        // never animates (and per the live-preview repro, doesn't even apply):
        // left/top move but the height stays put. An absolutely-positioned svg
        // reflows no siblings, so the ternary's sibling-shove protection buys
        // nothing here. Route svg size through `other` (variant object) like
        // left/top; generator's updateVariantStyleInCode collapses any stale
        // inline size ternary to its base so the two can't conflict. HTML
        // children keep the ternary (FLIP works → smooth, no shove).
        const isSvgWrapper = cachedNode?.type === 'svg';
        // A CMS `.map()` ROW (the collection template) is a plain template element —
        // often `<Link>`, NOT `motion.*` — so a `variants` OBJECT wouldn't apply at
        // runtime, and it lives inside a `.map()` callback (no AnimatePresence wrap).
        // Route its per-variant `display` (Hide) to an inline `display: variant ===
        // 'x' ? 'none' : '<base>'` ternary instead: plain inline style (works on a
        // `<Link>`), deploy-correct, and the Renderer resolves it for the template AND
        // every ghost copy (resolveVariantStyles in build, syncInlineStyles in patch).
        const cmsRowParent = cachedNode?.parentId ? getNodeFromCache(cachedNode.parentId) : null;
        const isCmsRow = !!cmsRowParent?.collectionList
          && Object.values(cmsRowParent.collectionList.templateIds ?? {}).includes(nodeId);
        // CODE-component instance: its root is a PLAIN element (whatever the
        // code component renders), so the motion numeric-rotate convention the
        // variant writer would emit (`rotate: 180`) is INVALID CSS there and
        // silently ignored — a rotated code-component instance rendered
        // unrotated (user report 2026-07-31). Convert a pure-rotate transform
        // to a deg-string `rotate` up front: valid CSS on plain elements AND
        // still motion-compatible. Design instances (motion root) keep the
        // numeric convention downstream.
        if (cachedNode?.isCodeComponent && typeof styles.transform === 'string') {
          const rotOnly = /^\s*rotate\((-?\d+(?:\.\d+)?)deg\)\s*$/.exec(styles.transform);
          if (rotOnly) {
            styles = { ...styles, transform: '', rotate: `${rotOnly[1]}deg` };
            trace.action('replica-context:code-component-rotate-deg', { nodeId, rotate: styles.rotate });
          }
        }
        const layout: Record<string, string> = {};
        const other: Record<string, string> = {};
        for (const [k, v] of Object.entries(styles)) {
          const isSvgSize = isSvgWrapper && (k === 'width' || k === 'height');
          const isConditional = PROJECTION_STYLE_PROPS.has(k) || (k === 'display' && isCmsRow);
          if (isConditional && !isSvgSize) layout[k] = v;
          else other[k] = v;
        }
        for (const [prop, value] of Object.entries(layout)) {
          condUpdates.push({
            nodeId, type: 'setConditionalStyle',
            variantName: isPrimary ? 'default' : variantName!,
            prop, value,
          });
        }
        rest = other;
      }

      // Push the inline/variant write for the remaining (non-layout) props.
      // When NO layout props were split off (`condUpdates` empty), keep the
      // original unconditional push — preserves the empty-styles no-op behavior
      // and the non-component (page) path untouched.
      const pushRest = condUpdates.length === 0 || Object.keys(rest).length > 0;

      if (isPrimary) {
        const updates: PendingUpdate[] = [...condUpdates];
        if (pushRest) {
          // A component INSTANCE stores its per-variant styles as INLINE TERNARIES
          // (writeInstanceConditionalStyles), so a plain `style` write here would
          // overwrite the whole `left: variant === 'v' ? … : …` expression and
          // WIPE the sibling-variant overrides — moving the instance on the
          // default tile erased the position set on variant-1. Skip the plain
          // write for instances: `updateVariantStyle('default')` already updates
          // the inline DEFAULT branch while preserving the others. A non-instance
          // motion child keeps the plain write — its variants live in a separate
          // object, so there's no inline conflict.
          const primaryNode = cachedNode;
          const isInstanceNode = !!primaryNode && (primaryNode.isComponentInstance || primaryNode.isCodeComponent);
          if (!isInstanceNode) {
            // Even a NON-instance can store SOME props as inline ternaries: an SVG
            // wrapper keeps width/height as `width: variant === 'v' ? … : …`
            // (motion clears inline width/height on a motion.svg, so they can't
            // live in the variants object like everything else). A plain `style`
            // write would clobber that whole expression and WIPE the variant
            // override — the exact "shape-edit then resize variant breaks +
            // moves primary" bug. Drop any prop the node holds in
            // conditionalStyles from the plain write; updateVariantStyle('default')
            // below edits just its DEFAULT branch, preserving the variants.
            const cond = primaryNode?.conditionalStyles;
            const plain: Record<string, string> = {};
            for (const [k, v] of Object.entries(rest)) {
              if (cond && cond[k]) continue;
              plain[k] = v;
            }
            // Always push the (possibly-empty) plain write: an empty styles input
            // is a meaningful no-op marker preserved from the original path, and an
            // all-conditional input collapses to a harmless `{}` rather than
            // clobbering the ternaries.
            updates.push({ nodeId, type: 'style', styles: plain });
          }
          // Component primary also mirrors animatable props to 'default' variant.
          if (isComponent) {
            // SVG GROUP CHILD: the primary position commit becomes an x/y ATTR
            // write (the orchestrator redirect); per-variant positions are x/y
            // translate DELTAS from those attrs. The default entry's job is
            // the animate-back RETURN PATH: NEUTRAL deltas (x: 0, y: 0) — the
            // resting position IS the base attrs. Raw left/top here is CSS
            // junk a nested svg ignores; absolute values double-position
            // (live finds 2026-06-11).
            const groupParentMirror = cachedNode?.parentId ? getNodeFromCache(cachedNode.parentId) : null;
            const isGroupChildMirror = cachedNode?.type === 'svg' && groupParentMirror?.type === 'svg';
            let mirror = rest;
            if (isGroupChildMirror) {
              mirror = {};
              for (const [k, v] of Object.entries(rest)) {
                if (k === 'left') { mirror.x = '0'; mirror.attrX = ''; }
                else if (k === 'top') { mirror.y = '0'; mirror.attrY = ''; }
                else mirror[k] = v;
              }
            }
            updates.push({ nodeId, type: 'updateVariantStyle', variantName: 'default', styles: mirror });
          }
        }
        return updates;
      } else {
        // Replica: route to the correct responsive/variant system
        if (isComponent) {
          const updates: PendingUpdate[] = [...condUpdates];
          if (pushRest) {
            // A GROUP CHILD (a nested <svg> inside a group <svg>) is positioned by
            // x/y ATTRIBUTES, not CSS left/top. Routing left/top into the variant
            // object does nothing — the child reads its SHARED x/y attr and snaps
            // back to the primary. Convert to per-variant x/y translate DELTAS
            // from the base attrs (see leftTopToXY — the probe-verified live
            // channel; detachment from primary edits is the orchestrator's
            // delta-compensation job).
            const groupParent = cachedNode?.parentId ? getNodeFromCache(cachedNode.parentId) : null;
            const isGroupChild = cachedNode?.type === 'svg' && groupParent?.type === 'svg';
            let variantStyles = rest;
            if (isGroupChild) {
              const conv = groupChildBoxToMotion(rest, cachedNode as any, variantName!);
              variantStyles = conv.styles;
              // The scale (like the per-variant rotation) paints about the
              // shape's own center only with the view-box px carrier inline
              // on the SHARED wrapper — inert on variants without transforms.
              if (conv.needsCarrier) {
                const carrier = svgChildCarrierOrigin(cachedNode?.attrs, groupParent?.attrs?.viewBox);
                if (cachedNode?.styles?.transformBox !== carrier.transformBox
                  || cachedNode?.styles?.transformOrigin !== carrier.transformOrigin) {
                  updates.push({ nodeId, type: 'updateStyles', styles: carrier as unknown as Record<string, string> });
                }
              }
              // GEOMETRY channel (rotated children): the size lands as a
              // per-variant `d` on every inner geometry child. Seed the
              // default with the BASE d (the animate-back return path) and
              // every OTHER variant lacking a d too — motion keeps the LAST
              // animated d when switching to an entry without one (the same
              // transform law that seeds rotate/scale neutrals).
              // SPARSE source (inheritance model): only the touched variant
              // gets a d; the default keeps the base d as the animate-back
              // value. Untouched variants inherit via the paint/runtime merge.
              for (const ig of conv.innerGeometry) {
                updates.push({ nodeId: ig.nodeId, type: 'updateVariantStyle', variantName: variantName!, styles: { d: ig.d } });
                const innerNode = getNodeFromCache(ig.nodeId);
                if (innerNode?.motionVariants?.default?.d == null) {
                  updates.push({ nodeId: ig.nodeId, type: 'updateVariantStyle', variantName: 'default', styles: { d: ig.baseD } });
                }
              }
              if (conv.sizeChannel) {
                trace.action('replica-context:group-child-size-channel', {
                  nodeId, variantName, channel: conv.sizeChannel, innerCount: conv.innerGeometry.length,
                });
              }
            }
            updates.push({ nodeId, type: 'updateVariantStyle', variantName: variantName!, styles: variantStyles });
          }
          return updates;
        } else {
          return [{ nodeId, type: 'updateContainerStyle', maxWidth: vpWidth, styles }];
        }
      }
    },

    exitToCanvas(nodeId: string, styles: Record<string, string>): PendingUpdate {
      trace.action('replica-context:exitToCanvas', { nodeId, vpId, styleKeys: Object.keys(styles) });
      return {
        nodeId,
        type: 'move',
        newParentId: null,
        canvasNode: true,
        styles,
      };
    },

    deleteUpdate(nodeId: string, contentEl: HTMLElement): PendingUpdate[] {
      trace.action('replica-context:deleteUpdate', { nodeId, vpId, isPrimary, isComponent });

      if (isPrimary) {
        // Primary: always full remove
        return [{ nodeId, type: 'remove' }];
      }

      if (isComponent) {
        // COMPONENT MASTER: don't probe the DOM — the canvas renders inside a
        // sandboxed iframe, so `contentEl.querySelector` (parent frame) never
        // reaches the variant tiles and always counted 0 → every delete fell
        // through to a full remove. Use the node METADATA instead, which is the
        // actual source of truth: a node is visible in variant V unless V is in
        // its `hiddenOnVariants` set (the AnimatePresence-conditional flag).
        //
        // Compute how many variants would STILL show the node after hiding it
        // in the current one. If that's 0 → this was its last variant → full
        // remove (+ connection cleanup downstream). Otherwise it's synced to
        // other variants → just hide it here (hiddenOnVariants /
        // setVariantVisibility), exactly the user's "hide node true on that
        // variant child."
        const node = getNodeFromCache(nodeId);
        const allVariants = getAllVariantNames();
        const currentVariant = isPrimary ? 'default' : vpId;
        const hiddenAfter = new Set(node?.hiddenOnVariants ?? []);
        hiddenAfter.add(currentVariant);
        const stillVisible = allVariants.filter(v => !hiddenAfter.has(v));

        trace.action('replica-context:deleteUpdate:visibility', {
          nodeId, vpId, isComponent: true, currentVariant,
          allVariants, hiddenAfter: Array.from(hiddenAfter), stillVisibleCount: stillVisible.length,
        });

        if (stillVisible.length === 0) {
          return [{ nodeId, type: 'remove' }];
        }
        return [ctx.hideInThis(nodeId)];
      }

      // PAGE replica (non-primary). The node's base JSX renders on the PRIMARY
      // viewport — we're deleting an EXISTING node, so its base exists — UNLESS its
      // base style is `display: none`. So deleting from a replica HIDES here
      // (@container display:none) and keeps the primary; it must NOT full-remove,
      // which would delete the JSX from EVERY tile. (Metadata, not a live-DOM probe:
      // the old probe used `contentEl.querySelector` from the PARENT frame, which
      // misses a COMPONENT-INSTANCE wrapper rendered in the iframe's other tiles →
      // it counted 0 visible → wrongly full-removed the whole instance. Same fix the
      // component-master path made — trust the metadata, not the DOM.)
      const node = getNodeFromCache(nodeId);
      const baseDisplay = node?.styles?.display ?? '';
      const baseVisibleOnPrimary = baseDisplay !== 'none';

      trace.action('replica-context:deleteUpdate:visibility', {
        nodeId, vpId, baseVisibleOnPrimary, baseDisplay,
      });

      if (baseVisibleOnPrimary) {
        // Base renders on primary → hide on THIS replica only (the reference "Remove here").
        return [ctx.hideInThis(nodeId)];
      }

      // Base is hidden on primary too — fall back to a DOM probe of the other REPLICAS;
      // if the node shows in any, hide here, else there's nowhere left → full remove.
      const visibleVpIds: string[] = [];
      for (const otherVpId of Object.keys(vpWidths)) {
        if (otherVpId === vpId || isPrimaryViewport(otherVpId)) continue;
        const el = contentEl.querySelector(`[data-node-id="${otherVpId}-${nodeId}"]`) as HTMLElement | null;
        if (el && window.getComputedStyle(el).display !== 'none') visibleVpIds.push(otherVpId);
      }
      return visibleVpIds.length === 0 ? [{ nodeId, type: 'remove' }] : [ctx.hideInThis(nodeId)];
    },
  };

  return ctx;
}
