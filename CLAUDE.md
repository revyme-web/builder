# Revyme — Development Rules

## Post-Message Checklist (DO THIS AFTER EVERY MESSAGE)
After completing any task, ALWAYS run through this checklist:
1. **Duplicates** — Does the new code duplicate logic that exists elsewhere? Consolidate into shared utils.
2. **Tests** — Does the new/changed code have tests? If not, write them. Run `npm test` to verify all pass.
3. **Debug traces** — Does every new/changed file have `trace.action`/`trace.fn`/`trace.error` calls for ALL significant operations?
4. **Integration review** — Run through the review checklist in `CONTRIBUTING.md`. Does the new code use shared helpers? Does it create new shared patterns that need extracting? Does the rest of the system need to adapt?

## Debug Traces — NEVER REMOVE
Every file we create or modify MUST include debug traces (`trace.action`, `trace.fn`, `trace.dom`, `trace.error`) for ALL significant operations — state changes, DOM updates, lifecycle events, jotai atom updates, callbacks. The debug system must capture EVERYTHING so we can diagnose issues from the trace alone.

**NEVER remove or simplify existing debug traces.** More data = easier debugging. Always ADD traces, never remove them. Include all relevant data (node IDs, positions, counts, flags, DOM connection state).

## No Duplicated Code
Before writing any new code, check that the same logic doesn't already exist elsewhere. For popup row buttons use `ControlActionRow` from `editor/controls/`. For × close buttons use `RemoveButton`. For color preview squares use `ColorSwatch`. Use centralized helpers:
- `src/canvas/node-ops.ts` — **Bridge-first canvas access.** Primary APIs: `findNodeRect(nodeId, vpId)`, `findNodeSize()`, `findNodeParentInnerSize()`, `findNodeComputedStyle()`, `findNodeComputedStyles()`, `findChildRects()`, `patchNodeStyles()`, `patchElementStyles()`. Also: imperative mutations (create/remove/update/move/reorder), **canvas CSS injection** (`injectCanvasCSS`, `removeCanvasCSS`, `getOrCreateCanvasStyleEl`), `getActiveFilePath()`. Parent-frame-only DOM lookups live behind honest names (`findParentFrameElement`); all canvas geometry goes through the bridge caches.
- `src/canvas/canvas-bridge.ts` — `CanvasBridge` interface, `DirectBridge` (fallback), `PostMessageBridge` (iframe), `getCanvasBridge()` singleton. Bridge methods: `getRect`, `getChildRects`, `getComputedValue`, `getComputedValues`, `getContainerRect`, `getElementIdsAtPoint`, `patchStyles`, `injectCSS`, `removeCSS`. **All canvas DOM reads go through bridge helpers in node-ops.ts.** The bridge also provides `rectCache` (sync rect polling), `computedCache` (prefetched computed styles), and `cornersCache` (rotated element corners) for 60fps operations.
- `src/canvas/canvas-math.ts` — coordinate space conversions, rect math. **Bridge-aware functions** (use these): `getAbsoluteCanvasRectById()`, `getParentCanvasOffsetById()`, `screenToParentById()`, `absoluteToRelativeById()`. **Deprecated** (still present): `getAbsoluteCanvasRect(el)`, `getParentCanvasOffset(el)`, `screenToParent(el)`, `getElementScreenRect(el)`, `getCombinedParentTransformMatrix(el)`.
- `src/canvas/transform/CameraCommands.ts` — `zoomToFit(contentEl, instant?)`, `zoomToSelection()`, `setCanvasInsets()`, `panToNode()`. Uses container-relative coords (not window-relative) for proper centering between sidebars
- `src/canvas/resize/geometry-utils.ts` — **Bridge-aware**: `getScreenCornersById(nodeId, vpId)` (reads from `cornersCache`), `getElementRotationById()`, `cornersFromRect()`, `cornersEqual()`, `zeroCrossing()`. **Deprecated** (still present): `getScreenCorners(el)`, `elementOrAncestorHasRotationOrSkew(el)`.
- `src/shared/css-utils.ts` — camelCase↔kebab, style parsing, htmlToJSX
- `src/shared/dom-utils.ts` — createElement helper, drag listeners, getStyleNum
- `src/shared/position-utils.ts` — visual stability engine, pin/inset conversions, `resolveComputedPx()` (any CSS value → px), `resolveDimensionsToPx()` (element width/height → px + clear flex), `convertChildToRelative()` / `convertChildToAbsolute()` (layout toggle)
- `src/code/parsing/ast-utils.ts` — parseJSX, findElementByDataId, findAttribute
- `src/canvas/commands.ts` — high-level user commands (select parent/children/siblings, delete, wrap, unfold, lock, hide)
- `src/code/project/project-fs.ts` — ProjectFS interface, InMemoryProjectFS, project file management
- `src/code/mutation/mutation-queue.ts` — `queueMutation()`, `flushNow()`, `setForceRender()` (forces full Renderer rebuild on next flush, used by non-canvas-initiated changes like JSON editor), `consumeForceRender()`, `syncImports()` (auto-manages React/framer-motion/next imports)
- `src/code/project/modify-file.ts` — `modifyProjectFile()` (safe read-modify-write with auto-flush, ALWAYS use this for read→modify→write)
- `src/code/project/active-file-store.ts` — active file tracking, page CRUD, file display names (`getFileDisplayName()` uses `parseComponentName` for `@name` annotation), `isLayoutFile()`, `getLayoutForPage()`, `getLayoutClientPath()`, `isSparkFilePath()`, `createRouteGroup()`, `getRouteGroup()`, `listRouteGroups()`, `movePageFile()`
- `src/code/project/canvas-config.ts` — `parseCanvasConfig()`, `serializeCanvasConfig()`, `updateCanvasConfigInCode()`, `stripCanvasConfig()` for per-page `/** @canvas { ... } */` viewport config
- `src/code/components/controls-parser.ts` — `parseSparkMetadata()`, `hasSparkControls()` for Spark `@controls`/`@label`/`@comment` annotations
- `src/code/generation/metadata-gen.ts` — `ensureLayoutFile()` (server shell), `ensureLayoutClientFile()` (client wrapper), metadata/siteConfig parse+update
- `src/code/components/component-ops.ts` — make/detach component (extract nodes to .tsx file). Instance tag gets `data-id` + `data-name`. Component root gets `{ style }` prop with `...style` spread at end. `parseComponentName(code)` reads `@name` annotation from code string, `getComponentDisplayName(filePath)` reads from file. Random PascalCase internal names via `generateInternalName()`.
- `src/code/features/variable-ops.ts` — create/remove variables (extract inline values to props)
- `src/code/stores/container-query-store.ts` — parse @media CSS responsive overrides, override detection helpers (source uses @media, canvas transforms to @container at render time)
- `src/code/components/import-resolver.ts` — resolve import paths to ProjectFS file paths
- `src/code/components/component-registry.ts` — scan component files, extract props/defaults
- `src/editor/tools/grid-helpers.ts` — `parseTrackList()`, `formatTrackList()`, `parseTrack()`, `parseAutoTrack()`, `formatAutoTrack()`, `parsePlacement()`, `formatPlacement()`, `parseSpan()`, `formatSpan()`, `TRACK_UNIT_OPTIONS` for CSS grid parsing/formatting
- `src/shared/flex-helpers.ts` — `parseFlex()`, `formatFlex()`, `isFillMode()`, `getFillMultiplier()`, `makeFillFlex()`, `canUseFill()`, `isMainAxis()` for CSS flex shorthand parsing/formatting
- `src/editor/controls/ControlProvider.tsx` — centralized control context (value source, write routing, overrides, `parentLayout`, `parentFlexDirection`)
- `src/editor/controls/control-registry.ts` — `resolveControl(property)`: CSS property → control type (numeric/select/custom). Used by StyleField and ComponentPropsTool.
- `src/editor/controls/css-property-options.ts` — CSS enum options + `getAlignOptions(dir)` / `getJustifyOptions(dir)` direction-aware helpers + `SELF_ALIGN_OPTIONS` (shared flex/grid child align-self options)
- `src/canvas/drag/reparent-utils.ts` — `calculateLayoutInsertIndexById()` (bridge-aware), `computeLayoutInsertOrderUpdates()`, `computeReorderAssignments()`, `applyLayoutEdgeMagnet()`.
- `src/canvas/drag/replica-context.ts` — `getReplicaContext(vpId, filePath, vpWidths)`: builds a `ReplicaContext` with 5 routing methods: `hideInThis`, `hideInAllOthers`, `styleUpdate`, `exitToCanvas`, `deleteUpdate`. Encapsulates all 4 routing combinations (page/component × primary/replica) for style writes, hides, and deletes.
- `src/canvas/drag/types.ts` — `detectParentLayoutById()`, `getFlexDirectionById()` (bridge-aware), DragStrategy interface, DragContext.
- `src/shared/constants.ts` — `FRAME_TAGS`, `TEXT_TAGS`, `canAcceptChildren(tag)` for element type classification
- `src/code/project/active-file-store.ts` — `switchActiveFile()` (safe file switching with queue flush + selection clear)
- `src/design-system/Modal.tsx` — reusable modal shell (portal, backdrop, Escape close)
- `src/editor/ui/ToolPopup.tsx` — floating popup with sliding panel navigation (pushPanel/popPanel). Context: `useToolPopup()` / `useToolPopupOptional()`
- `src/editor/ui/VariableModal.tsx` — variable create/manage modal with default value controls via control-registry
- `src/editor/ui/ColorPicker.tsx` — full custom color picker (saturation square, hue/alpha sliders, HEX/RGB/HSL, eyedropper)
- `src/editor/ui/color-utils.ts` — color conversion utilities (hexToRgb, rgbToHsv, hsvToRgb, parseColor, formatColor)
- `src/editor/controls/ColorInput.tsx` — color swatch+value button, opens ColorPicker in ToolPopup or sliding panel
- `src/editor/hooks/useTextStyles.ts` — `useTextStyles()`: selection-aware text style read/write (TipTap edit mode vs node styles)
- `src/shared/css-utils.ts` — `jsxStyleToHTML()` (JSX→HTML style conversion), `htmlToJSX()`, `toKebab()`/`toCamel()`, `splitStyleProps()` (parenthesis-aware comma splitting)
- `src/shared/constants.ts` — `FRAME_TAGS`, `TEXT_TAGS`, `MEDIA_TAGS`, `isFrameTag()`, `isTextTag()`, `MAP_TEMPLATE_COLOR` for element type classification + map system constants
- `src/shared/gradient-utils.ts` — `parseGradient()`, `formatGradient()`, `createDefaultGradient()` for CSS gradient parsing/formatting
- `src/shared/mask-utils.ts` — `parseMaskEntries()`, `formatMaskEntries()`, `detectMaskType()`, `maskStopFill()` for CSS mask parsing/formatting
- `src/code/stores/gradient-store.ts` — `activeGradientAtom`, `isMaskGradientAtom`, stop/callback atoms for gradient overlay
- `src/editor/ui/shadow-utils.ts` — `parseShadowEntries()`, `formatShadowEntries()`, `extractNonShadowFilter()`, `mergeFilterWithDropShadows()` for multi-layer box-shadow + drop-shadow parsing/formatting
- `src/shared/clippath-utils.ts` — `parseClipPath()`, `formatClipPath()`, `CLIPPATH_PRESETS`, `CSSVal` type for clip-path parsing/formatting with unit preservation (% and px)
- `src/code/stores/clippath-store.ts` — `activeClipPathAtom`, `clipPathUpdateCallbackAtom` for clip-path overlay communication
- `src/shared/svg-path/svg-path-parser.ts` — `parseSvgPath()`: tokenize SVG path `d` attribute into command arrays (all M/L/H/V/C/S/Q/T/A/Z commands)
- `src/shared/svg-path/svg-path-model.ts` — `SvgPath`, `SvgItem`, `SvgPoint`, `SvgControlPoint`: mutable SVG path data model with insert/delete/changeType/setLocation/translate + `dToElementAttrs()`
- `src/code/stores/shape-edit-store.ts` — `shapeEditingIdAtom`, `selectedPointAtom`, `shapeEditCallbackAtom` for SVG shape edit mode
- `src/canvas/creators/ShapeCreator.ts` — `startShapeCreation()` for draw-to-create SVG shapes (path/pen creation is internal)
- `src/shared/constants.ts` — `SVG_SHAPE_TAGS`, `isSvgTag()` for SVG element type classification (alongside `FRAME_TAGS`, `TEXT_TAGS`)
- `src/code/variants/connection-config.ts` — `parseConnections()`, `addConnection()`, `removeConnection()` for variant state transitions. Trigger types: `click`, `clickStart`, `mouseEnter`, `mouseLeave`, `inView`. Code generation: `generateConnectionCode()` creates `useState(initialVariant)`, event handlers, `useEffect` chains for inView
- `src/code/variants/variant-config.ts` — `parseVariantConfig()`, `serializeVariantConfig()`, `createDefaultVariantConfig()` for variant metadata
- `src/code/variants/variant-ops.ts` — `addVariant()`, `removeVariant()`, `updateVariantPosition()` for variant CRUD
- `src/code/generation/generator-*.ts` — the split generator modules are canonical (the old `generator.ts` barrel was retired 2026-07; import directly from the focused module):
  - `generator-utils.ts` — `findJSXDataIdIndex`, `findTagClose`, `generate` (babel)
  - `generator-crud.ts` — `addNodeInCode` (auto motion.* + layout for component files), `addCanvasNodeInCode` (append/create canvasNodes fragment), `moveNodeInCode` (canvasNode flag routes to fragment), `reorderNodeInCode`, `removeNodeInCode`, `updateNodeInCode`, `updateNodeTextInCode`, `updateNodeChildrenFromHTML`
  - `generator-styles.ts` — `updateVariantStyleInCode` (writes to variant objects + ensures default has base values; canvas-only props `left`/`top`/`position` stripped from root variant entries; numeric `order`/`opacity`/`scale` written without quotes), `setConditionalOrderInCode` (FLIP reorder via ternary in style), `updateContainerQueryStyle`, `clearContainerStylesForNode`, `updateBorderOverlayStyle`, `updateHoverStyleInCode`, `updatePseudoStyleInCode`, `setSmoothScrollInCode`
  - `generator-attrs.ts` — `updateHtmlAttrsInCode`, `changeTagInCode`, `updateSvgAttrsInCode`, `addSvgChildInCode`, `removeSvgChildInCode`
  - `generator-motion.ts` — `updateMotionConfigTransition`, `updateVariantEntryTransition`, `updateKeyframesInCode`, `updateMotionPropInCode`, `updateScrollAnimInCode` (useScroll + useTransform + useMotionTemplate), `removeScrollAnimFromCode`
- `src/code/stores/viewport-store.ts` — `viewportsConfigAtom` (dynamic viewport list), `viewportWidthsAtom`, `viewportPositionsAtom`, `getSortedBreakpointWidths()`
- `src/canvas/ui/AddViewportMenu.tsx` — viewport breakpoint picker (device presets + custom), triggered from viewport header `+` button
- `src/code/project/modify-file.ts` — `modifyProjectFile()` + `setBumpVersion()` (must be wired from Canvas.tsx for atom propagation)
- `src/editor/controls/ControlActionRow.tsx` — `ControlActionRow` for popup row buttons (replaces raw 17-occurrence className pattern)
- `src/editor/controls/RemoveButton.tsx` — `RemoveButton` for × close buttons (replaces 9-occurrence pattern)
- `src/editor/controls/ColorSwatch.tsx` — `ColorSwatch` for color/gradient preview squares with `sm`/`md` sizes
- `src/editor/controls/unified/ControlProvider.tsx` — `UnifiedControlProvider(property, defaultValue, mode, ...)`, `resolveValue()`, `resolveBinding()` for mode-aware control contexts
- `src/editor/controls/unified/UsedByRow.tsx` — `UsedByRow`, `consumeAnchorOverride()` for "Used by X" binding display
- `src/editor/controls/unified/types.ts` — `ControlMode`, `ControlBinding`, `AtomProps` types
- `src/editor/tools/StylesTool/atoms/` — individual ToolAtom controls (OpacityControl, RadiusControl, FillControl, BorderControl, etc.)
- `src/editor/hooks/useScrollBoundProps.ts` — `useScrollBoundProps()`, `getScrollBoundProps()` for detecting scroll-bound properties
- `src/shared/animation-utils.ts` — `parseTransitionConfig()`, `formatTransitionConfig()`, `transitionSummary()` for animation transition parsing
- `src/code/parsing/scroll-parser.ts` — `parseScrollHooks()`, `getScrollDataForNode()` for scroll animation detection
- `src/code/stores/animation-store.ts` — `keyframesAtom`, `keyframeNamesAtom`, `keyframesBumpAtom`, `textAnimCallsAtom`, `scrollAnimDataAtom`, `cssHoverStylesAtom`, `activeKeyframeSheetAtom`, `selectedKeyframeStopAtom`, `isPickingAnimTargetAtom` for animation state
- `src/editor/tools/AnimationTool/motion/MotionPropsEditor.tsx` — shared ToolAtom-based editor for animation properties with preview + Add Property
- `src/editor/controls/css-property-options.ts` — `YES_NO_OPTIONS`, `OVERFLOW_OPTIONS`, `getCSSPropertyOptions(property)` for shared option arrays
- `src/editor/tools/typography-utils.ts` — `groupTypoTokens()`, `getTypoTokenValue()`, `detectActivePreset()`, `createDefaultTypoTokens()`, `TYPO_SUFFIXES`, `RESPONSIVE_PROPS` for typography preset token grouping/detection
- `src/editor/tools/TextStyleTool/atoms/decoration-helpers.ts` — `parseDecoShorthand()`, `formatDecoShorthand()` for CSS text-decoration shorthand parsing (handles legacy pipe format)
- `src/code/generation/preset-gen.ts` — `parsePresetTokens()`, `serializePresetTokens()`, `addPresetTokenToCSS()`, `updatePresetTokenInCSS()`, `removePresetTokenFromCSS()` for tokens.css CRUD
- `src/code/project/preset-ops.ts` — `getPresetTokens()`, `refreshCanvasTokens()` for reading/refreshing design tokens
- `src/canvas/Renderer.ts` — `shouldUseInnerHTML()`: determines if node textContent should use innerHTML (excludes SVG nodes to prevent shape duplication); `positionOverlayInPortal()`: positions overlay relative to trigger in viewport-local coords
- `src/code/parsing/overlay-parser.ts` — `parseOverlayCalls()`, `parseOverlayTriggerCalls()`, `getOverlayPairs()`, `getOverlayForNode()`, `getTriggerForNode()` for overlay/trigger attribute detection
- `src/code/generation/overlay-gen.ts` — `createOverlayInCode()`, `updateOverlayPositionInCode()`, `updateOverlayTriggerInCode()`, `removeOverlayInCode()` for overlay code generation
- `src/code/stores/overlay-store.ts` — `overlayEditingIdAtom` (overlay mode state), `overlayCallsAtom`, `overlayTriggerCallsAtom` (parsed from code)
- `src/canvas/drag/strategies/OverlayDragStrategy.ts` — drag handler for overlay nodes (offset-based, syncs replicas)
- `src/editor/tools/OverlayTool.tsx` — overlay management UI (create/configure overlays, overlay mode CSS)
- `src/code/generation/map-gen.ts` — `makeIntoMapInCode()`, `addMapItemInCode()`, `removeMapItemInCode()`, `updateMapItemInCode()`, `addMapFieldInCode()`, `bindStyleToMapInCode()`, `bindPropToMapInCode()`, `propagateToGhosts()` for inline .map() repeater code generation
- `src/code/generation/fit-text-gen.ts` — `calculateFitViewBox()` (binary search for FIT text optimal size), `wrapInFitSVGInCode()` (wrap text in SVG foreignObject), `unwrapFitSVGInCode()` (restore original text element)
- `src/canvas/node-ops.ts` — `redirectToFitTextWrapper()` (redirect clicks on FIT text children to SVG wrapper)
- `src/canvas/ui/arrow-path.ts` — `computeArrowPath()`, `generateSteppedPath()`, `getClosestEdgeCenterFromQuad()` shared arrow connector geometry (used by ArrowConnectors + MapGhostOverlay)
- `src/canvas/hooks/usePolledValue.ts` — `usePolledValue(enabled, compute, deps, {immediate, resetKey})` shared RAF-poll-into-state hook (HoverHighlight/ParentHighlight/ConnectionHandle/SlotConnectionHandle)
- `src/canvas/hooks/useRafForceRenderTick.ts` — `useRafForceRenderTick()` drag-scoped RAF re-render pump (`tick`/`start`/`stop`; GapHandles + PaddingHandles)
- `src/canvas/hooks/useModifierKeys.ts` — `useModifierKeys()` Alt/Ctrl(Meta) key tracking with blur reset (Dimensions/DistanceIndicators)
- `src/canvas/node-ops.ts` — `parseRectCacheKey(key)` splits a bridge rect-cache key (`${vpPrefix}:${nodeId}`) — never hand-roll the indexOf(':')/slice pair
- `src/canvas-sandbox/sandbox-dom-utils.ts` — `findElByNodeId(root, vpPrefix, nodeId)`, `findAllByNodeId()`, `nodeIdSelector()`, `cssEscape()` — sandbox-side node lookups (never inline `querySelector('[data-node-id="..."]')`)
- `src/canvas/ui/AddEntryUI.tsx` — shared "+ entry" card skeleton: `AddEntryCard`, `useAddEntryPlacement` (RAF placement poll + overlap scan), `scanPastRects`, `whenNodeRectReady` (AddVariantUI + AddVectorUI)
- `src/code/stores/store.ts` — `isMapTemplateSelectedAtom` for detecting when the selected node is inside a .map() template, `isComponentInstanceInCache(nodeId)` for detecting component instances, `isComponentSelectedAtom` for purple accent on component selection/pages
- `src/code/parsing/parser.ts` — `CanvasNode` type includes `attrBindings`, `styleBindings`, `propBindings`, `inlineMapData` fields for .map() repeater binding metadata
- `src/shared/types.ts` — `NodeMap` re-export (uses `CanvasNode` from parser.ts)
- `src/shared/insert-items/` — Insert element registry shared with canvas (ToolbarGhost/ToolbarDragStrategy): data (`element-data.ts`), icons (`element-icons.tsx`, `category-icons.tsx`, `creative-preview-icons.tsx`, `cms-field-glyphs.tsx`), lookup (`insert-item-lookup.ts`), `icon-style-utils.ts`. Panel UI stays in `src/editor/left-toolbar/panels/insert/` (`index.tsx`, `IconPanel.tsx`)
- `src/shared/id-utils.ts` — `nodeIdToVarName()`/`nodeIdToVarNameCapitalised()` (canonical nodeId→JS-identifier formula) + `generateNodeId(prefix)` (the unique-ID factory every creation path shares — moved from creator-utils)
- `src/shared/pin-utils.ts` — position pin/inset helpers (moved from editor/tools/PositionTool)
- `src/shared/svg-geometry.ts` — SVG scale/geometry math (was `canvas/resize/scale-geometry.ts`; consumed by canvas, code/svg, generator-attrs, and the sandbox)
- `src/shared/math-utils.ts` — `clamp()` (leaf; canvas-math re-exports it)
- `src/shared/hash-utils.ts` — shared hashing helpers
- `src/code/project/name-gen.ts` — `generateSyllableName()` random readable names
- `src/code/parsing/parse-utils.ts` — shared parse helpers (`findMatchingParen()` etc.)
- `src/code/project/file-path-kind.ts` — pure path-kind predicates (`isComponentFilePath`, `isTemplateFilePath`, `isComponentLikeFilePath`, `isIconSetFilePath`); re-exported by active-file-store (leaf so canvas/node-ops can import them without a cycle)
- `src/code/stores/` also hosts cross-layer UI atoms: `left-panel-store.ts` (`leftPanelAtom`/`togglePanelAtom`), `component-editor-store.ts` (`componentEditorFileAtom` + props/streaming), `palette-store.ts` (`paletteOpenAtom`/`paletteQueryAtom` — the editor-internal palette atoms stay in `editor/command-palette/palette-store.ts`), `cms-editor-store.ts` (CMS editor overlay open/collection/item/field atoms)
- `src/code/oracle/` — the AI output constraint engine (28 files): tiered rule checks (`check-file.ts`) that gate AI-submitted files before they reach the project
- `src/editor/ui/SearchableDropdown.tsx` — shared searchable dropdown; `src/editor/ui/ChatShell.tsx` — shared chat panel shell (PageChat/ComponentChat/PluginChat)
- `src/editor/left-toolbar/panels/LibraryPanel/shared/` — LibraryPanel shared chrome/hooks (`SectionChrome`, `useLibraryMultiSelect`, folder CRUD, drag)

## Hooks Conventions
- `src/canvas/hooks/` — canvas-side hooks (`useCanvasTransform`, `useRendererSync`, `useSandboxBridge`, `usePolledValue`, `useRafForceRenderTick`, `useModifierKeys`, …). Canvas.tsx logic extracts here, one hook per file, camelCase `useXxx.ts`.
- `src/editor/hooks/` — editor-side hooks (`useTextStyles`, `useLivePreview`, `useEditorPanel`, `useDebouncedCallback`, `useAnchoredMenu`, `useClickOutside`, …). Same naming convention.

## Hook-Injection Anchor Strategies (code generation)
Generated hooks/consts are injected into user components via TWO anchor strategies — pick the one the surrounding generator already uses:
- `RENDER_RETURN_RE` (`generator-utils.ts`) — anchors at the component's `return (<…` line; used to insert hook calls just before the JSX return.
- `insertConstIntoEnclosingFn` (`generator-utils.ts`) — walks up to the enclosing function body start; used when the const must be in scope for an arbitrary JSX expression deep in the tree.

## Cross-Bundle Shared Modules
The canvas sandbox bundle (`src/canvas-sandbox/`) imports parent-side modules beyond `canvas/Renderer`: `canvas/resize/geometry-utils`, `shared/svg-geometry`, code-component runtime, slot-children, and the TipTap extensions. Changes to those files affect BOTH bundles — keep them free of editor-only imports (vite.sandbox.config's `sandboxStubsPlugin` aliases `canvas/canvas-bridge`, `canvas/node-ops`, `code/stores/store`, `code/project/project-fs`, `code/project/cms-ops` to `canvas-sandbox/stubs/*`, so those stubs' exports must mirror the real modules).

## Code-First Drag Architecture
Drag entry/exit (viewport reparenting) commits mutations **immediately** via `flushNow()` inside strategies, not deferred to mouseUp. The Renderer patches elements in place via `patchElement` (no destruction). Only `el.style.left/top` is DOM-only (60fps position updates during drag). No manual replica management — no `hideReplicasForDrag`/`restoreReplicasAfterDrag`, no `querySelectorAll` replica sync, no `deferredUpdates` in DragCoordinator. Strategy switches are clean: old strategy commits, new starts fresh.

## Iframe Bridge Architecture — All Canvas DOM Access Goes Through Bridge
Canvas content renders inside a sandboxed iframe. The parent frame (editor, tools, drag/resize) NEVER directly queries or manipulates canvas DOM elements. Instead, all reads and writes go through the bridge:

**Read APIs (node-ops.ts wrappers around bridge):**
- `findNodeRect(nodeId, vpId)` — element bounding rect (sync, from `rectCache`)
- `findNodeSize(nodeId, vpId)` — width/height
- `findNodeParentInnerSize(parentId, vpId)` — parent content area (minus padding)
- `findNodeComputedStyle(nodeId, vpId, prop)` — single computed property (sync, from `computedCache`)
- `findNodeComputedStyles(nodeId, vpId, props[])` — multiple computed properties
- `findChildRects(parentId, vpId)` — all child IDs + rects

**Write APIs:**
- `patchNodeStyles(contentEl, nodeId, vpPrefix, styles)` — patches inline styles via bridge
- `patchElementStyles(el, styles)` — direct DOM style patch (parent-frame elements only)
- `injectCanvasCSS(selector, cssBody)` / `removeCanvasCSS(selector)` — canvas `<style>` rules

**60fps Sync Caches (for RAF polling during drag/resize/selection):**
- `rectCache` + `rectUpdate` — bounding rects, updated every Renderer cycle
- `computedCache` + `computedUpdate` — prefetched computed styles for interaction
- `cornersCache` + `cornersUpdate` — rotated element screen corners

**Bridge Protocol:** `src/canvas-sandbox/protocol.ts` defines the postMessage command types. `bridge-host.ts` (parent) sends commands, `bridge-sandbox.ts` (iframe) handles them.

**Text editing** uses a parent-side overlay div positioned via `findNodeRect()`. TipTap mounts on this overlay (stays in parent frame). On commit, final HTML is sent via `setInnerHTML` bridge command.

**NEVER use** `getNodeEl()`, `findParentFrameElement()`, `el.getBoundingClientRect()`, or `getComputedStyle(el)` for canvas elements. These only work for parent-frame DOM (editor UI, overlays). All canvas element access must go through the bridge helpers listed above.

## Canvas Nodes — `const canvasNodes` JSX Fragment
Canvas workspace elements (floating frames outside viewports) are stored in `const canvasNodes = (<>...</>)` AFTER the `export default` statement, not inline in the component return. Parser detects this via AST. Generator uses string ops for CRUD (`addCanvasNodeInCode`, `updateNodeInCode`, `removeNodeInCode`, `moveNodeInCode` with `canvasNode: true`). `addNodeInCode` auto-converts to `motion.*` + `layout={true}` in component files. Children inside canvas nodes get `isCanvasNode: false`. Canvas nodes excluded from variant UI (AddVariantUI, ConnectionHandle) and variant position tracking. Old `data-canvas-node="true"` inline JSX still works (backward compat).

## Overlay System — Portal Architecture
Overlays use a standard portal pattern: rendered OUTSIDE the viewport tree to escape overflow:hidden and transforms.
- **Portal container**: sibling of viewport root inside canvas transform, z-index: 20
- **Renderer**: moves overlay elements from viewport tree to portal, always repositions from trigger
- **Overlay mode**: dedicated `<style id="overlay-mode-styles">` for show/hide + `::after` dim on viewport roots
- **Resize**: alignment-aware edge anchoring (gap axis anchors trigger-side edge, alignment axis determines center/start/end behavior)
- **Drag**: OverlayDragStrategy stores offset from trigger, not absolute position
- **Delete**: primary viewport = full remove, replica = container query hide (same as regular nodes)
- **Page switch**: clears `overlayEditingIdAtom` in `switchActiveFile()`

## Map System (.map() Repeaters) — Rules
- **Ghost copies in patchElement**: NEVER destroy+rebuild every cycle (kills SparkHost React roots). Only rebuild when item count changes.
- **SparkHost render sync**: uses `revyme:render-complete` event from Renderer — don't rely on RAF timing alone.
- **Iterator variable**: always detect from `.map()` callback parameter, never hardcode `item`.

## Component Instance Styles — Write Redirect
When editing a component instance on a page, style writes go to the **instance tag** (`<Hero style={{width: '400px'}} />`), not the component file. The expanded ID format `instanceId:componentNodeId` triggers a redirect in `updateNodeStyles()` (node-ops.ts). At parse time, `expandComponent()` merges instance styles onto the component root. The generator AST path keeps `SpreadElement` (`...style`) last in style objects.

**auto -> remove**: Setting width/height to `auto` on a component instance converts to `''` (remove property) so the master's default value passes through via the `...style` spread.

## Component Variant System — Architecture
Components support visual variants (framer-motion states). Key rules:
- **Export pattern**: `function Name() {} + export default withResponsiveProps(Name)` (never `export default function`)
- **All elements**: converted to `motion.*` at creation time for layout FLIP animations
- **LayoutGroup**: wraps component return, `MotionConfig` for transitions — both transparent in parser
- **Instance wrapper**: `display: contents` so it doesn't create a box — element lookups resolve to the first child
- **Variant styles**: go in variant objects (`const cardVariants = { default: {}, 'variant-1': { ... } }`)
- **Order reorder**: goes in inline `style` as ternary (`order: variant === 'v1' ? 1 : 0`) — NOT in variant objects (framer-motion tweens order as float). Parser stores in `conditionalStyles`.
- **Transitions**: Root default → `<MotionConfig>`, child/variant → `transition` prop or variant entry
- **Connections**: `useState(initialVariant)` + `useEffect` sync + event handlers. `initial={initialVariant}` on root.
- **Canvas rendering**: `resolveVariantStyles` merges base + variant + conditional styles per viewport. `responsiveVariantMap` maps viewport width → variant for page replicas.
- **Resize on variants**: width/height → variant object, position → `variantConfig` (x, y), `left`/`top`/`position` stripped from root variant entries

## Multi-Select — Use `selectedIdsAtom`
**`selectedIdsAtom`** (`atom<string[]>`) is the single source of truth for selection. `selectedNodeAtom` is **read-only derived** (returns first element).

- **NEVER write to `selectedNodeAtom`** — write to `selectedIdsAtom` instead
- **Operations must iterate ALL selected IDs** — delete, copy, style updates, etc.
- **ControlProvider** already applies style changes to all selected nodes
- **`deleteNode()`** accepts `string | string[]` — pass the full array

## Empty String = Remove Property
When passing `''` (empty string) as a style value, it means **delete this property** everywhere:
- **Generator**: removes the property from JSX (fast path: regex delete, AST path: splice)
- **Node cache**: `updateNodeInCache` deletes keys with empty values
- **DOM**: `applyStylesToEl` clears empty values first, then sets non-empty (two-pass, prevents shorthand/longhand conflicts)
- **Code mutations**: the style object `{ border: '1px solid red', borderTopWidth: '' }` means "set border, remove borderTopWidth"

## Injecting CSS into Canvas Style Element
Use shared helpers from `node-ops.ts` — NEVER manually create/query `<style data-canvas-styles>`:
- `injectCanvasCSS(selector, cssBody)` — inject or replace a CSS rule
- `removeCanvasCSS(selector)` — remove a CSS rule by selector
- `getOrCreateCanvasStyleEl()` — get/create the style element

## Atom Updates During Continuous Interaction (Drag/Slider)
When updating a Jotai atom that drives a canvas overlay (e.g. `activeGradientAtom`) during drag or continuous input, **NEVER use `useEffect` to sync** — it causes a double render per frame (jitter). Instead, call `setAtom(value)` directly in the same callback as `setState(value)`:
```ts
// ✅ Same callback = one React batch
setData(prev => {
  const next = { ...prev, ...updates };
  setActiveGradient(next);   // atom in same batch
  onChange(formatGradient(next));
  return next;
});

// ❌ Separate effect = two renders per frame = jitter
useEffect(() => { setActiveGradient(data); }, [data]);
```

## Modifying ProjectFS Files — ALWAYS Use `modifyProjectFile()`
**NEVER** do raw `projectFS.readFile → modify → projectFS.writeFile`. This silently loses pending mutation queue changes. Use `modifyProjectFile(filePath, code => transform(code))` instead — it auto-flushes the queue, reads fresh code, writes, and re-syncs.

Exception: read-only access (`projectFS.readFile` for parsing/display) is fine without flush.

## Tests
Every new module must have corresponding tests. Check existing test files (`*.test.ts`) and add tests for new functions. Run `npm test` to verify.
