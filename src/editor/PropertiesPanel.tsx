// PropertiesPanel.tsx — Right sidebar: composes tool components.
// All tools sit inside <ControlProvider> which handles style read/write routing.

import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { selectedNodeAtom, selectedIdsAtom, mapItemIndexAtom, mapContextAtom, isMapTemplateSelectedAtom } from '../code/stores/store';
import { useNodesComputed } from '../code/stores/node-family';
import { activeFilePathAtom, isComponentFilePath, isIconSetFilePath, isPageClientFile, isPageServerFile, isDesignComponentFile, isVariantFile, isTemplateFilePath } from '../code/project/active-file-store';
import { activeEditorAtom } from '../code/stores/editor-store';
import { isDefaultLocaleAtom } from '../code/stores/locale-store';
import TranslationPanel from './tools/TranslationPanel';
import { ToolDivider } from './controls';
import { ControlProvider, useControl } from './controls/ControlProvider';
import { trace } from '@/shared/debug-trace';
import PanelErrorBoundary from '@/editor/ui/PanelErrorBoundary';
import { LocalizeGate } from './controls/localize-gate';
import SizeTool from './tools/SizeTool';
import PositionTool from './tools/PositionTool';
import MultiAlignmentControl from './tools/PositionTool/MultiAlignmentControl';
import LayoutTool, { GridChildControls } from './tools/LayoutTool';
import { resolveMultiSelectLayoutType } from './multi-select-layout';
import ComponentPropsTool from './tools/ComponentPropsTool';
import IconSetTool from './tools/IconSetTool';
import TextStyleTool from './tools/TextStyleTool';
import StylesTool from './tools/StylesTool';
import CursorTool from './tools/CursorTool';
import AccessibilityTool from './tools/AccessibilityTool';
import ScrollSectionTool from './tools/ScrollSectionTool';
import LinkTool from './tools/LinkTool';
import ExportTool from './tools/ExportTool';
import SvgShapeTool from './tools/SvgShapeTool';
import PathTool from './tools/PathTool';
import SketchTool from './tools/SketchTool';
import AnimationTool from './tools/AnimationTool';
import MapTool from './tools/MapTool';
import ImageTool from './tools/ImageTool';
import VideoTool from './tools/VideoTool';
import AudioTool from './tools/AudioTool';
import OverlayTool from './tools/OverlayTool';
import { overlayCallsAtom } from '@/code/stores/overlay-store';
import CollectionListTool from './tools/CollectionListTool';
import FormTool from './tools/FormTool';
import FormStateTool from './tools/FormStateTool';
import InputTool from './tools/InputTool';
import InteractionsTool from './tools/InteractionsTool';
import SelectionTool from './tools/SelectionTool';
import VectorContainerTool from './tools/VectorContainerTool';
import { isTextTag, isFrameTag, canAcceptChildren, isLinkTag } from '@/shared/constants';
import { shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import type { CanvasNode } from '@/code/parsing/parser';
import TemplatePicker from './TemplatePicker';
import { VariableModalHost } from './ui/VariableModalHost';

// React.memo: Canvas re-renders at every drag transition (drag-state,
// interacting-viewport, highlight state) and each one cascaded through this
// whole panel (~110ms with every tool atom, traced mid-drag on big pages).
// The panel has NO props — parent re-renders never need to propagate; its
// own atoms still re-render it when actual values change.
export default React.memo(function PropertiesPanel() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);

  // TRANSLATION MODE (non-default locale active): the whole right panel
  // becomes per-locale text areas for translatable content — and nothing
  // else (localization overhaul Phase 2).
  if (!isDefaultLocale) {
    return <TranslationPanel />;
  }

  if (!selectedId) {
    // Nothing selected → empty shell. The Template picker lives in the
    // inner panel, gated to viewport selection (root / layout::root) so
    // it's visible only when the user has a clear "I'm editing this
    // page" anchor — not in the deselected state.
    return (
      <div
        data-properties-panel
        data-tutorial="right-toolbar"
        className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] overflow-y-auto scrollbar-hide relative z-5000"
        style={{ marginTop: 52, willChange: 'transform', isolation: 'isolate' }}
      />
    );
  }

  // Multi-select: ControlProvider operates on the first selected node
  // (passes useControl() its styles for the standard tools); the
  // additional SelectionTool aggregates across ALL selected nodes for
  // batch fill editing; LayoutTool + PositionTool are hidden inside
  // PropertiesPanelInner via the isMultiSelect branch — they don't
  // generalize across heterogeneous nodes.
  const isMultiSelect = selectedIds.length > 1;

  return (
    <ControlProvider>
      <PropertiesPanelInner isMultiSelect={isMultiSelect} />
      {/* Single, stable mount for the variable manage modal — see VariableModalHost for why it lives
          here rather than inside each ControlLabel. */}
      <VariableModalHost />
    </ControlProvider>
  );
})

// ─── Helper: Find the parent collection context for a template node ────────
function findCollectionContext(node: CanvasNode, nodes: Map<string, CanvasNode>): { slug: string; itemVar: string } | null {
  // Walk up the tree to find the parent with collectionList
  let current: CanvasNode | undefined = node;
  while (current) {
    if (current.collectionList) {
      return { slug: current.collectionList.source, itemVar: current.collectionList.itemVar };
    }
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return null;
}

// ─── Map Item Navigator — sticky bar for switching between ghost clones ────
function MapItemNavigator({ node }: { node: CanvasNode }) {
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const mapContext = useAtomValue(mapContextAtom);
  const isMapTemplate = useAtomValue(isMapTemplateSelectedAtom);
  const setMapItemIndex = useSetAtom(mapItemIndexAtom);

  if (!isMapTemplate || mapItemIndex == null || !mapContext) return null;

  const totalItems = mapContext.mapData.length;
  const itemLabel = mapItemIndex === 0 ? 'Template' : `Item ${mapItemIndex}`;

  const goPrev = () => {
    if (mapItemIndex > 0) setMapItemIndex(mapItemIndex - 1);
  };
  const goNext = () => {
    if (mapItemIndex < totalItems - 1) setMapItemIndex(mapItemIndex + 1);
  };

  return (
    <div
      className="flex items-center justify-between px-3 py-1.5 border-b border-[rgba(249,115,22,0.3)]"
      style={{ backgroundColor: 'rgba(249, 115, 22, 0.15)' }}
    >
      <button
        onClick={goPrev}
        disabled={mapItemIndex <= 0}
        className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-primary)] disabled:opacity-20 hover:bg-[rgba(249,115,22,0.3)] transition-colors cursor-pointer disabled:cursor-default"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
      </button>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'rgb(249, 115, 22)' }}>
          {itemLabel}
        </span>
        <span className="text-[10px] text-[var(--text-disabled)]">
          {node.name || node.type}
        </span>
      </div>
      <button
        onClick={goNext}
        disabled={mapItemIndex >= totalItems - 1}
        className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-primary)] disabled:opacity-20 hover:bg-[rgba(249,115,22,0.3)] transition-colors cursor-pointer disabled:cursor-default"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
      </button>
    </div>
  );
}

// The CMS detail-page item navigator ("ITEM 1 / 4") used to live here as a
// sticky bar at the top of this panel. It moved to the canvas-top
// `SlugPageBreadcrumb` (standard breadcrumb + searchable item dropdown)
// so the previewed-record switcher reads as page-level chrome, not a property.
// See canvas/ui/SlugPageBreadcrumb.tsx.

// Inner component — has access to useControl()
function PropertiesPanelInner({ isMultiSelect = false }: { isMultiSelect?: boolean }) {
  const { node, styles, vpId, isReplica, vpWidth, parentLayout, updateStyle, updateMultipleStyles } = useControl();
  const activeEditor = useAtomValue(activeEditorAtom);
  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const filePath = useAtomValue(activeFilePathAtom);
  const allOverlayCalls = useAtomValue(overlayCallsAtom);

  // Live-map lookups — the panel must reflect the current parent immediately
  // when a reparent commits mid-drag (parent-layout indicator, child controls
  // for new flex/grid context, etc.). Fine-grained subscription: everything
  // that needs OTHER nodes than the selected one (FIT-wrapper child
  // resolution, svg-group child check, ancestor walks for collection/form/
  // overlay context) is grouped into ONE computed read that only re-renders
  // the panel when a RESULT actually changes — not on every map commit.
  const mapDerived = useNodesComputed((nodes) => {
    if (!node) return null;

    // FIT SVG wrapper: resolve to inner text element for tool display.
    // The SVG wrapper should show text controls (not SVG shape controls).
    const isFitSvgWrapper = node.type === 'svg' && node.id.endsWith('-svg');
    let displayNode = node;
    if (isFitSvgWrapper) {
      // Walk through foreignObject to find the inner text element
      for (const childId of node.children) {
        const child = nodes.get(childId);
        if (child?.type === 'foreignObject') {
          for (const innerId of child.children) {
            const inner = nodes.get(innerId);
            if (inner) { displayNode = inner; break; }
          }
          break;
        }
      }
    }

    // SVG group — a <svg> wrapper whose children are themselves <svg> shape
    // wrappers (see `isSvgGroup` usage below for why it swaps the tool set).
    const isSvgGroup = node.type === 'svg' && !isFitSvgWrapper && Array.isArray(node.children)
      && node.children.some((cid) => nodes.get(cid)?.type === 'svg');

    // True when this node lives inside a collection-list container (an ancestor has a
    // `collectionList`) — covers BOTH `.map()` template nodes AND siblings of the map
    // like the pagination Load More instance.
    const isInsideCollectionList = (() => {
      let cur = node.parentId ? nodes.get(node.parentId) : undefined;
      for (let depth = 0; cur && depth < 50; depth++) {
        if (cur.collectionList) return true;
        cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
      }
      return false;
    })();

    // True when an ancestor is a <form>.
    const isInsideForm = (() => {
      let cur = node.parentId ? nodes.get(node.parentId) : undefined;
      for (let depth = 0; cur && depth < 50; depth++) {
        if (cur.type === 'form') return true;
        cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
      }
      return false;
    })();

    // True when an ANCESTOR is an overlay (this node lives inside one).
    const isInsideOverlay = (() => {
      const overlayIds = new Set(allOverlayCalls.map((c) => c.overlayId));
      let cur = node.parentId ? nodes.get(node.parentId) : undefined;
      for (let depth = 0; cur && depth < 50; depth++) {
        if (overlayIds.has(cur.id)) return true;
        cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
      }
      return false;
    })();

    const collectionCtx = node.isCollectionTemplate ? findCollectionContext(node, nodes) : null;

    return { isFitSvgWrapper, displayNode, isSvgGroup, isInsideCollectionList, isInsideForm, isInsideOverlay, collectionCtx };
  }, [node, allOverlayCalls]);

  // MULTI-SELECT Layout tool. Shows when the whole selection shares a layout type
  // (all flex OR all grid) so gap / align / padding edits fan out at once — AND
  // when NO node has a layout but every one of them is a frame that could take
  // one, in which case the tool appears in its ADD (`+`) state so a single click
  // gives them all a layout. It used to disappear entirely for plain frames,
  // which is the case where bulk-adding is most useful (user request 2026-07-25).
  // Base `display` mirrors what LayoutTool itself reads.
  const multiSelectSelIds = useAtomValue(selectedIdsAtom);
  const multiSelectLayoutType = useNodesComputed((nodes) =>
    isMultiSelect
      ? resolveMultiSelectLayoutType(
        multiSelectSelIds,
        (id) => nodes.get(id)?.styles?.display ?? '',
        // `motion.div` → `div`: component files wrap every element in motion.*,
        // and FRAME_TAGS holds plain tag names.
        (id) => {
          const t = nodes.get(id)?.type ?? '';
          return canAcceptChildren(t.startsWith('motion.') ? t.slice(7) : t);
        },
      )
      : null,
    [isMultiSelect, multiSelectSelIds],
  );

  // Unresolvable selection (id not in the nodes map — e.g. a stale/foreign
  // id selected during cross-file navigation, or a `'root'` fallback on a
  // component master, which has no `root` node): render the same EMPTY SHELL
  // as the no-selection state instead of returning null. A null here
  // unmounted the ENTIRE right sidebar ("properties panel completely
  // disappears" — user report 2026-07-29, MotionLink-root master).
  if (!node || !mapDerived) {
    trace.action('properties-panel:unresolvable-selection-shell', {});
    return (
      <div
        data-properties-panel
        data-tutorial="right-toolbar"
        className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] overflow-y-auto scrollbar-hide relative z-5000"
        style={{ marginTop: 52, willChange: 'transform', isolation: 'isolate' }}
      />
    );
  }

  const { isFitSvgWrapper, displayNode, isSvgGroup, isInsideCollectionList, isInsideForm, isInsideOverlay, collectionCtx } = mapDerived;
  void collectionCtx;

  const s = styles;
  // Link is mapped to <a> by Renderer but parser keeps type='Link'.
  // Always treat Link as text — it always has text styling (font, color).
  // If Link also wraps children, it can be both text and frame.
  // MotionLink (motion.create(Link)) ALSO renders as an <a> and carries the
  // same text styling on its own style (fontSize/color/textDecoration), so a
  // MotionLink wrapping text must get the typography controls too — even though
  // it's classified as a FRAME tag (it can wrap children). Same dual nature.
  const rawType = displayNode.type;
  const isLink = isLinkTag(rawType);
  // A link that WRAPS element children is a flex container (e.g. a detached CMS card
  // link: <Link><div/><h3/></Link>), NOT a text element — text lives in `textContent`,
  // so any element child means "container". Such a link must NOT get the typography
  // tool, even though `a` is a TEXT tag. A bare text link (`<a>click</a>`, no children)
  // keeps its text controls.
  const linkIsContainer = isLink && Array.isArray(displayNode.children) && displayNode.children.length > 0;
  const isLinkType = isLink && !linkIsContainer;
  const isText = !linkIsContainer && (isTextTag(rawType) || isLinkType);
  const isFrame = isFrameTag(rawType) || linkIsContainer;
  const isSvg = node.type === 'svg' && !isFitSvgWrapper;
  // Sketch wrappers are SVGs marked with `data-sketch="true"` by the
  // SketchCreator. They share the SVG selection branch (Position +
  // Size at top) but swap SvgShapeTool's fill/stroke controls for the
  // brush/taper/easing tool tailored to perfect-freehand parameters.
  // Also match `data-name="Sketch"`: grouping a sketch strips the
  // data-sketch attr but keeps the name, so a sketch selected INSIDE a
  // group would otherwise wrongly get the SVG shape tool.
  const isSketch = isSvg && (node.attrs?.['data-sketch'] === 'true' || node.name === 'Sketch');
  // SVG group — a <svg> wrapper whose children are themselves <svg> shape
  // wrappers. Gets the focused StylesTool group panel (Opacity / Fill
  // fanned to all children / Hide / Rotate) instead of SvgShapeTool, which
  // targets a single polygon's fill+stroke and is meaningless for a group.
  // (`isSvgGroup` is computed in the map-derived subscription above.)
  const isImageElement = node.type === 'img' || node.type === 'Image' || node.type === 'motion.img';
  const isVideoElement = node.type === 'video' || node.type === 'motion.video';
  const isAudioElement = node.type === 'audio' || node.type === 'motion.audio';
  const isShapeEditing = !!shapeEditingId;
  const hasCollectionList = !!node.collectionList;
  const isCollectionTemplate = !!node.isCollectionTemplate;
  // Form tooling: the Form tool on a <form>; the Input tool on form controls.
  const isFormElement = node.type === 'form';
  const isInputElement = node.type === 'input' || node.type === 'textarea' || node.type === 'select';
  // `isInsideCollectionList` (ancestor has a `collectionList` — drives showing
  // the InteractionsTool on a component instance inside a list) and
  // `isInsideForm` (ancestor is a <form> — drives the Form State tool) are
  // computed in the map-derived subscription above.
  // The viewport frame: page root on bare pages, the layout-merged root on
  // pages with a Template. Per-element tools (Interactions, Link,
  // Animation, Cursor, Accessibility) hide here because the viewport is a
  // container — those tools target child elements.
  const isViewportFrame = node.id === 'root' || node.id === 'layout::root';
  // Templated viewport: with the template merged ONTO the page root, the
  // viewport root IS `root` but carries `fromLayout` (the template's flex
  // column). Its layout belongs to the TEMPLATE, so the Layout/Styles/Overlays
  // tools are hidden here (edit them via Template → Edit). A NON-templated
  // page's `root` has no `fromLayout`, so its tools still show.
  const isTemplatedViewport = node.id === 'root' && !!node.fromLayout;
  // Editing a Template itself (its `LayoutClient.tsx` is the active file) and
  // the template ROOT is selected → the Layout tool renders its simplified,
  // flex-column-locked form (Align / Gap / Padding). See LayoutTool.
  const isTemplateRootEdit = isTemplateFilePath(filePath) && node.id === 'root';
  // Overlay node — positioned by its trigger (side/align/offset in the Overlay
  // tool), so Position and Dimensions don't apply: the portal placement would
  // fight any manual coords, standard the panel leads with Show On/Overlay.
  const isOverlayNode = allOverlayCalls.some((c) => c.overlayId === node.id);
  // `isInsideOverlay` (an ANCESTOR is an overlay — drives showing the
  // InteractionsTool on a component INSTANCE inside a fixed/relative overlay
  // so its event props can be wired to "Close Overlay" (Increment D), e.g. a
  // design component's internal X firing `event1` to dismiss the modal) is
  // computed in the map-derived subscription above.
  // A FIXED overlay (modal) is just a full-viewport backdrop + behaviour config —
  // it has no box to size/style/lay-out/animate from the generic panels. So when
  // one is selected we collapse the ENTIRE panel to ONLY the Overlay tool (Show On
  // + Overlay), hiding Position/Dimensions/Animation/Layout/Styles/Cursor/Anchor/
  // Accessibility. (Relative overlays keep the fuller panel — their box is real.)
  const isFixedOverlay = allOverlayCalls.some((c) => c.overlayId === node.id && c.config?.type === 'fixed');
  // Icon-set instance — `node.componentFile` points at
  // `icons/X.tsx`. The instance is a leaf reference
  // to a master file; it has no DOM children of its own to lay out, no
  // animatable properties beyond what the master defines, and no
  // separate accessibility surface. Layout / Animation / Accessibility
  // panels would target the wrapper element (which the master replaces
  // via cloneElement at runtime), so anything the user set there would
  // either be discarded or fight the master's own values.
  const cf = node.componentFile;
  // Container-set instance flag covers BOTH local masters (under
  // `icons/` in projectFS) AND CDN-linked masters
  // (URLs containing `/vectors/`). The runtime
  // semantics are identical — both render via the master-component
  // cloneElement branch — so the same Layout / Animation /
  // Accessibility suppression applies to both. Without the URL check
  // a freshly-pasted CDN vector would still see Layout / Animation
  // panels even though they'd target a wrapper that gets replaced
  // at runtime.
  const isContainerSetInstance = !!cf && (
    cf.startsWith('icons/') ||
    (cf.startsWith('http') && cf.includes('/vectors/'))
  );
  // Regular component instance — `node.isComponentInstance` is set by
  // the parser on the wrapper tag itself (see `project-parser`). The
  // wrapper renders as `display: contents` at runtime so it has NO box
  // of its own (see CLAUDE.md > "Component Variant System"). Any layout
  // the user sets here would target a contents-display element — the
  // panel would offer flex/grid knobs that paint onto a non-existent
  // box. Suppress the panel so the user edits layout on the component
  // master file instead, where the layout actually has somewhere to land.
  const isComponentInstance = !!node.isComponentInstance;
  // A CODE-component instance — its `componentFile` is under `components/` but the
  // file is NOT a design component (no `variantConfig`/`@name`). Code components are
  // arbitrary user React: they don't reliably forward `data-overlay-trigger`/`{...rest}`
  // onto a DOM root, so an overlay attached here won't resolve. Hide the Overlay tool
  // for them (design-component instances keep it — they forward props to the root).
  const isCodeComponentInstance = !!cf && cf.startsWith('components/') && !isDesignComponentFile(cf);
  // A VECTOR VARIANT CARD — a direct child of `root` in an icon-set
  // master (e.g. `icon-1`). Its position/size live in iconConfig and it's a
  // pure vector container: pins/inset/alignment, Interactions, Navigation,
  // Animation, Styles etc. don't apply. Show ONLY Position (X/Y) + Size, like a
  // vector primitive but even more minimal.
  const isVectorVariantCard = isIconSetFilePath(filePath)
    && node.parentId === 'root' && isFrameTag(rawType);
  // (`collectionCtx` — the parent collection context for a template node — is
  // computed in the map-derived subscription above.)

  // Position (single-select) / MultiAlignment (multi-select) + Size cluster —
  // shared verbatim by the vector-variant-card and SVG branches below, which
  // differ only in the PositionTool's `isTopLevel` value. Plain function (not
  // a component) so the rendered element tree is unchanged.
  const positionAndSizeTools = (isTopLevel: boolean) => (
    <>
      {!isMultiSelect ? (
        <PositionTool
          nodeId={node.id}
          styles={s}
          vpId={vpId}
          isReplica={isReplica}
          vpWidth={vpWidth}
          isTopLevel={isTopLevel}
        />
      ) : (
        <MultiAlignmentControl vpId={vpId} />
      )}
      <SizeTool
        styles={s}
        nodeId={node.id}
        vpId={vpId}
        onUpdate={updateStyle}
        onUpdateMultiple={updateMultipleStyles}
      />
    </>
  );

  return (
    <div
      data-properties-panel
      data-tutorial="right-toolbar"
      className="w-[260px] shrink-0 bg-[var(--bg-surface)] border-l border-[var(--border-light)] flex flex-col relative z-5000"
      style={{ marginTop: 52, paddingLeft: '1.5px', willChange: 'transform', isolation: 'isolate' }}
      onMouseDown={(e) => {
        if (activeEditor && !(e.target instanceof HTMLSelectElement)) {
          e.preventDefault();
        }
      }}
    >
      {/* Containment: a crashing tool (update-depth loops et al) must never
          unmount the whole app — the boundary drops the panel CONTENT only
          (the shell div stays, so layout holds) and re-arms when the
          selection changes. */}
      <PanelErrorBoundary name="properties-panel" resetKey={node.id}>
      {/* ─── Fixed top: Map Navigator ───
          (The CMS detail-page "ITEM 1 / 4" item switcher moved OUT of the
          panel to the canvas-top SlugPageBreadcrumb — standard, with a
          searchable item dropdown. See canvas/ui/SlugPageBreadcrumb.tsx.) */}
      <div className="shrink-0">
        <MapItemNavigator node={node} />
      </div>

      {/* ─── Scrollable content ─── */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        {/* Small breathing room above the first section so the header divider
            doesn't kiss the topmost tool's title. Using `mb-1.5` on a spacer
            (rather than `pt-2` on the scroll container) keeps the spacing
            outside the scrollable area — it stays put even when the panel
            scrolls. */}
        <div className="mb-1.5" />

      {/* ─── Template picker — viewport selection on page files ────────────
          Shows when the user has the page's viewport-frame selected. The
          frame is ALWAYS `'root'` now: with no Template it's the bare page
          root; WITH a Template the template root is merged ONTO `'root'`
          (no separate `layout::root` layer). Hidden for child-element
          selection or empty selection so it doesn't compete with the
          per-element tools. See `TemplatePicker.tsx` + `template-ops.ts`. */}
      {(node.id === 'root' || node.id === 'layout::root')
        && (isPageClientFile(filePath) || isPageServerFile(filePath) || isVariantFile(filePath)) && (
        <>
          {/* pt-1 so the Template title sits at the same vertical offset
              from the header that the rest of the tools do — without it
              the row reads as glued to the header buttons. */}
          <div className="pt-1">
            <TemplatePicker />
          </div>
          {/* Divider matches the inter-tool spacing further down so the
              Template section reads as part of the same tool stack — not
              a floating header above it. */}
          <ToolDivider />
        </>
      )}

      {/* ─── Tools — order matches old builder ─── */}
      {/* pb-8 leaves breathing room after the Export tool so the last
          control isn't flush with the panel's bottom edge — scroll-to-end
          previously left the Export Frame button kissing the viewport
          bottom which felt cramped. */}
      <div className="flex-1 pt-1 pb-8 flex flex-col">

        {/* Shape edit mode: PathTool (Position + Curve for the selected
            anchor) appears above the rest of the SvgShapeTool, mirroring
            the reference's shape-edit panel order. PathTool auto-hides when no
            anchor is selected — ToolDivider lives inside PathTool so it
            only renders alongside the Path section, no leftover line. */}
        {isShapeEditing && (
          <>
            <PathTool />
            <SvgShapeTool />
            <ToolDivider />
          </>
        )}

        {!isShapeEditing && <>
        {/* VECTOR VARIANT CARD (icon-set card): ONLY Position
            (X/Y) + Size. `isTopLevel` renders the bare X/Y SpaceControl — no
            pins, no inset, no alignment icons, no Type dropdown — and nothing
            else (no Interactions / Navigation / Animation / Styles). It's a
            pure vector container; everything else would target a wrapper or a
            property it doesn't have. */}
        {isVectorVariantCard ? (
          /* Vector cards are shape containers — same no-localize rule as the
             SVG branch below. */
          <LocalizeGate hidden>
            {positionAndSizeTools(true)}
            {/* Fill = the card's OWN background (full-width). Selection →
                Colors = the inner SVG shapes' fills, aggregated in the
                SelectionTool list format. */}
            {!isMultiSelect && (
              <>
                <ToolDivider />
                <VectorContainerTool />
              </>
            )}
          </LocalizeGate>
        ) : isSvg ? (
          /* Shapes can't be localized — SVG presentation attrs and the
             wrapper's box have no per-locale story, so the Localize menu item
             is suppressed on EVERY control shown for a shape selection:
             Position/Dimensions, the shape Styles/Stroke sections, sketches,
             AND the group-selection StylesTool (which is only gated HERE so
             frames elsewhere keep their Localize). SvgShapeTool also gates
             internally for its shape-edit-mode render above (user request
             2026-07-24). */
          <LocalizeGate hidden>
            {positionAndSizeTools(!!node.isCanvasNode || !node.parentId)}
            <ToolDivider />
            {isSketch ? <SketchTool /> : isSvgGroup ? <StylesTool /> : <SvgShapeTool />}
            {/* Sketches get the AnimationTool too — they support a
                draw-on animation. Regular SVG primitives don't (yet),
                so they stay on the compact panel without it. */}
            {isSketch && (
              <>
                <ToolDivider />
                <AnimationTool styles={s} onUpdate={updateStyle} />
              </>
            )}
          </LocalizeGate>
        ) : isFixedOverlay ? (
          /* FIXED overlay (modal): collapse the whole panel to ONLY the Overlay
             tool — everything else is meaningless for a full-viewport backdrop. */
          <OverlayTool />
        ) : <>
        {/* When the viewport-frame itself is selected (`root` on a bare
            page, `layout::root` on a templated one), several tools don't
            apply: Interactions/Link/Animation/Cursor/Accessibility all
            target a specific element. The viewport is a layout container,
            not a styled element. Hiding them at this scope keeps the
            page-level affordance focused (Template + Position + Layout +
            Styles) and matches the reference's site-frame behaviour.

            Component instances also hide both: Interactions live in the
            master's variant graph (the instance is just a reference, not
            a place to author new transitions), and Link / Anchor target
            an element with a real box — the instance wrapper is
            `display: contents` so an `<a>` attached here doesn't wrap
            anything visible in the live DOM. Same rule for icon-set
            instances: their wrappers get cloneElement-replaced at
            runtime so an attached link / handler is dropped. */}
        {/* Overlay nodes also hide both: an overlay opens/closes via its
            trigger (Show On), so variant interactions and a nav link on the
            floating panel itself don't apply. */}
        {/* 0. Interactions (component variant connections / event fires / page
            interactions). Hidden for instances EXCEPT: (a) a component instance
            INSIDE a collection list (e.g. a Load More button → wire its Click to
            pagination); (b) a NESTED instance inside a DESIGN-COMPONENT master —
            it can be a variant-connection SOURCE (e.g. the Header's hamburger
            instance toggling the Header's open/closed variant). In a master file
            the InteractionsTool returns ComponentInteractions for EVERY node, which
            reads connections by `sourceNode === selectedId`, so the nested instance's
            connection shows + is editable. */}
        {!isViewportFrame && !isContainerSetInstance && !isMultiSelect && !isOverlayNode
          && (!isComponentInstance || isInsideCollectionList || isInsideOverlay || isDesignComponentFile(filePath)) && !isCodeComponentInstance && (
          <>
            <InteractionsTool />
            <ToolDivider />
          </>
        )}

        {/* 0b. Link + Anchor (Navigation) — single-node only (still hidden for
            instances / overlays / multi-select). Code-component instances carry
            `isCodeComponent` (not `isComponentInstance`), so gate them explicitly
            too — a code component has no links, and its own `target`/`href` controls
            would otherwise be misread as a nav link's New Tab / Link To. */}
        {!isViewportFrame && !isComponentInstance && !isCodeComponentInstance && !isContainerSetInstance && !isMultiSelect && !isOverlayNode && (
          <>
            <LinkTool />
            <ToolDivider />
          </>
        )}

        {/* 1. Position — the single-node tool (type / pins / coords) can't
            generalize across a heterogeneous group, so on multi-select we
            swap it for the alignment-only control: the same Position header
            with just the 6 align icons, wired to group-bbox math so the user
            can line the selection up. */}
        {/* Overlay selected — lead with Show On + Overlay (the reference order). Skip
            POSITION (placement is trigger-driven via Position/Align/Offset —
            manual coords would fight it), but DO show DIMENSIONS: the overlay's
            width/height are real fixed values the user edits (same as its resize
            handles; routes inline on primary / @container on a replica). */}
        {isOverlayNode && (
          <>
            <OverlayTool />
            <ToolDivider />
            <SizeTool
              styles={s}
              nodeId={node.id}
              vpId={vpId}
              onUpdate={updateStyle}
              onUpdateMultiple={updateMultipleStyles}
              pxOnly
            />
            <ToolDivider />
          </>
        )}
        {!isOverlayNode && (!isMultiSelect ? (
          <PositionTool
            nodeId={node.id}
            styles={s}
            vpId={vpId}
            isReplica={isReplica}
            vpWidth={vpWidth}
            isTopLevel={!!node.isCanvasNode || !node.parentId}
          />
        ) : (
          <MultiAlignmentControl vpId={vpId} />
        ))}

        {/* 2. Dimensions */}
        {!isOverlayNode && (
          <>
            <SizeTool
              styles={s}
              nodeId={node.id}
              vpId={vpId}
              onUpdate={updateStyle}
              onUpdateMultiple={updateMultipleStyles}
            />
            <ToolDivider />
          </>
        )}

        {/* 3. Grid Child (only when parent is grid) */}
        {parentLayout === 'grid' && (
          <>
            <GridChildControls />
            <ToolDivider />
          </>
        )}

        {/* Collection List (nodes with collectionList) — placed ABOVE Animation
            so the CMS source/filter/sort/pagination controls sit near the top of
            the panel (design-tool parity), not buried below Layout/Overlays. */}
        {hasCollectionList && (
          <>
            <CollectionListTool />
            <ToolDivider />
          </>
        )}

        {/* Form (the <form> element) — Send To / Redirect / Antispam / Tracking. */}
        {isFormElement && (
          <>
            <FormTool />
            <ToolDivider />
          </>
        )}

        {/* Input (input / textarea / select) — Type / Name / Placeholder / Required / + props. */}
        {isInputElement && (
          <>
            <InputTool />
            <ToolDivider />
          </>
        )}

        {/* 4. Animation ("Effects") — hidden on the viewport frame (no
            animatable target). Vector/icon-set instances DO get it: the user
            animates the whole vector wrapper (appear / hover / loop / scroll),
            which is a valid instance-level effect (the master-only concern is
            animating the vector's INTERNAL parts, not the wrapper). */}
        {/* The viewport/root frame gets the AnimationTool too, but restricted to
            ONLY the Glide ("Flow") effect — the one meaningful page-level animation
            (the reference puts Flow on the page). All other effects stay hidden there. */}
        <AnimationTool
          styles={s}
          onUpdate={updateStyle}
          glideOnly={isViewportFrame}
        />

        {/* Page Effects (View Transitions) live INSIDE the AnimationTool's "+"
            on a viewport (a "Page Transition" effect), not a separate section. */}

        {/* 5. Map data editor (inline .map() repeater) — before Layout */}
        <MapTool />

        {/* 5b. Layout (all elements — text nodes get Block-only mode).
            Container-set instances (icon sets) hide it: the
            instance is a leaf reference, not a layout container — the
            master defines the inner layout and the wrapper itself is
            replaced via cloneElement at runtime. Anything the user set
            here would target a wrapper that doesn't exist after render.
            Regular component instances also hide it: the parser-emitted
            wrapper renders as `display: contents` so it has no box for
            flex/grid to operate on — layout edits belong on the master
            file (`Edit Component` button in the right panel jumps there). */}
        {/* Layout tool: single-select as before, OR multi-select when every
            selected node shares the same layout type (multiSelectLayoutType) —
            edits fan out to all via ControlProvider.

            NEVER for text elements: layout is a frame concept. The text
            multi-column "Block" mode was removed (2026-08-12) — see
            detectLayoutFlags in LayoutTool for the full rationale — so a
            text node has no layout to show, and the Adjust control's
            display:flex plumbing must not surface the frame controls. */}
        {!isText && !isContainerSetInstance && !isComponentInstance && !isCodeComponentInstance && !isTemplatedViewport
          && (!isMultiSelect || multiSelectLayoutType !== null) && (
          <LayoutTool
            styles={s}
            nodeId={node.id}
            onUpdate={updateStyle}
            onUpdateMultiple={updateMultipleStyles}
            templateRoot={isTemplateRootEdit}
          />
        )}

        {/* 5c. Overlay (right under Layout — title + collapsible body, same
            shape as Animation/Layout). Overlay NODES render it at the top of
            the panel instead (see above).

            Hidden on the VIEWPORT FRAME: the tool's job is to make the
            selected node a trigger, and the only triggers that exist are
            click and hover — neither is meaningful on the page container
            itself. This used to be gated on `isTemplatedViewport`, which
            only caught the templated case, so a plain page still offered
            "add an overlay" on its root. `isViewportFrame` covers both
            (`root` and `layout::root`). */}
        {!isOverlayNode && !isCodeComponentInstance && !isViewportFrame && <OverlayTool />}

        {/* 6. Text Style (only for text elements, just before Styles) */}
        {isText && <TextStyleTool />}

        {/* The standalone "Template bindings" row was here — removed once the
            per-property menu (Bind to Field / Unbind Field) covered every
            bindable property in the panel. The dedicated row was confusing:
            it duplicated the menu's affordance and only handled text/src/href. */}

        {/* 6b. Form State — maps the enclosing form's lifecycle (loading/
            success/error/disabled) to this instance's variants. Self-gates
            to a multi-variant component instance inside a <form>. */}
        {isComponentInstance && isInsideForm && <FormStateTool />}

        {/* 7. Component Props */}
        <ComponentPropsTool />

        {/* 7a. Icon Set (only for icon-set instances — IconSetTool returns
            null when the selected node isn't pointing at an icons/*.tsx file). */}
        <IconSetTool />
        <ToolDivider />

        {/* 7b. Image source/alt (only for image elements) */}
        {isImageElement && (
          <>
            <ImageTool />
            <ToolDivider />
          </>
        )}

        {/* 7c. Video controls (only for video elements) */}
        {isVideoElement && (
          <>
            <VideoTool />
            <ToolDivider />
          </>
        )}

        {/* 7d. Audio controls (only for audio elements) */}
        {isAudioElement && (
          <>
            <AudioTool />
            <ToolDivider />
          </>
        )}

        {/* 7e. Selection (multi-select only) — aggregated fills across
            all selected nodes. Placed right above Styles so the user's
            mental model of "set the color" lands first on the
            multi-color aggregator, then on per-element overrides
            below. Returns null on single-select. */}
        {isMultiSelect && (
          <>
            <SelectionTool />
            <ToolDivider />
          </>
        )}

        {/* 8. Styles: Fill, Radius, Padding, Margin, Overflow, Opacity.
            Hidden on a templated viewport — those styles belong to the
            Template's root, not the page (edit via Template → Edit). */}
        {!isTemplatedViewport && (
          <>
            <StylesTool />
            <ToolDivider />
          </>
        )}

        {/* Cursor + Accessibility — hidden on the viewport frame. Cursor
            is a per-element CSS property; accessibility tags/labels apply
            to content elements, not the layout container. Accessibility
            is ALSO hidden on container-set instances AND on regular
            component instances — both render as a wrapper that's
            replaced / collapsed at runtime (cloneElement for sets,
            `display: contents` for components), so any aria-* / role
            attached here is dropped from or detached from the live tree.
            The master file is where a11y belongs for both. */}
        {!isViewportFrame && (
          <>
            <CursorTool />
            <ToolDivider />
            {/* Scroll Section ("Anchor" target) — above Accessibility. A page
                concept (links scroll to `#name`), so hidden on component
                masters and on the layout container. Also hidden on vector/icon
                sets: their wrapper is cloneElement-replaced at runtime, so an
                anchor id attached here is dropped. */}
            {!isComponentFilePath(filePath) && !isContainerSetInstance && (
              <>
                <ScrollSectionTool />
                <ToolDivider />
              </>
            )}
            {!isContainerSetInstance && !isComponentInstance && (
              <>
                <AccessibilityTool />
                <ToolDivider />
              </>
            )}
          </>
        )}

        {/* 11. Export */}
        <ExportTool />
        </>}
        </>}
      </div>
      </div>{/* end scrollable content */}
      </PanelErrorBoundary>
    </div>
  );
}
