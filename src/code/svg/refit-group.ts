// refit-group.ts — Recompute a group SVG's style + viewBox to fit its
// children after one of them has moved or resized.
//
// Why this exists: when a child of a group SVG moves (drag, resize), its
// new x/y/width/height get written into the source via `updateHtmlAttrs`.
// The group itself, however, keeps its old declared `style.width/height`
// + `viewBox` — so even though child paint is correct (overflow:visible
// lets it spill past the group's box), the SELECTION rect drawn around
// the group still shows the old pre-edit bounds and the user sees a
// disconnect between "what's painted" and "what's selected".
//
// `refitGroupBounds` reads the group's source, parses every child's
// current x/y/width/height, computes their union bbox, then rewrites:
//
//   1. The group's `style.left/top/width/height` (so it sits at the new
//      union top-left and is the new union size).
//   2. The group's `viewBox` (matches the new dimensions, 1:1 scale).
//   3. Each child's `x/y` shifted by the bbox origin delta so the
//      visual position stays put through the wrapper relocation.
//
// Done in ONE `modifyProjectFile` transaction so source never lands in
// an inconsistent state — children-shifted-but-group-not-resized would
// produce one frame of jumpy re-paint.

import { modifyProjectFile } from '../project/modify-file';
import { getNodeFromCache, injectNodeIntoCache } from '@/code/stores/store';
import { geometryBBox, geometryVertices, translateShapeGeometry, transformShapeGeometry, rotatedLinearAffine, mulLinear2, rotLinear2, type Linear2, type Affine6 } from '@/shared/svg-geometry';
import { r3, computeScaledChildPatches, parseRotateTransform, type GroupResizeSnapshot, type GroupChildSnapshot } from './group-resize-bake';
import { trace } from '@/shared/debug-trace';

// ─── Motion-aware <svg> token scanning ──────────────────────────────────────
// Group wrappers and children can be `<motion.svg>` (per-variant rotation /
// geometry wiring makes the child a motion component). Every structural scan
// in this module must treat `<svg` / `<motion.svg` (and their closing tags)
// as the SAME token. A plain `indexOf('<svg')` is motion-BLIND: parseChildren
// skipped motion children entirely, so the union refit shrink-wrapped the
// group to only the plain children (the 2026-06-12 "group completely shrinks
// in the wrong directions" break), and `setChildAttrsInSource` walked back
// past the motion child's own tag onto its plain SIBLING — resizing the
// wrong shape while the real target kept its stale attrs.
function svgOpenLastBefore(code: string, idx: number): number {
  return Math.max(code.lastIndexOf('<svg', idx), code.lastIndexOf('<motion.svg', idx));
}
function svgOpenNext(code: string, from: number): { idx: number; len: number } {
  const a = code.indexOf('<svg', from);
  const b = code.indexOf('<motion.svg', from);
  if (a === -1 && b === -1) return { idx: -1, len: 0 };
  if (b === -1 || (a !== -1 && a < b)) return { idx: a, len: 4 };
  return { idx: b, len: 11 };
}
function svgCloseNext(code: string, from: number): { idx: number; len: number } {
  const a = code.indexOf('</svg>', from);
  const b = code.indexOf('</motion.svg>', from);
  if (a === -1 && b === -1) return { idx: -1, len: 0 };
  if (b === -1 || (a !== -1 && a < b)) return { idx: a, len: 6 };
  return { idx: b, len: 13 };
}
/** Length of the closing token a child BLOCK ends with. */
function blockCloseLen(block: string): number {
  return block.endsWith('</motion.svg>') ? 13 : 6;
}
/** "Contains a nested svg wrapper" — group-vs-shape child detection. */
const NESTED_SVG_RE = /<(?:motion\.)?svg[\s/>]/;

/** Rotation of a MOTION group child. The unified rotation channel stores the
 *  primary rotation in the child's variants const DEFAULT entry with a
 *  view-box PX carrier origin in `style` — there is NO `transform="rotate()"`
 *  attr for the source scanners to see. The carrier origin is expressed in
 *  the PARENT's user space, which is exactly the `rotate(θ cx cy)` pivot
 *  convention this module already uses — so a motion child's rotation maps
 *  1:1 onto the attr form for all bounds/refit math. Without this fallback
 *  the refit unions the UN-rotated bbox and the commit jumps (live repro
 *  2026-06-12: −16.7px top snap on a rotated child resize). */
function parseMotionChildRotation(code: string, openText: string): { angle: number; cx: number; cy: number } | null {
  const om = openText.match(/transformOrigin\s*:\s*['"](-?[\d.]+)px\s+(-?[\d.]+)px['"]/);
  if (!om) return null;
  let angle = NaN;
  // (a) motion child: rotation in the variants const DEFAULT entry
  const vName = openText.match(/variants=\{(\w+)\}/)?.[1];
  if (vName) {
    const cm = code.match(new RegExp(`const ${vName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
    const dm = cm?.[1]?.match(/default\s*:\s*\{([^}]*)\}/);
    const rm = dm?.[1]?.match(/rotate\s*:\s*['"]?(-?[\d.]+)/);
    if (rm) angle = parseFloat(rm[1]);
  }
  // (b) canvas-node child (module scope, no variants wiring): plain inline
  // CSS `rotate` property in the style block, same px carrier origin.
  if (!Number.isFinite(angle)) {
    const sm = openText.match(/\brotate\s*:\s*['"](-?[\d.]+)(?:deg)?['"]/);
    if (sm) angle = parseFloat(sm[1]);
  }
  if (!Number.isFinite(angle) || Math.abs(angle) < 0.001) return null;
  return { angle, cx: parseFloat(om[1]), cy: parseFloat(om[2]) };
}

/** Re-pin a motion child's carrier origin to its (new) box centre. The
 *  carrier origin is parent-user-space px at the attr-box centre — any bake
 *  that rewrites the box must move the pivot with it, or the NEXT gesture
 *  starts from a stale pivot and jumps (group-resize repro 2026-06-12:
 *  committed origin stayed at the pre-resize centre). No-op without a px
 *  transformOrigin. */
function setMotionOriginToBoxCentre(tag: string, x: number, y: number, w: number, h: number): string {
  return tag.replace(
    /(transformOrigin\s*:\s*['"])(-?[\d.]+)px\s+(-?[\d.]+)px(['"])/,
    `$1${r3(x + w / 2)}px ${r3(y + h / 2)}px$4`,
  );
}

/** Shift a motion child's carrier-origin pivot by (dx, dy) — the motion
 *  counterpart of `shiftRotatePivotInTag` for refit re-basing. No-op when the
 *  tag has no px transformOrigin. */
function shiftMotionOriginInTag(tag: string, dx: number, dy: number): string {
  return tag.replace(
    /(transformOrigin\s*:\s*['"])(-?[\d.]+)px\s+(-?[\d.]+)px(['"])/,
    (_m, pre, ox, oy, post) => `${pre}${r3(parseFloat(ox) + dx)}px ${r3(parseFloat(oy) + dy)}px${post}`,
  );
}

/**
 * The post-refit final state of a child + its group, returned by
 * `moveChildAndRefitGroup` so the caller can pre-patch the iframe DOM
 * with the SAME values that source ends up at — preventing the flash
 * where bridge-DOM and renderer-applied-source briefly disagree.
 */
export interface MoveAndRefitResult {
  /** Post-refit attrs for the moved child (x/y/width/height). */
  childAttrs: Record<string, string>;
  /** Post-refit attrs for every other child that was shifted. Keyed by
   *  child id so the caller can patch each in iframe DOM. */
  siblingAttrs: Map<string, Record<string, string>>;
  /** Post-refit styles for the group wrapper (left/top/width/height, plus
   *  `transformOrigin` when the group is rotated — see `groupTransformOrigin`). */
  groupStyles: Record<string, string>;
  /** Post-refit viewBox for the group. */
  groupViewBox: string;
  /** Post-refit rotation pivot (`transform-origin`) = the new painted-content
   *  centre. Empty string when the group is not rotated. Kept fresh so a later
   *  rotate pivots on the visible centre (Bug B). */
  groupTransformOrigin: string;
}

/**
 * Apply a child's new x/y (and optionally width/height) AND refit the
 * group's bbox to encompass the new union — all in ONE source mutation.
 * Returns the final post-refit state so the caller can mirror it to
 * the iframe DOM via the bridge in the same tick.
 *
 * Why combined: applying the two as separate `modifyProjectFile` calls
 * leaves a microtask window where atoms are inconsistent (child at new
 * x/y, group still at old origin). The Renderer's RAF can fire in that
 * gap and paint with mismatched values: the painted child snaps to
 * `oldGroup.left + newChild.x`, which is hundreds of pixels off where
 * the user dropped it. Single transaction = single atom update = no
 * intermediate render.
 *
 * Why return the final state: even with one transaction, the caller
 * was previously bridge-patching the iframe DOM with the PRE-refit
 * drag values (e.g. `x="-2327"`), then source landed with POST-refit
 * shifted values (`x="0"` + group moved). Renderer applied the group's
 * new origin a frame before patching the child's new x — visible jump
 * to `(newGroupLeft + bridgeChildX) = -7132` for one frame. By
 * returning final values, the bridge patch can land them too, so
 * bridge-DOM matches source-DOM and the renderer's update is a no-op.
 */
export function moveChildAndRefitGroup(
  filePath: string,
  groupId: string,
  childId: string,
  attrs: Record<string, string>,
): MoveAndRefitResult | null {
  let result: MoveAndRefitResult | null = null;
  modifyProjectFile(filePath, (code) => {
    // The drag-commit path writes the child's x/y via a prior `flushNow()`
    // BEFORE calling us, so `setChildAttrsInSource` is frequently a NO-OP here
    // (the attrs already match). That must NOT skip the refit — otherwise the
    // group never normalizes (its CSS box / viewBox stay stale while children
    // spill outside), which breaks rotation (transform-origin ends up off the
    // box centre) and selection geometry. Only bail when the child genuinely
    // isn't in source; run the refit whenever it exists.
    if (code.indexOf(`data-id="${childId}"`) === -1) {
      trace.action('move-child-refit:child-not-found', { childId });
      return code;
    }
    let mutated = setChildAttrsInSource(code, childId, attrs);
    // Refit ALSO for rotated groups. Previously this was skipped because a
    // plain translation refit JUMPS a rotated group on mouseup — but leaving
    // the box un-refit let it drift away from the painted content, which broke
    // rotated-group resize (the box and the visible content diverged, so
    // resizing one edge moved the opposite corner / felt scaled). The refit is
    // now rotation-aware (`rotatedRefitPosition`), so the box stays tight to
    // the content WITHOUT a jump, keeping box == content == centred pivot — the
    // invariant the resize + selection both rely on.
    const refit = refitGroupInSourceWithResult(mutated, groupId, childId);
    if (refit) {
      mutated = refit.code;
      result = refit.result;
    } else {
      // Refit no-op (already snug) — child attrs are still what we wrote.
      result = {
        childAttrs: { ...attrs },
        siblingAttrs: new Map(),
        groupStyles: {},
        groupViewBox: '',
        groupTransformOrigin: '',
      };
    }
    return mutated;
  });
  if (result) seedRefitResultIntoCache(groupId, childId, result);
  return result;
}

/**
 * Mirror a just-committed refit into the IMPERATIVE node cache. Mid-gesture
 * forced renders ship `getCachedNodesMap()` (Canvas.tsx force-render wiring —
 * nodesAtom is intentionally stale while deferred-drag-flush stashes the
 * fan-out), and `updateNodeInCache` mirrors STYLES only, so without this seed
 * the render repaints the PRE-refit wrapper (old viewBox/box + un-shifted
 * siblings). That Frankenstein DOM PAINTS correctly (a refit is a pure
 * re-base), but the wrapper frame is one refit behind the model — the next
 * group-child drag then writes model-frame coords into the stale frame and
 * offsets from the cursor for the whole gesture (stable only on the first
 * drag after reload; user report 2026-07-28). Seeding here covers every
 * caller: the drag commit (CanvasDragOrchestrator, which also seeds its
 * rotated-pivot transform on top) and the group-child resize commit
 * (ResizeManager → updateNodeStyles).
 */
function seedRefitResultIntoCache(groupId: string, childId: string, result: MoveAndRefitResult): void {
  const seedAttrs = (nid: string, attrs: Record<string, string>) => {
    const n = getNodeFromCache(nid);
    if (n) injectNodeIntoCache({ ...n, attrs: { ...n.attrs, ...attrs } });
  };
  seedAttrs(childId, result.childAttrs);
  for (const [siblingId, siblingAttrs] of result.siblingAttrs) seedAttrs(siblingId, siblingAttrs);
  const group = getNodeFromCache(groupId);
  if (group) {
    injectNodeIntoCache({
      ...group,
      attrs: { ...group.attrs, ...(result.groupViewBox ? { viewBox: result.groupViewBox } : {}) },
      styles: { ...group.styles, ...result.groupStyles },
    });
  }
  trace.action('refit-group:cache-seeded', {
    groupId,
    childId,
    siblingCount: result.siblingAttrs.size,
    groupViewBox: result.groupViewBox,
  });
}

/**
 * Normalize a group SVG so its viewBox matches its pixel dimensions
 * (1 viewBox unit = 1 pixel). Required after a resize that changes the
 * group's CSS width/height — without this, the viewBox stays at the OLD
 * dimensions, CSS scales the children visually, and:
 *
 *   • Children's source x/y/width/height are now in viewBox units that
 *     no longer match pixels — drag deltas (in pixels) get written as
 *     viewBox units, producing "moves very slowly" symptom (cursor moves
 *     N pixels, child moves N * scaleRatio pixels).
 *   • `moveChildAndRefitGroup`'s shrink-wrap reads children's bbox in
 *     viewBox units and rewrites the group's pixel dimensions to match
 *     — undoing the user's resize ("reverts to size before resize").
 *
 * The fix: rescale all children's x/y/width/height by the
 * (newPixelDim / oldViewBoxDim) ratio AND set viewBox = "0 0 newW newH".
 * Source ends up 1:1 again. Drag math from this point on works in pixels
 * because viewBox units == pixels.
 *
 * Idempotent — if viewBox already matches dimensions, no-op.
 */
export function normalizeGroupOnResize(
  filePath: string,
  groupId: string,
  newWidthPx: number,
  newHeightPx: number,
  // Optional new left/top (px). A TOP/LEFT-edge resize moves the group's
  // position together with its size; writing left/top HERE (in the same
  // transaction as width/height/viewBox/children) keeps the post-resize
  // render fully consistent. Writing them separately afterwards caused a
  // 1-frame JUMP on mouseup — the new size painted at the OLD position,
  // then corrected. Omitted for bottom/right resizes (position unchanged).
  newLeftPx?: number,
  newTopPx?: number,
): void {
  modifyProjectFile(filePath, (code) => {
    const group = findGroupSvg(code, groupId);
    if (!group) {
      trace.action('normalize-group:not-found', { groupId });
      return code;
    }
    // Apply any left/top move to the group's box. A NESTED group's box is
    // `x/y/width/height` ATTRIBUTES (parent group's user space), so left→x and
    // top→y go on attributes; a top-level group's box is `style.left/top`.
    // Shared by both the "already 1:1" early-out and the full-normalize path so
    // the position write is never dropped.
    const applyPosition = (groupOpen: string): string => {
      let out = groupOpen;
      // Keep ~3 decimals (not integer) so a rotated group's opposite corner —
      // which the resize pins precisely — doesn't creep ≤0.5px on commit.
      if (newLeftPx != null && Number.isFinite(newLeftPx)) {
        out = group.nested ? setAttr(out, 'x', `${r3(newLeftPx)}`) : setStyleNumberInJsxOpen(out, 'left', r3(newLeftPx));
      }
      if (newTopPx != null && Number.isFinite(newTopPx)) {
        out = group.nested ? setAttr(out, 'y', `${r3(newTopPx)}`) : setStyleNumberInJsxOpen(out, 'top', r3(newTopPx));
      }
      return out;
    };
    // A ROTATED group rotates around a px `transform-origin` (its painted-
    // content centre, NOT the box centre). When children scale by (scaleX,
    // scaleY) the content centre scales with them, so the origin must scale
    // too — otherwise the committed rotation pivots around the OLD point and
    // the group jumps on mouseup. The resize's live pivot tracks the same
    // fraction-of-box, so scaling here keeps live == committed. Applied to a
    // group-open string in the same transaction.
    const applyOriginScale = (groupOpen: string, scaleX: number, scaleY: number): string => {
      const om = groupOpen.match(/transformOrigin\s*:\s*["'](-?[\d.]+)px\s+(-?[\d.]+)px["']/);
      if (!om) return groupOpen;
      const nx = r3(parseFloat(om[1]) * scaleX);
      const ny = r3(parseFloat(om[2]) * scaleY);
      return setStyleStr(groupOpen, 'transformOrigin', `${nx}px ${ny}px`);
    };
    // Read CURRENT viewBox to determine the OLD coordinate scale.
    const vbMatch = group.openText.match(/viewBox="([^"]+)"/);
    if (!vbMatch) return code;
    const parts = vbMatch[1].trim().split(/\s+/).map(parseFloat);
    if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return code;
    const [, , oldVbW, oldVbH] = parts;
    if (!oldVbW || !oldVbH) return code;
    const scaleX = newWidthPx / oldVbW;
    const scaleY = newHeightPx / oldVbH;
    // Already 1:1 — no viewBox/child scaling needed. Still apply any left/top
    // move so a position-only change in this transaction isn't lost.
    if (Math.abs(scaleX - 1) < 0.001 && Math.abs(scaleY - 1) < 0.001) {
      trace.action('normalize-group:already-1to1', { groupId, scaleX, scaleY, hasPos: newLeftPx != null || newTopPx != null });
      const posOnly = applyPosition(group.openText);
      if (posOnly === group.openText) return code;
      return code.slice(0, group.tagStart) + posOnly + code.slice(group.tagEnd + 1);
    }

    const childCount = parseChildren(code, group.bodyStart, group.bodyEnd).length;
    // A TOP-LEVEL FLEX/FLOW group's live preview is the browser viewBox STRETCH
    // (scale applied in the group's own frame → rotated nested content SHEARS to
    // fill the box, no gap). Bake that EXACTLY (structure + rotations preserved) so
    // commit == live with no mouseup snap. An ABSOLUTE (canvas) group or a NESTED
    // group instead previews via the R·S bake, so they keep the plain per-frame
    // scale (which already matches their live). [[groups-in-groups-recursive]]
    const groupIsAbsolute = /\bleft\s*:\s*["']/.test(group.openText) && /\btop\s*:\s*["']/.test(group.openText);
    const useShearBake = !group.nested && !groupIsAbsolute;
    let mutated = useShearBake
      ? stretchGroupChildrenSource(code, group, scaleX, scaleY)
      : scaleGroupChildrenSource(code, group, scaleX, scaleY);
    // Update group viewBox to match new pixel dimensions AND write the
    // new style.width/height in the SAME source transaction. Without
    // updating style.width/height here, the standard updateNodeStyles
    // path that runs AFTER normalize would do it via a separate write +
    // version bump — and the React render that fires from THIS write
    // would briefly paint with new viewBox + old style.width, so the
    // group flashes at its old pixel size for one frame before the
    // standard write lands. Atomic = no flash.
    // Keep ~3 decimals (viewBox == width/height stays exactly 1:1) so a rotated
    // group's corners pin precisely instead of creeping ≤0.5px on commit.
    let newGroupOpen = group.openText.replace(/viewBox="[^"]+"/, `viewBox="0 0 ${r3(newWidthPx)} ${r3(newHeightPx)}"`);
    // Nested group: size lives in `width/height` ATTRIBUTES; top-level: in style.
    if (group.nested) {
      newGroupOpen = setAttr(newGroupOpen, 'width', `${r3(newWidthPx)}`);
      newGroupOpen = setAttr(newGroupOpen, 'height', `${r3(newHeightPx)}`);
    } else {
      newGroupOpen = setStyleNumberInJsxOpen(newGroupOpen, 'width', r3(newWidthPx));
      newGroupOpen = setStyleNumberInJsxOpen(newGroupOpen, 'height', r3(newHeightPx));
    }
    // Same transaction: apply the TOP/LEFT-edge position move so the new
    // size never paints at the old position for a frame (the mouseup jump).
    newGroupOpen = applyPosition(newGroupOpen);
    // Scale the rotation pivot with the children so a rotated group's
    // committed pivot matches the live-resize pivot (no mouseup swing).
    newGroupOpen = applyOriginScale(newGroupOpen, scaleX, scaleY);
    // A ROTATED nested group rotates via `transform="rotate(θ cx cy)"` (pivot in
    // PARENT user space). The resize moves/resizes its box, so the pivot must
    // follow to the NEW box centre (== content centre after the scale) — else
    // every resize rotates about a STALE point and the group jumps. Top-level
    // groups use the CSS transformOrigin (handled by applyOriginScale above).
    if (group.nested) {
      const nx = (newLeftPx != null && Number.isFinite(newLeftPx)) ? newLeftPx : group.left;
      const ny = (newTopPx != null && Number.isFinite(newTopPx)) ? newTopPx : group.top;
      const pcx = r3(nx + newWidthPx / 2);
      const pcy = r3(ny + newHeightPx / 2);
      newGroupOpen = newGroupOpen.replace(
        /transform="rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)"/,
        (_m, ang) => `transform="rotate(${ang} ${pcx} ${pcy})"`,
      );
    }
    mutated = mutated.slice(0, group.tagStart) + newGroupOpen + mutated.slice(group.tagEnd + 1);

    trace.action('normalize-group:committed', {
      groupId, oldVbW, oldVbH, newWidthPx, newHeightPx, scaleX, scaleY, childCount,
      newLeftPx, newTopPx,
    });
    return mutated;
  });
}

/** Rewrite a `key: 'Npx'` (or numeric) entry inside a JSX `style={{ ... }}`
 *  attribute on an opening tag. Only touches the FIRST style block on the
 *  tag, which is fine for our generated SVG groups (one style attr each). */
function setStyleNumberInJsxOpen(openTag: string, key: string, valuePx: number): string {
  const styleAttrMatch = openTag.match(/style=\{\{([^}]+)\}\}/);
  if (!styleAttrMatch) return openTag;
  const body = styleAttrMatch[1];
  const re = new RegExp(`(['"]?${key}['"]?\\s*:\\s*)['"][^'"]*['"]`);
  let newBody: string;
  if (re.test(body)) {
    newBody = body.replace(re, `$1'${valuePx}px'`);
  } else {
    // Append at end (rare — width/height almost always present on groups).
    const trimmed = body.replace(/,\s*$/, '');
    newBody = `${trimmed}, ${key}: '${valuePx}px'`;
  }
  return openTag.replace(/style=\{\{[^}]+\}\}/, `style={{${newBody}}}`);
}

/** Pure helper: apply attrs to the child SVG with `data-id="${childId}"`.
 *  Returns unchanged code on miss so callers can fail safely. */
function setChildAttrsInSource(code: string, childId: string, attrs: Record<string, string>): string {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return code;
  const marker = `data-id="${childId}"`;
  const markerIdx = code.indexOf(marker);
  if (markerIdx === -1) return code;
  const tagStart = svgOpenLastBefore(code, markerIdx);
  if (tagStart === -1) return code;
  const tagEnd = code.indexOf('>', markerIdx);
  if (tagEnd === -1) return code;
  let tagText = code.slice(tagStart, tagEnd + 1);
  for (const key of keys) {
    tagText = setAttrOnTag(tagText, key, attrs[key]);
  }
  return code.slice(0, tagStart) + tagText + code.slice(tagEnd + 1);
}

function setAttrOnTag(tag: string, key: string, value: string): string {
  const re = new RegExp(`(\\s${key}=)"[^"]*"`);
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  if (tag.endsWith('/>')) return tag.slice(0, -2) + ` ${key}="${value}" />`;
  return tag.slice(0, -1) + ` ${key}="${value}">`;
}

interface ChildSvg {
  /** Source range of the entire `<svg ...>...</svg>` block. */
  start: number;
  end: number;
  /** Source range of the opening tag (`<svg ...>`). */
  tagStart: number;
  tagEnd: number;
  /** Start index + token length of the CLOSING tag (`</svg>` is 6,
   *  `</motion.svg>` is 13) — never assume the plain-token length. */
  closeStart: number;
  closeLen: number;
  /** The opening tag's full text — we rewrite x/y attrs in-place here. */
  openText: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Refit a group SVG's bounds to its children's union bbox. Idempotent —
 * if the group is already snug around its children (within 0.5 px), this
 * is a no-op. Reads the group's data-id and walks each top-level inner
 * `<svg>` child to compute the union.
 */
export function refitGroupBounds(groupId: string, filePath: string): void {
  modifyProjectFile(filePath, (code) => refitGroupInSource(code, groupId));
}

/**
 * Refit a CHAIN of nested groups bottom-up in ONE transaction. `groupIdsBottomUp`
 * is the deepest-first list of `<svg>`-group ancestors affected by a change
 * (e.g. `[innerGroup, outerGroup]`) — typically built by walking a changed
 * node's `parentId` while the parent is an svg group (see
 * `getSvgGroupAncestorChain` in node-ops).
 *
 * Why bottom-up + single transaction: refitting the inner group resizes its
 * attribute box, which grows the outer group's child union; the next iteration
 * re-reads the mutated source and absorbs it. Doing each level as a separate
 * `modifyProjectFile` would leave a render window where the outer box is stale
 * relative to the inner — the exact "one level fixed, parent still wrong"
 * symptom. This keeps EVERY level snug after any descendant change, which is
 * what makes selection / rotation / resize correct at arbitrary nesting depth.
 */
export function refitGroupChain(groupIdsBottomUp: string[], filePath: string): void {
  if (groupIdsBottomUp.length === 0) return;
  trace.action('refit-group-chain', { chain: groupIdsBottomUp });
  // Collect each level's post-refit values so the imperative cache can be
  // seeded after the transaction — a mid-gesture forced render ships the
  // cache (see seedRefitResultIntoCache), and without seeding the OUTER
  // levels the render would mix a fresh inner group into a stale outer frame.
  const seeds: Array<{ gid: string; result: MoveAndRefitResult }> = [];
  modifyProjectFile(filePath, (code) => {
    let out = code;
    for (const gid of groupIdsBottomUp) {
      const r = refitGroupInSourceWithResult(out, gid, '');
      if (r) {
        out = r.code;
        seeds.push({ gid, result: r.result });
      } else {
        // No-op / normalize-only levels: the pure twin preserves those edge
        // paths (returns normalized source where WithResult returns null).
        out = refitGroupInSource(out, gid);
      }
    }
    return out;
  });
  for (const s of seeds) seedRefitResultIntoCache(s.gid, '', s.result);
}

/** Extract `name="value"` attributes from a tag's attribute string. */
function parseTagAttrs(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr))) out[m[1]] = m[2];
  return out;
}

const GEOM_TAG_RE = /<(?:motion\.)?(path|polygon|polyline|rect|ellipse|circle|line)\b([^>]*?)(\/?)>/;

/** Scale every child of a group by (scaleX, scaleY) for a GROUP resize: box
 *  x/y/width/height AND viewBox AND geometry AND any inner rotate-pivot, so the
 *  child stays 1:1 (viewBox == box) and a rotated child gets a clean rotate·scale
 *  (no shear). RECURSIVE: a child that is itself a GROUP (contains nested `<svg>`)
 *  scales its OWN box + viewBox, then recurses so its descendants scale by the
 *  SAME factor — a nested group then scales identically to a shape (its content
 *  follows the resize at any depth), instead of staying put. Pure source
 *  transform. */
function scaleGroupChildrenSource(code: string, group: GroupSvgRange, scaleX: number, scaleY: number): string {
  const children = parseChildren(code, group.bodyStart, group.bodyEnd);
  // Process end → start so earlier children's source indices stay valid through
  // splices AND recursion (a child's whole `<svg>…</svg>` region is independent
  // of its lower-index siblings).
  let mutated = code;
  for (const c of [...children].sort((a, b) => b.tagStart - a.tagStart)) {
    const vbM = c.openText.match(/viewBox="([^"]+)"/);
    if (!vbM) continue;
    const [vbx, vby, vbw, vbh] = vbM[1].trim().split(/[\s,]+/).map(Number);
    if (!(vbw > 0) || !(vbh > 0)) continue;
    const innerStart = c.tagEnd + 1;
    const closeStart = c.closeStart;
    const innerHtml = mutated.slice(innerStart, closeStart);

    if (NESTED_SVG_RE.test(innerHtml)) {
      // GROUP CHILD — recurse into its children (rewrites the inner content,
      // which lies AFTER this child's open tag, so the open-tag indices stay
      // valid), THEN scale its own box + viewBox + any rotate pivot.
      const nestedRange: GroupSvgRange = {
        tagStart: c.tagStart, tagEnd: c.tagEnd,
        bodyStart: innerStart, bodyEnd: closeStart,
        openText: c.openText, nested: true,
        width: c.width, height: c.height, left: c.x, top: c.y,
      };
      mutated = scaleGroupChildrenSource(mutated, nestedRange, scaleX, scaleY);
      let openText = c.openText;
      openText = setAttr(openText, 'x', `${r3(c.x * scaleX)}`);
      openText = setAttr(openText, 'y', `${r3(c.y * scaleY)}`);
      openText = setAttr(openText, 'width', `${r3(c.width * scaleX)}`);
      openText = setAttr(openText, 'height', `${r3(c.height * scaleY)}`);
      openText = setAttr(openText, 'viewBox', `${r3(vbx * scaleX)} ${r3(vby * scaleY)} ${r3(vbw * scaleX)} ${r3(vbh * scaleY)}`);
      // A rotated nested group's `rotate(θ cx cy)` pivot is in THIS group's user
      // space — scale it with everything else.
      const rm = openText.match(/transform="rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)"/);
      if (rm) openText = openText.replace(/transform="rotate\([^"]*\)"/, `transform="rotate(${rm[1]} ${r3(parseFloat(rm[2]) * scaleX)} ${r3(parseFloat(rm[3]) * scaleY)})"`);
      openText = setMotionOriginToBoxCentre(openText, c.x * scaleX, c.y * scaleY, c.width * scaleX, c.height * scaleY);
      mutated = mutated.slice(0, c.tagStart) + openText + mutated.slice(c.tagEnd + 1);
    } else {
      // SHAPE CHILD — scale box + viewBox + geometry via the SHARED math
      // (rotated shapes get the M = R(-θ)·S·R(θ) shear, identical to the live bake).
      const childId = c.openText.match(/data-id="([^"]+)"/)?.[1];
      const gm = innerHtml.match(GEOM_TAG_RE);
      if (!childId || !gm || gm.index === undefined) continue;
      const geomAttrs = parseTagAttrs(gm[2]);
      const snap: GroupChildSnapshot = {
        childId, x: c.x, y: c.y, width: c.width, height: c.height,
        vbx: vbx || 0, vby: vby || 0, vbw, vbh,
        geomId: geomAttrs['data-id'] || '', geomTag: gm[1], geomAttrs,
        rotate: parseRotateTransform(geomAttrs.transform),
      };
      const [p] = computeScaledChildPatches({ origVbW: 0, origVbH: 0, children: [snap] }, scaleX, scaleY);
      // Geometry FIRST (after the open tag, so open-tag indices stay valid), then open tag.
      const geomAbsStart = innerStart + gm.index;
      let newGeom = gm[0];
      for (const [k, v] of Object.entries(p.geomAttrs)) newGeom = setAttrOnTag(newGeom, k, v);
      mutated = mutated.slice(0, geomAbsStart) + newGeom + mutated.slice(geomAbsStart + gm[0].length);
      let openText = c.openText;
      for (const [k, v] of Object.entries(p.childAttrs)) openText = setAttr(openText, k, v);
      openText = setMotionOriginToBoxCentre(
        openText,
        parseFloat(p.childAttrs.x ?? `${c.x}`) || 0,
        parseFloat(p.childAttrs.y ?? `${c.y}`) || 0,
        parseFloat(p.childAttrs.width ?? `${c.width}`) || 0,
        parseFloat(p.childAttrs.height ?? `${c.height}`) || 0,
      );
      mutated = mutated.slice(0, c.tagStart) + openText + mutated.slice(c.tagEnd + 1);
    }
  }
  return mutated;
}

/** Test seam for `scaleGroupChildrenSource`. */
export function scaleGroupChildrenInSource(code: string, groupId: string, scaleX: number, scaleY: number): string {
  const group = findGroupSvg(code, groupId);
  if (!group) return code;
  return scaleGroupChildrenSource(code, group, scaleX, scaleY);
}

// ─── STRETCH bake (structure-preserving, matches the flex viewBox stretch) ────
// When a group is a FLEX child, the browser STRETCHES its content to fill the
// dragged box (the scale S is applied in the TOP group's frame → `S·R` for a
// rotated nested child: the content shears to fill, NO gap). The plain
// `scaleGroupChildrenSource` instead scales each child in its OWN rotated frame
// (`R·S`), which doesn't fill the box (gap) and disagrees with the live preview
// (mouseup snap). This bake reproduces the stretch EXACTLY at 1:1 while PRESERVING
// every rotation: each leaf's geometry is SHEARED by `R(-φcum)·S·R(φcum)` (the
// general "the reference trick"), groups keep their `rotate(θ)`, and each group is
// shrink-wrapped + repositioned with a pivot-aware formula so the painted content
// lands at exactly `S·(original)`. So box == live == tight, with rotations intact.

/** Apply a 2×2 linear map `L` to one child `<svg>…</svg>` BLOCK (a standalone
 *  substring, attribute-boxed nested child). Returns the rewritten block —
 *  geometry sheared, rotations preserved, box shrink-wrapped + repositioned. */
function stretchChildBlock(block: string, L: Linear2): string {
  const openEnd = block.indexOf('>') + 1;
  const openTag = block.slice(0, openEnd);
  const vbM = openTag.match(/viewBox="([^"]+)"/);
  if (!vbM) return block;
  const vp = vbM[1].trim().split(/[\s,]+/).map(Number);
  const vbw = vp[2], vbh = vp[3];
  if (!(vbw > 0) || !(vbh > 0)) return block;
  const x = parseFloat(openTag.match(/\sx="([^"]*)"/)?.[1] ?? '0') || 0;
  const y = parseFloat(openTag.match(/\sy="([^"]*)"/)?.[1] ?? '0') || 0;
  const inner = block.slice(openEnd, block.length - blockCloseLen(block));

  if (NESTED_SVG_RE.test(inner)) {
    // GROUP child: shear each grandchild in the rotated-into frame, then
    // shrink-wrap + reposition this group (keeping its own rotation).
    const rot = parseRotateTransform(openTag.match(/\stransform="([^"]*)"/)?.[1]);
    const theta = rot?.angle ?? 0;
    const Lc: Linear2 = rot ? mulLinear2(rotLinear2(-theta), mulLinear2(L, rotLinear2(theta))) : L;
    let body = block;
    for (const gk of [...parseChildren(block, openEnd, block.length - blockCloseLen(block))].sort((a, b) => b.tagStart - a.tagStart)) {
      const newG = stretchChildBlock(block.slice(gk.tagStart, gk.end + 1), Lc);
      body = body.slice(0, gk.tagStart) + newG + body.slice(gk.end + 1);
    }
    // Content painted bbox B (in this group's frame), after shearing.
    const oe2 = body.indexOf('>') + 1;
    const gks2 = parseChildren(body, oe2, body.length - blockCloseLen(body));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const gk of gks2) {
      const pb = childPaintedBoundsInGroup(body, gk);
      if (pb.minX < minX) minX = pb.minX; if (pb.minY < minY) minY = pb.minY;
      if (pb.maxX > maxX) maxX = pb.maxX; if (pb.maxY > maxY) maxY = pb.maxY;
    }
    if (!Number.isFinite(minX)) return body;
    const Bx = minX, By = minY, Bw = maxX - minX, Bh = maxY - minY;
    // Rebase grandchildren so the content starts at (0,0) in the new viewBox.
    let body2 = body;
    for (const gk of [...gks2].sort((a, b) => b.tagStart - a.tagStart)) {
      let nt = setAttrOnTag(setAttrOnTag(gk.openText, 'x', `${r3(gk.x - Bx)}`), 'y', `${r3(gk.y - By)}`);
      nt = shiftRotatePivotInTag(nt, -Bx, -By);
      body2 = body2.slice(0, gk.tagStart) + nt + body2.slice(gk.tagEnd + 1);
    }
    // Pivot-aware reposition: keep θ, place the box so the painted content lands
    // at exactly L·(original). The rotation pivot Pc is in the PARENT frame, so
    // (unlike the shape case, whose pivot is box-local) the box origin solves to
    //   N' = L·R(θ)·(N − Pc) + L·Pc + R(θ)·Borigin + (R(θ) − I)·Cb
    // (derived by matching the rotation's constant part — note L·R, NOT R·L).
    const Pcx = rot ? rot.cx : x + vbw / 2, Pcy = rot ? rot.cy : y + vbh / 2;
    const Cbx = Bw / 2, Cby = Bh / 2;
    const rad = (theta * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const dx = x - Pcx, dy = y - Pcy;
    const Rdx = cos * dx - sin * dy, Rdy = sin * dx + cos * dy;        // R(θ)·(N−Pc)
    const t1x = L[0] * Rdx + L[2] * Rdy, t1y = L[1] * Rdx + L[3] * Rdy; // L·R(θ)·(N−Pc)
    const t2x = L[0] * Pcx + L[2] * Pcy, t2y = L[1] * Pcx + L[3] * Pcy; // L·Pc
    const t3x = cos * Bx - sin * By, t3y = sin * Bx + cos * By;          // R(θ)·Borigin
    const t4x = cos * Cbx - sin * Cby - Cbx, t4y = sin * Cbx + cos * Cby - Cby; // (R−I)·Cb
    const newX = t1x + t2x + t3x + t4x, newY = t1y + t2y + t3y + t4y;
    let no = setAttrOnTag(setAttrOnTag(openTag, 'x', `${r3(newX)}`), 'y', `${r3(newY)}`);
    no = setAttrOnTag(setAttrOnTag(no, 'width', `${r3(Bw)}`), 'height', `${r3(Bh)}`);
    no = setAttrOnTag(no, 'viewBox', `0 0 ${r3(Bw)} ${r3(Bh)}`);
    if (rot) no = no.replace(/transform="rotate\([^"]*\)"/, `transform="rotate(${theta} ${r3(newX + Cbx)} ${r3(newY + Cby)})"`);
    no = setMotionOriginToBoxCentre(no, newX, newY, Bw, Bh);
    return no + body2.slice(body2.indexOf('>') + 1);
  }

  // SHAPE child: shear geometry by R(-φ)·L·R(φ), shrink-wrap, reposition.
  const gm = inner.match(GEOM_TAG_RE);
  if (!gm || gm.index === undefined) return block;
  const attrs = parseTagAttrs(gm[2]);
  const grot = parseRotateTransform(attrs.transform);
  const phi = grot?.angle ?? 0;
  const Px = grot?.cx ?? 0, Py = grot?.cy ?? 0;
  const affine: Affine6 = grot ? rotatedLinearAffine(phi, L, Px, Py) : [L[0], L[1], L[2], L[3], 0, 0];
  const transformed = transformShapeGeometry(gm[1], attrs, affine);
  const gb = geometryBBox(gm[1], transformed) ?? { x: 0, y: 0, width: 0, height: 0 };
  const rebased = translateShapeGeometry(gm[1], transformed, -gb.x, -gb.y);
  const Cbx = gb.width / 2, Cby = gb.height / 2;
  const LPx = L[0] * Px + L[2] * Py, LPy = L[1] * Px + L[3] * Py;
  const dKx = (LPx - gb.x) - Cbx, dKy = (LPy - gb.y) - Cby;
  const rad = (phi * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const compX = dKx * (1 - cos) + dKy * sin, compY = -dKx * sin + dKy * (1 - cos);
  const newX = (L[0] * x + L[2] * y) + gb.x + compX, newY = (L[1] * x + L[3] * y) + gb.y + compY;
  let newGeom = gm[0];
  for (const [k, v] of Object.entries(rebased)) newGeom = setAttrOnTag(newGeom, k, v);
  if (grot) newGeom = setAttrOnTag(newGeom, 'transform', `rotate(${phi} ${r3(Cbx)} ${r3(Cby)})`);
  let no = setAttrOnTag(setAttrOnTag(openTag, 'x', `${r3(newX)}`), 'y', `${r3(newY)}`);
  no = setAttrOnTag(setAttrOnTag(no, 'width', `${r3(gb.width)}`), 'height', `${r3(gb.height)}`);
  no = setAttrOnTag(no, 'viewBox', `0 0 ${r3(gb.width)} ${r3(gb.height)}`);
  no = setMotionOriginToBoxCentre(no, newX, newY, gb.width, gb.height);
  const newInner = inner.slice(0, gm.index) + newGeom + inner.slice(gm.index + gm[0].length);
  return no + newInner + block.slice(block.length - blockCloseLen(block));
}

/** Stretch-bake a group's DIRECT children by `(scaleX, scaleY)` (the top group's
 *  box is set separately by the caller). Each child is sheared to fill the scaled
 *  box exactly — matching the flex viewBox stretch — with all rotations preserved. */
function stretchGroupChildrenSource(code: string, group: GroupSvgRange, scaleX: number, scaleY: number): string {
  const L: Linear2 = [scaleX, 0, 0, scaleY];
  let mutated = code;
  for (const c of [...parseChildren(code, group.bodyStart, group.bodyEnd)].sort((a, b) => b.tagStart - a.tagStart)) {
    const newBlock = stretchChildBlock(mutated.slice(c.tagStart, c.end + 1), L);
    mutated = mutated.slice(0, c.tagStart) + newBlock + mutated.slice(c.end + 1);
  }
  return mutated;
}

/** Test seam for `stretchGroupChildrenSource`. */
export function stretchGroupChildrenInSource(code: string, groupId: string, scaleX: number, scaleY: number): string {
  const group = findGroupSvg(code, groupId);
  if (!group) return code;
  return stretchGroupChildrenSource(code, group, scaleX, scaleY);
}

/** Test seam: the union of a group's children's PAINTED vertices (the actual
 *  rendered extent in the group's own user space). */
export function groupContentPaintedBoundsInSource(code: string, groupId: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const group = findGroupSvg(code, groupId);
  if (!group) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of parseChildren(code, group.bodyStart, group.bodyEnd)) {
    for (const [vx, vy] of paintedVerticesInGroup(code, c)) {
      if (vx < minX) minX = vx; if (vy < minY) minY = vy;
      if (vx > maxX) maxX = vx; if (vy > maxY) maxY = vy;
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ─── LIVE group-resize child baking (source-side snapshot) ───────────────────
// The pure baking math + types live in `group-resize-bake.ts` (shared with the
// iframe sandbox's live `bakeGroupResize` so live == commit). This source-string
// snapshot is the COMMIT-side counterpart used for testing the equivalence.

/** Snapshot a group's children (boxes + viewBoxes + geometry + rotate pivots)
 *  from SOURCE. Null when not a group. */
export function snapshotGroupChildrenForResize(code: string, groupId: string): GroupResizeSnapshot | null {
  const group = findGroupSvg(code, groupId);
  if (!group) return null;
  const vbm = group.openText.match(/viewBox="([^"]+)"/);
  if (!vbm) return null;
  const gp = vbm[1].trim().split(/[\s,]+/).map(Number);
  const origVbW = gp[2], origVbH = gp[3];
  if (!(origVbW > 0) || !(origVbH > 0)) return null;
  const children = parseChildren(code, group.bodyStart, group.bodyEnd);
  const out: GroupChildSnapshot[] = [];
  for (const c of children) {
    const childId = c.openText.match(/data-id="([^"]+)"/)?.[1];
    if (!childId) continue;
    const cvb = c.openText.match(/viewBox="([^"]+)"/);
    if (!cvb) continue;
    const [vbx, vby, vbw, vbh] = cvb[1].trim().split(/[\s,]+/).map(Number);
    if (!(vbw > 0) || !(vbh > 0)) continue;
    const gm = code.slice(c.tagEnd + 1, c.closeStart).match(GEOM_TAG_RE);
    if (!gm) continue;
    const geomAttrs = parseTagAttrs(gm[2]);
    const rmt = (geomAttrs.transform || '').match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
    out.push({
      childId, x: c.x, y: c.y, width: c.width, height: c.height,
      vbx: vbx || 0, vby: vby || 0, vbw, vbh,
      geomId: geomAttrs['data-id'] || '', geomTag: gm[1], geomAttrs,
      rotate: rmt ? { angle: parseFloat(rmt[1]), cx: parseFloat(rmt[2]), cy: parseFloat(rmt[3]) } : null,
    });
  }
  if (out.length === 0) return null;
  return { origVbW, origVbH, children: out };
}

/**
 * Normalize every child of a group so its box (x/y/width/height + viewBox)
 * tightly wraps its PAINTED geometry — VISUALLY unchanged.
 *
 * Why: a shape-edit reshape can leave a child's geometry spilling far outside
 * its own viewBox/box (e.g. a path `d` with coords well past `viewBox`). The
 * group refit unions child BOXES, so the group box then fails to contain the
 * painted content — selection (which samples real geometry) and resize (which
 * uses the box) diverge and the rotated-group resize "moves both sides".
 *
 * For each child we read its geometry bbox `(gx,gy,gw,gh)` in viewBox units and,
 * preserving the current viewBox→box scale `s = box/vb`, rewrite:
 *   viewBox = `0 0 gw gh`,  width = gw·sx,  height = gh·sy,
 *   x = childX + (gx-vbX)·sx,  y = childY + (gy-vbY)·sy,
 * and translate the geometry by `(-gx,-gy)`. The geometry's screen position +
 * scale are unchanged, so there is no visual jump — but now box == geometry, so
 * the subsequent group union (and thus the group box) wraps the painted content.
 */
function normalizeChildrenToGeometry(code: string, group: GroupSvgRange): string {
  const children = parseChildren(code, group.bodyStart, group.bodyEnd);
  let mutated = code;
  // End→start so earlier children's indices stay valid as we splice.
  for (const c of [...children].sort((a, b) => b.tagStart - a.tagStart)) {
    const vbMatch = c.openText.match(/viewBox="([^"]+)"/);
    if (!vbMatch) continue;
    const [vbX, vbY, vbW, vbH] = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (!(vbW > 0) || !(vbH > 0) || !(c.width > 0) || !(c.height > 0)) continue;

    const innerStart = c.tagEnd + 1;
    const closeStart = c.closeStart;
    const inner = mutated.slice(innerStart, closeStart);
    // A child that is itself a GROUP (contains a nested `<svg>`) must NOT be
    // normalized to "geometry" — `GEOM_TAG_RE` would match a DEEPLY nested
    // shape inside the sub-group and collapse the sub-group's box back onto one
    // descendant. A group child's box already wraps its content (it was refit
    // bottom-up first), so leave it alone here.
    if (NESTED_SVG_RE.test(inner)) continue;
    const gm = inner.match(GEOM_TAG_RE);
    if (!gm || gm.index === undefined) continue;
    const tag = gm[1];
    const attrs = parseTagAttrs(gm[2]);
    // The shape may carry its own `transform="rotate(a cx cy)"` (a rotated
    // child). We fit to the UN-ROTATED geometry bbox (NOT the rotated one) —
    // that is the convention `startRotatedSvgShapeResize` uses: the box == the
    // un-rotated geometry bbox (viewBox `0 0 W H`) with the rotation living in
    // the inner transform. Fitting to the ROTATED bbox here instead would
    // conflict with the resize and make the child explode on the next resize.
    // The re-base still moves the rotate PIVOT with the geometry so a reshape
    // doesn't jump.
    const rm = (attrs.transform || '').match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
    const innerAngle = rm ? parseFloat(rm[1]) : 0;
    const innerCx = rm ? parseFloat(rm[2]) : 0;
    const innerCy = rm ? parseFloat(rm[3]) : 0;
    const gb = geometryBBox(tag, attrs);
    if (!gb || gb.width <= 0 || gb.height <= 0) continue;

    // Already tight (geometry bbox == viewBox bounds)? Skip.
    if (Math.abs(gb.x - vbX) < 0.5 && Math.abs(gb.y - vbY) < 0.5 &&
        Math.abs(gb.width - vbW) < 0.5 && Math.abs(gb.height - vbH) < 0.5) continue;

    const sx = c.width / vbW, sy = c.height / vbH;
    const newW = r3(gb.width * sx);
    const newH = r3(gb.height * sy);
    const newX = r3(c.x + (gb.x - vbX) * sx);
    const newY = r3(c.y + (gb.y - vbY) * sy);
    if (!(newW > 0) || !(newH > 0)) continue;

    // Re-base geometry to origin (0,0); for a rotated shape also shift the
    // rotate pivot by the same (-gb.x,-gb.y) so the painted result just
    // translates (no jump).
    const shifted = translateShapeGeometry(tag, attrs, -gb.x, -gb.y);
    let newGeom = gm[0];
    for (const [k, v] of Object.entries(shifted)) newGeom = setAttrOnTag(newGeom, k, v);
    if (rm) {
      newGeom = setAttrOnTag(newGeom, 'transform', `rotate(${innerAngle} ${r3(innerCx - gb.x)} ${r3(innerCy - gb.y)})`);
    }

    // Rewrite the child open tag.
    let newOpen = setAttrOnTag(c.openText, 'x', `${newX}`);
    newOpen = setAttrOnTag(newOpen, 'y', `${newY}`);
    newOpen = setAttrOnTag(newOpen, 'width', `${newW}`);
    newOpen = setAttrOnTag(newOpen, 'height', `${newH}`);
    newOpen = setAttrOnTag(newOpen, 'viewBox', `0 0 ${r3(gb.width)} ${r3(gb.height)}`);

    // Splice geometry FIRST (it's after the open tag, so open-tag indices stay
    // valid), then the open tag.
    const geomAbsStart = innerStart + gm.index;
    mutated = mutated.slice(0, geomAbsStart) + newGeom + mutated.slice(geomAbsStart + gm[0].length);
    mutated = mutated.slice(0, c.tagStart) + newOpen + mutated.slice(c.tagEnd + 1);
    trace.action('normalize-child-geometry', { tag, newX, newY, newW, newH, gb });
  }
  return mutated;
}

/** Test seam: normalize a named group's children to their geometry. */
export function normalizeGroupChildrenInSource(code: string, groupId: string): string {
  const group = findGroupSvg(code, groupId);
  if (!group) return code;
  return normalizeChildrenToGeometry(code, group);
}

/** The ACTUAL painted vertices of child `c`, expressed in c's PARENT (the group)
 *  user space. VERTICES, not an AABB — so a rotated ancestor rotates the real
 *  painted points, never an intermediate box AABB.
 *
 *  Why vertices and not a recursive AABB: collapsing a child to its AABB and then
 *  rotating that AABB's 4 corners by an ancestor's rotation over-reaches into the
 *  AABB's EMPTY corners. With BOTH a rotated leaf geometry AND a rotated parent
 *  group (group ▸ group ▸ rotated-shape), that double rotation inflates the top
 *  group box by hundreds of px → a gap on one side. Carrying the real vertices the
 *  whole way and AABB-ing exactly once at the top is the only tight result — it's
 *  what `paintedGroupUserBounds` (the selection) does, so box == selection. */
function paintedVerticesInGroup(code: string, c: ChildSvg): Array<[number, number]> {
  let vbx = 0, vby = 0, vbw = c.width, vbh = c.height;
  const vbM = c.openText.match(/viewBox="([^"]+)"/);
  if (vbM) {
    const p = vbM[1].trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p[2] > 0 && p[3] > 0) { vbx = p[0]; vby = p[1]; vbw = p[2]; vbh = p[3]; }
  }
  const sxBox = vbw > 0 ? c.width / vbw : 1, syBox = vbh > 0 ? c.height / vbh : 1;
  const innerHtml = code.slice(c.tagEnd + 1, c.closeStart);

  // Map a vertex from c's USER (viewBox) space → c's PARENT space: viewBox
  // scale+translate, then c's OWN rotation about its pivot (pivot is in parent
  // space for an attribute `rotate(θ cx cy)`).
  const crot = parseRotateTransform(c.openText.match(/\stransform="([^"]*)"/)?.[1])
    ?? parseMotionChildRotation(code, c.openText);
  const crad = (crot?.angle ?? 0) * (Math.PI / 180), ccos = Math.cos(crad), csin = Math.sin(crad);
  const toParent = ([ux, uy]: [number, number]): [number, number] => {
    const px = c.x + (ux - vbx) * sxBox, py = c.y + (uy - vby) * syBox;
    if (!crot) return [px, py];
    const dx = px - crot.cx, dy = py - crot.cy;
    return [crot.cx + dx * ccos - dy * csin, crot.cy + dx * csin + dy * ccos];
  };
  const boxCorners = (): Array<[number, number]> =>
    ([[vbx, vby], [vbx + vbw, vby], [vbx + vbw, vby + vbh], [vbx, vby + vbh]] as Array<[number, number]>).map(toParent);

  // A child that is itself a GROUP (contains a nested `<svg>`): union its OWN
  // children's painted vertices (recursively), each already in c's USER space,
  // then map up to c's parent space.
  if (NESTED_SVG_RE.test(innerHtml)) {
    const subChildren = parseChildren(code, c.tagEnd + 1, c.closeStart);
    const out: Array<[number, number]> = [];
    for (const sc of subChildren) {
      for (const v of paintedVerticesInGroup(code, sc)) out.push(toParent(v));
    }
    return out.length ? out : boxCorners();
  }

  // Leaf shape: the actual geometry vertices, rotated by the geometry's OWN
  // transform about its pivot (in viewBox space), then mapped to parent space.
  const gm = innerHtml.match(GEOM_TAG_RE);
  if (!gm) return boxCorners();
  const attrs = parseTagAttrs(gm[2]);
  let verts = geometryVertices(gm[1], attrs);
  if (verts.length === 0) {
    // A %-based shape (`<ellipse rx="50%">`, etc.) FILLS its viewBox, so
    // geometryVertices can't compute absolute coords and returns []. Its painted
    // geometry IS the viewBox box — use those corners as the LOCAL vertices so
    // the shape's OWN rotation (`grot`) below still applies. Returning
    // boxCorners() here instead maps only the WRAPPER rotation (crot) and DROPS
    // grot, so a rotated circle's group bounds came out un-rotated (too big).
    verts = [[vbx, vby], [vbx + vbw, vby], [vbx + vbw, vby + vbh], [vbx, vby + vbh]];
  }
  const grot = parseRotateTransform(attrs.transform);
  if (grot) {
    const a = (grot.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    verts = verts.map(([x, y]): [number, number] => {
      const dx = x - grot.cx, dy = y - grot.cy;
      return [grot.cx + dx * cos - dy * sin, grot.cy + dx * sin + dy * cos];
    });
  }
  return verts.map(toParent);
}

/** A child's PAINTED bounds (AABB) in GROUP coords — the AABB of its actual
 *  painted vertices (see `paintedVerticesInGroup`). The group refit unions these
 *  so the group box == what's painted == what you select/resize. */
function childPaintedBoundsInGroup(code: string, c: ChildSvg): { minX: number; minY: number; maxX: number; maxY: number } {
  const verts = paintedVerticesInGroup(code, c);
  if (verts.length === 0) return { minX: c.x, minY: c.y, maxX: c.x + c.width, maxY: c.y + c.height };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of verts) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Refit + return the post-refit final state. Used by the drag commit
 *  path so the caller can bridge-patch the iframe DOM with the same
 *  values source ends up at. `movedChildId` (optional) is broken out in
 *  the returned `childAttrs` for caller convenience; all other shifted
 *  children land in `siblingAttrs`. */
function refitGroupInSourceWithResult(
  code: string,
  groupId: string,
  movedChildId: string,
): { code: string; result: MoveAndRefitResult } | null {
  let group = findGroupSvg(code, groupId);
  if (!group) {
    trace.action('refit-group:group-not-found', { groupId });
    return null;
  }
  // First make every child box wrap its geometry (a reshape can leave geometry
  // spilling outside the box). Re-find the group afterwards — splicing shifted
  // source indices.
  const normalized = normalizeChildrenToGeometry(code, group);
  const normalizeChanged = normalized !== code;
  if (normalizeChanged) {
    code = normalized;
    group = findGroupSvg(code, groupId);
    if (!group) return null;
  }
  const children = parseChildren(code, group.bodyStart, group.bodyEnd);
  if (children.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of children) {
    const pb = childPaintedBoundsInGroup(code, c);
    if (pb.minX < minX) minX = pb.minX;
    if (pb.minY < minY) minY = pb.minY;
    if (pb.maxX > maxX) maxX = pb.maxX;
    if (pb.maxY > maxY) maxY = pb.maxY;
  }
  const newW = Math.round(maxX - minX);
  const newH = Math.round(maxY - minY);
  const dx = -Math.round(minX);
  const dy = -Math.round(minY);

  const sameSize = Math.abs(newW - group.width) < 0.5 && Math.abs(newH - group.height) < 0.5;
  const sameOrigin = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;
  // True no-op only when normalization ALSO changed nothing — otherwise the
  // normalized geometry/box rewrites must still be returned to the caller.
  if (sameSize && sameOrigin && !normalizeChanged) return null;

  let mutated = code;
  let movedChildAttrs: Record<string, string> = {};
  const siblingAttrs = new Map<string, Record<string, string>>();

  const sortedChildren = [...children].sort((a, b) => b.tagStart - a.tagStart);
  for (const c of sortedChildren) {
    const newX = Math.round(c.x + dx);
    const newY = Math.round(c.y + dy);
    let newOpen = setAttr(setAttr(c.openText, 'x', `${newX}`), 'y', `${newY}`);
    // A child that is a ROTATED nested group carries `transform="rotate(θ cx
    // cy)"` with cx,cy in THIS group's user space — shift the pivot with the
    // child or its rotation would orbit the old centre after the refit.
    newOpen = shiftRotatePivotInTag(newOpen, dx, dy);
    // Same for a MOTION child's carrier origin (parent user space px).
    newOpen = shiftMotionOriginInTag(newOpen, dx, dy);
    mutated = mutated.slice(0, c.tagStart) + newOpen + mutated.slice(c.tagEnd + 1);
    const childIdAttr = c.openText.match(/data-id="([^"]+)"/)?.[1] ?? '';
    if (childIdAttr === movedChildId) {
      movedChildAttrs = { x: `${newX}`, y: `${newY}` };
    } else if (childIdAttr) {
      siblingAttrs.set(childIdAttr, { x: `${newX}`, y: `${newY}` });
    }
  }

  // Position the new (tight) box so the content stays visually fixed. Under a
  // CSS rotation a plain `group.left - dx` translation does NOT cancel the
  // child shift (the shift is in the box's pre-rotation local frame, the box
  // move is in canvas space), so the group would jump. `rotatedRefitPosition`
  // compensates for the rotation + the pivot moving to the new box centre.
  const rot = parseGroupRotation(group.openText);
  let newLeft: number, newTop: number;
  if (rot) {
    const pos = rotatedRefitPosition(
      group.left, group.top, Math.round(minX), Math.round(minY),
      rot.originX ?? group.width / 2, rot.originY ?? group.height / 2, newW / 2, newH / 2, rot.angleDeg,
    );
    newLeft = Math.round(pos.left);
    newTop = Math.round(pos.top);
  } else {
    newLeft = group.left - dx;
    newTop = group.top - dy;
  }
  const newGroupOpen = rewriteGroupOpen(group.openText, newW, newH, newLeft, newTop, group.nested);
  mutated = mutated.slice(0, group.tagStart) + newGroupOpen + mutated.slice(group.tagEnd + 1);

  trace.action('refit-group:committed', {
    groupId, newW, newH, dx, dy, newLeft, newTop, rotated: !!rot, nested: group.nested,
  });

  // When the group is rotated, the refit moved its painted-content centre, so
  // the rotation pivot must move with it (Bug B). Source is rewritten in
  // `rewriteGroupOpen`; surface the new origin so the caller bridge-patches the
  // live DOM in lockstep.
  const isRotated = groupOpenHasTransformOrigin(group.openText);
  const groupTransformOrigin = groupCentreOrigin(newW, newH);
  // A group that is a FLEX/FLOW child (`position: relative`, no left/top) is
  // positioned by its parent layout, NOT by left/top. Patching left/top onto it
  // OFFSETS it from its flow slot (the bug). Only an ABSOLUTE group (explicit
  // left + top) gets the position write; for a flex child we just resize + the
  // children re-base, and the layout re-flows it.
  const groupIsAbsolute = /\bleft\s*:\s*["']/.test(group.openText) && /\btop\s*:\s*["']/.test(group.openText);
  const groupStyles: Record<string, string> = {
    width: `${newW}px`,
    height: `${newH}px`,
  };
  if (groupIsAbsolute) {
    groupStyles.left = `${Math.round(newLeft)}px`;
    groupStyles.top = `${Math.round(newTop)}px`;
  }
  if (isRotated) groupStyles.transformOrigin = groupTransformOrigin;
  const result: MoveAndRefitResult = {
    childAttrs: movedChildAttrs,
    siblingAttrs,
    groupStyles,
    groupViewBox: `0 0 ${newW} ${newH}`,
    groupTransformOrigin: isRotated ? groupTransformOrigin : '',
  };
  return { code: mutated, result };
}

/** Pure source-transform — refit a group in the given code string and
 *  return the mutated source. Used both by the standalone
 *  `refitGroupBounds` and by `moveChildAndRefitGroup` (which composes it
 *  with a child-attr write in a single transaction). */
/** Test seam: refit a group's bounds in a source string (pure). */
export function refitGroupBoundsInSource(code: string, groupId: string): string {
  return refitGroupInSource(code, groupId);
}

function refitGroupInSource(code: string, groupId: string): string {
  let group = findGroupSvg(code, groupId);
  if (!group) {
    trace.action('refit-group:group-not-found', { groupId });
    return code;
  }

  // Normalize child boxes to their geometry first (a reshape can leave geometry
  // spilling outside the box → the group box wouldn't wrap the painted content).
  const normalized = normalizeChildrenToGeometry(code, group);
  const normalizeChanged = normalized !== code;
  if (normalizeChanged) {
    code = normalized;
    const g = findGroupSvg(code, groupId);
    if (!g) return code;
    group = g;
  }

  const children = parseChildren(code, group.bodyStart, group.bodyEnd);
  if (children.length === 0) {
    trace.action('refit-group:no-children', { groupId });
    return code;
  }

  // Union of children's PAINTED bounds (rotated bbox for rotated children) so
  // the group box wraps what's actually painted, not the un-rotated boxes.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of children) {
    const pb = childPaintedBoundsInGroup(code, c);
    if (pb.minX < minX) minX = pb.minX;
    if (pb.minY < minY) minY = pb.minY;
    if (pb.maxX > maxX) maxX = pb.maxX;
    if (pb.maxY > maxY) maxY = pb.maxY;
  }
  const newW = Math.round(maxX - minX);
  const newH = Math.round(maxY - minY);
  const dx = -Math.round(minX); // amount to shift each child's x by
  const dy = -Math.round(minY);

  const sameSize = Math.abs(newW - group.width) < 0.5 && Math.abs(newH - group.height) < 0.5;
  const sameOrigin = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5;
  if (sameSize && sameOrigin) {
    // Normalization may still have changed geometry/boxes — return that.
    if (normalizeChanged) return code;
    trace.action('refit-group:no-change', { groupId, newW, newH, dx, dy });
    return code;
  }

  let mutated = code;
  const sortedChildren = [...children].sort((a, b) => b.tagStart - a.tagStart);
  for (const c of sortedChildren) {
    let newOpen = setAttr(setAttr(c.openText, 'x', `${Math.round(c.x + dx)}`), 'y', `${Math.round(c.y + dy)}`);
    // Shift a rotated nested-group child's pivot with it (see the other loop).
    newOpen = shiftRotatePivotInTag(newOpen, dx, dy);
    newOpen = shiftMotionOriginInTag(newOpen, dx, dy);
    mutated = mutated.slice(0, c.tagStart) + newOpen + mutated.slice(c.tagEnd + 1);
  }
  // Rotation-aware box position (see `refitGroupInSourceWithResult`).
  const rot = parseGroupRotation(group.openText);
  const { left: newLeft, top: newTop } = rot
    ? (() => { const p = rotatedRefitPosition(group.left, group.top, Math.round(minX), Math.round(minY), rot.originX ?? group.width / 2, rot.originY ?? group.height / 2, newW / 2, newH / 2, rot.angleDeg); return { left: Math.round(p.left), top: Math.round(p.top) }; })()
    : { left: group.left - dx, top: group.top - dy };
  const newGroupOpen = rewriteGroupOpen(group.openText, newW, newH, newLeft, newTop, group.nested);
  mutated = mutated.slice(0, group.tagStart) + newGroupOpen + mutated.slice(group.tagEnd + 1);

  trace.action('refit-group:committed', {
    groupId, newW, newH, dx, dy, newLeft, newTop, rotated: !!rot, nested: group.nested,
  });
  return mutated;
}

// ─── Source-level helpers ─────────────────────────────────────────────

interface GroupSvgRange {
  /** `<` of the opening tag. */
  tagStart: number;
  /** `>` of the opening tag (inclusive). */
  tagEnd: number;
  /** Char after the opening `>`. */
  bodyStart: number;
  /** `<` of the closing `</svg>`. */
  bodyEnd: number;
  openText: string;
  width: number;
  height: number;
  left: number;
  top: number;
  /** A NESTED group (a `<svg>` inside another `<svg>`) stores its box in
   *  `x/y/width/height` ATTRIBUTES (it sits in the parent group's user space,
   *  exactly like a shape child) instead of `style={{ left/top/width/height }}`.
   *  When true, `left/top` are the `x/y` attrs and refit must read/write the
   *  box via attributes, not the style block. The rotation pivot
   *  (`transform-origin`) is still CSS, so it stays in `style`. */
  nested: boolean;
}

function findGroupSvg(code: string, groupId: string): GroupSvgRange | null {
  const marker = `data-id="${groupId}"`;
  const markerIdx = code.indexOf(marker);
  if (markerIdx === -1) return null;
  const tagStart = svgOpenLastBefore(code, markerIdx);
  if (tagStart === -1) return null;
  const tagEnd = code.indexOf('>', markerIdx);
  if (tagEnd === -1) return null;
  // Tag-walk to the matching closing tag (motion-aware)
  let depth = 1;
  let cursor = tagEnd + 1;
  let bodyEnd = -1;
  while (cursor < code.length && depth > 0) {
    const nextOpen = svgOpenNext(code, cursor);
    const nextClose = svgCloseNext(code, cursor);
    if (nextClose.idx === -1) return null;
    if (nextOpen.idx !== -1 && nextOpen.idx < nextClose.idx) {
      depth++;
      cursor = nextOpen.idx + nextOpen.len;
    } else {
      depth--;
      if (depth === 0) { bodyEnd = nextClose.idx; break; }
      cursor = nextClose.idx + nextClose.len;
    }
  }
  if (bodyEnd === -1) return null;

  const openText = code.slice(tagStart, tagEnd + 1);
  const styleBody = openText.match(/style=\{\{([^}]+)\}\}/)?.[1] ?? '';
  // A NESTED group has its box in attributes — there's no `width:` in its
  // style block (top-level groups always carry CSS width/left/top). Detect
  // that and read x/y/width/height from the ATTRIBUTES instead, so the union
  // refit computes against the real box (not zeros) and `rewriteGroupOpen`
  // knows to write back to attributes.
  const nested = !/\bwidth\s*:/.test(styleBody);
  const attrNum = (key: string) => parseFloat(openText.match(new RegExp(`\\s${key}="([^"]+)"`))?.[1] ?? '') || 0;
  return {
    tagStart, tagEnd,
    bodyStart: tagEnd + 1,
    bodyEnd,
    openText,
    nested,
    width: nested ? attrNum('width') : parseStyleNum(styleBody, 'width'),
    height: nested ? attrNum('height') : parseStyleNum(styleBody, 'height'),
    left: nested ? attrNum('x') : parseStyleNum(styleBody, 'left'),
    top: nested ? attrNum('y') : parseStyleNum(styleBody, 'top'),
  };
}

function parseChildren(code: string, bodyStart: number, bodyEnd: number): ChildSvg[] {
  const children: ChildSvg[] = [];
  let scan = bodyStart;
  while (scan < bodyEnd) {
    const open = svgOpenNext(code, scan);
    const openIdx = open.idx;
    if (openIdx === -1 || openIdx >= bodyEnd) break;
    const tagEnd = code.indexOf('>', openIdx);
    if (tagEnd === -1 || tagEnd >= bodyEnd) break;
    // Tag-walk for the nested svg's matching close (motion-aware)
    let depth = 1;
    let cursor = tagEnd + 1;
    let closeStart = -1;
    let closeLen = 6;
    while (cursor < code.length && depth > 0) {
      const no = svgOpenNext(code, cursor);
      const nc = svgCloseNext(code, cursor);
      if (nc.idx === -1) break;
      if (no.idx !== -1 && no.idx < nc.idx) { depth++; cursor = no.idx + no.len; }
      else { depth--; if (depth === 0) { closeStart = nc.idx; closeLen = nc.len; break; } cursor = nc.idx + nc.len; }
    }
    if (closeStart === -1) break;

    const openText = code.slice(openIdx, tagEnd + 1);
    const x = parseFloat(openText.match(/\sx="([^"]+)"/)?.[1] ?? '0') || 0;
    const y = parseFloat(openText.match(/\sy="([^"]+)"/)?.[1] ?? '0') || 0;
    const w = parseFloat(openText.match(/\swidth="([^"]+)"/)?.[1] ?? '0') || 0;
    const h = parseFloat(openText.match(/\sheight="([^"]+)"/)?.[1] ?? '0') || 0;

    children.push({
      start: openIdx, end: closeStart + closeLen - 1,
      tagStart: openIdx, tagEnd,
      closeStart, closeLen,
      openText, x, y, width: w, height: h,
    });
    scan = closeStart + closeLen;
  }
  return children;
}

function setAttr(tag: string, key: string, value: string): string {
  const re = new RegExp(`(\\s${key}=)"[^"]*"`);
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  // Insert before the closing `>` or `/>`.
  if (tag.endsWith('/>')) return tag.slice(0, -2) + ` ${key}="${value}" />`;
  return tag.slice(0, -1) + ` ${key}="${value}">`;
}

/** Shift the pivot of a `transform="rotate(θ cx cy)"` ATTRIBUTE by (dx,dy). A
 *  rotated NESTED group stores its rotation as this SVG attribute with the
 *  pivot in its PARENT group's user space; when a refit re-origins the parent
 *  (shifting every child by dx,dy), the pivot must move with the child or the
 *  rotation orbits the stale centre. No-op when (dx,dy)=0 or no rotate attr. */
function shiftRotatePivotInTag(tag: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return tag;
  return tag.replace(
    /(transform=")rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)(")/,
    (_m, pre, ang, cx, cy, post) => `${pre}rotate(${ang} ${r3(parseFloat(cx) + dx)} ${r3(parseFloat(cy) + dy)})${post}`,
  );
}

function rewriteGroupOpen(openText: string, newW: number, newH: number, newLeft: number, newTop: number, nested = false): string {
  // viewBox attr — preserve "0 0" origin.
  let out = openText.replace(/viewBox="[^"]*"/, `viewBox="0 0 ${newW} ${newH}"`);
  if (nested) {
    // A nested group's box is `x/y/width/height` ATTRIBUTES (it lives in the
    // parent group's user space, like a shape child). Write the new box there.
    out = setAttr(out, 'x', `${Math.round(newLeft)}`);
    out = setAttr(out, 'y', `${Math.round(newTop)}`);
    out = setAttr(out, 'width', `${newW}`);
    out = setAttr(out, 'height', `${newH}`);
    // A nested group rotates via the SVG `transform="rotate(θ cx cy)"` ATTRIBUTE
    // (pivot in PARENT user space). The refit moved/resized the box, so the pivot
    // must follow to the new box CENTRE — else the rotation pivots about a stale
    // point and the group jumps (e.g. when a grandchild rotates and refits this
    // group). No-op when un-rotated.
    const pcx = r3(Math.round(newLeft) + newW / 2);
    const pcy = r3(Math.round(newTop) + newH / 2);
    out = out.replace(
      /transform="rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)"/,
      (_m, ang) => `transform="rotate(${ang} ${pcx} ${pcy})"`,
    );
    // transform-origin (CSS) refresh — no-op for the attribute-rotation case.
    out = out.replace(/style=\{\{([^}]+)\}\}/, (_, body) =>
      `style={{${setStyleStr(body as string, 'transformOrigin', groupCentreOrigin(newW, newH))}}}`);
    return out;
  }
  // Style object — replace each numeric prop. The style body is JSX
  // `style={{ ... }}`; we mutate the substring inside the double braces.
  out = out.replace(/style=\{\{([^}]+)\}\}/, (_, body) => {
    let b = body as string;
    b = setStyleNum(b, 'left', newLeft);
    b = setStyleNum(b, 'top', newTop);
    b = setStyleNum(b, 'width', newW);
    b = setStyleNum(b, 'height', newH);
    // Refresh the rotation pivot to the NEW painted-content centre. After a
    // refit the union spans `0 0 newW newH`, so the centre is (newW/2, newH/2).
    // Only touched when the group is rotated (transformOrigin already present);
    // a stale pivot makes a later rotate spin around the OLD centre and the
    // group "loses its sense of direction" (Bug B). `setStyleStr` is a no-op
    // when the key is absent, so un-rotated groups are untouched.
    b = setStyleStr(b, 'transformOrigin', groupCentreOrigin(newW, newH));
    return `style={{${b}}}`;
  });
  return out;
}

/** `transform-origin` string for a refit group's new painted-content centre
 *  (the union after refit spans `0 0 newW newH`, so the centre is its middle). */
function groupCentreOrigin(newW: number, newH: number): string {
  // EXACT half (not integer-rounded): the resize compensation derives its pivot
  // fraction kx = originX/width, and rounding 183.5→184 makes kx=0.5013≠0.5, so
  // the opposite corner creeps on every resize. `w/2` keeps kx exactly 0.5.
  return `${r3(newW / 2)}px ${r3(newH / 2)}px`;
}

/** Parse a group's rotation (deg) + pivot from its opening tag — handles BOTH a
 *  top-level group's CSS `transform: rotate(θdeg)` (pivot = `transformOrigin`,
 *  box-local px) AND a nested group's SVG `transform="rotate(θ cx cy)"` ATTRIBUTE
 *  (pivot = box centre, kept fresh; caller substitutes the box centre via the
 *  null origin). Returns null when there's no non-zero rotation — callers then
 *  use the plain (translation-only) refit position. */
export function parseGroupRotation(openText: string): { angleDeg: number; originX: number | null; originY: number | null } | null {
  const rot = openText.match(/transform\s*:\s*["'][^"']*rotate\(\s*(-?[\d.]+)deg\s*\)/);
  if (rot) {
    const angleDeg = parseFloat(rot[1]);
    if (!Number.isFinite(angleDeg) || angleDeg === 0) return null;
    const om = openText.match(/transformOrigin\s*:\s*["'](-?[\d.]+)px\s+(-?[\d.]+)px["']/);
    // null when no explicit px origin — caller substitutes the box centre (the
    // CSS default), NOT 0,0, so a missing origin can't introduce an offset.
    return { angleDeg, originX: om ? parseFloat(om[1]) : null, originY: om ? parseFloat(om[2]) : null };
  }
  // NESTED group: rotation is the SVG `transform` ATTRIBUTE; its pivot is the box
  // centre (kept fresh), so return a null origin → caller uses the box centre.
  const attrRot = openText.match(/transform="rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)"/);
  if (attrRot) {
    const angleDeg = parseFloat(attrRot[1]);
    if (!Number.isFinite(angleDeg) || angleDeg === 0) return null;
    return { angleDeg, originX: null, originY: null };
  }
  return null;
}

/**
 * New box top-left so the painted content stays VISUALLY FIXED when a refit
 * shifts every child by (-minX,-minY), moves the rotation pivot from O_old to
 * O_new (the new box centre), and the box carries a CSS `rotate(angleDeg)`.
 *
 * A rotated element paints a box-local point `p` at:
 *     canvas(p) = boxTL + O + R·(p - O)            (R = rotation by angleDeg)
 * After refit the same content point is at local `p-(minX,minY)`, pivot O_new.
 * Setting the two canvas positions equal and solving for the new boxTL:
 *     boxTL' = boxTL + (I-R)·(O_old - O_new) + R·(minX,minY)
 *
 * For angleDeg=0 this collapses to `boxTL + (minX,minY)` — exactly the plain
 * translation-only refit (`group.left - dx`, dx=-minX). Skipping this
 * compensation under rotation is what made a refit JUMP the group on child
 * drag — the reason rotated groups used to skip refit entirely (which then
 * let the box drift away from the content and broke rotated-group resize).
 */
export function rotatedRefitPosition(
  oldLeft: number, oldTop: number,
  minX: number, minY: number,
  oldOriginX: number, oldOriginY: number,
  newOriginX: number, newOriginY: number,
  angleDeg: number,
): { left: number; top: number } {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rx = (vx: number, vy: number) => cos * vx - sin * vy;
  const ry = (vx: number, vy: number) => sin * vx + cos * vy;
  const ox = oldOriginX - newOriginX;
  const oy = oldOriginY - newOriginY;
  return {
    left: oldLeft + (ox - rx(ox, oy)) + rx(minX, minY),
    top: oldTop + (oy - ry(ox, oy)) + ry(minX, minY),
  };
}

/** True when a group's opening tag carries a rotation pivot (i.e. it's
 *  currently rotated, so transform-origin must be kept fresh through refit). */
function groupOpenHasTransformOrigin(openText: string): boolean {
  return /transformOrigin\s*:/.test(openText);
}

/** Replace a string-valued `key: '…'` inside a JSX style body. No-op when the
 *  key is absent — so we never ADD a transform-origin to an un-rotated group. */
function setStyleStr(styleBody: string, key: string, value: string): string {
  const re = new RegExp(`(${key}\\s*:\\s*["'])[^"']*(["'])`);
  if (re.test(styleBody)) return styleBody.replace(re, `$1${value}$2`);
  return styleBody;
}

function parseStyleNum(styleBody: string, key: string): number {
  const m = styleBody.match(new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`));
  if (!m) return 0;
  return parseFloat(m[1]) || 0;
}

function setStyleNum(styleBody: string, key: string, value: number): string {
  const re = new RegExp(`(${key}\\s*:\\s*["'])[^"']+(["'])`);
  if (re.test(styleBody)) return styleBody.replace(re, `$1${Math.round(value)}px$2`);
  return styleBody;
}
