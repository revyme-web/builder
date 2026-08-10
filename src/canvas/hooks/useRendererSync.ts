// src/canvas/hooks/useRendererSync.ts
//
// Feeds React state into getCanvasRenderer(). Owns:
//   - setSandboxReady / setInteracting / setGradientActive flag forwarding
//   - hoverSuppressUntilRef cooldown management (returned to Canvas for mouse handlers)
//   - canvasInteractingValRef sync (passed in as ref so handleMouseMove stays correct)
//   - DnD interacting forwarding to the iframe-side canvas-dnd library + bridge
//   - The main render() effect with file-switch detection (forceRender)
//   - The viewport-headers render effect (re-fires on iframeRenderTick)

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useAtomValue, useSetAtom, useAtom } from 'jotai';
import {
  nodesAtom, codeAtom, canvasInteractingAtom,
  hoveredIdAtom, hoveredNodeIdAtom, hoveredViewportIdAtom,
  selectedIdsAtom,
} from '@/code/stores/store';
import {
  activeFilePathAtom, getLayoutForPage, getLayoutClientPath,
} from '@/code/project/active-file-store';
import { extractStyleCSS } from '@/code/parsing/parser';
import { activeGradientAtom } from '@/code/stores/gradient-store';
import { dragStateOps } from '@/canvas/drag/drag-state-store';
import {
  activeLocaleAtom,
  isDefaultLocaleAtom,
  localeOverridesAtom,
  i18nConfigAtom,
} from '@/code/stores/locale-store';
import { collectionSchemasAtom, localizedCollectionDataAtom } from '@/code/stores/cms-store';
import { cmsPageMetaAtom, activePreviewItemAtom } from '@/code/stores/cms-page-store';
import {
  viewportPositionsAtom,
  interactingViewportIdAtom,
} from '@/code/stores/viewport-store';
import { applyDetailPageBindings } from '@/code/features/cms-page-bindings';
import { projectFS } from '@/code/project/project-fs';
import {
  renderViewportHeaders,
  setViewportHeadersVisible,
} from '../ViewportHeaderManager';
import { getCanvasRenderer } from '../CanvasRenderer';
import { trace } from '@/shared/debug-trace';
import type { PostMessageBridge } from '@/canvas-sandbox/bridge-host';
import type { ViewportConfig, SnapGuide, SpacingGuide } from '@/shared/types';
import type { AddViewportMenuState } from '../ui/AddViewportMenu';

export interface UseRendererSyncOptions {
  activeViewports: ViewportConfig[];
  sandboxReady: boolean;
  iframeRenderTick: number;
  vpOverlayRef: React.RefObject<HTMLDivElement | null>;
  postMessageBridgeRef: React.RefObject<PostMessageBridge | null>;
  editingNodeIdRef: React.MutableRefObject<string | null>;
  canvasInteractingValRef: React.MutableRefObject<boolean>;
  isComponentFile: boolean;
  isIconSetMaster: boolean;
  // Canvas local-state setters (useState-derived, can't re-read from atoms)
  setSnapGuides: (g: SnapGuide[]) => void;
  setSpacingGuides: (g: SpacingGuide[]) => void;
  setAddVpMenu: (s: AddViewportMenuState) => void;
  // startTextEdit / commitTextEdit are included in deps for exhaustive-deps
  // compliance even though they're not used in the body — pass them through.
  startTextEdit: unknown;
  commitTextEdit: unknown;
}

/** Leaf HOST for the renderer-sync hook. This hook subscribes to the raw
 *  `nodesAtom` + `codeAtom` on every commit — that's its JOB (shipping the
 *  fresh map to the iframe) — so hosting it inside Canvas re-rendered the
 *  entire Canvas subtree per commit. Rendering `<RendererSyncHost {...opts}
 *  hoverSuppressUntilRef={ref} />` keeps those subscriptions on this
 *  null-rendering fiber instead. The parent CREATES the hover-cooldown ref
 *  (useRef(0)) and passes it in — the hook writes cooldown timestamps into
 *  it and Canvas's mouse handlers read it, no subscription needed on either
 *  side. */
export function RendererSyncHost(
  props: UseRendererSyncOptions & { hoverSuppressUntilRef: React.MutableRefObject<number> },
): null {
  useRendererSync(props);
  return null;
}

export function useRendererSync(
  opts: UseRendererSyncOptions & { hoverSuppressUntilRef?: React.MutableRefObject<number> },
) {
  const {
    activeViewports,
    sandboxReady,
    iframeRenderTick,
    vpOverlayRef,
    postMessageBridgeRef,
    editingNodeIdRef,
    canvasInteractingValRef,
    isComponentFile,
    isIconSetMaster,
    setSnapGuides,
    setSpacingGuides,
    setAddVpMenu,
    startTextEdit,
    commitTextEdit,
  } = opts;

  // ─── Atom reads (internal — no need to thread through options) ──────────
  const nodes = useAtomValue(nodesAtom);
  // Live map for imperative click handlers registered by effects whose dep
  // arrays don't include `nodes` (viewport-header onSelect) — the closure
  // would otherwise resolve against a stale parse.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const code = useAtomValue(codeAtom);
  const [canvasInteractingVal, setCanvasInteracting] = useAtom(canvasInteractingAtom);
  const activeGradient = useAtomValue(activeGradientAtom);
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const activeLocale = useAtomValue(activeLocaleAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const i18nConfig = useAtomValue(i18nConfigAtom);
  const localeOverrides = useAtomValue(localeOverridesAtom);
  const cmsSchemas = useAtomValue(collectionSchemasAtom);
  // LOCALIZED, not raw: the canvas must show the active locale's CMS field
  // values. On the default locale this is the same Map, so nothing changes.
  const cmsData = useAtomValue(localizedCollectionDataAtom);
  const cmsPageMeta = useAtomValue(cmsPageMetaAtom);
  const previewItem = useAtomValue(activePreviewItemAtom);
  const vpPositions = useAtomValue(viewportPositionsAtom);

  const setSelectedIds = useSetAtom(selectedIdsAtom);
  const setHoveredId = useSetAtom(hoveredIdAtom);
  const setHoveredNodeId = useSetAtom(hoveredNodeIdAtom);
  const setHoveredViewport = useSetAtom(hoveredViewportIdAtom);
  const setInteractingViewport = useSetAtom(interactingViewportIdAtom);
  const setVpPositions = useSetAtom(viewportPositionsAtom);

  const renderer = getCanvasRenderer();

  // Tracks the file path that the iframe was LAST rendered for. The render
  // effect compares this to the current activeFilePath; when they diverge
  // (file switch) it routes the render through `renderer.forceRender`
  // instead of `render` so it bypasses every skip flag (canvasUpdating /
  // textEditing / gradientActive / interacting). Without this the
  // file-switch render gets suppressed by stale skip flags set in the
  // same React tick (e.g. Make Component's writeFile mutation flush) and
  // the iframe keeps showing the PREVIOUS file's render — the visible
  // "previous page leaks into the new master view" bug.
  const prevRenderedFilePathRef = useRef(activeFilePath);

  // `hoverSuppressUntilRef` extends the no-hover window past the
  // trailing edge of an interaction. The bridge cornersUpdate /
  // rectUpdate events that follow a `domOnly: true` patch arrive via
  // postMessage AFTER `setInteracting(false)` lands on the parent's
  // React tree — there's a ~1-2 frame window where the gate is open
  // but the cache is still stale. The very first pointermove after
  // mouseup hit-tests against pre-commit rects, sets `hoveredId` to
  // a wrong element, and HoverHighlight flashes on that wrong target
  // until the cache catches up. Holding the gate closed for an extra
  // 200ms after interaction ends covers the postMessage round-trip
  // with margin to spare.
  //
  // When hosted via <RendererSyncHost>, the ref is CREATED by the parent
  // (Canvas) and passed in — the internal one is the fallback for direct
  // hook callers. useRef must run unconditionally (hook rules), so create
  // then pick.
  const internalHoverSuppressRef = useRef<number>(0);
  const hoverSuppressUntilRef = opts.hoverSuppressUntilRef ?? internalHoverSuppressRef;

  // ─── Renderer flag-forwarding effects ───────────────────────────────────

  // Wire React state into the renderer. The renderer owns the bridge.render
  // call and the should-skip predicate; this component just feeds it state.
  // (Bridge wiring happens in the bridge-creation effect above.)
  useEffect(() => {
    trace.action('renderer:sandbox-ready', { sandboxReady });
    renderer.setSandboxReady(sandboxReady);
  }, [renderer, sandboxReady]);

  // `canvasInteractingAtom` only covers pan/zoom + sandbox-dnd gestures —
  // PARENT-frame element drags (DragCoordinator) publish on dragStateOps
  // instead and never set the atom. The sandbox's per-patch subtree-refresh
  // gate keys off this forwarded flag, so a big-import element drag without
  // it re-emits 500+ rects per move and the visual position trails the
  // cursor by seconds (live find 2026-07-15). Forward the OR of both.
  const elementDragActive = useSyncExternalStore(dragStateOps.subscribe, dragStateOps.get, dragStateOps.get);
  const interactingCombined = canvasInteractingVal || elementDragActive;

  useEffect(() => {
    trace.action('renderer:interacting', { canvasInteractingVal, elementDragActive });
    renderer.setInteracting(interactingCombined);
  }, [renderer, interactingCombined, canvasInteractingVal, elementDragActive]);

  useEffect(() => {
    trace.action('renderer:gradient-active', { active: !!activeGradient });
    renderer.setGradientActive(!!activeGradient);
  }, [renderer, activeGradient]);

  // Forward interacting state to the iframe-side canvas-dnd library so it
  // hides its selection / hover / handle overlays during pan + zoom — without
  // this, its overlays sit at fixed screen coordinates while the canvas
  // transforms underneath, producing the "stuck rectangle" symptom.
  // Also forward to the bridge proper so per-patch `emitSubtreeRefresh` is
  // skipped during continuous interactions — eliminates the forced-layout
  // cascade that lagged SelectionOverlay polling on big rotated containers.
  useEffect(() => {
    trace.action('renderer:bridge-interacting', { interactingCombined });
    postMessageBridgeRef.current?.setDndInteracting(interactingCombined);
  }, [postMessageBridgeRef, interactingCombined]);

  // Sync the ref + clear hover state on both edges of an interaction:
  //   - Leading edge (becomes true): clear so any pre-existing hover
  //     id (set before the drag) doesn't sit in the atom waiting to
  //     paint on mouseup.
  //   - Trailing edge (becomes false): clear AGAIN and arm the
  //     suppression cooldown, so the post-commit pointermove can't
  //     re-populate hover from a stale rectCache before the bridge
  //     events catch up.
  useEffect(() => {
    canvasInteractingValRef.current = canvasInteractingVal;
    trace.action('renderer:hover-suppress-sync', {
      canvasInteractingVal,
      suppressUntil: !canvasInteractingVal ? performance.now() + 200 : 0,
    });
    setHoveredId(null);
    setHoveredNodeId(null);
    if (!canvasInteractingVal) {
      // Trailing edge — keep hover suppressed for 200ms so the bridge
      // cache has time to receive post-commit rect/corners updates.
      hoverSuppressUntilRef.current = performance.now() + 200;
    }
  }, [canvasInteractingVal, canvasInteractingValRef, setHoveredId, setHoveredNodeId]);

  // ─── Main render effect ──────────────────────────────────────────────────
  // Render effect: a single useEffect that hands the current state to the
  // renderer and lets it decide whether to forward to the iframe. NOTE:
  // canvasInteractingVal / activeGradient / editor refs are intentionally NOT
  // in deps — those are skip conditions, not render triggers. We don't want
  // an interaction starting/ending to fire a render with stale nodes.
  useEffect(() => {
    // Skip render while text editing — TipTap mounts inside the iframe and
    // a parent-driven render would blow away its DOM. The renderer also
    // gates this via setTextEditing(true) for redundancy.
    if (editingNodeIdRef.current) return;
    const globals = projectFS.readFile('app/globals.css') || '';
    // Detect file switch — Make Component / Make Icon Set
    // / double-click instance / Library jump all flip activeFilePath. The
    // iframe MUST receive the new file's nodes; otherwise it stays on the
    // stale previous render. The regular `renderer.render()` path bails
    // on any of canvasUpdating / textEditing / gradientActive / interacting
    // — all of which can be set by an unrelated atom write that happens
    // in the same React tick as the file switch. Use `forceRender` for
    // file switches: it bypasses every skip flag (still respects
    // sandbox-ready). Without this the new master/page renders with the
    // PREVIOUS file's DOM still in the iframe.
    const isFileSwitch = prevRenderedFilePathRef.current !== activeFilePath;
    // CMS Detail-page substitution: when the active file has a
    // `/** @cmsPage { kind: 'detail' } */` annotation, the parser
    // populates `binding` / `attrBindings` / `styleBindings` on nodes
    // referencing `item.field`. We substitute those bindings here using
    // the previewed item record so the canvas shows that one item's
    // content. Switching the preview-slug navigator changes
    // `activePreviewItemAtom` and the next render picks up the swap.
    const renderNodesPayload = cmsPageMeta?.kind === 'detail' && previewItem
      ? applyDetailPageBindings(nodes, previewItem)
      : nodes;
    // Template responsive CSS: renderNodes runs in the SANDBOX where projectFS
    // is a stub, so its own fs-based LayoutClient merge reads nothing — the
    // template's @media overrides (e.g. footer-nav flex-wrap ≤1199px) never
    // reached templated-page tiles (live find 2026-07-13). Compute the
    // prefixed CSS here (real fs) and ship it, exactly like globalsCss.
    let layoutCss = '';
    if (code && !code.includes('LayoutClient') && !code.includes('RootLayout')) {
      const layoutPath = getLayoutForPage(activeFilePath);
      const clientPath = layoutPath ? getLayoutClientPath(layoutPath) : null;
      const layoutClientCode = clientPath ? projectFS.readFile(clientPath) : null;
      const rawLayoutCss = layoutClientCode ? extractStyleCSS(layoutClientCode) : '';
      if (rawLayoutCss) {
        layoutCss = rawLayoutCss.replace(/\[data-id="([^"]+)"\]/g, '[data-id="layout::$1"]');
      }
    }
    const renderInput = {
      nodes: renderNodesPayload,
      viewports: activeViewports.map(vp => ({ ...vp, ...(!isComponentFile ? (vpPositions[vp.id] || {}) : {}) })),
      code,
      css: '',
      globalsCss: globals,
      layoutCss,
      activeLocale,
      defaultLocale: isDefaultLocale ? undefined : i18nConfig?.defaultLocale,
      // Forward the in-memory locale-override map for ALL locales (default
      // included). After a node migrates to `{t('id')}`, the JSX no longer
      // carries any plain text — the canvas must apply the override even
      // in the default locale or transformed nodes render empty when you
      // switch back to EN. The map is loaded from messages/{locale}.json
      // for both default and non-default locales by the Canvas locale-
      // overrides effect above.
      localeOverrides,
      // CMS schemas + item data → iframe stub. Without this the iframe
      // sandbox sees zero items and renders the "No items in {slug}"
      // placeholder for every collection list.
      cmsCollections: {
        schemas: Object.fromEntries(cmsSchemas),
        data: Object.fromEntries(cmsData),
      },
    };
    trace.action('renderer:render', {
      isFileSwitch,
      activeFilePath,
      codeLen: code.length,
      nodeCount: nodes.size,
      viewportCount: activeViewports.length,
      isComponentFile,
      sandboxReady,
    });
    if (isFileSwitch) {
      // File switch: bypass every skip flag (textEditing / gradient /
      // interacting / canvasUpdating). Without this the iframe stays
      // on the previous file's render — the previous page's components
      // visibly bleed into a freshly-entered component master view.
      trace.action('canvas:file-switch-force-render', { activeFilePath });
      const shipped = renderer.forceRender(renderInput);
      // Mark the file as rendered ONLY when the force actually reached the
      // iframe. forceRender still drops when the sandbox is mid-(re)build —
      // marking it delivered anyway meant the next effect run took the
      // SKIPPABLE render path and, with the atoms already settled, often no
      // render at all: the iframe stayed on the previous file's DOM
      // indefinitely. Live repro: create a template right after an undo (the
      // undo's restore keeps the sandbox busy) — the template editor showed
      // the full landing page (user report 2026-07-27). Leaving the ref
      // STALE makes this self-healing: `sandboxReady` is a dep of this
      // effect, so the ready flip re-runs it, `isFileSwitch` is still true,
      // and the switch render retries until it ships.
      if (shipped) prevRenderedFilePathRef.current = activeFilePath;
    } else {
      renderer.render(renderInput);
    }

    // selectedId intentionally NOT in deps — selection visuals handled by SelectionOverlay.
    // cmsSchemas / cmsData ARE in deps so editing an item in the CMS panel
    // re-renders the canvas immediately (otherwise the panel would update
    // but ghost copies on canvas would stay stale until another mutation
    // triggered a render).
  }, [renderer, nodes, vpPositions, setSelectedIds, startTextEdit, commitTextEdit, activeLocale, localeOverrides, sandboxReady, cmsSchemas, cmsData, cmsPageMeta, previewItem, activeFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Viewport headers render effect ─────────────────────────────────────
  // Render viewport headers — separate effect so iframeRenderTick can re-fire
  // it after the iframe's first paint populates the rect cache. If folded
  // into the render effect above, iframeRenderTick would also re-trigger
  // renderer.render() and cause a feedback loop with onRenderComplete.
  useEffect(() => {
    const vpOverlay = vpOverlayRef.current;
    if (!vpOverlay) return;
    trace.action('renderer:viewport-headers', {
      isComponentFile,
      isIconSetMaster,
      viewportCount: activeViewports.length,
      iframeRenderTick,
    });
    // Master files (component variants AND icon-set vectors) don't show
    // viewport headers — variant labels live inline on the canvas, and
    // icon sets have a single anonymous master canvas.
    if (isComponentFile || isIconSetMaster) {
      vpOverlay.querySelectorAll('[data-viewport-header]').forEach(el => el.remove());
      return;
    }
    renderViewportHeaders(vpOverlay, activeViewports.map(vp => ({ ...vp, ...(vpPositions[vp.id] || {}) })), {
      onSelect: (id) => {
        // COMPONENT MASTERS have no `root` node — the header manager's
        // `'root'` fallback (variant tile containers carry no data-id)
        // selected a nonexistent id, and the Properties panel unmounted
        // entirely (user report 2026-07-29: MotionLink-root master). Resolve
        // any id missing from the map to the MASTER ROOT (first parse root)
        // so a tile-header click selects the variant root, same as the
        // Layers variant-header row.
        let resolved = id;
        const liveNodes = nodesRef.current;
        if (isComponentFile && id && !liveNodes.has(id)) {
          for (const [nid, n] of liveNodes) {
            if (!n.parentId && n.type !== 'style' && !n.isCanvasNode) { resolved = nid; break; }
          }
          trace.action('renderer:viewport-header-select-master-root', { requested: id, resolved });
        }
        setSelectedIds(resolved ? [resolved] : []);
      },
      onHover: (id, viewportId) => {
        setHoveredId(id);
        if (viewportId) setHoveredViewport(viewportId);
      },
      onInteractingViewport: (id) => setInteractingViewport(id),
      onPositionCommit: (vpId, x, y) => {
        trace.action('renderer:viewport-position-commit', { vpId, x: Math.round(x), y: Math.round(y) });
        setVpPositions(prev => ({ ...prev, [vpId]: { x: Math.round(x), y: Math.round(y) } }));
      },
      onSnapGuidesChange: setSnapGuides,
      onSpacingGuidesChange: setSpacingGuides,
      onDragStateChange: (dragging) => {
        trace.action('renderer:viewport-drag-state', { dragging });
        setCanvasInteracting(dragging);
        if (vpOverlay) setViewportHeadersVisible(vpOverlay, !dragging);
      },
      onAddViewport: (sourceVpId, x, y) => {
        trace.action('renderer:add-viewport-menu', { sourceVpId, x, y });
        setAddVpMenu({ show: true, sourceVpId, x, y });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewports, vpPositions, isComponentFile, isIconSetMaster, sandboxReady, iframeRenderTick]);

  return { hoverSuppressUntilRef };
}
