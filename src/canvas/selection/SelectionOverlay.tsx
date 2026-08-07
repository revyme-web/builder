// SelectionOverlay.tsx — Orchestrates all selection visual helpers.
// Single RAF loop polls selected element position.
// Composes: HoverHighlight, SelectionBorder, ResizeHandles, RotateHandle.

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAtomValue, useSetAtom, getDefaultStore } from 'jotai';
import { selectedNodeAtom, selectedIdsAtom, hoveredIdAtom, hoveredViewportIdAtom, hoveredNodeIdAtom, canvasInteractingAtom, isRotatingAtom, isComponentSelectedAtom, isMapTemplateSelectedAtom, isComponentFileAtom, nodesAtom, mapItemIndexAtom, marqueeViewportSpreadAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { marqueeSelectionSig } from './SelectionBox';
import { activeEditorAtom, suppressSelectionOverlayAtom, colorPickerOpenAtom } from '@/code/stores/editor-store';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { SELECTION_COLOR, COMPONENT_COLOR, MAP_TEMPLATE_COLOR, isTextTag, isFitSize } from '@/shared/constants';
import { interactingViewportIdAtom, viewportWidthsAtom, syncViewportWidths, viewportsConfigAtom, viewportPositionsAtom, getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { isDefaultLocaleAtom } from '@/code/stores/locale-store';
import { rewriteAnimationBreakpoints } from '@/code/animations/animation-scope';
import { rewriteContainerBreakpoints, rewriteResponsiveBreakpoints, rewriteResponsiveTextBreakpoints } from '@/code/generation/generator-styles';
import { modifyProjectFile } from '@/code/project/modify-file';
import { findNodeRect, findGhostsForTemplate, getContentRoot, updateNodeStyles, findNodeComputedStyles, patchNodeStyles, getViewportPrefix, forceCanvasRender } from '@/canvas/node-ops';
import { mirrorPrimaryViewportHeightToRoot } from '@/canvas/viewport-size-ops';
import { makeGhostId } from '@/shared/ghost-id';
import { updateVariantPosition } from '@/code/variants/variant-ops';
import { projectFS } from '@/code/project/project-fs';
import { syncQueueCode } from '@/code/mutation/mutation-queue';
import { computeArrowPathFromCorners, computeArrowPathFromRects } from '@/canvas/ui/arrow-path';
import { getScreenCornersById, getElementRotationById, cornersEqual, getHandlesFromDirection, cornersFromRect, getOppositeCorner, processZeroCrossing, updateDirectionAfterCrossing, nodeOrAncestorHasRotationOrSkewById, type ScreenCorners, type Direction } from '@/canvas/resize/geometry-utils';
import { getTransformedPoint } from '@/canvas/canvas-math';
import { startResize, applyAspectRatioLock } from '@/canvas/resize/ResizeManager';
import { startRotate, parseRotationFromMatrix, mergeRotation } from '@/canvas/resize/RotateManager';
import { transformManager } from '@/canvas/transform';
import type { SnapGuide } from '@/shared/types';
import { styleHelperOps } from './style-helper-store';
import { trace } from '@/shared/debug-trace';
import HoverHighlight from './HoverHighlight';
import SelectionBorder from './SelectionBorder';
import ResizeHandles from './ResizeHandles';
import SelectionFade from './SelectionFade';
import RotateHandle from './RotateHandle';
import BorderRadiusHandle from './BorderRadiusHandle';
import ObjectPositionHandle from './ObjectPositionHandle';
import PaddingHandles from './PaddingHandles';
import { resolveOverlaySize } from './overlay-size';
import GapHandles from './GapHandles';
import GripHandle from './GripHandle';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import InteractionOutline from './InteractionOutline';
import StyleUpdateHelper from './StyleUpdateHelper';
import DropLineIndicator from './DropLineIndicator';
import ParentHighlight from './ParentHighlight';
import GradientOverlay from './GradientOverlay';
import ClipPathOverlay from './ClipPathOverlay';
import { activeGradientAtom, selectedGradientStopAtom, gradientUpdateCallbackAtom, gradientStopUpdateCallbackAtom, gradientStopSelectCallbackAtom, gradientCommitCallbackAtom, isMaskGradientAtom } from '@/code/stores/gradient-store';
import { activeClipPathAtom, clipPathUpdateCallbackAtom, clipPathCommitCallbackAtom } from '@/code/stores/clippath-store';
import { activeFancyRadiusAtom, fancyRadiusCallbackAtom, fancyRadiusCommitAtom } from '@/code/stores/borderradius-store';
import FancyRadiusOverlay from './FancyRadiusOverlay';
import { shapeEditingIdAtom, shapeEditCommitPendingAtom, groupEditingIdAtom } from '@/code/stores/shape-edit-store';
import { sketchEditingIdAtom } from '@/code/stores/sketch-edit-store';
import { isPickingAnimTargetAtom } from '@/code/stores/animation-store';
import { panHighlightAtom } from '@/code/stores/tool-store';

/**
 * Determine if hover should be suppressed (hovering the exact same element as selection).
 * Different viewport or different ghost index → show hover.
 */
function isHoveringSameAsSelected(
  hoveredId: string, selectedId: string | null,
  hoveredVpId: string, selectedVpId: string,
  hoveredNodeId: string | null, mapItemIndex: number | null,
): boolean {
  if (hoveredId !== selectedId) return false;
  if (hoveredVpId !== selectedVpId) return false;
  // Same data-id + same viewport. Now check ghost context:
  // Extract ghost index from hoveredNodeId (e.g. "card__2" → 2, "card" → null)
  const hoveredGhostMatch = hoveredNodeId?.match(/__(\d+)$/);
  const hoveredGhostIdx = hoveredGhostMatch ? parseInt(hoveredGhostMatch[1], 10) : null;
  // Selected ghost index: mapItemIndex (0 = template, 1+ = ghost, null = not in map)
  const selectedGhostIdx = mapItemIndex;
  // Both not in ghost context → same element
  if (hoveredGhostIdx === null && (selectedGhostIdx === null || selectedGhostIdx === 0)) return true;
  // Both are ghosts — only suppress if same index
  if (hoveredGhostIdx !== null && selectedGhostIdx !== null && hoveredGhostIdx === selectedGhostIdx) return true;
  // Template (index 0) hovered while ghost selected, or vice versa → show hover
  return false;
}

interface SelectionOverlayProps {
  onGripDragStart?: (nodeId: string, event: React.PointerEvent, gripAxis: 'x' | 'y') => void;
  /** Live snap-guide updates during resize. Same callback Canvas wires for drag. */
  onSnapGuidesChange?: (guides: SnapGuide[]) => void;
}

export default function SelectionOverlay({ onGripDragStart, onSnapGuidesChange }: SelectionOverlayProps = {}) {
  // Viewers can select a node for inspection — but the selection is
  // visual-only: just the border, no resize / rotate / radius / padding /
  // gap / grip handles (those are all edit affordances).
  const isViewer = useIsViewer();
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const marqueeSpread = useAtomValue(marqueeViewportSpreadAtom);
  const hoveredId = useAtomValue(hoveredIdAtom);
  const hoveredVpId = useAtomValue(hoveredViewportIdAtom);
  const hoveredNodeId = useAtomValue(hoveredNodeIdAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const setInteracting = useSetAtom(canvasInteractingAtom);
  const setRotating = useSetAtom(isRotatingAtom);
  // DELIBERATELY whole-map (category B-adjacent): this overlay is keyed to
  // the SELECTED node, which changes on every drag commit anyway — a
  // per-node migration would not skip its re-render during the interactions
  // that matter, and the ~15 scattered map reads below (ancestor walks over
  // selection + hover, per-selectedIds filters, JSX-inline lookups) make a
  // faithful split high-risk for zero practical win. Identity preservation
  // still keeps its useMemos cheap.
  const nodes = useAtomValue(nodesAtom);
  const isComponent = useAtomValue(isComponentSelectedAtom);
  const isMapTemplate = useAtomValue(isMapTemplateSelectedAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  // True when the active file is a component master OR a TEMPLATE (LayoutClient).
  // Both are shared content that renders PURPLE (accent-secondary) — the user is
  // editing something reused across the site, and the colour is the cue. Use the
  // WIDE predicate (isComponentFileAtom = isComponentLikeFilePath) to MATCH the
  // hover + parent highlights (HoverHighlight also reads isComponentFileAtom), so
  // selecting a node on a template is purple just like hovering it. (A previous
  // narrow-predicate attempt made the SELECT overlay blue on templates while
  // hover/parent stayed purple — the inconsistency the user reported.)
  const isInComponentMaster = useAtomValue(isComponentFileAtom);
  // MULTI-select render pairs: (top-level id × viewport). MARQUEE selections
  // carry a per-node viewport spread, so each node outlines on EVERY artboard
  // the sweep covered and the group box + handles enclose ALL of them
  // (desktop + tablet + mobile at once, standard). The sig check
  // self-invalidates a stale spread after any non-marquee selection change —
  // those fall back to the interacting viewport, the pre-spread behavior.
  // Memoized so GroupBoundingBox's RAF poll doesn't restart every render.
  const multiSelectPairs = useMemo(() => {
    if (selectedIds.length <= 1) return [] as Array<{ id: string; vpId: string }>;
    const selSet = new Set(selectedIds);
    const topLevelIds = selectedIds.filter(id => {
      let walker: string | null | undefined = nodes.get(id)?.parentId;
      while (walker) {
        if (selSet.has(walker)) return false;
        walker = nodes.get(walker)?.parentId;
      }
      return true;
    });
    const spreadValid = marqueeSpread && marqueeSpread.sig === marqueeSelectionSig(selectedIds);
    const vpsFor = (id: string): string[] =>
      (spreadValid && marqueeSpread!.byNode[id]?.length ? marqueeSpread!.byNode[id]! : [vpId]);
    return topLevelIds.flatMap(id => vpsFor(id).map(v => ({ id, vpId: v })));
  }, [selectedIds, nodes, marqueeSpread, vpId]);
  // CMS-collection-template counterpart of `isMapTemplate`. Same shape
  // (selected node lives inside a `.map()` callback) — different source.
  // Drives the ghost-outline + arrow-connector overlay below.
  const isCmsCollectionTemplate = useMemo(() => {
    if (!selectedId) return false;
    let current = nodes.get(selectedId);
    while (current) {
      const parent = current.parentId ? nodes.get(current.parentId) : null;
      if (parent?.collectionList && !parent.collectionList.source.startsWith('__inline:')) return true;
      current = parent ?? undefined;
    }
    return false;
  }, [selectedId, nodes]);
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const setViewportWidths = useSetAtom(viewportWidthsAtom);
  const setViewportsConfig = useSetAtom(viewportsConfigAtom);
  const setVpPositions = useSetAtom(viewportPositionsAtom);
  // Read viewport configs reactively so the resize-disabled flags update
  // immediately when the user toggles auto ↔ px height in the SizeTool.
  // Reading via `getDefaultStore()` from inside the layout-effect (as the
  // earlier draft did) only re-evaluates when `selectedId` / `vpId` change,
  // which leaves the vertical handles stuck off after the user picks px.
  const allViewportConfigs = useAtomValue(viewportsConfigAtom);
  // Master files: ALWAYS purple regardless of what's selected — the
  // user is editing shared component content, the colour-coding is the
  // safety cue. Map templates stay green (they're a different kind of
  // shared content). Pages: blue unless the selection is itself a
  // component instance, in which case purple (already handled by
  // `isComponent`).
  const selectionColor = isMapTemplate
    ? MAP_TEMPLATE_COLOR
    : (isComponent || isInComponentMaster)
      ? COMPONENT_COLOR
      : SELECTION_COLOR;
  const activeGradient = useAtomValue(activeGradientAtom);
  const selectedGradientStop = useAtomValue(selectedGradientStopAtom);
  const gradientCallback = useAtomValue(gradientUpdateCallbackAtom);
  const stopUpdateCallback = useAtomValue(gradientStopUpdateCallbackAtom);
  const stopSelectCallback = useAtomValue(gradientStopSelectCallbackAtom);
  const gradientCommit = useAtomValue(gradientCommitCallbackAtom);
  const isMask = useAtomValue(isMaskGradientAtom);
  const setActiveGradient = useSetAtom(activeGradientAtom);
  const setGradientCallback = useSetAtom(gradientUpdateCallbackAtom);
  const activeClipPath = useAtomValue(activeClipPathAtom);
  const clipPathCallback = useAtomValue(clipPathUpdateCallbackAtom);
  const clipPathCommit = useAtomValue(clipPathCommitCallbackAtom);
  const activeFancyRadius = useAtomValue(activeFancyRadiusAtom);
  const fancyRadiusCallback = useAtomValue(fancyRadiusCallbackAtom);
  const fancyRadiusCommit = useAtomValue(fancyRadiusCommitAtom);
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const sketchEditingId = useAtomValue(sketchEditingIdAtom);
  const shapeEditCommitPending = useAtomValue(shapeEditCommitPendingAtom);
  const groupEditingId = useAtomValue(groupEditingIdAtom);
  const isPickingAnimTarget = useAtomValue(isPickingAnimTargetAtom);
  const isPanMode = useAtomValue(panHighlightAtom);
  const activeEditor = useAtomValue(activeEditorAtom);
  const isTextEditing = !!activeEditor;
  const suppressOverlay = useAtomValue(suppressSelectionOverlayAtom);
  // Color/gradient picker open → hide the selection box + handles (but NOT the
  // gradient / clip-path editing overlays, which the user is dragging).
  const colorPickerOpen = useAtomValue(colorPickerOpenAtom);
  const [corners, setCorners] = useState<ScreenCorners | null>(null);
  const [rotation, setRotation] = useState(0);
  const [resizeDisabled, setResizeDisabled] = useState<{ h: boolean; v: boolean }>({ h: false, v: false });

  // ── Corners DURING render on selection change (paint in the SAME commit) ──
  // The `instant-corners` layout effect below sets `corners` only AFTER the whole
  // selection re-render commits — which on a node-create includes the properties
  // panel re-rendering all its tools (~60ms). That's why the overlay (border,
  // handles, radius handle) lands one render LATER than the panel. Setting it here
  // — a conditional setState during render (valid React derived-state pattern, runs
  // once per selection change) — pulls the corners into THIS render, so the whole
  // overlay paints in the same frame as everything else. For a freshly-created
  // node the bridge rect was just SEEDED, so this resolves instantly. The layout
  // effect still runs and re-asserts the same values (+ resizeDisabled / display).
  const radiusGateSigRef = useRef<string>(''); // DIAGNOSTIC: gate-transition logging
  const cornersSelIdRef = useRef<string | null>(null);
  if (selectedId !== cornersSelIdRef.current) {
    cornersSelIdRef.current = selectedId;
    const gid = makeGhostId(selectedId ?? '', mapItemIndex ?? 0);
    const fresh = selectedId
      ? (getScreenCornersById(gid, vpId) ?? getScreenCornersById(selectedId, vpId))
      : null;
    setCorners(fresh);
    setRotation(selectedId ? getElementRotationById(gid, vpId) : 0);
  }

  // Reset cached corners when suppression toggles ON. The corners value
  // sits stale across suppression because the RAF poll's last write
  // sticks while the overlay is hidden — so on un-suppress the next
  // render paints the OLD rect for one frame before the poll re-measures
  // (visible as the outline jumping from the previous font's bounds to
  // the new font's bounds when the user picks a font from the family
  // popup). Forcing corners to null on suppression-on means
  // un-suppression always paints from a fresh RAF measurement.
  useEffect(() => {
    if (suppressOverlay) setCorners(null);
  }, [suppressOverlay]);

  // Reset corners on active-file change. The RAF poll's "keep stale on
  // transient miss" rule keeps the LAST known corners when a getCorners
  // call returns null — but on file switch the last-known corners are
  // from the PREVIOUS file (same data-id, different file). Without this
  // reset the overlay paints the previous file's rect until the next
  // non-null poll overwrites it; the user sees a "huge stale overlay" on
  // entry until any action triggers a fresh render. Explicit reset means
  // the poll always starts from null after a switch and only paints once
  // it has a real master-file rect. (`activeFilePath` is declared earlier
  // in the component body — see the atom subscriptions block.)
  useEffect(() => {
    setCorners(null);
  }, [activeFilePath]);

  // Clear gradient overlay when selected node changes — prevents stale overlay on different nodes
  useEffect(() => {
    setActiveGradient(null);
    setGradientCallback(null);
  }, [selectedId]);

  // Instant corners on selection change — runs BEFORE browser paint.
  // This eliminates the flash between hover disappearing and selection appearing.
  // NOTE: deps intentionally exclude `nodes` — the RAF poll below keeps corners
  // fresh during drag. Re-firing this on every `nodes` change caused
  // `setCorners(null)` to flicker the overlay when the iframe was mid-rebuild,
  // unmounting FancyRadiusOverlay and losing pointer capture during drags.
  useLayoutEffect(() => {
    if (!selectedId) {
      setCorners(null);
      trace.action('selection-overlay:clear', { reason: 'no selectedId' });
      return;
    }
    // Use bridge corners cache (accurate for rotated elements).
    // When the user clicked a .map() ghost, mapItemIndex points at that ghost
    // index — look up the GHOST'S corners (templateId__N) so the selection
    // box draws on the clicked ghost, not the index-0 template.
    const ghostId = makeGhostId(selectedId!, mapItemIndex ?? 0);
    // Hidden nodes (display: none from base styles, @media replicas, or
    // motionVariants) report `getBoundingClientRect()` as DOMRect(0, 0, 0,
    // 0) — the selection border, resize handles, grip, radius handle, etc.
    // would all then draw stacked at the canvas origin (top-left), which
    // looked like a phantom overlay attached to nothing. Bail before
    // setting corners so the entire overlay tree renders nothing.
    const computedDisplay = findNodeComputedStyles(ghostId, vpId, ['display']).display
      || findNodeComputedStyles(selectedId!, vpId, ['display']).display;
    if (computedDisplay === 'none') {
      setCorners(null);
      trace.action('selection-overlay:hidden-node', { selectedId, vpId, reason: 'display:none' });
      return;
    }
    let c: ScreenCorners | null = getScreenCornersById(ghostId, vpId);
    if (!c && ghostId !== selectedId) c = getScreenCornersById(selectedId!, vpId);
    setRotation(getElementRotationById(ghostId, vpId));
    if (c) {
      setCorners(c);
      const selectedNode = selectedId ? nodes.get(selectedId) : null;
      const isInstanceWrapper = selectedNode?.componentFile && !selectedNode?.componentInstanceId;
      const nodeStyles = isInstanceWrapper ? (selectedNode?.styles ?? {}) : (selectedNode?.styles ?? {});
      // SVG group child: width/height live in `node.attrs` (SVG attrs),
      // not in CSS styles. Without this fallback, the disabled-axis
      // logic below sees empty width/height styles and turns OFF both
      // axes — the user gets no resize handles at all (just a tiny
      // rotate dot). Fall back to attrs so the resize handles render
      // for nested-SVG selections inside a group.
      const selectedParent = selectedNode?.parentId ? nodes.get(selectedNode.parentId) : null;
      const isSvgGroupChild = selectedNode?.type === 'svg' && selectedParent?.type === 'svg';
      // Resolve width/height for THIS artboard's variant so a replica whose size
      // is overridden per-variant (e.g. height: variant === 'variant-1' ? '311px'
      // : 'min-content') shows the right handles — the raw node.styles carries the
      // base ('min-content'), which wrongly reads as auto/fit.
      const resolvedSize = selectedNode
        ? resolveOverlaySize(selectedNode, vpId, allViewportConfigs, isInComponentMaster)
        : { width: '', height: '' };
      const w = resolvedSize.width || (isSvgGroupChild ? (selectedNode?.attrs?.width || '') : '') || '';
      const h = resolvedSize.height || (isSvgGroupChild ? (selectedNode?.attrs?.height || '') : '') || '';
      const hasHInset = !!(nodeStyles.left && nodeStyles.right);
      const hasVInset = !!(nodeStyles.top && nodeStyles.bottom);
      const elIsFitSvg = false; // Can't detect without element
      // Viewport frames (page `root` / `layout::root`): the JSX has
      // `width: '100%'` because the element fills its parent at runtime, but
      // dragging the resize handle is supposed to change the *viewport
      // breakpoint width* (handled by `ResizeManager.ts:886` via the
      // `onViewportResize` callback, NOT by writing a CSS width). Without
      // this branch the `w === '100%'` check below disables the horizontal
      // handles and the user only gets a rotation dot, no way to resize.
      const isViewportFrame = selectedId === 'root' || selectedId === 'layout::root';
      // Vertical handles for viewport frames: enabled ONLY when the user
      // has opted into a fixed-px height (vp.height set in the @canvas
      // block). In auto mode the viewport stretches to content and a
      // vertical drag has nothing meaningful to write — keep them hidden.
      // When vp.height IS set, dragging top/bottom updates the persisted
      // height via `onViewportResize`'s newHeight argument.
      const vpForFrame = isViewportFrame
        ? allViewportConfigs.find(vp => vp.id === vpId)
        : undefined;
      // Vertical handles also light up when THIS replica is inheriting
      // the primary's px height — dragging the bottom/corner handle on
      // an inheriting replica is exactly how the user DETACHES it (the
      // resize callback writes the new height onto this replica's own
      // `vp.height`). Without the primary-fallback, the bottom handles
      // were hidden on every replica that didn't already have its own
      // height, so there was no way to start the detach gesture.
      const primaryVp = isViewportFrame ? allViewportConfigs.find(v => v.isPrimary) ?? allViewportConfigs[0] : undefined;
      const ownHasPx = !!(vpForFrame && typeof vpForFrame.height === 'number' && vpForFrame.height > 0);
      const baseHasPx = !!(primaryVp && primaryVp !== vpForFrame && typeof primaryVp.height === 'number' && primaryVp.height > 0);
      const vpHasPxHeight = ownHasPx || baseHasPx;
      const hDisabled = isViewportFrame ? false : !elIsFitSvg && !hasHInset && (!w || isFitSize(w) || w === '100%');
      const vDisabled = isViewportFrame ? !vpHasPxHeight : elIsFitSvg || (!hasVInset && (!h || isFitSize(h)));
      setResizeDisabled({ h: hDisabled, v: vDisabled });
      trace.action('selection-overlay:instant-corners', { selectedId, vpId, found: true, isViewportFrame, vpHasPxHeight, ownHasPx, baseHasPx });
    } else {
      // Keep stale corners — element is transiently missing (likely mid-rebuild
      // from a renderer cycle). RAF poll will refresh as soon as it reappears.
      // Resetting to null here would unmount overlays and break in-flight drags.
      trace.action('selection-overlay:instant-corners', { selectedId, vpId, found: false, kept: 'stale' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, vpId, mapItemIndex, allViewportConfigs]);

  // RAF polling loop — keeps corners in sync during pan, zoom, resize, etc.
  useEffect(() => {
    if (!selectedId) return;
    let rafId: number;
    let lastFoundState: boolean | null = null;
    const poll = () => {
      // Use bridge corners cache (accurate for rotated elements).
      // For ghost selection (mapItemIndex > 0) follow the ghost, not the template.
      const pollGhostId = makeGhostId(selectedId!, mapItemIndex ?? 0);
      // Bail when the selected node is hidden in this viewport (display:
      // none from base, @media, or motionVariants). Without this the RAF
      // poll keeps re-asserting the (0,0,0,0) corners whenever the user
      // toggles visibility while the node is selected, and the overlay
      // re-appears at the canvas top-left.
      const pollDisplay = findNodeComputedStyles(pollGhostId, vpId, ['display']).display
        || findNodeComputedStyles(selectedId!, vpId, ['display']).display;
      if (pollDisplay === 'none') {
        setCorners(prev => prev === null ? prev : null);
        rafId = requestAnimationFrame(poll);
        return;
      }
      let newCorners: ScreenCorners | null = getScreenCornersById(pollGhostId, vpId);
      if (!newCorners && pollGhostId !== selectedId) {
        newCorners = getScreenCornersById(selectedId!, vpId);
      }
      // Trace node resolution changes (resolved ↔ missing in the bridge
      // corners cache). Formerly keyed off a parent-frame findNodeElement
      // read, which is always null in iframe mode — the bridge cache is
      // the authoritative source now.
      const found = !!newCorners;
      if (found !== lastFoundState) {
        trace.action('selection-overlay:poll-resolve', { selectedId, vpId, pollGhostId, found });
        lastFoundState = found;
      }
      setRotation(getElementRotationById(pollGhostId, vpId));
      if (newCorners) {
        setCorners(prev => cornersEqual(prev, newCorners!) ? prev : newCorners!);
        const selNode = selectedId ? nodes.get(selectedId) : null;
        const isInstWrap = selNode?.componentFile && !selNode?.componentInstanceId;
        const nStyles = selNode?.styles ?? {};
        // Mirror the instant-corners path's SVG-group-child fallback —
        // nested SVGs in a group store width/height as SVG ATTRS, not
        // CSS styles. Without this fallback the RAF poll keeps writing
        // `hDisabled = true, vDisabled = true` every frame (because
        // nStyles.width/height are empty for SVG attrs), wiping out the
        // handles ~1 frame after they first render via the instant
        // path. User-visible symptom: handles flash for ~0.1s then
        // disappear on every selection of a group child.
        const selParent = selNode?.parentId ? nodes.get(selNode.parentId) : null;
        const selIsSvgGroupChild = selNode?.type === 'svg' && selParent?.type === 'svg';
        // Resolve per-artboard variant size (see instant-corners path above).
        const resolvedSize = selNode
          ? resolveOverlaySize(selNode, vpId, allViewportConfigs, isInComponentMaster)
          : { width: '', height: '' };
        const w = resolvedSize.width || (selIsSvgGroupChild ? (selNode?.attrs?.width || '') : '') || '';
        const h = resolvedSize.height || (selIsSvgGroupChild ? (selNode?.attrs?.height || '') : '') || '';
        const hasHInset = !!(nStyles.left && nStyles.right);
        const hasVInset = !!(nStyles.top && nStyles.bottom);
        // Same viewport-frame override as the instant-corners path above —
        // page roots carry `width: '100%'` but resize means breakpoint-
        // width, not CSS width. Vertical handles enable only when the
        // user has opted into a fixed-px viewport height (so a drag has
        // a real value to write); auto-height keeps them hidden.
        const isViewportFrame = selectedId === 'root' || selectedId === 'layout::root';
        const vpForFrame = isViewportFrame
          ? allViewportConfigs.find(vp => vp.id === vpId)
          : undefined;
        // Mirror the instant-corners primary-fallback — see comment there.
        const primaryVp = isViewportFrame ? allViewportConfigs.find(v => v.isPrimary) ?? allViewportConfigs[0] : undefined;
        const ownHasPx = !!(vpForFrame && typeof vpForFrame.height === 'number' && vpForFrame.height > 0);
        const baseHasPx = !!(primaryVp && primaryVp !== vpForFrame && typeof primaryVp.height === 'number' && primaryVp.height > 0);
        const vpHasPxHeight = ownHasPx || baseHasPx;
        setResizeDisabled(prev => {
          const hDisabled = isViewportFrame ? false : !hasHInset && (!w || isFitSize(w) || w === '100%');
          const vDisabled = isViewportFrame ? !vpHasPxHeight : !hasVInset && (!h || isFitSize(h));
          if (prev.h === hDisabled && prev.v === vDisabled) return prev;
          return { h: hDisabled, v: vDisabled };
        });
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [selectedId, vpId, mapItemIndex, nodes, allViewportConfigs]);

  // ─── Resize start handler (corners + edges) ────────────────────────────
  const handleResizeStart = useCallback((direction: Direction, e: React.PointerEvent) => {
    if (!selectedId) return;

    const contentEl = getContentRoot();
    if (!contentEl) return;

    trace.action('selection-overlay:resize-start', { selectedId, direction, vpId });
    startResize(selectedId, vpId, direction, e.nativeEvent, {
      nodeId: selectedId,
      contentEl,
      onInteracting: setInteracting,
      onViewportResize: (resizedVpId, newWidth, newHeight = 0, newX) => {
        // 0. FRAME-PARITY x: a west-edge (or zero-crossing-flipped) resize
        // moved the tile's left live — persist the final x into the @canvas
        // positions or the commit re-render snaps the tile back to its old
        // spot ("resize left edge grows the right edge", 2026-08-07). East
        // drags pass the unchanged x (no-op).
        if (typeof newX === 'number' && Number.isFinite(newX)) {
          setVpPositions(prev => {
            const cur = prev[resizedVpId] ?? { x: 0, y: 0 };
            if (cur.x === newX) return prev;
            return { ...prev, [resizedVpId]: { ...cur, x: newX } };
          });
        }
        // 1. Get old width before updating — from the live viewport config
        // (respects custom breakpoints, unlike the old hardcoded VIEWPORTS).
        const oldVp = allViewportConfigs.find(v => v.id === resizedVpId);
        const oldWidth = oldVp?.width ?? newWidth;

        // 2. Update viewport width atom + imperative sync for the generator
        setViewportWidths(prev => {
          // Band rules in the FILE are keyed by the CONFIG width — always
          // rewrite from that. The widths ATOM is dirtied mid-drag by the
          // band-crossing live re-render (ResizeManager writes the crossing
          // width into it so the tile renders at the live width), so
          // `prev[resizedVpId]` here can be a transient drag value that no
          // band rule was ever keyed by.
          const prevWidth = oldWidth;
          const updated = { ...prev, [resizedVpId]: newWidth };
          syncViewportWidths(updated);

          // 3. Rewrite @container breakpoints AND animation media-query gates so
          //    both style overrides and responsive hover/tap overrides re-bucket
          //    to the resized viewport.
          if (prevWidth !== newWidth) {
            modifyProjectFile(activeFilePath, code =>
              // …plus component-instance `data-responsive` (per-viewport variant + `_bp`)
              // and width-keyed `useResponsiveText` overrides.
              rewriteResponsiveTextBreakpoints(
                rewriteResponsiveBreakpoints(
                  rewriteAnimationBreakpoints(
                    rewriteContainerBreakpoints(code, prevWidth, newWidth),
                    prevWidth, newWidth, getSortedBreakpointWidths()),
                  prevWidth, newWidth, getSortedBreakpointWidths()),
                prevWidth, newWidth, getSortedBreakpointWidths()));
          }

          return updated;
        });

        // 4. Persist the new breakpoint(s) to the `/** @canvas { viewports } */`
        // block. Width is always written for the resized viewport;
        // height is written only when the user opted into px-mode (the
        // resize handler signals this with `newHeight > 0`). When
        // `newHeight === 0` we leave the existing height field as-is.
        //
        // PRIMARY HEIGHT BROADCAST: when the user resizes the PRIMARY
        // viewport's height, we also write that height onto every
        // replica. Without this, each replica keeps its own `vp.height`
        // (copied at creation by `addViewport.ts`) and the Renderer
        // applies that as an inline override per-viewport — so after the
        // live-drag mirror lights up the replicas during the gesture,
        // mouseup snaps them back to their stale per-replica copies.
        // The user perceives this as "replicas revert on mouseup". This
        // broadcast keeps the replica's persisted height in lockstep
        // with primary's. Resizing a REPLICA vertically (`!isPrimaryResize`)
        // touches only that replica, same as before.
        const allVpsForCommit = getDefaultStore().get(viewportsConfigAtom);
        const primaryForCommit = allVpsForCommit.find(v => v.isPrimary) ?? allVpsForCommit[0];
        const isPrimaryResize = !!primaryForCommit && primaryForCommit.id === resizedVpId;
        setViewportsConfig(prev => prev.map(v => {
          if (v.id === resizedVpId) {
            if (newHeight > 0) return { ...v, width: newWidth, height: newHeight };
            return { ...v, width: newWidth };
          }
          if (isPrimaryResize && newHeight > 0) {
            return { ...v, height: newHeight };
          }
          return v;
        }));

        // 4b. Also mirror the new height onto the PAGE ROOT'S inline JSX
        // `style.height` for the PRIMARY viewport — that's what gives the
        // user a real `height: '1400px'` value in source (instead of the
        // stale `height: '100%'` placeholder that ignores the resize).
        // Replicas don't get this mirror: the root style is shared across
        // every viewport, so writing a replica's height there would force
        // primary + every other replica to the same value. Replica-only
        // height lives in vp.height (above) and the renderer applies it
        // inline per-viewport. Helper handles the syncQueueCode + flush
        // race itself.
        if (newHeight > 0 && isPrimaryResize) {
          const contentEl = getContentRoot();
          if (contentEl) {
            mirrorPrimaryViewportHeightToRoot({ activeFilePath, contentEl, height: newHeight });
          }
        }

        // 5. Force an immediate iframe render with the fresh viewport
        // widths. ResizeManager fires this callback BEFORE clearing its
        // own `interacting` flag (`ResizeManager.ts:891-893`), so the
        // post-callback React render still sees `renderer.interacting ===
        // true` and skips. After the flag flips false, no further dep
        // change re-fires the render effect — the iframe would stay at the
        // pre-resize width until the next unrelated event. forceRender
        // bypasses both skip flags and reads viewports imperatively from
        // jotaiStore (Canvas.tsx:435-485), so it picks up the writes from
        // steps 2 + 4 even before React commits.
        forceCanvasRender();

        trace.action('viewport:resize', { vpId: resizedVpId, newWidth, oldWidth });
      },
      onVariantPositionUpdate: (variantName, x, y) => {
        updateVariantPosition(activeFilePath, variantName, x, y);
        const freshCode = projectFS.readFile(activeFilePath);
        if (freshCode) syncQueueCode(freshCode);
        trace.action('variant:position-update-from-resize', { variantName, x, y });
      },
      onSnapGuidesChange: (guides) => onSnapGuidesChange?.(guides),
    });
  }, [selectedId, vpId, setInteracting, setViewportWidths, setViewportsConfig, activeFilePath, onSnapGuidesChange, allViewportConfigs]);

  // Edge resize uses the same handler
  const handleEdgePointerDown = handleResizeStart;

  // ─── Rotate start handler ─────────────────────────────────────────────
  const handleRotateStart = useCallback((e: React.PointerEvent, corner: string) => {
    if (!selectedId) return;

    const contentEl = getContentRoot();
    if (!contentEl) return;

    trace.action('selection-overlay:rotate-start', { selectedId, corner, vpId });
    startRotate(selectedId, vpId, e.nativeEvent, {
      nodeId: selectedId,
      contentEl,
      // Toggle isRotatingAtom alongside the generic interacting flag so the
      // InteractionOutline can hide itself for the duration of the rotate.
      onInteracting: (active) => {
        setInteracting(active);
        setRotating(active);
      },
    });
  }, [selectedId, vpId, setInteracting, setRotating]);

  // Text editing mode — hide the entire parent-frame overlay. The editor
  // mounts directly inside the sandbox iframe and we inject a CSS outline
  // on the editing element from text-edit-host, so the highlight grows
  // naturally with the text as the user types / line-wraps. The cached
  // corners used here only update on render, which lags behind the live
  // contentEditable expansion and produced the "outline doesn't follow
  // the text" mismatch.
  if (isTextEditing) return null;

  // Pan mode (space held or hand tool) — hide all overlays, no hover, no selection handles
  if (isPanMode) return null;

  // VIEWPORT-frame interaction (resize / tile drag) — hide the selection
  // chrome for the gesture and refit once on mouseup. The overlay refits
  // from the rect cache, which lags one frame behind the live `left`
  // patches a west-edge viewport resize makes (frame-parity x), so the
  // outline+handles jittered rightward against the stable tile ("header
  // and selection overlay glitch out to the right", 2026-08-07). The
  // gesture's own handlers live on window, so unmounting mid-drag is safe
  // (same pattern the rotate suppression uses).
  if (isInteracting && (selectedId === 'root' || selectedId === 'layout::root')) return null;

  // Font-family hover preview is open: the picker rapidly mutates the
  // selected text's font on every row hover, but the overlay's RAF
  // poll only re-measures once per frame and can't catch up — the user
  // sees the box border lagging behind the new text bounds. Hide
  // entirely while the picker is open; the popup atom flips back to
  // false on close and the overlay reappears.
  if (suppressOverlay) return null;

  // Sketch-edit mode owns its own visual indicator (the dashed accent
  // outline rendered by SketchEditOverlay). Showing the regular
  // selection box on top of that produces a confusing double-rect
  // (one matching wrapper bounds, one matching screen-corner content)
  // — exactly what the user reported as "weird behavior with a double
  // parent container". Hide cleanly while editing; the regular
  // overlay returns the moment edit mode exits.
  if (sketchEditingId) return null;

  // While picking an animation target: show only hover highlight (green) so user can see what they'd pick
  if (isPickingAnimTarget) return hoveredId ? <HoverHighlight nodeId={hoveredId} color="#22c55e" /> : null;

  // During interactions: show only the thin outline + style helper tooltip
  // + drag overlays (no handles/border). When shape-edit is active these
  // are all suppressed because the InteractionOutline / ParentHighlight
  // paint at the shape's wrapper bounds (which lag behind the morphing
  // path's live geometry as the user scrubs Width / Array). SvgEditorOverlay
  // is mounted separately by `<ShapeEditOverlayHost/>` (see Canvas.tsx) so
  // its lifecycle isn't tangled with SelectionOverlay's many early-return
  // paths — moving the JSX position of SvgEditorOverlay across an
  // isInteracting flip used to unmount+remount the component, which fired
  // commitShapeEdit on unmount and dropped the editor's selection on
  // remount → setShapeEditAnchorPosition no-op'd because no anchor was
  // selected → Position chevron drag froze after one tick.
  if (isInteracting) {
    if (shapeEditingId && selectedId === shapeEditingId) return null;
    return (
      <>
        <InteractionOutline />
        <ParentHighlight />
        <DropLineIndicator />
        <StyleUpdateHelper />
      </>
    );
  }

  // Shape-edit commit in flight: SvgEditorOverlay just unmounted and the
  // renderer hasn't yet flushed the new wrapper geometry into rectCache.
  // Reading findNodeRect now would return the STALE pre-edit bounds, so
  // hide the selection box until `bridge.onRenderComplete` clears the
  // flag (Canvas.tsx) — by then the cache reflects the morphed shape and
  // the box paints once at the correct final position. Without this gate,
  // the box visibly jumps from old→new bounds for one frame.
  if (shapeEditCommitPending) return null;

  return (
    <>
      {/* Hover highlight — suppress only when hovering the EXACT selected element
          (same data-id + same viewport + same ghost). Show for replicas and other ghosts.
          Also suppress when hovering the ISOLATED GROUP itself in group-edit mode —
          the user is "inside" that group editing its children, so highlighting
          the group's bounds reads as visual noise (the group's box-around-everything
          is implied, not interactive). Children of the group still highlight on
          hover so the user can see what they're about to click.

          Multi-select mode: when the hovered node is a DESCENDANT of any
          node in `selectedIds`, suppress the hover. The click handler
          redirects descendant clicks to the selected ancestor, so showing
          a hover border on the child is misleading — the user would
          click and select/drag the ancestor anyway. Reduces visual
          noise when a group with many descendants is selected. */}
      {(() => {
        // Color/gradient picker open → no hover highlight (same rule as the
        // selection box) so the canvas stays clean while you pick a color.
        if (colorPickerOpen) return null;
        if (!hoveredId) return null;
        if (isHoveringSameAsSelected(hoveredId, selectedId, hoveredVpId, vpId, hoveredNodeId, mapItemIndex)) return null;
        if (hoveredId === groupEditingId) return null;
        // NOTE: descendants of a multi-selected node used to be hover-SUPPRESSED
        // here, on the reasoning that "the user would click and select/drag the
        // ancestor anyway". That stopped being true — a click with no drag now
        // picks the child (see CanvasMouseController's deferred
        // `pendingMultiSelectChild`). With the outline gone as well, children of a
        // multi-selection read as completely inert: nothing lights up and nothing
        // seemed clickable (user report 2026-07-25). Showing it again is also just
        // honest — the outline now matches what the click will do.
        return <HoverHighlight nodeId={hoveredId} />;
      })()}

      {/* Dashed border around the selected node's parent — gives the user a
          visual cue of which container they're editing inside. Self-derived
          from the selection in this branch; the duplicated mount inside the
          isInteracting branch above lets drag strategies override the target
          via parentHighlightOps without a flicker on transition. */}
      {!colorPickerOpen && <ParentHighlight />}

      {/* Thin outline during interactions (drag, resize, rotate) */}
      <InteractionOutline />

      {/* ── SINGLE SELECTION: full handles + tools ── */}
      {corners && selectedId && selectedIds.length <= 1 && (
        <>
          {/* Border + handles fade in together (~0.12s) on appear / reposition
              jump (e.g. after a section reorder) — but not while dragging. */}
          <SelectionFade
            corners={corners}
            // Live cache probe — lets the fade's reveal ticker read the
            // CURRENT cornersCache directly instead of waiting for this
            // component's rAF-starved poll to deliver a new `corners` prop.
            // After a reparent drop the cache is fresh within ~60ms (the
            // bridge message handlers run between the parent's long tasks)
            // while the poll can lag hundreds of ms — see SelectionFade.
            liveCornersProbe={() => (selectedId ? getScreenCornersById(selectedId, vpId) : null)}
          >
          {/* Hide selection border + all handles while editing shape vertices,
              fancy radius, OR a color/gradient (colorPickerOpen) — in the last
              case the gradient/clip overlays below stay so the user can see and
              drag them without the selection chrome on top. */}
          {!shapeEditingId && !activeFancyRadius && !colorPickerOpen && (
            <SelectionBorder
              corners={corners}
              rotation={rotation}
              color={selectionColor}
            />
          )}
          {/* All handles (resize/rotate/radius/object-position/padding/
              gap/grip) are edit affordances — hidden for viewers AND in
              TRANSLATION MODE (non-default locale: selection border only,
              geometry is not editable — localization overhaul Phase 2). */}
          {!shapeEditingId && !activeFancyRadius && !isViewer && isDefaultLocale && !colorPickerOpen && (
            <>
              <ResizeHandles
                corners={corners}
                rotation={rotation}
                onResizeStart={handleResizeStart}
                color={selectionColor}
                disableHorizontal={resizeDisabled.h}
                disableVertical={resizeDisabled.v}
              />
              <RotateHandle
                corners={corners}
                rotation={rotation}
                onRotateStart={handleRotateStart}
              />
              {/* Border-radius handle: only show on non-rotated, non-text
                  elements where NO ANCESTOR carries a rotation/skew.
                  Text tags (p, h1-h6, span, etc.) don't get a visual
                  radius affordance — the handle would land on top of
                  the text and is rarely useful there.
                  Ancestor check: the handle is positioned in screen
                  space via `corners.TL`, and the drag is vertical in
                  screen Y. When an ancestor is rotated/skewed, the
                  axis the user perceives as "vertical" no longer
                  aligns with the element's local coordinate system,
                  so the radius update reads visually wrong. Helper
                  ignores pure scale/translate (canvas pan/zoom on
                  the viewport root) so it doesn't false-positive. */}
              {(() => {
                // DIAGNOSTIC (temporary): which gate input gates the radius
                // handle, and WHEN does it flip true? Logs on transition only.
                const rNode = nodes.get(selectedId);
                const isText = isTextTag(rNode?.type ?? '');
                const isSvg = rNode?.type === 'svg';
                const hasRot = nodeOrAncestorHasRotationOrSkewById(selectedId, vpId);
                const show = rotation === 0 && !isText && !isSvg && !hasRot;
                const sig = `${selectedId}|${show}|rot=${rotation}|t=${rNode?.type ?? '∅'}|hasRot=${hasRot}|c=${corners ? 'y' : 'n'}`;
                if (sig !== radiusGateSigRef.current) {
                  radiusGateSigRef.current = sig;
                  trace.action('selection-overlay:radius-gate', { selectedId, show, rotation, type: rNode?.type ?? '∅', isText, isSvg, hasRot, hasCorners: !!corners });
                }
                return show;
              })() && (
                <BorderRadiusHandle
                  corners={corners}
                  nodeId={selectedId}
                  vpId={vpId}
                  color={selectionColor}
                  onInteracting={setInteracting}
                />
              )}
              {/* Object-position handle (bottom-right dot): only renders
                  when the element actually has something to reposition —
                  an <img>/<video> in `object-fit: cover`, or a frame
                  with a `background-image` in `background-size: cover`.
                  Drag adjusts the CSS position so the user can frame
                  the visible portion of a cropped background. The
                  handle itself early-returns null in non-eligible
                  cases, so it's safe to always include. */}
              {rotation === 0 && (
                <ObjectPositionHandle
                  corners={corners}
                  nodeId={selectedId}
                  vpId={vpId}
                  nodeType={nodes.get(selectedId)?.type ?? ''}
                  color={selectionColor}
                  onInteracting={setInteracting}
                />
              )}
              <PaddingHandles
                nodeId={selectedId}
                vpId={vpId}
                onInteracting={setInteracting}
              />
              <GapHandles
                nodeId={selectedId}
                vpId={vpId}
                onInteracting={setInteracting}
              />
              {/* Grip handle is axis-aligned by design — its drag direction
                  presumes a non-rotated, non-skewed bounding box. When the
                  element itself OR any ancestor carries a transform with
                  non-zero rotation/skew, the corners are no longer axis-
                  aligned (TL.y !== TR.y or TL.x !== BL.x). In that case
                  the grip would still drag along its own screen axis,
                  which produces visually wrong reparent gestures relative
                  to the rotated element. Hide it instead. This single
                  geometric check covers BOTH the element-rotated case
                  (selectedNode.styles.transform: rotate(X)) AND the
                  ancestor-transformed case (parent's matrix bleeds into
                  the bounding rect). */}
              {(() => {
                const TOL = 0.5; // px tolerance for floating-point noise
                const axisAligned =
                  Math.abs(corners.TL.y - corners.TR.y) < TOL &&
                  Math.abs(corners.BL.y - corners.BR.y) < TOL &&
                  Math.abs(corners.TL.x - corners.BL.x) < TOL &&
                  Math.abs(corners.TR.x - corners.BR.x) < TOL;
                if (!axisAligned) return null;
                // Hide the grip (drag-to-reorder) on a child of a WRAPPING flex
                // container: once children wrap onto multiple lines the single-axis
                // reorder drag is ambiguous (cross-line neighbours), so it shouldn't
                // appear — mirrors the GapHandles flex-wrap guard, but read from the
                // PARENT here since the grip sits on a CHILD. Source style first
                // (sync, reliable), computed as fallback.
                const sel = nodes.get(selectedId);
                const parentId = sel?.parentId;
                if (parentId) {
                  const parent = nodes.get(parentId);
                  const pComputed = findNodeComputedStyles(parentId, vpId, ['flexWrap', 'flex-wrap']);
                  const pWrap = parent?.styles?.flexWrap || parent?.styles?.['flex-wrap']
                    || pComputed['flexWrap'] || pComputed['flex-wrap'] || '';
                  if (pWrap === 'wrap' || pWrap === 'wrap-reverse') return null;
                }
                return (
                  <GripHandle
                    corners={corners}
                    nodeId={selectedId}
                    vpId={vpId}
                    color={selectionColor}
                    onGripDragStart={onGripDragStart}
                  />
                );
              })()}
            </>
          )}
          </SelectionFade>
          {/* Gradient editing overlay — shows when gradient editor is active */}
          {activeGradient && (
            <GradientOverlay
              corners={corners}
              gradientType={activeGradient.type}
              direction={activeGradient.direction}
              centerX={activeGradient.centerX}
              centerY={activeGradient.centerY}
              radiusX={activeGradient.radiusX}
              radiusY={activeGradient.radiusY}
              radialShape={activeGradient.radialShape}
              radialSize={activeGradient.radialSize}
              angle={activeGradient.angle}
              stops={activeGradient.stops}
              selectedStopId={selectedGradientStop}
              onDirectionChange={gradientCallback ? (deg) => gradientCallback({ direction: deg }) : undefined}
              onCenterChange={gradientCallback ? (x, y) => gradientCallback({ centerX: x, centerY: y }) : undefined}
              onRadiusChange={gradientCallback ? (rx, ry) => gradientCallback({ radiusX: rx, radiusY: ry }) : undefined}
              onAngleChange={gradientCallback ? (deg) => gradientCallback({ angle: deg }) : undefined}
              onStopPositionChange={stopUpdateCallback || undefined}
              onSelectStop={stopSelectCallback || undefined}
              onCommit={gradientCommit || undefined}
              isMask={isMask}
            />
          )}
          {/* Clip-path editing overlay — shows when clip-path editor is active */}
          {activeClipPath && (
            <ClipPathOverlay
              corners={corners}
              data={activeClipPath}
              onChange={clipPathCallback || (() => {})}
              onCommit={clipPathCommit || undefined}
            />
          )}
          {/* Fancy border-radius overlay — shows when radius editor is active */}
          {activeFancyRadius && (
            <FancyRadiusOverlay
              corners={corners}
              data={activeFancyRadius}
              onChange={fancyRadiusCallback || (() => {})}
              onCommit={fancyRadiusCommit || undefined}
            />
          )}
          {/* Shape edit overlay is hoisted out — see ShapeEditOverlayHost in
              Canvas.tsx. Mounting it here meant the JSX position changed
              between SelectionOverlay's many return paths, which made React
              unmount+remount on isInteracting flips and dropped editor state
              mid-edit. */}
        </>
      )}

      {/* ── MULTI-SELECT: group bounding box + individual thin borders ──
          Filter to TOP-LEVEL selected nodes only. A descendant whose
          ancestor is also selected doesn't get its own border — it
          rides along visually with the ancestor's frame. Mirrors the
          drag filter (DragCoordinator) and the hover suppression
          above: the user picks the group as a whole, descendants are
          implicit. Without this, selecting a parent + many children
          paints overlapping borders on every child and the canvas
          looks like a wireframe diagram. */}
      {multiSelectPairs.length > 0 && (
        <>
          {multiSelectPairs.map(p => (
            <SecondarySelectionBorder key={`${p.vpId}:${p.id}`} nodeId={p.id} vpId={p.vpId} color={selectionColor} />
          ))}
          {!isViewer && (
            <GroupBoundingBox pairs={multiSelectPairs} color={selectionColor} />
          )}
        </>
      )}

      {/* Collection ghost outlines + arrow connectors — shows when the
          selected node is inside ANY `.map()` (inline array OR CMS slug).
          Color tracks the selection: orange for inline maps (matches the
          map template selection treatment), blue for CMS (matches the
          CMS pill / accent). */}
      {selectedId && (isMapTemplate || isCmsCollectionTemplate) && (
        <MapGhostOverlay
          nodeId={selectedId}
          vpId={vpId}
          color={isMapTemplate ? MAP_TEMPLATE_COLOR : SELECTION_COLOR}
        />
      )}

      {/* Style helper tooltip — always mounted so setter is registered */}
      <StyleUpdateHelper />
    </>
  );
}

/**
 * MapGhostOverlay — orange outlines on ghost copies + curved arrow connectors to template.
 * Reuses shared arrow-path geometry (same as component variant connectors).
 * Scoped to the active viewport only — ghosts in other viewports are ignored.
 */
function MapGhostOverlay({ nodeId, vpId, color }: { nodeId: string; vpId: string; color: string }) {
  const vpConfigs = useAtomValue(viewportsConfigAtom);
  const [ghostCorners, setGhostCorners] = useState<ScreenCorners[]>([]);
  const [arrowPaths, setArrowPaths] = useState<string[]>([]);

  // Find the template root: walk up to find the node whose parent has
  // ANY collectionList. The same overlay serves both inline `.map()`
  // arrays and CMS-backed collections — the only difference is the
  // colour passed in by the caller, which is also why we don't filter
  // by `source.startsWith('__inline:')` here anymore.
  // Per-computation subscription — the walk re-runs per commit but this
  // small overlay only re-renders when the template-root RESULT changes.
  const templateRootId = useNodesComputed((nodes) => {
    let current = nodes.get(nodeId);
    while (current) {
      const parent = current.parentId ? nodes.get(current.parentId) : null;
      if (parent?.collectionList) return current.id;
      current = parent ?? undefined;
    }
    return null;
  }, [nodeId]);

  useEffect(() => {
    if (!templateRootId) return;
    let rafId: number;
    const poll = () => {
      // Bridge-cache lookup. ghosts are stored in rectCache + cornersCache
      // under composite keys ${vpPrefix}:${templateId}__N — see
      // findGhostsForTemplate in node-ops.ts. Works in both DirectBridge
      // (in-process DOM) and PostMessageBridge (iframe) modes.
      const ghosts = findGhostsForTemplate(templateRootId, vpId);
      const templateRect = ghosts.length > 0 ? findNodeRect(templateRootId, vpId) : null;
      const corners: ScreenCorners[] = [];
      const paths: string[] = [];

      for (const g of ghosts) {
        const gCorners = g.corners ?? cornersFromRect(g.rect);
        corners.push(gCorners);
        if (templateRect) {
          // Prefer corners-based path when both sides have proper corners
          // (handles rotation correctly); fall back to rects otherwise.
          const d = g.corners
            ? computeArrowPathFromCorners(cornersFromRect(templateRect), gCorners)
            : computeArrowPathFromRects(templateRect, g.rect);
          if (d) paths.push(d);
        }
      }

      setGhostCorners(corners);
      setArrowPaths(paths);
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [templateRootId, vpId, vpConfigs]);

  if (ghostCorners.length === 0) return null;

  return (
    <svg
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none', overflow: 'visible', zIndex: 1,
      }}
    >
      {/* Ghost outlines (dashed orange) */}
      {ghostCorners.map((c, i) => (
        <path
          key={`ghost-${i}`}
          d={`M ${c.TL.x} ${c.TL.y} L ${c.TR.x} ${c.TR.y} L ${c.BR.x} ${c.BR.y} L ${c.BL.x} ${c.BL.y} Z`}
          fill="none" stroke={color} strokeWidth={1.5}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Arrow connectors (curved, same style as component variants) */}
      {arrowPaths.map((d, i) => (
        <path
          key={`arrow-${i}`}
          d={d}
          fill="none" stroke={color} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}


/** Group bounding box around all selected (node × viewport) PAIRS — border
 *  with resize handles for proportional resize. A marquee spanning several
 *  artboards passes one pair per swept viewport, so the box + handles
 *  enclose the replicas too (design-tool parity); resize/rotate then live-patch
 *  and COMMIT each pair against its own viewport (primary write vs
 *  @container override — `viewportPrefix` on updateNodeStyles). */
function GroupBoundingBox({ pairs, color }: { pairs: Array<{ id: string; vpId: string }>; color: string }) {
  const [groupCorners, setGroupCorners] = useState<ScreenCorners | null>(null);
  const setInteracting = useSetAtom(canvasInteractingAtom);
  const setRotating = useSetAtom(isRotatingAtom);

  // Group resize: proportional scaling per node, ported from old builder
  // `create-resize-handler.tsx`. Each node gets a delta scaled by its size
  // ratio to the LARGEST initial node — so small selected items move less
  // than big ones, keeping their relative shapes during the resize. Smooth
  // zero-crossing (width/height going negative → handle flips, no jump).
  //
  // Per-element transform compensation: when a selected element has a
  // rotation or skew, its CSS transform rotates around the element center.
  // Changing width/height moves the center, so the rotated element drifts
  // visually unless we shift left/top to keep one corner pinned. We pin the
  // handle-opposite corner: at start, capture its on-screen position after
  // running it through the matrix; each frame, recompute the same corner
  // through the matrix with the new rect and offset newLeft/newTop by the
  // delta. Same trick the single-element ResizeManager uses.
  //
  // All DOM access goes through the bridge (`findNodeComputedStyles`,
  // `findNodeRect`, `patchNodeStyles`) so this works in iframe mode.
  const handleGroupResizeStart = useCallback((direction: Direction, e: React.PointerEvent) => {
    interface NodeState {
      id: string;
      vpId: string;
      vpPrefix: string;
      width: number;
      height: number;
      left: number;
      top: number;
      xHandle: 'left' | 'right' | null;
      yHandle: 'top' | 'bottom' | null;
      direction: Direction;
      matrixStr: string;
      hasTransform: boolean;
      // Screen-space pin: the handle-opposite corner of the initial rect,
      // run through the element's own matrix. Each frame after computing
      // the new rect, we shift left/top so this point stays fixed.
      fixedPoint: { x: number; y: number } | null;
    }
    const states: NodeState[] = [];
    const { xHandle: initXH, yHandle: initYH } = getHandlesFromDirection(direction);

    for (const { id, vpId } of pairs) {
      const computed = findNodeComputedStyles(id, vpId, ['width', 'height', 'left', 'top', 'transform']);
      const w = parseFloat(computed.width);
      const h = parseFloat(computed.height);
      // `left`/`top` from getComputedStyle resolve percent / inset values to
      // px. Skip if missing — node isn't ready in the rect cache yet.
      const l = parseFloat(computed.left);
      const t = parseFloat(computed.top);
      if (![w, h, l, t].every((n) => Number.isFinite(n))) continue;

      // Per-element transform: matrix(...) form from getComputedStyle.
      // `none` and empty string both mean "no transform" — skip pinning.
      const matrixStr = computed.transform || '';
      const hasTransform = !!matrixStr && matrixStr !== 'none';
      let fixedPoint: { x: number; y: number } | null = null;
      if (hasTransform) {
        const oppCorner = getOppositeCorner(direction, { left: l, top: t, width: w, height: h });
        fixedPoint = getTransformedPoint(
          oppCorner.x, oppCorner.y,
          { x: l, y: t, width: w, height: h },
          matrixStr,
        );
      }

      states.push({
        id,
        vpId,
        vpPrefix: getViewportPrefix(vpId),
        width: w,
        height: h,
        left: l,
        top: t,
        xHandle: initXH,
        yHandle: initYH,
        direction,
        matrixStr,
        hasTransform,
        fixedPoint,
      });
    }
    if (states.length === 0) return;

    // Stable scale factors per node — computed once at lift, never updated.
    // The largest node moves at the full mouse delta; smaller ones get a
    // fraction so the GROUP scales proportionally instead of every node
    // changing by the same px amount.
    const origMaxW = Math.max(...states.map((n) => n.width));
    const origMaxH = Math.max(...states.map((n) => n.height));
    // Keyed per PAIR — the same node can appear once per swept viewport.
    const origSizes = new Map(states.map((n) => [`${n.vpPrefix}:${n.id}`, { w: n.width, h: n.height }]));

    let prevMouseX = e.clientX;
    let prevMouseY = e.clientY;
    const scale = transformManager.getTransform().scale || 1;
    const contentEl = getContentRoot();

    setInteracting(true);
    trace.action('group-resize:start', {
      count: states.length,
      direction,
      origMaxW,
      origMaxH,
      transformedCount: states.filter((n) => n.hasTransform).length,
    });

    const onMove = (me: PointerEvent) => {
      // Incremental delta from the LAST frame, not from start — prevents
      // jumps after a zero-crossing handle flip.
      const frameDx = (me.clientX - prevMouseX) / scale;
      const frameDy = (me.clientY - prevMouseY) / scale;
      prevMouseX = me.clientX;
      prevMouseY = me.clientY;

      for (const n of states) {
        const orig = origSizes.get(`${n.vpPrefix}:${n.id}`)!;
        const wFactor = origMaxW > 0 ? orig.w / origMaxW : 1;
        const hFactor = origMaxH > 0 ? orig.h / origMaxH : 1;
        const dx = frameDx * wFactor;
        const dy = frameDy * hFactor;

        let newW = n.width + (n.xHandle === 'left' ? -dx : n.xHandle === 'right' ? dx : 0);
        let newH = n.height + (n.yHandle === 'top' ? -dy : n.yHandle === 'bottom' ? dy : 0);
        let newL = n.xHandle === 'left' ? n.left + dx : n.left;
        let newT = n.yHandle === 'top' ? n.top + dy : n.top;

        // Shift on a corner — per-element aspect lock, same rule (and same
        // helper) as the single-element ResizeManager: EACH node keeps ITS
        // OWN start ratio, so a group of circles stays circular while a
        // wide card in the same selection stays wide. Ratio comes from the
        // lift-time sizes (origSizes), not the mutating frame state, so
        // the lock can't drift across frames. Runs before zero-crossing,
        // matching the single-element order.
        if (me.shiftKey && n.xHandle && n.yHandle && orig.h > 0) {
          const locked = applyAspectRatioLock(
            newW, newH, n.height, n.top, orig.w / orig.h, n.yHandle, false,
          );
          newH = locked.height;
          newT = locked.top;
        }

        // Zero-crossing — width/height went negative → flip handle,
        // adjust position, update the per-node Direction so the next
        // compensation step pins the correct corner.
        let crossed = false;
        if (n.xHandle || n.yHandle) {
          const hadX = n.xHandle !== null;
          const hadY = n.yHandle !== null;
          const zc = processZeroCrossing(
            newW, newH, newL, newT,
            n.xHandle ?? 'right', n.yHandle ?? 'bottom',
          );
          newW = zc.width;
          newH = zc.height;
          newL = zc.left;
          newT = zc.top;
          if (zc.crossed) {
            crossed = true;
            if (hadX) n.xHandle = zc.xHandle;
            if (hadY) n.yHandle = zc.yHandle;
            n.direction = updateDirectionAfterCrossing(
              n.xHandle ?? zc.xHandle,
              n.yHandle ?? zc.yHandle,
              n.direction,
            );
          }
        }

        newW = Math.max(1, newW);
        newH = Math.max(1, newH);

        // Transform compensation — pin the handle-opposite corner through
        // the element's matrix. Without this, rotating an element and
        // resizing the group would slide it diagonally because the matrix
        // pivots around the new (shifted) center.
        if (n.hasTransform && n.fixedPoint) {
          const newRect = { x: newL, y: newT, width: newW, height: newH };
          const newOpp = getOppositeCorner(n.direction, {
            left: newL, top: newT, width: newW, height: newH,
          });
          const newFP = getTransformedPoint(newOpp.x, newOpp.y, newRect, n.matrixStr);
          newL += n.fixedPoint.x - newFP.x;
          newT += n.fixedPoint.y - newFP.y;
        }

        n.width = newW;
        n.height = newH;
        n.left = newL;
        n.top = newT;

        // After a crossing, rebase fixedPoint to the new direction's
        // opposite corner so the next frame pins the side we're now
        // dragging away from. Matches single-element ResizeManager.
        if (crossed && n.hasTransform) {
          const oppCorner = getOppositeCorner(n.direction, {
            left: newL, top: newT, width: newW, height: newH,
          });
          n.fixedPoint = getTransformedPoint(
            oppCorner.x, oppCorner.y,
            { x: newL, y: newT, width: newW, height: newH },
            n.matrixStr,
          );
        }

        if (contentEl) {
          patchNodeStyles(contentEl, n.id, n.vpPrefix, {
            width: `${Math.round(newW)}px`,
            height: `${Math.round(newH)}px`,
            left: `${Math.round(newL)}px`,
            top: `${Math.round(newT)}px`,
          });
        }
      }

      // Tooltip on the first selected node (matches single-resize UX).
      const primary = states[0];
      if (primary) {
        styleHelperOps.show({
          type: 'dimensions',
          position: { x: me.clientX + 16, y: me.clientY + 16 },
          dimensions: {
            width: Math.round(primary.width),
            height: Math.round(primary.height),
            unit: 'px',
          },
        });
      }
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      styleHelperOps.hide();
      setInteracting(false);

      // Commit each node's final geometry through the standard mutation
      // path so the JSX file picks up the change. updateNodeStyles auto-
      // routes to @container overrides on non-primary viewports.
      const finalContentEl = getContentRoot();
      if (finalContentEl) {
        for (const n of states) {
          updateNodeStyles({
            id: n.id,
            styles: {
              width: `${Math.round(n.width)}px`,
              height: `${Math.round(n.height)}px`,
              left: `${Math.round(n.left)}px`,
              top: `${Math.round(n.top)}px`,
            },
            contentEl: finalContentEl,
            // Commit against the PAIR's viewport: primary write for '' —
            // replica pairs route to their @container override instead.
            viewportPrefix: n.vpPrefix,
          });
        }
      }
      trace.action('group-resize:end', { count: states.length });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pairs, setInteracting]);

  useEffect(() => {
    let rafId: number;
    const poll = () => {
      // Compute the union (axis-aligned) bounding box of all selected
      // elements. Read each element's SCREEN CORNERS, not `findNodeRect`:
      // for a rotated SVG shape (rotation on the inner shape's `transform`
      // attribute) `rectCache` deliberately holds the un-rotated wrapper
      // CSS box — see `cornersForElement` in bridge-sandbox.ts — so unioning
      // those rects gave a box that missed the actual painted geometry.
      // `getScreenCornersById` returns the rotated painted quad; unioning
      // its 4 corners encloses the real shape. For non-rotated elements the
      // corners ARE the rect corners, so this is an exact equivalent.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let found = false;

      for (const { id, vpId } of pairs) {
        const corners = getScreenCornersById(id, vpId);
        if (!corners) continue;
        for (const pt of [corners.TL, corners.TR, corners.BR, corners.BL]) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
        }
        found = true;
      }

      if (found) {
        const newCorners: ScreenCorners = {
          TL: { x: minX, y: minY },
          TR: { x: maxX, y: minY },
          BR: { x: maxX, y: maxY },
          BL: { x: minX, y: maxY },
        };
        setGroupCorners(prev => cornersEqual(prev, newCorners) ? prev : newCorners);
      }

      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [pairs]);

  // Group rotate: apply same rotation to all selected elements
  // (must be before early return to maintain hook order)
  //
  // All DOM access goes through the bridge (`findNodeComputedStyles` for the
  // start angle, `patchNodeStyles` for the live frames) so this works in
  // iframe mode — the old parent-frame element read returned null there and
  // the whole gesture silently no-op'd. The base (non-rotate) transform parts
  // come from the node's authored inline styles in the NodeMap; the start
  // rotation from the computed matrix (same source single-element rotate uses).
  const handleGroupRotateStart = useCallback((e: React.PointerEvent) => {
    const storeNodes = getDefaultStore().get(nodesAtom);
    const elements: { id: string; vpPrefix: string; baseTransform: string; startRotation: number; liveTransform: string }[] = [];
    for (const { id, vpId } of pairs) {
      const startRotation = parseRotationFromMatrix(findNodeComputedStyles(id, vpId, ['transform']).transform);
      const baseTransform = storeNodes.get(id)?.styles?.transform || '';
      elements.push({ id, vpPrefix: getViewportPrefix(vpId), baseTransform, startRotation, liveTransform: baseTransform });
    }
    if (elements.length === 0 || !groupCorners) return;

    // Calculate group center in screen space
    const cx = (groupCorners.TL.x + groupCorners.BR.x) / 2;
    const cy = (groupCorners.TL.y + groupCorners.BR.y) / 2;
    const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);

    setInteracting(true);
    setRotating(true);
    const liveContentEl = getContentRoot();
    trace.action('group-rotate:start', { count: elements.length, vpPrefixes: elements.map((el) => el.vpPrefix) });

    const onMove = (me: PointerEvent) => {
      const currentAngle = Math.atan2(me.clientY - cy, me.clientX - cx);
      let deltaDeg = (currentAngle - startAngle) * (180 / Math.PI);

      // Shift snap to 15°
      if (me.shiftKey) deltaDeg = Math.round(deltaDeg / 15) * 15;

      for (const item of elements) {
        const newRotation = item.startRotation + deltaDeg;
        // Replace only the rotate() part, preserving translate/scale etc.
        item.liveTransform = mergeRotation(item.baseTransform, newRotation);
        if (liveContentEl) {
          patchNodeStyles(liveContentEl, item.id, item.vpPrefix, { transform: item.liveTransform });
        }
      }

      styleHelperOps.show({
        type: 'rotate',
        position: { x: me.clientX + 16, y: me.clientY + 16 },
        value: Math.round(elements[0].startRotation + deltaDeg),
        unit: 'deg',
      });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      styleHelperOps.hide();
      setInteracting(false);
      setRotating(false);

      // Commit each node's final transform through the standard mutation
      // path so the JSX file picks up the change (empty string = remove the
      // transform property when the rotation returned to 0 with no base).
      const contentEl = getContentRoot();
      if (contentEl) {
        for (const item of elements) {
          updateNodeStyles({ id: item.id, styles: { transform: item.liveTransform }, contentEl, viewportPrefix: item.vpPrefix });
        }
      }
      trace.action('group-rotate:end', { count: elements.length });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pairs, groupCorners, setInteracting, setRotating]);

  // Early return AFTER all hooks
  if (!groupCorners) return null;

  return (
    <>
      <SelectionBorder corners={groupCorners} rotation={0} color={color} />
      <ResizeHandles corners={groupCorners} rotation={0} onResizeStart={handleGroupResizeStart} color={color} />
      <RotateHandle corners={groupCorners} rotation={0} onRotateStart={(e) => handleGroupRotateStart(e)} />
    </>
  );
}

/** Simple selection border for secondary selected nodes (no handles, no polling — just border). */
function SecondarySelectionBorder({ nodeId, vpId, color }: { nodeId: string; vpId: string; color: string }) {
  const [corners, setCorners] = useState<ScreenCorners | null>(null);

  useEffect(() => {
    trace.action('secondary-selection:mount', { nodeId, vpId });
    let rafId: number;
    const poll = () => {
      // Bridge-based corners — `findParentFrameElement` does a parent-frame
      // `document.querySelector`, which returns null / a stale hidden
      // anchor div for iframe canvas content. `getScreenCorners` on that
      // drew a phantom selection box near the canvas origin during
      // multi-select. `getScreenCornersById` reads the bridge
      // `cornersCache` (rotation-aware — the same source the group box and
      // single-select border use). Keep the previous corners on a cache
      // miss so the border doesn't flicker mid-render.
      const c = getScreenCornersById(nodeId, vpId);
      if (c) setCorners(prev => cornersEqual(prev, c) ? prev : c);
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(rafId);
      trace.action('secondary-selection:unmount', { nodeId });
    };
  }, [nodeId, vpId]);

  if (!corners) return null;
  return <SelectionBorder corners={corners} rotation={0} color={color} />;
}
