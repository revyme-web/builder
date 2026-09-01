// Canvas.tsx — Thin shell wiring together: TransformManager, DragCoordinator, text editing.
// All complex logic lives in dedicated systems. Canvas just routes events.

import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { nextFrames } from '@/shared/dom-utils';
import { getCanvasRenderer } from './CanvasRenderer';
import { finishPendingRestore } from '@/code/mutation/history';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { codeAtom, nodesAtom, selectedNodeAtom, selectedIdsAtom, hoveredIdAtom, hoveredNodeIdAtom, hoveredViewportIdAtom, canvasInteractingAtom, mapItemIndexAtom, mapContextAtom, updatingFromCanvasAtom, marqueeViewportSpreadAtom, getNodesSnapshot, getCachedNodesMap } from '../code/stores/store';
import type { CanvasNode } from '../code/parsing/parser';
import { activeFilePathAtom, componentBreadcrumbAtom, isComponentFilePath, isIconSetFilePath } from '../code/project/active-file-store';
// updateVariantPosition, updateIconPosition/Size, parseIconSetConfig
import { projectFS } from '../code/project/project-fs';
import { parseCmsPageMeta } from '../code/project/cms-page-ops';
import { slugPageReferrerByFileAtom } from '../code/stores/cms-page-store';
import { viewportsConfigAtom, interactingViewportIdAtom, viewportPositionsAtom, viewportWidthsAtom, syncViewportWidths } from '../code/stores/viewport-store';
import { selectionStylesAtom, isTextEditingAtom, textEditSnapshotAtom } from '../code/stores/editor-store';
import { shapeEditingIdAtom, selectedPointAtom, selectedAnchorInfoAtom, groupEditingIdAtom, shapeEditCommitPendingAtom } from '@/code/stores/shape-edit-store';
import { repositionSignalOps } from './drag/reposition-signal';
import { dragStateOps } from './drag/drag-state-store';
import { shouldSkipLaggingForcedRender } from './render-integrity';
import { autoFocusLayersAtom } from '@/code/stores/user-preferences-store';
import { snappedRulerGuideIdsAtom } from '@/code/stores/ruler-guides-store';
import { overlayEditingIdAtom, overlayCallsAtom } from '@/code/stores/overlay-store';
import { setViewportHeaderOverlayEditMode } from './ViewportHeaderManager';
import { activeLocaleAtom, isDefaultLocaleAtom, i18nConfigAtom, localeOverridesAtom } from '@/code/stores/locale-store';
import {
  isSpaceBarDown,
} from './transform';
import { queueMutation, setActiveFilePath as setQueueActiveFile, hasPendingDeferredFanOut, getCurrentCode } from '../code/mutation/mutation-queue';
import type { MutationErrorDetail } from '../code/mutation/mutation-queue';
import { DragCoordinator } from './drag/DragCoordinator';
import { setToolbarDragCoordinator } from './drag/toolbar-drag-bridge';
import ToolbarGhost from './ui/ToolbarGhost';
import CanvasRulers from './ui/CanvasRulers';
import RulerGuides from './ui/RulerGuides';
import Comments from './ui/Comments';
import { getViewportPrefix, setStyleContext, setUpdatingFromCanvasFlagger, setForceCanvasRender, setReplicaOverridesGetter, getNodeHitsAtPoint, injectCanvasCSS, removeCanvasCSS, forceCanvasRender } from './node-ops';
import { registerTextEditCommitter } from './text-edit-committer';
// redirectToComponentInstance, redirectToCollectionTemplate, redirectToFitTextWrapper,
// redirectLayoutNodeToViewport, getIsolatedChildOfGroup, vpIdFromPrefix,
import { isGhostNodeId } from '@/shared/ghost-id';
import { containerOverridesAtom, getOverridesAtWidth } from '@/code/stores/container-query-store';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import { cmsPageMetaAtom, activePreviewItemAtom } from '@/code/stores/cms-page-store';
import { applyDetailPageBindings } from '@/code/features/cms-page-bindings';
import { openCmsEditorAtom } from '@/code/stores/cms-editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { SANDBOX_ORIGIN } from '@/canvas-sandbox/protocol';
import type { SnapGuide, SpacingGuide } from '@/shared/types';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { preloadProjectFonts } from '@/code/project/font-preload';
import { backfillCmsTimestamps } from '@/code/project/cms-ops';
import { toolModeAtom, panHighlightAtom } from '@/code/stores/tool-store';
import { commentModeActiveAtom } from '@/code/stores/comment-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { isShapeMode, isLayoutMode } from '@/code/stores/tool-store';
import CanvasOverlay from './selection/CanvasOverlay';
import CanvasFileDrop from './CanvasFileDrop';
import SelectionOverlay from './selection/SelectionOverlay';
import LayerDropHighlight from './selection/LayerDropHighlight';
import ShapeEditOverlayHost from './selection/ShapeEditOverlayHost';
import SketchEditOverlay from './selection/SketchEditOverlay';
import CanvasNodeNameDisplay from './selection/CanvasNodeNameDisplay';
import DistanceIndicators from './selection/DistanceIndicators';
import DimensionsIndicators from './selection/DimensionsIndicators';
import PinConstraintLines from './selection/PinConstraintLines';
import PanelErrorBoundary from '@/editor/ui/PanelErrorBoundary';
import SelectionBox, { marqueeSelectionSig } from './selection/SelectionBox';
import CodeComponentHost from './CodeComponentHost';
import ContextMenu from './ui/ContextMenu';
import ComponentBreadcrumb from './ui/ComponentBreadcrumb';
import SlugPageBreadcrumb from './ui/SlugPageBreadcrumb';
import AddVariantUI from './ui/AddVariantUI';
import AddVectorUI from './ui/AddVectorUI';
import ArrowConnectors from './ui/ArrowConnectors';
import ConnectionHandle from './ui/ConnectionHandle';
import SlotConnectionHandle from './ui/SlotConnectionHandle';
import SlotConnectors from './ui/SlotConnectors';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import ConnectionTypeModal from '@/editor/ui/ConnectionTypeModal';
import AddViewportMenu, { type AddViewportMenuState } from './ui/AddViewportMenu';
import PixelGrid from './ui/PixelGrid';
import MutationErrorBanner from './ui/MutationErrorBanner';
import SnapGuidesOverlay from './ui/SnapGuidesOverlay';
import { snapGuidesOps } from './ui/snap-guides-store';
import { contextMenuAtom } from '@/code/stores/context-menu-store';
import { StableAtomSyncHost } from './hooks/useStableAtomSync';
import { useMutationQueueLifecycle } from './hooks/useMutationQueueLifecycle';
import { useActiveViewports } from './hooks/useActiveViewports';
import { useLocaleOverrides } from './hooks/useLocaleOverrides';
import { RendererSyncHost } from './hooks/useRendererSync';
import { useCanvasTransform } from './hooks/useCanvasTransform';
import { useSandboxBridge } from './hooks/useSandboxBridge';
import { CanvasMouseController } from './mouse/CanvasMouseController';
import { CanvasTextEditController } from './text-edit/CanvasTextEditController';
import { CanvasDragOrchestrator } from './drag/CanvasDragOrchestrator';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useCanvasCommandsBridge } from './hooks/useCanvasCommandsBridge';
import { useInsertionBridge } from './hooks/useInsertionBridge';
import { addViewport } from './helpers/addViewport';

// TipTap was here. Editor now lives inside the sandbox iframe (see
// canvas-sandbox/text-edit-host.ts). Parent only ferries commands and reads
// the per-transaction selection snapshot.


export default function Canvas() {
  // Read the store this component subscribes to. main.tsx wraps the app in
  // <Provider> with no store prop, which creates an isolated store — distinct
  // from getDefaultStore(). Reading via getDefaultStore() inside imperative
  // callbacks (forceCanvasRender) hits the wrong store, sees the original
  // initial codeAtom, re-derives nodesAtom from it, and ships pre-edit
  // nodes to the iframe — making mid-drag re-parents look stale.
  const jotaiStore = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const vpOverlayRef = useRef<HTMLDivElement>(null);
  // NO whole-map nodesAtom subscription here. Canvas is the ROOT canvas
  // component — subscribing re-rendered its entire subtree on EVERY commit
  // (the dominant slice of the big-page post-drag cascade), yet the map was
  // only ever consumed inside callbacks via `nodesRef.current`. That ref is
  // now getter-backed (see below) and reads the CURRENT map imperatively at
  // call time — fresher than the old React-commit-lagged mirror, zero
  // subscription cost.
  // Viewers inside a component master see the variant arrows for context
  // but every variant-authoring affordance — Add Variant, Add Vector,
  // the connection-drag handle — stays hidden.
  const isViewer = useIsViewer();
  const selectedId = useAtomValue(selectedNodeAtom);
  const [selectedIds, setSelectedIds] = useAtom(selectedIdsAtom);
  const setMarqueeSpread = useSetAtom(marqueeViewportSpreadAtom);
  // Write-only codeAtom handle — NO subscription. The atom `code` value had
  // zero render uses (only the codeRef mirror + this setter), so subscribing
  // re-rendered the whole Canvas subtree on every commit for nothing. codeRef
  // below is getter-backed and reads the store imperatively at call time.
  const setCode = useSetAtom(codeAtom);
  const setHoveredId = useSetAtom(hoveredIdAtom);
  const setHoveredNodeId = useSetAtom(hoveredNodeIdAtom);
  const setHoveredViewport = useSetAtom(hoveredViewportIdAtom);
  const setSelectionStyles = useSetAtom(selectionStylesAtom);
  const [interactingVpIdVal, setInteractingViewport] = useAtom(interactingViewportIdAtom);
  const [canvasInteractingVal, setCanvasInteracting] = useAtom(canvasInteractingAtom);
  // Mirror of `canvasInteractingVal` readable from event-handler
  // closures without re-creating them every render. The hover tracker
  // (`handleMouseMove`) reads this to suppress hover updates while a
  // gap / padding / resize / drag is in progress — see comment in
  // `handleMouseMove` for the bug it fixes.
  const canvasInteractingValRef = useRef(false);
  const [activeFilePath, setActiveFilePath] = useAtom(activeFilePathAtom);
  const setBreadcrumb = useSetAtom(componentBreadcrumbAtom);
  const setUpdatingFromCanvas = useSetAtom(updatingFromCanvasAtom);
  const setComponentEditorFile = useSetAtom(componentEditorFileAtom);
  const [vpPositions, setVpPositions] = useAtom(viewportPositionsAtom);
  const [vpWidths, setViewportWidths] = useAtom(viewportWidthsAtom);
  const [vpConfigs, setVpConfigs] = useAtom(viewportsConfigAtom);
  // Mirror the (file-scoped, config-derived) widths atom into the imperative
  // `_viewportWidths` store that getActiveAnimationScope /
  // getSortedBreakpointWidths read. The atom itself now derives from the
  // active file's @canvas config with a same-file override
  // (viewport-store.ts), so the old two-way reconcile-configs-into-widths
  // set is gone — it was the racing half of the "resize reverts after
  // visiting the template" bug.
  useEffect(() => {
    syncViewportWidths(vpWidths);
  }, [vpWidths]);
  // PERF — neutralise `backdrop-filter: blur()` on the canvas DURING any drag/resize/interaction.
  // backdrop-filter is THE dominant cause of canvas drag-jank: the compositor re-blurs everything behind
  // each such element on EVERY repaint, and a real page has many (e.g. a glass Header rendered once per
  // viewport + page glass cards × 3 viewports) → single-digit FPS even though the JS per-frame work is tiny
  // (the cost is pure GPU/compositor, invisible to the JS trace — it shows only as the untraced ~44ms/frame
  // gap). An EMPTY template (no blur) drags perfectly smooth — that's the tell. This is CANVAS-ONLY editor
  // CSS (injectCanvasCSS), removed the instant interaction ends, so the live preview + deployed site keep
  // the blur exactly as authored. `!important` beats the inline `backdropFilter` on the nodes.
  useEffect(() => {
    const SEL = '[data-node-id], [data-node-id] *';
    if (canvasInteractingVal) {
      injectCanvasCSS(SEL, 'backdrop-filter: none !important; -webkit-backdrop-filter: none !important;');
    } else {
      removeCanvasCSS(SEL);
    }
    return () => removeCanvasCSS(SEL);
  }, [canvasInteractingVal]);
  const setContextMenu = useSetAtom(contextMenuAtom);
  const [toolMode, setToolMode] = useAtom(toolModeAtom);
  const setCommentModeActive = useSetAtom(commentModeActiveAtom);
  const setShapeEditingId = useSetAtom(shapeEditingIdAtom);
  const setSelectedPoint = useSetAtom(selectedPointAtom);
  const setGroupEditingId = useSetAtom(groupEditingIdAtom);
  const [overlayEditingId, setOverlayEditingId] = useAtom(overlayEditingIdAtom);
  const overlayCallsForHeader = useAtomValue(overlayCallsAtom);
  // Overlay edit mode → the viewport header becomes the exit affordance
  // (accent "Editing Overlay · <vp>" bar with a Done button, standard).
  // Lives here (not in OverlayTool) so it survives selection changes that
  // unmount the tool while the mode is still active.
  // Exit overlay-edit mode (shared by the per-viewport header's Done button AND the
  // component-master "Editing Overlay" banner below — component masters render NO
  // viewport headers, so the header affordance never appears there).
  const exitOverlayEdit = useCallback(() => {
    const oid = overlayEditingId;
    setOverlayEditingId(null);
    // Land back on the trigger so the panel keeps showing overlay controls.
    const call = overlayCallsForHeader.find((c) => c.overlayId === oid);
    if (call?.config.triggerId) setSelectedIds([call.config.triggerId]);
    trace.action('canvas:overlay-edit-done', { overlayId: oid });
  }, [overlayEditingId, overlayCallsForHeader, setOverlayEditingId, setSelectedIds]);
  useEffect(() => {
    if (!overlayEditingId) {
      setViewportHeaderOverlayEditMode(false);
      return;
    }
    // NOTE: when the trigger is dragged out, the overlay becomes a canvas node
    // but overlay mode STAYS active — a canvas overlay still behaves as an
    // overlay (visible only while editing, hidden on exit, see the show/hide
    // CSS effect below). We intentionally do NOT auto-exit here.
    setViewportHeaderOverlayEditMode(true, exitOverlayEdit);
    return () => setViewportHeaderOverlayEditMode(false);
  }, [overlayEditingId, exitOverlayEdit]);
  // Overlay-mode canvas visuals — show ONLY the edited overlay, accent-tint
  // the viewports. Lives here (not in OverlayTool) so deselecting mid-edit
  // doesn't unmount the tool and kill the visuals while the mode is active.
  // MUST go through injectCanvasCSS — a parent-head <style> never reaches the
  // sandboxed canvas iframe, which left overlays permanently visible there.
  useEffect(() => {
    // `/*persist*/` in each body marks the rule for the Renderer's style
    // rebuild to preserve — without it the first re-render (e.g. an overlay
    // drag commit) wipes these and the mode visuals vanish mid-session.
    // (The BASE hide rule — `[data-overlay-node] { display: none }` — is baked
    // into the Renderer's canvasOverrides on every render, NOT injected here:
    // a mount-time injection can fire before the sandbox connects and never
    // land, leaving all overlays visible on a fresh page load.)
    if (!overlayEditingId) return;
    // `z-index: 50` lifts the shown overlay above the canvas tint (z-index 10)
    // so a canvas-node overlay pops over the dimmed canvas, not under it.
    const showSelector = `[data-id="${overlayEditingId}"][data-overlay-node]`;
    injectCanvasCSS(showSelector, '/*persist*/ display: block !important; z-index: 50 !important;');
    injectCanvasCSS('[data-viewport]', '/*persist*/ position: relative;');
    // Accent tint (standard, kept LIGHT) over viewports AND root-level
    // canvas nodes — every parentless thing on the canvas EXCEPT the edited
    // overlay, which is portaled above the tint and visually pops. `--accent`
    // is an EDITOR token that doesn't exist inside the canvas iframe, so
    // resolve it here and bake the literal color into the injected rules.
    // Canvas nodes = direct [data-node-id] children of the content root;
    // :not([data-viewport]) skips viewport roots and overlay portals (both
    // carry data-viewport).
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
    const tintBody = `/*persist*/ content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, ${accent} 18%, rgba(255, 255, 255, 0.12));
  border-radius: inherit;
  z-index: 10;
  pointer-events: none;`;
    // Exclude the edited overlay itself so it pops instead of being dimmed
    // (when its trigger was dragged out, the overlay is a direct canvas-node
    // child and would otherwise get the tint ::after like every other node).
    const canvasNodeTintSelector = `[data-content-root] > [data-node-id]:not([data-viewport]):not([data-id="${overlayEditingId}"])::after`;
    // SVG elements can't host ::after — fade svg canvas nodes (sketches,
    // paths, shapes) directly instead so they recede like everything else.
    const svgCanvasNodeSelector = '[data-content-root] > svg[data-node-id]:not([data-viewport])';
    injectCanvasCSS('[data-viewport]::after', tintBody);
    injectCanvasCSS(canvasNodeTintSelector, tintBody);
    injectCanvasCSS(svgCanvasNodeSelector, '/*persist*/ opacity: 0.4;');
    trace.action('canvas:overlay-mode-css', { overlayId: overlayEditingId });
    // The overlay was `display: none` (base hide rule) until the show rule
    // above flipped it to `display: block`. Its `rectCache`/`cornersCache`
    // entry is therefore a STALE zero rect — and CSS injection alone never
    // re-measures it. Without a render here the hit-test misses the visible
    // overlay (click → "empty canvas" → instantly EXITS overlay mode) and the
    // SelectionOverlay has no corners to draw the auto-selection box. Forcing
    // a render re-measures the now-shown overlay into both caches, so clicking
    // selects it and auto-select lands — for create AND reopen-after-reload.
    forceCanvasRender();
    return () => {
      removeCanvasCSS(showSelector);
      removeCanvasCSS('[data-viewport]');
      removeCanvasCSS('[data-viewport]::after');
      removeCanvasCSS(canvasNodeTintSelector);
      removeCanvasCSS(svgCanvasNodeSelector);
      // Re-render so the now-hidden overlay's still-visible cached rect is
      // cleared — otherwise a click on its former location keeps hitting it.
      forceCanvasRender();
    };
  }, [overlayEditingId]);
  // While editing a text node, hide the variant-connection handle — it overlaps the text caret/selection and
  // a drag-to-connect would fight the text selection. Mirrors SelectionOverlay, which also bails on text edit.
  const isTextEditing = useAtomValue(isTextEditingAtom);
  const setMapItemIndex = useSetAtom(mapItemIndexAtom);
  const mapItemIndexVal = useAtomValue(mapItemIndexAtom);
  const mapContextVal = useAtomValue(mapContextAtom);
  // mapItemIndexRef / mapContextRef removed — controllers read jotaiStore.get(atom) directly.
  // ghostClickHandledRef moved to CanvasMouseController (owns ghost detection state).
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const i18nConfig = useAtomValue(i18nConfigAtom);
  // localeOverrides / setLocaleOverrides — consumed by CanvasTextEditController via jotaiStore.
  // Canvas.tsx no longer reads localeOverrides directly; useRendererSync reads it from its own atom hook.
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const cmsSchemas = useAtomValue(collectionSchemasAtom);
  const cmsData = useAtomValue(collectionDataAtom);
  const cmsPageMeta = useAtomValue(cmsPageMetaAtom);
  const previewItem = useAtomValue(activePreviewItemAtom);
  // One opener for the CMS editor — it also selects the CMS left panel, which
  // App requires for the overlay to stay mounted. See openCmsEditorAtom.
  const openCmsEditor = useSetAtom(openCmsEditorAtom);
  const setLeftPanel = useSetAtom(leftPanelAtom);

  // ─── Auto-focus layers preference ──────────────────────────────────────
  // When the user toggles `autoFocusLayers` ON in File → Preferences,
  // every node selection (no matter which left panel was open) snaps the
  // panel back to "Pages & Layers" so the user can immediately see where
  // the selection lives in the tree. Tracked here at the Canvas level
  // because selection events are routed through `setSelectedIds`; the
  // atom subscription gives us a single fire-on-change point without
  // wiring a callback through every selection path.
  //
  // We re-read the pref + read selectedIds on every change so flipping
  // the pref while a selection is already active won't retroactively
  // open the panel — only NEW selections after toggling.
  // ─── Revyme MCP bridge (dev only) ───────────────────────────────────────
  // Connects this editor tab to the ai-generator's SSE bridge so MCP clients
  // (Claude Code etc.) can read project files and submit oracle-gated writes.
  // Lazy import keeps the bridge out of the main bundle. Dev always connects;
  // production CLOUD builds connect too (the bridge is now keyed per website
  // and, with REVYME_BRIDGE_AUTH=1 server-side, session-verified) — a plain
  // OSS production build stays off the bridge.
  useEffect(() => {
    if (!import.meta.env.DEV && !CLOUD_ENABLED) return;
    void import('@/ai/mcp/bridge-client').then((m) => m.startMcpBridge());
  }, []);

  const autoFocusLayers = useAtomValue(autoFocusLayersAtom);
  const selectedIdsForAutoFocus = useAtomValue(selectedIdsAtom);
  useEffect(() => {
    if (!autoFocusLayers) return;
    if (selectedIdsForAutoFocus.length === 0) return;
    // Snap to the dedicated `'layers'` panel — the Layers tree split out
    // of the combined `'pages-layers'` panel into its own tab. The old ID
    // would now open the Pages list instead of the layer tree, defeating
    // the whole point of the auto-focus preference.
    setLeftPanel('layers');
    trace.action('canvas:auto-focus-layers', { count: selectedIdsForAutoFocus.length });
  }, [autoFocusLayers, selectedIdsForAutoFocus, setLeftPanel]);

  // ─── Iframe sandbox ─────────────────────────────────────────────────────
  // Canvas content always renders inside the cross-origin sandbox iframe.
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Render coordination: a single object owns the bridge.render() call and
  // the should-skip-this-render predicate. Replaces the previous 4-ref
  // sync stack (updatingFromCanvas / canvasInteracting / textCommit /
  // structuralChange refs scattered through this file). See
  // src/canvas/CanvasRenderer.ts.
  const renderer = useMemo(() => getCanvasRenderer(), []);

  // SandboxBridgeManager + handshake wired via useSandboxBridge.
  // `bridgeRef` is stable for the iframe lifetime; pass it to hooks that need
  // a RefObject<PostMessageBridge | null> (useRendererSync, useCanvasTransform).
  const { bridgeRef: postMessageBridgeRef, sandboxReady, iframeRenderTick, handleIframeLoad } = useSandboxBridge(iframeRef, {
    onBridgeCreated: (bridge) => {
      renderer.setBridge(bridge);
      trace.action('canvas:bridge-created', {});
    },

    onRenderComplete: () => {
      trace.action('canvas:iframe-render-complete', {});
      // Shape-edit / drag-commit overlay reveal: SvgEditorOverlay's
      // unmount and the SVG-group drag commit both set
      // `shapeEditCommitPendingAtom` to suppress SelectionOverlay until
      // the renderer flushes the new geometry. Render-complete =
      // rectCache now reflects post-edit/post-refit bounds, so it's
      // safe to let the overlay paint again. Without clearing here the
      // selection box would stay hidden until some other render cycle
      // happens to fire.
      //
      // Double-RAF the clear: `renderComplete` fires the same task as the
      // iframe finishes its DOM mutations, but the cornersCache /
      // computedCache updates that follow (per-element emits) and the
      // browser's first post-render paint both need a frame to settle.
      // Clearing inline produced a visible one-frame flash where the
      // overlay re-appeared briefly at the old position. First RAF gives
      // the iframe time to paint the new geometry, second RAF runs after
      // the parent processes any trailing cache events.
      if (jotaiStore.get(shapeEditCommitPendingAtom)) {
        nextFrames(2, () => {
          if (jotaiStore.get(shapeEditCommitPendingAtom)) {
            jotaiStore.set(shapeEditCommitPendingAtom, false);
          }
        });
      }
      // Same gap-clear for the reposition pulse — keeps a re-parented node's name
      // label (CanvasNodeNameDisplay) hidden from drop until the cache reflects its
      // new parent, so it doesn't flash back on mouseup. Double-RAF for the same
      // paint-timing reason as the shape-edit clear above.
      if (repositionSignalOps.isCommitPending()) {
        nextFrames(2, () => repositionSignalOps.clearCommitPending());
      }
      // Bridge the iframe's renderComplete into the same window event the
      // parent Renderer dispatches. CodeComponentHost listens for this to
      // mount React roots on freshly-rendered code component containers —
      // without bridging, dropped code components stayed empty until the
      // user resized/moved them (which forces another render cycle).
      window.dispatchEvent(new Event('revyme:render-complete'));
      // Undo/redo restore-finish (version bump + reselect) is EVENT-DRIVEN
      // off this signal: renderComplete means the restore's visual is in the
      // iframe and the allRects measure landed (it precedes this emit), so
      // the selection overlay + properties panel can update NOW (~60-70ms
      // after the keypress) instead of waiting out the 300ms worst-case
      // timer (which stays as the fallback when a render never completes —
      // sandbox mid-rebuild). One rAF so trailing corners/computed cache
      // emits process first — same paint-timing reason as the clears above.
      // No-op when no restore is pending; a rapid next undo supersedes the
      // pending finish before this fires (cancelPendingRestore), making the
      // deferred call a harmless no-op too.
      nextFrames(1, () => finishPendingRestore());
    },

    onNodeMouseDown: (nodeId, _event) => {
      trace.action('canvas:iframe-node-mousedown', { nodeId });
    },

    // canvas-dnd events from inside the iframe
    onDndCommit: (updates) => {
      trace.action('canvas:dnd-commit', { count: updates.length, updates });
      // STUB — translates canvas-dnd PendingUpdates into existing mutation queue.
      // Full variant/replica routing not yet ported. For now, route style updates
      // through updateNodeStyles (which knows about variants) and structural
      // updates through queueMutation directly.
      for (const u of updates) {
        if (u.type === 'style' && u.styles) {
          // Defer to existing updateNodeStyles for variant-aware routing
          import('./node-ops').then(({ updateNodeStyles, getContentRoot }) => {
            const contentEl = getContentRoot();
            if (contentEl) updateNodeStyles({ id: u.nodeId, styles: u.styles!, contentEl });
          });
        } else if (u.type === 'reorder' && u.newParentId != null && u.newIndex != null) {
          queueMutation({ type: 'reorder', nodeId: u.nodeId, parentId: u.newParentId, index: u.newIndex });
        } else if (u.type === 'move') {
          queueMutation({ type: 'move', nodeId: u.nodeId, newParentId: u.newParentId ?? null, index: u.newIndex, styles: u.styles });
        }
      }
    },
    onDndSelect: (ids) => {
      trace.action('canvas:dnd-select', { count: ids.length });
      setSelectedIds(ids);
    },
    onDndHover: (id) => {
      // Suppress while the canvas is interacting (gap drag, padding
      // drag, resize, etc.) AND for a short cooldown after interaction
      // ends — the bridge's post-commit rect/corners messages arrive a
      // frame or two after `setInteracting(false)` flips the gate
      // open, so without the cooldown a pointermove in that window
      // hit-tests against stale rectCache and lands hover on the
      // wrong element.
      // NOTE: dndHover events haven't fired since canvas-dnd was
      // removed from the iframe (see sandbox-dnd-host.ts) — actual
      // hover writes happen in `handleMouseMove` via the parent-side
      // hit-test. Kept for forward-compat in case bridge dnd comes back.
      if (canvasInteractingValRef.current || performance.now() < hoverSuppressUntilRef.current) return;
      trace.action('canvas:dnd-hover', { id });
      setHoveredId(id);
    },
    // Ghost-aware hoveredNodeId: canvas-dnd's onDndHover only carries the
    // canonical data-id (no `__N` suffix). Use the iframe's RAF-throttled
    // mouse position to run our rectCache-based hit-test, which DOES return
    // ghost-suffixed IDs when the cursor is over a ghost copy. Without this,
    // HoverHighlight always draws the outline on the template's text/box
    // even when the user is hovering ghost #N.
    onSandboxMouseMove: (x, y) => {
      // Same suppression + cooldown as `onDndHover` above — this is
      // the second bridge-side path that can write hoveredNodeId.
      if (canvasInteractingValRef.current || performance.now() < hoverSuppressUntilRef.current) return;
      // Overlay edit mode gates hover entirely (handled in handleMouseMove); skip
      // the ghost-hover path so nothing in the dimmed viewport lights up.
      if (jotaiStore.get(overlayEditingIdAtom)) return;
      const hits = getNodeHitsAtPoint(x, y);
      if (hits.length === 0) return;
      const { id: hitId } = hits[0];
      // Only override hoveredNodeId for ghost-suffixed hits. For non-ghost
      // hover, leave hoveredNodeId alone — the existing onDndHover path
      // handles that case (it sets hoveredId; downstream consumers fall
      // back to canonical lookup when there's no ghost suffix).
      if (isGhostNodeId(hitId)) {
        setHoveredNodeId(hitId);
      }
    },
    onDndViewportHit: (vpId) => {
      trace.action('canvas:dnd-viewport-hit', { vpId });
      setInteractingViewport(vpId);
    },
    onDndDragState: (state) => {
      trace.action('canvas:dnd-drag-state', state);
      setCanvasInteracting(state.isDragging);
    },

    // ─── Text-edit events from sandbox-hosted TipTap ────────────────────
    // Selection state arrives as a precomputed snapshot (mixed-value detection
    // already done iframe-side, since the parent can't read editor state
    // across origins).
    onTextEditSelectionChanged: (snapshot) => {
      jotaiStore.set(textEditSnapshotAtom, snapshot);
    },
    // Live HTML stream as the user types. Currently unused by parent (the
    // canvas element shows the latest content because the editor mounts on
    // it directly); kept for future preview / dirty-state hooks.
    onTextEditContentChanged: () => { /* no-op for now */ },
    // User clicked outside the editor or pressed Escape → commit. The HTML
    // we get is the final value we persist through the existing mutation
    // pipeline.
    onTextEditCommitted: (html, fit) => {
      textEditControllerRef.current?.commitEditWithHtml(html, fit);
      editingNodeIdRef.current = textEditControllerRef.current?.getEditingNodeId() ?? null;
    },
    onTextEditCancelled: () => {
      textEditControllerRef.current?.cancelEdit();
      editingNodeIdRef.current = null;
    },

    // Shape-edit outside-click from sandbox. The sandbox-side
    // shape-edit-host attaches a capture-phase mousedown listener inside
    // the iframe. When the user clicks outside the active overlay/SVG,
    // it emits this event so the parent can clear the editing atom.
    // Clearing the atom unmounts SvgEditorOverlay, whose cleanup calls
    // `bridge.commitShapeEdit()` to pull the final wrapper bounds + inner
    // JSX and queue source mutations + flushNow — which produces the
    // re-render that updates rectCache so SelectionOverlay sees the new
    // bounds. On icon-set master files (where vectors cover the whole
    // canvas) this is the only exit path other than Escape.
    onShapeEditCancelled: () => {
      const editId = jotaiStore.get(shapeEditingIdAtom);
      trace.action('canvas:bridge-shape-edit-cancelled', { editId });
      if (!editId) return;
      setShapeEditingId(null);
      setSelectedPoint(null);
      jotaiStore.set(selectedAnchorInfoAtom, null);
    },
    // Pen-creation "click away to finish": exit shape-edit. Unlike cancel, the
    // iframe editor is STILL active, so the overlay's unmount commitShapeEdit()
    // runs and COMMITS the drawn path (rather than discarding).
    onShapeEditDone: () => {
      const editId = jotaiStore.get(shapeEditingIdAtom);
      trace.action('canvas:bridge-shape-edit-done', { editId });
      if (!editId) return;
      setShapeEditingId(null);
      setSelectedPoint(null);
      jotaiStore.set(selectedAnchorInfoAtom, null);
    },
    // Ferry SvgPathEditor's onAnchorInfo into a parent atom so the
    // shape-edit Path tool can render Position (x, y) and the Curve
    // segmented control off it. Library fires `null` when nothing is
    // selected — clears the atom so the Path tool hides itself.
    onAnchorInfo: (info) => {
      trace.action('canvas:bridge-anchor-info', info ?? { info: null });
      jotaiStore.set(selectedAnchorInfoAtom, info);
    },
  });

  // Keep mutation queue aware of active file (for writeFile mutations)
  useEffect(() => { setQueueActiveFile(activeFilePath); }, [activeFilePath]);

  // Track where the user came from when they navigate INTO a CMS `[slug]`
  // detail page, so the slug breadcrumb can lead with a "back to <origin>"
  // segment (the collection segment opens the CMS overlay, not navigation).
  // In-memory; the breadcrumb falls back to the slug page's parent route.
  const prevActiveFileRef = useRef<string | null>(null);
  const setSlugReferrer = useSetAtom(slugPageReferrerByFileAtom);
  useEffect(() => {
    const prev = prevActiveFileRef.current;
    prevActiveFileRef.current = activeFilePath;
    if (!prev || prev === activeFilePath) return;
    const code = projectFS.readFile(activeFilePath);
    const meta = code ? parseCmsPageMeta(code) : null;
    if (meta?.kind !== 'detail') return;
    setSlugReferrer((m) => {
      if (m.get(activeFilePath) === prev) return m;
      const n = new Map(m);
      n.set(activeFilePath, prev);
      return n;
    });
  }, [activeFilePath, setSlugReferrer]);


  // Preload every Google Font the project references — on load AND on page
  // switch. Scans the whole ProjectFS (raw source + preset tokens, resolving
  // `var(--typo-…-font)` refs), not just the active page's node styles, so
  // typography-preset fonts load without the user having to open the preset
  // editor (whose FontFamilyControl loadGoogleFont()s as a render side-effect
  // — previously the only path that loaded them). Also self-heals missing
  // Google Fonts @imports in app/globals.css for the canvas iframe + live site.
  useEffect(() => {
    preloadProjectFonts();
    // One-time-per-collection backfill of CMS Created/Updated timestamps so
    // older items are sortable/filterable by date (idempotent — see cms-ops).
    backfillCmsTimestamps();
  }, [activeFilePath]);

  // ─── Viewport/Variant resolution ────────────────────────────────────────
  // Component files use variant configs. Icon-set masters use a single
  // viewport (no breakpoint replicas — vectors are discrete picks). Pages
  // use writable viewport widths.
  const activeViewports = useActiveViewports();
  const isComponentFile = isComponentFilePath(activeFilePath);
  // Icon-set masters render with a single anonymous master viewport
  // that sizes itself to the variant grid (NOT to root.style.width,
  // which is `'100%'` in the template — parseInt would yield 100 and
  // clamp the viewport to 100 px). The width-from-grid fallback below
  // handles it cleanly.
  const isIconSetMaster = isIconSetFilePath(activeFilePath);

  // Keep global style context in sync for imperative code (ResizeManager, DragCoordinator)
  const interactingVpWidth = activeViewports.find(v => v.id === interactingVpIdVal)?.width ?? DEFAULT_VIEWPORT_WIDTH;
  setStyleContext(activeFilePath, interactingVpIdVal, interactingVpWidth, activeLocale, isDefaultLocale);

  // Wire the canvas-initiated flag setter so updateNodeStyles can suppress the
  // next iframe render (the bridge has already been patched directly).
  setUpdatingFromCanvasFlagger(() => { renderer.markCanvasUpdate(); });

  // Wire replica overrides getter — lets updateNodeStyles avoid stomping a
  // replica's @media width/height (etc.) when a primary resize fans out.
  // Exact-width match: only the viewport that explicitly overrides the
  // property is shielded; synced replicas still mirror primary live.
  setReplicaOverridesGetter((nodeId, vpWidth) => {
    if (!vpWidth) return {};
    return Object.fromEntries(getOverridesAtWidth(containerOverrides, nodeId, vpWidth));
  });

  // Wire force-render so drag strategies can flush a structural change to
  // the iframe DOM mid-drag (live re-parent), bypassing the canvasInteracting
  // skip guard. Read nodes/code from the jotai store IMPERATIVELY rather
  // than from refs — refs only update on React commit, which hasn't fired
  // yet during the strategy's sync execution after flushNow. Using the
  // refs would ship the OLD pre-move nodes to the iframe, defeating the
  // whole purpose of forceRender.
  setForceCanvasRender((mode?: 'force' | 'patch', overrideNodes?: Map<string, CanvasNode>, overrideCode?: string) => {
    // Use the Provider store, NOT getDefaultStore(). main.tsx's <Provider>
    // creates an isolated store; getDefaultStore() returns a different
    // (unused) store and would re-derive nodesAtom from the unwritten
    // initial codeAtom, shipping pre-edit nodes to the iframe.
    const store = jotaiStore;
    // Undo/redo passes PRE-DERIVED nodes + code (seedNodesForCode) — reading
    // nodesAtom there would key on the still-stale codeAtom (the fan-out is
    // deferred) and re-parse the WRONG code, clobbering the seeded cache.
    //
    // While a deferred fan-out is ARMED (drop / drag-end / restore window),
    // nodesAtom + codeAtom are intentionally STALE — the imperative node
    // cache and the queue's currentCode are the committed truth. A force
    // render fired inside that window (e.g. a strategy's deferred truth-up
    // rAF) must not rebuild from the stale parse: it re-nests a just-exited
    // node back into its OLD parent until the fan-out lands (the "snaps
    // back to the original slot, then jumps to canvas" flash).
    // The same staleness holds for the whole GESTURE window (dragStateOps
    // true): deferred-drag-flush stashes the setCode fan-out, so nodesAtom /
    // codeAtom lag the queue until gesture end. A commit-time force render
    // (svg group-child drag/resize refit) fires BEFORE scheduleDragEndFanOut
    // arms the deferral — reading nodesAtom there shipped the PRE-drag parse,
    // overwrote the bridge-patched finals, and (because identity-preserve
    // returns sameMap for the later fresh parse) no reconciling render ever
    // followed. The DOM wrapper stayed one refit behind the model — paints
    // correct after the commit's re-base, but every SUBSEQUENT drag of a
    // group child starts offset (first drag after reload was stable).
    const gestureActive = dragStateOps.get();
    const fanOutArmed = hasPendingDeferredFanOut() || gestureActive;
    const cachedMap = getCachedNodesMap();
    const freshNodes = overrideNodes ?? (fanOutArmed && cachedMap.size > 0 ? cachedMap : store.get(nodesAtom));
    const freshCode = overrideCode ?? (fanOutArmed ? getCurrentCode() : store.get(codeAtom));
    // INTEGRITY GUARD (stale-window renders only): a structural ADD reaches
    // the imperative cache only via the next parse — a forced render racing
    // into that window ships a map MISSING the just-committed node and
    // rebuilds the canvas without it ("my new frame vanished after 2s but
    // it's still in Layers" — 1-in-50 race, user report 2026-07-29). When the
    // committed code declares ids the shipped map doesn't have, SKIP: the
    // pending fan-out parse renders the complete tree (and fires
    // renderComplete for any suppression waiting on it) moments later.
    if (!overrideNodes && fanOutArmed && shouldSkipLaggingForcedRender(freshCode, freshNodes)) return;
    const globals = projectFS.readFile('app/globals.css') || '';
    // Pull CMS state from the imperative store too — drag strategies that
    // call forceRender mid-flight need the iframe to keep its collection
    // ghost copies populated, otherwise the canvas flashes empty cards.
    const freshSchemas = store.get(collectionSchemasAtom);
    const freshData = store.get(collectionDataAtom);
    // Pull viewports + widths IMPERATIVELY too. The previous version used
    // `activeViewportsRef.current`, but that ref only updates on React
    // commit. Callers that fire forceRender right after a synchronous atom
    // write (e.g. SizeTool's viewport-breakpoint change) ran BEFORE React
    // had a chance to re-render, so the ref still pointed to the OLD
    // widths and the iframe rebuilt at the prior size — visible only once
    // the next event (drag) triggered another commit. Re-deriving from the
    // current `viewportsConfigAtom` + `viewportWidthsAtom` here matches the
    // exact computation in the component body (Canvas.tsx:393-408).
    const freshConfigs = store.get(viewportsConfigAtom);
    const freshWidths = store.get(viewportWidthsAtom);
    const freshPositions = store.get(viewportPositionsAtom);
    // Component AND icon-set masters use the activeViewports computed in the
    // render path (variants for components, single viewport for icon sets).
    // Page files re-derive from atoms because viewport widths can change live.
    const activeFilePathNow = store.get(activeFilePathAtom);
    const isMasterFile = isComponentFilePath(activeFilePathNow) || isIconSetFilePath(activeFilePathNow);
    const freshViewports = isMasterFile
      ? activeViewportsRef.current
      : freshConfigs.map(v => {
          const merged = { ...v, width: freshWidths[v.id] ?? v.width };
          const pos = freshPositions[v.id];
          return pos ? { ...merged, ...pos } : merged;
        });
    // DETAIL-PAGE CMS VALUES LIVE IN THE NODES, AND ARE BAKED IN RIGHT HERE.
    //
    // Exactly the localeOverrides trap below, one binding system over. On a
    // `/collection/[slug]` page the parser leaves `{item.title}` nodes with an
    // EMPTY textContent and a `binding` descriptor; the words only exist once
    // `applyDetailPageBindings` substitutes the previewed record. React renders
    // do that in useRendererSync, but this imperative path shipped the raw
    // parser map — so `patchElement` saw empty text, `shouldClearEmptiedText`
    // fired, and every bound paragraph and image on the page was wiped.
    //
    // It reproduced on ANY style edit, because those end in
    // `forceRenderAfterExternalEdit` (user report 2026-09-01: changing padding
    // made all the images disappear; 72 `clear-emptied-text` traces in one
    // pass, and the live preview - which never takes this path - stayed
    // correct). Read from the store, not a closure: this callback is
    // imperative and long-lived, and the previewed slug changes under it.
    const cmsMeta = store.get(cmsPageMetaAtom);
    const cmsPreviewItem = store.get(activePreviewItemAtom);
    const boundNodes = cmsMeta?.kind === 'detail' && cmsPreviewItem
      ? applyDetailPageBindings(freshNodes, cmsPreviewItem)
      : freshNodes;

    const freshInput = {
      nodes: boundNodes,
      viewports: freshViewports,
      code: freshCode,
      css: '',
      globalsCss: globals,
      activeLocale,
      defaultLocale: isDefaultLocale ? undefined : i18nConfig?.defaultLocale,
      cmsCollections: {
        schemas: Object.fromEntries(freshSchemas),
        data: Object.fromEntries(freshData),
      },
      // TRANSLATED TEXT LIVES HERE, NOT IN THE NODE.
      //
      // A `{t('key')}` node parses to an EMPTY `textContent` — the words come
      // from this map. `patchElement` clears a node whose text went empty
      // (`shouldClearEmptiedText`) and then re-applies the override; with the
      // map missing, the clear lands and the re-apply is a no-op, so every
      // translated node on the page is WIPED. This input omitted it, so any
      // imperative `forceCanvasRender()` — entering overlay edit mode, and a
      // dozen other paths — blanked all localized text until the next React
      // render through `useRendererSync` put it back (user report 2026-08-09:
      // "when i just open the overlay, suddenly all of the text on the page
      // completely disappears").
      //
      // Read from the store, not a closure: this callback is imperative and
      // long-lived, and `useLocaleOverrides` rewrites the atom whenever the
      // locale, page or messages change.
      localeOverrides: store.get(localeOverridesAtom),
    };
    // 'patch' (undo/redo): diff-patch via render() — no rebuild, no code-
    // component remount. INTENTIONAL: an undo restore must never be eaten by
    // a leftover canvasUpdating mark or the duplicate-forward dedup (the DOM
    // may have imperatively diverged from the last-forwarded state — the
    // stale-lineHeight-after-Cmd+Z class). 'force' (default): the historical
    // full-rebuild bypass.
    trace.action('canvas:force-render-source', {
      mode: mode ?? 'force',
      gestureActive,
      fanOutArmed,
      usedCache: !overrideNodes && fanOutArmed && cachedMap.size > 0,
      hasOverrides: !!overrideNodes,
      nodeCount: freshNodes.size,
    });
    // distrustPatchKeys: an undo/redo restore recreates a PAST state, so
    // per-element patch keys stamped back then can coincide with the new
    // signatures and subtree-skip stale DOM (see the render() call site).
    if (mode === 'patch') renderer.render(freshInput, { intentional: true, distrustPatchKeys: true });
    else renderer.forceRender(freshInput);
  });

  // ─── Locale overrides ────────────────────────────────────────────────────
  // Extracted to hook: wires setLocaleStyleCallback + loads overrides from
  // :lang() CSS, i18n/ JSON (legacy), and messages/ (next-intl).
  useLocaleOverrides(contentRef);

  // Connection modal state (for variant connections)
  const [connectionModal, setConnectionModal] = useState<{
    from: string; to: string; position: { x: number; y: number };
    /** When set, the trigger handler attaches to the JSX element with
     *  this `data-id` instead of the variant root. */
    sourceNodeId?: string;
  } | null>(null);

  // Snap guides + spacing bands live in snap-guides-store (module state +
  // useSyncExternalStore in SnapGuidesOverlay) — as Canvas useState the
  // per-frame updates re-rendered the ENTIRE Canvas subtree during drags
  // (headers rebuild + AddViewportMenu + tool re-renders at ~37fps on big
  // pages).
  const setSpacingGuides = snapGuidesOps.setSpacing;
  // Track which ruler-guide IDs are currently being snapped to so
  // `RulerGuides.tsx` can hide them while the snap is locked (the pink
  // snap line + cyan guide line would otherwise stack on the same pixel,
  // and the user can't tell whether the snap actually fired). Done in
  // the same callback as `setSnapGuides` so the atom write lands in the
  // same React batch — useEffect-sync would cause an extra render every
  // snap-state change.
  const setSnappedRulerIds = useSetAtom(snappedRulerGuideIdsAtom);
  const setSnapGuides = useCallback((guides: SnapGuide[]) => {
    snapGuidesOps.setSnap(guides);
    let next: Set<string> | null = null;
    for (const g of guides) {
      if (g.referenceId.startsWith('ruler-guide:')) {
        if (!next) next = new Set();
        next.add(g.referenceId.slice('ruler-guide:'.length));
      }
    }
    // Reuse the empty set when nothing changed so atom subscribers
    // don't re-render on every snap-line update during normal drags.
    setSnappedRulerIds((prev: Set<string>) => {
      if (!next && prev.size === 0) return prev;
      if (next && prev.size === next.size && [...prev].every((id) => next!.has(id))) return prev;
      return next ?? new Set();
    });
  }, [setSnappedRulerIds]);
  const [addVpMenu, setAddVpMenu] = useState<AddViewportMenuState>({ show: false, sourceVpId: '', x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [mutationError, setMutationError] = useState<MutationErrorDetail | null>(null);

  // Fresh refs for callbacks (avoid stale closures). Getter-backed like
  // nodesRef below — reads the Provider store imperatively so callbacks see
  // the CURRENT code without Canvas subscribing to every commit.
  const codeRef = useMemo(() => ({
    get current() { return jotaiStore.get(codeAtom); },
    set current(_v: string) { /* read-only mirror — the code lives in the store */ },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  // Getter-backed "ref": `.current` reads the CURRENT node map imperatively
  // (getNodesSnapshot runs the nodesAtom getter, so a pending re-parse lands
  // first). Shaped like a MutableRefObject so the existing consumers
  // (useKeyboardShortcuts, useCanvasCommandsBridge, drag/frame-creator
  // getNodes) work unchanged — but with NO nodesAtom subscription behind it,
  // Canvas no longer re-renders on every commit just to refresh a mirror.
  const nodesRef = useMemo(() => ({
    get current() { return getNodesSnapshot(); },
    set current(_v: Map<string, CanvasNode>) { /* read-only mirror — the map lives in the store */ },
  }), []);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const toolModeRef = useRef(toolMode);
  toolModeRef.current = toolMode;
  const interactingVpIdRef = useRef(interactingVpIdVal);
  interactingVpIdRef.current = interactingVpIdVal;
  // activeFilePathRef removed — every long-lived consumer reads the active
  // file via `jotaiStore.get(activeFilePathAtom)` (e.g. the drag orchestrator
  // constructed in a `[]`-deps effect). Closing over the `activeFilePath`
  // state variable in a once-only effect freezes the value at mount and
  // silently leaks writes to the wrong file when the user switches pages
  // mid-session — always prefer the live atom read.
  // NOTE: prevRenderedFilePathRef moved into useRendererSync (owns file-switch detection).
  const activeViewportsRef = useRef(activeViewports);
  activeViewportsRef.current = activeViewports;
  const nodeMouseDownRef = useRef<(nodeId: string, e: MouseEvent) => void>(() => {});

  // ─── Text Editing ──────────────────────────────────────────────────────
  //
  // Extracted to CanvasTextEditController. The controller owns all refs and
  // commit branches. Canvas.tsx only holds the ref to the controller and
  // wires its lifecycle to sandboxReady.
  //
  // Backward-compat: editingNodeIdRef is kept as a proxy so keyboard-shortcuts
  // and useRendererSync can still gate on editing state without importing the
  // controller.

  const textEditControllerRef = useRef<import('./text-edit/CanvasTextEditController').CanvasTextEditController | null>(null);

  // Proxy ref: mirrors controller.getEditingNodeId() for callers that still
  // test editingNodeIdRef.current (keyboard shortcuts, useRendererSync render guard,
  // mousedown handler).
  const editingNodeIdRef = useRef<string | null>(null);

  // Controller lifecycle — construct when bridge is ready, dispose on unmount.
  useEffect(() => {
    if (!sandboxReady) return;
    const bridge = postMessageBridgeRef.current;
    if (!bridge) return;
    const controller = new CanvasTextEditController({
      jotaiStore,
      bridge,
      iframeRef,
      renderer,
      getInteractingVpId: () => interactingVpIdRef.current || 'desktop',
    });
    textEditControllerRef.current = controller;
    trace.action('canvas:text-edit-controller-created', {});
    return () => {
      if (textEditControllerRef.current) {
        textEditControllerRef.current.dispose();
        textEditControllerRef.current = null;
        editingNodeIdRef.current = null;
        trace.action('canvas:text-edit-controller-disposed', {});
      }
    };
  }, [sandboxReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the proxy ref in sync after each render so callers always see the
  // current editing node id without importing the controller.
  editingNodeIdRef.current = textEditControllerRef.current?.getEditingNodeId() ?? null;

  // Wrapper functions that delegate to the controller (same API as the old
  // useCallback closures so all existing callers remain unchanged).
  const startTextEdit = useCallback((nodeId: string, _el: HTMLElement | null, textContent: string, vpId?: string) => {
    textEditControllerRef.current?.startEdit(nodeId, textContent, vpId);
    // Sync proxy ref immediately so keyboard shortcuts / render guard see the update.
    editingNodeIdRef.current = nodeId;
  }, []);

  const commitTextEdit = useCallback(async () => {
    await textEditControllerRef.current?.commitEdit();
    editingNodeIdRef.current = textEditControllerRef.current?.getEditingNodeId() ?? null;
  }, []);

  // Expose commitTextEdit to non-canvas UI (the right-header Play button) so it
  // can flush an in-progress text-edit before entering the live preview.
  useEffect(() => {
    registerTextEditCommitter(commitTextEdit);
    return () => registerTextEditCommitter(null);
  }, [commitTextEdit]);

  // ─── Drag Orchestrator ─────────────────────────────────────────────────
  // CanvasDragOrchestrator wraps DragCoordinator, owns the 5-branch commit
  // ladder, and manages the auto-pan lifecycle. Constructed once per mount
  // (after containerRef/contentRef are ready via a DOM-committed useEffect).
  // All heavy commit logic now lives in CanvasDragOrchestrator.commitUpdates.

  const dragOrchestratorRef = useRef<import('./drag/CanvasDragOrchestrator').CanvasDragOrchestrator | null>(null);

  // Shim: callers that still take a DragCoordinator (useCanvasTransform,
  // setToolbarDragCoordinator) receive the inner coordinator.
  // Updated by the effect below whenever the orchestrator is (re)created.
  const dragCoordinatorRef = useRef<DragCoordinator | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const orchestrator = new CanvasDragOrchestrator({
      jotaiStore,
      containerEl: container,
      contentEl: content,
      getVpOverlay: () => vpOverlayRef.current,
      onSnapGuidesChange: setSnapGuides,
      onSpacingGuidesChange: setSpacingGuides,
      onDraggingChange: setIsDragging,
      onCanvasInteractingChange: setCanvasInteracting,
      getCode: () => codeRef.current,
      getNodes: () => nodesRef.current as any,
      getSelectedIds: () => {
        const ids = selectedIdsRef.current;
        return ids.length > 0 ? ids : (selectedIdRef.current ? [selectedIdRef.current] : []);
      },
      // Live atom read, NOT a closure over the `activeFilePath` state value.
      // The orchestrator is constructed once per mount (`useEffect(…, [])` below),
      // so a `() => activeFilePath` closure would freeze the path captured at
      // the initial render. After the user enters a component master via the
      // breadcrumb (active file flips from `app/page.tsx` → `components/Foo.tsx`),
      // dragging the default variant would then commit `updateVariantPosition`
      // against the OLD page path — silently polluting the home page with a
      // `variantConfig` array. Reading the atom on each call keeps us aligned
      // with the active-file-store at commit time.
      getActiveFilePath: () => jotaiStore.get(activeFilePathAtom),
      isComponentFile,
      setSelectedIds,
      renderer,
      getInteractingVpId: () => interactingVpIdRef.current || 'desktop',
      setCode,
    });
    dragOrchestratorRef.current = orchestrator;
    dragCoordinatorRef.current = orchestrator.coordinator;
    setToolbarDragCoordinator(orchestrator.coordinator);
    trace.action('canvas:drag-orchestrator-created', {});

    return () => {
      setToolbarDragCoordinator(null);
      dragOrchestratorRef.current?.dispose();
      dragOrchestratorRef.current = null;
      dragCoordinatorRef.current = null;
      trace.action('canvas:drag-orchestrator-disposed', {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Constructed once per mount — all deps accessed via stable refs/getters

  // Keep coordinator refs + derived flags up to date when DOM or file changes.
  // updateRefs handles DOM element changes; updateDerivedFlags handles file-type changes.
  useEffect(() => {
    if (dragOrchestratorRef.current && containerRef.current && contentRef.current) {
      dragOrchestratorRef.current.updateRefs(containerRef.current, contentRef.current);
      dragOrchestratorRef.current.updateDerivedFlags(isComponentFile);
    }
  });

  // ─── Shape edit mode: clear when selection changes ────────────────────────
  // Kept in Canvas.tsx (not moved to controller) because it reacts to
  // React-atom changes (selectedId) via useEffect — not a mouse event.
  useEffect(() => {
    // If a different node is selected (or deselected), exit shape edit mode — persist first
    setShapeEditingId(prev => {
      if (prev && prev !== selectedId) {
        trace.action('canvas:shape-edit-exit', { reason: 'selection-changed', prev, newSelectedId: selectedId });
        setSelectedPoint(null);
        return null;
      }
      return prev;
    });
  }, [selectedId, setShapeEditingId, setSelectedPoint]);

  // Stable-atom mirror moved to a leaf host (<StableAtomSyncHost /> in the
  // JSX below) so its per-commit subscriptions don't re-render Canvas.
  useMutationQueueLifecycle({ onError: setMutationError });

  // ─── Render nodes + viewport headers ────────────────────────────────────
  // Renderer sync is hosted in a LEAF (<RendererSyncHost/> in the JSX below)
  // so its per-commit nodesAtom/codeAtom subscriptions — its job is shipping
  // every commit to the iframe — no longer re-render the whole Canvas
  // subtree. Canvas owns the hover-cooldown ref; the leaf's hook writes into
  // it, the mouse handlers read it.
  const hoverSuppressUntilRef = useRef<number>(0);

  // ─── Transform ─────────────────────────────────────────────────────────
  // Drives cursor + toolbar hand highlight while panning (defined here so
  // useCanvasTransform can receive it; consumed by mouse handlers below).
  const [panCursor, setPanCursorLocal] = useState(false);
  const setPanHighlight = useSetAtom(panHighlightAtom);
  const setPanCursor = useCallback((v: boolean) => {
    setPanCursorLocal(v);
    setPanHighlight(v);
  }, [setPanHighlight]);

  // Extracted into useCanvasTransform: registers content + vpOverlay with
  // transformManager, subscribes for pan/zoom ticks, attaches wheel +
  // middle-mouse-pan listeners, tracks viewport header positions, observes DOM.
  useCanvasTransform({
    containerRef,
    contentRef,
    vpOverlayRef,
    iframeRef,
    postMessageBridgeRef,
    dragCoordinatorRef,
    setPanCursor,
  });

  // ─── Mouse Controller ────────────────────────────────────────────────────────
  // CanvasMouseController owns all mouse handling: hover, mousedown, mouseup,
  // dblclick, ghost detection, replica selection, and viewport-change events.
  // Constructed once sandboxReady fires (needs bridge + orchestrators).
  const mouseControllerRef = useRef<CanvasMouseController | null>(null);

  // Shared creator callbacks — defined before the controller so it can be
  // threaded in via frameCreatorCallbacksRef. Updated every render so
  // callbacks always close over the latest state/refs.
  const frameCreatorCallbacksRef = useRef<() => any>(null);
  frameCreatorCallbacksRef.current = () => ({
    getContainerRect: () => containerRef.current!.getBoundingClientRect(),
    getContentEl: () => contentRef.current!,
    getNodes: () => nodesRef.current,
    onCreated: (nodeId: string, vpId: string) => {
      if (vpId && vpId !== interactingVpIdRef.current) {
        setInteractingViewport(vpId);
      }
      setSelectedIds([nodeId]);
    },
    onToolReset: () => setToolMode('select'),
    getViewportWidth: (vpId: string) => {
      const vp = activeViewports.find(v => v.id === vpId);
      return vp?.width ?? DEFAULT_VIEWPORT_WIDTH;
    },
    onNodeMouseDown: (nodeId: string, e: MouseEvent) => mouseControllerRef.current?.handleNodeMouseDown(nodeId, e),
    onStartTextEdit: (nodeId: string, el: HTMLElement) => {
      startTextEdit(nodeId, el, el.innerHTML || '​');
    },
  });

  useEffect(() => {
    if (!sandboxReady) return;
    const bridge = postMessageBridgeRef.current;
    if (!bridge || !dragOrchestratorRef.current || !textEditControllerRef.current) return;

    const controller = new CanvasMouseController({
      jotaiStore,
      bridge,
      containerRef,
      iframeRef,
      contentRef,
      dragCoordinatorRef,
      textEditControllerRef,
      editingNodeIdRef,
      hoverSuppressUntilRef,
      canvasInteractingValRef,
      frameCreatorCallbacksRef,
      setBreadcrumb,
      setActiveFilePath,
      setUpdatingFromCanvas,
      setPanCursor,
      setInteractingViewport,
      setSelectedIds,
      setHoveredId,
      setHoveredNodeId,
      setHoveredViewport: (id: string | null) => setHoveredViewport(id as string),
      setMapItemIndex,
      setShapeEditingId,
      setSelectedPoint,
      setGroupEditingId,
      setOverlayEditingId,
      startTextEdit,
      commitTextEdit,
      openCmsEditor,
      setLeftPanel: (p: string) => setLeftPanel(p as any),
      setToolMode: (m: string) => setToolMode(m as any),
      getCmsData: () => cmsData,
    });
    controller.bindNodeMouseDown(nodeMouseDownRef);
    mouseControllerRef.current = controller;
    trace.action('canvas:mouse-controller-wired', {});
    return () => {
      controller.dispose();
      mouseControllerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxReady]); // Constructed once per sandboxReady — all deps accessed via stable refs/getters

  // Keep nodeMouseDownRef current after each render so Renderer can install per-node handlers
  // even before the controller is constructed (uses the ref's latest bound function).

  // Hover suppression note: isPanning/isSpacePanning/isSpaceBarDown are consumed
  // inside CanvasMouseController.handleMouseMove. No inline reference here.

  // Grip handle drag start — called from SelectionOverlay → GripHandle
  const handleGripDragStart = useCallback((nodeId: string, event: React.PointerEvent, gripAxis: 'x' | 'y') => {
    trace.action('canvas:grip-drag-start', { nodeId, gripAxis });
    const vpPrefix = getViewportPrefix(interactingVpIdVal);
    dragCoordinatorRef.current?.startPending(nodeId, event.nativeEvent, vpPrefix, { gripAxis });
  }, [interactingVpIdVal]);

  // Selection box (rubber band) callback. `vpId` = the viewport the marquee
  // mostly covered — set it as the interacting viewport so a sweep over a
  // TABLET/MOBILE replica selects there exactly like a replica click would.
  // `viewportsByNode` feeds the overlay's per-artboard outlines: a sweep
  // spanning desktop + tablet + mobile shows the selection on EVERY swept
  // artboard at once (standard), keyed to this exact selection via the
  // sig so any later non-marquee selection self-invalidates the spread.
  const handleSelectionBoxChange = useCallback((ids: string[], vpId: string, viewportsByNode: Record<string, string[]>) => {
    trace.action('canvas:selection-box-change', { count: ids.length, ids, vpId });
    setSelectedIds(ids);
    if (ids.length > 0 && vpId) setInteractingViewport(vpId);
    setMarqueeSpread(ids.length > 0 ? { sig: marqueeSelectionSig(ids), byNode: viewportsByNode } : null);
    // Cancel the deferred deselect — selection box is handling selection
    mouseControllerRef.current?.cancelEmptyCanvasClick();
  }, [setSelectedIds, setInteractingViewport, setMarqueeSpread]);

  // Wheel + middle-mouse pan: moved to useCanvasTransform above.

  // ─── Keyboard Shortcuts (via KeyboardManager) ──────────────────────────
  useKeyboardShortcuts({
    selectedIdRef, selectedIdsRef, nodesRef, contentRef, editingNodeIdRef, toolModeRef,
    // Tool shortcuts (v / f / t / shapes / layouts …) all route through
    // this setter. Comment mode is mutually exclusive with every tool —
    // it forces toolMode to 'select', so pressing 'v' wouldn't change
    // toolMode and a plain effect couldn't detect it. Clearing comment
    // mode here covers every tool keypress, including 'v'.
    setToolMode: ((m: string) => {
      setToolMode(m as any);
      setCommentModeActive(false);
    }) as any,
    setSelectedIds, commitTextEdit,
    handleNodeMouseDown: (nodeId: string, e: MouseEvent) => mouseControllerRef.current?.handleNodeMouseDown(nodeId, e),
    setPanHighlight: setPanCursor,
  });

  // ─── Canvas Commands Bridge ─────────────────────────────────────────────
  // Publishes the same selection/node/content refs used by the keyboard
  // shortcuts so the cmd+K palette (and any future menu surface) can
  // call paste/cut/duplicate and selection navigation without
  // reimplementing the closure-captured plumbing. Cleared on unmount.
  useCanvasCommandsBridge({
    selectedIdRef, selectedIdsRef, nodesRef, contentRef,
    setSelectedIds,
    handleNodeMouseDown: (nodeId: string, e: MouseEvent) => mouseControllerRef.current?.handleNodeMouseDown(nodeId, e),
  });

  // ─── Insertion Bridge ───────────────────────────────────────────────────
  // Publishes the selection setter so the cmd+K palette (and any other
  // imperative insert path) can route its node-creation through the
  // shared paste-rule engine and have the created ids auto-selected.
  useInsertionBridge({ setSelectedIds });

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Leaf hosts — their per-commit nodesAtom/codeAtom subscriptions live
          on these null-rendering fibers, not on Canvas (see
          useStableAtomSync / useRendererSync). */}
      <StableAtomSyncHost />
      <RendererSyncHost
        activeViewports={activeViewports}
        sandboxReady={sandboxReady}
        iframeRenderTick={iframeRenderTick}
        vpOverlayRef={vpOverlayRef}
        postMessageBridgeRef={postMessageBridgeRef}
        editingNodeIdRef={editingNodeIdRef}
        canvasInteractingValRef={canvasInteractingValRef}
        isComponentFile={isComponentFile}
        isIconSetMaster={isIconSetMaster}
        setSnapGuides={setSnapGuides}
        setSpacingGuides={setSpacingGuides}
        setAddVpMenu={setAddVpMenu}
        startTextEdit={startTextEdit}
        commitTextEdit={commitTextEdit}
        hoverSuppressUntilRef={hoverSuppressUntilRef}
      />
      {mutationError && <MutationErrorBanner error={mutationError} />}
    <div
      ref={containerRef}
      data-canvas-viewport=""
      // Anchor for the live-collaboration cursor overlay. The
      // CollaboratorCursors layer reads this element's
      // getBoundingClientRect() to convert canvas-relative cursor
      // coords into screen-space transforms. Co-located with the
      // canvas viewport so cursors stay aligned with what each user
      // is actually editing.
      data-canvas-root=""
      onMouseDown={e => mouseControllerRef.current?.handleMouseDown(e.nativeEvent)}
      onMouseMove={e => mouseControllerRef.current?.handleMouseMove(e.nativeEvent)}
      onMouseUp={e => mouseControllerRef.current?.handleMouseUp(e.nativeEvent)}
      onMouseLeave={e => mouseControllerRef.current?.handleMouseUp(e.nativeEvent)}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        // A right-click on a VIEWPORT HEADER opens the same menu, but none
        // of the node operations apply to a viewport — the flag disables
        // them (see context-menu-store).
        const onViewportHeader =
          (e.target as HTMLElement).closest?.('[data-viewport-header]') != null;
        setContextMenu({
          show: true,
          x: e.clientX,
          y: e.clientY,
          nodeId: onViewportHeader ? null : selectedId,
          viewportHeader: onViewportHeader,
        });
      }}
      style={{
        flex: 1, overflow: 'hidden', backgroundColor: 'transparent',
        position: 'relative', cursor: toolMode === 'frame' || toolMode === 'text' || toolMode === 'sketch' || isShapeMode(toolMode) || isLayoutMode(toolMode) ? 'crosshair' : panCursor ? 'grabbing' : toolMode === 'hand' || isSpaceBarDown() ? 'grab' : 'default',
        userSelect: 'none', WebkitUserSelect: 'none',
      }}
    >
      {/* NOTE: the COMPONENT-master "Editing Overlay / Exit" affordance lives in the
          top breadcrumb bar (`ComponentBreadcrumb.tsx`) — it REPLACES the breadcrumb in
          overlay-edit mode. A canvas-floating banner here would sit BEHIND that fixed
          z-9000 bar. Pages use the per-viewport header affordance. `exitOverlayEdit` is
          still shared with the viewport header's Done button. */}

      {/* Hidden parent-frame anchor — DragCoordinator/SelectionBox initialize against it.
          Actual canvas content lives in the sandbox iframe below. */}
      <div ref={contentRef} data-content-root="" style={{
        position: 'absolute', transform: 'translateZ(0)', backfaceVisibility: 'hidden',
        display: 'none',
      }} />
      <iframe
        ref={iframeRef}
        // Stable identifier for parent-frame code that needs to reach the
        // canvas iframe imperatively (master-entry opacity dip in
        // `enterComponentFile`, etc.) without depending on the iframe's
        // `src` URL or its position among any future siblings.
        data-canvas-iframe=""
        src={SANDBOX_ORIGIN + '/'}
        onLoad={handleIframeLoad}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: 'none',
          // pointer-events: none — clicks pass through to the parent's
          // containerRef which still owns selection + drag via DragCoordinator.
          // canvas-dnd is initialized inside the iframe but doesn't capture
          // events yet (full migration pending).
          pointerEvents: 'none',
          zIndex: 0,
          background: 'transparent',
        }}
        sandbox="allow-scripts allow-same-origin"
        // credentialless="" — required for the parent's
        // `Cross-Origin-Embedder-Policy: credentialless` to accept this
        // cross-origin (5174) embed. Pairs with the iframe response's CORP
        // header. Effect: cross-origin isolation kicks in, the iframe gets
        // its own renderer process. React/JSX type doesn't ship the attr,
        // so spread it via `{...{ credentialless: '' }}`.
        {...({ credentialless: '' } as Record<string, string>)}
        tabIndex={-1}
      />

      {/* Canvas-space overlay for viewport headers (imperative, transforms with content).
          zIndex:1 keeps it above the iframe (zIndex:0). Without an explicit
          z-index the iframe's stacking context wins on some browser/GPU paths
          and the headers become invisible. */}
      <div ref={vpOverlayRef} style={{ position: 'absolute', transform: 'translateZ(0)', backfaceVisibility: 'hidden', pointerEvents: 'none', zIndex: 1 }} />

      {/* Pixel grid — shows 1px grid lines when zoomed past 500% */}
      <PixelGrid />

      {/* Rulers + persistent ruler guides — gated on the `showRulers`
          pref. CanvasRulers draws the top + left strips with px ticks
          and starts new guides via drag-from-ruler; RulerGuides
          renders the per-page persistent guide lines (parsed from the
          active file's `@rulerGuides` annotation block) and
          handles drag/select/delete/context-menu for each. Both gate
          internally on `showRulersAtom`, so flipping the pref hides
          everything in one shot. */}
      <CanvasRulers />
      <RulerGuides />

      {/* Comment markers — bubbles + edit popup + chat popup. Renders
          only when `commentModeActiveAtom` is true; otherwise null
          (the canvas stays uncluttered during normal editing). */}
      <Comments />

      {/* Selection + hover overlays */}
      <CanvasOverlay>
        <SelectionOverlay onGripDragStart={handleGripDragStart} onSnapGuidesChange={setSnapGuides} />
        {/* Solid outline on the node a LAYERS-PANEL drag is about to drop
            INSIDE — stable JSX slot, independent of SelectionOverlay's early
            returns (mirrors ShapeEditOverlayHost's placement). */}
        <LayerDropHighlight />
        {/* Shape-edit overlay lives at this stable JSX slot — outside
            SelectionOverlay's many conditional return paths. Mounting it
            inside SelectionOverlay caused React to unmount+remount it
            whenever the JSX position shifted (e.g. isInteracting flipping
            when the user dragged a Position chevron), which fired
            commitShapeEdit on the unmount and dropped the editor's
            selection on the remount. */}
        <ShapeEditOverlayHost />
      </CanvasOverlay>

      {/* Sketch brush-stroke capture overlay — renders only when
          `sketchEditingIdAtom` is set (after drag-create-commit, or
          double-click on an existing `<svg data-sketch="true">`).
          Lives outside CanvasOverlay so it can own its own pointer
          events without the overlay wrapper's pointer-events:none. */}
      <SketchEditOverlay />

      {/* Floating name + icon labels above canvas-level floaters and
          (in component master files) every variant root. Lives outside
          CanvasOverlay because it tracks its own per-node positions
          via the bridge — no need to share the overlay's wrapper. */}
      <CanvasNodeNameDisplay />

      {/* Pin constraint lines for pinned absolute elements — hidden while in
          TEXT EDIT MODE so the dashed connectors don't clutter the text the
          user is editing (same reason ConnectionHandle gates on !isTextEditing). */}
      {!isTextEditing && <PanelErrorBoundary name="pin-lines" resetKey={selectedId}><PinConstraintLines /></PanelErrorBoundary>}
      {/* Distance indicators (ALT + selection; ALT + hover measures to the
          hovered element instead). Boundaried like pin-lines above: it is a
          position:fixed overlay, so an unguarded throw takes the whole canvas
          subtree with it. */}
      <PanelErrorBoundary name="distance-indicators" resetKey={selectedId}>
        <DistanceIndicators />
      </PanelErrorBoundary>
      {/* Dimensions indicators (ALT + CTRL + selection) */}
      <DimensionsIndicators />

      {/* Rubber-band selection box */}
      <SelectionBox
        containerEl={containerRef.current}
        contentEl={contentRef.current}
        onSelectionChange={handleSelectionBoxChange}
        isActive={toolMode === 'select'}
      />

      {/* Snap guides overlay */}
      <SnapGuidesOverlay />

      {/* Toolbar drag ghost — canvas-space inside transform, fixed when outside */}
      <ToolbarGhost />

      {/* Component breadcrumb (visible when editing inside a component) */}
      <ComponentBreadcrumb />

      {/* Slug-page breadcrumb (visible on CMS `[slug]` detail pages) — shows
          the collection + a searchable item dropdown to switch the previewed
          record. Self-gates internally. */}
      <SlugPageBreadcrumb />

      {/* Add Variant button — only shows on component master files when
          a variant root is selected. Self-gates internally. Hidden for
          viewers (variant authoring is an edit). */}
      {!isViewer && <AddVariantUI />}

      {/* Add Vector button — only shows on icon-set master files when a
          vector is selected. Separate from AddVariantUI so each system
          stays focused. Self-gates internally. */}
      {!isViewer && <AddVectorUI />}

      {/* Connection arrows between variant blocks — kept for viewers so
          the variant transition graph stays legible for inspection. */}
      <ArrowConnectors />

      {/* Motion path editing overlay */}

      {/* Connection handle (drag from variant to variant) — hidden for
          viewers since creating connections is an edit, and hidden while
          editing a text node (it overlaps the caret + would fight selection). */}
      {!isViewer && !isTextEditing && (
        <ConnectionHandle
          onConnectionCreated={(from, to, mousePos, sourceNodeId) => {
            setConnectionModal({ from, to, position: mousePos, sourceNodeId });
          }}
        />
      )}

      {/* Slot connection handle — drag a canvas node into a code-component
          slot (LensBox etc.). Editor-only, like the variant handle. */}
      {!isViewer && <SlotConnectionHandle />}

      {/* Persistent connector arrows for established slot connections. */}
      {!isViewer && <SlotConnectors />}

      {/* Connection type modal */}
      {connectionModal && (
        <ConnectionTypeModal
          from={connectionModal.from}
          to={connectionModal.to}
          position={connectionModal.position}
          sourceNodeId={connectionModal.sourceNodeId}
          onClose={() => setConnectionModal(null)}
        />
      )}

      {/* OS file + browser image-URL drop handler (upload to R2 → drop as
          a frame with a background-image fill). Editor-only: viewers can't
          upload, so its window listeners + drop indicator stay unmounted. */}
      {!isViewer && <CanvasFileDrop />}

      {/* Context menu */}
      <ContextMenu />

      {/* Live Code component renderer */}
      <CodeComponentHost />

      {/* Add viewport dropdown */}
      <AddViewportMenu
        menu={addVpMenu}
        existingVpIds={activeViewports.map(v => v.id)}
        onAdd={(vpId, label, width) => addViewport({
          vpId, label, width,
          sourceVpId: addVpMenu.sourceVpId,
          activeViewports, vpWidths, vpPositions, activeFilePath,
          setVpConfigs, setViewportWidths, setVpPositions,
        })}
        onClose={() => setAddVpMenu({ show: false, sourceVpId: '', x: 0, y: 0 })}
      />
    </div>
    </div>
  );
}