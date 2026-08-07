// Renderer.ts — Imperative DOM renderer with DOM diffing.
//
// Root IS the viewport — no wrapper divs. The root element from JSX gets
// `data-viewport` and `container-type: inline-size` applied directly.
// Replica viewports are clones of root at different widths.
//
// DOM Diffing: patches only what changed instead of replaceChildren.

import type { CanvasNode } from '../code/parsing/parser';
import { resolveActiveVariant, bandForTile, responsiveVariantForWidth } from './resolve-core';
import { pinnedResolveWidth, viewportBandPinOps } from './resize/viewport-band-pin-store';
import { extractStyleCSS } from '../code/parsing/parser';
import type { ViewportConfig, CollectionItem, NodeOverride, FilterGroup, FilterConfig, SortConfig, OverlayConfig } from '@/shared/types';
import { resolveOverlayConfig } from '@/code/parsing/overlay-parser';
import { trace, pauseDOMObserver, resumeDOMObserver } from '@/shared/debug-trace';
import { jsxStyleToHTML, coerceCssNumberToPx } from '@/shared/css-utils';
import { isSvgTag, isTextTag, WRAPPER_ONLY_STYLE_PROPS, isFitSize } from '@/shared/constants';
import { resolveResponsiveUnits, resolveContainerQueryUnits } from '@/shared/responsive-units';
import { hasMotionTransformProp, motionPropsToCSSTransform, MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { simpleHash } from '@/shared/hash-utils';
import { getOrCreateCanvasStyleEl, getActiveFilePath } from './node-ops';
import { getCollectionData, getCollectionSchema } from '@/code/project/cms-ops';
import { getLayoutForPage, getLayoutClientPath } from '@/code/project/active-file-store';
import { projectFS } from '@/code/project/project-fs';
import {
  parseResponsiveBreakpoints, stripResponsiveBlocks, getResponsiveOverridesForNode,
  _isComponentMaster, _allViewportWidthsAsc, getPushedLayoutCss,
  setResponsiveBreakpoints, setIsComponentMaster, setAllViewportWidthsAsc,
} from './renderer/responsive';
import { positionOverlayInPortal, positionCanvasNodeOverlays, collectOverlayElsForRoot, rememberOverlayPlacements, classifyPortalChild, type OverlayPlacement } from './renderer/overlay-portals';
import { applyStrokeAlignment, setElStyle, clearElStyle, resolveInstanceWrapperOverflow } from './renderer/style-apply';
import { applyNodeCmsBindings, applyBindingDataToTree, applyLocaleOverrides, clearLocaleStyleResidue } from './renderer/bindings';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Determine whether a node's textContent should be rendered via innerHTML.
 * SVG nodes are excluded — their children (polygon, path, etc.) are rendered
 * as actual child elements, not via innerHTML injection.
 */
export function shouldUseInnerHTML(
  nodeType: string,
  textContent: string,
  hasMixedContent: boolean,
  childrenCount: number,
  isChildrenSlot?: boolean,
  /** Set when textContent was extracted from a JSXExpressionContainer +
   *  StringLiteral (e.g. `<p>{"raw <svg>code</svg>"}</p>`). The text is
   *  guaranteed plain runtime data — never JSX — so the `<` fallback
   *  below must NOT fire for it. Without this opt-out, pasted source
   *  code containing `<svg>` etc. would render as actual icons. */
  textIsLiteral?: boolean,
): boolean {
  if (isChildrenSlot) return false;
  if (nodeType === 'svg' || isSvgTag(nodeType)) return false;
  if (!textContent) return false;
  if (textIsLiteral) return false;
  return hasMixedContent || (childrenCount === 0 && textContent.includes('<'));
}

/**
 * Whether a PATCH should clear text the DOM still holds.
 *
 * The normal text write is gated on the resolved text being TRUTHY, so a node
 * whose content became `''` kept whatever was last painted. Unbinding Content
 * (× on the CMS pill) writes an empty static value, so the collection TEMPLATE
 * row — item 0, the only row patched through `patchElement`; the ghosts go via
 * `applyBindingDataToTree` — went on showing the old field value until a page
 * switch (user report 2026-07-25). This mirrors the "empty string = remove the
 * property" rule styles already follow.
 *
 * Deliberately scoped to TEXT tags: a non-text leaf can legitimately hold DOM
 * the renderer owns but the node model doesn't describe — a code component's
 * mounted React root, a background `<video>`, a slot ghost — and blanking
 * those would destroy them.
 *
 * RICH TEXT is excluded for the same reason. A node whose content is entirely
 * markup — `<p><span style="color:…">typed text</span></p>`, which is exactly
 * what styling text inside the editor produces — parses to `hasMixedContent:
 * true` with an EMPTY `textContent`, and `shouldUseInnerHTML` bails on that
 * empty string too. So "no text content" says nothing about whether the node
 * should be blank, and clearing wiped the span: type into a new text node,
 * pick a colour before committing, and the content vanished on commit
 * (user report 2026-07-25, regression from the emptied-text fix earlier the
 * same day).
 */
export function shouldClearEmptiedText(
  node: Pick<CanvasNode, 'type' | 'children' | 'hasMixedContent' | 'isChildrenSlot'>,
  resolvedTextContent: string | undefined,
  hasActiveTextBinding: boolean,
  elHasText: boolean,
): boolean {
  if (resolvedTextContent) return false;      // normal write path handles it
  if (hasActiveTextBinding) return false;     // a live CMS field owns this text
  if (node.hasMixedContent) return false;     // content is markup, not textContent
  if (node.isChildrenSlot) return false;      // page content, not this node's text
  if (node.children.length > 0) return false; // not a leaf — children own the box
  if (!isTextTag(node.type)) return false;
  return elHasText;
}

// ─── CMS Ghost Inert CSS ───────────────────────────────────────────────────
// Ghosts of CMS-bound `.map()` rows (items 1+) must be visually full-fidelity
// but completely inert — no clicks, no hover, no text selection, nothing
// reaches them. Without this rule any descendant whose template specifies
// `pointer-events: auto` or `user-select: text` would punch through the
// imperative ghost-root flags. The `data-cms-ghost` attribute is set only
// on CMS-backed ghosts (NOT inline-map ghosts, which need to stay
// selectable so the user can edit per-item data).
let _cmsGhostCSSInjected = false;
function injectCmsGhostCSS() {
  if (_cmsGhostCSSInjected) return;
  _cmsGhostCSSInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-cms-ghost-inert', 'true');
  style.textContent = `
    [data-cms-ghost="true"],
    [data-cms-ghost="true"] * {
      pointer-events: none !important;
      user-select: none !important;
      -webkit-user-select: none !important;
    }
  `;
  document.head.appendChild(style);
}

// ─── Media Controls CSS ─────────────────────────────────────────────────────
// Inject once: disables native audio/video controls on canvas while keeping elements selectable.
let _mediaControlsCSSInjected = false;
function injectMediaControlsCSS() {
  if (_mediaControlsCSSInjected) return;
  _mediaControlsCSSInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-media-controls-block', 'true');
  style.textContent = `
    [data-content-root] video::-webkit-media-controls,
    [data-content-root] audio::-webkit-media-controls {
      pointer-events: none !important;
    }
    [data-content-root] video::-webkit-media-controls-enclosure,
    [data-content-root] audio::-webkit-media-controls-enclosure {
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

const VALID_TAGS = new Set([
  'div', 'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'a', 'button', 'section', 'header', 'footer', 'nav', 'main',
  'article', 'aside', 'figure', 'figcaption', 'blockquote', 'address',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'form', 'input', 'textarea', 'select', 'option', 'label', 'fieldset', 'legend',
  'details', 'summary', 'dialog', 'menu',
  'strong', 'em', 'b', 'i', 'u', 's', 'small', 'sub', 'sup', 'code', 'pre', 'kbd',
  'br', 'hr', 'iframe', 'video', 'audio', 'canvas', 'picture', 'source',
  'svg', 'rect', 'circle', 'ellipse', 'polygon', 'path', 'line', 'polyline', 'g', 'foreignObject',
]);

// ─── Previous-patch key tracking ──────────────────────────────────────────
// patchElement writes inline styles from `styleEntries` on every render.
// To clear keys that were set in a PREVIOUS render but are now absent from
// the new map (otherwise they linger as stale inline values that only a
// page-switch — which destroys + recreates the element — can clear), we
// remember the exact set of keys each element received on its last patch.
//
// WeakMap so removed elements get GC'd without leaking. Tracks ONLY the
// keys patchElement itself wrote — external systems (drag/resize live
// patches, locale overrides, slot/wrapper decorations) are NOT covered by
// the clear, by design.
const _prevPatchedKeys = new WeakMap<HTMLElement, Set<string>>();

// ─── Collection-list ghost binding signature ──────────────────────────────
// Which CMS fields the template subtree is bound to, recorded on the list
// element so a patch can tell "the bindings changed" from "nothing changed".
// The DOM tree looks identical before and after an unbind, so the structural
// signature can't see it, and `applyBindingDataToTree` only ever WRITES a
// bound value — it can't clear one that's gone. See the use site.
const GHOST_BINDING_SIG_ATTR = 'data-ghost-binding-sig';

/** `id:__text=field|src=field|__style.prop=field` for every node in a
 *  collection template subtree, in tree order. Cycle-safe via `seen`.
 *  Exported for the regression test that pins WHEN ghosts must rebuild. */
export function collectionBindingSignature(
  templateNode: CanvasNode,
  allNodes: Map<string, CanvasNode>,
  seen: Set<string> = new Set(),
): string {
  if (seen.has(templateNode.id)) return '';
  seen.add(templateNode.id);
  const parts: string[] = [];
  if (templateNode.binding) parts.push(`${templateNode.binding.property}=${templateNode.binding.field}`);
  for (const b of templateNode.attrBindings ?? []) parts.push(`${b.property}=${b.field}`);
  for (const b of templateNode.styleBindings ?? []) parts.push(`__style.${b.styleProp}=${b.field}`);
  for (const b of templateNode.propBindings ?? []) parts.push(`${b.prop}=${b.field}`);
  // Per-viewport / per-variant rebinds change the painted value too.
  if (templateNode.responsiveBindings) parts.push(`rb:${JSON.stringify(templateNode.responsiveBindings)}`);
  if (templateNode.variantBindings) parts.push(`vb:${JSON.stringify(templateNode.variantBindings)}`);
  const own = parts.length > 0 ? `${templateNode.id}[${parts.join('|')}]` : '';
  const kids = templateNode.children
    .map(cid => { const c = allNodes.get(cid); return c ? collectionBindingSignature(c, allNodes, seen) : ''; })
    .filter(Boolean);
  return [own, ...kids].filter(Boolean).join(',');
}

// ─── Drag-locked node IDs ─────────────────────────────────────────────────
// Nodes in this set are SKIPPED entirely by patchElement's style application
// — used by LayoutLiftedStrategy during an in-progress drag so the lift's
// imperative `position: absolute` + `left/top/zIndex` patches (set via
// `patchNodeStyles` on every frame) aren't clobbered by mid-drag source-
// triggered renders (e.g. alt-duplicate `addNode`).
//
// Set/cleared by `setRendererDragLockedNodeIds(ids)`; LayoutLiftedStrategy
// calls this on lift / cleanup. The renderer treats locked nodes as
// "rendered, don't re-style" — children still patch normally.
let _dragLockedNodeIds: Set<string> = new Set();
export function setRendererDragLockedNodeIds(ids: Set<string>): void {
  _dragLockedNodeIds = ids;
}

// extractStyleCSS cache (see the inject-CSS block in renderNodes).
let _lastCssCode = '';
let _lastCssResult = '';

/**
 * Resolve a node's PER-VIEWPORT style-VARIABLE values for the tile at `vpWidth`. The inline
 * `__mq` ternary (`backgroundColor: __mq0 ? colorTablet : color1`) evaluates `useMediaQuery`
 * against the editor WINDOW, so every replica tile would otherwise paint the same value — the
 * canvas must resolve it explicitly per tile. Picks the SMALLEST breakpoint whose max-width still
 * covers `vpWidth` (same cascade the `__mq` chain encodes), else nothing (→ the base binding shows).
 * Bails for component masters (they resolve per-variant, not per-viewport).
 */
function getResponsiveStyleVarValuesForNode(node: CanvasNode, vpWidth: number | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vpWidth || _isComponentMaster || !node.responsiveStyleValues) return out;
  vpWidth = pinnedResolveWidth(node.id, vpWidth); // viewport-drag pin (page nodes freeze, chrome live)
  for (const [prop, byW] of Object.entries(node.responsiveStyleValues)) {
    // BAND, not cascade: each override applies only inside its viewport's exclusive range [min, b].
    // A Tablet override does NOT paint Mobile. Shared with the text resolver + the drag preview (Bug 1).
    const b = bandForTile(byW, node.responsiveStyleBands?.[prop], vpWidth);
    if (b !== null) out[prop] = byW[b];
  }
  return out;
}

/**
 * Per-VIEWPORT TEXT value for a node on a given tile — the text twin of
 * `getResponsiveStyleVarValuesForNode`. BANDED (a Tablet override does NOT paint Mobile). Returns
 * undefined when no per-viewport branch covers `vpWidth` (→ the base `textContent` shows). Bails for
 * component masters (they resolve per-variant, not per-viewport).
 */
function getResponsiveTextValueForNode(node: CanvasNode, vpWidth: number | undefined): string | undefined {
  if (!vpWidth || _isComponentMaster || !node.responsiveTextValues) return undefined;
  vpWidth = pinnedResolveWidth(node.id, vpWidth); // viewport-drag pin
  const b = bandForTile(node.responsiveTextValues, node.responsiveTextBands, vpWidth);
  return b !== null ? node.responsiveTextValues[b] : undefined;
}

/** Per-viewport text from the useResponsiveText channel (`node.textOverrides`,
 *  keyed by viewport width). ONE definition for BOTH render paths —
 *  patchElement had this bucket walk inline while buildNodeElement never
 *  consulted the channel at all, so the FIRST paint of a replica tile showed
 *  the PRIMARY text until any later patch pass ("on load the override text is
 *  wrong, fixes after I do something", 2026-08-06). Bucket = smallest
 *  configured viewport width ≥ the (pin-adjusted) tile width. */
function getTextOverrideBucketValue(node: CanvasNode, vpWidth: number | undefined): string | undefined {
  if (!node.textOverrides || vpWidth === undefined || _allViewportWidthsAsc.length === 0) return undefined;
  const w = pinnedResolveWidth(node.id, vpWidth); // viewport-drag pin
  let bucket: number | null = null;
  for (const vw of _allViewportWidthsAsc) {
    if (w <= vw) { bucket = vw; break; }
  }
  if (bucket === null) return undefined;
  const o = node.textOverrides[String(bucket)];
  return typeof o === 'string' ? o : undefined;
}

/** SVG presentation attributes that must be set via setAttribute (not style) */
const SVG_ATTRS = [
  'cx', 'cy', 'rx', 'ry', 'r', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'width', 'height', 'd', 'points', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap',
  'strokeLinejoin', 'strokeDasharray', 'viewBox', 'xmlns', 'preserveAspectRatio',
  'transform', 'opacity', 'fillRule', 'clipRule',
] as const;

// SVG attrs that define a shape's GEOMETRY and may be overridden per VARIANT.
// A per-variant geometry edit is stored as a style-keyed value in the variants
// object (so framer-motion animates it on the live site), but on the canvas it
// must be applied as an ATTRIBUTE: a raw `d`/coordinate is invalid as a CSS
// property (unlike fill/stroke, which the CSS style path applies directly), so
// without this overlay the SVG_ATTRS loop re-writes the BASE `d` and the tile
// snaps back to the primary shape. width/height are deliberately EXCLUDED — on
// the SVG wrapper they're the CSS box size, not geometry, so writing them as
// attributes would double-set the box. Per-VIEWPORT geometry stays the CSS `d:
// path(...)` route (browser applies the @container rule) and is unaffected here.
const GEOMETRY_VARIANT_ATTRS = new Set<string>([
  'd', 'points', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
]);

/**
/**
 * Resolve a RESPONSIVE raw-element attr (`node.responsiveAttrs[key]`) to the
 * value for the active replica width / variant on the canvas — mirroring the
 * source ternary that live React evaluates (`type={__mq0 ? 'date' : 'text'}`).
 * Variant override wins (most specific), then the smallest breakpoint whose
 * max-width still covers `vpWidth`; falls back to `base`. See responsive-attrs-gen.ts.
 */
function resolveResponsiveAttr(
  node: CanvasNode,
  key: string,
  base: string,
  vpWidth: number | undefined,
  variant: string | null | undefined,
): string {
  const r = node.responsiveAttrs?.[key];
  if (!r) return base;
  if (variant && r.variant && r.variant[variant] != null) return r.variant[variant];
  if (vpWidth != null && r.viewport) {
    const widths = Object.keys(r.viewport).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    for (const b of widths) if (vpWidth <= b) return r.viewport[b];
  }
  return base;
}

/**
 * Resolve styles for a node, merging framer-motion variant overrides.
 * Base styles come from node.styles. If a variantName is active and the node
 * has motionVariants, the variant's styles override the base.
 */
/** @internal Exported for testing. */
// Per-NODE memo of the variant-resolution result. `resolveVariantStyles` is a PURE function of
// `(node, variantName, vpWidth)` — it only reads fields off `node` (motionVariants / conditionalStyles /
// responsiveVariantMap / styles …). Parsed nodes are IMMUTABLE per parse cycle (nodesAtom re-parses → fresh
// objects), so a WeakMap keyed by the node object auto-invalidates on the next parse (old node GC'd, no entry).
// WHY: on a TEMPLATE the big Header component instance is a sibling under `root`, so every render cycle
// (each drag-move frame) re-resolved its WHOLE internal variant tree (~15 nodes) — the trace's
// `resolve-variant ×570`. A normal page keeps the Header static in the layout, so it never paid this; that's
// the template-only "drag is super slow" bottleneck. Caching skips the re-resolve for any UNCHANGED instance.
const variantStyleMemo = new WeakMap<CanvasNode, Map<string, Record<string, string>>>();

export function resolveVariantStyles(
  node: CanvasNode,
  variantName?: string | null,
  vpWidth?: number,
): Record<string, string> {
  const memoKey = `${variantName ?? ''}|${vpWidth ?? ''}`;
  const perNode = variantStyleMemo.get(node);
  const cached = perNode?.get(memoKey);
  if (cached) return cached;
  const result = resolveVariantStylesUncached(node, variantName, vpWidth);
  if (perNode) perNode.set(memoKey, result);
  else variantStyleMemo.set(node, new Map([[memoKey, result]]));
  return result;
}

function resolveVariantStylesUncached(
  node: CanvasNode,
  variantName?: string | null,
  vpWidth?: number,
): Record<string, string> {
  // For component master viewports: use variantName directly
  // For page viewport replicas: resolve from responsiveVariantMap using viewport width
  // Viewport-drag pin: page nodes on the dragged tile resolve at the gesture's
  // start width; template chrome (layout::) resolves live (see pin store).
  if (vpWidth) vpWidth = pinnedResolveWidth(node.id, vpWidth);
  let resolvedVariant = variantName;
  // A SPECIFIC per-tile variant in `responsiveVariantMap[vpWidth]` WINS over the passed `variantName`
  // (the instance's BASE variant) on a page replica — it's the per-viewport override (a per-viewport
  // variant VARIABLE's inline `initialVariant={__mqN ? var : base}`, or a data-responsive override).
  // Without this, an instance whose base resolves to a CONCRETE variant (e.g. 'default', when the
  // `: base` branch is a bound page var) passes that as `variantName`, so the `!resolvedVariant` block
  // below never runs and the tablet stays 'default'. (The Header "worked" only because its base
  // `initialVariant={…Sv}` resolved to null, letting that block fire.) `responsiveVariantMap` is set
  // ONLY on page instances — never on a component-master viewport — so this can't hijack a master pick.
  // Lookups go through `responsiveVariantForWidth` — media-query INTERVAL
  // semantics, not exact keys. Template chrome's map is keyed by the
  // TEMPLATE's breakpoints (768/375) while the page tile renders at the
  // PAGE's width (e.g. mobile resized to 585): the exact lookup missed and
  // the tile painted the DESKTOP nav while live showed the tablet burger
  // (user report 2026-08-06). Page instances hit their exact key as before.
  const mappedVariant = vpWidth ? responsiveVariantForWidth(node.responsiveVariantMap, vpWidth, node.responsiveVariantBp) : undefined;
  if (vpWidth && mappedVariant !== undefined
      && (node.motionVariants || node.conditionalStyles || node.hiddenOnVariants)) {
    resolvedVariant = mappedVariant;
  } else
  // `hiddenOnVariants` included so a conditionally-rendered (AnimatePresence) node
  // with NO variant styles still resolves its per-viewport variant — otherwise its
  // visibility check below never fires on a page instance and it shows on every tile.
  if (!resolvedVariant && vpWidth && node.responsiveVariantMap && (node.motionVariants || node.conditionalStyles || node.hiddenOnVariants)) {
    // A viewport width not listed in the responsive map IS the primary breakpoint
    // (the map only carries the non-default breakpoints). Fall back to the
    // instance's PRIMARY variant — `componentVariant` (the baked `initialVariant`
    // / scroll-variant `canvasVariant`), NOT a blind 'default'. This matters when
    // the map is keyed by a DIFFERENT breakpoint than the tile width — e.g. a
    // component INSIDE A TEMPLATE: its `data-responsive` carries the template's
    // breakpoints (…, 1440), but the merged page renders the primary tile at the
    // PAGE's width (e.g. 1463). `map[1463]` misses, so without the
    // `componentVariant` fallback the primary tile renders 'default' and a
    // hoisted/per-route resting variant (Header "Desktop Scrolled") never paints.
    // Same fallback chain the CMS-binding + size paths already use (search
    // `?? node.componentVariant`). `componentVariant` is null when the instance
    // has no explicit variant → 'default', so untouched instances are unchanged.
    resolvedVariant = mappedVariant ?? node.componentVariant ?? 'default';
  }

  // NESTED-instance fallback: a component instance nested INSIDE another component (on a plain page) is NOT a
  // page-LEVEL instance, so it never gets a `responsiveVariantMap` — its resolved variant lives ONLY in
  // `componentVariant` (the baked `initialVariant`, resolved through the parent's per-variant conditional, e.g.
  // `initialVariant={initialVariant === 'variant-1' ? seJoReVariant1 : 'default'}`). On a PAGE render
  // `variantName` is null (line ~1269) and there's no map, so the blocks above leave `resolvedVariant` null →
  // the node paints its DEFAULT entry (pink) instead of `motionVariants['variant-1']` (black). Use
  // componentVariant. Guarded by `!responsiveVariantMap` so it can NEVER override a page replica's per-tile pick.
  if (!node.responsiveVariantMap && (!resolvedVariant || resolvedVariant === 'default')
      && node.componentVariant && node.componentVariant !== 'default') {
    resolvedVariant = node.componentVariant;
  }

  // Apply conditional styles (e.g., order: variant === 'v1' ? 1 : 0) for the active variant
  let baseStyles = node.styles;
  if (resolvedVariant && node.conditionalStyles) {
    const overrides: Record<string, string> = {};
    for (const [prop, map] of Object.entries(node.conditionalStyles)) {
      overrides[prop] = map[resolvedVariant] ?? map['default'] ?? baseStyles[prop] ?? '';
    }
    if (Object.keys(overrides).length > 0) {
      baseStyles = { ...baseStyles, ...overrides };
    }
  }

  let result: Record<string, string>;
  if (!node.motionVariants) {
    result = baseStyles;
  } else {
    // INHERITANCE (the responsive-system model): a variant tile paints
    // base + DEFAULT entry + its own entry. The default entry carries the
    // primary's motion values (rotation, geometry d, …) — untouched variants
    // therefore follow the primary LIVE, exactly like an un-overridden
    // breakpoint follows the base. The variant's own (sparse) entry only
    // overrides what was independently touched.
    //
    // The 'default' entry is ALWAYS active (framer-motion `animate={['default', variant]}`), so apply it even
    // when NO specific variant resolved (`resolvedVariant` null). Otherwise a value parked ONLY in the default
    // entry — e.g. a Layout's `display: flex` on a component root — is dropped after an INSTANCE's
    // `style={{ display: "" }}` empties it from the base, and the node renders block (top-left) on the canvas
    // though it's flex live. A resolved NON-default variant then layers on top of the default entry.
    const defaultEntry = node.motionVariants['default'] as Record<string, string> | undefined;
    const variantStyles = (resolvedVariant && resolvedVariant !== 'default')
      ? node.motionVariants[resolvedVariant]
      : undefined;
    result = (defaultEntry || variantStyles)
      ? { ...baseStyles, ...(defaultEntry ?? {}), ...(variantStyles ?? {}) }
      : baseStyles;
  }
  // Diagnostic (only for per-tile-variant instances): does the expanded node actually carry the resolved
  // variant's entry, and did its background survive into the merged result? Pinpoints "resolved right but
  // wrong styles" — e.g. motionVariants missing the variant-2 key → falls back to default (black).
  if (node.responsiveVariantMap) {
    trace.fn('renderer:resolve-variant', {
      id: node.id, vpWidth, resolvedVariant,
      mvKeys: node.motionVariants ? Object.keys(node.motionVariants) : null,
      resolvedBg: (node.motionVariants?.[resolvedVariant ?? ''] as Record<string, string> | undefined)?.backgroundColor ?? null,
      resultBg: (result as Record<string, string>).backgroundColor ?? null,
    });
  }
  let folded = foldMotionTransforms(result);
  // attrX/attrY — motion's SVG ATTRIBUTE motion values, used as per-variant
  // ABSOLUTE x/y positions for group children (replica-context leftTopToXY).
  // Expose them as x/y so the GEOMETRY_VARIANT_ATTRS application sites set the
  // real attributes on the tile, exactly like live motion animates them. Done
  // AFTER the fold (plain x/y motion values are translate transforms and must
  // keep folding; attrX/attrY must NOT). Clone before mutating — `folded` can
  // alias node.styles when no motion props are present.
  if (folded.attrX != null || folded.attrY != null) {
    folded = { ...folded };
    if (folded.attrX != null) { folded.x = folded.attrX; delete folded.attrX; }
    if (folded.attrY != null) { folded.y = folded.attrY; delete folded.attrY; }
  }
  // Per-viewport component-instance PROP overrides. `expandComponent` lowered each
  // `data-responsive` prop to the style it drives (e.g. direction → flexDirection) and
  // keyed it by viewport width. Page instances hit their exact key (tiles render at
  // exactly their own breakpoint widths); INTERVAL lookup covers template chrome, whose
  // map is keyed by the TEMPLATE's breakpoints while the tile renders at the PAGE's
  // width — live's withResponsiveProps matches by width range, so the canvas must too
  // (same class as the resolvedVariant interval fix above). Applied LAST so it wins.
  if (vpWidth && node.responsivePropStyles) {
    const propStyles = responsiveVariantForWidth(node.responsivePropStyles, vpWidth, node.responsiveVariantBp);
    if (propStyles) folded = { ...folded, ...propStyles };
  }
  // AnimatePresence + conditional render visibility (the pattern from
  // setVariantVisibilityInCode). When the active variant is in the node's
  // `hiddenOnVariants` set, apply `display: 'none'` on the canvas so the
  // tile reflects what live preview renders (unmounted via the conditional).
  // Applied LAST, after the motionVariants merge and every other layer: the
  // node's DEFAULT variant entry often carries its own `display: 'flex'`
  // (Layout writes park display there), and merging the hide into baseStyles
  // let that entry override it — "Hide Yes hid on live but the canvas tile
  // still showed it" (user report 2026-08-06). Live UNMOUNTS the node
  // regardless of any style, so nothing may out-rank the hide here.
  if (resolvedVariant && node.hiddenOnVariants?.has(resolvedVariant)) {
    folded = { ...folded, display: 'none' };
  }
  return folded;
}

/**
 * Fold framer-motion INDEPENDENT transform props (rotate / scale / x / y /
 * skew) into a single CSS `transform` for the STATIC canvas. The source code
 * stores these as motion props (so live motion composes them with the layout
 * FLIP); the canvas has no motion, so it renders them as CSS here. Any motion
 * props are removed and combined (after any pre-existing CSS `transform`, e.g.
 * a pin's `translate(-50%,-50%)`) so the tile matches the animated result.
 * No-op when the map carries no motion transform props.
 */
function foldMotionTransforms(styles: Record<string, string>): Record<string, string> {
  if (!hasMotionTransformProp(styles)) return styles;
  const motionCss = motionPropsToCSSTransform(styles);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (MOTION_TRANSFORM_PROPS.has(k)) continue; // drop the motion props themselves
    out[k] = v;
  }
  if (motionCss) {
    const existing = out.transform && out.transform !== 'none' ? out.transform : '';
    out.transform = existing ? `${existing} ${motionCss}` : motionCss;
  }
  return out;
}

/**
 * Resolve a node's per-variant text. Returns the text for the active variant
 * from `node.conditionalText` (parsed from a `{variant === 'x' ? 'a' : 'b'}`
 * text child), or null when the node has no per-variant text or no variant is
 * active. Same variant-resolution path as `resolveVariantStyles`.
 */
function resolveConditionalText(
  node: CanvasNode,
  variantName?: string | null,
  vpWidth?: number,
): string | null {
  if (!node.conditionalText) return null;
  if (vpWidth !== undefined) vpWidth = pinnedResolveWidth(node.id, vpWidth); // viewport-drag pin
  // A SPECIFIC per-viewport variant (page replica) WINS over the base variantName — see
  // resolveVariantStyles. Interval lookup (responsiveVariantForWidth), same as there.
  const mappedTextVariant = vpWidth !== undefined
    ? responsiveVariantForWidth(node.responsiveVariantMap, vpWidth, node.responsiveVariantBp) : undefined;
  let variant: string | null | undefined =
    mappedTextVariant !== undefined ? mappedTextVariant : variantName;
  if (!variant && vpWidth !== undefined && node.responsiveVariantMap) {
    // Same primary-variant fallback as resolveVariantStyles: an unlisted tile
    // width (the page primary, esp. when the map is template-breakpoint-keyed)
    // resolves the instance's `componentVariant`, not a blind null.
    variant = node.componentVariant ?? null;
  }
  // NESTED-instance fallback — the text twin of resolveVariantStyles' block:
  // an instance nested inside another component (or on a plain page render,
  // where variantName is null) has no responsiveVariantMap; its resolved
  // variant lives ONLY in `componentVariant` (the baked `initialVariant`).
  // Without this, a Button instance with initialVariant="variant-3" painted
  // variant-3 STYLES (resolveVariantStyles has the fallback) but DEFAULT
  // TEXT — "CONTACT US instead of the variant's text; live site correct,
  // canvas wrong" (user report 2026-08-05).
  if (!node.responsiveVariantMap && (!variant || variant === 'default')
      && node.componentVariant && node.componentVariant !== 'default') {
    variant = node.componentVariant;
  }
  if (!variant) return null;
  return node.conditionalText[variant] ?? node.conditionalText['default'] ?? null;
}

/**
 * Render nodes into the container with DOM diffing.
 * Root elements get `data-viewport` + `container-type: inline-size` directly (no wrapper).
 * Replica viewports are clones with prefixed IDs.
 */
/** Locales whose script is right-to-left — drives the canvas `dir` attr
 *  (mirrored by the live site's Providers). Keyed by primary subtag. */
const RTL_LOCALES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ku', 'dv', 'yi']);

// ─── Subtree patch-skip signatures ──────────────────────────────────────────
// Incremental subtree patching: every node gets a content signature that
// folds in its whole subtree. patchElement stores the signature (plus render
// context) on the DOM element after a completed patch; when the next render
// sees the same key, the ENTIRE subtree is skipped. An undo / drag-commit /
// single-style edit then costs only the changed branch instead of a full
// 800-node × 3-viewport patch pass (live find 2026-07-17: ~200ms renderNodes
// per Cmd+Z on a big page).
//
// The cache is rebuilt per renderNodes call (node objects are fresh
// structured-clones per render in the sandbox; DirectBridge callers may
// mutate node objects between renders — a fresh stringify per render always
// sees current content).
let _sigCache: Map<string, { sig: string; dynamic: boolean }> | null = null;
let _patchSkipCount = 0;
// FILE-SWITCH renders set this: the per-element `__revymePatchKey` subtree
// skip must not be trusted — the keys were stamped by the PREVIOUS file's
// render and node ids collide across files by design (every page and every
// LayoutClient roots at `data-id="root"`). A stale-but-matching key let the
// whole old subtree survive a switch (the home page rendered inside a fresh
// template's viewports, user report 2026-07-27). Keys are still RE-STAMPED
// during the distrusted walk, so the next same-file render skips normally.
let _distrustPatchKeys = false;
// Fingerprint of the render's RESPONSIVE CSS input (page <style> + carried
// component CSS — the exact string parseResponsiveBreakpoints consumes).
// Folded into every patch key: patchElement/buildNodeElement bake @media
// band values (e.g. a replica `display:none`) into INLINE styles, so a band
// change with an UNCHANGED node model must still bust the subtree skip —
// otherwise an undo that removes the band leaves the stale inline value
// hidden behind a matching patch key ("Cmd+Z doesn't un-hide the tablet
// copy until a page switch", live find 2026-07-22).
let _responsiveCssFp = '';
// Active render locale — folded into every patch key so a locale SWITCH
// always busts the subtree skip. Locale styles are applied INLINE
// (applyLocaleOverrides); on a DESIGN-COMPONENT MASTER with no text
// translations the overrides map is empty on the switch-back-to-default
// render, the skip stayed eligible, and the whole subtree kept the previous
// locale's inline values ("stuck on French until I re-enter the component",
// live find 2026-07-22). Pages dodged it only because their non-empty
// translation map already disabled the skip.
let _activeRenderLocale = '';

const SIG_JSON_REPLACER = (_key: string, value: unknown): unknown =>
  value instanceof Set ? Array.from(value as Set<string>).sort() : value;

/** Per-node subtree signature + "dynamic" flag. `dynamic` marks subtrees whose
 *  rendering depends on data OUTSIDE the node model (CMS collections, code
 *  components, bindings) — those must never be skipped, because their inputs
 *  can change without the node signature changing. */
function nodeSigEntry(
  node: CanvasNode,
  allNodes: Map<string, CanvasNode>,
): { sig: string; dynamic: boolean } {
  const cached = _sigCache?.get(node.id);
  if (cached) return cached;
  let childSigs = '';
  let dynamic = Boolean(
    node.collectionList || node.inlineMapData || node.isCodeComponent ||
    node.binding || node.attrBindings?.length || node.styleBindings?.length ||
    node.propBindings?.length || node.isCollectionTemplate,
  );
  for (const cid of node.children) {
    const child = allNodes.get(cid);
    if (child) {
      const entry = nodeSigEntry(child, allNodes);
      childSigs += entry.sig + ',';
      dynamic = dynamic || entry.dynamic;
    } else {
      childSigs += cid + ':missing,';
    }
  }
  const entry = {
    sig: simpleHash(JSON.stringify(node, SIG_JSON_REPLACER)) + ':' + simpleHash(childSigs),
    dynamic,
  };
  _sigCache?.set(node.id, entry);
  return entry;
}

/** Invalidate a DOM element's stored patch key. Every IMPERATIVE style/content
 *  write (bridge patchStyles, setInnerHTML, lift/restore) must call this so
 *  the next render fully re-patches that element — preserving the old
 *  "render restores canvas state" behavior exactly where it's relied upon. */
export function clearPatchKey(el: Element): void {
  delete (el as HTMLElement & { __revymePatchKey?: string }).__revymePatchKey;
}

/**
 * Register style keys an IMPERATIVE write just put on an element, so the next
 * render's stale-clear can reconcile them against the model.
 *
 * `_prevPatchedKeys` deliberately tracked only what patchElement itself wrote —
 * but that leaves a hole the moment an imperative write ADDS a property and the
 * post-flush render is skipped (which is the normal path: `updateStyles` is in
 * `IMPERATIVELY_PATCHED_MUTATIONS`, so patching the DOM directly arms the skip).
 * The key then exists in the DOM but in no render's key set, so when it later
 * disappears from the model NOTHING clears it.
 *
 * Reported as: set padding on a CMS row → ⌘Z → the code loses `padding` but the
 * canvas keeps it, until a redo+undo or a page switch rebuilt the element
 * (2026-07-26). The trace showed the whole chain — the style write, then
 * `CanvasRenderer:skip-canvasUpdating`, then an undo render with ZERO
 * `renderer:stale-clear-key` traces.
 *
 * Safe because every caller is a model-bound style commit (bridge patchStyles /
 * patchMultipleStyles / patchAttrsAndStyles and their ghost fan-out): a render
 * reconciling them back to the model IS the documented "render restores canvas
 * state" behavior. Styles that must outlive a render — the drag lift's
 * `position/left/top/zIndex` — are protected upstream by `_dragLockedNodeIds`,
 * which skips those elements entirely.
 */
export function trackImperativeStyleKeys(el: Element, keys: Iterable<string>): void {
  const target = el as HTMLElement;
  const existing = _prevPatchedKeys.get(target);
  if (existing) {
    for (const k of keys) existing.add(k);
    return;
  }
  _prevPatchedKeys.set(target, new Set(keys));
}

/** The style keys the next render's stale-clear will reconcile for this element
 *  (renderer-written + imperatively tracked). Exposed for tests + diagnostics. */
export function getTrackedStyleKeys(el: Element): ReadonlySet<string> | undefined {
  return _prevPatchedKeys.get(el as HTMLElement);
}

/** Remove keys from an element's stale-clear reconciliation set — the inverse
 *  of `trackImperativeStyleKeys`, for writes that are NOT model-bound commits.
 *
 *  The drag lift/restore cycle is the caller: `restoreNode` re-writes the
 *  element's PRE-LIFT inline values via `applyTwoPass`, which tracks every key
 *  it writes. But tracking hands a key to the next render's stale-clear, which
 *  reconciles it against the node's resolved styles — and a BUILD-ONLY inline
 *  prop (an instance wrapper's variant-sized width/height, applied by
 *  renderNodes, never present in patchElement's resolvedStyles) has no model
 *  entry, so a tracked copy of it gets CLEARED by whatever render comes next.
 *  Reported as: layout-drag a component instance (restore correct, tracked),
 *  then grid-drag anywhere else — its commit render stale-cleared the
 *  wrapper's height and the instance below collapsed (2026-07-27). A restore
 *  must return the element's TRACKING state to pre-lift truth, not just its
 *  inline values. */
export function untrackImperativeStyleKeys(el: Element, keys: Iterable<string>): void {
  const existing = _prevPatchedKeys.get(el as HTMLElement);
  if (!existing) return;
  for (const k of keys) existing.delete(k);
}

/** Invalidate the patch key on an element AND every ancestor. Required by all
 *  imperative writes: a skipped ANCESTOR never descends, so clearing only the
 *  written element would leave it un-restored on the next render. */
export function clearPatchKeyChain(el: Element | null): void {
  let cur: Element | null = el;
  while (cur) {
    clearPatchKey(cur);
    cur = cur.parentElement;
  }
}

export function renderNodes(
  container: HTMLElement,
  nodes: Map<string, CanvasNode>,
  _selectedId: string | null,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
  viewports?: ViewportConfig[],
  code?: string,
  activeLocale?: string,
  defaultLocale?: string,
  localeOverrides?: Map<string, NodeOverride>,
  distrustPatchKeys?: boolean,
) {
  const t0 = performance.now();
  _sigCache = new Map();
  _patchSkipCount = 0;
  _distrustPatchKeys = !!distrustPatchKeys;
  pauseDOMObserver();

  // Sweep LIVE-!important residue before patching. A replica scrub patches
  // inline with !important (cascade parity with the committed @container
  // rule) and the replica commit SKIPS the render, so the inline lingers —
  // invisible while the rule holds the same value, but an UNDO that removes
  // the rule left the stale inline winning until a page switch ("Cmd+Z
  // doesn't update the DOM", live find 2026-07-21). Clearing here lets the
  // patch walk + rebuilt @container CSS re-assert the restored truth on
  // EVERY render, patch and full alike.
  {
    const marked = container.querySelectorAll('[data-live-important]');
    for (const el of Array.from(marked) as HTMLElement[]) {
      const props = (el.getAttribute('data-live-important') || '').split(',');
      for (const p of props) { if (p) try { el.style.removeProperty(p); } catch { /* skip */ } }
      el.removeAttribute('data-live-important');
      clearPatchKeyChain(el);
    }
    if (marked.length > 0) trace.action('renderer:live-important-swept', { count: marked.length });
  }

  // Prevent <a> link navigation on canvas — clicks on links should select, not navigate.
  // Uses a capturing listener so it fires before any other handler.
  if (!(container as any).__linkGuard) {
    container.addEventListener('click', (e: Event) => {
      const target = (e.target as HTMLElement)?.closest?.('a');
      if (target && container.contains(target)) {
        e.preventDefault();
      }
    }, true); // capture phase
    (container as any).__linkGuard = true;
  }

  // Freeze EVERY <video> on the canvas on its first frame. A playing video
  // constantly decodes + repaints — a real perf drain while editing. This is
  // CANVAS-ONLY: the Renderer patches the sandbox DOM; the live site renders the
  // real React code and still autoplays. A MutationObserver catches every video
  // however it's added (node render, bgVideo, code component, slot child) and a
  // `play`→`pause` net undoes any attempt to start (autoplay attr or code .play()).
  if (!(container as any).__videoFreeze) {
    const freezeVideo = (v: HTMLVideoElement) => {
      if ((v as any).__frozen) return;
      (v as any).__frozen = true;
      v.autoplay = false;
      v.removeAttribute('autoplay');
      v.loop = false;
      v.muted = true;
      v.addEventListener('play', () => { try { v.pause(); } catch { /* ignore */ } });
      // Park on the decoded first frame (not a black frame) once data arrives.
      const park = () => { try { v.pause(); } catch { /* ignore */ } };
      v.addEventListener('loadeddata', park, { once: true });
      if (v.readyState >= 2) park();
      try { v.pause(); } catch { /* ignore */ }
    };
    container.querySelectorAll('video').forEach((v) => freezeVideo(v as HTMLVideoElement));
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (n instanceof HTMLVideoElement) freezeVideo(n);
          else if (n instanceof HTMLElement) n.querySelectorAll('video').forEach((v) => freezeVideo(v as HTMLVideoElement));
        });
      }
    });
    obs.observe(container, { childList: true, subtree: true });
    (container as any).__videoFreeze = obs;
  }

  // Partition root nodes
  const viewportRoots: CanvasNode[] = [];
  const canvasRoots: CanvasNode[] = [];
  for (const node of nodes.values()) {
    if (!node.parentId) {
      // Skip canvas-nodes that came from a COMPONENT FILE's expansion
      // (slot-hoisted `const cn_X = …` decls in a master that's being
      // rendered as an instance on this page). They belong to the
      // component instance and render INSIDE it via the slot-children
      // wiring in CodeComponentHost — letting them ALSO be picked up
      // as page-canvas-level free-floating roots leaks the master's
      // slot canvas-nodes onto the page (visible symptom: ghost "Frame"
      // blocks appearing outside the viewport, at the master's authoring
      // coords, when a page hosts a slot-bearing component instance).
      // `componentInstanceId` is set only during expandComponent, so
      // this is the cheap, exact discriminator.
      if (node.isCanvasNode && node.componentInstanceId) continue;
      if (node.isCanvasNode) canvasRoots.push(node);
      else viewportRoots.push(node);
    }
  }

  // No viewports — simple render
  if (!viewports || viewports.length === 0) {
    const fragment = document.createDocumentFragment();
    for (const root of viewportRoots) {
      fragment.appendChild(buildNodeElement(root, nodes, onNodeMouseDown));
    }
    container.replaceChildren(fragment);
    resumeDOMObserver();
    return;
  }

  // ─── Inject CSS from <style> blocks ──────────────────────────────────
  // Merges code-extracted CSS with any imperatively-injected rules (e.g. ::after borders).
  // Without merge, renderNodes would overwrite imperative injections before mutation queue flushes.
  if (code) {
    // extractStyleCSS regexes the WHOLE code string (400KB+ on big imports)
    // — cache by string identity. Mid-drag renders re-render with the SAME
    // code (the deferred-drag-flush stashes the setCode fan-out), so every
    // transition render was paying the full-file scan for an unchanged
    // result.
    let pageCSS: string;
    if (code === _lastCssCode) {
      pageCSS = _lastCssResult;
    } else {
      pageCSS = extractStyleCSS(code) || '';
      _lastCssCode = code;
      _lastCssResult = pageCSS;
    }
    // Merge layout CSS: when the code is a page (not the layout itself),
    // include responsive styles from the page's TEMPLATE LayoutClient so
    // template nodes (navbar, footer) show correct responsive overrides
    // in replica viewports. Walks via `getLayoutForPage` so a page in
    // `app/(marketing)/` picks up `app/(marketing)/LayoutClient.tsx` —
    // not the (now-non-existent) bare root LayoutClient.
    // Rewrite selectors: [data-id="X"] → [data-id="layout::X"] to match prefixed IDs.
    if (!code.includes('LayoutClient') && !code.includes('RootLayout')) {
      // PREFER the parent-pushed layout CSS (already prefixed): in the sandbox
      // iframe projectFS is a STUB, so the fs walk below reads nothing — the
      // template's @media overrides silently never reached templated-page
      // tiles (live find 2026-07-13: footer-nav flex-wrap). The fs path stays
      // as the fallback for parent-side renders (DirectBridge) and tests.
      const pushedLayoutCss = getPushedLayoutCss();
      if (pushedLayoutCss !== null) {
        if (pushedLayoutCss) pageCSS = pageCSS + '\n' + pushedLayoutCss;
        trace.action('renderer:layout-css-merge', { source: 'pushed', mergedLayoutCssLen: pushedLayoutCss.length });
      } else {
        const activeFile = getActiveFilePath();
        const layoutPath = getLayoutForPage(activeFile);
        const clientPath = layoutPath ? getLayoutClientPath(layoutPath) : null;
        const layoutClientCode = clientPath ? projectFS.readFile(clientPath) : null;
        let mergedLayoutCssLen = 0;
        if (layoutClientCode) {
          let layoutCSS = extractStyleCSS(layoutClientCode);
          if (layoutCSS) {
            layoutCSS = layoutCSS.replace(/\[data-id="([^"]+)"\]/g, '[data-id="layout::$1"]');
            pageCSS = pageCSS + '\n' + layoutCSS;
            mergedLayoutCssLen = layoutCSS.length;
          }
        }
        trace.action('renderer:layout-css-merge', {
          source: 'fs', activeFile, layoutPath, clientPath,
          clientCodeLen: layoutClientCode?.length ?? 0, mergedLayoutCssLen,
        });
      }
    }
    // Inject preset tokens CSS (:root { } variables) before element styles
    // so var() references in element styles can resolve.
    // Wrap with markers so refreshCanvasTokens() can replace just this section later.
    // Extract ONLY :root tokens and @keyframes from globals.css.
    // NEVER include: @import (loads fonts globally), * resets, body/html styles, a/img styles.
    // Scope :root tokens to [data-content-root] so they don't affect the builder UI.
    const rawGlobalsCSS = projectFS.readFile('app/globals.css');
    let tokensCSS = '';
    // Font CSS (`@import` + `@font-face`) is kept SEPARATE from tokensCSS and
    // rendered into a dedicated stable <style> (see below). Re-setting a <style>
    // that holds @import/@font-face makes the browser re-process it (re-fetch /
    // re-apply the font), flashing custom-font text → FOUT on every pan/render.
    let fontsCSS = '';
    if (rawGlobalsCSS) {
      const safeBlocks: string[] = [];
      const fontFaceBlocks: string[] = [];
      // Extract @import rules (typically Google Fonts) and keep them — without
      // them the iframe falls back to default fonts even when the user's CSS
      // references custom families. They MUST appear before any other rule
      // per CSS spec, so we collect them up front and prepend at output time.
      const fontImports: string[] = [];
      const withoutImports = rawGlobalsCSS.replace(/@import\s+url\([^)]*\)[^;]*;/g, (match) => {
        fontImports.push(match);
        return '';
      });
      // Extract :root and [data-theme] blocks — scope them to canvas content
      const rootRx = /:root\s*\{([^}]*)\}/gs;
      let m;
      while ((m = rootRx.exec(withoutImports)) !== null) {
        // Scope to canvas content area so tokens don't leak to builder UI
        safeBlocks.push(`[data-content-root] {${m[1]}}`);
      }
      // Also extract @keyframes (safe to include globally)
      // Use brace-depth counting instead of regex (nested braces break regex)
      {
        const KF = '@keyframes';
        let ki = 0;
        while (ki < withoutImports.length) {
          const kfStart = withoutImports.indexOf(KF, ki);
          if (kfStart === -1) break;
          let j = kfStart + KF.length;
          while (j < withoutImports.length && withoutImports[j] !== '{') j++;
          if (j >= withoutImports.length) break;
          let depth = 1; j++;
          while (j < withoutImports.length && depth > 0) {
            if (withoutImports[j] === '{') depth++;
            else if (withoutImports[j] === '}') depth--;
            j++;
          }
          safeBlocks.push(withoutImports.slice(kfStart, j));
          ki = j;
        }
      }
      // Extract @font-face blocks (custom / workspace fonts). Safe to include
      // globally — they only DECLARE a face for the iframe to resolve, they
      // don't reset or style anything. Without this, text bound to a custom
      // family falls back to a system font on the canvas even though the
      // @font-face exists in globals.css. Brace-depth scan (same as
      // @keyframes) so the single block is captured exactly.
      {
        const FF = '@font-face';
        let fi = 0;
        while (fi < withoutImports.length) {
          const ffStart = withoutImports.indexOf(FF, fi);
          if (ffStart === -1) break;
          let j = ffStart + FF.length;
          while (j < withoutImports.length && withoutImports[j] !== '{') j++;
          if (j >= withoutImports.length) break;
          let depth = 1; j++;
          while (j < withoutImports.length && depth > 0) {
            if (withoutImports[j] === '{') depth++;
            else if (withoutImports[j] === '}') depth--;
            j++;
          }
          fontFaceBlocks.push(withoutImports.slice(ffStart, j));
          fi = j;
        }
      }
      // Extract [data-theme] blocks
      const themeRx = /\[data-theme[^\]]*\]\s*\{([^}]*)\}/gs;
      while ((m = themeRx.exec(withoutImports)) !== null) {
        safeBlocks.push(`[data-content-root] {${m[1]}}`);
      }
      // Tokens = :root vars + @keyframes + themes ONLY (NO fonts — those go to
      // `fontsCSS` → the stable [data-canvas-fonts] sheet). This also makes the
      // marker block match refreshCanvasTokens' regex (which never matched fonts),
      // so live token updates stay in lockstep.
      tokensCSS = safeBlocks.join('\n');
      // @import MUST be the first rule in its sheet (CSS spec) → imports first,
      // then @font-face declarations.
      fontsCSS = [...fontImports, ...fontFaceBlocks].join('\n');
    }
    // Tokens block contains :root vars, @keyframes, and theme blocks. Font
    // @imports were extracted separately above (they MUST appear before any
    // other rule in the stylesheet per CSS spec, otherwise the browser
    // discards them silently and fonts never load).
    const tokensBlock = tokensCSS
      ? `/* canvas-tokens-start */\n${tokensCSS}\n/* canvas-tokens-end */\n`
      : '';
    // Disable all CSS animations and transitions in the canvas — they are for live website only.
    // GSAP/framer-motion animations are controlled separately via timeline preview.
    // Overlays are HIDDEN on canvas by default — baked in here (every render,
    // both frames) rather than relying on the parent's one-shot injectCanvasCSS,
    // which can fire before the sandbox connects and never land, leaving every
    // overlay visible on a fresh page load. The overlay-edit-mode show rule
    // (`[data-id="x"][data-overlay-node]`, injected by Canvas.tsx) out-specifies
    // this base rule, so the edited overlay still appears.
    const canvasOverrides = `[data-content-root] * { animation: none !important; transition: none !important; }\n`
      + `[data-overlay-node] { display: none !important; }\n`;
    // Component-instance carried CSS (raw) — the master's <style> block, flattened away during
    // expansion, rewritten by expandComponent to the prefixed instance id (`instanceId:masterId`) and
    // stowed on each expanded root's `afterCSS`. This carries BOTH the overlay ::after rules AND the
    // master's @media responsive rules (e.g. a typography preset's per-breakpoint font-size). Collected
    // BEFORE parsing breakpoints so instance nodes resolve per-viewport. Dedup by content so multiple
    // instances of the same component each contribute (their prefixes differ).
    let componentAfterCSSRaw = '';
    {
      const seen = new Set<string>();
      for (const node of nodes.values()) {
        if (!node.afterCSS) continue;
        if (seen.has(node.afterCSS)) continue;
        seen.add(node.afterCSS);
        // A layout/template component instance rendered ON A PAGE carries a `layout::`-prefixed id, but its
        // afterCSS selector was stowed UNPREFIXED at parse time (`[data-id="instanceId:masterId"]::after`),
        // so it never matches the `layout::…` element → an overlay border (e.g. a hoisted `border` variable)
        // shows when the TEMPLATE is the active file but vanishes on a PAGE that applies it. Prefix the
        // selector to match the merged-layout id, mirroring the layoutCSS `[data-id]`→`[data-id="layout::"]`
        // rewrite above (~line 999). Template-as-active-file nodes aren't prefixed, so they're untouched.
        componentAfterCSSRaw += '\n' + (node.id.startsWith('layout::')
          ? node.afterCSS.replace(/\[data-id="(?!layout::)([^"]+)"\]/g, '[data-id="layout::$1"]')
          : node.afterCSS);
      }
      if (seen.size > 0) {
        trace.action('renderer:component-after-css', { ruleCount: seen.size });
      }
    }

    // PAGE bands must never ORDER template chrome. The flat template merge
    // makes `layout::` nodes siblings of the page sections (bracketed at
    // ±100000 so sections slot between); a pre-guard reorder wrote
    // section-space `order` for chrome into a replica band and the template
    // FOOTER rendered between sections on that tile (2026-08-06). The
    // selectors are DEAD on the live site (the `layout::` prefix is a
    // canvas-merge artifact — no such data-id exists in real DOM), so
    // stripping the `order` declarations here makes the canvas match live
    // even for already-corrupted pages. Chrome keeps every other banded
    // style; only `order` is template-owned placement.
    const pageCSSClean = pageCSS
      ? pageCSS.replace(/(\[data-id="layout::[^"]*"\]\s*\{)([^}]*)(\})/g,
          (_m, open: string, body: string, close: string) =>
            open + body.replace(/(?:^|;)\s*order\s*:\s*[^;}]+;?/g, ';').replace(/^;/, '') + close)
      : pageCSS;

    // Parse responsive overrides for patchElement to merge into inline styles — from BOTH the page CSS
    // AND the carried component CSS, so a typography preset's @media rules on a COMPONENT INSTANCE
    // resolve to the instance's per-viewport tier (keyed by the prefixed `instanceId:masterId`). Without
    // the carried CSS here, instances only ever painted the base/desktop tier on every tile. Merging into
    // inline styles (rather than relying on raw @container CSS) prevents !important-vs-inline flicker.
    setResponsiveBreakpoints(parseResponsiveBreakpoints((pageCSSClean ?? '') + componentAfterCSSRaw));
    _responsiveCssFp = simpleHash((pageCSSClean ?? '') + componentAfterCSSRaw);
    // A component master (file with `variantConfig`) resolves typography/responsive overrides to the
    // highest breakpoint (base/desktop) — see `_isComponentMaster`. Real pages keep per-viewport.
    setIsComponentMaster(code?.includes('variantConfig') ?? false);
    // Capture every configured viewport width once per render pass — used by
    // patchElement's text-override bucket lookup. Same source canvas-dnd's
    // breakpoint helpers use; viewports can be added/removed/resized
    // dynamically by the user, so we re-read each pass.
    // Viewport-drag pin: the DRAGGED viewport's entry must stay at the PIN
    // width in this list. During a crossing re-render the input carries the
    // LIVE width (e.g. 315), so a text-override bucket walk found "smallest
    // vp ≥ pinned 314" = 315 and missed the override keyed "314" — primary
    // text flashed mid-drag even though the QUERY width was pinned. Pinning
    // the list fixes every list consumer at once.
    const bandPinForWidths = viewportBandPinOps.get();
    setAllViewportWidthsAsc((viewports ?? [])
      .map((v) => (bandPinForWidths && v.id === bandPinForWidths.vpId ? bandPinForWidths.pinWidth : v.width))
      .filter((w) => Number.isFinite(w) && w > 0)
      .sort((a, b) => a - b));

    // Source code uses @media queries (real CSS). Canvas needs @container so each side-by-side viewport
    // responds to its OWN width, not the browser window. Also convert :hover to [data-hover-preview] so
    // hover effects only show during the CSS Hover editor preview, not on normal canvas hover (which is
    // used for selection). Both transforms apply to the carried component CSS too — its @media rules must
    // become @container, otherwise an instance's responsive resolves against the whole canvas window.
    let canvasCSS = pageCSSClean ? pageCSSClean.replace(/@media\s*\(/g, '@container (') : '';
    canvasCSS = canvasCSS.replace(/:hover\s*\{/g, '[data-hover-preview]{');
    let componentAfterCSS = componentAfterCSSRaw
      .replace(/@media\s*\(/g, '@container (')
      .replace(/:hover\s*\{/g, '[data-hover-preview]{');
    // Resolve vw/vh INSIDE the @container blocks per matching tile width —
    // native CSS would resolve them against the iframe window, so a
    // `clamp(…vw…) !important` override painted the same (huge) size on every
    // tile and beat the correctly-resolved inline merge. Blocks matching
    // multiple tiles are duplicated per width. See responsive-units.ts.
    canvasCSS = resolveContainerQueryUnits(canvasCSS, _allViewportWidthsAsc);
    componentAfterCSS = resolveContainerQueryUnits(componentAfterCSS, _allViewportWidthsAsc);
    // Component master → drop all responsive @container blocks so the inline base/desktop styles win on
    // every variant tile (the `!important` @container rules would otherwise resolve against each narrow
    // tile and collapse the text to the smallest breakpoint). Pairs with `_isComponentMaster` short-
    // circuiting the patchElement merge. Real page tiles keep their responsive CSS.
    if (_isComponentMaster) {
      canvasCSS = stripResponsiveBlocks(canvasCSS);
      componentAfterCSS = stripResponsiveBlocks(componentAfterCSS);
    }
    // tokensBlock = `:root` vars + @keyframes + themes (marker-wrapped for
    // refreshCanvasTokens). Font CSS (@import + @font-face) is NOT here — it
    // lives in the dedicated stable [data-canvas-fonts] <style> below, so the
    // frequent rewrites of [data-canvas-styles] (per-render + imperative
    // inject/removeCanvasCSS, e.g. backdrop-filter toggling on pan) never
    // re-process the import/face → no custom-font FOUT.
    const css = tokensBlock + canvasOverrides + canvasCSS + componentAfterCSS;
    const styleEl = container.querySelector('[data-canvas-styles]') as HTMLStyleElement | null;
    // Imperative rules tagged with the `/*persist*/` body marker (overlay-mode
    // visibility/tint rules from Canvas.tsx) survive this rebuild wholesale —
    // without it, the first re-render after e.g. an overlay drag commit wiped
    // them and the edit-mode tint vanished mid-session.
    const persistRules = (text: string): string[] =>
      text.match(/[^{}]+\{[^}]*\/\*persist\*\/[^}]*\}/g) || [];
    if (css) {
      const el = styleEl || getOrCreateCanvasStyleEl();
      if (el) {
        // Preserve imperatively-injected ::after rules not yet in code
        const current = el.textContent || '';
        // Border-overlay rules key off `data-id` now (renders in preview/live); legacy `data-node-id`
        // rules are still matched so older files keep working in the canvas.
        const afterRules = current.match(/\n\[data-(?:node-)?id="[^"]+"\]::after\s*\{[^}]*\}/gs) || [];
        let merged = css;
        for (const rule of afterRules) {
          // Only preserve if the code doesn't already contain this exact selector
          const selectorMatch = rule.match(/(\[data-(?:node-)?id="[^"]+"\]::after)/);
          if (selectorMatch && !css.includes(selectorMatch[1])) {
            merged += rule;
          }
        }
        for (const rule of persistRules(current)) {
          if (!merged.includes(rule)) merged += '\n' + rule.trim();
        }
        if (el.textContent !== merged) el.textContent = merged;
      }
    } else if (styleEl) {
      // No CSS from code — but preserve imperative ::after + persist rules if any
      const current = styleEl.textContent || '';
      const afterRules = current.match(/\n\[data-(?:node-)?id="[^"]+"\]::after\s*\{[^}]*\}/gs) || [];
      const keep = [...afterRules, ...persistRules(current).map(r => '\n' + r.trim())];
      if (keep.length > 0) {
        const preserved = keep.join('');
        if (styleEl.textContent !== preserved) styleEl.textContent = preserved;
      } else {
        styleEl.remove();
      }
    }

    // ── Perf: dedicated static <style data-canvas-perf> (canvas-only) ──
    // CSS containment scopes style/layout recalculation: without it every
    // drag-frame style write dirtied the WHOLE document and the next
    // forced-layout read (rect/corners measure) re-laid-out all tiles
    // (~100-220ms recurring stalls on an 11k-px page, live find 2026-07-17).
    // `layout style` only — no `size` (tiles/sections are content-sized) and
    // no `paint` (free-floating hero chips may overhang section bounds).
    // Canvas-only: this style element lives in the sandbox document and never
    // touches user source or the published site.
    {
      let perfEl = container.querySelector('[data-canvas-perf]') as HTMLStyleElement | null;
      if (!perfEl) {
        perfEl = document.createElement('style');
        perfEl.setAttribute('data-canvas-perf', 'true');
        perfEl.textContent =
          `[data-viewport] { contain: layout style; }\n` +
          `[data-viewport] > [data-node-id] { contain: layout style; }\n`;
        container.prepend(perfEl);
        trace.dom('renderer:perf-containment-injected', {});
      }
    }

    // ── Fonts: dedicated stable <style data-canvas-fonts> ──
    // @import (Google Fonts) + @font-face (custom fonts) live here, NOT in the
    // dynamic [data-canvas-styles]. Re-setting a <style> that holds @import /
    // @font-face makes the browser RE-PROCESS them (re-fetch / re-apply), which
    // flashes custom-font text back to the fallback (FOUT) — it fired on every
    // pan (Canvas.tsx toggles backdrop-filter via inject/removeCanvasCSS on
    // pan start/end) and every render. Rewritten ONLY when the font CSS actually
    // changes, and prepended so @import precedes everything per the CSS spec.
    {
      let fontsEl = container.querySelector('[data-canvas-fonts]') as HTMLStyleElement | null;
      if (fontsCSS) {
        if (!fontsEl) {
          fontsEl = document.createElement('style');
          fontsEl.setAttribute('data-canvas-fonts', 'true');
          container.prepend(fontsEl);
        }
        if (fontsEl.textContent !== fontsCSS) {
          fontsEl.textContent = fontsCSS;
          trace.action('renderer:fonts-style-updated', { size: fontsCSS.length });
        }
      } else if (fontsEl) {
        fontsEl.remove();
      }
    }
  }

  // ─── Locale: set lang (+ dir for RTL scripts) on content root ─────────
  _activeRenderLocale = activeLocale ?? '';
  const isNonDefaultLocale = activeLocale && defaultLocale && activeLocale !== defaultLocale;
  if (isNonDefaultLocale) {
    container.setAttribute('lang', activeLocale);
    // RTL by locale code (closed set — avoids threading the i18n config
    // through the sandbox bridge; matches the live Providers' rule).
    if (RTL_LOCALES.has(activeLocale.split('-')[0])) container.setAttribute('dir', 'rtl');
    else container.removeAttribute('dir');
    trace.action('renderer:set-lang', { locale: activeLocale, rtl: RTL_LOCALES.has(activeLocale.split('-')[0]) });
  } else {
    container.removeAttribute('lang');
    container.removeAttribute('dir');
  }

  // ─── Viewports: root IS the viewport frame (no wrapper) ───────────────
  const primaryViewport = viewports.find(v => v.isPrimary) ?? viewports[0];

  for (const vp of viewports) {
    const isPrimary = vp.id === primaryViewport.id;
    const prefix = isPrimary ? '' : vp.id + '-';
    // For framer-motion variants: ALL tiles on a component master page
    // need a variantName so the per-node variant resolution
    // (`resolveVariantStyles`) can apply variant overrides + check
    // `hiddenOnVariants` (the AnimatePresence-conditional render
    // visibility flag). The PRIMARY tile maps `vp.id === 'desktop'`
    // (the conventional primary id) to the variants object's `'default'`
    // entry, matching the rest of the codebase's desktop→default
    // mapping. Non-primary tiles pass their id as-is (e.g.
    // 'variant-1'). Page responsive viewports (tablet/mobile) still
    // use `responsiveVariantMap` via vpWidth — `variantName` stays
    // null for those.
    const isComponentMaster = code?.includes('variantConfig') ?? false;
    const variantName = isComponentMaster
      ? (isPrimary ? 'default' : vp.id)
      : null;

    // For each viewport, we render root directly with viewport attributes.
    // The root element IS the viewport frame.
    for (const rootNode of viewportRoots) {
      const prefixedId = prefix + rootNode.id;
      let rootEl = container.querySelector(`[data-node-id="${prefixedId}"]`) as HTMLElement | null;

      // File switch reuse guard: when a file switch lands a master viewport
      // whose data-id matches an INSTANCE id from the previous file's page
      // render (e.g. Make Component reuses the original frame's data-id on
      // both the instance tag AND the new master root), the query above
      // finds the OLD instance expansion deep inside the previous page's
      // viewport root. Patching it there leaves the new master root nested
      // inside a stale parent that the cleanup step below (lines ~814-817)
      // removes wholesale — taking the just-patched master root with it.
      // Net result: the iframe ends up with NO viewport root for the new
      // file (visible as the freshly-entered master rendering invisibly).
      // Treat any match that isn't a direct child of `container` as a
      // stale duplicate: remove it, set rootEl to null so the create path
      // below runs and appends a fresh element AT container level.
      if (rootEl && rootEl.parentElement !== container) {
        rootEl.remove();
        rootEl = null;
      }

      if (rootEl) {
        // EXISTS — patch in place. Pass `localeOverrides` for ALL locales,
        // not just non-default ones. Once a node migrates to `{t('id')}`,
        // the JSX no longer carries plain text — the override map (loaded
        // from messages/{locale}.json by Canvas.tsx) is the only source of
        // visible copy, including in the default locale. Without this the
        // transformed nodes render empty when the user switches back to EN.
        patchElement(rootEl, rootNode, nodes, onNodeMouseDown, prefix, variantName, undefined, localeOverrides, vp.width);
      } else {
        // NEW — create root element
        rootEl = buildNodeElement(rootNode, nodes, onNodeMouseDown, prefix, variantName, undefined, '', localeOverrides, vp.width);
        container.appendChild(rootEl);
      }

      // Apply viewport/variant attributes directly on root
      // These OVERRIDE any inline left/top/width from the node's styles
      rootEl.setAttribute('data-viewport', vp.id);
      // canvas-dnd expects `data-viewport-id` for hit-test scoping. Mirror our
      // existing `data-viewport` value so canvas-dnd can pick the right replica.
      rootEl.setAttribute('data-viewport-id', vp.id);
      // Mark the primary viewport so canvas-dnd's onCommit knows which replica
      // to mirror writes from.
      if (vp.id === viewports[0]?.id || vp.isPrimary) {
        rootEl.setAttribute('data-viewport-primary', 'true');
      } else {
        rootEl.removeAttribute('data-viewport-primary');
      }
      if (variantName) rootEl.setAttribute('data-variant', variantName);
      // `container-type: inline-size` applies SIZE CONTAINMENT on the inline
      // (width) axis — the element is sized as if it had no contents on that
      // axis. That's fine for pages (the root width is the definite vp.width),
      // but on a component-master root sized to its content (Fit width =
      // min-content/fit-content/etc.) it makes `width: min-content` ignore the
      // text and collapse to just the padding. So for a Fit-width master root,
      // skip inline containment (we lose width-based @container queries on that
      // root, which is meaningless for a content-sized component anyway).
      let masterFitWidth = false;
      if (isComponentMaster && variantName !== undefined) {
        const rwv = resolveVariantStyles(rootNode, variantName, vp.width).width ?? rootNode.styles?.width;
        masterFitWidth = isFitSize(rwv);
      }
      // Viewport-drag pin: while THIS tile's width is being dragged, its
      // container queries are silenced (containerType normal) so foreign
      // bands can't flash over the pinned inline values as the width sweeps
      // their intervals; every render during the gesture (the band-crossing
      // re-renders) re-stamps this line, so the consult must live HERE — an
      // injected stylesheet or one-shot patch is overwritten by the next
      // render (the "no difference, still flips to desktop mid-drag" report).
      const bandPinnedTile = viewportBandPinOps.get()?.vpId === vp.id;
      rootEl.style.containerType = (masterFitWidth || bandPinnedTile) ? 'normal' : 'inline-size';
      if (bandPinnedTile) trace.action('renderer:band-pin-container-off', { vpId: vp.id });
      rootEl.style.position = 'absolute';
      rootEl.style.left = `${vp.x}px`;
      rootEl.style.top = `${vp.y}px`;
      // NOTE: do NOT set `will-change: transform` permanently here — it
      // makes Chrome cache the rasterized bitmap and STRETCH it on canvas
      // zoom (= blurry zoom). Instead, TransformManager dynamically sets
      // will-change while a scale change is in flight and clears it on
      // debounce so Chrome re-rasterizes at the new scale.
      if (vp.width > 0 && !isComponentMaster) rootEl.style.width = `${vp.width}px`;
      // Optional viewport height — three cases, all sourced from the
      // @canvas block via SizeTool:
      //   • numeric (e.g. 900) → write `height: '900px'`
      //   • the string `'auto'`  → write `height: 'auto'` explicitly so
      //     the inline override survives across renders (clearing
      //     `style.height` would just fall through to whatever the JSX
      //     re-renders, which the user is trying to override)
      //   • undefined / 0 / null → clear the override and let React's
      //     JSX render govern (legacy projects without a height field)
      if (!isComponentMaster) {
        if (vp.height === 'auto') {
          rootEl.style.height = 'auto';
        } else if (typeof vp.height === 'number' && vp.height > 0) {
          rootEl.style.height = `${vp.height}px`;
        } else {
          rootEl.style.height = '';
        }
      }
      // Component master wrapper sizing — when the master root has
      // `position: 'absolute'` (e.g. extracted from an absolutely-
      // positioned element), the wrapper has no in-flow children and
      // collapses to height 0 (visible as a thin line on the master
      // page). Resolve the master root's variant + inline styles for
      // this viewport and apply width/height to the wrapper so it sizes
      // to its content. No-op when the root is in normal flow (the
      // wrapper already grows to fit its child).
      if (isComponentMaster && variantName !== undefined) {
        const resolved = resolveVariantStyles(rootNode, variantName, vp.width);
        const rootPosition = resolved.position || rootNode.styles?.position;
        if (rootPosition === 'absolute' || rootPosition === 'fixed') {
          if (resolved.width) rootEl.style.width = resolved.width;
          if (resolved.height) rootEl.style.height = resolved.height;
        }
      }
      // Store viewport width as data attribute for VW/VH resolution in patchElement
      rootEl.setAttribute('data-viewport-width', String(vp.width));
    }
  }

  // ─── Overlay portals — render overlay nodes OUTSIDE viewport (the reference pattern) ───
  // For each viewport, find overlay nodes and move them to a portal sibling.
  // This prevents overflow:hidden and transform from clipping/transforming overlays.
  // Every relative-overlay placement this render performed, replayed by the
  // sandbox at gesture end (a layout drop skips the re-render).
  const overlayPlacements: OverlayPlacement[] = [];

  for (const vp of viewports) {
    const isPrimary = vp.id === primaryViewport.id;
    const prefix = isPrimary ? '' : vp.id + '-';

    // Track which overlay IDs the CURRENT render produced for this viewport,
    // across all roots. Anything else in the portal is stale — left over from
    // a previous page/file whose overlays were portaled out of its tree and
    // therefore never torn down by the regular node reconciliation.
    const activeOverlayIds = new Set<string>();
    let portal = container.querySelector(`[data-overlay-portal="${vp.id}"]`) as HTMLElement | null;

    for (const rootNode of viewportRoots) {
      const prefixedId = prefix + rootNode.id;
      const rootEl = container.querySelector(`[data-node-id="${prefixedId}"]`) as HTMLElement | null;
      if (!rootEl) continue;

      // Overlay nodes to place this render — under the root AND already in the
      // portal. Portaled ones MUST be re-included or they never get repositioned
      // again after the render that first moved them out (see the helper's doc).
      const overlayEls = collectOverlayElsForRoot(rootEl, portal);
      if (overlayEls.length === 0) continue;

      // Get or create portal container (sibling of viewport root)
      if (!portal) {
        portal = document.createElement('div');
        portal.setAttribute('data-overlay-portal', vp.id);
        portal.setAttribute('data-viewport', vp.id); // For click viewport detection
        portal.style.position = 'absolute';
        portal.style.left = `${vp.x}px`;
        portal.style.top = `${vp.y}px`;
        portal.style.width = `${vp.width}px`;
        portal.style.height = '0';
        portal.style.zIndex = '20';
        portal.style.pointerEvents = 'none';
        // Make the portal a query container at the viewport's width so the
        // overlay's per-replica STYLE overrides (`@container (max-width: N)`
        // rules the editor writes for replica edits) actually apply — the
        // overlay is portaled OUTSIDE the viewport root, so without this it
        // would never match any container query and replica styling silently
        // did nothing.
        portal.style.containerType = 'inline-size';
        container.appendChild(portal);
      } else {
        // Update portal position to match viewport
        portal.style.left = `${vp.x}px`;
        portal.style.top = `${vp.y}px`;
        portal.style.width = `${vp.width}px`;
        portal.style.containerType = 'inline-size'; // (idempotent — heals portals from older sessions)
      }

      // Move overlay elements from viewport tree to portal + position from trigger
      overlayEls.forEach(overlayEl => {
        const el = overlayEl as HTMLElement;
        el.style.pointerEvents = 'auto';

        // Read overlay config to find trigger
        const overlayAttr = el.getAttribute('data-overlay') || '';
        let config: any = {};
        try { config = JSON.parse(overlayAttr); } catch { /* skip */ }

        const overlayNodeId = el.getAttribute('data-node-id') || '';
        activeOverlayIds.add(overlayNodeId);

        // Fixed overlays (modals): stay in viewport tree, no portal, no trigger
        // positioning. In the PUBLISHED page they're `position:fixed` covering
        // 100vw/100vh of the browser. On the CANVAS, `100vh` would resolve to the
        // browser window (spanning many tiles), so we render them ABSOLUTE inside
        // the viewport root, covering exactly that tile: left/top 0, width 100%,
        // height = the viewport's own height ("100vh of the canvas viewport"). For
        // an `auto`-height tile fall back to the rendered root height.
        if (config.type === 'fixed') {
          el.style.position = 'absolute';
          el.style.left = '0';
          el.style.top = '0';
          el.style.width = '100%';
          // "100vh on the canvas". The tile is almost always auto-height
          // (vp.height === "auto"), and rootEl.offsetHeight is the FULL scrolling
          // page — using it made a fixed/modal overlay span the ENTIRE page
          // instead of one screen. When there's no explicit numeric tile height,
          // approximate a real device screenful from the breakpoint width so the
          // modal covers ~100vh, like it will on the deployed site.
          const vpH = typeof vp.height === 'number' && vp.height > 0
            ? vp.height
            : (vp.width >= 1024 ? 900 : vp.width >= 600 ? 1024 : 812);
          el.style.height = `${vpH}px`;
          // Config-driven backdrop (live, so panel edits show immediately): fill +
          // zIndex come from data-overlay, falling back to the defaults the
          // generator wrote into the element style.
          const fcfg = config as { zIndex?: number; fill?: string };
          el.style.zIndex = String(fcfg.zIndex ?? 100);
          if (fcfg.fill) el.style.backgroundColor = fcfg.fill;
          return;
        }

        // Relative overlays: move to portal + position from trigger
        const triggerId = config.triggerId || '';
        const triggerNodeId = prefix + triggerId;
        // When the trigger IS the variant-root (design-component master, overlay on
        // the root), `rootEl` itself is the trigger — `querySelector` only matches
        // DESCENDANTS, so it returns null and `positionOverlayInPortal` bails early,
        // pinning the overlay at the artboard's 0,0 (top-left). Use rootEl directly.
        const triggerEl = triggerId === rootNode.id
          ? rootEl
          : (rootEl.querySelector(`[data-node-id="${triggerNodeId}"]`) as HTMLElement | null);

        // If already in portal from previous render, replace with fresh element
        const existingInPortal = portal!.querySelector(`[data-node-id="${overlayNodeId}"]`) as HTMLElement | null;
        if (existingInPortal && existingInPortal !== el) {
          existingInPortal.remove();
        }

        // Move to portal
        portal!.appendChild(el);

        // Resolve this viewport's EFFECTIVE config (base + per-vp overrides)
        // so each tile positions from its own side/align/offset/collision —
        // overlays are fully responsive per replica, same as the @media model.
        const effectiveConfig = resolveOverlayConfig(config as OverlayConfig, vp.id, vp.width);

        // Always (re-)position from trigger — handles config changes, trigger moves, etc.
        // Component master: don't clamp to the variant tile (it's an editing surface,
        // not a real viewport) — let the overlay overflow over the canvas as it will
        // on the live page.
        positionOverlayInPortal(el, effectiveConfig, triggerEl, rootEl, !_isComponentMaster);

        // Record the inputs so the sandbox can REPLAY this exact placement at
        // gesture end. A layout drag (reorder / reparent) commits imperatively
        // and skips the re-render, so without a replay the overlay keeps the
        // position it had when the gesture began.
        overlayPlacements.push({
          overlayNodeId,
          triggerNodeId: triggerId === rootNode.id ? '' : triggerNodeId,
          rootNodeId: prefixedId,
          config: effectiveConfig,
          clamp: !_isComponentMaster,
        });

        // PER-REPLICA / PER-VARIANT HIDE on the canvas. A "Hide: Yes" hides the overlay
        // for one viewport (page replica → source `@media`→`@container` rule) or one
        // design-component variant (→ `hiddenOnVariants`). On the LIVE site these resolve
        // globally (window `@media` / React unmount). On the CANVAS in overlay EDIT mode,
        // the edit-mode show rule (`[data-id][data-overlay-node]{display:block!important}`,
        // Canvas.tsx) is MORE SPECIFIC than the per-replica `@container` hide
        // (`[data-id]{display:none!important}`), so it wins and the overlay shows in EVERY
        // tile — including the hidden one. Stamp the hide INLINE on THIS tile's portal copy:
        // inline `!important` beats any stylesheet `!important` regardless of specificity,
        // overriding the show rule for exactly the hidden tile. Each tile has its own portal
        // copy, so this affects only `vp`. Canvas-only.
        const overlaySrcId = el.getAttribute('data-id') || '';
        let hideThisTile = false;
        if (_isComponentMaster) {
          // Component variant: `getResponsiveOverridesForNode` bails for masters; resolve
          // the per-variant hide (`hiddenOnVariants`) instead. Here `vp.id` IS the variant.
          const ovNode = nodes.get(overlaySrcId);
          if (ovNode) hideThisTile = resolveVariantStyles(ovNode, vp.id, vp.width).display === 'none';
        } else {
          hideThisTile = getResponsiveOverridesForNode(overlaySrcId, vp.width).display === 'none';
        }
        if (hideThisTile) el.style.setProperty('display', 'none', 'important');
        else el.style.removeProperty('display');
      });
    }

    // Stale cleanup — MUST run even when this render produced zero overlays.
    // The old code skipped it via `continue` when the tree had no overlay
    // elements, so switching to a page/component without overlays left the
    // previous page's portaled overlays stuck on screen forever.
    if (portal) {
      Array.from(portal.children).forEach(child => {
        const childNodeId = (child as HTMLElement).getAttribute('data-node-id');
        const verdict = classifyPortalChild(childNodeId, prefix, nodes, activeOverlayIds);
        if (verdict === 'keep-active' || verdict === 'keep-valid') return;
        trace.action('renderer:reap-stale-portal-overlay', { childNodeId, vpId: vp.id, verdict });
        child.remove();
      });
      // Drop the portal only when it's genuinely empty (all children were
      // stale-removed) — NOT merely because nothing was re-portaled this pass.
      if (portal.children.length === 0) portal.remove();
    }
  }

  // Clean up stale overlay portals (viewports that no longer exist)
  container.querySelectorAll('[data-overlay-portal]').forEach(portal => {
    const vpId = portal.getAttribute('data-overlay-portal');
    if (!viewports.some(v => v.id === vpId)) portal.remove();
  });

  // Hand this render's placements to the replay cache. Written even when empty,
  // so removing the last overlay clears it instead of leaving a stale entry the
  // gesture-end replay would keep re-positioning.
  rememberOverlayPlacements(overlayPlacements);

  // Copy text-inheritance defaults from the primary viewport root to the
  // content container. Canvas-level nodes (parentId=null, isCanvasNode=true)
  // and lift-time hoisted elements live as direct children of the container,
  // OUTSIDE the viewport root's DOM subtree — so without this they don't
  // inherit the project's body font / color and visibly switch to the
  // browser default (Times-style serif). Applying the viewport root's
  // computed values to the container makes canvas-level elements match
  // the in-layout look without baking inline styles into committed code.
  if (viewports.length > 0) {
    const primaryRoot = container.querySelector('[data-viewport-primary]') as HTMLElement | null;
    if (primaryRoot) {
      const cs = getComputedStyle(primaryRoot);
      const TEXT_INHERIT = [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
        'lineHeight', 'letterSpacing', 'color',
      ] as const;
      for (const p of TEXT_INHERIT) {
        const v = cs[p as any];
        if (v) (container.style as any)[p] = v;
      }
    }
  }

  // ─── Canvas nodes (outside viewports) ─────────────────────────────────
  // Root-level canvas nodes (no parentId, isCanvasNode=true)
  patchCanvasNodes(container, canvasRoots, nodes, onNodeMouseDown);

  // A canvas-node OVERLAY (its trigger was dragged out to the canvas) stays
  // positioned relative to its (canvas-node) trigger — the reference behavior:
  // drag the source out, the overlay follows and keeps its relative placement.
  // Works in canvas space (the canvas nodes' own left/top units), no portal.
  positionCanvasNodeOverlays(container, canvasRoots, nodes);

  // Hoisted canvas nodes: descendants of viewport roots with isCanvasNode=true.
  // These are children of root in the code, but rendered at container level so
  // viewport overflow:hidden doesn't clip them. Position offset by viewport origin.
  // With layout merge, the page root is a child of the layout viewport root,
  // so we check two levels deep (viewport root children + their children).
  const hoistedCanvasNodes: { node: CanvasNode; vpX: number; vpY: number }[] = [];
  const hoistedSeen = new Set<string>();
  const hoistInspect: any[] = [];
  for (const rootNode of viewportRoots) {
    for (const childId of rootNode.children) {
      const child = nodes.get(childId);
      if (!child) continue;
      hoistInspect.push({ level: 'child', id: child.id, isCanvasNode: child.isCanvasNode, parentId: child.parentId });
      if (child.isCanvasNode && !hoistedSeen.has(child.id)) {
        hoistedCanvasNodes.push({ node: child, vpX: primaryViewport.x, vpY: primaryViewport.y });
        hoistedSeen.add(child.id);
      }
      // Also check grandchildren (page root's children when layout wraps page)
      for (const grandchildId of child.children) {
        const grandchild = nodes.get(grandchildId);
        if (grandchild) {
          hoistInspect.push({ level: 'grandchild', id: grandchild.id, isCanvasNode: grandchild.isCanvasNode, parentId: grandchild.parentId, viaParent: child.id });
        }
        if (grandchild?.isCanvasNode && !hoistedSeen.has(grandchild.id)) {
          hoistedCanvasNodes.push({ node: grandchild, vpX: primaryViewport.x, vpY: primaryViewport.y });
          hoistedSeen.add(grandchild.id);
        }
      }
    }
  }
  if (hoistInspect.length > 0) {
    trace.action('renderer:hoistInspect', { viewportRootIds: viewportRoots.map(r => r.id), entries: hoistInspect });
  }
  if (hoistedCanvasNodes.length > 0) {
    patchHoistedCanvasNodes(container, hoistedCanvasNodes, nodes, onNodeMouseDown);
  }

  // Remove stale hoisted canvas nodes (no longer isCanvasNode or deleted)
  const activeHoistedIds = new Set(hoistedCanvasNodes.map(h => h.node.id));
  const hoistedCleanup: { id: string; removed: boolean }[] = [];
  container.querySelectorAll('[data-hoisted-canvas]').forEach(el => {
    const nid = (el as HTMLElement).getAttribute('data-node-id');
    if (nid && !activeHoistedIds.has(nid)) {
      hoistedCleanup.push({ id: nid, removed: true });
      el.remove();
    } else if (nid) {
      hoistedCleanup.push({ id: nid, removed: false });
    }
  });
  if (hoistedCleanup.length > 0) {
    trace.action('renderer:hoisted-cleanup', {
      activeIds: Array.from(activeHoistedIds),
      cleanup: hoistedCleanup,
    });
  }

  // ─── Slot-connected canvas nodes ──────────────────────────────────────
  // Canvas nodes connected into a code-component slot live as
  // `data-canvas-node` children of the component tag (real JSX — so the
  // live site renders them inside the component). In the editor they
  // float at container level like any other canvas node, positioned by
  // their own `style.left/top` — so they drag normally.
  const slotCanvasNodes: CanvasNode[] = [];
  const slotSeen = new Set<string>();
  for (const node of nodes.values()) {
    if (node.isCanvasNode && node.parentId && !hoistedSeen.has(node.id)) {
      slotCanvasNodes.push(node);
      slotSeen.add(node.id);
    }
  }
  if (slotCanvasNodes.length > 0) {
    patchSlotCanvasNodes(container, slotCanvasNodes, nodes, onNodeMouseDown);
    trace.action('renderer:slot-canvas-nodes', { ids: [...slotSeen] });
  }
  container.querySelectorAll('[data-slot-canvas]').forEach(el => {
    const nid = (el as HTMLElement).getAttribute('data-node-id');
    if (nid && !slotSeen.has(nid)) el.remove();
  });

  // Remove stale viewport elements (viewports that no longer exist)
  const activeVpNodeIds = new Set<string>();
  for (const vp of viewports) {
    const prefix = vp.id === primaryViewport.id ? '' : vp.id + '-';
    for (const rootNode of viewportRoots) {
      activeVpNodeIds.add(prefix + rootNode.id);
    }
  }
  container.querySelectorAll('[data-viewport]').forEach(el => {
    const nid = (el as HTMLElement).getAttribute('data-node-id');
    if (nid && !activeVpNodeIds.has(nid)) el.remove();
  });

  resumeDOMObserver();

  const duration = performance.now() - t0;
  trace.fn('renderNodes', {
    duration: `${duration.toFixed(1)}ms`,
    viewportRoots: viewportRoots.length,
    canvasRoots: canvasRoots.length,
    totalNodes: nodes.size,
    subtreeSkips: _patchSkipCount,
  });

  // Notify CodeComponentHost that DOM is ready (ghost copies are built)
  window.dispatchEvent(new Event('revyme:render-complete'));
}

// ─── Collection chain config (filter / sort / limit) ───────────────────────
//
// Mirrors what `cms-gen.ts:buildChainCode` emits and what
// `parser.ts:parseFilterCallback / parseSortCallback / parseSliceArgs`
// reads back. Run on the raw collection data BEFORE the renderer's ghost
// loop so the canvas reflects the live website's behaviour — change a
// filter and ghost #2 disappears, change a sort and rows reorder, drop
// a limit and the spillover rows hide. Without this the canvas would
// keep showing the unfiltered data and the user couldn't tell whether
// their config was correct.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDateVal = (v: any): boolean => typeof v === 'string' && DATE_ONLY_RE.test(v);

function evalFilter(item: CollectionItem, filter: FilterConfig): boolean {
  const rhs = filter.value;
  // Dynamic-value filters (search field / date picker) have no author-time value on
  // the canvas — pass through so the canvas previews every row (the deployed page
  // applies the real predicate against the live variable). See Phase 4.
  if (filter.valueSource && filter.valueSource !== 'static') return true;
  // Date-day comparison (mirrors cms-gen): a date-only value compares against the
  // field's "YYYY-MM-DD" prefix so a full ISO timestamp (_createdAt/_updatedAt) or
  // a date-only field both match, and gt/lt/between compare lexically (chronologically).
  const dateCmp = isDateVal(rhs) || (Array.isArray(rhs) && (isDateVal(rhs[0]) || isDateVal(rhs[1])));
  const lhs = dateCmp ? String((item as any)[filter.field] ?? '').slice(0, 10) : (item as any)[filter.field];
  switch (filter.operator) {
    case 'between': {
      const [lo, hi] = Array.isArray(rhs) ? rhs : [rhs, rhs];
      if (dateCmp) return lhs >= String(lo) && lhs <= String(hi);
      return Number(lhs) >= Number(lo) && Number(lhs) <= Number(hi);
    }
    case 'equals': return lhs === rhs;
    case 'not_equals': return lhs !== rhs;
    // contains / not_contains are CASE-INSENSITIVE (design-tool parity) — matches the
    // generated predicate (String(field).toLowerCase().includes(value.toLowerCase())).
    case 'contains':
      if (typeof lhs === 'string' && typeof rhs === 'string') return lhs.toLowerCase().includes(rhs.toLowerCase());
      if (Array.isArray(lhs)) return lhs.includes(rhs as any);
      return false;
    case 'not_contains':
      if (typeof lhs === 'string' && typeof rhs === 'string') return !lhs.toLowerCase().includes(rhs.toLowerCase());
      if (Array.isArray(lhs)) return !lhs.includes(rhs as any);
      return true;
    case 'gt': return dateCmp ? String(lhs) > String(rhs) : Number(lhs) > Number(rhs);
    case 'gte': return dateCmp ? String(lhs) >= String(rhs) : Number(lhs) >= Number(rhs);
    case 'lt': return dateCmp ? String(lhs) < String(rhs) : Number(lhs) < Number(rhs);
    case 'lte': return dateCmp ? String(lhs) <= String(rhs) : Number(lhs) <= Number(rhs);
    case 'exists': {
      const present = lhs !== undefined && lhs !== null && lhs !== '';
      return rhs === false ? !present : present;
    }
    default: return true;
  }
}

type ListOverride = { filterGroup?: FilterGroup | null; sort?: SortConfig[] | null };

function applyChainConfig(
  raw: CollectionItem[],
  cfg: {
    filterGroup?: FilterGroup | null; sort?: SortConfig | SortConfig[] | null;
    limit?: number | null; offset?: number | null; pagination?: { perPage: number } | null;
    responsive?: Record<string, ListOverride> | null;
    variantConfigs?: Record<string, ListOverride> | null;
  } | undefined,
  /** Active replica width — selects the per-viewport override bucket (max-width). */
  vpWidth?: number,
  /** Active variant (master artboard / resolved instance variant) — selects the
   *  per-variant override. */
  variantName?: string,
): CollectionItem[] {
  if (!cfg) return raw;
  let data = raw;

  // Resolve effective filter/sort = base ← per-viewport bucket ← per-variant
  // (mirrors the deployed useResponsiveListConfig merge). An override only
  // replaces a dim it explicitly carries; absent dims inherit base.
  let filterGroup = cfg.filterGroup ?? null;
  let sort: SortConfig | SortConfig[] | null = cfg.sort ?? null;
  if (cfg.responsive && vpWidth) {
    const bps = Object.keys(cfg.responsive).map(Number).filter(n => isFinite(n) && n > 0).sort((a, b) => a - b);
    let bucket: number | null = null;
    for (const b of bps) { if (vpWidth <= b) { bucket = b; break; } }
    const ov = bucket != null ? cfg.responsive[String(bucket)] : null;
    if (ov) { if (ov.filterGroup !== undefined) filterGroup = ov.filterGroup; if (ov.sort !== undefined) sort = ov.sort; }
  }
  if (cfg.variantConfigs && variantName && cfg.variantConfigs[variantName]) {
    const ov = cfg.variantConfigs[variantName];
    if (ov.filterGroup !== undefined) filterGroup = ov.filterGroup;
    if (ov.sort !== undefined) sort = ov.sort;
  }

  if (filterGroup && filterGroup.filters.length > 0) {
    const { combinator, filters } = filterGroup;
    data = data.filter(item => combinator === 'or'
      ? filters.some(f => evalFilter(item, f))
      : filters.every(f => evalFilter(item, f)));
  }
  // Multi-key stable sort: first non-zero key delta wins (accepts legacy single config).
  const sortKeys = Array.isArray(sort) ? sort : sort ? [sort] : [];
  if (sortKeys.length > 0) {
    data = [...data].sort((a, b) => {
      for (const { field, direction } of sortKeys) {
        const av = (a as any)[field];
        const bv = (b as any)[field];
        if (av === bv) continue;
        const dir = direction === 'desc' ? -1 : 1;
        return av > bv ? dir : -dir;
      }
      return 0;
    });
  }
  // Skip the first `offset` items, then preview page 1 (pagination) / honor the
  // static limit. Mirrors the generated `.slice(offset, offset+N)` so the canvas
  // shows the same window the deployed page renders.
  const off = cfg.offset && cfg.offset > 0 ? cfg.offset : 0;
  if (cfg.pagination && cfg.pagination.perPage > 0) {
    data = data.slice(off, off + cfg.pagination.perPage);
  } else if (cfg.limit && cfg.limit > 0) {
    data = data.slice(off, off + cfg.limit);
  } else if (off > 0) {
    data = data.slice(off);
  }
  return data;
}

// ─── DOM Differ ─────────────────────────────────────────────────────────────

/**
 * Mirror inline `style` from every `[data-node-id]` element in the template
 * subtree to the matching ghost subtree element. Pairing is done by
 * `data-id` + ghost suffix (read from the ghost's own `data-node-id`).
 *
 * Why this exists: when the user edits a property on the template, the
 * renderer's patch pass updates inline styles on the template DOM but
 * leaves ghost descendants stale — they look correct only after a full
 * rebuild (which is what a page-switch happened to trigger). The bridge's
 * patchStyles mirroring covers the live drag/slider path; this covers the
 * post-flush re-render path.
 *
 * Implementation note: we deliberately overwrite the ghost's `cssText`
 * with the template's. Ghosts have NO per-row inline overrides — every
 * row-specific value comes through `applyBindingDataToTree` AFTER this,
 * which sets the bound style props back to the resolved field value.
 * That means the order matters: sync styles first, bindings second.
 */
function syncInlineStyles(templateEl: HTMLElement, ghostEl: HTMLElement): void {
  const templateNodes = templateEl.querySelectorAll<HTMLElement>('[data-node-id]');
  // Always copy the root pair too — query starts from descendants only.
  ghostEl.style.cssText = templateEl.style.cssText;
  for (const tEl of templateNodes) {
    const dataId = tEl.getAttribute('data-id');
    if (!dataId) continue;
    // Match by data-id (descendants share the same data-id between
    // template and ghost — only data-node-id differs by suffix).
    const matching = ghostEl.querySelectorAll<HTMLElement>(`[data-id="${dataId}"]`);
    for (const gEl of matching) {
      gEl.style.cssText = tEl.style.cssText;
    }
  }
}

/**
 * Patch a single DOM element to match its CanvasNode.
 * Only touches properties that actually changed.
 */
/**
 * Ensure a `<video data-bg-video>` first child mirrors `node.bgVideo` on the
 * host element. Called from patchElement on every cycle so add/change/remove
 * stays in sync. The video is intentionally NOT given a `data-id` so it's
 * skipped by `getElementIdsAtPoint` and the rectCache-based selection box.
 */
function syncBgVideoChild(hostEl: HTMLElement, bgVideo: CanvasNode['bgVideo']): void {
  const existing = hostEl.querySelector(':scope > video[data-bg-video]') as HTMLVideoElement | null;
  if (!bgVideo) {
    if (existing) {
      existing.remove();
      trace.dom('renderer:bg-video-removed');
    }
    return;
  }
  const v = existing ?? document.createElement('video');
  if (!existing) {
    v.setAttribute('data-bg-video', '');
    v.style.position = 'absolute';
    v.style.inset = '0';
    v.style.width = '100%';
    v.style.height = '100%';
    v.style.zIndex = '-1';
  }
  // src — only swap if changed (changing src restarts playback).
  if (v.getAttribute('src') !== bgVideo.src) {
    v.setAttribute('src', bgVideo.src);
    try { v.load(); } catch { /* ignore */ }
    trace.dom('renderer:bg-video-src-updated');
  }
  // Boolean HTML attributes — set as IDL props (browser respects these
  // immediately; setAttribute on autoplay/muted is unreliable cross-browser).
  // CANVAS: force autoplay/loop OFF so the bg video stays frozen on its first
  // frame (the video-freeze observer in renderNodes also nets any play()); the
  // live site autoplays via its own React render, unaffected by this.
  v.autoplay = false;
  v.muted = bgVideo.muted;
  v.loop = false;
  // …but a frozen video still has to DECODE a frame to show one. With playback
  // off and no poster, a default `preload="metadata"` can leave the element
  // blank. `auto` buffers enough to paint the first frame without ever playing —
  // which is exactly the "static, non-playable version" the canvas promises.
  v.preload = 'auto';
  (v as any).playsInline = bgVideo.playsInline;
  v.controls = bgVideo.controls;
  // Inline style: objectFit + pointerEvents (only when controls off, so the
  // host stays selectable; with controls on, clicks need to land on the
  // native video UI).
  v.style.objectFit = bgVideo.objectFit || 'cover';
  v.style.pointerEvents = bgVideo.controls ? '' : 'none';
  // Poster.
  if (bgVideo.poster) {
    if (v.getAttribute('poster') !== bgVideo.poster) v.setAttribute('poster', bgVideo.poster);
  } else if (v.hasAttribute('poster')) {
    v.removeAttribute('poster');
  }
  // autoplay + muted — calling .play() defensively makes Safari/iOS more
  // reliable when toggling autoplay back on without a fresh load.
  if (!existing) {
    hostEl.insertBefore(v, hostEl.firstChild);
    trace.dom('renderer:bg-video-inserted', { src: bgVideo.src.slice(0, 60) });
  }
  if (bgVideo.autoPlay && v.paused) {
    // `play()` predates the promise-returning spec — it returns UNDEFINED in
    // older Safari (and in jsdom), so a bare `.catch` throws a TypeError and
    // takes the whole render down with it. Guard before chaining.
    const p = v.play() as Promise<void> | undefined;
    p?.catch?.(() => { /* autoplay may be blocked — ignore */ });
  }
}

function patchElement(
  el: HTMLElement,
  node: CanvasNode,
  allNodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
  idPrefix: string,
  variantName?: string | null,
  bindingData?: CollectionItem | null,
  localeOverrides?: Map<string, NodeOverride>,
  vpWidth?: number,
): void {
  // Skip elements being edited by TipTap — their DOM is managed by ProseMirror
  if (el.hasAttribute('data-editing')) return;

  // Drag-locked nodes: skip the ENTIRE patch (styles, attrs, children) so
  // LayoutLiftedStrategy's imperative `position: absolute` + `left/top` +
  // `zIndex: 9999` lift styles survive mid-drag force-renders (e.g. when
  // ALT is pressed and the alt-duplicate `addNode` triggers a render).
  // Otherwise the lifted overlay loses its absolute positioning + z-index
  // and the user sees it snap back into the flex flow underneath siblings.
  if (_dragLockedNodeIds.has(node.id)) return;

  // Whole-subtree skip: identical content signature + render context means
  // this element and every descendant would patch to exactly what they
  // already are. Locale-override renders and collection-bound rows resolve
  // against EXTERNAL data, so they never skip (conservative-correct).
  let patchKey: string | null = null;
  if (_sigCache && !bindingData && (!localeOverrides || localeOverrides.size === 0)) {
    const entry = nodeSigEntry(node, allNodes);
    if (!entry.dynamic) {
      patchKey = `${entry.sig}|${idPrefix}|${variantName ?? ''}|${vpWidth ?? ''}|${_responsiveCssFp}|${_activeRenderLocale}`;
      // A file-switch render never skips on a stored key — see _distrustPatchKeys.
      if (!_distrustPatchKeys && (el as HTMLElement & { __revymePatchKey?: string }).__revymePatchKey === patchKey) {
        _patchSkipCount++;
        return;
      }
    }
  }

  // This element IS being patched. If it lives inside a CULLED root, that
  // root's placeholder box + replayed rect caches are now stale — mark it so
  // the render cycle restores it (culling.restoreDirty) before measuring.
  // DISTRUSTED renders (undo/redo, file switch) force EVERY element down this
  // path — the patch-key skip above is disabled by design so undo residue gets
  // reconciled. But marking dirty from a distrusted walk restored EVERY culled
  // root on every keystroke (36 subtrees on a real page), and re-attaching a
  // subtree makes the browser re-decode + re-raster its images: on
  // image-heavy pages undo took ~½s, and deleting the images made it instant
  // ("those images create the bottleneck", 2026-08-07). A distrusted render
  // re-patches to the SAME values unless the node actually changed, so gate
  // the dirty-mark on a real value change: compare the freshly computed patch
  // key against the stored one (computed above even when the skip is
  // disabled). No key (dynamic/binding nodes) stays conservative — always
  // dirty.
  const culledRoot = el.closest('[data-culled]');
  if (culledRoot) {
    const stored = (el as HTMLElement & { __revymePatchKey?: string }).__revymePatchKey;
    const unchanged = patchKey !== null && stored === patchKey;
    if (!unchanged) culledRoot.setAttribute('data-culled-dirty', 'true');
  }

  // Background-video sync — runs every cycle so add/change/remove stays live.
  syncBgVideoChild(el, node.bgVideo);

  // Clear inheritance-preservation styles set by liftNode if a non-restore
  // commit path got here (mutation-queue → setCode → re-render). Without
  // this the lifted-time computed font/color values would persist on the
  // element forever, even though the user never set them in JSX.
  const preservedAttr = el.getAttribute('data-lift-preserved-props');
  if (preservedAttr) {
    for (const k of preservedAttr.split(',')) {
      const key = k.trim();
      if (key && !node.styles?.[key]) {
        try { (el.style as any)[key] = ''; } catch { /* skip */ }
      }
    }
    el.removeAttribute('data-lift-preserved-props');
  }
  // Skip Code component containers — their content is managed by CodeComponentHost React roots
  if (node.isCodeComponent) {
    // Patch styles on the container, don't touch children. Resolve the ACTIVE
    // variant first: a code-component instance (e.g. a vector set) inside a
    // component master sizes per artboard tile — its width/height may be
    // `variant === 'v' ? a : b` conditionals (node.conditionalStyles). The old
    // code applied raw node.styles (the DEFAULT branch) and returned BEFORE the
    // resolveVariantStyles call below, so the container stayed at the default
    // size on every tile — the vector set showed the wrong size on non-default
    // variants and resize/drag appeared to REVERT on mouseup (the re-render
    // snapped the container back to default). Normal/`isComponentInstance` nodes
    // already resolved correctly because they reach the shared path below.
    // Band overrides MUST merge here too — this early-return branch was the
    // ONE patch path without the @media→inline parity merge. At rest the band
    // CSS masked it (the counters' mobile `width: 88px !important` painted
    // over the base 131px), but the viewport-drag pin turns the tile's
    // container queries OFF — the containers snapped to their base width and
    // the centered column around them read as "lost align/justify center
    // during resize" (2026-08-06, the last surviving drag flip).
    const resolvedContainerStyles = {
      ...resolveVariantStyles(node, variantName, vpWidth),
      ...getResponsiveOverridesForNode(node.id, vpWidth),
    };
    // The CONTAINER carries the rotation on the canvas (resolveVariantStyles folds
    // conditionalStyles.rotate into a CSS `transform`). That's what the rotate
    // handle, the selection overlay, and RotateManager all operate on — same as
    // any normal element — so the canvas rotates cleanly. The mounted INNER
    // motion.div must NOT also rotate (it would double); the sandbox's
    // resolveVariantProps drops motion-transform props from the inner's style, so
    // only the container rotates here and the inner `animate` springs on the LIVE
    // site (where there is no container).
    for (const [key, value] of Object.entries(resolvedContainerStyles)) {
      const v = (key === 'position' && value === 'fixed') ? 'absolute' : value;
      const cur = key.startsWith('--') ? el.style.getPropertyValue(key) : (el.style as any)[key];
      if (cur !== coerceCssNumberToPx(key, v)) setElStyle(el, key, v);
    }
    trace.dom('renderer:patch-code-component-container', { nodeId: node.id, component: node.type, variantName });
    return;
  }
  // (overlay elements use CSS for positioning — no special Renderer handling needed)

  // Component instance wrapper: proper container (like the reference's ComponentContainer).
  // The wrapper gets explicit width/height — from instance styles or from the component root's defaults.
  // The inner component root fills the wrapper ONLY along axes the wrapper has
  // an explicit size for. When the wrapper is auto-sized (no instance height
  // and no master height), forcing `height: 100%` on the inner makes it 100%
  // of an indefinite parent — i.e. 0 — and collapses the card. Per-axis
  // independent: a card may have explicit width but auto height (content-driven).
  // Instance wrapper = the node is an instance-tag for its own component.
  // The `isComponentInstance` flag is set explicitly by `expandComponent`
  // and works for ANY nesting depth — `componentInstanceId` alone can't
  // distinguish "I'm a nested instance" from "I'm a regular descendant
  // inside someone else's expansion".
  if (node.isComponentInstance) {
    // patchElement reuses the existing DOM element by `data-id` — when a
    // regular styled <div> just became a `<Component />` instance wrapper
    // (via Make Component), the OLD inline styles (padding, border-radius,
    // background, shadow, etc.) linger on the DOM because the patch loop
    // below only SETS new keys, never CLEARS stale ones. That produced the
    // "doubled padding / shadow" bug right after make-component: the outer
    // wrapper kept the original visual styles AND the inner root painted
    // them again via the style-spread.
    //
    // Walk the inline style and remove any property that isn't on the
    // wrapper's allow-list. The patch loop further down then re-sets the
    // allowed ones from `resolvedStyles`.
    for (let i = el.style.length - 1; i >= 0; i--) {
      const prop = el.style[i]; // kebab-case
      const camel = prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel === 'width' || camel === 'height' || camel === 'overflow') continue;
      if (WRAPPER_ONLY_STYLE_PROPS.has(camel)) continue;
      el.style.removeProperty(prop);
    }

    // Mirror the component ROOT's clipping overflow onto the wrapper (the
    // wrapper is the real flex item — see resolveInstanceWrapperOverflow's
    // rationale). Resolved through variants/@media so a per-variant or
    // per-viewport overflow edit is honoured per tile. An instance-tag
    // overflow (rare, user-set) still wins: the styleEntries patch loop below
    // allow-lists `overflow` and runs after this.
    const wrapperRootNode = node.children[0] ? allNodes.get(node.children[0]) : null;
    const wrapperRootStyles = wrapperRootNode ? resolveVariantStyles(wrapperRootNode, variantName, vpWidth) : null;
    const wrapperOverflow = resolveInstanceWrapperOverflow(wrapperRootStyles);
    if (el.style.overflow !== wrapperOverflow) {
      trace.dom('renderer:instance-wrapper-overflow', { nodeId: node.id, overflow: wrapperOverflow });
    }
    el.style.overflow = wrapperOverflow;
    const root = el.firstElementChild as HTMLElement | null;
    if (root) {
      // If wrapper has no explicit dimension OF ITS OWN, take the component
      // root's VARIANT/VIEWPORT-RESOLVED dimension (wrapperRootStyles), NOT its
      // base `styles`: a per-viewport variant replica whose conditional height
      // differs (`height: variant === 'variant-2' ? '293px' : '117px'`) lives
      // on the ROOT's conditionalStyles, and the root's own height is SKIPPED
      // for a component-root-in-instance (below) — so the wrapper is the ONLY
      // place the resolved height can land.
      //
      // SET-OR-CLEAR keyed on SOURCE (`node.styles.*`), NOT on the DOM
      // (`el.style.*`): the old `!el.style.height` guard only set the height
      // when the wrapper had NONE, so once a tile was painted at the base
      // (117px) a later per-tile variant switch (adding variant-2 on mobile
      // AFTER the initial paint) could never update it — the stale 117px stuck
      // (the tablet fix worked only because a full page reload rebuilt it
      // fresh; mobile's live variant add went through patchElement and kept
      // the stale value — live find 2026-07-03). Now every patch re-syncs.
      trace.dom('renderer:instance-wrapper-size-sync', {
        nodeId: node.id, instW: node.styles.width ?? null, instH: node.styles.height ?? null,
        rootW: wrapperRootStyles?.width ?? null, rootH: wrapperRootStyles?.height ?? null,
        rootBaseH: wrapperRootNode?.styles?.height ?? null,
      });
      if (!node.styles.width) el.style.width = wrapperRootStyles?.width ?? '';
      if (!node.styles.height) el.style.height = wrapperRootStyles?.height ?? '';
      // Inner fills the wrapper ONLY for axes that have a definite size on
      // the wrapper. Otherwise leave the inner at auto so its content height
      // (or width) bubbles up and the wrapper auto-sizes around it.
      const wrapperHasWidth = !!el.style.width;
      const wrapperHasHeight = !!el.style.height;
      root.style.width = wrapperHasWidth ? '100%' : '';
      root.style.height = wrapperHasHeight ? '100%' : '';
    }
  }

  // Resolve styles: base styles + variant overrides (if active variant or responsive variant)
  // Then merge @media responsive overrides for this viewport width — prevents flicker
  // caused by inline styles fighting with @container !important rules.
  const baseStyles = resolveVariantStyles(node, variantName, vpWidth);
  // Per-viewport VARIABLE bindings paint their resolved value per tile (the inline __mq ternary
  // can't evaluate per-replica). An explicit @media override (a removed-variable literal) still
  // wins over it, so apply var-values first, then @media.
  const responsiveVarValues = getResponsiveStyleVarValuesForNode(node, vpWidth);
  const responsiveOverrides = getResponsiveOverridesForNode(node.id, vpWidth);
  const resolvedStyles = (Object.keys(responsiveVarValues).length > 0 || Object.keys(responsiveOverrides).length > 0)
    ? { ...baseStyles, ...responsiveVarValues, ...responsiveOverrides }
    : baseStyles;

  // Patch styles — two-pass: clear empty values first, then set non-empty.
  // This prevents shorthand/longhand conflicts (e.g. setting border then clearing borderTopWidth).
  // Overlay nodes: skip top/left/right/bottom from code styles — Renderer positions per-viewport
  // Heal PREVIOUS-locale inline residue BEFORE the style pass below — the
  // pass re-applies the node's base values over the cleared keys; keys with
  // no base stay removed. (applyLocaleOverrides re-applies the CURRENT
  // locale's values after the style pass.)
  clearLocaleStyleResidue(el, localeOverrides?.get(node.id), node.id, '');
  const isOverlayNode = !!node.attrs?.['data-overlay'];
  // Get viewport width for VW/VH resolution.
  // Read from data-viewport-width attribute (set by renderNodes) — reliable source
  // since style.width may be overwritten by code's width:'100%' during patchElement.
  const vpContainer = el.closest('[data-viewport]') as HTMLElement | null;
  const vpWidthPx = parseFloat(vpContainer?.getAttribute('data-viewport-width') || '') || 1440;

  // Component roots inside instance wrappers: skip width/height + every
  // wrapper-only prop from inline styles. The root fills the wrapper via
  // 100% (set above) when the wrapper has explicit dimensions. Wrapper-only
  // props (position, left/top, flex, grid placement, margin, etc.) describe
  // the *instance's* placement in its parent and must not be reapplied to
  // the inner root. project-parser.ts already filters these from the
  // instance→root style merge; this is defense-in-depth for stale data
  // paths (variants, responsive overrides, direct mutations).
  const isComponentRootInInstance = !!(node.componentInstanceId && node.isComponentRoot);
  // Variant-scoped locale CSS carrier: instance roots on PAGE tiles get their
  // RESOLVED variant stamped (master tiles are stamped in renderNodes ~1066;
  // the live site carries the JSX data-variant attr). Same precedence chain
  // the style resolution uses: per-tile responsive map → baked instance
  // variant → default. Parser drops the JSX expression attr, so this is the
  // only writer of the attribute here.
  if (isComponentRootInInstance) {
    const rv = (vpWidth != null ? node.responsiveVariantMap?.[vpWidth] : undefined)
      ?? node.componentVariant ?? 'default';
    if (el.getAttribute('data-variant') !== rv) el.setAttribute('data-variant', rv);
  }
  // Component instance wrapper: the OUTER half of the two-div instance
  // model. Visual props (border, padding, background, gradient, etc.) live
  // on the inner root via the expandComponent style merge. The wrapper is a
  // structural positioning container — it gets ONLY layout/positioning
  // props (width/height + WRAPPER_ONLY_STYLE_PROPS like position/transform/
  // order/flex/grid/margin/alignSelf/justifySelf). Without this filter the
  // instance.styles' visual props paint twice (outer + inner via spread)
  // producing the user-reported "doubled padding / shadow" effect.
  const isInstanceWrapper = !!node.isComponentInstance;
  const styleEntries = Object.entries(resolvedStyles)
    .filter(([key]) => !(isOverlayNode && (key === 'top' || key === 'left' || key === 'right' || key === 'bottom')))
    .filter(([key, value]) => {
      if (isInstanceWrapper) {
        // Allow-list: only wrapper-relevant props on the outer.
        if (key === 'width' || key === 'height' || key === 'overflow') return true;
        // `display: 'none'` from `hiddenOnVariants` MUST reach the wrapper so a
        // hidden instance is removed from layout (not just its inner content) —
        // otherwise the wrapper keeps its box: still in flow AND selectable on
        // the variants where it's hidden. (Other display values stay filtered so
        // the wrapper keeps its transparent/`contents` role.)
        if (key === 'display' && value === 'none') return true;
        if (WRAPPER_ONLY_STYLE_PROPS.has(key)) return true;
        return false;
      }
      if (isComponentRootInInstance) {
        if (key === 'width' || key === 'height') return false;
        if (WRAPPER_ONLY_STYLE_PROPS.has(key)) return false;
      }
      return true;
    })
    .map(([key, value]) => {
      let v = (key === 'position' && value === 'fixed') ? 'absolute' : value;
      // Resolve vw/vh against the simulated viewport (not the iframe window)
      // so each replica paints at its own width-proportional pixel size.
      // Shared with the sandbox bridge's live-patch path — see
      // `shared/responsive-units.ts` for the heuristic and rationale.
      if (typeof v === 'string') v = resolveResponsiveUnits(v, vpWidthPx);
      return [key, v] as const;
    });
  // STALE-CLEAR: walk the keys we set in the PREVIOUS patchElement
  // call for this element and remove any that aren't in the new map.
  // Without this, a key that was in source last render and is now
  // absent (e.g. `display: 'none'` from a solo-replica entry that
  // got unhidden — source loses the display key entirely) silently
  // lingers on the element. The two loops below only walk
  // `styleEntries` from the new resolvedStyles, so an absent key is
  // never visited → previous inline value stays forever → user has
  // to page-switch (which destroys + recreates the element from
  // scratch) for it to clear.
  //
  // Tracking via WeakMap (NOT a DOM attribute) so cleanup happens
  // automatically when elements get garbage-collected on subtree
  // removal. We track ONLY the keys patchElement itself wrote — not
  // every inline property the element has — so external systems
  // (drag/resize live patches via bridge, locale overrides applied
  // further down, slot/wrapper decorations applied in early-return
  // branches) aren't affected by the clear.
  const prevKeys = _prevPatchedKeys.get(el);
  const currKeys = new Set(styleEntries.map(([k]) => k));
  if (prevKeys) {
    for (const k of prevKeys) {
      if (!currKeys.has(k)) {
        // Instance wrappers: width/height/overflow are OWNED by the wrapper
        // size-sync above (master-root fallback, runs BEFORE this clear).
        // When an instance's size override is REMOVED (W/H → auto), the key
        // leaves styleEntries while still in prevKeys — clearing it here
        // stripped the fallback's just-written master size and the instance
        // collapsed to content until the NEXT full rebuild (page switch)
        // re-seeded it (user report 2026-07-31).
        if (isInstanceWrapper && (k === 'width' || k === 'height' || k === 'overflow')) continue;
        clearElStyle(el, k);
        trace.dom('renderer:stale-clear-key', { nodeId: node.id, idPrefix, key: k });
      }
    }
  }
  _prevPatchedKeys.set(el, currKeys);
  // Read custom-property values via getPropertyValue (bracket access returns
  // undefined for `--x`), so the change-guard below doesn't redundantly re-set.
  const readStyle = (key: string): string =>
    key.startsWith('--') ? el.style.getPropertyValue(key) : (el.style as any)[key];
  for (const [key, v] of styleEntries) {
    if (v === '' && readStyle(key) !== '') clearElStyle(el, key);
  }
  for (const [key, v] of styleEntries) {
    if (v !== '' && readStyle(key) !== coerceCssNumberToPx(key, v)) setElStyle(el, key, v);
  }

  // Next.js <Image fill> → width:100% height:100%
  if ((node.type === 'Image' || node.type === 'img' || node.type === 'motion.img') && node.attrs?.fill !== undefined) {
    if (!resolvedStyles.width && el.style.width !== '100%') el.style.width = '100%';
    if (!resolvedStyles.height && el.style.height !== '100%') el.style.height = '100%';
    trace.dom('renderer:image-fill-resolved', { nodeId: node.id });
  }

  // Audio/video: inject global CSS rule to disable native control interaction on canvas.
  // The element itself remains selectable/draggable — only the browser's shadow DOM
  // controls (play button, volume, scrubber) are blocked.
  const tagLower = node.type.replace('motion.', '');
  if ((tagLower === 'audio' || tagLower === 'video') && !_mediaControlsCSSInjected) {
    injectMediaControlsCSS();
  }

  // Apply bindings from collection data (overrides base styles/text for template
  // item 0), honoring per-viewport rebind / unbind→default at vpWidth.
  if (bindingData) {
    applyNodeCmsBindings(el, node, bindingData, vpWidth, variantName, { skipHref: true });
  }

  // Patch HTML attributes (neutralize href on canvas — links must not navigate in the editor)
  // Also actively remove href if it exists from a previous render
  if (el.hasAttribute('href')) el.removeAttribute('href');
  // FIT SVG: skip viewBox overwrite only while text is being edited (data-editing on a descendant).
  // Once editing ends and mutations flush, the code has the correct viewBox — let Renderer apply it.
  const isFitSvg = node.type === 'svg' && node.id.endsWith('-svg');
  const isFitEditing = isFitSvg && el.querySelector('[data-editing]') !== null;
  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === 'href') continue;
      if (isFitEditing && key === 'viewBox') continue;
      // `var:<name>` is a VARIABLE binding (e.g. a Search Field's `value={var}`),
      // not a literal — the canvas can't resolve the page variable, so skip it
      // (else the input would render the raw text "var:searchTitle").
      if (typeof value === 'string' && value.startsWith('var:')) continue;
      // Responsive raw-element attr (input type/name/placeholder) → resolve the
      // value for this replica's width / variant so the canvas matches live.
      const safeValue = node.responsiveAttrs ? resolveResponsiveAttr(node, key, value, vpWidth, variantName) : value;
      if (el.getAttribute(key) !== safeValue) el.setAttribute(key, safeValue);
    }
    // Mark overlay nodes for CSS-based visibility control (hidden by the base
    // `[data-overlay-node] { display:none }` rule until overlay mode shows the
    // ACTIVE one). This applies to canvas-node overlays too (trigger dragged
    // out): they must still obey overlay mode — appear only while editing,
    // disappear on exit — exactly like a viewport overlay. positionCanvasNode-
    // Overlays keeps the shown one glued to its canvas-node trigger.
    if (node.attrs['data-overlay'] && !el.hasAttribute('data-overlay-node')) {
      el.setAttribute('data-overlay-node', 'true');
    }
    // Overlay positioning is handled by the portal system in renderNodes()
    // (overlays are moved from viewport tree to a portal sibling)
  }

  // Patch SVG-specific attributes (must use setAttribute with kebab-case names).
  // For GEOMETRY attrs (d/points/coords) prefer the VARIANT-RESOLVED value
  // (baseStyles = resolveVariantStyles, which merges the active variant's
  // overrides) over the base attr — otherwise a per-variant geometry edit (e.g.
  // a reshaped `d`) is overwritten by the base `d` here and the canvas tile snaps
  // back to the primary shape. See GEOMETRY_VARIANT_ATTRS for why this is gated.
  if (isSvgTag(node.type) && node.attrs) {
    for (const attr of SVG_ATTRS) {
      const variantGeom = GEOMETRY_VARIANT_ATTRS.has(attr) ? baseStyles[attr] : undefined;
      const val = variantGeom ?? node.attrs[attr];
      if (val !== undefined && val !== '') {
        const svgAttr = attr.replace(/([A-Z])/g, '-$1').toLowerCase();
        if (el.getAttribute(svgAttr) !== val) {
          el.setAttribute(svgAttr, val);
        }
        // A variant geometry edit lives in the ATTRIBUTE here — clear any stale
        // inline CSS for that prop (e.g. a `d: path(...)` left from the previous
        // path() storage format) so it can't override the attribute via the
        // cascade. (Per-viewport geometry keeps its inline CSS — variantGeom is
        // undefined there, so this never runs.)
        if (variantGeom !== undefined && (el.style as any)[attr]) {
          try { (el.style as any)[attr] = ''; } catch { /* invalid prop */ }
        }
      }
    }
    // After geometry attrs land — interpret data-stroke-align (Inside /
    // Outside fake alignment) so the clip path matches the latest shape.
    applyStrokeAlignment(el, node.type, node.attrs, node.id);
  }

  // Opaque imported graphic (data-graphic svg): the parser kept the svg's
  // children OUT of the node tree (see CanvasNode.graphicMarkup) — inject
  // them as raw markup instead. innerHTML on an SVG element parses in SVG
  // context, which case-corrects clipPath/linearGradient/mask/… so defs
  // actually resolve (node-ifying them rendered clipPath as a <div> and
  // shapes painted unclipped). Cached per element so unchanged markup
  // doesn't re-parse every patch cycle.
  if (node.graphicMarkup !== undefined && isSvgTag(node.type)) {
    if ((el as HTMLElement & { __graphicMarkup?: string }).__graphicMarkup !== node.graphicMarkup) {
      try {
        el.innerHTML = node.graphicMarkup;
        (el as HTMLElement & { __graphicMarkup?: string }).__graphicMarkup = node.graphicMarkup;
        trace.dom('renderer:patch-graphic-markup', { nodeId: node.id, length: node.graphicMarkup.length });
      } catch (err) {
        trace.error('renderer:patch-graphic-markup-failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Per-viewport text overrides (useResponsiveText hook): the canvas renderer
  // is DOM-patching, not React-driven, so the hook call in the JSX never runs
  // here. The parser captured the primary + overrides into `node.textOverrides`
  // keyed by viewport width; we resolve per render pass using that pass's
  // `vpWidth` AND the page's full viewport list (`_allViewportWidthsAsc`,
  // refreshed each render).
  //
  // Bucket logic: find the SMALLEST configured viewport width that's >= the
  // current pass's vpWidth — that's the viewport "bucket" we're in. If the
  // override map has an entry for that bucket, use it; otherwise fall back
  // to primary. This matches Revyme's desktop-first @media convention:
  //   • desktop=1440, tablet=768, mobile=375
  //   • override at 768 only → tablet bucket only ([376, 768] range)
  //   • mobile (375) is its own bucket → no override → primary
  // The previous "any bp >= vpWidth wins" version made the tablet override
  // bleed into mobile because 375 ≤ 768.
  let resolvedTextContent = node.textContent;
  const patchTextOverride = getTextOverrideBucketValue(node, vpWidth);
  if (patchTextOverride !== undefined) resolvedTextContent = patchTextOverride;

  // Per-variant text: a `{variant === 'x' ? 'a' : 'b'}` child is captured by
  // the parser into `node.conditionalText`; pick the active variant's text.
  const variantText = resolveConditionalText(node, variantName, vpWidth);
  if (variantText !== null) resolvedTextContent = variantText;
  // Per-VIEWPORT text override on a replica tile (template/page): the inline `{__mq ? branch : base}`
  // child evaluates against the editor WINDOW, so the canvas resolves it per tile. Takes precedence
  // over base/variant text (an active CMS binding still wins via the `hasActiveTextBinding` guard below).
  const responsiveText = getResponsiveTextValueForNode(node, vpWidth);
  if (responsiveText !== undefined) resolvedTextContent = responsiveText;
  // RICH-TEXT locale runs: a mixed node whose inner JSX carries {t('key')}
  // run calls renders the locale-RESOLVED innerJsx from the override map —
  // the raw source would paint the literal `{t('…')}` markup.
  const localeInnerJsx = localeOverrides?.get(node.id)?.innerJsx;
  if (localeInnerJsx !== undefined) {
    resolvedTextContent = localeInnerJsx;
    trace.dom('renderer:locale-inner-jsx', { nodeId: node.id });
  }

  // Mixed content: convert JSX style syntax to HTML and render via innerHTML
  // Detect by flag OR by textContent containing HTML tags (fallback for timing issues)
  // Skip SVG nodes — their children (polygon, path, etc.) are rendered by the code generator, not innerHTML
  // A node with an ACTIVE text binding (its CMS field was resolved above) must NOT
  // have its text re-applied from the static `textContent` — that would clobber the
  // resolved field value with a stale default on PATCH. This is the re-bind bug: a
  // CMS-bound component prop kept its master default (`'sqdgqsd'`) in textContent, so
  // the template (item 0) reverted to it after a re-bind while ghosts (built via
  // applyBindingDataToTree) stayed correct. The BUILD path uses an if/else (binding
  // XOR textContent) so it's unaffected — only this patch-path's separate text write needs the guard.
  const hasActiveTextBinding = !!(bindingData && node.binding
    && node.binding.property === 'text'
    && bindingData[node.binding.field] !== undefined);
  const useInnerHTML = shouldUseInnerHTML(node.type, resolvedTextContent, node.hasMixedContent, node.children.length, node.isChildrenSlot, node.textIsLiteral);
  if (useInnerHTML && !hasActiveTextBinding) {
    try {
      const html = jsxStyleToHTML(resolvedTextContent);
      if (el.innerHTML !== html) {
        el.innerHTML = html;
        trace.dom('renderer:set-innerHTML', { nodeId: node.id });
      }
    } catch (err) {
      trace.error('renderer:patchElement-innerHTML-failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
      try { el.textContent = resolvedTextContent; } catch { /* ignore */ }
    }
  } else if (resolvedTextContent && node.children.length === 0 && !hasActiveTextBinding) {
    // Patch text content (only for leaf nodes)
    if (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
      if (el.childNodes[0].textContent !== resolvedTextContent) {
        el.childNodes[0].textContent = resolvedTextContent;
      }
    } else if (el.textContent !== resolvedTextContent || el.childElementCount > 0) {
      // `el.textContent` STRIPS child element tags, so a rich→plain flatten — styled
      // `<span>` runs removed in source but still in the live DOM — compares EQUAL
      // ("Guidance…chapter." === "Guidance…chapter.") and would SKIP, leaving the
      // stale styled spans on canvas (mixed colors) AND letting the next text-edit
      // round-trip re-serialize them back into the code. A plain leaf has NO element
      // children, so `childElementCount > 0` forces the bare text, which removes them.
      el.textContent = resolvedTextContent;
    }
  } else if (shouldClearEmptiedText(node, resolvedTextContent, hasActiveTextBinding, !!el.textContent)) {
    el.textContent = '';
    trace.dom('renderer:clear-emptied-text', { nodeId: node.id, tag: node.type });
  }

  // Locale overrides (non-default language: text w/ per-viewport bucketing, attrs, styles).
  // Shared with buildNodeElement via applyLocaleOverrides so build + patch stay in lockstep.
  applyLocaleOverrides(el, node, localeOverrides, vpWidth, '');

  // Patch children recursively (pass bindingData so bound text/attrs resolve for collection items).
  // SKIP for opaque graphics: their children live in graphicMarkup innerHTML (no
  // data-node-id), and the reconciler would strip those untracked svg shapes as
  // "stale shape-edit leftovers".
  if (node.graphicMarkup === undefined) {
    patchChildElements(el, node.children, allNodes, onNodeMouseDown, idPrefix, variantName, localeOverrides, bindingData, vpWidth);
  }

  // Patch completed for this subtree — remember the signature so the next
  // render can skip it wholesale when nothing changed. (Dynamic subtrees and
  // locale/binding renders keep patchKey null and always re-patch.)
  if (patchKey) (el as HTMLElement & { __revymePatchKey?: string }).__revymePatchKey = patchKey;

  // ─── Collection list: rebuild ghost copies on patch ─────────────────────
  // buildNodeElement creates ghosts on initial render; patchElement must also
  // handle them so that adding/removing items in the data array is reflected.
  if (node.collectionList) {
    const { source, templateIds } = node.collectionList;
    const isInlineMap = source.startsWith('__inline:');
    const rawData = isInlineMap
      ? (node.inlineMapData || [])
      : getCollectionData(source);
    // Resolve the active variant the SAME way as applyNodeCmsBindings: artboard
    // variantName → instance per-viewport variant → baked componentVariant. Then
    // applyChainConfig merges base ← per-viewport ← per-variant config overrides.
    // Per-tile variant wins over base variantName, then componentVariant — shared resolve-core helper.
    // (`__listVariant ?? undefined` below normalizes the null fallback exactly as the old `?? undefined`.)
    const __listVariant = resolveActiveVariant(node, { vpWidth, variant: variantName });
    const data = applyChainConfig(rawData as CollectionItem[], node.collectionList, vpWidth, __listVariant ?? undefined);

    // Template was dragged OUT / removed (`.map(() => null)` → templateIds empty, or
    // its node no longer exists): the list can't render rows. Drop any stale ghosts +
    // empty placeholder NOW so the canvas matches the emptied list on mouse-up — not
    // only after a reload. (Otherwise ghostCountMatch stays true and the rebuild is
    // skipped, leaving the old rows behind.)
    const __tplId = templateIds['default'] || Object.values(templateIds)[0];
    if (!__tplId || !allNodes.get(__tplId)) {
      el.querySelectorAll(':scope > [data-collection-ghost]').forEach(g => g.remove());
      el.querySelectorAll('[data-collection-empty]').forEach(ph => ph.remove());
      trace.action('renderer:patch-collection-no-template-clear', { nodeId: node.id, source });
      return;
    }

    // Check if ghost count matches data — skip rebuild if unchanged
    const existingGhosts = el.querySelectorAll(':scope > [data-collection-ghost]');
    const expectedGhostCount = Math.max(0, data.length - 1);
    const ghostCountMatch = existingGhosts.length === expectedGhostCount;

    // Also remove empty placeholder if present
    el.querySelectorAll('[data-collection-empty]').forEach(ph => ph.remove());

    // Un-hide the template row (item 0) if a prior empty state hid it. On a live
    // `.map()` over an empty filtered array NO row renders, so the empty branch
    // below hides the canvas template too; restore it now that the filter matches
    // ≥1 item again (the non-empty paths re-run patchElement on it right after).
    if (data.length > 0) {
      const tplEl0 = el.querySelector(`[data-node-id="${idPrefix + __tplId}"]`) as HTMLElement | null;
      if (tplEl0?.getAttribute('data-collection-empty-hidden')) {
        tplEl0.style.removeProperty('display');
        tplEl0.removeAttribute('data-collection-empty-hidden');
        trace.action('renderer:collection-template-unhidden', { nodeId: node.id, templateId: __tplId });
      }
    }

    // Ensure ghost-select event delegation is attached on the collection parent.
    // This runs on every patch (not just rebuild) so even preserved ghosts get the handler.
    if (isInlineMap && !el.hasAttribute('data-ghost-delegated')) {
      el.setAttribute('data-ghost-delegated', 'true');
      el.addEventListener('mousedown', (e) => {
        // Walk up from target to find a ghost root
        let target = e.target as HTMLElement | null;
        while (target && target !== el) {
          if (target.hasAttribute('data-collection-ghost')) {
            // Extract ghost index from data-node-id suffix
            const nodeId = target.getAttribute('data-node-id') || '';
            const match = nodeId.match(/__(\d+)$/);
            if (match) {
              const ghostIndex = parseInt(match[1], 10);
              const tplId = target.getAttribute('data-id') || '';
              const ghostEvent = new CustomEvent('revyme:ghost-select', {
                detail: { ghostIndex, templateId: tplId },
                bubbles: true,
              });
              document.dispatchEvent(ghostEvent);
              trace.action('renderer:ghost-select-delegated', { ghostIndex, templateId: tplId });
            }
            return;
          }
          target = target.parentElement;
        }
      }, true); // capture phase
    }

    // If ghost count matches, patch template + update ghost styles from binding data
    // (preserves CodeComponentHost React roots mounted on ghost elements — no full rebuild)
    if (ghostCountMatch && data.length > 0) {
      const templateNode = allNodes.get(templateIds['default'] || Object.values(templateIds)[0]);
      if (templateNode) {
        const templateEl = el.querySelector(`[data-node-id="${idPrefix + templateNode.id}"]`) as HTMLElement;
        if (templateEl) {
          patchElement(templateEl, templateNode, allNodes, onNodeMouseDown, idPrefix, variantName, data[0] as CollectionItem, localeOverrides, vpWidth);

          // Check if template structure changed (new/removed children via drag or creator).
          // DEEP signature — the old direct-child count (`:scope >`) missed nodes added
          // DEEPER in the template subtree (live find 2026-07-13: a text bound to
          // item.description + a frame created INSIDE the tile's inner wrapper showed
          // on the template but never on the ghosts until a page-switch rebuild).
          // Compare the full descendant data-id SEQUENCE: template ids minus the
          // viewport prefix vs ghost ids minus prefix + their `__N` suffix — catches
          // deep adds, removals, and reorders at any depth.
          const stripIdPrefix = (id: string) => (idPrefix && id.startsWith(idPrefix) ? id.slice(idPrefix.length) : id);
          const treeSig = (root: HTMLElement, ghostSuffix: string | null): string =>
            Array.from(root.querySelectorAll('[data-node-id]'))
              .map((n) => {
                let id = stripIdPrefix(n.getAttribute('data-node-id') || '');
                if (ghostSuffix && id.endsWith(ghostSuffix)) id = id.slice(0, -ghostSuffix.length);
                return id;
              })
              .join('|');
          const templateSig = treeSig(templateEl, null);
          let structureMismatch = false;
          existingGhosts.forEach(ghost => {
            const gid = ghost.getAttribute('data-node-id') || '';
            const suffix = gid.match(/__\d+$/)?.[0] ?? null;
            if (treeSig(ghost as HTMLElement, suffix) !== templateSig) structureMismatch = true;
          });

          // BINDING signature. `applyBindingDataToTree` only WRITES a bound
          // value — it has nothing to say about a field that is no longer
          // bound, so a ghost keeps painting the last value it was given.
          // Unbinding Content (× on the pill) therefore left every row showing
          // its old text even though the JSX was already correct; it only
          // cleared on the full rebuild a page switch does (user report
          // 2026-07-25). Binding / re-pointing has the same hole in reverse.
          // Compare the template subtree's binding set against the one the
          // ghosts were last built from and fall through to a rebuild on any
          // change — the structure check above can't see it (the DOM tree is
          // identical either way).
          const bindingSig = collectionBindingSignature(templateNode, allNodes);
          const prevBindingSig = el.getAttribute(GHOST_BINDING_SIG_ATTR);
          if (prevBindingSig !== null && prevBindingSig !== bindingSig) {
            trace.action('renderer:ghost-binding-mismatch', {
              nodeId: templateNode.id, prev: prevBindingSig.slice(0, 200), next: bindingSig.slice(0, 200),
            });
            structureMismatch = true;
          }
          el.setAttribute(GHOST_BINDING_SIG_ATTR, bindingSig);

          if (structureMismatch) {
            trace.action('renderer:ghost-structure-mismatch', { nodeId: templateNode.id, templateSig: templateSig.slice(0, 200) });
            // Fall through to full rebuild below (don't return)
          } else {
            // Structure matches — copy template-tree inline styles onto the
            // matching ghost subtree (so style edits propagate without a
            // full rebuild) and refresh binding data per row.
            //
            // We CANNOT call patchElement on the ghost root: patchElement
            // queries children via `[data-node-id="${idPrefix + childId}"]`
            // but ghost children carry the `__N` suffix at the END of the
            // id. The lookups miss, the reconciler treats them as stale,
            // and the children get removed mid-resize — exactly the
            // "ghosts disappear during desktop resize" symptom. Stick to
            // walking the trees in parallel and copying `el.style.cssText`
            // node-by-node — no queries, no reconciliation.
            const templateNodeEl = el.querySelector(`[data-node-id="${idPrefix + templateNode.id}"]`) as HTMLElement | null;
            for (let i = 1; i < data.length; i++) {
              const ghostSuffix = `__${i}`;
              const ghostEl = el.querySelector(`[data-node-id="${idPrefix + templateNode.id + ghostSuffix}"]`) as HTMLElement;
              if (!ghostEl) continue;
              const bindingItem = data[i] as CollectionItem;
              if (templateNodeEl) syncInlineStyles(templateNodeEl, ghostEl);
              applyBindingDataToTree(ghostEl, templateNode, allNodes, bindingItem, ghostSuffix, idPrefix, vpWidth, variantName);
            }
            // Pin the template (data-0) AHEAD of its clones. A reorder drag can
            // park the dragged template element AMONG its clones on the PRIMARY
            // (patchChildElements skips it while drag-locked, so it isn't moved
            // back to index 0); since the clones mirror the template's `order`,
            // DOM order decides and data-0 then renders BELOW its clones.
            // Replicas rebuild fresh so they're unaffected (and it self-heals on
            // page switch) — this makes the primary match without a reload.
            if (templateNodeEl) {
              const firstGhost = el.querySelector(':scope > [data-collection-ghost]') as HTMLElement | null;
              if (firstGhost && (templateNodeEl.compareDocumentPosition(firstGhost) & Node.DOCUMENT_POSITION_PRECEDING)) {
                el.insertBefore(templateNodeEl, firstGhost);
                trace.action('renderer:collection-template-repinned-first', { templateId: templateNode.id, idPrefix });
              }
            }
            // DIAGNOSTIC: after syncing, log the template + ghost orders and the
            // container's child DOM order, so "template sinks below its clones
            // after reorder" is attributable (mirror miss vs DOM-position vs a
            // stale order). Cheap — fires once per collection patch, not per child.
            trace.action('renderer:collection-order-after-sync', {
              templateId: templateNode.id, idPrefix,
              templateOrder: templateNodeEl?.style.order || '',
              kids: Array.from(el.children).map(c => {
                const k = c as HTMLElement;
                return { id: k.getAttribute('data-node-id') || `<${k.tagName.toLowerCase()}>`, order: k.style.order || '', ghost: k.hasAttribute('data-collection-ghost') };
              }),
            });
            return;
          }
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // Ghost count changed — full rebuild needed
    existingGhosts.forEach(ghost => ghost.remove());

    const templateNode = allNodes.get(templateIds['default'] || Object.values(templateIds)[0]);
    // Record what the rebuilt ghosts are being built FROM, so the next patch
    // compares against a fresh baseline (the fast path above only gets to
    // write it when the ghost count already matched).
    if (templateNode) el.setAttribute(GHOST_BINDING_SIG_ATTR, collectionBindingSignature(templateNode, allNodes));
    if (templateNode && data.length > 0) {
      // Re-render template (item 0) with binding data
      const templateEl = el.querySelector(`[data-node-id="${idPrefix + templateNode.id}"]`) as HTMLElement;
      trace.action('renderer:ghost-rebuild', { templateId: templateNode.id, idPrefix, templateElFound: !!templateEl, dataLength: data.length });
      if (templateEl) {
        const bindingItem0 = data[0] as CollectionItem;
        patchElement(templateEl, templateNode, allNodes, onNodeMouseDown, idPrefix, variantName, bindingItem0, localeOverrides, vpWidth);
      }

      // Build ghost copies for items 1+
      // Insert right after template element (not at parent end) to match live website order
      let insertAfterEl: Element | null = templateEl;
      for (let i = 1; i < data.length; i++) {
        const bindingItem = data[i] as CollectionItem;
        const ghostSuffix = `__${i}`;
        const ghostEl = buildNodeElement(
          templateNode, allNodes, onNodeMouseDown, idPrefix, variantName, bindingItem, ghostSuffix, localeOverrides, vpWidth,
        );
        if (isInlineMap) {
          const ghostIdx = i;
          ghostEl.addEventListener('mousedown', (e) => {
            const ghostEvent = new CustomEvent('revyme:ghost-select', {
              detail: { ghostIndex: ghostIdx, templateId: templateNode.id },
              bubbles: true,
            });
            ghostEl.dispatchEvent(ghostEvent);
            trace.action('renderer:ghost-select', { ghostIndex: ghostIdx, templateId: templateNode.id });
          }, true);
        } else {
          // CMS-backed ghost — see the buildNodeElement path; same rule.
          injectCmsGhostCSS();
          ghostEl.setAttribute('data-cms-ghost', 'true');
        }
        ghostEl.setAttribute('data-collection-ghost', 'true');
        // Insert after previous ghost (or template for first ghost)
        if (insertAfterEl?.nextSibling) {
          el.insertBefore(ghostEl, insertAfterEl.nextSibling);
        } else {
          el.appendChild(ghostEl);
        }
        insertAfterEl = ghostEl;
        trace.dom('renderer:patch-collection-ghost', {
          nodeId: templateNode.id, source, index: i,
          ghostId: templateNode.id + ghostSuffix,
        });
      }
    } else if (data.length === 0) {
      // Hide the template row itself (item 0). A live `.map()` over an empty
      // filtered array renders NO row, but on canvas the template is a real model
      // element that stays in the DOM — without this it shows a stale row (e.g.
      // "Marcus Chen") on top of the empty placeholder. Un-hidden above once the
      // filter matches data again.
      const tplEl0 = el.querySelector(`[data-node-id="${idPrefix + __tplId}"]`) as HTMLElement | null;
      if (tplEl0) {
        tplEl0.style.display = 'none';
        tplEl0.setAttribute('data-collection-empty-hidden', 'true');
      }
      // Show empty placeholder
      const placeholder = document.createElement('div');
      placeholder.setAttribute('data-collection-empty', 'true');
      placeholder.style.padding = '16px';
      placeholder.style.textAlign = 'center';
      placeholder.style.color = '#888';
      placeholder.style.fontSize = '13px';
      placeholder.style.fontFamily = 'system-ui, sans-serif';
      placeholder.textContent = isInlineMap
        ? `No items in ${source.replace('__inline:', '')}`
        : `No items in ${source}`;
      el.appendChild(placeholder);
    }
  }
}

/**
 * Patch children of an element to match the expected child IDs.
 */
function patchChildElements(
  parent: HTMLElement,
  childIds: string[],
  allNodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
  idPrefix: string,
  variantName?: string | null,
  localeOverrides?: Map<string, NodeOverride>,
  bindingData?: CollectionItem | null,
  vpWidth?: number,
): void {
  const existingChildren = new Map<string, HTMLElement>();
  // Untracked SVG shape children: the shape-edit library's `setSvgContent`
  // writes bare shape markup into the live SVG (stripping data-node-id via
  // its serializer's data-* filter). Those stale shapes survive shape-edit
  // exit and end up as siblings to the renderer's data-node-id children →
  // every shape paints twice (duplicate strokes / "second stroke moving
  // behind it" after subsequent attribute edits like stroke-dasharray).
  // Collect them here, remove below alongside other stale children.
  const parentIsSvg = parent.tagName.toLowerCase() === 'svg'
    || parent.namespaceURI === 'http://www.w3.org/2000/svg';
  const SVG_SHAPE_TAG_SET = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
  const staleUntrackedSvgChildren: HTMLElement[] = [];
  for (const child of Array.from(parent.children)) {
    const nid = (child as HTMLElement).getAttribute('data-node-id');
    if (nid) {
      existingChildren.set(nid, child as HTMLElement);
    } else if (parentIsSvg && SVG_SHAPE_TAG_SET.has(child.tagName.toLowerCase())) {
      staleUntrackedSvgChildren.push(child as HTMLElement);
    }
  }

  // Exclude canvas nodes — they are hoisted to container level (not rendered inside viewports)
  const expectedPrefixedIds = childIds
    .filter(id => !allNodes.get(id)?.isCanvasNode)
    .map(id => idPrefix + id);

  // Remove children not in expected list (includes stale canvas nodes inside viewport).
  // Preserve collection ghost copies — they are managed by the collection list handler in patchElement.
  for (const [nid, el] of existingChildren) {
    if (!expectedPrefixedIds.includes(nid) && !el.hasAttribute('data-collection-ghost')) {
      // Drag-locked children are placed here IMPERATIVELY by the active
      // strategy (reparentLive mid-drag entry) — a render carrying a STALE
      // pre-entry snapshot has this parent's childIds WITHOUT the entered
      // node and would strip it right back out (then patchCanvasNodes'
      // build branch resurrected it at the canvas root → the reparent
      // glitch). Leave locked elements where the strategy put them; the
      // post-drop unlocked render reconciles from committed source.
      const canonical = el.getAttribute('data-id') || nid;
      if (_dragLockedNodeIds.has(canonical)) {
        trace.action('renderer:patch-children-keep-locked-extra', {
          parentNodeId: parent.getAttribute('data-node-id'), childId: nid,
        });
        continue;
      }
      el.remove();
    }
  }
  // Drop shape-edit leftovers (see the collection comment above).
  for (const stale of staleUntrackedSvgChildren) {
    trace.dom('renderer:remove-untracked-svg-shape', { parentNodeId: parent.getAttribute('data-node-id'), tag: stale.tagName.toLowerCase() });
    stale.remove();
  }
  // ATOMIC creator-placeholder swap: a creator drew the node into this flex slot
  // imperatively (`data-placeholder-id="create-<id>"`, see holdFlexSlotPlaceholder)
  // for instant feedback. Now that the REAL node is rendering in this same patch,
  // drop its placeholder in the SAME frame — no overlap / reflow flash, no jump.
  for (const child of Array.from(parent.children)) {
    const phId = (child as HTMLElement).getAttribute?.('data-placeholder-id');
    if (phId && phId.startsWith('create-') && childIds.includes(phId.slice('create-'.length))) {
      (child as HTMLElement).remove();
    }
  }

  // DIAGNOSTIC: log the expected child order vs the current DOM order + each
  // element's inline `order` — pinpoints whether a stale reorder is a DOM-order
  // miss (insertBefore not firing) or a lingering inline `order` overriding it.
  const _pcParentId = parent.getAttribute('data-node-id');
  if (_pcParentId === idPrefix + 'root' || _pcParentId === 'root') {
    trace.action('renderer:patch-children-order', {
      parentNodeId: _pcParentId, idPrefix, expected: expectedPrefixedIds,
      domBefore: Array.from(parent.children).map(c => ({
        id: (c as HTMLElement).getAttribute('data-node-id') || `<${c.tagName.toLowerCase()}>`,
        order: (c as HTMLElement).style.order || '',
      })),
    });
  }

  // Create or update children in correct order
  let prevChild: Element | null = null;
  for (let i = 0; i < childIds.length; i++) {
    const childId = childIds[i];
    const prefixedId = idPrefix + childId;
    const childNode = allNodes.get(childId);
    if (!childNode || childNode.isCanvasNode) continue;

    // Drag-locked children: skip ENTIRELY. The strategy may have lifted
    // them out of this parent (LayoutLifted moves to `contentRoot` via
    // `bridge.liftNode` so the dragged overlay can move freely across
    // overflow:hidden ancestors). If we let the normal reconciliation
    // run, it would either build a fresh element (creating a duplicate
    // with the same `data-node-id`) or `insertBefore` the lifted
    // element back into this parent — which changes its positioned
    // ancestor, so its imperative `left/top` (captured in contentRoot
    // space) is reinterpreted in the new parent's space and the dragged
    // overlay visibly JUMPS. Skipping leaves the lifted element under
    // contentRoot for the rest of the drag; cleanup re-renders it
    // normally once the lock is released.
    if (_dragLockedNodeIds.has(childId)) {
      // The locked child still occupies a DOM slot — update `prevChild`
      // to it so any subsequent NEW child (e.g. an alt-duplicate
      // inserted into source while the lock is held) gets positioned
      // AFTER this DOM element, not prepended to the parent. Without
      // this, every new child piles up at `parent.firstElementChild`
      // because the skip leaves `prevChild = null` for the whole loop.
      // NOTE: a child skipped here is NOT repositioned — so if a structural
      // reorder lands while the lock is still held, the primary tile keeps
      // the OLD DOM order (replicas rebuild fresh, so they look correct →
      // primary-only stale-order symptom).
      trace.action('renderer:patch-children-skip-locked', {
        parentNodeId: parent.getAttribute('data-node-id'),
        childId, prefixedId, expectedIndex: i,
      });
      const lockedEl = existingChildren.get(prefixedId);
      if (lockedEl) prevChild = lockedEl;
      continue;
    }

    let childEl = existingChildren.get(prefixedId);

    // Tag-mismatch guard: a node can switch element types in source code
    // (e.g. the in-tree SVG editor (src/svg-editor/) normalizes <ellipse>/<rect>/<polygon> to
    // <path> after the first user edit). The reused element's tagName
    // doesn't match the new type, and patchElement's attribute writes
    // silently no-op (a <path> ignores `points`, an <ellipse> ignores
    // `d`). Drop the stale element so the build branch creates a fresh
    // one of the right tag. Mirror buildNodeElement's tag-resolution
    // logic so the comparison stays in sync.
    if (childEl) {
      let rawType = childNode.type.startsWith('motion.') ? childNode.type.slice(7) : childNode.type;
      if (rawType === 'Link' || rawType === 'MotionLink') rawType = 'a';
      else if (rawType === 'Image') rawType = 'img';
      const expectedTag = VALID_TAGS.has(rawType) ? rawType : 'div';
      if (childEl.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
        trace.action('renderer:tag-mismatch-replace', {
          nodeId: childNode.id,
          oldTag: childEl.tagName.toLowerCase(),
          newTag: expectedTag,
        });
        childEl.remove();
        childEl = undefined;
      }
    }

    let wasBuilt = false;
    if (childEl) {
      patchElement(childEl, childNode, allNodes, onNodeMouseDown, idPrefix, variantName, bindingData, localeOverrides, vpWidth);
    } else {
      childEl = buildNodeElement(childNode, allNodes, onNodeMouseDown, idPrefix, variantName, bindingData, '', localeOverrides, vpWidth);
      wasBuilt = true;
    }

    // Find the correct position, skipping over collection ghost elements
    // (ghosts are managed by the collection handler in patchElement, not here)
    let correctNext: Element | null = prevChild ? prevChild.nextElementSibling : parent.firstElementChild;
    while (correctNext && correctNext.hasAttribute('data-collection-ghost')) {
      correctNext = correctNext.nextElementSibling;
    }
    if (childEl !== correctNext) {
      if (_pcParentId === idPrefix + 'root' || _pcParentId === 'root') {
        trace.action('renderer:patch-children-move', { parentNodeId: _pcParentId, childId, wasBuilt, expectedIndex: i });
      }
      if (prevChild) {
        // Insert after prevChild, but skip any ghost elements between them
        let insertBefore = prevChild.nextElementSibling;
        while (insertBefore && insertBefore.hasAttribute('data-collection-ghost')) {
          insertBefore = insertBefore.nextElementSibling;
        }
        if (insertBefore) {
          parent.insertBefore(childEl, insertBefore);
        } else {
          parent.appendChild(childEl);
        }
      } else {
        parent.prepend(childEl);
      }
    }

    // For freshly built SVG-shape children that just got inserted into an
    // SVG parent: applyStrokeAlignment ran inside buildNodeElement BEFORE
    // the element had a parent, so `el.closest('svg')` returned null and
    // the `<clipPath>` def never got created. Re-apply now that the child
    // is connected to its parent SVG — otherwise the iframe paints one
    // frame as Center before the next render cycle rebuilds the def, and
    // the user sees a Center→Inside flash on shape-edit commit.
    if (wasBuilt && isSvgTag(childNode.type) && childNode.attrs) {
      const parentIsSvg = parent.tagName.toLowerCase() === 'svg'
        || parent.namespaceURI === 'http://www.w3.org/2000/svg';
      if (parentIsSvg) {
        applyStrokeAlignment(childEl, childNode.type, childNode.attrs, childNode.id);
      }
    }

    // Track prevChild including any trailing ghosts (so next child inserts after them)
    prevChild = childEl;
    while (prevChild.nextElementSibling?.hasAttribute('data-collection-ghost')) {
      prevChild = prevChild.nextElementSibling;
    }
  }
}

/**
 * Patch canvas-level nodes (outside viewports).
 */
/**
 * Render canvas nodes that are CHILDREN of viewport roots at container level.
 * These nodes have isCanvasNode=true but are children of root in the code.
 * Hoisting them to container level prevents viewport overflow:hidden from clipping them.
 * Position is offset by the viewport origin so they appear at the correct canvas position.
 */
function patchHoistedCanvasNodes(
  container: HTMLElement,
  hoisted: { node: CanvasNode; vpX: number; vpY: number }[],
  allNodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
): void {
  for (const { node } of hoisted) {
    // Look for existing element at container level (may have been hoisted in a previous render)
    let el = container.querySelector(`[data-node-id="${node.id}"][data-hoisted-canvas]`) as HTMLElement | null;
    const allMatches = Array.from(container.querySelectorAll(`[data-node-id="${node.id}"]`)) as HTMLElement[];

    if (el) {
      trace.action('renderer:patchHoistedCanvasNodes:reuse', {
        nodeId: node.id,
        totalMatches: allMatches.length,
        styles: { left: node.styles?.left, top: node.styles?.top, position: node.styles?.position },
      });
      patchElement(el, node, allNodes, onNodeMouseDown, '');
    } else {
      // Also check if it exists inside the viewport (first render after adding this feature)
      const insideVp = container.querySelector(`[data-node-id="${node.id}"]:not([data-hoisted-canvas])`) as HTMLElement | null;
      trace.action('renderer:patchHoistedCanvasNodes:create', {
        nodeId: node.id,
        foundInsideVp: !!insideVp,
        totalMatches: allMatches.length,
        styles: { left: node.styles?.left, top: node.styles?.top, position: node.styles?.position },
      });
      if (insideVp) insideVp.remove();

      el = buildNodeElement(node, allNodes, onNodeMouseDown);
      el.setAttribute('data-hoisted-canvas', 'true');
      el.style.position = 'absolute';
      container.appendChild(el);
    }

    // Canvas nodes are in absolute canvas coordinates — independent of viewport position.
    // No viewport offset needed — they're siblings of viewport roots in the container.
  }
}

/**
 * Render slot-connected canvas nodes at container level. They live as
 * `data-canvas-node` children of a code-component tag in the JSX, but in
 * the editor they float like any other canvas node — positioned by their
 * own `style.left/top` (applied by `buildNodeElement`/`patchElement`), so
 * dragging them commits to `style` normally.
 */
function patchSlotCanvasNodes(
  container: HTMLElement,
  slotNodes: CanvasNode[],
  allNodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
): void {
  for (const node of slotNodes) {
    let el = container.querySelector(`[data-node-id="${node.id}"][data-slot-canvas]`) as HTMLElement | null;
    if (el) {
      patchElement(el, node, allNodes, onNodeMouseDown, '');
    } else {
      // First float after a connect — drop any copy still inside the
      // component's DOM subtree, then build a fresh container-level one.
      const inside = container.querySelector(`[data-node-id="${node.id}"]:not([data-slot-canvas])`) as HTMLElement | null;
      if (inside) inside.remove();
      el = buildNodeElement(node, allNodes, onNodeMouseDown);
      el.setAttribute('data-slot-canvas', 'true');
      container.appendChild(el);
    }
    el.style.position = 'absolute';
  }
}

function patchCanvasNodes(
  container: HTMLElement,
  canvasRoots: CanvasNode[],
  allNodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
): void {
  const canvasIds = new Set(canvasRoots.map(n => n.id));

  const existingCanvasEls = new Map<string, HTMLElement>();
  // Also track the canonical (unprefixed) `data-id` for each entry so the
  // drag-lock check below matches on REPLICA elements too. `data-node-id`
  // is prefixed for replicas (e.g. `tablet-x`) but `_dragLockedNodeIds`
  // holds canonical IDs (`x`), so a `Set.has(data-node-id)` lookup misses
  // on replica drags and the lifted element gets `.remove()`d mid-drag.
  const existingCanonicalIds = new Map<string, string>();
  for (const child of Array.from(container.children)) {
    const el = child as HTMLElement;
    if (el.hasAttribute('data-viewport') || el.hasAttribute('data-canvas-styles') || el.hasAttribute('data-hoisted-canvas')) continue;
    const nid = el.getAttribute('data-node-id');
    if (nid) {
      existingCanvasEls.set(nid, el);
      const canonical = el.getAttribute('data-id') || nid;
      existingCanonicalIds.set(nid, canonical);
    }
  }

  trace.action('renderer:patchCanvasNodes', {
    canvasRootIds: canvasRoots.map(n => n.id),
    existingDomIds: Array.from(existingCanvasEls.keys()),
    willRemove: Array.from(existingCanvasEls.keys()).filter(nid =>
      !canvasIds.has(nid) && !_dragLockedNodeIds.has(existingCanonicalIds.get(nid) || nid)
    ),
  });

  for (const [nid, el] of existingCanvasEls) {
    // Drag-locked nodes live in `container` (contentRoot) during the lift
    // — LayoutLiftedStrategy's / GridDragStrategy's `bridge.liftNode` does
    // `contentRoot.appendChild(el)` so the dragged overlay can move freely
    // across overflow:hidden ancestors. They show up here as "not in
    // canvasIds" (they're regular flex/grid children, not canvasNodes), so
    // the remove loop below would WIPE the lifted overlay from the DOM
    // mid-drag. Skip them.
    //
    // Use the canonical `data-id` (NOT the prefixed `data-node-id`) for
    // the lock lookup — on replicas the `data-node-id` is `tablet-x` /
    // `mobile-x` but `_dragLockedNodeIds` stores canonical IDs.
    const canonical = existingCanonicalIds.get(nid) || nid;
    if (_dragLockedNodeIds.has(canonical)) continue;
    if (!canvasIds.has(nid)) el.remove();
  }

  for (const node of canvasRoots) {
    let el = existingCanvasEls.get(node.id);
    if (el) {
      patchElement(el, node, allNodes, onNodeMouseDown, '');
    } else {
      // Drag-locked node with NO element at the container root: the active
      // strategy moved its element imperatively (reparentLive entry into a
      // frame, liftNode). Building here would RESURRECT it at the canvas
      // root from a possibly STALE snapshot (during a drag,
      // canvasInteracting blocks nodesAtom re-derivation, so a mid-drag
      // forceRender can carry PRE-ENTRY canvasRoots) — the "glitches out
      // and offsets on reparent" bug: the entered element got rebuilt at
      // the root and every parent-relative per-frame write resolved against
      // the content root. The post-drop unlocked render rebuilds it
      // correctly from committed source.
      if (_dragLockedNodeIds.has(node.id)) {
        trace.action('renderer:patchCanvasNodes-skip-locked-build', { nodeId: node.id });
        continue;
      }
      el = buildNodeElement(node, allNodes, onNodeMouseDown);
      el.style.position = 'absolute';
      container.appendChild(el);
    }
  }
}

// ─── Element Builder ────────────────────────────────────────────────────────

function buildNodeElement(
  node: CanvasNode,
  nodes: Map<string, CanvasNode>,
  onNodeMouseDown: (nodeId: string, e: MouseEvent) => void,
  idPrefix: string = '',
  variantName?: string | null,
  bindingData?: CollectionItem | null,
  idSuffix: string = '',
  localeOverrides?: Map<string, NodeOverride>,
  vpWidth?: number,
): HTMLElement {
  // Strip motion. prefix for canvas rendering (motion.h1 → h1, motion.span → span)
  // Map Next.js built-in components to their HTML equivalents
  const NEXTJS_TAG_MAP: Record<string, string> = { 'Link': 'a', 'MotionLink': 'a', 'Image': 'img' };
  let rawType = node.type.startsWith('motion.') ? node.type.slice(7) : node.type;
  rawType = NEXTJS_TAG_MAP[rawType] || rawType;
  const tag = VALID_TAGS.has(rawType) ? rawType : 'div';
  const isSvg = isSvgTag(tag);
  const el = isSvg
    ? document.createElementNS(SVG_NS, tag) as unknown as HTMLElement
    : document.createElement(tag);
  el.setAttribute('data-node-id', idPrefix + node.id + idSuffix);
  el.setAttribute('data-id', node.id);

  // Images: load EAGERLY on the canvas. `loading="lazy"` uses the iframe
  // viewport for its intersection check, but the canvas content is panned/
  // scaled via a `translate3d`+`scale` transform on `contentRoot`, so the
  // browser's lazy heuristic mis-judges what's visible — images in the
  // translated region stay unloaded (blank) until a pan/zoom brings them into
  // the iframe viewport ("image stops loading, reappears when I move"). A
  // design surface should always show its images; eager is the correct trade.
  if (tag === 'img') {
    (el as HTMLImageElement).loading = 'eager';
  }

  // Overlay nodes: mark for CSS-based visibility control. Canvas-node overlays
  // are stamped too — they must obey overlay mode (show only while editing,
  // hide on exit) just like viewport overlays (see patchElement above).
  if (node.attrs?.['data-overlay']) {
    el.setAttribute('data-overlay-node', 'true');
  }

  // Placeholder node for {children} slot in layout editing
  if (node.isChildrenSlot) {
    // Apply node.styles FIRST (e.g. flex:1, minHeight:200px from store.ts) so
    // the slot has its sizing on the very first render. Without this, the
    // first render falls through here without ever applying flex:1 — the
    // placeholder collapses to its intrinsic content size and only "fixes
    // itself" on the next patchElement cycle (after any user action).
    for (const [key, value] of Object.entries(node.styles)) {
      try { (el.style as any)[key] = value; } catch { /* skip */ }
    }
    el.style.border = '1px solid rgba(136,91,255,0.25)';
    el.style.borderRadius = '4px';
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.gap = '6px';
    el.style.cursor = 'default';
    el.style.backgroundColor = 'rgba(136,91,255,0.04)';
    // The {children} slot is the page-content area — it ALWAYS fills the full
    // width (real page roots render at width:100%). `align-self: stretch` makes
    // it immune to the Template root's `align-items`, so changing Align never
    // shrinks or re-centers the placeholder.
    el.style.alignSelf = 'stretch';
    el.setAttribute('data-placeholder-slot', 'true');
    el.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(136,91,255,0.5)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18"/></svg><span style="font-size:11px;color:rgba(136,91,255,0.6);font-family:system-ui,sans-serif;font-weight:500">Placeholder</span><span style="font-size:10px;color:rgba(136,91,255,0.35);font-family:system-ui,sans-serif;text-align:center;line-height:1.3">Your page content<br>will appear here.</span>`;
    trace.dom('renderer:build-children-slot-placeholder', { nodeId: node.id });
    return el; // Skip normal children rendering
  }

  // Layout nodes: locked visual chrome.
  // The layout root wraps page content — it needs pointer-events so children are clickable.
  // Only non-root layout nodes (navbar, footer, their children) block pointer events.
  if (node.fromLayout) {
    el.setAttribute('data-layout-node', 'true');
    if (node.parentId) {
      // Non-root layout node — block interaction
      el.style.pointerEvents = 'none';
    }
  }

  if (isSvg) {
    trace.action('renderer:build-svg-element', { nodeId: node.id, tag });
  }

  // Code component nodes: render as container for live React mount (skip static child building)
  if (node.isCodeComponent) {
    el.setAttribute('data-code-component', 'true');
    el.setAttribute('data-code-component-component', node.type);
    el.setAttribute('data-code-component-file', node.componentFile || '');
    // Base + variant + band overrides — the same resolution the patch branch
    // applies. This early-return path previously used RAW node.styles: the
    // first paint missed per-viewport band values entirely (masked by band
    // CSS at rest, exposed when the viewport-drag pin turns the tile's
    // container queries off — the counters' 88px mobile width snapped back
    // to base mid-drag).
    const containerStyles = {
      ...resolveVariantStyles(node, variantName, vpWidth),
      ...getResponsiveOverridesForNode(node.id, vpWidth),
    };
    for (const [key, value] of Object.entries(containerStyles)) {
      const v = (key === 'position' && value === 'fixed') ? 'absolute' : value;
      setElStyle(el, key, v); // setElStyle handles `--custom-props` (bracket assign no-ops them)
    }
    // Apply a minimum size so the element is visible/selectable
    if (!containerStyles.width) el.style.minWidth = '100px';
    if (!containerStyles.height) el.style.minHeight = '40px';
    el.style.display = el.style.display || 'block';
    // Mousedown for selection
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      onNodeMouseDown(node.id, e);
    });
    trace.dom('renderer:build-code-component-container', { nodeId: node.id, component: node.type });
    return el; // Skip child rendering — live React will fill this
  }

  // Resolve styles: base + variant overrides + @media responsive overrides
  const buildBaseStyles = resolveVariantStyles(node, variantName, vpWidth);
  const buildResponsive = getResponsiveOverridesForNode(node.id, vpWidth);
  const resolvedStyles = Object.keys(buildResponsive).length > 0
    ? { ...buildBaseStyles, ...buildResponsive }
    : buildBaseStyles;
  // Same allow-list / strip filter as the patch path — applied here on
  // initial build so the FIRST render doesn't paint visual props on the
  // outer instance wrapper (which would visibly double padding/border/etc.
  // against the inner root that already has them via the style spread).
  const buildIsInstanceWrapper = !!node.isComponentInstance;
  const buildIsComponentRootInInstance = !!(node.componentInstanceId && node.isComponentRoot);
  // Variant-scoped locale CSS carrier on first build — see patchElement's
  // isComponentRootInInstance stamp for the rationale/precedence.
  if (buildIsComponentRootInInstance) {
    const rv = (vpWidth != null ? node.responsiveVariantMap?.[vpWidth] : undefined)
      ?? node.componentVariant ?? 'default';
    el.setAttribute('data-variant', rv);
  }
  // Viewport width for vw/vh (and clamp(…vw…)) resolution on the FIRST paint.
  // The element isn't in the DOM yet, so we can't read `data-viewport-width` off an
  // ancestor (patchElement does) — use the threaded vpWidth, fallback 1440.
  const buildVpWidthPx = vpWidth || 1440;
  // Record every key this build writes into `_prevPatchedKeys` (below, after
  // the loop) — the same ledger patchElement keeps. Without the seed, a key
  // baked inline from a RESPONSIVE OVERRIDE at build time (e.g. an element
  // rebuilt mid-drag with a band `display:none`) is invisible to the
  // stale-clear when the override later disappears: prevKeys is empty, the
  // key isn't in the new styleEntries, so the inline value lingers forever —
  // the "undo doesn't un-hide the tablet copy until a page switch" bug.
  const buildPatchedKeys = new Set<string>();
  for (const [key, value] of Object.entries(resolvedStyles)) {
    // Skip empty values on a FRESH element. They're "remove this property"
    // markers (meaningful only when re-patching an element that already has the
    // value — that's why patchElement uses a clear-empties-first two-pass). On a
    // brand-new element there's nothing to clear, and worse: an empty SHORTHAND
    // like `background: ''` that sorts AFTER its longhands (`backgroundImage`)
    // would reset the shorthand and wipe the longhands we just set — the
    // background-image vanished on initial render and only came back on drag
    // (which re-patches via patchElement's two-pass). Mirrors the sandbox
    // renderer's `applyStyles` (`if (!value) continue`).
    if (value === '') continue;
    if (buildIsInstanceWrapper) {
      // Outer wrapper allow-list: positioning + dimensions + overflow, PLUS
      // `display:'none'` from hiddenOnVariants so a hidden instance is removed
      // from layout (not just its inner content). See the patchElement filter.
      const wrapperAllowed = key === 'width' || key === 'height' || key === 'overflow'
        || (key === 'display' && value === 'none')
        || WRAPPER_ONLY_STYLE_PROPS.has(key);
      if (!wrapperAllowed) continue;
    } else if (buildIsComponentRootInInstance) {
      // Inner root deny-list: width/height come from `100%` filling the
      // wrapper; wrapper-only props belong on the outer.
      if (key === 'width' || key === 'height') continue;
      if (WRAPPER_ONLY_STYLE_PROPS.has(key)) continue;
    }
    // Convert position:fixed → position:absolute for canvas compatibility
    // (CSS transforms on the canvas wrapper break fixed positioning)
    let v = (key === 'position' && value === 'fixed') ? 'absolute' : value;
    // Resolve vw/vh — including inside clamp() — against the simulated viewport on
    // the FIRST build too. Without this, `clamp(40px, 6.6vw, 86px)` was left for CSS
    // to resolve against the IFRAME WINDOW (wrong size) until a page-switch triggered
    // patchElement (which already resolves it). Mirrors patchElement's line ~1934.
    if (typeof v === 'string') v = resolveResponsiveUnits(v, buildVpWidthPx);
    // setElStyle (not bracket assignment) so CSS custom properties (`--X`, e.g. an overlay-
    // border variable consumed by the `::after`) apply on the FIRST render too — bracket
    // assignment silently no-ops them, so the border only appeared after a later patchElement
    // cycle (page-switch) until this was fixed.
    setElStyle(el, key, v);
    // Mirror patchElement's styleEntries filter: overlay position props are
    // EXCLUDED from patch entries (the Renderer positions overlays
    // per-viewport in the portal), so seeding them would make the first
    // patch stale-clear the overlay's placement.
    const isOverlayPosKey = !!node.attrs?.['data-overlay']
      && (key === 'top' || key === 'left' || key === 'right' || key === 'bottom');
    if (!isOverlayPosKey) buildPatchedKeys.add(key);
  }
  if (buildPatchedKeys.size > 0) {
    _prevPatchedKeys.set(el, buildPatchedKeys);
    if (Object.keys(buildResponsive).length > 0) {
      trace.dom('renderer:build-seed-keys', { nodeId: node.id, overrideKeys: Object.keys(buildResponsive), keyCount: buildPatchedKeys.size });
    }
  }

  // Instance wrapper size fallback: same logic as the patchElement path
  // (line ~1117) but applied here on the FIRST build. Without it, the
  // wrapper renders at 0×0 on the initial paint of a master view —
  // patchElement's fallback only runs on subsequent renders. Copy the
  // master root's width/height onto the wrapper if neither the JSX nor
  // a previous patch already set them. The master root then fills the
  // wrapper via `100%`/`100%`, set after its own buildNodeElement
  // attaches it as `el.firstElementChild`.
  if (buildIsInstanceWrapper) {
    const rootNodeId = node.children[0];
    const rootNode = rootNodeId ? nodes.get(rootNodeId) : null;
    if (rootNode) {
      // Use the root's VARIANT/VIEWPORT-RESOLVED styles, NOT its base `styles`
      // — a per-viewport variant replica's conditional height (e.g. variant-2
      // → 293px) lives on the root's conditionalStyles and is skipped on the
      // root itself; the wrapper is the only place it can land. Base `styles`
      // gave every tile the DEFAULT height → squished/overlapping rows on
      // replicas (matches the patchElement fix). See resolveVariantStyles.
      const buildWrapperRootStyles = resolveVariantStyles(rootNode, variantName, vpWidth);
      if (!el.style.width && !node.styles.width && buildWrapperRootStyles.width) {
        el.style.width = buildWrapperRootStyles.width;
      }
      if (!el.style.height && !node.styles.height && buildWrapperRootStyles.height) {
        el.style.height = buildWrapperRootStyles.height;
      }
      // Mirror the root's clipping overflow on the FIRST paint too (same
      // rationale as the patchElement path — the wrapper is the flex item, so
      // its overflow decides the automatic minimum size / collapse parity with
      // the deployed single-div instance). Instance-tag overflow (applied by
      // the build style loop above) wins when present.
      if (!el.style.overflow && !node.styles.overflow) {
        const buildRootOverflow = resolveInstanceWrapperOverflow(resolveVariantStyles(rootNode, variantName, vpWidth));
        if (buildRootOverflow !== 'visible') {
          el.style.overflow = buildRootOverflow;
          trace.dom('renderer:instance-wrapper-overflow-build', { nodeId: node.id, overflow: buildRootOverflow });
        }
      }
    }
  }

  // Next.js <Image fill> → width:100% height:100% (fill makes image fill positioned parent)
  if ((node.type === 'Image' || node.type === 'img' || node.type === 'motion.img') && node.attrs?.fill !== undefined) {
    if (!resolvedStyles.width) el.style.width = '100%';
    if (!resolvedStyles.height) el.style.height = '100%';
    trace.dom('renderer:image-fill-resolved', { nodeId: node.id });
  }

  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key === 'href') continue;  // Skip href on canvas
      // Variable binding (`var:<name>`) — not a literal DOM value (see patchElement).
      if (typeof value === 'string' && value.startsWith('var:')) continue;
      el.setAttribute(key, node.responsiveAttrs ? resolveResponsiveAttr(node, key, value, vpWidth, variantName) : value);
    }
  }

  // Apply SVG-specific attributes (must use setAttribute, not style)
  if (isSvg && node.attrs) {
    for (const attr of SVG_ATTRS) {
      // Variant-resolved GEOMETRY wins over the base attr (see the build-element path above) so a
      // per-variant `d`/geometry edit shows on the tile instead of snapping back to the primary shape.
      const variantGeom = GEOMETRY_VARIANT_ATTRS.has(attr) ? buildBaseStyles[attr] : undefined;
      const val = variantGeom ?? node.attrs[attr];
      if (val !== undefined && val !== '') {
        const svgAttr = attr.replace(/([A-Z])/g, '-$1').toLowerCase();
        el.setAttribute(svgAttr, val);
        // See build-element path: clear stale inline CSS so a variant geometry
        // attribute isn't overridden by a leftover `d: path(...)` inline style.
        if (variantGeom !== undefined && (el.style as any)[attr]) {
          try { (el.style as any)[attr] = ''; } catch { /* invalid prop */ }
        }
      }
    }
    applyStrokeAlignment(el, node.type, node.attrs, node.id);
  }

  // Opaque imported graphic — build-path twin of patchElement's
  // graphicMarkup injection (see there for why innerHTML, not child nodes).
  if (node.graphicMarkup !== undefined && isSvg) {
    try {
      el.innerHTML = node.graphicMarkup;
      (el as HTMLElement & { __graphicMarkup?: string }).__graphicMarkup = node.graphicMarkup;
      trace.dom('renderer:build-graphic-markup', { nodeId: node.id, length: node.graphicMarkup.length });
    } catch (err) {
      trace.error('renderer:build-graphic-markup-failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── Data binding resolution ─────────────────────────────────────────────
  // Resolve ALL CMS bindings (text / style / attr) for this row, honoring
  // per-viewport rebind / unbind→default at vpWidth. Skip href (canvas links
  // must not navigate). `textApplied` tells us whether a text binding set the
  // content — if not, fall through to the normal (non-binding) text path.
  const { textApplied } = bindingData
    ? applyNodeCmsBindings(el, node, bindingData, vpWidth, variantName, { skipHref: true })
    : { textApplied: false };
  if (!textApplied) {
    // Normal text content (no text binding active). Skip SVG nodes — their
    // children (polygon, path, etc.) are rendered by the generator, not innerHTML.
    // Per-variant text resolves the same way as in patchElement so the first paint
    // of a variant tile already shows that variant's text. Per-VIEWPORT override wins on a replica tile.
    // Rich-text locale runs win over raw source (same rule as patchElement) —
    // the raw inner JSX would paint literal `{t('…')}` calls.
    // `textOverrides` (useResponsiveText) sits just above node.textContent in
    // precedence — same order patchElement applies. It was MISSING from this
    // build chain entirely: the first paint showed primary text on replica
    // tiles until any later patch pass re-resolved it.
    const buildText = localeOverrides?.get(node.id)?.innerJsx
      ?? getResponsiveTextValueForNode(node, vpWidth) ?? resolveConditionalText(node, variantName, vpWidth)
      ?? getTextOverrideBucketValue(node, vpWidth) ?? node.textContent;
    const buildUseInnerHTML = shouldUseInnerHTML(node.type, buildText, node.hasMixedContent, node.children.length, node.isChildrenSlot, node.textIsLiteral);
    if (buildUseInnerHTML) {
      try {
        el.innerHTML = jsxStyleToHTML(buildText);
        trace.dom('renderer:build-innerHTML', { nodeId: node.id });
      } catch (err) {
        trace.error('renderer:buildNodeElement-innerHTML-failed', { nodeId: node.id, error: err instanceof Error ? err.message : String(err) });
        try { el.textContent = buildText; } catch { /* ignore */ }
      }
    } else if (buildText && node.children.length === 0) {
      el.textContent = buildText;
    }
  }

  // Locale overrides (non-default language: text w/ per-viewport bucketing, attrs, styles).
  // Shared with patchElement via applyLocaleOverrides — build now gets the SAME per-viewport text
  // bucketing patch already had (was plain override.text here → primary text on a per-viewport locale).
  applyLocaleOverrides(el, node, localeOverrides, vpWidth, 'build-');

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    onNodeMouseDown(node.id, e);
  });

  // ─── Build children ──────────────────────────────────────────────────────
  for (const childId of node.children) {
    const childNode = nodes.get(childId);
    if (childNode) {
      const childEl = buildNodeElement(childNode, nodes, onNodeMouseDown, idPrefix, variantName, bindingData, idSuffix, localeOverrides, vpWidth);
      el.appendChild(childEl);
      // Re-apply stroke alignment now that the child is connected to its
      // parent SVG — the in-child applyStrokeAlignment call above ran
      // before this appendChild, so `el.closest('svg')` returned null and
      // the `<defs>` / `<clipPath>` never got created. Without this
      // re-apply, Inside alignment silently fails the first time a shape's
      // SVG wrapper is freshly built (canvas→viewport reparent, page
      // load, etc.) until the next non-build patch cycle.
      if (isSvg && childNode.attrs && isSvgTag(childNode.type)) {
        applyStrokeAlignment(childEl, childNode.type, childNode.attrs, childNode.id);
      }
    }
  }

  // Instance wrapper post-build pass: mirror patchElement's master-root-
  // fill logic (line ~1128) on the FIRST build. Without this, the
  // master-root child of an instance wrapper renders with NO width/height
  // (they're stripped above by the buildIsComponentRootInInstance branch
  // expecting `100%` to come from this fallback). The DOM the user
  // reported showed exactly that: wrapper sized 303×212 but inner master
  // root with only background-color/border-radius — no size — so the
  // colored block doesn't fill until a 2 px drag triggers patchElement.
  if (buildIsInstanceWrapper) {
    el.style.overflow = el.style.overflow || 'visible';
    const innerRoot = el.firstElementChild as HTMLElement | null;
    if (innerRoot) {
      const wrapperHasWidth = !!el.style.width;
      const wrapperHasHeight = !!el.style.height;
      if (wrapperHasWidth) innerRoot.style.width = '100%';
      if (wrapperHasHeight) innerRoot.style.height = '100%';
    }
  }

  // ─── Collection list: repeating templates ─────────────────────────────────
  // After building own children, if this node has a collectionList, render
  // template copies for each collection item. Item 0 = editable template
  // (already built above as a normal child), items 1+ = ghost copies.
  if (node.collectionList) {
    const { source, templateIds } = node.collectionList;
    // Inline maps (from const arrays) use '__inline:varName' as source
    const isInlineMap = source.startsWith('__inline:');
    const rawData = isInlineMap
      ? (node.inlineMapData || [])
      : getCollectionData(source);
    // Resolve the active variant the SAME way as applyNodeCmsBindings: artboard
    // variantName → instance per-viewport variant → baked componentVariant. Then
    // applyChainConfig merges base ← per-viewport ← per-variant config overrides.
    // Per-tile variant wins over base variantName, then componentVariant — shared resolve-core helper.
    // (`__listVariant ?? undefined` below normalizes the null fallback exactly as the old `?? undefined`.)
    const __listVariant = resolveActiveVariant(node, { vpWidth, variant: variantName });
    const data = applyChainConfig(rawData as CollectionItem[], node.collectionList, vpWidth, __listVariant ?? undefined);
    const schema = isInlineMap ? null : getCollectionSchema(source);
    const hasLayouts = !!(schema?.layouts && schema.layouts.length > 1);

    trace.action('renderer:collection-list', {
      nodeId: node.id, source, itemCount: data.length, hasLayouts,
      templateIds: Object.keys(templateIds),
    });

    if (data.length === 0) {
      // The template (item 0) was already built as a normal child above. On a live
      // `.map()` over an empty filtered array NO row renders, so hide it on canvas
      // too — otherwise a stale row (e.g. "Marcus Chen") shows on top of the empty
      // placeholder. Patch cycles restore it via `data-collection-empty-hidden`.
      const tplId0 = templateIds['default'] || Object.values(templateIds)[0];
      const tplEl0 = el.querySelector(`[data-node-id="${idPrefix + tplId0}"]`) as HTMLElement | null;
      if (tplEl0) {
        tplEl0.style.display = 'none';
        tplEl0.setAttribute('data-collection-empty-hidden', 'true');
      }
      // Show empty placeholder
      const placeholder = document.createElement('div');
      placeholder.setAttribute('data-collection-empty', 'true');
      placeholder.style.padding = '16px';
      placeholder.style.textAlign = 'center';
      placeholder.style.color = '#888';
      placeholder.style.fontSize = '13px';
      placeholder.style.fontFamily = 'system-ui, sans-serif';
      placeholder.textContent = isInlineMap
        ? `No items in ${source.replace('__inline:', '')}`
        : `No items in ${schema?.name || source}`;
      el.appendChild(placeholder);
      trace.action('renderer:collection-empty-placeholder', { nodeId: node.id, source });
    } else {
      // For each data item, build a copy of the template.
      // Track last inserted element so ghosts go right after template (not at parent end).
      let lastInsertedEl: Element | null = null;
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        const isTemplate = i === 0;
        // Cast inline map items to CollectionItem for binding resolution
        // (they lack _id/_slug but the binding resolver only reads field keys)
        const bindingItem = item as CollectionItem;

        // Resolve which template to use for this item (supports per-item layouts)
        let templateNode: CanvasNode | undefined;
        if (hasLayouts && item._layout && templateIds[item._layout]) {
          templateNode = nodes.get(templateIds[item._layout]);
        }
        templateNode = templateNode || nodes.get(templateIds['default'] || Object.values(templateIds)[0]);

        if (!templateNode) {
          trace.error('renderer:collection-template-not-found', {
            nodeId: node.id, source, index: i, itemId: isInlineMap ? `inline-${i}` : item._id,
          });
          continue;
        }

        if (isTemplate) {
          // First item: the template is already rendered as a normal child above.
          // Re-render it with binding data so bound fields resolve to item 0's values.
          // Remove the existing template child first, then re-build with binding data.
          const existingTemplateEl = el.querySelector(`[data-node-id="${idPrefix + templateNode.id}"]`);
          // Replace in-place to maintain position among siblings
          const templateEl = buildNodeElement(
            templateNode, nodes, onNodeMouseDown, idPrefix, variantName, bindingItem, '', localeOverrides, vpWidth,
          );
          if (existingTemplateEl) {
            existingTemplateEl.replaceWith(templateEl);
          } else {
            el.appendChild(templateEl);
          }
          lastInsertedEl = templateEl;
          trace.action('renderer:collection-template-rendered', {
            nodeId: templateNode.id, source, itemId: isInlineMap ? `inline-0` : item._id, index: 0,
          });
        } else {
          // Ghost copies — insert right after template/previous ghost
          const ghostSuffix = `__${i}`;
          const ghostEl = buildNodeElement(
            templateNode, nodes, onNodeMouseDown, idPrefix, variantName, bindingItem, ghostSuffix, localeOverrides, vpWidth,
          );
          if (isInlineMap) {
            const ghostIdx = i;
            ghostEl.addEventListener('mousedown', (e) => {
              const ghostEvent = new CustomEvent('revyme:ghost-select', {
                detail: { ghostIndex: ghostIdx, templateId: templateNode.id },
                bubbles: true,
              });
              ghostEl.dispatchEvent(ghostEvent);
              trace.action('renderer:ghost-select', { ghostIndex: ghostIdx, templateId: templateNode.id });
            }, true);
          } else {
            // CMS-backed ghost — locked out via the data-cms-ghost CSS rule
            // (covers descendants too, survives patch cycles, no opacity fade).
            // Setting the attribute is enough; no inline style writes here.
            injectCmsGhostCSS();
            ghostEl.setAttribute('data-cms-ghost', 'true');
          }
          ghostEl.setAttribute('data-collection-ghost', 'true');
          if (lastInsertedEl?.nextSibling) {
            el.insertBefore(ghostEl, lastInsertedEl.nextSibling);
          } else {
            el.appendChild(ghostEl);
          }
          lastInsertedEl = ghostEl;
          trace.action('renderer:collection-ghost-rendered', {
            nodeId: templateNode.id, source, itemId: isInlineMap ? `inline-${i}` : item._id, index: i,
            ghostId: templateNode.id + ghostSuffix,
          });
        }
      }
    }
  }

  // Stamp the subtree signature at BUILD time too (same eligibility rules as
  // patchElement). Without this, the first patch render after a full rebuild
  // re-walked every node just to discover nothing changed (~200ms on a big
  // page for the very first drag-commit/undo after load).
  if (_sigCache && !bindingData && !idSuffix && (!localeOverrides || localeOverrides.size === 0)) {
    const entry = nodeSigEntry(node, nodes);
    if (!entry.dynamic) {
      (el as HTMLElement & { __revymePatchKey?: string }).__revymePatchKey =
        `${entry.sig}|${idPrefix}|${variantName ?? ''}|${vpWidth ?? ''}|${_responsiveCssFp}|${_activeRenderLocale}`;
    }
  }

  // Background video — the BUILD path needs this too, not just `patchElement`.
  // A frame with a video Fill that was rendered from scratch (first paint, page
  // switch, any subtree rebuild) came out with no `<video>` child at all: the
  // sync only ran on patch, and an unchanged node model is patch-SKIPPED, so
  // nothing ever inserted it. The video then never appeared on the canvas no
  // matter how many times the page was switched, while the live site — which
  // renders the `<video>` straight from the JSX — showed it fine. Live find
  // 2026-07-25.
  //
  // AFTER children are built: `syncBgVideoChild` inserts as FIRST child, and
  // several branches above assign `el.innerHTML` (graphic markup, text), which
  // would wipe an earlier insert. Autoplay/loop are forced off in there, so the
  // canvas keeps its frozen-first-frame contract.
  syncBgVideoChild(el, node.bgVideo);

  return el;
}
