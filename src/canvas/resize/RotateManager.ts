// RotateManager.ts — Handles pointer-driven element rotation.
// Math: angle from element center to pointer = rotation.
// Follows imperative-first pattern: DOM updates instantly, code catches up.
//
// Two write paths:
//   - Plain elements / top-level <svg>: CSS `transform: rotate(Ndeg)` style.
//   - SVG shape wrappers (a <svg> with an inner path/polygon/…): the SVG
//     `transform="rotate(angle cx cy)"` ATTRIBUTE on the inner shape, pivot
//     baked in. CSS rotation on a NESTED <svg> orbits because transform-origin
//     defaults to `0 0` there; the explicit-pivot attribute has no such
//     ambiguity. Mirrors how the reference stores SVG rotation.

import { updateNodeStyles, patchNodeStyles, findNodeRect, findNodeComputedStyle, findNodeComputedStyles, findSvgShapeChild, getViewportPrefix, getActiveFilePath, getSvgGroupAncestorChain, isPrimaryViewport } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { getScreenCornersById } from '@/canvas/resize/geometry-utils';
import { styleHelperOps } from '@/canvas/selection/style-helper-store';
import { trace } from '@/shared/debug-trace';
import { getDefaultStore } from 'jotai';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { projectFS } from '@/code/project/project-fs';
import { nodesAtom, getNodeFromCache } from '@/code/stores/store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { getEffectiveStyles } from '@/canvas/selection/pin-constraint-utils';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { refitGroupChain } from '@/code/svg/refit-group';
import { modifyProjectFile } from '@/code/project/modify-file';
import { normalizeShapeWrapperViewBoxInCode, ensureShapeChildIds } from '@/code/generation/generator-attrs';
import { svgChildCarrierOrigin, groupChildScaleToGeometryUpdates } from '@/canvas/drag/replica-context';
import { motionPropsToCSSTransform } from '@/shared/motion-transform';
import type { CanvasNode } from '@/code/parsing/parser';

let cleanup: (() => void) | null = null;

interface RotateCallbacks {
  contentEl: HTMLElement;
  nodeId: string;
  onInteracting: (active: boolean) => void;
}

/**
 * Start rotating an element.
 * Call from SelectionOverlay's handleRotateStart.
 */
export function startRotate(
  nodeId: string,
  vpId: string,
  startEvent: PointerEvent,
  callbacks: RotateCallbacks,
): void {
  if (cleanup) { cleanup(); cleanup = null; }

  const { contentEl, onInteracting } = callbacks;
  const vpPrefix = getViewportPrefix(vpId);

  // Capture original inline transform (to preserve non-rotation parts on commit)
  // Read from NodeMap inline styles (same as el.style.transform in direct mode)
  const store = getDefaultStore();
  const nodes = store.get(nodesAtom);
  const nodeData = nodes.get(nodeId);

  // SVG shape wrapper → rotate via the inner shape's `transform` ATTRIBUTE
  // (explicit pivot), not a CSS transform on the wrapper.
  const shapeChild = findSvgShapeChild(nodeData, nodes);
  // A GROUP <svg> (svg children, no inner shape) rotates around its PAINTED-
  // content centre (its `transform-origin` pivot). For a NESTED group whose
  // attribute box doesn't equal its content, the box AABB centre
  // (`findNodeRect`) is NOT that pivot — using it makes the handle-drag angle
  // reference diverge from the spin point, so the group jumps. The group's
  // SCREEN CORNERS (cornersCache → `paintedGroupUserBounds`) already hug the
  // painted content, so their centroid IS the pivot in screen space — for
  // nested AND top-level, rotated or not, with no dependency on the box being
  // freshly refit (the rect cache updates async). Use that as the angle centre.
  const isGroupWrapper = nodeData?.type === 'svg' && !shapeChild
    && (nodeData.children ?? []).some(cid => nodes.get(cid)?.type === 'svg');
  let centerX: number, centerY: number;
  const groupCorners = isGroupWrapper ? getScreenCornersById(nodeId, vpId) : null;
  if (groupCorners) {
    centerX = (groupCorners.TL.x + groupCorners.TR.x + groupCorners.BR.x + groupCorners.BL.x) / 4;
    centerY = (groupCorners.TL.y + groupCorners.TR.y + groupCorners.BR.y + groupCorners.BL.y) / 4;
    trace.action('rotate:group-corner-centre', { nodeId, centerX, centerY });
  } else {
    // Get element center in screen space via bridge
    const rect = findNodeRect(nodeId, vpId);
    if (!rect) {
      trace.error('rotate:start:no-rect', { nodeId, vpId });
      return;
    }
    centerX = rect.left + rect.width / 2;
    centerY = rect.top + rect.height / 2;
  }

  // A top-level svg SHAPE (parent is NOT an svg) now rotates via its WRAPPER's
  // CSS transform — per-variant + animatable, and it doesn't bleed to the
  // primary (the inner-attribute write did: a single SHARED attr with no
  // viewport/variant routing). Only a NESTED shape (inside an svg GROUP) keeps
  // the inner-attribute path, because CSS `transform` ORBITS on a nested <svg>.
  const wrapperParent = nodeData?.parentId ? nodes.get(nodeData.parentId) : null;
  const parentIsSvg = wrapperParent?.type === 'svg';

  // Current rotation from computed transform via bridge. A top-level shape may
  // still carry a LEGACY inner-attr rotation (created before this change) — read
  // the angle from that attr so the wrapper rotation continues from it; the migration
  // block below moves it onto the wrapper in one frame and clears the attr.
  const computedTransform = findNodeComputedStyle(nodeId, vpId, 'transform');
  const legacyShapeRotate = (shapeChild && !parentIsSvg)
    ? parseSvgRotate(shapeChild.node.attrs?.transform)
    : null;
  const currentRotation = legacyShapeRotate
    ? legacyShapeRotate.angle
    : parseRotationFromMatrix(computedTransform);
  if (nodeData && shapeChild && parentIsSvg) {
    const started = startSvgShapeRotate(
      nodeId, vpId, vpPrefix, startEvent, callbacks,
      shapeChild.node, nodeData, centerX, centerY,
    );
    if (started) return;
    // No usable geometry bbox — fall through to the CSS path below.
  }

  // A NESTED group (a GROUP <svg> whose parent is also <svg>) must rotate via
  // the SVG `transform="rotate(θ cx cy)"` ATTRIBUTE — CSS `transform-box:
  // border-box` ORBITS on a nested <svg> (verified in-browser), the explicit
  // parent-space pivot spins in place. Top-level groups keep the CSS path.
  if (nodeData && isGroupWrapper && parentIsSvg) {
    startNestedGroupRotate(nodeId, vpId, vpPrefix, startEvent, callbacks, nodeData, centerX, centerY);
    return;
  }

  // TILE-EFFECTIVE transform, not base: an unpinned-on-variant element's
  // centering translate lives in the variant entry (or a replica's @media
  // band), not inline. Merging the live rotation into the BASE string
  // dropped the translate for the whole gesture — the element jumped
  // down-right by half its size and snapped back on mouseup (user report
  // 2026-08-27). The commit merge (non-variant-routed path in onUp) uses the
  // same effective base so a band-carried translate survives its band
  // commit; on a primary tile effective === base, byte-identical behavior.
  const vpCfgForTransform = getDefaultStore().get(viewportsConfigAtom).find(v => v.id === vpId);
  const vpMaxWidthForTransform =
    (!isComponentFilePath(getActiveFilePath()) && vpCfgForTransform && !vpCfgForTransform.isPrimary)
      ? (vpCfgForTransform.width ?? 0)
      : 0;
  const originalTransform = getEffectiveStyles(
    nodeId,
    nodeData?.styles ?? {},
    vpMaxWidthForTransform,
    getDefaultStore().get(containerOverridesAtom),
    nodeData?.motionVariants,
    isPrimaryViewport(vpId) ? 'default' : vpId,
  ).transform || '';

  // Track live transform for reading during onMove/onUp
  let liveTransform = originalTransform;
  let lastAppliedRotation = currentRotation;

  // A group <svg> (no inner shape → fell through to this CSS path) rotates
  // via a CSS transform on the wrapper. SVG elements default their
  // `transform-origin` to `0 0`, so without this it orbits the top-left
  // corner instead of spinning in place. Pivot on the painted-content centre
  // (robust to un-refit groups whose content sits outside the box). Mirrors
  // RotateControl's group write path so the handle-drag and slider agree.
  // Computed once — the content bbox doesn't change while only the wrapper
  // rotates.
  const isSvgWrapper = nodeData?.type === 'svg';
  // A single-shape svg (content fills the viewBox → painted centre == box centre)
  // pivots at `50% 50%`, expressed as a PERCENT so the CSS pivot AUTO-TRACKS the
  // box as it resizes. A baked-px origin (`64.5px 45.5px`) is the box centre only
  // at the size it was rotated; grow the box later and it drifts off-centre, so a
  // rotated resize can't pin the opposite corner (it slides). A GROUP's painted
  // content ≠ its box, so it keeps the explicit painted-centre px origin.
  const pivotStyles: Record<string, string> = isSvgWrapper
    ? (shapeChild
        ? { transformBox: 'border-box', transformOrigin: '50% 50%' }
        : svgPivotStyles(nodeId, vpId))
    : {};

  // Pivot-change compensation. The group rotates around its PAINTED-content
  // centre (svgPivotStyles), but the stored `transform-origin` may be the BOX
  // centre (set by refit/resize) — they differ when a child was rotated/reshaped
  // without refitting the group box. Switching the origin mid-rotation (angle ≠ 0)
  // shifts the painted result by (I-R(θ))·(O_new - O_old), which the user sees as
  // a JUMP the instant rotation starts. Cancel it by shifting left/top the
  // opposite way (and commit those too, so there's no jump on mouseup either).
  if (isSvgWrapper && pivotStyles.transformOrigin && currentRotation) {
    const o1 = (nodeData?.styles?.transformOrigin || '').match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
    const o2 = pivotStyles.transformOrigin.match(/(-?[\d.]+)px\s+(-?[\d.]+)px/);
    if (o1 && o2) {
      const dx = parseFloat(o2[1]) - parseFloat(o1[1]);
      const dy = parseFloat(o2[2]) - parseFloat(o1[2]);
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        const a = (currentRotation * Math.PI) / 180;
        const cos = Math.cos(a), sin = Math.sin(a);
        // -(I-R(θ))·(dx,dy);  (I-R) = [1-cos, sin; -sin, 1-cos]
        const compX = -((1 - cos) * dx + sin * dy);
        const compY = -(-sin * dx + (1 - cos) * dy);
        const curLeft = parseFloat(nodeData?.styles?.left || '0') || 0;
        const curTop = parseFloat(nodeData?.styles?.top || '0') || 0;
        pivotStyles.left = `${Math.round((curLeft + compX) * 1000) / 1000}px`;
        pivotStyles.top = `${Math.round((curTop + compY) * 1000) / 1000}px`;
      }
    }
  }

  // Migrate a LEGACY inner-attr rotation onto the wrapper in ONE frame (no
  // flash): clear the child `transform` attr live AND apply the same angle as a
  // wrapper CSS rotation simultaneously, so the shape stays at its current
  // visual rotation. The attr is dropped from SOURCE on commit (onUp).
  if (legacyShapeRotate) {
    (getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    }).setChildShapeAttribute?.(nodeId, vpPrefix, 0, 'transform', null);
    updateNodeStyles({
      id: nodeId,
      styles: { transform: mergeRotation(originalTransform, currentRotation), ...pivotStyles },
      contentEl,
      domOnly: true,
    });
  }

  // Starting angle from center to pointer
  const startAngle = Math.atan2(startEvent.clientY - centerY, startEvent.clientX - centerX);

  trace.action('rotate:start', { nodeId, vpId, currentRotation, centerX, centerY, migratedFromAttr: !!legacyShapeRotate });
  onInteracting(true);

  const onMove = (e: PointerEvent) => {
    // Current angle from center to pointer
    const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    const deltaAngle = (angle - startAngle) * (180 / Math.PI);

    // Snap to 15° increments when Shift held
    let newRotation = currentRotation + deltaAngle;
    if (e.shiftKey) {
      newRotation = Math.round(newRotation / 15) * 15;
    }

    // Apply rotation via bridge. Use `updateNodeStyles({ domOnly: true })`
    // (not `patchNodeStyles`) so the rotation broadcasts to every
    // viewport's painting of the same node, not just the primary.
    // Drag strategies use the same pattern for live multi-viewport
    // sync — without this fan-out, replicas only catch up on mouseup
    // (when the source commit re-renders them), so the user sees the
    // primary rotate but the replicas stay frozen until release.
    // `domOnly: true` skips the mutation queue + cache update so the
    // commit at mouseup remains the single source-of-truth write.
    const newTransform = mergeRotation(originalTransform, newRotation);
    updateNodeStyles({
      id: nodeId,
      styles: { transform: newTransform, ...pivotStyles },
      contentEl,
      domOnly: true,
    });
    liveTransform = newTransform;
    lastAppliedRotation = newRotation;

    // Show rotation tooltip near cursor
    styleHelperOps.show({
      type: 'rotate',
      position: { x: e.clientX, y: e.clientY },
      value: newRotation,
    });
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;

    // Use the last applied rotation (tracked locally, no DOM read needed)
    const finalRotation = lastAppliedRotation;

    trace.action('rotate:end', { nodeId, vpId, finalRotation });

    // PER-VARIANT rotation of a PLAIN motion element (component master,
    // non-primary variant): route the angle into the variant object as an
    // EXPLICIT `rotate` motion value — the same channel the SVG shape handle
    // (commitVariantRotation) and the Styles Rotate control already use.
    // The CSS-transform path below writes `transform: mergeRotation(orig, 0) ===
    // ''` for a 0° result, which the variant routing (updateVariantStyleInCode)
    // reads as "reset override" and DELETES the rotate from the variant entry.
    // So rotating a variant element back to 0 — when its DEFAULT variant is
    // rotated (e.g. 90°) — silently dropped the override (`'variant-1': {}`) and
    // the tile rendered rotated like the primary. A non-zero angle worked (it
    // wrote a real `rotate`), which is why it looked intermittent. Writing an
    // explicit `rotate: 0` fixes it. SVG wrappers keep the CSS + group-refit
    // path below (their variant rotation already routes via startSvgShapeRotate).
    if (!isSvgWrapper && isComponentFilePath(getActiveFilePath()) && !isPrimaryViewport(vpId)) {
      trace.action('rotate:end-variant-routed-plain', { nodeId, vpId, finalRotation });
      commitVariantRotation(nodeId, vpId, finalRotation);
      styleHelperOps.hide();
      onInteracting(false);
      return;
    }

    // TOP-LEVEL SVG WRAPPER on a variant tile. Nested shapes returned early
    // via startSvgShapeRotate, so any svg wrapper reaching here is top-level —
    // and the CSS commit below writes updateNodeStyles to the BASE inline
    // transform, which a variant tile NEVER paints (it reads the variant
    // entry). So the rotation silently reverted on mouseup and the dropped
    // pivot shifted it left (live find 2026-09-05, X arm on variant-1; the
    // preview was already correct, only the commit diverged).
    //
    // Route the angle into the variant entry like plain elements do, and
    // write the SAME `pivotStyles` the preview painted (border-box + bbox
    // centre) to base — motion applies `rotate` with no origin of its own, so
    // the base pivot governs and the commit is pixel-identical to the last
    // preview tick.
    // Top-level svg wrapper on a variant → the SAME variant-entry commit the
    // slider and plain elements use (commitVariantRotation now resolves the
    // svg-wrapper pivot via variantRotateCarrier, so handle and slider land
    // identically). Nested shapes returned early via startSvgShapeRotate.
    if (isSvgWrapper && isComponentFilePath(getActiveFilePath()) && !isPrimaryViewport(vpId)) {
      if (legacyShapeRotate) {
        queueMutation({ type: 'updateSvgAttrs', nodeId, attrs: { transform: '' }, childIndex: 0 });
      }
      commitVariantRotation(nodeId, vpId, finalRotation);
      styleHelperOps.hide();
      onInteracting(false);
      return;
    }

    // Commit to code — merge final rotation into ORIGINAL transform (preserve translate, scale, etc.)
    const transformValue = mergeRotation(originalTransform, finalRotation);

    // Drop the pivot helpers when returning to 0° so we don't leave a dead
    // `transform-box`/`transform-origin` on the node once it's unrotated.
    const commitPivot = transformValue ? pivotStyles : (isSvgWrapper ? { transformBox: '', transformOrigin: '' } : {});
    updateNodeStyles({
      id: nodeId,
      styles: { transform: transformValue, ...commitPivot },
      contentEl,
    });

    // Migration commit: drop the now-stale inner-shape `transform` attr from
    // SOURCE so it can't double up with the wrapper rotation we just committed.
    if (legacyShapeRotate) {
      queueMutation({ type: 'updateSvgAttrs', nodeId, attrs: { transform: '' }, childIndex: 0 });
    }

    // Rotating a GROUP changes the bounds it (and any ancestor group) must wrap
    // — shrink-wrap the whole `<svg>`-group ancestor chain to the rotated
    // content so every level's box/selection stays snug (Part 2, recursive).
    if (isGroupWrapper) {
      flushNow();
      const chain = getSvgGroupAncestorChain(nodeId);
      if (chain.length > 0) refitGroupChain(chain, getActiveFilePath());
    }

    styleHelperOps.hide();
    onInteracting(false);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onInteracting(false);
  };
}

/**
 * Rotate an SVG shape wrapper by writing `transform="rotate(angle cx cy)"`
 * onto its inner shape element. Returns false (so `startRotate` falls back to
 * the CSS path) when no geometry bbox is available to derive the pivot.
 */
function startSvgShapeRotate(
  nodeId: string,
  vpId: string,
  vpPrefix: string,
  startEvent: PointerEvent,
  callbacks: RotateCallbacks,
  shapeNode: CanvasNode,
  nodeData: CanvasNode,
  centerX: number,
  centerY: number,
): boolean {
  const { contentEl, onInteracting } = callbacks;
  const bridge = getCanvasBridge() as {
    setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
  };

  const originalShapeTransform = shapeNode.attrs?.transform || '';
  const existing = parseSvgRotate(originalShapeTransform);
  const legacyCssTransform = nodeData.styles?.transform || '';

  // Pivot (cx,cy) in the shape's own user space:
  //   1. reuse the pivot baked into an existing rotate(a cx cy) — captured
  //      when rotation was first applied, stays stable across re-rotations.
  //   2. else the wrapper's painted-geometry bbox center. With no rotation
  //      attr yet, <svg>.getBBox() ignores the wrapper's own (legacy CSS)
  //      transform AND its children carry no transform → it IS the
  //      un-rotated geometry, exactly the pivot we want.
  let cx: number, cy: number;
  if (existing) {
    cx = existing.cx;
    cy = existing.cy;
  } else {
    const bbox = findNodeComputedStyles(nodeId, vpId, ['__bboxX', '__bboxY', '__bboxWidth', '__bboxHeight']);
    const bx = parseFloat(bbox.__bboxX);
    const by = parseFloat(bbox.__bboxY);
    const bw = parseFloat(bbox.__bboxWidth);
    const bh = parseFloat(bbox.__bboxHeight);
    if (![bx, by, bw, bh].every(Number.isFinite)) {
      trace.error('rotate:svg:no-bbox', { nodeId, vpId });
      return false;
    }
    cx = bx + bw / 2;
    cy = by + bh / 2;
  }

  const currentRotation = existing
    ? existing.angle
    : parseRotationFromMatrix(findNodeComputedStyle(nodeId, vpId, 'transform'));

  // Clear any legacy CSS transform on the <svg> wrapper live so it doesn't
  // visually compound with the new attribute rotation during the drag.
  if (legacyCssTransform) {
    patchNodeStyles(contentEl, nodeId, vpPrefix, { transform: '' });
  }

  const startAngle = Math.atan2(startEvent.clientY - centerY, startEvent.clientX - centerX);
  let lastAppliedRotation = currentRotation;

  // Rotating a child changes its PAINTED bounds, so the group must re-fit (box
  // == content). No path did this before — an absolute group hides the stale
  // box behind overflow:visible + getBBox selection, but a FLEX group reads the
  // stale SIZE and mis-positions in its layout. Commit refit (`refitGroupBounds`)
  // for any SVG-group parent; live refit (`liveRefitGroup`) for flex groups only.
  const groupId = nodeData.parentId || null;
  const rotNodes = getDefaultStore().get(nodesAtom);
  const groupNode = groupId ? rotNodes.get(groupId) : null;
  const groupIsSvg = groupNode?.type === 'svg';
  const groupPos = (groupIsSvg && groupId) ? (findNodeComputedStyles(groupId, vpId, ['position']).position || '') : '';
  // Live refit the parent group during the rotate. The bridge command walks the
  // whole `<svg>`-group ancestor CHAIN (`liveRefitGroupChainEl`) and only acts
  // when the TOP-LEVEL group is in a flex/flow LAYOUT (so the layout reflows live);
  // on the canvas (absolute top) it's a no-op → commit-time refit. So passing the
  // immediate parent (even a NESTED group, which is `position: static`) is safe —
  // the chain handles nested attrs + the canvas/flex decision internally.
  const liveRefitGroupId = (groupIsSvg && groupId && groupPos !== 'absolute' && groupPos !== 'fixed') ? groupId : null;
  const commitRefitGroupId = groupIsSvg ? groupId : null;

  trace.action('rotate:start', { nodeId, vpId, currentRotation, centerX, centerY, svgShape: true, cx, cy });
  onInteracting(true);

  // PER-VARIANT rotation preview: on a non-primary variant the painted
  // rotation lives in the WRAPPER's folded CSS transform (variant entry +
  // view-box carrier), not the inner shape's attr. Previewing via the inner
  // attr COMPOSES with the wrapper's existing folded rotate — the painting
  // visibly un/double-transforms for the whole gesture and only lands right
  // on the mouseup rebuild (user find 2026-06-12). Preview by patching the
  // folded wrapper transform instead: the first tick equals the current
  // painted state and the last tick equals the commit — stable throughout.
  // ONE rotation channel for nested children in component files: the motion
  // entry (default entry on the primary) + the view-box carrier. The legacy
  // inner-ATTR rotation skews/vanishes under non-bake box changes (panel
  // width on the primary distorted it; live find 2026-06-12) — new rotations
  // always go to the motion channel; an existing attr angle is folded into
  // the baseline and cleared at commit.
  const rotParentNode = getNodeFromCache(nodeId)?.parentId
    ? getNodeFromCache(getNodeFromCache(nodeId)!.parentId!)
    : null;
  const rotParentIsSvg = rotParentNode?.type === 'svg';
  // NESTED children: always the motion channel (primary = default entry).
  // TOP-LEVEL shapes keep their existing wrapper-CSS primary path; only
  // their variant rotations ride the motion channel (as before).
  const isVariantRotatePreview = isComponentFilePath(getActiveFilePath())
    && (rotParentIsSvg || !isPrimaryViewport(vpId));
  const rotateEntryName = isPrimaryViewport(vpId) ? 'default' : vpId;
  const variantEntryForPreview: Record<string, string | number> = isVariantRotatePreview
    ? ({
      ...((rotateEntryName !== 'default' ? getNodeFromCache(nodeId)?.motionVariants?.default : undefined) ?? {}),
      ...(getNodeFromCache(nodeId)?.motionVariants?.[rotateEntryName] ?? {}),
    } as Record<string, string | number>)
    : {};
  // INHERITING-REPLICA LIVE MIRROR: a PRIMARY rotation belongs to every
  // variant tile whose own entry lacks `rotate` (they inherit the default).
  // The commit already syncs them — mirroring per tick makes the sync LIVE
  // instead of snapping on mouseup. Each mirror folds the live default
  // (with the in-progress angle) UNDER the variant's own entry, the same
  // merge resolveVariantStyles paints.
  const inheritingMirrors: Array<{ prefix: string; own: Record<string, string | number> }> = [];
  if (isVariantRotatePreview && rotateEntryName === 'default') {
    const mvAll = getNodeFromCache(nodeId)?.motionVariants ?? {};
    // Variant tiles come from the component's variantConfig (NOT
    // viewportsConfigAtom, which holds page viewports — empty for variant
    // mirroring; the first pass silently mirrored to nobody).
    let variantNames: string[] = [];
    try {
      variantNames = parseVariantConfig(projectFS.readFile(getActiveFilePath()) ?? '').map(v => v.name);
    } catch { /* no config — nothing to mirror */ }
    for (const vName of variantNames) {
      if (vName === vpId || vName === 'default') continue;
      const own = (mvAll[vName] ?? {}) as Record<string, string | number>;
      if (own.rotate != null && own.rotate !== '') continue; // independent rotation — don't touch
      inheritingMirrors.push({ prefix: `${vName}-`, own });
    }
  }

  // Preview base BEFORE the first tick: pivot carrier + legacy-attr clear on
  // the interacting tile and every inheriting mirror — see the helper's doc.
  if (isVariantRotatePreview) {
    applyVariantRotatePreviewBase(nodeId, vpPrefix, vpId);
    for (const m of inheritingMirrors) applyVariantRotatePreviewBase(nodeId, m.prefix, vpId);
  }

  const onMove = (e: PointerEvent) => {
    const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    let newRotation = currentRotation + (angle - startAngle) * (180 / Math.PI);
    if (e.shiftKey) newRotation = Math.round(newRotation / 15) * 15;

    if (isVariantRotatePreview) {
      const folded = motionPropsToCSSTransform({ ...variantEntryForPreview, rotate: newRotation });
      getCanvasBridge().patchStyles(nodeId, vpPrefix, { transform: folded }, true);
      for (const m of inheritingMirrors) {
        const mFolded = motionPropsToCSSTransform({ ...variantEntryForPreview, rotate: newRotation, ...m.own });
        getCanvasBridge().patchStyles(nodeId, m.prefix, { transform: mFolded }, true);
      }
    } else {
      const attr = mergeSvgRotate(originalShapeTransform, newRotation, cx, cy);
      bridge.setChildShapeAttribute?.(nodeId, vpPrefix, 0, 'transform', attr || null);
      // Live group auto-fit — AFTER the rotated transform is in the DOM (flex only).
      if (liveRefitGroupId) getCanvasBridge().liveRefitGroup?.(liveRefitGroupId, vpPrefix);
    }
    lastAppliedRotation = newRotation;

    styleHelperOps.show({
      type: 'rotate',
      position: { x: e.clientX, y: e.clientY },
      value: newRotation,
    });
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;

    const finalRotation = lastAppliedRotation;
    const attr = mergeSvgRotate(originalShapeTransform, finalRotation, cx, cy);

    trace.action('rotate:end', { nodeId, vpId, finalRotation, svgShape: true, attr });

    // PER-VARIANT ROTATION (component master, non-primary variant): the inner
    // shape's `transform` ATTRIBUTE is SHARED by every variant painting —
    // committing there leaks the rotation onto the primary (live find
    // 2026-06-11). Route the angle into the variant object as a `rotate`
    // motion value instead — same per-variant channel as x/y position deltas.
    // Probe FACT 3 (motion-svg-variant-position.test.tsx): motion applies it
    // as style.transform rotate(θdeg) with NO transform-origin, so the wrapper
    // carries inline transformBox: fill-box + transformOrigin: 50% 50% to pin
    // the rotation to the shape's own center in every renderer. Those two
    // props are inert without a rotation — safe on the shared base. The
    // default entry gets the neutral return path (rotate: 0, the transform
    // law: animated transforms need an entry in every variant).
    if (isVariantRotatePreview) {
      // The live preview patched the WRAPPER's folded transform (never the
      // inner attr), and its last tick equals the committed fold — leave it;
      // the flush rebuild replaces it with the identical value, seamless.
      // Full commit pipeline (normalize, geometry migration, carrier, entry
      // write, default seed, legacy fold) shared with the Styles-panel
      // Rotate control.
      commitVariantRotation(nodeId, vpId, finalRotation);
      styleHelperOps.hide();
      onInteracting(false);
      return;
    }

    // Commit the rotation onto the inner shape's `transform` attribute.
    queueMutation({ type: 'updateSvgAttrs', nodeId, attrs: { transform: attr }, childIndex: 0 });
    // Drop the legacy CSS transform from source so it can't fight the attr.
    if (legacyCssTransform) {
      updateNodeStyles({ id: nodeId, styles: { transform: '' }, contentEl });
    }

    // Re-fit the group to the rotated child's new painted bounds. Flush first so
    // the refit reads the freshly-committed transform (same ordering rule as the
    // rotated-child resize commit). Refit the WHOLE `<svg>`-group ancestor chain
    // (not just the immediate parent) so a rotated shape inside a NESTED group
    // shrink-wraps every level above it (Part 2, recursive). refitGroupInSource
    // is flex-aware (omits left/top for a flow child) so it works in both
    // contexts.
    if (commitRefitGroupId) {
      flushNow();
      const chain = getSvgGroupAncestorChain(commitRefitGroupId);
      refitGroupChain(chain.length > 0 ? chain : [commitRefitGroupId], getActiveFilePath());
    }

    styleHelperOps.hide();
    onInteracting(false);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onInteracting(false);
  };

  return true;
}

/**
 * Rotate a NESTED group (a GROUP `<svg>` whose parent is also `<svg>`) via the
 * SVG `transform="rotate(θ cx cy)"` ATTRIBUTE on the group element itself, with
 * the pivot `(cx,cy)` in the PARENT group's user space (= the group's box centre
 * `x+w/2, y+h/2`). CSS `transform-box: border-box` ORBITS on a nested `<svg>`
 * (the browser doesn't pin the pivot to the element's own box); the explicit
 * attribute pivot spins in place — verified in-browser. Mirrors the shape path,
 * but the attribute lives on the group wrapper, not an inner geometry element.
 */
function startNestedGroupRotate(
  nodeId: string,
  vpId: string,
  vpPrefix: string,
  startEvent: PointerEvent,
  callbacks: RotateCallbacks,
  nodeData: CanvasNode,
  centerX: number,
  centerY: number,
): void {
  const { contentEl, onInteracting } = callbacks;
  const bridge = getCanvasBridge();

  // Reuse the pivot baked into an existing `rotate(θ cx cy)` (stable across
  // re-rotations); else the group's box centre in PARENT space. The legacy CSS
  // rotation (transform/transformBox/transformOrigin in style) is cleared and
  // migrated to this attribute — a one-time snap from the old orbited pose to
  // the correct spin-in-place pose.
  const existingAttr = nodeData.attrs?.transform || '';
  const am = existingAttr.match(/rotate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/);
  // Pivot (cx,cy) = the PAINTED-CONTENT centre in PARENT user space, NOT the box
  // centre. The selection box / rotate handle are drawn at the content bounds
  // (`paintedGroupUserBounds`); pivoting on the box centre when box ≠ content
  // makes the selection swing/orbit as you drag (the "weird and jumps"). getBBox
  // (served as `__bbox*`) is the content bounds in the group's OWN user space;
  // at our 1:1 viewBox that's parent units, offset by the group's x/y. The angle
  // centre passed in (`centerX/centerY` = corners centroid) IS this point in
  // screen space, so the handle math and the visual pivot agree.
  const bb = findNodeComputedStyles(nodeId, vpId, ['__bboxX', '__bboxY', '__bboxWidth', '__bboxHeight']);
  const bx = parseFloat(bb.__bboxX), by = parseFloat(bb.__bboxY);
  const bw = parseFloat(bb.__bboxWidth), bh = parseFloat(bb.__bboxHeight);
  const gx = parseFloat(nodeData.attrs?.x ?? '0') || 0;
  const gy = parseFloat(nodeData.attrs?.y ?? '0') || 0;
  let cx: number, cy: number, currentRotation: number;
  if ([bx, by, bw, bh].every(Number.isFinite) && bw > 0 && bh > 0) {
    cx = gx + bx + bw / 2;
    cy = gy + by + bh / 2;
  } else {
    const gw = parseFloat(nodeData.attrs?.width ?? '0') || 0;
    const gh = parseFloat(nodeData.attrs?.height ?? '0') || 0;
    cx = gx + gw / 2;
    cy = gy + gh / 2;
  }
  if (am) {
    currentRotation = parseFloat(am[1]);
  } else {
    // Migrate any legacy CSS rotation angle to the attribute.
    currentRotation = parseRotationFromMatrix(findNodeComputedStyle(nodeId, vpId, 'transform'));
  }
  const hadLegacyCss = !!(nodeData.styles?.transform || nodeData.styles?.transformOrigin);

  // Clear the legacy CSS rotation live so it can't compound with the attribute.
  if (hadLegacyCss) {
    patchNodeStyles(contentEl, nodeId, vpPrefix, { transform: '', transformBox: '', transformOrigin: '' });
  }

  const startAngle = Math.atan2(startEvent.clientY - centerY, startEvent.clientX - centerX);
  let lastAppliedRotation = currentRotation;

  trace.action('rotate:start', { nodeId, vpId, currentRotation, centerX, centerY, nestedGroup: true, cx, cy });
  onInteracting(true);

  const onMove = (e: PointerEvent) => {
    const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
    let newRotation = currentRotation + (angle - startAngle) * (180 / Math.PI);
    if (e.shiftKey) newRotation = Math.round(newRotation / 15) * 15;
    lastAppliedRotation = newRotation;

    const attr = `rotate(${Math.round(newRotation * 10) / 10} ${cx} ${cy})`;
    // Set the transform ATTRIBUTE on the group element (patchAttrsAndStyles
    // emits corners/rect/ancestor refresh so the selection + parent outline
    // track live).
    bridge.patchAttrsAndStyles?.(nodeId, vpPrefix, { transform: attr }, {});
    // Rotating a nested group changes its painted (rotated) extent, which its
    // ANCESTOR groups must wrap — refit the chain LIVE so a flex-layout top-level
    // group reflows each frame. No-op on the canvas (absolute top).
    if (nodeData.parentId) bridge.liveRefitGroup?.(nodeData.parentId, vpPrefix);

    styleHelperOps.show({ type: 'rotate', position: { x: e.clientX, y: e.clientY }, value: newRotation });
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    cleanup = null;

    const finalRotation = lastAppliedRotation;
    const attr = finalRotation ? `rotate(${Math.round(finalRotation * 10) / 10} ${cx} ${cy})` : '';
    trace.action('rotate:end', { nodeId, vpId, finalRotation, nestedGroup: true, attr });

    // Commit the rotation onto the group's OWN `transform` attribute.
    queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { transform: attr } });
    // Drop the legacy CSS rotation from source so it can't fight the attribute.
    if (hadLegacyCss) {
      updateNodeStyles({ id: nodeId, styles: { transform: '', transformBox: '', transformOrigin: '' }, contentEl });
    }
    // Refit the whole ancestor chain to the rotated content (recursive).
    flushNow();
    const chain = getSvgGroupAncestorChain(nodeId);
    if (chain.length > 0) refitGroupChain(chain, getActiveFilePath());

    styleHelperOps.hide();
    onInteracting(false);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    onInteracting(false);
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Pivot styles (transform-box + transform-origin) that rotate a GROUP /
 *  top-level `<svg>` around its PAINTED-content centre rather than its CSS
 *  box centre. Why content-centre: a group whose child was dragged outside
 *  the original box (stale, not-yet-refit — e.g. child `y="-1133"` while the
 *  box is `0 0 1370 389`) paints its content far off the box; box-centre
 *  rotation would swing it in a huge arc ("offset / not in the centre").
 *
 *  `getBBox` (served as `__bbox*`) gives the content bbox in user units.
 *  Group viewBoxes are always `0 0 W H` at 1:1, so those units are px from
 *  the border-box top-left — `transform-box: border-box` + an explicit
 *  `Npx Npx` origin pins the pivot to the content centre deterministically
 *  (no reliance on fill-box's outer-svg semantics, which vary by browser).
 *  Falls back to fill-box/center when no bbox is available. */
export function svgPivotStyles(nodeId: string, vpId: string): Record<string, string> {
  const b = findNodeComputedStyles(nodeId, vpId, ['__bboxX', '__bboxY', '__bboxWidth', '__bboxHeight']);
  const bx = parseFloat(b.__bboxX), by = parseFloat(b.__bboxY);
  const bw = parseFloat(b.__bboxWidth), bh = parseFloat(b.__bboxHeight);
  if ([bx, by, bw, bh].every(Number.isFinite) && bw > 0 && bh > 0) {
    const cx = Math.round((bx + bw / 2) * 100) / 100;
    const cy = Math.round((by + bh / 2) * 100) / 100;
    return { transformBox: 'border-box', transformOrigin: `${cx}px ${cy}px` };
  }
  return { transformBox: 'fill-box', transformOrigin: 'center' };
}

/** Parse rotation degrees from a CSS matrix string. Pure — no DOM access. */
export function parseRotationFromMatrix(matrixStr: string | null | undefined): number {
  if (!matrixStr || matrixStr === 'none') return 0;

  const match = matrixStr.match(/matrix\(([^)]+)\)/);
  if (!match) return 0;

  const values = match[1].split(',').map(v => parseFloat(v.trim()));
  if (values.length < 2) return 0;

  return Math.atan2(values[1], values[0]) * (180 / Math.PI);
}

/** Build the CSS transform string for a given rotation angle. Pure. */
export function buildRotationTransform(degrees: number): string {
  if (degrees === 0) return '';
  return `rotate(${Math.round(degrees * 10) / 10}deg)`;
}

/** Snap rotation to 15° increments. */
export function snapRotation(degrees: number): number {
  return Math.round(degrees / 15) * 15;
}

/** Calculate rotation from center point to pointer. */
export function calculateRotationAngle(
  centerX: number, centerY: number,
  pointerX: number, pointerY: number,
): number {
  return Math.atan2(pointerY - centerY, pointerX - centerX);
}

/**
 * Replace only the rotate() part of an existing transform string.
 * Preserves other transforms (translateX, translateY, scale, etc.).
 */
export function mergeRotation(existingTransform: string, degrees: number): string {
  const rotateStr = degrees !== 0 ? `rotate(${Math.round(degrees * 10) / 10}deg)` : '';
  // Remove existing rotate(...) from the transform
  const withoutRotate = existingTransform
    .replace(/rotate\([^)]*\)\s*/g, '')
    .trim();
  if (!withoutRotate && !rotateStr) return '';
  if (!withoutRotate) return rotateStr;
  if (!rotateStr) return withoutRotate;
  return `${withoutRotate} ${rotateStr}`;
}

// ─── SVG Shape Rotation (transform ATTRIBUTE, explicit pivot) ───────────────
// SVG shapes rotate via a `transform="rotate(angle cx cy)"` ATTRIBUTE on the
// inner shape element. The pivot (cx,cy) is baked in — unlike CSS
// `transform: rotate()` whose pivot depends on `transform-origin` /
// `transform-box`, which defaults to `0 0` on a nested <svg> and makes the
// shape orbit instead of spinning in place.

/**
 * Parse `rotate(a)` / `rotate(a cx cy)` (commas or spaces) out of an SVG
 * transform-attribute string. Returns null when there is no rotate().
 * cx/cy default to 0 for the bare `rotate(a)` form. Pure.
 */
export function parseSvgRotate(
  attr: string | null | undefined,
): { angle: number; cx: number; cy: number } | null {
  if (!attr || attr === 'none') return null;
  const m = attr.match(/rotate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+))?\s*\)/);
  if (!m) return null;
  const angle = parseFloat(m[1]);
  if (!Number.isFinite(angle)) return null;
  const cx = m[2] != null ? parseFloat(m[2]) : 0;
  const cy = m[3] != null ? parseFloat(m[3]) : 0;
  return {
    angle,
    cx: Number.isFinite(cx) ? cx : 0,
    cy: Number.isFinite(cy) ? cy : 0,
  };
}

/**
 * Build an SVG `rotate(angle cx cy)` transform-attribute value. Returns the
 * empty string at angle 0 so the attribute round-trips as "no rotation".
 * Pure.
 */
export function buildSvgRotate(angle: number, cx: number, cy: number): string {
  if (!angle) return '';
  const a = Math.round(angle * 10) / 10;
  const x = Math.round(cx * 100) / 100;
  const y = Math.round(cy * 100) / 100;
  return `rotate(${a} ${x} ${y})`;
}

/**
 * Replace only the rotate() part of an SVG transform attribute, preserving
 * any other transforms (e.g. a translate()). Mirrors `mergeRotation` for the
 * CSS-style path. Pure.
 */
export function mergeSvgRotate(
  existingAttr: string,
  angle: number,
  cx: number,
  cy: number,
): string {
  const rotateStr = buildSvgRotate(angle, cx, cy);
  const without = (existingAttr || '')
    .replace(/rotate\([^)]*\)\s*/g, '')
    .trim();
  if (!without && !rotateStr) return '';
  if (!without) return rotateStr;
  if (!rotateStr) return without;
  return `${without} ${rotateStr}`;
}

/** Commit a MOTION-CHANNEL rotation (component group child / variant tile):
 *  normalize + stamp inner ids, migrate any CSS scale to geometry, write the
 *  carrier + the entry rotate, seed the default return path (presence-
 *  guarded), and fold-and-clear a legacy inner-attr rotation. Shared by the
 *  rotate HANDLE commit and the Styles-panel Rotate control. */
/**
 * Paint everything the VARIANT rotate preview needs BESIDES the folded
 * transform, so every gesture tick equals the commit's final paint:
 *
 *   1. the pivot carrier — the same branch commitVariantRotation writes
 *      (view-box + px origin for a nested group child, fill-box/center
 *      otherwise). Without it the live rotation spins around the wrapper's
 *      DEFAULT origin: the bar visibly offset for the whole gesture and only
 *      snapped right on mouseup (live find 2026-09-05, X-icon arm).
 *   2. a cleared legacy inner-attr rotation — the old `rotate(a cx cy)` attr
 *      otherwise keeps painting UNDER the wrapper preview and compounds.
 *
 * Idempotent — the slider path calls it per tick.
 */
/**
 * The pivot carrier for a variant rotation, resolved once so preview AND
 * commit, handle AND slider all agree (a fill-box/border-box mismatch between
 * the slider's commit and the handle's made the slider offset — live find
 * 2026-09-05). Three shapes:
 *   - nested group child (parent is <svg>) → view-box + px origin
 *   - top-level <svg> wrapper              → border-box + bbox-centre px
 *     (motion applies `rotate` with no origin of its own, so this pins the
 *      spin to the PAINTED content centre — what the handle preview uses)
 *   - plain element                        → fill-box/centre
 */
function variantRotateCarrier(nodeId: string, vpId: string): Record<string, string> {
  const node = getNodeFromCache(nodeId);
  const parent = node?.parentId ? getNodeFromCache(node.parentId) : null;
  if (node && parent?.type === 'svg') {
    return svgChildCarrierOrigin(node.attrs, parent.attrs?.viewBox) as unknown as Record<string, string>;
  }
  if (node?.type === 'svg') {
    // MIRROR the handle's general-path pivotStyles EXACTLY (see its comment):
    // a single-SHAPE svg (content fills the viewBox → painted centre == box
    // centre) pivots at 50% 50% as a PERCENT so it auto-tracks resize; only a
    // GROUP svg (no inner shape) keeps the painted-centre px origin.
    // svgPivotStyles for BOTH made the slider spin around the bbox-px point
    // (~top of a short box: 12.5px 2px ≈ 51%/17%) while the handle and commit
    // used 50% 50% — offset during the slider drag, snapping right on mouseup
    // (live find 2026-09-05).
    const shapeChild = findSvgShapeChild(node, getDefaultStore().get(nodesAtom));
    return shapeChild
      ? { transformBox: 'border-box', transformOrigin: '50% 50%' }
      : svgPivotStyles(nodeId, vpId);
  }
  return { transformBox: 'fill-box', transformOrigin: '50% 50%' };
}

export function applyVariantRotatePreviewBase(nodeId: string, vpPrefix: string, vpId: string): void {
  const node = getNodeFromCache(nodeId);
  getCanvasBridge().patchStyles(nodeId, vpPrefix, variantRotateCarrier(nodeId, vpId), true);
  const innerId = node?.children?.[0];
  const innerTransform = innerId ? (getNodeFromCache(innerId)?.attrs?.transform ?? '') : '';
  if (innerTransform && parseSvgRotate(innerTransform)) {
    (getCanvasBridge() as { setChildShapeAttribute?: (p: string, v: string, i: number, a: string, val: string | null) => void })
      .setChildShapeAttribute?.(nodeId, vpPrefix, 0, 'transform', null);
  }
}

export function commitVariantRotation(nodeId: string, vpId: string, finalRotation: number): void {
  const rotateEntryName = isPrimaryViewport(vpId) ? 'default' : vpId;
  const originalShapeTransform = (() => {
    const n = getNodeFromCache(nodeId);
    const innerId = n?.children?.[0];
    return innerId ? (getNodeFromCache(innerId)?.attrs?.transform ?? '') : '';
  })();
  modifyProjectFile(getActiveFilePath(), (code) =>
    ensureShapeChildIds(normalizeShapeWrapperViewBoxInCode(code, nodeId), nodeId).code);
  for (const mig of groupChildScaleToGeometryUpdates(nodeId, rotateEntryName, getActiveFilePath())) {
    queueMutation(mig as any);
  }
  queueMutation({ type: 'updateStyles', nodeId, styles: variantRotateCarrier(nodeId, vpId) });
  queueMutation({
    type: 'updateVariantStyle', nodeId, variantName: rotateEntryName,
    styles: { rotate: `${Math.round(finalRotation * 10) / 10}` },
  });
  if (rotateEntryName !== 'default') {
    const defRotateCur = getNodeFromCache(nodeId)?.motionVariants?.default?.rotate;
    if (defRotateCur == null || defRotateCur === '') {
      queueMutation({ type: 'updateVariantStyle', nodeId, variantName: 'default', styles: { rotate: '0' } });
    }
  }
  if (originalShapeTransform && parseSvgRotate(originalShapeTransform)) {
    queueMutation({ type: 'updateSvgAttrs', nodeId, attrs: { transform: '' }, childIndex: 0 });
  }
  trace.action('rotate:end-variant-routed', { nodeId, variantName: rotateEntryName, rotate: finalRotation });
  flushNow();
}
