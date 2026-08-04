// ControlProvider.tsx — Centralized control context for property tools.
//
// Provides: value reading, style writing (inline vs container query routing),
// responsive override detection, and future variable/token/locale awareness.
//
// Replaces the manual onUpdate/onUpdateMultiple callback threading
// that was duplicated across every tool in PropertiesPanel.

import { createContext, useContext, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
// Live nodes — the panel must show the current parent (for parentLayout /
// parentFlexDirection / parent-relative child controls) the moment a
// reparent commits mid-drag. The freeze fix lives at the parser-atom level.
// Fine-grained per-node subscriptions (useNode / useNodesComputed) replace the
// whole-map `useAtomValue(nodesAtom)` read: same live data, but the provider
// only re-renders when a node/result it actually uses changes. Callbacks read
// fresh via `getNodesSnapshot()`.
import { selectedNodeAtom, selectedIdsAtom, mapItemIndexAtom, mapContextAtom, isComponentInstanceInCache, getNodesSnapshot } from '@/code/stores/store';
import { useNode, useLiveNode, useNodesComputed } from '@/code/stores/node-family';
import { isReplicaViewportAtom, interactingViewportWidthAtom, interactingViewportIdAtom, isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { resolveParentVariantStyle } from './parent-variant-style';
import { containerOverridesAtom, getOverrideBreakpoints, hasOverrideAtWidth, getOverridesAtWidth, clearShorthandSupersededLonghands } from '@/code/stores/container-query-store';
import { isDefaultLocaleAtom, localeOverridesAtom } from '@/code/stores/locale-store';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { removeComponentPropProjectWide } from '@/code/features/remove-component-prop';
import { propagateToGhosts } from '@/code/generation/map-ghost-propagate';
import { updateNodeStyles, getContentRoot, getViewportPrefix, forceCanvasRender, parseRectCacheKey } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { makeGhostId } from '@/shared/ghost-id';
import { detectValueSource, BORDER_LONGHANDS, type ValueSource } from '@/code/features/variable-ops';
import { isComponentFileAtom } from '@/code/stores/store';
import { pageVariablesAtom } from '@/code/stores/page-variables-store';
import { defaultForType, pageVariableTypeForProperty, isConditionalDisplayProperty, conditionalBranchesFor } from '@/code/features/page-variables';
import { styleControlVariableSpec } from './control-variable-type';
import { resolveControl } from './control-registry';
import { resolveVariableEditor } from './variable-editor-registry';

// Compound shorthands → longhands that atoms write alongside them in direct
// mode but that the variable's bound shorthand should override. When the user
// creates a variable on one of these properties, the AST drops the longhands
// in the same edit so the function signature ends up with one prop instead of
// one-per-longhand. Atoms can override per call with explicit `clearLonghands`.
const AUTO_CLEAR_LONGHANDS_BY_PROPERTY: Record<string, string[]> = {
  border: BORDER_LONGHANDS,
};
import type { CanvasNode } from '@/code/parsing/parser';
import type { FieldDefinition } from '@/shared/types';
import { collectionSchemasAtom, collectionDataAtom } from '@/code/stores/cms-store';
import { cmsPageMetaAtom } from '@/code/stores/cms-page-store';
import { trace } from '@/shared/debug-trace';

// One shared reference for "this selection has no styles" — see `baseStyles`.
const EMPTY_STYLES: Record<string, string> = {};

// ─── Context ────────────────────────────────────────────────────────────────

export interface ControlContextValue {
  /** Selected node ID (null if nothing selected) */
  nodeId: string | null;
  /** Selected node data */
  node: CanvasNode | null;
  /** All node styles */
  styles: Record<string, string>;
  /** Active viewport ID */
  vpId: string;
  /** Whether editing a replica (non-primary) viewport */
  isReplica: boolean;
  /** Viewport width for container query routing */
  vpWidth: number;
  /** Parent node's layout type: 'grid', 'flex', or 'none' */
  parentLayout: 'grid' | 'flex' | 'none';
  /** Parent node's flex-direction (defaults to 'row') */
  parentFlexDirection: string;

  /** Update a single style property. Routes to inline or container query automatically. */
  updateStyle: (key: string, value: string) => void;
  /** Update multiple style properties at once. */
  updateMultipleStyles: (styles: Record<string, string>) => void;
  /** DOM-only style patch — for live drag previews (sliders, color picker
   *  swatch). Writes directly to the iframe via the bridge with NO code
   *  write, NO mutation queue, NO atom update. Use during continuous
   *  input; commit through `updateStyle` on release. */
  updateStyleLive: (key: string, value: string) => void;

  /** Check if a property has responsive overrides at any breakpoint */
  hasOverride: (property: string) => boolean;
  /** Get all responsive override breakpoints for a property */
  getOverrides: (property: string) => { maxWidth: number; value: string }[];

  /** Detect the source of a style value: 'inline', 'prop' (variable), or 'token' */
  getValueSource: (property: string) => { source: ValueSource; ref: string | null };
  /**
   * Extract an inline value into a component prop (create variable).
   * `clearLonghands` is for compound atoms (e.g. Border) that produce per-side
   * longhands the new shorthand prop should override — pass them here so the
   * AST drops them in the same edit and the function signature carries one
   * prop instead of one-per-longhand.
   */
  createVariable: (property: string, propName: string, defaultValue?: string, clearLonghands?: string[]) => void;
  /** Unbind a variable from this node (→ literal). `deleteProp` (variable-modal "delete" only)
   *  also drops the prop from the component signature; the controls-panel × keeps it. */
  removeVariable: (property: string, propName: string, defaultValue: string, deleteProp?: boolean) => void;

  /** Map item override context (null when not editing a ghost) */
  mapOverride: {
    itemIndex: number;
    itemCount: number;
    isOverridden: (property: string) => boolean;
    resetOverride: (property: string) => void;
    goToItem: (index: number | null) => void;
  } | null;

  /**
   * CMS-collection-template context. Non-null when the selected node is
   * inside a `.map()` over a CMS collection. Drives the "Bind to Field"
   * menu item and the type-filtered field picker on every property.
   */
  cmsBinding: {
    /** Collection slug, e.g. 'blog'. */
    slug: string;
    /** Iterator variable in the .map() callback, e.g. 'item'. */
    itemVar: string;
    /** Schema fields available for binding. */
    fields: FieldDefinition[];
    /** Returns the bound fieldId for a property, or null if not bound. */
    getBindingForProperty: (property: string) => string | null;
    /** Bind a property to a CMS field (replaces inline value with `{itemVar.fieldId}`). */
    bindToField: (property: string, fieldId: string) => void;
    /** Replace the binding back with a static fallback. */
    unbindField: (property: string, staticValue?: string) => void;
    /** True when the active (non-default) variant carries its own per-variant CMS
     *  override (rebind or unbind→value) for this property — drives the Reset Override
     *  menu item for Fill/style/Content labels on a variant. */
    hasVariantOverride: (property: string) => boolean;
    /** Reset Override on a variant: drop THIS variant's CMS branch → revert to the
     *  primary's base binding (e.g. back to `url(item.image)`). Mirrors the text reset. */
    resetVariantOverride: (property: string) => void;
    /** Selected node's tag (`p`, `div`, `img`, …) — narrows the per-property
     *  field-type filter so e.g. text Fill doesn't offer image-typed fields. */
    nodeTag?: string;
  } | null;
}

const ControlContext = createContext<ControlContextValue | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * Wraps the properties panel tools with centralized control context.
 * Provides style read/write, viewport routing, and override detection.
 *
 * Usage:
 *   <ControlProvider>
 *     <FillTool />
 *     <SizeTool />
 *     ...
 *   </ControlProvider>
 */
export function ControlProvider({ children }: { children: ReactNode }) {
  const selectedId = useAtomValue(selectedNodeAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const vpId = useAtomValue(interactingViewportIdAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const vpWidth = useAtomValue(interactingViewportWidthAtom);
  const overrides = useAtomValue(containerOverridesAtom);
  // Component master variants: parallel to `isReplica`/`overrides` for
  // pages but sourced from `motionVariants[variantName]` instead of
  // @media rules. Used by the styles merger + hasOverride below so
  // controls on a non-default variant viewport show the variant's
  // per-property override AND light the ControlLabel blue with a
  // Reset Override menu entry — same UX as tablet/mobile replicas.
  const isComponentVariantViewport = useAtomValue(isComponentVariantViewportAtom);
  const activeComponentVariant = useAtomValue(activeComponentVariantAtom);

  const isDefaultLocale = useAtomValue(isDefaultLocaleAtom);
  const localeOverrides = useAtomValue(localeOverridesAtom);

  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const mapContext = useAtomValue(mapContextAtom);
  const setMapItemIndex = useSetAtom(mapItemIndexAtom);

  const isComponentFile = useAtomValue(isComponentFileAtom);
  const pageVariables = useAtomValue(pageVariablesAtom);

  // LIVE cache-first read: a drop commits styles/structure to the imperative
  // cache synchronously, but the parsed nodesAtom is DEFERRED (canvas-first).
  // useLiveNode re-renders on the cache version bumps so the whole Properties
  // panel shows committed values the same frame the drop lands (was ~0.5s
  // behind on a big page).
  const selectedNode = useLiveNode(selectedId);
  const node = selectedId ? selectedNode ?? null : null;
  // FIT SVG wrapper: resolve inner text node for text style reads/writes.
  // Dimensional styles (width, height, position) stay on the SVG; text styles go to the inner <p>.
  const isFitWrapper = node?.type === 'svg' && selectedId?.endsWith('-svg');
  const fitInnerNode = useNodesComputed((nodes) => {
    if (!isFitWrapper || !node) return null;
    for (const childId of node.children) {
      const child = nodes.get(childId);
      if (child?.type === 'foreignObject') {
        for (const innerId of child.children) {
          return nodes.get(innerId) ?? null;
        }
      }
    }
    return null;
  }, [isFitWrapper, node]);
  // Merge SVG styles with inner text styles so controls show text properties
  // correctly. WRAPPER SPREADS LAST: the wrapper owns the dimensional styles
  // (width/height — mirroring updateStyle's write routing below), while the
  // inner contributes the text properties the wrapper doesn't define. The old
  // inner-last order let the inner's internal `width: 'auto'` clobber the
  // wrapper's `width: '100%'`, so the Size tool showed an uneditable "auto"
  // for every FIT text (live find 2026-07-13).
  // MEMOISED — the identity of this object is load-bearing, not just its
  // contents. It feeds the `styles` memo below, whose result feeds
  // `effectiveStyles`' useNodesComputed DEPS; a fresh object here rebuilds that
  // selectAtom every render, and jotai's useAtomValue re-subscribes + calls its
  // own rerender() whenever the atom identity changes → unbounded render loop.
  // Both branches used to allocate: `{ ...inner, ...node }` on every FIT-wrapper
  // render, and `{}` on every render with NO resolvable node — which is exactly
  // the state a component-variant drag-out lands in (the exit clone's
  // addCanvasNode is still queued, so the selected id isn't in the map yet). The
  // panel then re-rendered ~10k times/second until mouseup and the canvas froze
  // behind it (user report 2026-08-02). EMPTY_STYLES keeps the no-node case on
  // one shared reference.
  const baseStyles = useMemo(
    () => (isFitWrapper && fitInnerNode
      ? { ...fitInnerNode.styles, ...node!.styles }
      : node?.styles ?? EMPTY_STYLES),
    [isFitWrapper, fitInnerNode, node],
  );

  // Merge overrides on top of base styles so controls show correct values:
  // 1. Locale overrides (when in non-default locale)
  // 2. Responsive overrides (when in replica viewport — tablet/mobile)
  const styles = useMemo(() => {
    let result = baseStyles;

    // Locale overrides
    if (!isDefaultLocale && selectedId) {
      const override = localeOverrides.get(selectedId);
      if (override?.styles && Object.keys(override.styles).length > 0) {
        result = { ...result, ...override.styles };
      }
    }

    // Responsive overrides: merge @media values for the current viewport width
    if (isReplica && selectedId && vpWidth) {
      const bpProps = getOverridesAtWidth(overrides, selectedId, vpWidth);
      if (bpProps.size > 0) {
        result = { ...result, ...Object.fromEntries(bpProps) };
        // A SHORTHAND override (`padding: 16px` in the @media rule) supersedes
        // the base LONGHANDS at paint — drop them so the panel's per-side inputs
        // (PaddingControl `paddingTop || sh[0]`) and the shorthand-vs-longhand
        // chevron don't read the stale base value (110/0/140/0) alongside the
        // override shorthand (16). The unified provider's else-branch already
        // does this; the DIRECT-mode atoms read THIS outer `styles`, so it must
        // clear here too — else the global field shows 16 but the individual
        // inputs show base, and a chevron click reverts to primary (live find
        // 2026-07-03).
        clearShorthandSupersededLonghands(result, bpProps.keys());
      }
    }

    // Variant overrides: when editing a non-primary variant in a
    // component master file, merge motionVariants[variantName] on top
    // of the base so controls reflect what's painted on THIS variant.
    // Parallel to the responsive-override merge above, just sourced
    // from the parser's per-variant style map. Without this, painting
    // a different fill on variant-2 leaves the Fill control showing
    // the base color and there's no visible override indicator.
    if (isComponentVariantViewport && activeComponentVariant && node?.motionVariants) {
      const variantStyles = (node.motionVariants as Record<string, Record<string, string>>)[activeComponentVariant];
      if (variantStyles && Object.keys(variantStyles).length > 0) {
        result = { ...result, ...variantStyles };
        // svg GROUP CHILD per-variant SIZE rides scaleX/scaleY (CSS width/height
        // are not painted on a nested svg — Chromium probe 2026-06-12). The
        // panel speaks px: synthesize width/height from base attrs × scale so
        // the Dimensions controls show the painted size (and the override dot).
        // Same synth as the unified provider — any new override source must
        // land in BOTH providers (the locale lesson's rule).
        if (node?.type === 'svg' && node.attrs) {
          const sxV = parseFloat(String(variantStyles.scaleX ?? ''));
          const syV = parseFloat(String(variantStyles.scaleY ?? ''));
          const baseW = parseFloat(node.attrs.width ?? '');
          const baseH = parseFloat(node.attrs.height ?? '');
          if (Number.isFinite(sxV) && Number.isFinite(baseW)) {
            result = { ...result, width: `${Math.round(baseW * sxV * 100) / 100}px` };
          }
          if (Number.isFinite(syV) && Number.isFinite(baseH)) {
            result = { ...result, height: `${Math.round(baseH * syV * 100) / 100}px` };
          }
        }
      }
    }

    // Conditional styles: layout-affecting props (flexDirection, gap, align,
    // justify, order, …) live as inline `style` ternaries keyed on the variant
    // (`conditionalStyles[prop][variant]`), NOT in the variants object — so they
    // FLIP-animate (see layout-props-must-be-style-ternaries). Resolve the value
    // for THIS variant so the Layout controls show the right value + override.
    if (isComponentVariantViewport && activeComponentVariant && node?.conditionalStyles) {
      const cond = node.conditionalStyles as Record<string, Record<string, string>>;
      const resolved: Record<string, string> = {};
      for (const [prop, map] of Object.entries(cond)) {
        const v = map[activeComponentVariant] ?? map['default'];
        if (v !== undefined) resolved[prop] = v;
      }
      if (Object.keys(resolved).length > 0) result = { ...result, ...resolved };
    }

    // Per-variant CMS STYLE override (variantBindings.style): an unbind→value injects a
    // LITERAL (e.g. backgroundImage: 'url(...)') on THIS variant only — surface it so the
    // Fill/style control shows the detached value (not the base binding's broken preview).
    // `{field}` rebinds are live bindings, not static styles, so skip them here (the
    // CmsBoundPill renders those).
    if (isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default' && node?.variantBindings?.style) {
      const vs = node.variantBindings.style[activeComponentVariant];
      if (vs) {
        const resolved: Record<string, string> = {};
        for (const [prop, entry] of Object.entries(vs)) {
          if (entry && 'value' in entry) resolved[prop] = entry.value;
        }
        if (Object.keys(resolved).length > 0) result = { ...result, ...resolved };
      }
    }

    return result;
  }, [baseStyles, isDefaultLocale, selectedId, localeOverrides, isReplica, vpWidth, overrides, isComponentVariantViewport, activeComponentVariant, node]);

  // Map-aware effective styles: overlay map data overrides onto base styles
  // (bounded template-subtree scan → useNodesComputed so it stays live per
  // commit but only re-renders when the merged result differs).
  const effectiveStyles = useNodesComputed((nodes) => {
    if (mapItemIndex == null || !mapContext) return styles;
    const itemData = mapContext.mapData[mapItemIndex];
    if (!itemData) return styles;

    const overrides: Record<string, string> = {};
    const queue = [mapContext.templateId];
    while (queue.length > 0) {
      const nid = queue.shift()!;
      const n = nodes.get(nid);
      if (!n) continue;
      for (const sb of (n.styleBindings || [])) {
        if (itemData[sb.field] !== undefined) {
          overrides[sb.styleProp] = itemData[sb.field];
        }
      }
      for (const childId of n.children) queue.push(childId);
    }

    return { ...styles, ...overrides };
  }, [styles, mapItemIndex, mapContext]);

  // Derive parent layout type for grid/flex child controls. EFFECTIVE for the
  // INTERACTING viewport: a replica @media can flip the parent's
  // flex-direction (or display) — the Fill/main-axis math must follow the
  // flipped direction, or Width→Fill on the replica writes a grow flex that
  // operates on the WRONG axis (row-fill in a column parent = the collapsed
  // "Global benefits" card, live find 2026-07-21).
  const parentNode = useLiveNode(node?.parentId) ?? null;
  const parentOverrides = (isReplica && parentNode && vpWidth)
    ? getOverridesAtWidth(overrides, parentNode.id, vpWidth)
    : null;
  // PER-VARIANT parent resolution — the component-master twin of the replica
  // `parentOverrides` above, and it was missing. A master's parent can flip its
  // direction per variant, either in its variant OBJECT
  // (`variants['variant-4'].flexDirection`) or as an inline ternary the parser
  // folds into `conditionalStyles.flexDirection['variant-4']` — the shape the
  // generator emits for `flexDirection: variant === 'variant-4' ? 'column' :
  // 'row'`. Reading only the base style resolved that parent as `row`, so on
  // variant-4 the panel presented the child's `flex: 3 0 0px` grow under WIDTH
  // while CSS was applying it to the main axis, which on a column is the HEIGHT:
  // lowering "Width 3 fr" visibly shrank the card's height (user report
  // 2026-07-26). Same failure the replica comment above describes, one axis-
  // resolution source later.
  //
  // Conditional LAST, matching the Renderer's `resolveVariantStyles` precedence
  // (base ← variant object ← conditional ternary). A conditional with no entry
  // for this variant falls back to its `default` key — that's the ternary's ELSE
  // branch, which is what the other variants actually render.
  const parentVariantStyle = (prop: string): string | undefined => (
    isComponentVariantViewport
      ? resolveParentVariantStyle(parentNode as never, activeComponentVariant, prop)
      : undefined
  );
  const parentDisplay = parentVariantStyle('display')
    || parentOverrides?.get('display') || parentNode?.styles.display || '';
  const parentLayout: 'grid' | 'flex' | 'none' = parentDisplay.includes('grid') ? 'grid'
    : parentDisplay.includes('flex') ? 'flex'
    : 'none';
  const parentFlexDirection = parentVariantStyle('flexDirection')
    || parentOverrides?.get('flexDirection')
    || parentNode?.styles.flexDirection || 'row';

  /**
   * Centralized style update — routing is handled inside updateNodeStyles
   * via the global style context (setStyleContext in Canvas.tsx).
   * No manual variant/replica detection needed here.
   */
  // Text properties that should target the inner <p> node in FIT mode (not the SVG wrapper)
  const TEXT_STYLE_KEYS = new Set([
    'color', 'fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textAlign', 'textTransform', 'textDecoration', 'whiteSpace',
    'writingMode', 'textDecorationLine', 'textDecorationColor', 'textDecorationStyle',
    'textDecorationThickness', 'textUnderlineOffset', 'WebkitTextStroke',
    'WebkitTextFillColor', 'WebkitBackgroundClip', 'backgroundClip',
  ]);
  const fitInnerIdRef = useRef(fitInnerNode?.id ?? null);
  fitInnerIdRef.current = fitInnerNode?.id ?? null;

  /** Apply styles to ALL selected nodes. Accepts single key+value or a Record. */
  const updateStyle = useCallback((keyOrStyles: string | Record<string, string>, value?: string) => {
    if (selectedIds.length === 0) return;
    const contentEl = getContentRoot();
    if (!contentEl) return;
    const styles = typeof keyOrStyles === 'string' ? { [keyOrStyles]: value! } : keyOrStyles;
    trace.action('control:update-style', { nodeIds: selectedIds, styles });

    // FIT SVG wrapper: route text-style properties to inner text node
    const innerId = fitInnerIdRef.current;
    if (innerId) {
      const textStyles: Record<string, string> = {};
      const svgStyles: Record<string, string> = {};
      for (const [k, v] of Object.entries(styles)) {
        if (TEXT_STYLE_KEYS.has(k)) textStyles[k] = v;
        else svgStyles[k] = v;
      }
      if (Object.keys(textStyles).length > 0) {
        updateNodeStyles({ id: innerId, styles: textStyles, contentEl });
      }
      if (Object.keys(svgStyles).length > 0) {
        for (const id of selectedIds) {
          updateNodeStyles({ id, styles: svgStyles, contentEl });
        }
      }
      return;
    }

    for (const id of selectedIds) {
      updateNodeStyles({ id, styles, contentEl });
    }
  }, [selectedIds]);

  // DOM-only live patch — bypasses the mutation queue + code generator
  // entirely. Used by sliders during continuous input so the canvas
  // updates at 60fps without re-parsing the source on every tick. The
  // consumer is expected to follow up with `updateStyle` on release to
  // commit the final value to code. Mirrors how the on-canvas gap
  // handle works.
  const updateStyleLive = useCallback((key: string, value: string) => {
    if (selectedIds.length === 0) return;
    const bridge = getCanvasBridge();
    const styles = { [key]: value };

    // NON-PRIMARY tile (page @media replica OR component variant): patch ONLY
    // the active tile. Every tile renders the SAME data-id, and a replica/
    // variant edit commits to that tile alone (@media rule / variant object).
    // The broad "patch all prefixes" fan-out below is right for PRIMARY/base
    // edits (which cascade to every tile), but on a non-primary edit it visibly
    // skews/moves the OTHER tiles during a live drag and leaves a stale
    // transform on them after release (the primary's source never changed, so
    // the Renderer doesn't re-render it to clear the patch). Scope to vpId.
    if (isComponentVariantViewport || isReplica) {
      const prefix = getViewportPrefix(vpId);
      // `important: true` — the COMMITTED replica/variant override is an
      // `@container`/@media rule with `!important` (updateContainerQueryStyle /
      // variant object). A plain inline live-patch (no !important) LOSES to that
      // stale `!important` rule (still carrying the pre-drag value), so the
      // canvas didn't move during the drag and only jumped on release when the
      // rule was rewritten (live find 2026-07-03). Inline `!important` beats a
      // stylesheet `!important`, so the live preview now tracks the drag at
      // 60fps. (Primary/base edits below commit to INLINE styles — no !important
      // needed there.)
      for (const id of selectedIds) bridge.patchStyles(id, prefix, styles, true);
      return;
    }

    // Patch primary + every replica viewport prefix the bridge knows
    // about. Same fan-out as the map-aware path above, kept here so
    // every selected id gets updated for every viewport in one pass.
    const rectCache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
    const prefixes = new Set<string>(['']);
    if (rectCache) {
      for (const cacheKey of rectCache.keys()) {
        const parsed = parseRectCacheKey(cacheKey);
        if (!parsed) continue;
        prefixes.add(parsed.vpPrefix);
      }
    }
    // BACKDROP exception: while any slider drags, Canvas.tsx injects
    // `backdrop-filter: none !important` canvas-wide (the PERF kill — blur is
    // THE drag-jank source). That stylesheet rule beat the plain inline live
    // patch, so dragging the Backdrop slider showed NO blur at all until
    // mouse-up ("it cancels during drag", user report 2026-07-29). An inline
    // `!important` outranks a stylesheet `!important`, so patch these keys
    // important: the node being EDITED previews live while every other blur
    // stays disabled for perf. The residue tracker clears the !important on
    // the next full render, and the commit writes plain inline styles.
    const important = 'backdropFilter' in styles || 'WebkitBackdropFilter' in styles;
    for (const id of selectedIds) {
      for (const prefix of prefixes) {
        bridge.patchStyles(id, prefix, styles, important);
      }
    }
  }, [selectedIds, isComponentVariantViewport, isReplica, vpId]);

  // Map-aware style update: routes writes to map data when editing a ghost item
  // Track which properties we've already auto-bound during this session
  // (parser re-parse is async, so styleBindings may be stale during continuous editing)
  const boundFieldsRef = useRef(new Map<string, string>());

  // Keep selectedId in a ref so mapAwareUpdateStyle always reads the latest value
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const mapAwareUpdateStyle = useCallback((keyOrStyles: string | Record<string, string>, value?: string) => {
    if (mapItemIndex == null || !mapContext) {
      updateStyle(keyOrStyles, value);
      return;
    }

    const allEntries = typeof keyOrStyles === 'string' ? { [keyOrStyles]: value! } : keyOrStyles;

    // `display` (the Hide toggle) is a TEMPLATE-level structural prop, NEVER a
    // per-item CMS field. The map-aware path below AUTO-BINDS each style key to a
    // CMS field (`item.<key>`) — meaningless for `display`, so Hide on a CMS row
    // silently no-op'd (it tried to bind a non-existent `display` field). Route it
    // through the normal style write so it reaches node-ops/replica-context: inline
    // `display:none` on the primary, a per-variant `display: variant === 'x' ?
    // 'none' : '<base>'` ternary on a variant — both hide the row's rendered rows.
    const entries: Record<string, string> = {};
    const structural: Record<string, string> = {};
    for (const [k, v] of Object.entries(allEntries)) {
      if (k === 'display') structural[k] = v;
      else entries[k] = v;
    }
    if (Object.keys(structural).length > 0) {
      updateStyle(structural);
      // A CMS-row `display:none` must RE-SYNC the collection ghosts: the panel write
      // patches the template + queues the mutation, but the ghost copies (and the
      // resolved template) only re-render on a full Renderer cycle — so the rows
      // stay visible until a drag forces one. Flush + force a render now (same
      // pattern pagination uses), so Hide takes effect immediately. Deferred a tick
      // so the queued mutation is in code before the Renderer re-reads it.
      flushNow();
      requestAnimationFrame(() => forceCanvasRender());
    }
    if (Object.keys(entries).length === 0) return;

    const itemData = { ...(mapContext.mapData[mapItemIndex] || {}) };

    for (const [key, val] of Object.entries(entries)) {
      // Check parsed bindings first, then local cache
      let fieldName: string | null = boundFieldsRef.current.get(key) || null;
      if (!fieldName) {
        const currentNodes = getNodesSnapshot();
        const queue = [mapContext.templateId];
        while (queue.length > 0) {
          const nid = queue.shift()!;
          const n = currentNodes.get(nid);
          if (!n) continue;
          for (const sb of (n.styleBindings || [])) {
            if (sb.styleProp === key) { fieldName = sb.field; break; }
          }
          if (fieldName) break;
          for (const childId of n.children) queue.push(childId);
        }
      }

      if (fieldName) {
        if (mapItemIndex === 0) {
          const oldVal = itemData[fieldName];
          itemData[fieldName] = val;
          queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: 0, item: itemData });
          propagateToGhosts(mapContext.varName, fieldName, oldVal, val, mapContext.mapData);
        } else {
          itemData[fieldName] = val;
          queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex, item: itemData });
        }
      } else {
        // Auto-bind: convert static style to per-item field (only once per property)
        const sid = selectedIdRef.current;
        trace.action('control:map-auto-bind', { key, sid, varName: mapContext.varName, currentValue: styles[key] || '' });
        if (sid) {
          flushNow();
          queueMutation({
            type: 'bindStyleToMap',
            nodeId: sid,
            varName: mapContext.varName,
            styleProp: key,
            fieldName: key,
            currentValue: styles[key] || '',
          });
          // Cache the binding so subsequent edits use updateMapItem directly
          boundFieldsRef.current.set(key, key);
          itemData[key] = val;
          queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex, item: itemData });
          if (mapItemIndex === 0) {
            propagateToGhosts(mapContext.varName, key, styles[key] || '', val, mapContext.mapData);
          }
        }
      }

      trace.action('control:map-update-style', { key, value: val, mapItemIndex, fieldName });
    }

    // Imperative DOM update via the canvas bridge so the change is visible
    // instantly without waiting for the mutation queue to flush + re-parse.
    // For .map() ghost edits the data binding only changes ONE item in the
    // array, so the patch must target the specific ghost (not all of them).
    // The bridge's patchStyles selector matches data-node-id exactly — pass
    // the ghost-suffixed id to hit just that ghost. For mapItemIndex===0 we
    // target the template AND mirror to all ghosts because that path either
    // edits the shared style (canonical write, no field binding) or
    // propagates a field default to ghosts (handled above by
    // propagateToGhosts).
    const sid = selectedIdRef.current;
    if (sid) {
      const targetNodeId = makeGhostId(sid, mapItemIndex ?? 0);
      const bridge = getCanvasBridge();
      // Patch primary viewport
      bridge.patchStyles(targetNodeId, '', entries);
      // Replica viewports: enumerate viewport prefixes from the bridge cache
      // (the rectCache holds keys `${vpPrefix}:${nodeId}`). Patch each replica
      // viewport's matching ghost too.
      const rectCache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
      if (rectCache) {
        const seenPrefixes = new Set<string>();
        for (const key of rectCache.keys()) {
          const vpPrefix = parseRectCacheKey(key)?.vpPrefix;
          if (!vpPrefix || seenPrefixes.has(vpPrefix)) continue;
          seenPrefixes.add(vpPrefix);
          bridge.patchStyles(targetNodeId, vpPrefix, entries);
        }
      }
    }
  }, [mapItemIndex, mapContext, updateStyle, styles]);

  // Backward compat alias — tools that call updateMultipleStyles still work
  const updateMultipleStyles = mapAwareUpdateStyle as (styles: Record<string, string>) => void;

  const hasOverride = useCallback((property: string) => {
    if (!selectedId) return false;
    // Component master non-primary variants: an override exists when
    // motionVariants[currentVariant][property] is present (any value,
    // including '' which is the "explicit un-set"). Mirrors the
    // @media-rule check below but sourced from per-variant style map.
    if (isComponentVariantViewport && activeComponentVariant && node?.motionVariants) {
      const variantStyles = (node.motionVariants as Record<string, Record<string, string>>)[activeComponentVariant];
      if (variantStyles && property in variantStyles) return true;
      // svg group-child SIZE rides scaleX/scaleY in the entry (the px channel
      // isn't painted on nested svg) — surface it as a width/height override.
      if (variantStyles && node?.type === 'svg') {
        if (property === 'width' && 'scaleX' in variantStyles) return true;
        if (property === 'height' && 'scaleY' in variantStyles) return true;
      }
      // Rotation rides the motion `rotate` key (unified channel) while the
      // panel's Rotate control is registered under `transform` — surface it
      // so the label goes purple + offers Reset Override on a replica.
      if (variantStyles && (property === 'transform' || property === 'rotate') && 'rotate' in variantStyles) return true;
    }
    // Per-variant VISIBILITY override: a "Hide: Yes" on a non-default variant writes an AnimatePresence
    // `{variant !== 'v' && …}` gate → the variant lands in `hiddenOnVariants` (NOT motionVariants/
    // conditionalStyles). The Hide control's property is `display`, so read it here — else its label stays
    // plain on the variant it's hidden in. Goes accent-secondary (purple) + offers Reset Override, exactly
    // like a per-variant style override. (resolveValue already maps this variant → `display: 'none'`.)
    if (property === 'display' && isComponentVariantViewport && activeComponentVariant
        && node?.hiddenOnVariants?.has(activeComponentVariant)) return true;
    // Conditional-style (ternary) override: a non-default variant has its OWN
    // branch for this layout prop → it's an override on this variant.
    if (isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default' && node?.conditionalStyles) {
      const map = (node.conditionalStyles as Record<string, Record<string, string>>)[property];
      if (map && activeComponentVariant in map) return true;
    }
    // Per-variant CMS STYLE override (variantBindings.style) → Fill/style label accent + reset.
    if (isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default' && node?.variantBindings?.style?.[activeComponentVariant]) {
      const vs = node.variantBindings.style[activeComponentVariant];
      if (property in vs || (property === 'backgroundColor' && 'backgroundImage' in vs)) return true;
    }
    // Per-variant TEXT override (literal branch OR variable binding) on a non-default variant — so the
    // Content label goes purple + offers "Reset Override", exactly like a per-variant Color override.
    if (property === 'textContent' && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
      if (node?.conditionalText && activeComponentVariant in node.conditionalText) return true;
      if (node?.conditionalTextVariable && activeComponentVariant in node.conditionalTextVariable) return true;
      // Per-variant CMS rebind / unbind→default override (variantBindings).
      if (node?.variantBindings?.text && activeComponentVariant in node.variantBindings.text) return true;
    }
    // Per-VIEWPORT override on a replica via an inline `__mq` ternary (a variable branch OR a frozen
    // literal) — NOT a @media rule, so hasOverrideAtWidth below misses it. The label still must go
    // purple + offer Reset because THIS tile differs from the cascaded base. Banded (own viewport only).
    if (isReplica && vpWidth) {
      if (property === 'textContent' && node?.responsiveTextValues) {
        for (const b of Object.keys(node.responsiveTextValues).map(Number)) {
          const min = node.responsiveTextBands?.[b] ?? 0;
          if (vpWidth <= b && vpWidth >= min) return true;
        }
      }
      const rsv = node?.responsiveStyleVariables?.[property];
      if (rsv) {
        for (const b of Object.keys(rsv).map(Number)) {
          const min = node?.responsiveStyleBands?.[property]?.[b] ?? 0;
          if (vpWidth <= b && vpWidth >= min) return true;
        }
      }
    }
    // Primary is the source of truth — its values aren't overrides of
    // anything, so the label never goes blue. Replicas only light up when
    // THIS exact viewport has its own @media rule. Tablet's rule is NOT an
    // override on mobile — see hasOverrideAtWidth's docstring for why.
    if (!isReplica || !vpWidth) return false;
    return hasOverrideAtWidth(overrides, selectedId, property, vpWidth);
  }, [selectedId, overrides, isReplica, vpWidth, isComponentVariantViewport, activeComponentVariant, node]);

  const getOverrides = useCallback((property: string) => {
    if (!selectedId) return [];
    return getOverrideBreakpoints(overrides, selectedId, property);
  }, [selectedId, overrides]);

  const getValueSource = useCallback((property: string) => {
    // textContent is special: it's not a CSS style. The Content control
    // surfaces variable state via `node.textVariable`, populated by the
    // parser when the JSX child is `{propName}`. Routes the menu and the
    // ControlLabel's purple two-line state.
    if (property === 'textContent') {
      // PER-VIEWPORT text override on THIS replica tile (banded, template/page): a variable branch →
      // purple pill bound to it; a literal branch (frozen via per-viewport remove) → plain literal (no
      // pill). Takes precedence over the cascaded base/variant binding. Mirrors `responsiveVarRef` for styles.
      if (isReplica && vpWidth && node?.responsiveTextValues) {
        for (const b of Object.keys(node.responsiveTextValues).map(Number).sort((a, c) => a - c)) {
          const min = node.responsiveTextBands?.[b] ?? 0;
          if (vpWidth <= b && vpWidth >= min) {
            const branchVar = node.responsiveTextVariables?.[b];
            return branchVar
              ? { source: 'prop' as ValueSource, ref: branchVar }
              : { source: 'inline' as ValueSource, ref: null };
          }
        }
      }
      // Per-variant text-variable binding (mirrors conditionalStyleVariables for styles): on a variant
      // viewport the bound state is PER VARIANT, so the pill shows only where the variable actually drives
      // the text — not on every variant. `conditionalTextVariable` maps variant → prop ('default' = the
      // ternary fallback that drives all unlisted variants).
      const ctv = node?.conditionalTextVariable;
      if (ctv) {
        // Resolve for the ACTIVE variant — works on every viewport including the primary (where the
        // active variant is 'default'). Without the 'default' fallback the primary viewport skipped this
        // and fell back to the global `textVariable`, showing the pill bound on a variant that actually
        // uses the literal — the "added everywhere" symptom.
        const v = activeComponentVariant ?? 'default';
        // 1) This variant is an explicit variable branch → bound to it.
        if (ctv[v]) return { source: 'prop' as ValueSource, ref: ctv[v] };
        // 2) This variant has its own LITERAL override → not bound here (show the literal editor).
        if (node?.conditionalText && v in node.conditionalText) return { source: 'inline' as ValueSource, ref: null };
        // 3) Falls through to the fallback — bound only if the fallback is the variable.
        if (ctv['default']) return { source: 'prop' as ValueSource, ref: ctv['default'] };
        return { source: 'inline' as ValueSource, ref: null };
      }
      // Plain global `{content}` binding (no per-variant ternary) → bound on every variant.
      if (node?.textVariable) {
        return { source: 'prop' as ValueSource, ref: node.textVariable };
      }
      return { source: 'inline' as ValueSource, ref: null };
    }
    const val = styles[property] ?? '';
    // Per-variant detach: on a NON-PRIMARY variant that has its OWN override
    // for this property, the base variable is shadowed here — so for THIS
    // variant it's a literal, not a variable binding. Ignore the variable
    // marker so the control shows the literal editor (color picker), not the
    // purple pill. The variable still lives in the base + other variants.
    // OVERLAY binding detach: the property (`border`) is detached on this variant by overriding
    // the CUSTOM PROPERTY (`--X`, where X is the bound variable name) in the variant object — NOT
    // `border` itself. Without this, the pill stays purple on the detached variant and the × is a
    // no-op (re-writes the same `--X` override).
    const overlayVarName = node?.styleVariables?.[property];
    const overlayCustomKey = overlayVarName ? `--${overlayVarName}` : null;
    const overriddenInVariant = isComponentVariantViewport
      && !!activeComponentVariant
      && (
        (!!(node?.motionVariants as Record<string, Record<string, string>> | undefined)?.[activeComponentVariant]
          && property in (node!.motionVariants as Record<string, Record<string, string>>)[activeComponentVariant])
        // Overlay-border detach via the custom property in the variant object.
        || (!!overlayCustomKey
          && !!(node?.motionVariants as Record<string, Record<string, string>> | undefined)?.[activeComponentVariant]
          && overlayCustomKey in (node!.motionVariants as Record<string, Record<string, string>>)[activeComponentVariant])
        // Conditional-style (ternary) override on a non-default variant.
        || (activeComponentVariant !== 'default'
          && !!(node?.conditionalStyles as Record<string, Record<string, string>> | undefined)?.[property]
          && activeComponentVariant in (node!.conditionalStyles as Record<string, Record<string, string>>)[property])
      );
    // Per-variant VARIABLE binding (`'--X': initialVariant === 'v' ? X : 'none'`): on the variant
    // it applies to, the property IS variable-bound (purple pill) even though there's no base
    // binding. Takes precedence over the detach/override logic above.
    const condVarRef = (isComponentVariantViewport && !!activeComponentVariant)
      ? (node?.conditionalStyleVariables?.[property]?.[activeComponentVariant]
        // The IDIOMATIC variant-object binding (`logoNameVariants['v'] = { color: prop }`) — same purple pill.
        // motionVariantVariables is keyed [variant][cssProp] (transposed from conditionalStyleVariables).
        ?? node?.motionVariantVariables?.[activeComponentVariant]?.[property])
      : undefined;
    // A PER-VIEWPORT override on a replica (a `@media` literal written when the variable was
    // removed on this tile) BREAKS the cascaded variable binding for this tile — so drop the pill
    // and show the override VALUE instead (the row already reads as an override + Reset). Mirrors
    // `overriddenInVariant` for component variants.
    const overriddenInViewport = isReplica && hasOverride(property);
    // Per-VIEWPORT variable bound on THIS replica tile → that variable is the pill, shadowing the
    // cascaded base (cascade: smallest breakpoint whose max-width covers vpWidth). Takes precedence.
    const responsiveVarRef = (() => {
      const byW = isReplica && vpWidth ? node?.responsiveStyleVariables?.[property] : undefined;
      if (!byW) return undefined;
      for (const b of Object.keys(byW).map(Number).sort((a, c) => a - c)) {
        // BAND, not cascade: the override's pill shows on its own viewport only.
        const min = node?.responsiveStyleBands?.[property]?.[b] ?? 0;
        if (vpWidth <= b && vpWidth >= min) return byW[b];
      }
      return undefined;
    })();
    // node.styleVariables is the post-resolve marker for variable bindings —
    // styles[property] now holds the *resolved* default for master files, so
    // the legacy `var:` prefix detection alone misses the binding.
    const variableRef = responsiveVarRef ?? condVarRef
      ?? ((overriddenInVariant || overriddenInViewport) ? undefined : node?.styleVariables?.[property]);
    return detectValueSource(val, variableRef);
  }, [styles, node, isComponentVariantViewport, activeComponentVariant, isReplica, vpWidth, hasOverride]);

  const createVariable = useCallback((property: string, propName: string, defaultValue?: string, clearLonghands?: string[]) => {
    if (!selectedId) return;

    // ─── TRANSITION variable (framer-motion transition, NOT a CSS style) ────────────────────────────────
    // A transition variable binds the framer-motion transition to a variable IDENTIFIER — per-variant native:
    // default → `<MotionConfig transition={var}>`, a variant → `variantObj[v].transition = var`, child →
    // `transition={var}`. NOT style.transition (the legacy mis-bind that can never drive a variant animation).
    // Route to the dedicated mutation so it lands in the right framer-motion slot for the ACTIVE variant.
    if (property === 'transition' && isComponentFile) {
      const isRoot = node ? !node.parentId : true;
      const onComponentVariant = isComponentVariantViewport && !!activeComponentVariant && activeComponentVariant !== 'default';
      const tMode: 'motionConfig' | 'variantEntry' | 'elementProp' = onComponentVariant ? 'variantEntry' : (isRoot ? 'motionConfig' : 'elementProp');
      trace.action('control:create-transition-variable', { nodeId: selectedId, mode: tMode, variant: onComponentVariant ? activeComponentVariant : null, propName });
      queueMutation({ type: 'createTransitionVariable', nodeId: selectedId, mode: tMode, variantName: onComponentVariant ? activeComponentVariant! : null, propName, defaultValue: defaultValue ?? '{}', onRoot: isRoot });
      return;
    }

    // PERSISTENT control type. For a SELECT-control style property (justify/align/wrap/overflow/…),
    // stamp the variable's @propMeta as `option` + its options UP FRONT. The VariableModal reads this
    // type → it keeps rendering the select even after the variable is UNBOUND from a node (otherwise it
    // derives the control from the live binding and falls back to a text input once removed — the
    // reported "X turns the select into an input" bug). Component create paths below don't touch the
    // @propMeta type, so this survives; the template path passes 'option' to ensureTemplateVarParam.
    // EXCLUDE properties that have a DEDICATED variable-editor atom (flexDirection→DirectionControl's
    // row/column arrows, overflow→OverflowControl, …). Those must render their OWN control, resolved by
    // the modal via resolveVariableEditor — stamping 'option' would force the generic select instead.
    const hasDedicatedEditor = property !== 'textContent' && !!resolveVariableEditor(property);
    const selectControlMeta = (property !== 'textContent' && !hasDedicatedEditor) ? resolveControl(property) : null;
    const selectVarType = selectControlMeta?.type === 'select' ? 'option' : null;
    if (selectControlMeta?.type === 'select') {
      queueMutation({ type: 'setComponentPropType', propName, varType: 'option' });
      // `locked: true` — these are FIXED CSS-enum values (justify/align/…); the modal must render a
      // plain select, not the editable option list (typing an arbitrary value would break the property).
      queueMutation({ type: 'setComponentPropOptions', propName, options: selectControlMeta.options.map((o) => o.value), locked: true });
    }

    // ─── PER-VIEWPORT variable bind on a REPLICA (page OR template) ──────
    // On a replica tile, "set variable" binds a DIFFERENT variable to THIS viewport only — an
    // inline `__mq`-gated identifier ternary (`prop: (__mqN ? overrideVar : baseExpr)`), keeping
    // the base binding on the other tiles. The viewport analog of a per-variant variable inside a
    // design component. Templates land here too (they're `isComponentFile` but edited with page
    // VIEWPORTS); gated out only on a real component-VARIANT edit. See responsive-style-vars-gen.ts.
    {
      const onComponentVariant = isComponentVariantViewport && !!activeComponentVariant && activeComponentVariant !== 'default';
      // SHAPE-routed (Phase 0): textContent (JSX text child) + every style prop share this ONE
      // per-viewport scope branch — the only difference is which codegen the bind routes to.
      if (isReplica && vpWidth && !onComponentVariant) {
        // Type for the page-variable declaration + default. The variable's EDITOR control (text input
        // vs SELECT vs color, …) is NOT keyed off this — it's derived from the bound style property in
        // the Template tool (resolveControl), exactly like the design-component instance tool. So an
        // enum prop (justify/align) stays type-agnostic here ('text') yet still renders its select.
        const inferredType = pageVariableTypeForProperty(property) ?? 'text';
        {
          const exists = pageVariables.some(v => v.name === propName);
          const captured = defaultValue ?? styles[property] ?? node?.textContent ?? defaultForType(inferredType);
          if (isComponentFile) {
            // TEMPLATE: variables are function PARAMS (so they show in the Template tool + support
            // per-route overrides), NOT useState. Always ensure the param (idempotent; converts a
            // useState a prior per-viewport create may have produced).
            trace.action('control:ensure-template-var-param-for-viewport', { nodeId: selectedId, property, propName, vpWidth, type: inferredType });
            queueMutation({ type: 'ensureTemplateVarParam', name: propName, defaultValue: captured, varType: selectVarType ?? inferredType, literalKind: inferredType === 'number' ? 'number' : inferredType === 'boolean' ? 'boolean' : 'string' });
          } else if (!exists) {
            trace.action('control:create-page-variable-for-viewport', { nodeId: selectedId, property, propName, vpWidth, type: inferredType });
            queueMutation({ type: 'addPageVariable', variable: { name: propName, type: inferredType, default: captured } });
          }
          if (property === 'textContent') {
            // TEXT shape: bind a DIFFERENT text variable on THIS tile only (`{__mq ? propName : base}`),
            // keeping the base text binding on the other tiles. base = existing text var, else the
            // current literal text quoted.
            const baseExpr = node?.textVariable ?? JSON.stringify(node?.textContent ?? '');
            trace.action('control:bind-responsive-text-variable', { nodeId: selectedId, propName, vpWidth, baseExpr });
            queueMutation({ type: 'bindResponsiveTextVariable', nodeId: selectedId, vpWidth, branch: propName, baseFallback: baseExpr });
          } else {
            // STYLE shape. Base fallback (only used if the prop has no value yet): the existing base
            // binding's identifier, else the current literal value quoted as a JS string expression.
            const baseExpr = node?.styleVariables?.[property]
              ?? (styles[property] ? JSON.stringify(styles[property]) : "''");
            trace.action('control:bind-responsive-style-variable', { nodeId: selectedId, property, propName, vpWidth, baseExpr });
            queueMutation({ type: 'bindResponsiveStyleVariable', nodeId: selectedId, vpWidth, styleProperty: property, varName: propName, baseFallback: baseExpr });
          }
          return;
        }
      }
      // PRIMARY tile of a node that already carries a per-viewport ternary (`__mq ? override : base`):
      // "Set Variable" can't bind through the plain path (the value isn't a bare prop). Set the BASE
      // branch to the variable identifier, keeping the per-viewport overrides — the inverse of the
      // base-removal path in `removeVariable`.
      if (!isReplica && property !== 'textContent' && node?.responsiveStyleVariables?.[property]) {
        const inferredType = pageVariableTypeForProperty(property);
        if (inferredType) {
          if (!pageVariables.some(v => v.name === propName)) {
            const captured = defaultValue ?? styles[property] ?? defaultForType(inferredType);
            queueMutation({ type: 'addPageVariable', variable: { name: propName, type: inferredType, default: captured } });
          }
          trace.action('control:bind-responsive-style-base', { nodeId: selectedId, property, propName });
          queueMutation({ type: 'setResponsiveStyleBase', nodeId: selectedId, styleProperty: property, newBase: propName });
          return;
        }
      }
    }

    // ─── Page file branch ──────────────────────────────────────────────
    // When editing a regular page, "create variable" means: declare a
    // page variable in the @pageVariables block AND replace the inline
    // style value with a JSX identifier. Two mutations, atomically
    // batched by the queue's RAF flush so the file is never invalid.
    //
    // textContent is NOT yet plumbed through here — it requires JSX-text
    // rewrites that the page-variable generator doesn't ship in this
    // phase. Falls through to the component-text helper below; the
    // ControlLabel menu gating skips textContent on page files anyway
    // until we add it.
    if (!isComponentFile && property !== 'textContent') {
      const inferredType = pageVariableTypeForProperty(property);
      if (inferredType) {
        let captured = defaultValue ?? styles[property] ?? defaultForType(inferredType);
        // Boolean variables for display/visibility store a 'true'/'false'
        // string, but the captured CSS value is 'none'/'hidden'/''/etc.
        // Translate so the variable's default reflects the visible state
        // at creation time — `none` → true (currently hidden) so the user's
        // immediate state is preserved when they bind it.
        if (inferredType === 'boolean' && isConditionalDisplayProperty(property)) {
          const branches = conditionalBranchesFor(property);
          if (branches) captured = captured === branches.consequent ? 'true' : 'false';
        }
        // Skip if a variable with this name already exists — modal flow
        // calls "Use This Variable" with the same name, which means the
        // variable IS the source. Re-adding would be a no-op anyway, but
        // the binding still needs to land.
        const exists = pageVariables.some(v => v.name === propName);
        if (!exists) {
          trace.action('control:create-page-variable', { nodeId: selectedId, property, propName, defaultValue: captured, type: inferredType });
          queueMutation({
            type: 'addPageVariable',
            variable: { name: propName, type: inferredType, default: captured },
          });
        } else {
          trace.action('control:bind-page-variable', { nodeId: selectedId, property, propName });
        }
        queueMutation({ type: 'bindStylePageVariable', nodeId: selectedId, styleProperty: property, varName: propName });
        return;
      }
      // Property has no compatible page-variable type — fall through. Also
      // means the menu shouldn't have shown the entry; defensive fallback.
    }

    // ─── Component master, NON-PRIMARY variant ──
    if (isComponentFile && property !== 'textContent' && isComponentVariantViewport
        && activeComponentVariant && activeComponentVariant !== 'default') {
      const baseVar = node?.styleVariables?.[property];
      if (baseVar) {
        // Re-binding the SAME base variable (or border, whose binding is an ::after overlay) → undo
        // this variant's DETACH override so it inherits the base again (legacy re-attach). Empty
        // value ⇒ the generator deletes the key.
        if (propName === baseVar || property === 'border') {
          const customKey = `--${baseVar}`;
          const variantObj = (node?.motionVariants as Record<string, Record<string, string>> | undefined)?.[activeComponentVariant];
          const keyToClear = (variantObj && customKey in variantObj) ? customKey
            : (variantObj && property in variantObj) ? property
            : customKey;
          trace.action('control:reattach-variable-for-variant', { nodeId: selectedId, property, propName, variant: activeComponentVariant, keyToClear });
          queueMutation({ type: 'updateVariantStyle', nodeId: selectedId, variantName: activeComponentVariant, styles: { [keyToClear]: '' } });
          return;
        }
        // A DIFFERENT variable on THIS variant — the base keeps its OWN variable via the ternary else:
        // `<cssProp>: initialVariant === 'v' ? newVar : baseVar`. The variant-scoped mirror of the
        // per-viewport create. Fixes "creating a variable on a non-default variant reused the primary's
        // variable instead of minting a new one" (Phase 1). `elseIsIdentifier` keeps baseVar a bare id.
        const def = defaultValue ?? styles[property] ?? '';
        // Clear any prior per-variant OBJECT entry for this prop (a panel edit on this variant wrote
        // `variants[v] = { …: 'literal' }`). A framer-motion variant value BEATS the inline style, so it
        // would MASK the new inline-ternary variable. Empty value ⇒ the generator deletes the key.
        queueMutation({ type: 'updateVariantStyle', nodeId: selectedId, variantName: activeComponentVariant, styles: { [property]: '' } });
        trace.action('control:create-variant-override-variable', { nodeId: selectedId, property, propName, variant: activeComponentVariant, baseVar });
        queueMutation({ type: 'setVariantInlineVariable', nodeId: selectedId, cssProp: property, propName, variantName: activeComponentVariant, elseValue: baseVar, defaultValue: def, elseIsIdentifier: true });
        return;
      }
      // NEW per-variant variable: the base has NO binding, so apply the variable ONLY on this
      // variant via an inline ternary. Border uses the `::after` overlay path; every other property
      // is a direct inline ternary (`<cssProp>: initialVariant === 'v' ? X : '<base value>'`).
      if (property === 'border') {
        const def = defaultValue ?? styles[`--${propName}`] ?? styles[property] ?? '';
        trace.action('control:create-variant-only-border-variable', { nodeId: selectedId, propName, variant: activeComponentVariant });
        queueMutation({ type: 'setVariantBorderVariable', nodeId: selectedId, propName, variantName: activeComponentVariant, defaultValue: def });
      } else {
        const base = styles[property] ?? '';                 // other variants keep the base value
        const def = defaultValue ?? base;                    // signature default for the new prop
        trace.action('control:create-variant-only-variable', { nodeId: selectedId, property, propName, variant: activeComponentVariant });
        queueMutation({ type: 'setVariantInlineVariable', nodeId: selectedId, cssProp: property, propName, variantName: activeComponentVariant, elseValue: base, defaultValue: def });
      }
      return;
    }

    // ─── Component file branch (original behavior) ──────────────────────
    if (property === 'textContent') {
      const text = defaultValue ?? node?.textContent ?? '';
      // Non-primary variant: bind the variable ONLY on this variant (per-variant ternary) — the other
      // variants keep their literal text. Otherwise it'd bind `{content}` on the shared child = every
      // variant. Works for both "Create Variable" (prop added) and "Set Variable" (existing prop).
      if (isComponentFile && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
        trace.action('control:bind-text-variable-for-variant', { nodeId: selectedId, propName, variant: activeComponentVariant });
        queueMutation({ type: 'bindTextVariableForVariant', nodeId: selectedId, variantName: activeComponentVariant, propName, propDefault: text });
        return;
      }
      if (!isComponentFile) {
        // Regular PAGE: a text variable should be a SETTABLE @pageVariables state
        // var (useState), NOT a read-only @propMeta prop — so it shows in the
        // Interactions tool's "Set Variable" list, exactly like a color page var.
        trace.action('control:create-text-page-variable', { nodeId: selectedId, propName, defaultValue: text });
        queueMutation({ type: 'createTextPageVariable', nodeId: selectedId, propName, defaultValue: text });
        return;
      }
      trace.action('control:create-text-variable', { nodeId: selectedId, propName, defaultValue: text });
      queueMutation({ type: 'createTextVariable', nodeId: selectedId, propName, defaultValue: text });
      return;
    }
    const value = defaultValue ?? styles[property] ?? '';
    // Type-aware creation (the reference model): a single-number control mints a Number variable (raw numeric
    // literal default), a boolean control (Hide/Wrap) a Toggle variable (ternary binding), and color/
    // image/text get their typed @propMeta. Properties with no clean primitive (border/shadow/transition)
    // → spec is null → the legacy string-style create path. See control-variable-type.ts.
    const spec = styleControlVariableSpec(property);
    if (spec?.conditional) {
      // Boolean visibility-style variable (display/visibility/flexWrap) — bind via ternary.
      const boolDefault = value === spec.conditional.consequent ? 'true' : 'false';
      trace.action('control:create-conditional-variable', { nodeId: selectedId, property, propName, boolDefault });
      queueMutation({
        type: 'createConditionalVariable',
        nodeId: selectedId, styleProperty: property, propName,
        consequent: spec.conditional.consequent, alternate: spec.conditional.alternate,
        boolDefault, varType: spec.typeId,
      });
      return;
    }
    const effectiveClearLonghands = clearLonghands ?? AUTO_CLEAR_LONGHANDS_BY_PROPERTY[property];
    trace.action('control:create-variable', { nodeId: selectedId, property, propName, defaultValue: value, clearLonghands: effectiveClearLonghands?.length ?? 0, literalKind: spec?.literalKind ?? 'string' });
    queueMutation({ type: 'createVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue: value, clearLonghands: effectiveClearLonghands, literalKind: spec?.literalKind ?? 'string', varType: spec?.typeId });
    // Seed a Number variable's slider knobs from the control registry (opacity → 0–1/0.01, gap → 0–200/1,
    // …) so its editor opens with sensible bounds instead of the generic 0–100. Defaults to a slider.
    if (spec?.typeId === 'number') {
      const reg = resolveControl(property);
      if (reg && reg.type === 'numeric') {
        queueMutation({ type: 'setComponentPropNumberMeta', propName, meta: { min: reg.min ?? null, max: reg.max ?? null, step: reg.step ?? null, control: 'slider' } });
      }
    }
  }, [selectedId, styles, node, isComponentFile, pageVariables, isComponentVariantViewport, activeComponentVariant, isReplica, vpWidth]);

  const removeVariable = useCallback((property: string, propName: string, defaultValue: string, deleteProp = false) => {
    if (!selectedId) return;

    // PER-VIEWPORT remove on a REPLICA viewport (page OR template) → drop the variable on THIS
    // tile ONLY: write its current resolved value as a per-viewport LITERAL override through the
    // normal per-viewport style path (a `@media` container rule), KEEPING the base binding so the
    // other viewports still resolve it. Mirrors a per-variant detach inside a design component, and
    // the row reads as an override with Reset on this tile. Templates MUST be handled here even
    // though they're `isComponentFile` (component-LIKE): they're edited with page VIEWPORTS, not
    // component variants — so this is gated only by being a real component-VARIANT edit (handled
    // per-variant below). `textContent` has its own per-variant path further down.
    const onComponentVariant = isComponentVariantViewport && !!activeComponentVariant && activeComponentVariant !== 'default';
    // SHAPE-routed (Phase 0): textContent + every style prop share this ONE per-viewport-remove scope
    // branch — removing on a replica writes a per-tile override, never clears the base everywhere.
    if (isReplica && vpWidth && !onComponentVariant) {
      if (property === 'textContent') {
        // TEXT shape: drop this tile's own per-viewport branch if present, else FREEZE the current
        // resolved text as a literal on THIS tile only (`{__mq ? "<frozen>" : base}`), keeping the
        // base text binding on the other tiles — the text twin of the style @media-literal freeze.
        if (node?.responsiveTextVariables?.[vpWidth] != null || node?.responsiveTextValues?.[vpWidth] != null) {
          trace.action('control:unbind-responsive-text-variable', { nodeId: selectedId, vpWidth });
          queueMutation({ type: 'unbindResponsiveTextVariable', nodeId: selectedId, vpWidth });
          return;
        }
        const baseExpr = node?.textVariable ?? JSON.stringify(node?.textContent ?? '');
        const frozen = (defaultValue && defaultValue.trim()) ? defaultValue : (node?.textContent ?? '');
        trace.action('control:freeze-text-per-viewport', { nodeId: selectedId, vpWidth, frozen });
        queueMutation({ type: 'bindResponsiveTextVariable', nodeId: selectedId, vpWidth, branch: JSON.stringify(frozen), baseFallback: baseExpr });
        return;
      }
      // STYLE shape. If THIS tile carries its own per-viewport VARIABLE binding (an `__mq` ternary
      // branch at this exact width), removing drops that branch → reverts the tile to the cascaded base.
      if (node?.responsiveStyleVariables?.[property]?.[vpWidth] != null) {
        trace.action('control:unbind-responsive-style-variable', { nodeId: selectedId, property, vpWidth });
        queueMutation({ type: 'unbindResponsiveStyleVariable', nodeId: selectedId, vpWidth, styleProperty: property });
        return;
      }
      // Otherwise (the variable is the cascaded base) FREEZE its current value as a per-viewport
      // @media literal on THIS tile, keeping the base binding elsewhere. Works for ANY style property —
      // enum/select (justify/align), gap, padding, margin, … — NOT just those with a page-variable
      // type. Was gated on `inferredType`, so type-less props fell through to the GLOBAL unbind below
      // (removed everywhere — the reported justify bug). updateStyle routes to @media on a replica.
      const literal = (defaultValue && defaultValue.trim()) ? defaultValue : (styles[property] ?? '');
      trace.action('control:freeze-style-per-viewport', { nodeId: selectedId, property, propName, vpWidth, literal });
      updateStyle(property, literal);
      return;
    }

    // BASE of a per-viewport variable ternary (`__mq ? override : base`), removed on the PRIMARY (or
    // any non-replica) tile: the value isn't a bare identifier, so the plain unbind below can't find
    // it (no-op). Replace just the base branch with its literal value, keeping the per-viewport
    // overrides. (Replica tiles with their own branch were handled above.)
    if (!isReplica && property !== 'textContent' && node?.responsiveStyleVariables?.[property]) {
      // INJECT the variable's DEFAULT value (light blue here) onto the node — never blank the style.
      // Prefer the declared default; fall back to the current resolved value if the default is empty.
      const literal = (defaultValue && defaultValue.trim()) ? defaultValue : (styles[property] ?? '');
      trace.action('control:unbind-responsive-style-base', { nodeId: selectedId, property, literal });
      queueMutation({ type: 'setResponsiveStyleBase', nodeId: selectedId, styleProperty: property, newBase: literal ? JSON.stringify(literal) : "''" });
      return;
    }

    // Page file, PRIMARY viewport — unbind the property globally (identifier → literal). The
    // variable itself stays declared so other bound properties keep working; the user removes it
    // explicitly via the variables modal when they're truly done with it.
    if (!isComponentFile && property !== 'textContent') {
      const inferredType = pageVariableTypeForProperty(property);
      if (inferredType) {
        trace.action('control:unbind-page-variable', { nodeId: selectedId, property, propName, defaultValue });
        queueMutation({ type: 'unbindStylePageVariable', nodeId: selectedId, styleProperty: property, literalValue: defaultValue });
        return;
      }
    }

    if (property === 'textContent') {
      // Non-primary variant: DETACH this variant only (per-variant ternary), keeping the variable bound
      // on every other variant — mirrors how style variables detach per-variant. The literal we pin is
      // the variable's current resolved value so the visible text doesn't jump.
      if (isComponentFile && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
        const literal = node?.textContent ?? defaultValue ?? '';
        trace.action('control:detach-text-variable-for-variant', { nodeId: selectedId, propName, variant: activeComponentVariant, literal });
        queueMutation({ type: 'detachTextVariableForVariant', nodeId: selectedId, variantName: activeComponentVariant, propName, literal });
        return;
      }
      if (!isComponentFile) {
        // Page text variable is a @pageVariables state var (not a prop): inline the
        // text back to its literal AND drop the annotation + useState hook in one go.
        trace.action('control:remove-text-page-variable', { nodeId: selectedId, propName });
        queueMutation({ type: 'removeTextPageVariable', nodeId: selectedId, propName, defaultValue });
        return;
      }
      // The × pill UNBINDS only (deleteProp=false) — the variable stays in the modal for re-binding,
      // exactly like style variables. Only the modal's explicit delete drops the prop.
      trace.action('control:remove-text-variable', { nodeId: selectedId, propName, deleteProp });
      queueMutation({ type: 'removeTextVariable', nodeId: selectedId, propName, defaultValue, deleteProp });
      return;
    }

    // Component master, NON-PRIMARY variant: don't remove the variable —
    // DETACH it for this variant only by overriding the property with the
    // variable's default value as a literal (a per-variant replica value, the
    // the reference model). The base binding + every other variant keep the variable.
    // `styles[property]` already holds the variable's resolved default (the
    // parser substitutes it), so it's the literal we inject.
    if (isComponentFile && property !== 'textContent' && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
      // PER-VARIANT VARIABLE (variant-only binding via inline ternary, no base binding): the variable
      // lives ONLY on this variant, so removing it is a full unbind of the ternary — strip the inline
      // `--X` + the `::after var` (removeVariableInCode handles the overlay; deleteProp=false keeps
      // the prop). NOT a detach (there's no base to fall back to).
      const isVariantOnlyVar = node?.conditionalStyleVariables?.[property]?.[activeComponentVariant] === propName
        && !node?.styleVariables?.[property];
      if (isVariantOnlyVar) {
        trace.action('control:remove-variant-only-variable', { nodeId: selectedId, property, propName, variant: activeComponentVariant });
        queueMutation({ type: 'removeVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue, deleteProp: false });
        return;
      }
      // PER-VARIANT VARIABLE OVERRIDE *with a base binding* (the Phase 1 structure: `cssProp:
      // variant==='v' ? variantVar : baseVar`). Removing this replica's pill DETACHES it to a LITERAL
      // (an active override with NO variable) while the BASE keeps its variable — the reference model
      // ("the primary has a variable, this replica shouldn't"). Two steps: (1) DROP the inline ternary's
      // variant branch so `conditionalStyleVariables` clears (the pill goes away — masking-only didn't,
      // the prior bug); (2) write the variant-object LITERAL so the variant still overrides (NOT revert
      // to the base variable). Literal = the variable's current value so the visible result doesn't jump.
      if (node?.conditionalStyleVariables?.[property]?.[activeComponentVariant] === propName
          && node?.styleVariables?.[property]) {
        const literal = (defaultValue && defaultValue.trim()) ? defaultValue : (styles[property] ?? '');
        trace.action('control:detach-variant-style-override', { nodeId: selectedId, property, propName, variant: activeComponentVariant, literal });
        queueMutation({ type: 'removeVariantStyleVariable', nodeId: selectedId, cssProp: property, variantName: activeComponentVariant });
        queueMutation({ type: 'updateVariantStyle', nodeId: selectedId, variantName: activeComponentVariant, styles: { [property]: literal } });
        return;
      }
      // OVERLAY-border binding (`'--X': prop` + `::after { border: var(--X) }`): the property
      // (`border`) isn't an inline style, so overriding `{ border: ... }` does nothing — the
      // overlay stays. Override the CUSTOM PROPERTY per variant instead so `var(--X)` resolves
      // to the detach value ON THIS VARIANT ONLY (base/other variants keep the variable). Empty
      // default ⇒ `none` (a concrete "no border" value that survives the variant object; an empty
      // string would be stripped as a remove-marker → would inherit the base border back).
      const customKey = `--${propName}`;
      const isOverlayBinding = node?.styleVariables?.[customKey] === propName;
      if (isOverlayBinding) {
        const ovVal = (defaultValue && defaultValue.trim()) ? defaultValue : 'none';
        trace.action('control:detach-overlay-variable-for-variant', { nodeId: selectedId, property, customKey, variant: activeComponentVariant, ovVal });
        queueMutation({ type: 'updateVariantStyle', nodeId: selectedId, variantName: activeComponentVariant, styles: { [customKey]: ovVal } });
        return;
      }
      const literal = (styles[property] ?? defaultValue ?? '');
      trace.action('control:detach-variable-for-variant', { nodeId: selectedId, property, propName, variant: activeComponentVariant, literal });
      queueMutation({ type: 'updateVariantStyle', nodeId: selectedId, variantName: activeComponentVariant, styles: { [property]: literal } });
      return;
    }

    // Primary (default) variant — UNBIND this node (identifier/overlay → literal). The prop is
    // KEPT by default so the variable stays in the modal for re-binding; it's only dropped from the
    // signature on a full delete (`deleteProp`, from the variable modal). The × in the controls
    // panel passes deleteProp=false. Already-detached variants keep their literal overrides as-is.
    trace.action('control:remove-variable', { nodeId: selectedId, property, propName, deleteProp });
    // Removing a component PROP at its SOURCE (inside the master) when it was the LAST binding → detach
    // the prop from every instance project-wide (the page var stays in the modal). Returns false (→ the
    // normal single-node unbind below, prop kept) when not a component master or other nodes still use it.
    if (removeComponentPropProjectWide(selectedId, property, propName, defaultValue)) return;
    queueMutation({ type: 'removeVariable', nodeId: selectedId, styleProperty: property, propName, defaultValue, deleteProp });
  }, [selectedId, isComponentFile, isComponentVariantViewport, activeComponentVariant, styles, pageVariables, node, isReplica, vpWidth, updateStyle]);

  // Map override context for ghost item editing
  const mapOverrideCtx = useMemo(() => {
    if (mapItemIndex == null || !mapContext) return null;
    const itemData = mapContext.mapData[mapItemIndex] || {};
    const item0 = mapContext.mapData[0] || {};

    return {
      itemIndex: mapItemIndex,
      itemCount: mapContext.mapData.length,
      isOverridden: (property: string) => {
        const currentNodes = getNodesSnapshot();
        const queue = [mapContext.templateId];
        while (queue.length > 0) {
          const nid = queue.shift()!;
          const n = currentNodes.get(nid);
          if (!n) continue;
          for (const sb of (n.styleBindings || [])) {
            if (sb.styleProp === property && itemData[sb.field] !== undefined && itemData[sb.field] !== item0[sb.field]) {
              return true;
            }
          }
          for (const childId of n.children) queue.push(childId);
        }
        return false;
      },
      resetOverride: (property: string) => {
        const currentNodes = getNodesSnapshot();
        const queue = [mapContext.templateId];
        while (queue.length > 0) {
          const nid = queue.shift()!;
          const n = currentNodes.get(nid);
          if (!n) continue;
          for (const sb of (n.styleBindings || [])) {
            if (sb.styleProp === property) {
              const updated = { ...itemData, [sb.field]: item0[sb.field] || '' };
              queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex, item: updated });
              return;
            }
          }
          for (const childId of n.children) queue.push(childId);
        }
      },
      goToItem: (index: number | null) => setMapItemIndex(index),
    };
  }, [mapItemIndex, mapContext, setMapItemIndex]);

  // CMS-collection-template context. Two sources surface this:
  //
  //   1. Selected node is inside a `.map()` over CMS data — the .map()
  //      parent has `collectionList` set by the parser. Walk ancestors to
  //      find it.
  //   2. Active file is a CMS Detail page (`/** @cmsPage { kind: 'detail' } */`).
  //      The whole page body is a template against `const item = ...`, so
  //      every selected node sees the same binding surface — no .map()
  //      ancestor exists. We synthesize the context from the page meta so
  //      `bindFieldInCode` (which only needs a nodeId + itemVar) works
  //      identically on both surfaces.
  const collectionSchemas = useAtomValue(collectionSchemasAtom);
  const collectionData = useAtomValue(collectionDataAtom);
  const cmsPageMeta = useAtomValue(cmsPageMetaAtom);
  // Ancestor-with-collectionList walk (.map() context) — the only part of the
  // CMS binding context that needs the node MAP (unbounded ancestor walk), so
  // it gets its own fine-grained computed subscription; the memo below builds
  // the callback surface from its plain result.
  const cmsListAncestor = useNodesComputed((nodes) => {
    let cursor: CanvasNode | undefined = node ?? undefined;
    while (cursor) {
      if (cursor.collectionList && !cursor.collectionList.source.startsWith('__inline:')) break;
      cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
    }
    return cursor?.collectionList
      ? { slug: cursor.collectionList.source, itemVar: cursor.collectionList.itemVar }
      : null;
  }, [node]);
  const cmsBindingCtx = useMemo<ControlContextValue['cmsBinding']>(() => {
    if (!selectedId || !node) return null;

    let slug: string;
    let itemVar: string;
    if (cmsListAncestor) {
      slug = cmsListAncestor.slug;
      itemVar = cmsListAncestor.itemVar;
    } else if (cmsPageMeta?.kind === 'detail') {
      // Fallback: detail page — the page body is a template, every node
      // in it bind-eligible. itemVar is fixed at 'item' to match the
      // detail-page generator + parser context.
      slug = cmsPageMeta.collection;
      itemVar = 'item';
    } else {
      return null;
    }

    const schema = collectionSchemas.get(slug);
    if (!schema) return null;
    // A component INSTANCE inside a collection list binds its PROPS (not element
    // text/style/attr) — route get/bind/unbind through the `.map()` prop path so
    // CmsBoundPill works for component props (Mechanism A).
    const isInstanceNode = !!selectedId && isComponentInstanceInCache(selectedId);
    return {
      slug,
      itemVar,
      fields: schema.fields,
      nodeTag: node.type,
      getBindingForProperty: (property: string) => {
        // PER-VARIANT override (component master): a non-default variant's own branch
        // shadows the base binding HERE — a `{field}` rebind shows the rebound field's
        // pill; a `{value}` literal (unbind→default) shows NO pill (→ the literal text
        // editor + the override accent). Other variants keep the base binding below.
        if ((property === 'text' || property === 'textContent')
            && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
          const vb = node.variantBindings?.text?.[activeComponentVariant];
          if (vb) return 'field' in vb ? vb.field : null;
        }
        // STYLE per-variant override (Fill/color/image). `backgroundColor` (the Fill row)
        // also checks `backgroundImage` — the same alias the base path uses below.
        if (property !== 'text' && property !== 'textContent' && property !== 'src' && property !== 'href' && property !== 'alt'
            && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
          const vs = node.variantBindings?.style?.[activeComponentVariant];
          const entry = vs?.[property] ?? (property === 'backgroundColor' ? vs?.['backgroundImage'] : undefined);
          if (entry) return 'field' in entry ? entry.field : null;
        }
        // Component-instance prop bound to a field reads back from propBindings.
        const pb = node.propBindings?.find(b => b.prop === property);
        if (pb) return pb.field;
        // `text` and `textContent` are aliases — the panel uses
        // `textContent` as the property key; the parser stores the binding
        // under `text`. Accepting both keeps every downstream consumer
        // (CmsBoundPill, ControlLabel's bound-name display, the menu
        // item's currentField check) from having to remember the alias.
        if ((property === 'text' || property === 'textContent') && node.binding?.property === 'text') {
          return node.binding.field;
        }
        if (property === 'src' && node.attrBindings?.find(b => b.property === 'src')) {
          return node.attrBindings.find(b => b.property === 'src')!.field;
        }
        if (property === 'href' && node.attrBindings?.find(b => b.property === 'href')) {
          return node.attrBindings.find(b => b.property === 'href')!.field;
        }
        if (property === 'alt' && node.attrBindings?.find(b => b.property === 'alt')) {
          return node.attrBindings.find(b => b.property === 'alt')!.field;
        }
        const direct = node.styleBindings?.find(b => b.styleProp === property);
        if (direct) return direct.field;
        // Fill (`backgroundColor`) auto-routes image-typed picks to
        // `backgroundImage` at write time. Surface the latter as if it
        // were the same binding here so the Fill row's pill / menu's
        // current-field highlight light up.
        if (property === 'backgroundColor') {
          const bg = node.styleBindings?.find(b => b.styleProp === 'backgroundImage');
          if (bg) return bg.field;
        }
        return null;
      },
      bindToField: (property: string, fieldId: string) => {
        if (!selectedId) return;
        if (isInstanceNode) {
          // Component-instance prop → bind via the .map() prop path: propName={item.field}.
          // Re-pointing a WHOLE-VALUE image binding (`prop={`url(${item.f})`}`) must keep
          // the url() wrap — the master binds the prop bare (`backgroundImage: prop`), so
          // a plain rebind would feed it a raw URL. The pill only shows on an existing
          // binding, so the current entry's urlWrap carries the convention forward.
          const urlWrap = node.propBindings?.find(b => b.prop === property)?.urlWrap;
          trace.action('control:bind-prop-to-field', { nodeId: selectedId, property, fieldId, slug, urlWrap });
          queueMutation({ type: 'bindPropToMap', nodeId: selectedId, varName: slug, propName: property, fieldName: fieldId, currentValue: '', urlWrap });
          flushNow();
          return;
        }
        // PER-VARIANT: editing a non-default variant of a design component master → bind this
        // variant only (a `variant === 'v' ? item.field : base` ternary), keeping the base binding
        // on every other variant. (Text only for now; style/attr per-variant is a follow-up.)
        if (isComponentFile && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
          if (property === 'text' || property === 'textContent') {
            trace.action('control:bind-field-for-variant', { nodeId: selectedId, fieldId, variant: activeComponentVariant });
            queueMutation({ type: 'setVariantCmsText', nodeId: selectedId, variantName: activeComponentVariant, itemVar, override: { kind: 'field', field: fieldId } });
            flushNow();
            return;
          }
          if (property !== 'src' && property !== 'href' && property !== 'alt') {
            // STYLE per-variant rebind (Fill/color/image/…). An image field on `backgroundColor`
            // writes the url()-wrapped binding on `backgroundImage` (same mapping as the base path).
            const ft = schema.fields.find(f => f.id === fieldId)?.type;
            const isImage = ft === 'image' || ft === 'file';
            const styleProp = (property === 'backgroundColor' && isImage) ? 'backgroundImage' : property;
            trace.action('control:bind-style-for-variant', { nodeId: selectedId, fieldId, styleProp, variant: activeComponentVariant });
            queueMutation({ type: 'setVariantCmsStyle', nodeId: selectedId, styleProp, variantName: activeComponentVariant, itemVar, override: { kind: 'field', field: fieldId, isImage } });
            flushNow();
            return;
          }
          // attr (src/href/alt) per-variant: not built yet → falls through to the global bind.
        }
        // Look up the field's declared type so the generator can dispatch
        // (e.g. picking an image field for `backgroundColor` rewrites it
        // as `backgroundImage: url(...)` instead of a broken color slot).
        const fieldType = schema.fields.find(f => f.id === fieldId)?.type;
        trace.action('control:bind-to-field', { nodeId: selectedId, property, fieldId, itemVar, fieldType });
        queueMutation({ type: 'bindField', nodeId: selectedId, property, fieldId, itemVar, fieldType });
        flushNow();
      },
      unbindField: (property: string, staticValue: string = '') => {
        if (!selectedId) return;
        if (isInstanceNode) {
          // Component-instance prop → strip `propName={item.field}` off the instance
          // (reverts to the component default).
          trace.action('control:unbind-prop-from-field', { nodeId: selectedId, property });
          queueMutation({ type: 'unbindPropFromMap', nodeId: selectedId, propName: property });
          flushNow();
          return;
        }
        // PER-VARIANT: unbind on a non-default component-master variant = inject a per-variant
        // literal for THIS variant only (the base binding stays on every other variant) — fixes
        // "removed from everywhere". design-tool parity: the injected literal is the FIELD'S NAME
        // (e.g. "Question" / "bio"), a clear editable placeholder — not empty, and not a single
        // row's value (which differs per row in a collection). (Text only for now.)
        if (isComponentFile && isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default') {
          if (property === 'text' || property === 'textContent') {
            const baseField = node.binding?.property === 'text' ? node.binding.field : undefined;
            const fieldName = (baseField && schema.fields.find(f => f.id === baseField)?.name) || baseField || staticValue || '';
            trace.action('control:unbind-field-for-variant', { nodeId: selectedId, variant: activeComponentVariant, fieldName });
            queueMutation({ type: 'setVariantCmsText', nodeId: selectedId, variantName: activeComponentVariant, itemVar, override: { kind: 'literal', value: fieldName } });
            flushNow();
            return;
          }
          if (property !== 'src' && property !== 'href' && property !== 'alt') {
            // STYLE per-variant UNBIND (Fill/color/image): inject the resolved VALUE as a literal on
            // THIS variant only, keeping the base binding on the others (fixes "removed everywhere").
            // Resolve the ACTUAL bound style prop (Fill image binds `backgroundImage`, not `backgroundColor`).
            const sb = node.styleBindings?.find(b => b.styleProp === property)
              ?? (property === 'backgroundColor' ? node.styleBindings?.find(b => b.styleProp === 'backgroundImage') : undefined);
            if (sb) {
              // design-tool parity: unbind = DETACH TO VALUE, not blank. For an IMAGE field, bake the
              // first row's resolved URL (url()-wrapped) so the Fill keeps showing a picture (editable),
              // mirroring how the text unbind injects the field's placeholder. Non-image (color) keeps
              // the passed static fallback.
              const fieldDef = schema.fields.find(f => f.id === sb.field || f.name === sb.field);
              const isImageField = fieldDef?.type === 'image' || fieldDef?.type === 'file';
              let injected = staticValue;
              if (isImageField) {
                const rawUrl = collectionData.get(slug)?.[0]?.[sb.field] as string | undefined;
                if (rawUrl) injected = `url(${rawUrl})`;
              }
              trace.action('control:unbind-style-for-variant', { nodeId: selectedId, styleProp: sb.styleProp, variant: activeComponentVariant, isImageField, injected });
              queueMutation({ type: 'setVariantCmsStyle', nodeId: selectedId, styleProp: sb.styleProp, variantName: activeComponentVariant, itemVar, override: { kind: 'literal', value: injected } });
              flushNow();
              return;
            }
          }
          // attr (src/href/alt) per-variant: not built yet → falls through to the global unbind.
        }
        trace.action('control:unbind-field', { nodeId: selectedId, property });
        queueMutation({ type: 'unbindField', nodeId: selectedId, property, staticValue });
        flushNow();
      },
      // True only on a non-default variant that carries its OWN per-variant CMS branch
      // (rebind or unbind→value) for this property — text via variantBindings.text, style
      // via variantBindings.style (Fill maps backgroundColor→backgroundImage, same as the
      // bind/unbind paths). Drives the Reset Override menu item on a variant.
      hasVariantOverride: (property: string) => {
        if (!(isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default')) return false;
        if (property === 'text' || property === 'textContent') {
          return !!(node.variantBindings?.text && activeComponentVariant in node.variantBindings.text);
        }
        const vs = node.variantBindings?.style?.[activeComponentVariant];
        if (!vs) return false;
        return property in vs || (property === 'backgroundColor' && 'backgroundImage' in vs);
      },
      // Reset Override on a variant: drop THIS variant's CMS branch → the ternary collapses
      // back to the primary's plain base binding (e.g. `{item.title}` / `url(item.image)`).
      resetVariantOverride: (property: string) => {
        if (!selectedId || !(isComponentVariantViewport && activeComponentVariant && activeComponentVariant !== 'default')) return;
        if (property === 'text' || property === 'textContent') {
          trace.action('control:reset-variant-cms-text', { nodeId: selectedId, variant: activeComponentVariant });
          queueMutation({ type: 'setVariantCmsText', nodeId: selectedId, variantName: activeComponentVariant, itemVar, override: { kind: 'clear' } });
          flushNow();
          return;
        }
        // Resolve the actual stored styleProp (Fill image lives under backgroundImage).
        const vs = node.variantBindings?.style?.[activeComponentVariant];
        const styleProp = vs && property in vs ? property
          : (property === 'backgroundColor' && vs && 'backgroundImage' in vs) ? 'backgroundImage'
          : property;
        trace.action('control:reset-variant-cms-style', { nodeId: selectedId, styleProp, variant: activeComponentVariant });
        queueMutation({ type: 'setVariantCmsStyle', nodeId: selectedId, styleProp, variantName: activeComponentVariant, itemVar, override: { kind: 'clear' } });
        flushNow();
      },
    };
  }, [selectedId, node, cmsListAncestor, collectionSchemas, collectionData, cmsPageMeta, isComponentFile, isComponentVariantViewport, activeComponentVariant]);

  const value: ControlContextValue = {
    nodeId: selectedId,
    node,
    styles: effectiveStyles,
    vpId,
    isReplica,
    vpWidth,
    parentLayout,
    parentFlexDirection,
    updateStyle: mapAwareUpdateStyle,
    updateMultipleStyles,
    updateStyleLive,
    hasOverride,
    getOverrides,
    getValueSource,
    createVariable,
    removeVariable,
    mapOverride: mapOverrideCtx,
    cmsBinding: cmsBindingCtx,
  };

  return (
    <ControlContext.Provider value={value}>
      {children}
    </ControlContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Access the control context from any tool component.
 * Provides style read/write, viewport info, and override detection.
 *
 * Usage:
 *   const { styles, updateStyle, updateMultipleStyles, hasOverride } = useControl();
 */
const FALLBACK_CONTEXT: ControlContextValue = {
  node: null,
  nodeId: null,
  vpId: 'desktop',
  isReplica: false,
  vpWidth: 1440,
  styles: {},
  parentLayout: 'none',
  parentFlexDirection: 'row',
  updateStyle: () => {},
  updateMultipleStyles: () => {},
  updateStyleLive: () => {},
  hasOverride: () => false,
  getOverrides: () => [],
  getValueSource: () => ({ source: 'inline' as ValueSource, ref: null }),
  createVariable: () => {},
  removeVariable: () => {},
  mapOverride: null,
  cmsBinding: null,
};

export function useControl(): ControlContextValue {
  const ctx = useContext(ControlContext);
  if (!ctx) return FALLBACK_CONTEXT;
  return ctx;
}

export function useControlOptional(): ControlContextValue | null {
  return useContext(ControlContext);
}
