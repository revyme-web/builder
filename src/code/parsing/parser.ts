// parser.ts — JSX string → flat node map
// Uses Babel to parse JSX and extract a flat node tree.

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { JSXElement, JSXAttribute, JSXExpressionContainer, ObjectExpression, ObjectProperty, StringLiteral, NumericLiteral, JSXText } from '@babel/types';
import { isTruthy } from '@/code/values/value-eval';
import { trace } from '@/shared/debug-trace';
import { isSvgTag } from '@/shared/constants';
import { cleanJsxText } from '@/shared/jsx-whitespace';
import { parsePageVariables } from '../features/page-variables';

// Handle ESM/CJS interop
const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

// Inline tags that are part of text content, not structural children
const INLINE_TAGS = new Set(['span', 'strong', 'em', 'br', 'a', 'u', 's', 'mark', 'sub', 'sup', 'b', 'i', 'small', 'code', 'p']);

// HTML/JSX attributes the parser captures into `node.attrs` — ONE list shared
// by BOTH element walkers (the main page-tree babel visitor AND the
// `const canvasNodes` fragment walker). These previously drifted: the canvas
// copy was missing 'rel', 'data-keep-params', 'data-revyme-track',
// 'data-slot-pos' and 'data-pinned', so those attrs were silently DROPPED on
// parse for nodes living on the free canvas workspace. Any new captured attr
// goes HERE, never inline in a walker.
// `data-loop` rides with the other effect-carrier attrs (data-scroll-fx,
// data-glide, …) so a declarative Loop's marker survives copy/paste — the
// paste engine re-emits attrs from the parsed node, and anything missing
// here silently vanishes from the pasted copy.
const PARSED_HTML_ATTRS = ['id', 'src', 'alt', 'href', 'target', 'rel', 'type', 'placeholder', 'aria-label', 'role', 'aria-hidden', 'tabindex', 'data-overlay', 'data-overlay-trigger', 'data-smooth-scroll', 'data-keep-params', 'data-sketch', 'data-revyme-track', 'data-slot-pos', 'data-pinned', 'data-replica-solo', 'data-alt-duplicate', 'data-scroll-fx', 'data-glide', 'data-loop', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'preload',
  // Form controls (input/textarea/select/option/button) + the <form> itself.
  // React JSX names (camelCase) so the generated .tsx is React-correct.
  // Also captured on CANVAS nodes: a form/search input dragged or pasted onto
  // the workspace lives in `const canvasNodes` — without these the Input tool
  // loses `data-search-field` + form attrs there.
  'name', 'value', 'required', 'checked', 'disabled', 'readOnly', 'autoComplete', 'autoFocus', 'maxLength', 'minLength', 'pattern', 'min', 'max', 'step', 'rows', 'cols', 'wrap', 'selected', 'multiple', 'inputMode', 'htmlFor', 'method', 'action', 'noValidate', 'data-form', 'data-search-field'];

// Attributes both walkers deliberately SKIP (handled by dedicated systems).
const PARSED_SKIP_ATTRS = new Set(['data-id', 'data-name', 'data-viewport', 'data-canvas-node', 'style', 'className', 'variants', 'animate', 'transition', 'key', 'whileHover', 'whileTap', 'whileInView', 'initial', 'viewport']);

/** True when a JSX child is an INLINE TEXT RUN (part of a rich-text node's
 *  content) rather than a structural child node. A run is an inline tag —
 *  plain `<span>` OR a motion-wrapped `<motion.span>` (component-master files
 *  convert every element to `motion.*`) — carrying NO `data-id` (a `data-id`
 *  marks a real canvas node). Resolving the base tag is what lets a
 *  `<motion.span>` run still register as inline text. */
/** The `<RevymeSplitText>` wrapper holding a text-anim node's real content, or null.
 *
 *  Text effects split at RUNTIME now, so an animated node's children are one wrapper element
 *  rather than N `<motion.span>`s. Every text detector below (CMS binding, text variable,
 *  translation key, per-variant / per-viewport conditional text) must therefore look ONE LEVEL
 *  DEEPER — they all share a single `for (const child of …)` loop, so pointing that loop at
 *  `contentEl` covers all of them at once.
 *
 *  Keyed on the WRAPPER, not on `data-text-anim`, so a half-written node still resolves. */
function findSplitTextWrapper(el: any): any | null {
  for (const c of el.children ?? []) {
    if (c.type !== 'JSXElement') continue;
    const n = c.openingElement?.name;
    const name = n?.type === 'JSXMemberExpression' ? `${n.object?.name}.${n.property?.name}` : n?.name;
    return name === 'RevymeSplitText' ? c : null;   // only the FIRST element child counts
  }
  return null;
}

function isInlineRunChild(c: any): boolean {
  if (!c || c.type !== 'JSXElement') return true; // text / expressions don't break inline-ness
  const opening = c.openingElement;
  const name = opening?.name;
  let baseTag: string;
  if (name?.type === 'JSXIdentifier') {
    baseTag = name.name;
  } else if (name?.type === 'JSXMemberExpression') {
    // motion.span → 'span'
    baseTag = name.property?.name || '';
  } else {
    return false;
  }
  if (!INLINE_TAGS.has(baseTag)) return false;
  const hasDataId = opening.attributes.some((a: any) =>
    a.type === 'JSXAttribute' && a.name?.name === 'data-id'
  );
  return !hasDataId;
}

export interface CanvasNode {
  id: string;
  type: string; // 'div', 'p', 'span', 'img', etc.
  name: string;
  parentId: string | null;
  children: string[];
  styles: Record<string, string>;
  /**
   * Per-CSS-property variable bindings — maps a CSS property to the React
   * prop / variable identifier that drives it (e.g. `boxShadow → 'cardShadow'`).
   * Set by the parser when an Identifier appears as a style value AND a
   * matching function param default is found. `node.styles[prop]` itself
   * carries the *resolved* default value so the canvas can render correctly;
   * `styleVariables[prop]` is the marker the variable system reads to show
   * the purple bound pill.
   *
   * Undefined / missing key = no variable on that property.
   */
  styleVariables?: Record<string, string>;
  /**
   * Carried `::after` (and other pseudo) CSS that must be injected into the
   * canvas `<style>` for THIS node to render correctly. Set by
   * `expandComponent` for component instances: the master's `<style>` block
   * (e.g. an overlay border `[data-id="X"]::after { border: var(--X) }`) is
   * lost when the instance is flattened into the page node tree, and its
   * selector keys off the UNPREFIXED master id. expandComponent rewrites the
   * data-id selectors to the prefixed instance id (`instanceId:masterId`) and
   * stows the CSS here; the Renderer appends every node's `afterCSS` to the
   * injected canvas CSS so the overlay matches the expanded element and paints
   * OVER children — same as the live site renders the master directly.
   * Undefined = nothing to inject for this node.
   */
  afterCSS?: string;
  /**
   * Text content variable binding — set when the element's sole text child is
   * `{propName}` (a JSXExpressionContainer with an Identifier expression).
   * `node.textContent` carries the resolved default string so the canvas
   * paints the default on the master, and `textVariable` is the marker the
   * Content control reads to show the purple bound state. Undefined = no
   * variable on this node's text.
   */
  textVariable?: string;
  /**
   * next-intl translation key — set when the element's text child is a
   * `{t('key')}` call (any hook variable name, one string-literal argument).
   * The canvas locale resolution (buildLocaleOverrideMap) looks this key up
   * in messages/{activeLocale}.json with a default-locale fallback, so a
   * translated node ALWAYS has a deterministic text entry per locale and can
   * never keep another locale's stale paint. Undefined = untranslated node.
   */
  translationKey?: string;
  /** `data-i18n-orphan="key"` — the translation key stashed when this node was
   *  dragged onto module-scope `canvasNodes` and its `{t('key')}` call was
   *  baked to a literal (`t` doesn't exist there). A first-class field rather
   *  than an `attrs` entry: `attrs` is an ALLOWLIST (`PARSED_HTML_ATTRS`) and
   *  stash attributes are deliberately off it — same treatment `data-var-orphan`
   *  gets. The canvas locale resolver reads this so a dormant node still
   *  translates. See i18n-gen's dormantize/rehydrate pair. */
  translationOrphanKey?: string;
  /**
   * next-intl attr translation keys — `placeholder={t('id__attr_placeholder')}`
   * parses to `{ placeholder: 'id__attr_placeholder' }`. Rendered values come
   * from the locale override map's `props` (messages lookup with default
   * fallback); the raw attr stays out of `attrs`.
   */
  attrTranslationKeys?: Record<string, string>;
  attrs: Record<string, string>; // src, alt, href, etc.
  textContent: string;
  hasMixedContent: boolean; // true if textContent contains inline HTML (spans, br, strong, etc.)
  /**
   * True when the textContent was extracted from a JSXExpressionContainer
   * wrapping a StringLiteral — i.e. JSX source of the form `<p>{"raw text"}</p>`.
   * The wrapped value is, by construction, plain runtime text — never JSX
   * fragments — so the renderer skips its `textContent.includes('<')`
   * innerHTML fallback and uses `el.textContent = …` directly. Without
   * this flag, pasted code containing `<svg>` etc. mis-renders as
   * actual HTML elements instead of literal text. See `text-paste.ts`
   * for the producer side.
   */
  textIsLiteral?: boolean;
  /**
   * Per-viewport text overrides — set when the element has the
   * `data-text-overrides` marker and contains `<span data-vp="...">` children.
   * Maps each viewport id to its HTML content (innerHTML of the matching
   * span). The PRIMARY viewport's value also lives in `node.textContent` so
   * existing readers that ignore overrides still get a sensible default.
   * `undefined` = no per-viewport overrides for this element.
   */
  textOverrides?: Record<string, string>;
  /**
   * Opaque imported-graphic markup — set when an `<svg>` carries
   * `data-graphic="true"` (dropped-SVG icon sets, imported vectors). The
   * svg's JSX children (paths, groups, clipPaths, masks, gradients…) are
   * NOT walked into CanvasNodes: def-ish elements (`clipPath`, `defs`,
   * `mask`, `linearGradient`, …) aren't in the Renderer's
   * VALID_TAGS/SVG_SHAPE_TAGS, so node-ifying them rendered `<clipPath>`
   * as a `<div>` — the def never existed and the referencing shapes
   * painted UNCLIPPED (giant stripe spill on dropped icon sets). Instead
   * the subtree is serialized to plain SVG markup here and the Renderer
   * injects it via `innerHTML` (SVG-context parsing case-corrects
   * clipPath/linearGradient/…). Inner shapes are intentionally not
   * selectable/editable — the wrapper svg is a leaf "graphic", like
   * the reference's imported Graphics. Also keeps resize sane: with no shape
   * child nodes, `findSvgShapeChild` returns null and resize stays a
   * plain box resize (no viewBox/geometry bake, which corrupted imported
   * icons whose paths live inside a `<g>`).
   */
  graphicMarkup?: string;
  order: number;
  isCanvasNode: boolean; // true if data-canvas-node="true" — lives on canvas, not inside viewports
  // Component system
  componentFile: string | null;
  componentInstanceId: string | null;
  isComponentRoot: boolean;
  /**
   * True iff THIS node is an instance-tag wrapper for its own component
   * (i.e. it was created from JSX like `<MyCard … />`). The Renderer uses
   * this to apply wrapper-only style allow-listing.
   *
   * Necessary because `componentInstanceId` only marks "I'm inside SOME
   * other component's expansion" — for a NESTED instance like
   * `<Outer><Inner/></Outer>`, the Inner wrapper has both `componentFile`
   * (its own component) AND `componentInstanceId` (the Outer it lives in),
   * so the legacy check `componentFile && !componentInstanceId` would
   * miss it. This flag is set explicitly in `expandComponent` regardless
   * of nesting depth.
   */
  isComponentInstance?: boolean;
  // motion variant system
  motionVariants: Record<string, Record<string, string>> | null; // e.g. { default: { height: '80px' }, open: { height: '400px' } }
  motionVariantsRef: string | null; // variable name if variants={navVariants} references a const
  /** Per-variant style VARIABLES — a variant entry whose value is a component PROP (`'variant-6': { color: color }`),
   *  the idiomatic framer-motion way to make ONE variant's value editable per page. variantName → cssProp → prop name.
   *  motionVariants holds the resolved value (prop default on the master, instance value on a page); the panel reads
   *  THIS to show the variable pill on that variant. */
  motionVariantVariables?: Record<string, Record<string, string>> | null;
  // Responsive variant map: viewport width → initialVariant name (from data-responsive on instances)
  responsiveVariantMap: Record<number, string> | null;
  /** The instance's `_bp` breakpoint list from data-responsive — the width
   *  set its overrides were authored against. Resolution buckets a tile
   *  width against THIS list (live withResponsiveProps parity) instead of
   *  cascading across map keys, which mis-resolved when a replica is WIDER
   *  than the primary. Null when the attr carries no `_bp` (legacy files —
   *  the resolver falls back to map-key interval matching). */
  responsiveVariantBp?: number[] | null;
  /**
   * Per-viewport CMS field REBINDINGS of instance props, parsed from a COMPUTED
   * `data-responsive={JSON.stringify({768:{projectTitle:item.shortTitle}})}` —
   * viewport width → { propName: fieldName }. Literal overrides from the same
   * attr still flow through `attrs['data-responsive']` (reconstructed JSON);
   * this carries ONLY the live `item.field` member-expression values so
   * expandComponent can lower them to per-viewport bindings on the master nodes.
   */
  responsivePropFieldBindings?: Record<number, Record<string, string>>;
  // Per-viewport component-instance PROP overrides, LOWERED to the styles they drive
  // (via styleVariables) so the canvas replica tiles resolve them — viewport width →
  // { cssProp: value }. Mirrors how withResponsiveProps merges per-viewport props live.
  // Set by expandComponent on the expanded internal nodes; read by resolveVariantStyles.
  responsivePropStyles?: Record<number, Record<string, string>> | null;
  /**
   * Per-viewport CMS-binding overrides LOWERED onto an expanded master node by
   * expandComponent (from the instance's `responsivePropFieldBindings` field-refs
   * + literal `data-responsive` overrides on a bound prop). Keyed by binding axis;
   * each viewport width → either `{field}` (rebind that viewport to a DIFFERENT
   * collection field) or `{value}` (unbind→default literal for that viewport). The
   * ghost renderer (resolveBoundField) consults this with the exact vpWidth and
   * falls back to the base binding when a viewport has no override.
   */
  responsiveBindings?: {
    text?: Record<number, { field: string } | { value: string }>;
    style?: Record<number, Record<string, { field: string } | { value: string }>>;
    attr?: Record<number, Record<string, { field: string } | { value: string }>>;
  };
  /**
   * Per-VARIANT CMS-binding overrides on a RAW element inside a `.map()` that lives
   * inside a design component MASTER — parsed from a `variant`/`initialVariant`
   * ternary whose branches are `item.field` member-expressions or literals
   * (`{initialVariant === 'variant-1' ? item.title : item.role}`). Same shape as
   * `responsiveBindings` but keyed by VARIANT NAME; the else/base branch stays the
   * normal `binding`/`styleBindings`. The Renderer resolves these with the active
   * variantName (each component-master artboard) before the base binding.
   */
  variantBindings?: {
    text?: Record<string, { field: string } | { value: string }>;
    style?: Record<string, Record<string, { field: string } | { value: string }>>;
    attr?: Record<string, Record<string, { field: string } | { value: string }>>;
  };
  /**
   * The active variant baked onto an EXPANDED component-instance node by
   * expandComponent (= the instance's resolved `initialVariant`). On a page the
   * Renderer has no variant artboard, so the ghost binding resolution falls back
   * to THIS when `variantName` is null — that's how a page instance set to
   * "Variant 2" resolves its `variantBindings['variant-2']` on the canvas (live
   * resolves it naturally via the real `initialVariant` prop). Null = primary.
   */
  componentVariant?: string | null;
  // Conditional styles: property → { variantName: value } for ternary expressions like order: variant === 'v1' ? 1 : 0
  conditionalStyles: Record<string, Record<string, string>> | null;
  /**
   * Per-variant VARIABLE bindings inside a conditional style — cssProp → { variantName: propName }.
   * Set when a style ternary's branch is the component PROP identifier rather than a literal, e.g.
   * `'--X': initialVariant === 'variant-1' ? X : 'none'` (a variable applied ONLY on `variant-1`).
   * `conditionalStyles` still holds the RESOLVED literal per variant (for the canvas); this parallel
   * map remembers WHICH variant carries the variable so the control shows the purple bound pill on
   * that variant only and Remove/detach targets the right branch. Undefined = no per-variant var.
   */
  conditionalStyleVariables?: Record<string, Record<string, string>> | null;
  /**
   * Per-VIEWPORT VARIABLE bindings on a style prop — cssProp → { vpWidth: propName }.
   * Set when a style value is a `useMediaQuery`-gated ternary of IDENTIFIERS, e.g.
   * `backgroundColor: (__mq0 ? colorTablet : color1)` → { backgroundColor: { 768: 'colorTablet' } }.
   * The viewport analog of `conditionalStyleVariables` (which is per-variant). `node.styles`
   * holds the resolved BASE/Desktop value; `responsiveStyleValues` holds the resolved per-viewport
   * VALUES (for the canvas, which can't evaluate useMediaQuery per replica tile); this map holds the
   * variable NAMES so a replica row shows the purple bound pill + Remove targets the right branch.
   */
  responsiveStyleVariables?: Record<string, Record<number, string>> | null;
  /**
   * Per-VIEWPORT resolved style VALUES (cssProp → { vpWidth: value }) for any per-viewport binding
   * (variable default OR a literal branch). The canvas Renderer merges the active tile's entry on
   * top of base styles so each replica paints its own value (the inline `__mq` ternary evaluates
   * against the editor window, not the tile, so the canvas must resolve it explicitly). Deploy is
   * unaffected — the real `useMediaQuery` resolves per actual viewport. Mirrors `conditionalStyles`.
   */
  responsiveStyleValues?: Record<string, Record<number, string>> | null;
  /**
   * Per-VIEWPORT band FLOOR (cssProp → { vpWidth: minWidth }) for `responsiveStyleValues` — the
   * `min-width` of the gate that override is banded to. A Tablet override (`768`) has minWidth `376`
   * so it applies ONLY to tiles in [376, 768] and does NOT cascade onto Mobile (each replica inherits
   * Desktop until changed individually). 0 = no floor. Consumed by the Renderer + control providers.
   */
  responsiveStyleBands?: Record<string, Record<number, number>> | null;
  // Per-variant text content: { variantName: text, default: text } parsed from a
  // ternary text child like `{variant === 'v1' ? 'A' : 'B'}`. The trailing
  // literal is the `default` branch (primary variant). Mirrors conditionalStyles.
  conditionalText?: Record<string, string> | null;
  /** Per-variant TEXT-VARIABLE bindings: variant name → prop name (`default` = the fallback). Set when a
   *  text ternary branch/fallback is a variable, so the Content control can show the per-variant bound
   *  state. Mirrors `conditionalStyleVariables` for styles. */
  conditionalTextVariable?: Record<string, string> | null;
  /** Per-VIEWPORT TEXT bindings — the text-child twin of `responsiveStyleVariables/Values/Bands`,
   *  parsed from a `{__mqN ? branch : base}` JSX text child. `responsiveTextVariables` maps vpWidth →
   *  the branch VARIABLE name (for the pill; absent when the branch is a literal). `responsiveTextValues`
   *  maps vpWidth → the resolved branch text (variable default OR literal) for per-tile canvas paint.
   *  `responsiveTextBands` maps vpWidth → the gate's min-width floor (banded, no cascade onto smaller). */
  responsiveTextVariables?: Record<number, string> | null;
  responsiveTextValues?: Record<number, string> | null;
  responsiveTextBands?: Record<number, number> | null;
  /** Per-VIEWPORT VARIABLE binding on a component-INSTANCE prop, from an inline `prop={__mqN ? var : base}`
   *  ternary (the instance-prop-attr twin of `responsiveTextVariables/Values/Bands`).
   *  `responsiveAttrPropVariables[prop][vpWidth]` = the bound variable name (for the pill);
   *  `responsiveAttrPropValues[prop][vpWidth]` = its resolved value (folded into `responsiveProps` →
   *  per-tile styles by expandComponent); `responsiveAttrPropBands[prop][vpWidth]` = the band floor. */
  responsiveAttrPropVariables?: Record<string, Record<number, string>> | null;
  responsiveAttrPropValues?: Record<string, Record<number, string>> | null;
  responsiveAttrPropBands?: Record<string, Record<number, number>> | null;
  // Conditional component-instance props: propName → { parentVariantName: value, default: value }
  // Captured from JSX expressions like `initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'}`
  // on a child component instance. Lets the user pick a different prop value per parent variant.
  // Resolved during expandComponent to drive per-parent-variant child styling.
  attrConditional?: Record<string, Record<string, string>>;
  /** Per-parent-variant conditional branches that are VARIABLES (the per-variant hoist): attr → variant →
   *  varName. A page-level instance resolves them against its own prop overrides (expandComponent). */
  attrConditionalVarRefs?: Record<string, Record<string, string>>;
  /**
   * Per-viewport / per-variant RESPONSIVE raw-element attrs (input type/name/…).
   * Captured from conditional-attr ternaries `type={__mq0 ? 'date' : 'text'}` /
   * `type={variant === 'm' ? 'date' : 'text'}`. `attrs[name]` holds the base
   * (fallback); this carries the overrides so the Renderer can resolve the value
   * for the active replica width / variant on the canvas (live React already
   * evaluates the ternary). See responsive-attrs-gen.ts.
   */
  responsiveAttrs?: Record<string, { viewport: Record<number, string>; variant: Record<string, string> }>;
  /**
   * Identifier-ref forwarding map for component-instance attrs:
   *   propName → refName
   *
   * Captured from JSX like `<RoHuVu poon={poon2} />` inside a parent file.
   * `attrs.poon` is resolved to the parent's `propDefaults[poon2]` so the
   * master canvas can render the inheritance visually — but we also keep
   * the original identifier name here so `expandComponent` knows to
   * SUBSTITUTE with the OUTER instance's runtime attr value when this
   * nested instance is expanded inside a page's component instance.
   *
   * In plain English: this is what lets the canvas render the hoisted-
   * variable chain end-to-end. Without it, the nested instance always
   * shows the parent file's default value even when the page passes a
   * different value down.
   */
  attrPropRefs?: Record<string, string>;
  /** Set of variant names on which this element is HIDDEN. Populated by:
   *  1. The conditional-render AnimatePresence pattern:
   *     `<AnimatePresence mode="popLayout">{variant !== 'X' && <... />}</AnimatePresence>`
   *  2. Legacy fallback: `variants['X'].display = 'none'` (auto-migrated).
   *
   *  When non-empty, the generator emits the AnimatePresence + conditional
   *  render pattern instead of writing `display: 'none'` to the variants
   *  object — so siblings can smoothly FLIP into the gap when the element
   *  unmounts (framer-motion's `mode="popLayout"`).
   *
   *  Set is preferred over Array for O(1) membership tests during
   *  per-variant render decisions in the canvas Renderer. */
  hiddenOnVariants?: Set<string>;
  // motion direct animation props (whileHover, whileTap, etc.)
  motionProps: {
    whileHover?: Record<string, string>;
    whileTap?: Record<string, string>;
    whileInView?: Record<string, string>;
    initial?: Record<string, string>;
    animate?: Record<string, string>;
    exit?: Record<string, string>;
    transition?: Record<string, string>;
    viewport?: Record<string, string>;
  } | null;
  // CMS Collection support
  collectionList?: {
    source: string;           // CMS slug ('team') or inline prefix ('__inline:varName')
    itemVar: string;          // .map() parameter name ('item', 'post', etc.)
    templateIds: Record<string, string>;  // layout ID → data-id of template node
    /** Parsed from `slug.filter(item => ...).map(...)` — null when no .filter(). */
    filterGroup?: import('@/shared/types').FilterGroup | null;
    /** Parsed from `slug.sort((a, b) => ...).map(...)` — array of sort rules applied
     *  in order (precedence = index). Legacy single-sort parses to a 1-element array.
     *  null/[] when no .sort(). */
    sort?: import('@/shared/types').SortConfig[] | null;
    /** Parsed from `slug.slice(0, N).map(...)` — null when no .slice(). */
    limit?: number | null;
    /** Start offset — parsed from the .slice() START index (`slug.slice(M, …)`).
     *  null/0 when none. Skip the first M items before limiting/rendering. */
    offset?: number | null;
    /** Pagination (Load More / Infinite Scroll) — Phase 3. */
    pagination?: import('@/shared/types').PaginationConfig | null;
    /** Responsive config (per-viewport / per-variant) — when the list was UPGRADED
     *  to the `__applyListConfig(slug, cfg)` + `useResponsiveListConfig(...)` shape.
     *  `filterGroup`/`sort`/`limit`/`offset` above hold the BASE; these hold the
     *  PARTIAL overrides resolved at render by (vpWidth, variantName). */
    responsive?: Record<string, { filterGroup?: import('@/shared/types').FilterGroup | null; sort?: import('@/shared/types').SortConfig[] | null }> | null;   // breakpoint width → partial
    variantConfigs?: Record<string, { filterGroup?: import('@/shared/types').FilterGroup | null; sort?: import('@/shared/types').SortConfig[] | null }> | null; // variant name → partial
  };
  isCollectionTemplate?: boolean;  // true if inside a .map() callback
  // Inline .map() data (const array defined in same file)
  inlineMapData?: Record<string, string>[];
  // Data binding support (single primary binding — backward compat)
  binding?: {
    field: string;            // collection field ID ('name', 'role', 'photo')
    property: 'text' | 'src' | 'href' | 'alt';
  };
  // Multiple attribute bindings (src + alt can coexist on same element)
  attrBindings?: Array<{
    field: string;
    property: 'src' | 'href' | 'alt';
  }>;
  // Style bindings: style properties bound to map data fields (e.g. backgroundColor: item.bgColor)
  styleBindings?: Array<{
    styleProp: string;        // CSS property in camelCase ('backgroundColor', 'borderRadius')
    field: string;            // data field name ('bgColor', 'radius')
  }>;
  // Prop bindings: component props bound to map data fields (e.g. endValue={item.value})
  propBindings?: Array<{
    prop: string;             // component prop name ('endValue', 'title')
    field: string;            // data field name ('value', 'cardTitle')
    // WHOLE-VALUE image binding — the instance wraps the plain-URL CMS value in
    // url() at the binding site (`coverImage={`url(${item.coverImage})`}`) because
    // the master uses the bare `backgroundImage: coverImage` convention. Consumers
    // that pass the RAW field value into the prop must re-apply the wrap.
    urlWrap?: boolean;
  }>;
  // Orphaned CMS prop bindings: remembered after the instance was dragged OUT
  // of a collection list (`data-cms-orphan="prop:field,…"`). The live binding is
  // stripped so it doesn't crash; this records the intent so the panel shows a
  // "Missing" pill and a re-entry into a collection can re-bind. See cms-detach-gen.
  orphanBindings?: Array<{
    prop: string;             // component prop name ('content', 'ergerg')
    field: string;            // remembered CMS field name ('title', 'untitled')
    urlWrap?: boolean;        // whole-value image binding (`:url` stash marker) — re-entry re-wraps
  }>;
  // Orphaned COMPONENT-VARIABLE bindings: remembered after a node was dragged OUT
  // of the component render onto module-scope `canvasNodes` (`data-var-orphan=
  // "content:bio,style.backgroundImage:image,attr.href:emailHref"`). The live
  // `{prop}` refs were swapped for literal defaults (no crash); this records the
  // intent so the panel keeps showing the SAME purple pill and a re-entry restores
  // the live binding. See component-var-detach-gen.
  orphanVarBindings?: Array<{
    kind: string;             // 'content' | 'style' | 'attr'
    target?: string;          // CSS prop / attribute name (none for 'content')
    prop: string;             // component prop name ('bio', 'image', 'direction')
  }>;
  // Layout system
  fromLayout?: boolean;         // true if node comes from a layout.tsx file (locked on canvas)
  isChildrenSlot?: boolean;     // true if this is a {children} placeholder in layout
  // Code components (live rendered on canvas)
  isCodeComponent?: boolean;              // true if this is a Code component instance (live rendered)
  componentProps?: Record<string, string>;  // props passed to component instance (expression values)
  // Background video (real <video data-bg-video> first-child element). Parser
  // peels it off the children list and surfaces its config here so the Fill
  // tool and canvas treat it as a managed property, not a regular child node.
  bgVideo?: {
    src: string;
    autoPlay: boolean;
    muted: boolean;
    loop: boolean;
    playsInline: boolean;
    controls: boolean;
    /** CSS object-fit value from the bg-video's inline style. Defaults to 'cover'. */
    objectFit: string;
    /** Optional poster image URL — only present when set in source. */
    poster?: string;
  };
}

/**
 * Per-parse shared state, threaded EXPLICITLY through both element walkers (the
 * main babel JSX visitor AND the `const canvasNodes` fragment walker) and the
 * per-element extraction helpers they share. Bundling this state (instead of
 * module-level lets + per-walker closures) is the root fix for the walker-drift
 * bug class: an extraction helper can only read the context it's handed, so the
 * two walk paths can't silently disagree.
 */
interface ParseCtx {
  /** Full source of the file being parsed (loc-based slicing + regex scans). */
  code: string;
  /** The flat node map being built. */
  nodes: Map<string, CanvasNode>;
  /** Auto-id counter for elements without a `data-id` (`auto_<n>`). ONE counter
   *  shared by both walkers, incremented in visit order, so generated ids come
   *  out identical for the same input. */
  idCounter: number;
  /** `__mqN` → media-query string, scanned once per parse from the page's
   *  `const __mqN = useMediaQuery('…')` declarations. Lets extractMotionProps stamp
   *  each responsive `_chain` branch with its resolved query so consumers (e.g. the
   *  detach-to-canvas resolver) can map a viewport WIDTH → the branch that applies. */
  gateQueryMap: Record<string, string>;
  /** `__mqN` → max-width px (derived from gateQueryMap). Lets the responsive
   *  raw-element attr parser map a gate to the breakpoint width it caps. */
  gateWidthMap: Record<string, number>;
  /** Ancestor data-id stack of the MAIN walker (babel enter/exit). The canvas
   *  walker keeps its OWN stack — its manual recursion mechanics differ. */
  parentStack: string[];
  /** Collection template context stack (for nested .map()). When inside a
   *  .map() callback, this tells us the item variable name. */
  collectionContextStack: Array<{ itemVar: string; source: string }>;
  /** CMS detail-page file-scope binding context — see the long design note in
   *  parseJSXToNodes where it's populated. */
  detailPageContext: { itemVar: string; source: string } | null;
  /** Pending `hiddenOnVariants` keyed by inner element's data-id. Populated
   *  when the parser walks into an `<AnimatePresence>` wrapper around a
   *  `{cond && <Child data-id="..."/>}` expression — the parsed condition's
   *  hidden-variant set is stashed here, then re-attached to the inner
   *  element's CanvasNode when its own JSXElement enter() fires. */
  pendingVisibilityByInnerId: Map<string, Set<string>>;
  /** The file's `const variantConfig = [...]`, parsed once up front. */
  currentVariantConfig: { name: string }[];
  /** Page-variable defaults, needed EARLY (before the node loop) — see the
   *  population site in parseJSXToNodes. */
  earlyPageVarDefaults: Record<string, string>;
}

/**
 * Walk the program AST for the default-exported function (or arrow function
 * assigned to a default-exported variable) and pull literal defaults off its
 * destructured first parameter. Used to resolve `var:propName` style values
 * to actual values when rendering a component master file on canvas.
 *
 * Returns `{ propName → defaultValue }`. Static literals only — props without
 * a default, or whose default is a complex expression, are skipped (they
 * can't be safely inlined into a CSS string).
 */
export function extractComponentPropDefaults(ast: any): Record<string, string> {
  const defaults: Record<string, string> = {};

  // Helper to read defaults out of a destructured first param.
  const readParam = (params: any[]) => {
    if (!params || params.length === 0) return;
    const first = params[0];
    // Strip TypeScript annotation wrappers.
    const target = first?.type === 'AssignmentPattern' ? first.left : first;
    if (!target || target.type !== 'ObjectPattern') return;
    for (const p of target.properties) {
      if (p.type !== 'ObjectProperty') continue;
      // `propName = 'default'` parses as ObjectProperty whose value is an
      // AssignmentPattern with `left = Identifier(propName)` and
      // `right = the default expression`.
      if (p.value?.type === 'AssignmentPattern' && p.value.left?.type === 'Identifier') {
        const name = p.value.left.name;
        const def = p.value.right;
        if (def?.type === 'StringLiteral') defaults[name] = def.value;
        else if (def?.type === 'NumericLiteral') defaults[name] = String(def.value);
        // Boolean defaults (`hidden = true`) — needed so `condvar:` visibility bindings
        // (`display: hidden ? 'none' : ''`) resolve to the right branch in the resolve pass.
        else if (def?.type === 'BooleanLiteral') defaults[name] = String(def.value);
        else if (
          def?.type === 'TemplateLiteral'
          && def.expressions.length === 0
          && def.quasis.length === 1
        ) {
          defaults[name] = def.quasis[0].value.cooked ?? def.quasis[0].value.raw;
        }
      }
    }
  };

  for (const stmt of ast.program.body) {
    // export default function Foo({ x = '...' }) {}
    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      if (decl?.type === 'FunctionDeclaration' || decl?.type === 'FunctionExpression' || decl?.type === 'ArrowFunctionExpression') {
        readParam(decl.params);
      }
      // export default withResponsiveProps(Foo) — fall through to look at `function Foo` declared above
      continue;
    }
    // function Foo({ x = '...' }) {} — picked up so `export default Foo` works
    if (stmt.type === 'FunctionDeclaration') {
      readParam(stmt.params);
    }
    // const Foo = ({ x = '...' }) => {} — picked up so `export default Foo` works
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.init?.type === 'ArrowFunctionExpression' || d.init?.type === 'FunctionExpression') {
          readParam(d.init.params);
        }
      }
    }
  }

  return defaults;
}

/**
 * Read a node's `data-var-orphan="content:bio,style.X:prop,attr.Y:prop"` stash
 * (left when a prop-bound node was dragged onto module-scope `canvasNodes` — the
 * live `{prop}` refs were swapped for literal defaults so it wouldn't crash) and
 * surface it as the SAME purple pills an in-scope binding shows: `textVariable`
 * for content, `styleVariables[target]` for style. Keeps the raw list on
 * `orphanVarBindings` for the pill's × + restore. Used by BOTH the main JSX path
 * and the separate canvasNodes path. See component-var-detach-gen.
 */
function applyTranslationOrphanKey(node: CanvasNode, openingAttributes: any[], id: string): void {
  const attr = openingAttributes.find(
    (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-i18n-orphan' && a.value?.type === 'StringLiteral',
  );
  if (!attr) return;
  node.translationOrphanKey = attr.value.value as string;
  trace.action('parser:translation-orphan-key', { nodeId: id, key: node.translationOrphanKey });
}

function applyVarOrphanBindings(node: CanvasNode, openingAttributes: any[], id: string): void {
  const attr = openingAttributes.find(
    (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-var-orphan' && a.value?.type === 'StringLiteral',
  );
  if (!attr) return;
  const entries = (attr.value.value as string)
    .split(',').map((s: string) => s.trim()).filter(Boolean)
    .map((pair: string) => {
      const ci = pair.indexOf(':');
      if (ci === -1) return null;
      const key = pair.slice(0, ci); const prop = pair.slice(ci + 1);
      if (!prop) return null;
      const di = key.indexOf('.');
      if (di === -1) return key === 'content' ? { kind: 'content', prop } : null;
      const target = key.slice(di + 1);
      return target ? { kind: key.slice(0, di), target, prop } : null;
    })
    .filter(Boolean) as Array<{ kind: string; target?: string; prop: string }>;
  if (entries.length === 0) return;
  node.orphanVarBindings = entries;
  for (const o of entries) {
    if (o.kind === 'content') node.textVariable = o.prop;
    else if (o.kind === 'style' && o.target) {
      (node.styleVariables ??= {})[o.target] = o.prop;
    }
  }
  trace.action('parser:var-orphan-bindings', { nodeId: id, count: entries.length });
}

/**
 * Extract CSS text from <style>{`...`}</style> elements in the JSX.
 * Returns the raw CSS string (for injection into the DOM).
 */
// Cache by code STRING IDENTITY. extractStyleCSS regex-scans the whole file
// (400KB+ on big imports) and is called by ~6 code-derived atoms/hooks
// (containerOverrides, pseudo, animation, locale, layout-css, …) — every one
// of them fires on a single drag-commit code change, so without this cache
// the same 470KB gets scanned 6× per drop. Returning the SAME result STRING
// for the same code also lets those atoms memoize by css identity (unchanged
// `<style>` block on a position drag → they skip their own re-parse).
let _extractCssCode: string | null = null;
let _extractCssResult = '';
export function extractStyleCSS(code: string): string {
  if (code === _extractCssCode) return _extractCssResult;
  // Match <style>{`...`}</style> or <style>{'...'}</style>
  const styleRegex = /<style>\s*\{[`'"]([\s\S]*?)[`'"]\}\s*<\/style>/gs;
  let css = '';
  let match;
  while ((match = styleRegex.exec(code)) !== null) {
    css += match[1] + '\n';
  }
  _extractCssCode = code;
  _extractCssResult = css.trim();
  return _extractCssResult;
}

/**
 * Parse the `const variantConfig = [{name, ...}, ...]` array out of a
 * component master file. Returns `[]` if not present (page files, parse
 * errors). Used at parse time to resolve "negative" visibility conditions
 * like `variant !== 'X'` into a hidden-variant set (need to know every
 * variant name to figure out which ones are hidden).
 */
function parseVariantConfigFromCode(code: string): { name: string }[] {
  const m = code.match(/const\s+variantConfig\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return [];
  const body = m[1];
  const out: { name: string }[] = [];
  const nameRegex = /name\s*:\s*['"]([^'"]+)['"]/g;
  let nm;
  while ((nm = nameRegex.exec(body)) !== null) {
    out.push({ name: nm[1] });
  }
  return out;
}

/**
 * Parse a visibility condition expression `<expr>` from a
 * `<AnimatePresence>{<expr> && <Child />}</AnimatePresence>` wrapper into
 * the set of variant names where the child is HIDDEN.
 *
 * Supported shapes:
 *   `variant !== 'X'`                          → hidden on X (set = {X})
 *   `variant !== 'X' && variant !== 'Y'`       → hidden on X, Y
 *   `variant === 'X'`                          → hidden on EVERY OTHER variant
 *   `variant === 'X' || variant === 'Y'`       → hidden on everything except X, Y
 *
 * For positive (`===`) chains we need `allVariants` to compute the
 * complement. Returns `null` for unrecognized shapes.
 */
function parseVisibilityCondition(
  expr: any,
  allVariants: string[] | null,
): Set<string> | null {
  // Literal `false` → hidden on ALL variants (generator's "visible nowhere"
  // form, emitted when hiddenVariants = allVariants — e.g. drag-out of a
  // variant where the element should disappear from JSX entirely).
  // Literal `true` → hidden NOWHERE (generator's degenerate "always visible"
  // form, treated as no wrapper).
  if (expr?.type === 'BooleanLiteral') {
    if (expr.value === false) {
      return allVariants ? new Set(allVariants) : new Set();
    }
    return new Set();
  }
  // Single comparison: variant !== 'X' or variant === 'X'
  if (expr?.type === 'BinaryExpression'
      && (expr.operator === '!==' || expr.operator === '===')
      && expr.left?.type === 'Identifier'
      && (expr.left.name === 'variant' || expr.left.name === 'initialVariant')
      && expr.right?.type === 'StringLiteral') {
    const variantName = expr.right.value;
    if (expr.operator === '!==') return new Set([variantName]);
    // === : hidden = all variants except `variantName`
    if (!allVariants) return null;
    return new Set(allVariants.filter(v => v !== variantName));
  }
  // Logical chain: a !== X && b !== Y && ... → union of hidden sets
  // or: a === X || b === Y || ... → complement
  if (expr?.type === 'LogicalExpression') {
    if (expr.operator === '&&') {
      // Negative chain — every node should be a `!==` (or another &&).
      const left = parseVisibilityCondition(expr.left, allVariants);
      const right = parseVisibilityCondition(expr.right, allVariants);
      if (!left || !right) return null;
      return new Set([...left, ...right]);
    }
    if (expr.operator === '||') {
      // Positive chain — gather the union of "visible" names, return
      // the complement.
      if (!allVariants) return null;
      const visible = new Set<string>();
      const walk = (e: any): boolean => {
        if (e?.type === 'BinaryExpression' && e.operator === '==='
            && e.left?.type === 'Identifier'
            && (e.left.name === 'variant' || e.left.name === 'initialVariant')
            && e.right?.type === 'StringLiteral') {
          visible.add(e.right.value);
          return true;
        }
        if (e?.type === 'LogicalExpression' && e.operator === '||') {
          return walk(e.left) && walk(e.right);
        }
        return false;
      };
      if (!walk(expr)) return null;
      return new Set(allVariants.filter(v => !visible.has(v)));
    }
  }
  return null;
}

/**
 * Tags whose `href`/`target`/`data-smooth-scroll` carry navigation semantics:
 * raw anchors (`a`), Next.js `Link`, and the `motion.create(Link)` wrapper
 * `MotionLink` emitted on component masters. (`motion.a` parses to tagName
 * `a`, so it's covered by the `a` case.)
 */
function isLinkLikeTag(tagName: string): boolean {
  return tagName === 'a' || tagName === 'Link' || tagName === 'MotionLink';
}

/**
 * For a RESPONSIVE raw-element attr (`type={__mq0 ? 'date' : 'text'}` or
 * `type={variant === 'm' ? 'date' : 'text'}`, possibly chained), return the
 * BASE value — the ternary's final string fallback — so the canvas + Input tool
 * show the primary value. Returns null when `expr` isn't such a responsive-attr
 * ternary (every test must be an `__mq*` gate or a `variant === '…'` compare and
 * every consequent a string literal). See responsive-attrs-gen.ts.
 */
function responsiveAttrFallback(expr: any): string | null {
  return parseResponsiveAttrExpr(expr)?.base ?? null;
}

/**
 * Parse a responsive raw-element attr ternary into its base + per-viewport
 * (max-width → value) + per-variant (name → value) overrides. `gateMap` maps
 * `__mqN` → max-width px (from `gateQueryMap`). Returns null when `expr` isn't a
 * responsive-attr ternary. Used for both the base fallback (above) and the
 * Renderer's per-replica/variant resolution on the canvas.
 */
function parseResponsiveAttrExpr(
  expr: any,
  gateMap?: Record<string, number>,
): { base: string; viewport: Record<number, string>; variant: Record<string, string> } | null {
  const viewport: Record<number, string> = {};
  const variant: Record<string, string> = {};
  let cursor = expr;
  let isResponsive = false;
  while (cursor && cursor.type === 'ConditionalExpression') {
    const t = cursor.test;
    const isMq = t?.type === 'Identifier' && /^__mq/.test(t.name);
    const isVariant = t?.type === 'BinaryExpression' && t.operator === '===' &&
      t.left?.type === 'Identifier' && (t.left.name === 'initialVariant' || t.left.name === 'variant') &&
      t.right?.type === 'StringLiteral';
    if ((!isMq && !isVariant) || cursor.consequent?.type !== 'StringLiteral') return null;
    const val = cursor.consequent.value as string;
    if (isMq && gateMap && gateMap[t.name] != null) viewport[gateMap[t.name]] = val;
    else if (isVariant) variant[t.right.value] = val;
    isResponsive = true;
    cursor = cursor.alternate;
  }
  if (!isResponsive) return null;
  return { base: cursor?.type === 'StringLiteral' ? cursor.value : '', viewport, variant };
}

/**
 * Parse a per-VIEWPORT TEXT-child ternary (`{__mqN ? branch : base}`, possibly chained) into its
 * base + per-viewport branches. A branch (and the base) may be a VARIABLE identifier OR a string
 * literal. `gateMap` maps `__mqN` → max-width; `queryMap` maps `__mqN` → full query (for the band
 * floor). Returns null when `expr` isn't a `__mq`-gated text ternary. The text twin of
 * `parseResponsiveAttrExpr`, but consequents can be identifiers (variable text), not just literals.
 */
// Active locale for PARSE-TIME locale-scope resolution: locale-scoped prop
// segments (`__activeLocale === 'fr' ? … :`) resolve against this and fold
// into the SAME responsive rails (matching plain-locale segment → overrides
// the base; matching banded segment → a width entry; other locales are
// skipped). Locale switches trigger a reparse (useLocaleOverrides) so the
// canvas re-resolves. Default '' = only base values (default locale).
let _parseActiveLocale = '';
export function setParseActiveLocale(locale: string): void {
  _parseActiveLocale = locale || '';
}

function parseResponsiveTextExpr(
  expr: any,
  gateMap: Record<string, number>,
  queryMap: Record<string, string>,
): {
  base: { kind: 'var'; name: string } | { kind: 'literal'; value: string } | null;
  vars: Record<number, string>;
  values: Record<number, string>;
  bands: Record<number, number>;
} | null {
  const vars: Record<number, string> = {};
  const values: Record<number, string> = {};
  const bands: Record<number, number> = {};
  let cursor = expr;
  let isResponsive = false;
  let localeBase: { kind: 'var'; name: string } | { kind: 'literal'; value: string } | null = null;
  const localeTest = (t: any): string | null =>
    t?.type === 'BinaryExpression' && t.operator === '==='
      && t.left?.type === 'Identifier' && t.left.name === '__activeLocale'
      && t.right?.type === 'StringLiteral' ? t.right.value : null;
  while (cursor && cursor.type === 'ConditionalExpression') {
    const t = cursor.test;
    const c = cursor.consequent;
    // Locale-scoped segments (see scoped-expr's locale SerScope).
    const plainLocale = localeTest(t);
    const bandedLocale = t?.type === 'LogicalExpression' && t.operator === '&&' ? localeTest(t.left) : null;
    const bandedGate = bandedLocale !== null && t.right?.type === 'Identifier' && /^__mq/.test(t.right.name) ? t.right.name : null;
    if (plainLocale !== null || bandedLocale !== null) {
      const matches = (plainLocale ?? bandedLocale) === _parseActiveLocale;
      if (matches) {
        if (plainLocale !== null) {
          if (c?.type === 'Identifier') localeBase = { kind: 'var', name: c.name };
          else if (c?.type === 'StringLiteral') localeBase = localeBase ?? { kind: 'literal', value: c.value };
        } else if (bandedGate && gateMap[bandedGate] != null) {
          const w = gateMap[bandedGate];
          if (c?.type === 'Identifier') vars[w] = c.name;
          else if (c?.type === 'StringLiteral') values[w] = c.value;
          const mw = /min-width:\s*([\d.]+)px/.exec(queryMap[bandedGate] ?? '');
          bands[w] = mw ? parseInt(mw[1], 10) : 0;
        }
      }
      isResponsive = true;
      cursor = cursor.alternate;
      continue;
    }
    if (!(t?.type === 'Identifier' && /^__mq/.test(t.name)) || gateMap[t.name] == null) return null;
    const w = gateMap[t.name];
    if (c?.type === 'Identifier') vars[w] = c.name;
    else if (c?.type === 'StringLiteral') values[w] = c.value;
    else return null;
    const mw = /min-width:\s*([\d.]+)px/.exec(queryMap[t.name] ?? '');
    bands[w] = mw ? parseInt(mw[1], 10) : 0;
    isResponsive = true;
    cursor = cursor.alternate;
  }
  if (!isResponsive) return null;
  let base: { kind: 'var'; name: string } | { kind: 'literal'; value: string } | null = null;
  if (cursor?.type === 'Identifier') base = { kind: 'var', name: cursor.name };
  else if (cursor?.type === 'StringLiteral') base = { kind: 'literal', value: cursor.value };
  // A matching plain-locale segment overrides the base everywhere (banded
  // matches already landed as width entries above).
  if (localeBase) base = localeBase;
  return { base, vars, values, bands };
}

// ─── Shared per-element extraction (used by BOTH walkers) ───────────────────
// The main babel JSX visitor and the `const canvasNodes` fragment walker call
// these SAME functions, so their extraction semantics cannot drift apart (the
// root fix behind the Phase-0.3 attr-list unification). Walker-specific
// behavior stays at the walker level: recursion/skip mechanics, isCanvasNode
// semantics, text/CMS-binding extraction (impossible at module scope for
// canvasNodes), mixed-content source slicing, motionVariantsRef resolution and
// collectionList preservation — see the two call sites.

/** Element tag name — handles motion.div → 'div', motion.span → 'span', etc. */
function resolveTagName(opening: any): string {
  if (opening.name.type === 'JSXIdentifier') {
    return opening.name.name;
  }
  if (opening.name.type === 'JSXMemberExpression') {
    // motion.div → 'div', motion.span → 'span'
    return (opening.name as any).property?.name || 'div';
  }
  return 'div';
}

/** data-id, or a shared-counter auto id (`auto_<n>`) when the JSX has none. */
function resolveElementId(attributes: any[], ctx: ParseCtx): string {
  let id = getAttr(attributes, 'data-id');
  if (!id) {
    id = `auto_${ctx.idCounter++}`;
  }
  return id;
}

/**
 * Element display name from data-name. Sketch wrappers (SVGs marked with
 * `data-sketch="true"` by SketchCreator) ALWAYS surface as "Sketch" regardless
 * of any data-name on the JSX — the floating canvas label, layers panel, and
 * right-panel selection all rely on this so a sketch never reads as a generic
 * "Vector" anywhere in the editor UI.
 */
function resolveElementName(tagName: string, attributes: any[]): string {
  const isSketchWrapper = tagName === 'svg'
    && getAttr(attributes, 'data-sketch') === 'true';
  return isSketchWrapper
    ? 'Sketch'
    : (getAttr(attributes, 'data-name') || tagName);
}

/**
 * Inline style object + conditional styles (ternary expressions like
 * `order: variant === 'v1' ? 1 : 0`). Also strips the legacy `backgroundVideo`
 * key — it was a fake CSS prop that never rendered. Real video fills now live
 * on a `<video data-bg-video>` child. Any value still in source is dead.
 */
function extractElementStyles(attributes: any[], ctx: ParseCtx): { styles: Record<string, string>; conditionalStyles: Record<string, Record<string, string>> | null } {
  const { styles, conditionalStyles } = extractStyles(attributes, ctx);
  if ('backgroundVideo' in styles) {
    delete styles.backgroundVideo;
    trace.action('parser:legacy-backgroundVideo-stripped');
  }
  return { styles, conditionalStyles };
}

/**
 * SVG attributes (cx, cy, d, points, fill, stroke, viewBox, etc.) into `attrs`.
 * Shared by BOTH walkers — without this on the canvasNodes path, shapes drawn
 * on the canvas lose their fill/width/height/stroke attrs and render invisible.
 * Call only for SVG tags; attrs already captured by the HTML extraction win.
 */
function extractSvgAttrsInto(
  attributes: any[],
  attrs: Record<string, string>,
  /** Optional: the walker's gate map + responsiveAttrs accumulator. When
   *  provided, a RESPONSIVE svg attr ternary (`viewBox={__mq0 ? "…" : "…"}` —
   *  written by the per-viewport FIT re-fit via setResponsiveAttrInCode) parses
   *  into base (→ attrs) + overrides (→ accum) instead of being silently
   *  DROPPED (the old literal-only branch lost the whole attr). */
  ctx?: ParseCtx,
  responsiveAttrsAccum?: Record<string, { viewport: Record<number, string>; variant: Record<string, string> }>,
): void {
  const skipAttrs = PARSED_SKIP_ATTRS;
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute' || !attr.name || attr.name.type !== 'JSXIdentifier') continue;
    const attrName = attr.name.name as string;
    if (skipAttrs.has(attrName) || attrName === 'data-id' || attrName === 'data-name') continue;
    // Already captured by HTML attr extraction above
    if (attrs[attrName]) continue;
    if (!attr.value) continue;
    if (attr.value.type === 'StringLiteral') {
      attrs[attrName] = attr.value.value;
    } else if (attr.value.type === 'JSXExpressionContainer') {
      const expr = attr.value.expression;
      if (expr.type === 'StringLiteral') {
        attrs[attrName] = expr.value;
      } else if (expr.type === 'NumericLiteral') {
        attrs[attrName] = String(expr.value);
      } else if (expr.type === 'ConditionalExpression' && responsiveAttrsAccum) {
        const parsed = parseResponsiveAttrExpr(expr, ctx?.gateWidthMap);
        if (parsed) {
          attrs[attrName] = parsed.base;
          if (Object.keys(parsed.viewport).length > 0 || Object.keys(parsed.variant).length > 0) {
            responsiveAttrsAccum[attrName] = { viewport: parsed.viewport, variant: parsed.variant };
            trace.action('parser:svg-responsive-attr', { attrName, viewports: Object.keys(parsed.viewport), variants: Object.keys(parsed.variant) });
          }
        }
      }
    }
  }
}

// ─── Opaque graphic serialization (data-graphic svg wrappers) ────────────────

/** JSX attribute names React RENAMES for SVG (camel → hyphen/colon), mapped
 *  back to the real SVG attribute for raw-markup injection. Natively-camel
 *  SVG attrs (viewBox, gradientTransform, clipPathUnits, patternUnits,
 *  preserveAspectRatio, stdDeviation, …) are NOT here — they pass through
 *  unchanged (and innerHTML's SVG-context parser case-corrects them anyway). */
const JSX_TO_SVG_ATTR: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
  xlinkHref: 'xlink:href',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  strokeDashoffset: 'stroke-dashoffset',
  strokeMiterlimit: 'stroke-miterlimit',
  strokeOpacity: 'stroke-opacity',
  fillRule: 'fill-rule',
  fillOpacity: 'fill-opacity',
  clipRule: 'clip-rule',
  clipPath: 'clip-path',
  stopColor: 'stop-color',
  stopOpacity: 'stop-opacity',
  vectorEffect: 'vector-effect',
  shapeRendering: 'shape-rendering',
  colorInterpolationFilters: 'color-interpolation-filters',
  floodColor: 'flood-color',
  floodOpacity: 'flood-opacity',
  fontFamily: 'font-family',
  fontSize: 'font-size',
  fontWeight: 'font-weight',
  fontStyle: 'font-style',
  letterSpacing: 'letter-spacing',
  textAnchor: 'text-anchor',
  dominantBaseline: 'dominant-baseline',
  paintOrder: 'paint-order',
  markerStart: 'marker-start',
  markerMid: 'marker-mid',
  markerEnd: 'marker-end',
  imageRendering: 'image-rendering',
  pointerEvents: 'pointer-events',
  transformOrigin: 'transform-origin',
};

function escapeSvgAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeSvgText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A JSX `style={{ … }}` ObjectExpression → CSS declaration text. Only
 *  literal keys/values are carried (imported graphics never have computed
 *  style expressions — the drop sanitizer builds them from `style="…"`). */
function styleObjectExprToCss(expr: any): string {
  if (!expr || expr.type !== 'ObjectExpression') return '';
  const decls: string[] = [];
  for (const prop of expr.properties ?? []) {
    if (prop.type !== 'ObjectProperty') continue;
    const key = prop.key?.type === 'Identifier' ? prop.key.name
      : prop.key?.type === 'StringLiteral' ? prop.key.value : null;
    if (!key) continue;
    const v = prop.value;
    const value = v?.type === 'StringLiteral' ? v.value
      : v?.type === 'NumericLiteral' ? String(v.value) : null;
    if (value === null) continue;
    const kebab = key.startsWith('--') ? key : key.replace(/([A-Z])/g, '-$1').toLowerCase();
    decls.push(`${kebab}: ${value}`);
  }
  return decls.join('; ');
}

/**
 * Serialize a `data-graphic` svg's JSX children (Babel AST) back to plain SVG
 * markup for `innerHTML` injection. Handles the subset imported graphics
 * contain: elements with string/number attrs (kebab OR React-camel names),
 * `style={{…}}` objects (→ `style="css"`), and text. Expression attrs that
 * aren't literals are dropped — an imported graphic has no live bindings.
 */
export function serializeJsxChildrenToSvgMarkup(children: any[]): string {
  let out = '';
  for (const child of children ?? []) {
    if (child.type === 'JSXText') {
      // Whitespace-only runs are formatting noise; real text (rare —
      // `<text>` labels) is escaped and kept.
      if (child.value.trim()) out += escapeSvgText(child.value);
      continue;
    }
    if (child.type === 'JSXExpressionContainer' && child.expression?.type === 'StringLiteral') {
      out += escapeSvgText(child.expression.value);
      continue;
    }
    if (child.type !== 'JSXElement') continue;
    const opening = child.openingElement;
    if (!opening || opening.name?.type !== 'JSXIdentifier') continue; // skip <Component/> members
    const tag = opening.name.name as string;
    let attrsText = '';
    for (const attr of opening.attributes ?? []) {
      if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier') continue;
      const rawName = attr.name.name as string;
      const name = JSX_TO_SVG_ATTR[rawName] ?? rawName;
      if (!attr.value) { attrsText += ` ${name}=""`; continue; }
      if (attr.value.type === 'StringLiteral') {
        attrsText += ` ${name}="${escapeSvgAttrValue(attr.value.value)}"`;
      } else if (attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression;
        if (rawName === 'style' && expr?.type === 'ObjectExpression') {
          const css = styleObjectExprToCss(expr);
          if (css) attrsText += ` style="${escapeSvgAttrValue(css)}"`;
        } else if (expr?.type === 'StringLiteral') {
          attrsText += ` ${name}="${escapeSvgAttrValue(expr.value)}"`;
        } else if (expr?.type === 'NumericLiteral') {
          attrsText += ` ${name}="${expr.value}"`;
        }
        // other expressions: dropped (no live bindings inside a graphic)
      }
    }
    const inner = serializeJsxChildrenToSvgMarkup(child.children ?? []);
    out += inner ? `<${tag}${attrsText}>${inner}</${tag}>` : `<${tag}${attrsText}/>`;
  }
  return out;
}

/** True when this element is an opaque imported graphic — an `<svg>` whose
 *  children stay OUT of the node tree (see CanvasNode.graphicMarkup). */
function isGraphicSvg(tagName: string, attrs: Record<string, string>): boolean {
  return tagName === 'svg' && attrs['data-graphic'] === 'true';
}

/**
 * True when the element's children are ONLY inline text runs (rich/mixed text):
 * at least one JSXElement child, and every child is an inline tag — plain
 * `<span>` or motion-wrapped `<motion.span>` — with no data-id. The DETECTION
 * is shared; what each walker does with a positive result differs (the main
 * walker additionally slices the raw inner JSX source into textContent).
 */
function isAllInlineMixedContent(el: any): boolean {
  if (el.children.length === 0) return false;
  const hasElements = el.children.some((c: any) => c.type === 'JSXElement');
  if (!hasElements) return false;
  // Check if ALL element children are inline/text tags — plain
  // <span> or motion-wrapped <motion.span>, with no data-id.
  return el.children.every(isInlineRunChild);
}

/**
 * Orphaned CMS prop bindings from the `data-cms-orphan="prop:field,…"` stash
 * (left by a detach — instance dragged out of a collection list). Format
 * mirrors cms-detach-gen's serializeOrphanBindings. Returns null when the
 * attr is absent or empty.
 */
function parseCmsOrphanBindings(attributes: any[]): Array<{ prop: string; field: string; urlWrap?: boolean }> | null {
  const orphanAttr = attributes.find(
    (a: any) => a.type === 'JSXAttribute' && a.name?.name === 'data-cms-orphan'
      && a.value?.type === 'StringLiteral',
  ) as any;
  if (!orphanAttr) return null;
  // A `:url` third segment marks a WHOLE-VALUE image binding (see cms-detach-gen).
  const orphanBindings = (orphanAttr.value.value as string)
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((pair) => {
      const parts = pair.split(':');
      if (parts.length < 2) return null;
      const entry: { prop: string; field: string; urlWrap?: boolean } = { prop: parts[0], field: parts[1] };
      if (parts[2] === 'url') entry.urlWrap = true;
      return entry;
    })
    .filter(Boolean) as Array<{ prop: string; field: string; urlWrap?: boolean }>;
  return orphanBindings.length > 0 ? orphanBindings : null;
}

/** Register `id` under `parentId`'s children and return this element's order index. */
function attachToParent(ctx: ParseCtx, parentId: string | null, id: string): number {
  if (parentId && ctx.nodes.has(parentId)) {
    const parent = ctx.nodes.get(parentId)!;
    parent.children.push(id);
  }
  return parentId && ctx.nodes.has(parentId) ? ctx.nodes.get(parentId)!.children.length - 1 : 0;
}

/** The common CanvasNode skeleton both walkers build. Walker-specific values
 *  (`isCanvasNode` semantics, `motionVariantsRef`) come in as parameters. */
function createBaseNode(p: {
  id: string;
  tagName: string;
  name: string;
  parentId: string | null;
  styles: Record<string, string>;
  conditionalStyles: Record<string, Record<string, string>> | null;
  attrs: Record<string, string>;
  textContent: string;
  hasMixedContent: boolean;
  textIsLiteral: boolean;
  order: number;
  isCanvasNode: boolean;
  motionVariantsRef: string | null;
  motionProps: CanvasNode['motionProps'];
}): CanvasNode {
  return {
    id: p.id,
    type: p.tagName,
    name: p.name,
    parentId: p.parentId,
    children: [],
    styles: p.styles,
    attrs: p.attrs,
    textContent: p.textContent,
    hasMixedContent: p.hasMixedContent,
    textIsLiteral: p.textIsLiteral || undefined,
    order: p.order,
    isCanvasNode: p.isCanvasNode,
    componentFile: null,
    componentInstanceId: null,
    isComponentRoot: false,
    motionVariants: null, // Resolved later from variantsRef
    motionVariantsRef: p.motionVariantsRef,
    responsiveVariantMap: null,
    conditionalStyles: p.conditionalStyles,
    motionProps: p.motionProps,
  };
}

/**
 * Attach the attr-extraction extras (component props, responsive / conditional
 * prop maps) onto the node — shared by BOTH walkers so the two paths surface
 * identical fields for identical JSX.
 */
function assignAttrExtras(node: CanvasNode, x: {
  componentProps: Record<string, string>;
  responsiveAttrsAccum: Record<string, { viewport: Record<number, string>; variant: Record<string, string> }>;
  attrConditional: Record<string, Record<string, string>>;
  attrConditionalVarRefs: Record<string, Record<string, string>>;
  attrPropRefs: Record<string, string>;
  responsiveAttrPropVars: Record<string, Record<number, string>>;
  responsiveAttrPropVals: Record<string, Record<number, string>>;
  responsiveAttrPropBandsAcc: Record<string, Record<number, number>>;
  responsivePropFieldBindings: Record<number, Record<string, string>> | undefined;
}): void {
  const id = node.id;
  if (Object.keys(x.componentProps).length > 0) node.componentProps = x.componentProps;
  if (Object.keys(x.responsiveAttrsAccum).length > 0) {
    node.responsiveAttrs = x.responsiveAttrsAccum;
    trace.action('parser:responsive-attrs', { nodeId: id, attrs: Object.keys(x.responsiveAttrsAccum) });
  }
  if (Object.keys(x.attrConditional).length > 0) {
    node.attrConditional = x.attrConditional;
    if (Object.keys(x.attrConditionalVarRefs).length > 0) node.attrConditionalVarRefs = x.attrConditionalVarRefs;
    trace.action('parser:attr-conditional', { nodeId: id, map: x.attrConditional });
  }
  if (Object.keys(x.attrPropRefs).length > 0) {
    node.attrPropRefs = x.attrPropRefs;
    trace.action('parser:attr-prop-refs', { nodeId: id, refs: x.attrPropRefs });
  }
  if (Object.keys(x.responsiveAttrPropVars).length > 0) node.responsiveAttrPropVariables = x.responsiveAttrPropVars;
  if (Object.keys(x.responsiveAttrPropVals).length > 0) node.responsiveAttrPropValues = x.responsiveAttrPropVals;
  if (Object.keys(x.responsiveAttrPropBandsAcc).length > 0) {
    node.responsiveAttrPropBands = x.responsiveAttrPropBandsAcc;
    trace.action('parser:responsive-attr-prop-vars', { nodeId: id, props: Object.keys(x.responsiveAttrPropVars) });
  }
  if (x.responsivePropFieldBindings) {
    node.responsivePropFieldBindings = x.responsivePropFieldBindings;
    trace.action('parser:responsive-prop-field-bindings', { nodeId: id, map: x.responsivePropFieldBindings });
  }
}

/**
 * HTML/JSX attributes (src, alt, href, `data-*`, …) + component-instance string
 * props — ONE extraction shared by BOTH element walkers (main babel visitor and
 * the `const canvasNodes` fragment walker). Besides `attrs` it returns:
 *   - `responsiveAttrsAccum`: per-viewport / per-variant responsive raw-element
 *     attr overrides, keyed by attr name (base value lives in `attrs`);
 *   - `responsivePropFieldBindings`: per-viewport CMS field-refs parsed from a
 *     COMPUTED `data-responsive={JSON.stringify({…})}`.
 */
function extractElementAttrs(opening: any, tagName: string, ctx: ParseCtx): {
  attrs: Record<string, string>;
  responsiveAttrsAccum: Record<string, { viewport: Record<number, string>; variant: Record<string, string> }>;
  responsivePropFieldBindings: Record<number, Record<string, string>> | undefined;
  attrTranslationKeys: Record<string, string> | undefined;
} {
  // Extract HTML attributes (src, alt, href, etc.)
  // For component instances (uppercase tags), also capture all non-standard attrs as props
  const attrs: Record<string, string> = {};
  // Per-viewport / per-variant responsive raw-element attr overrides, keyed
  // by attr name (base lives in `attrs`). Attached to node.responsiveAttrs.
  const responsiveAttrsAccum: Record<string, { viewport: Record<number, string>; variant: Record<string, string> }> = {};
  // Per-viewport CMS field-refs from a COMPUTED data-responsive (set in the attr loop below).
  let responsivePropFieldBindings: Record<number, Record<string, string>> | undefined;
  // next-intl attr translation calls — `placeholder={t('id__attr_placeholder')}`
  // → { placeholder: 'id__attr_placeholder' }. The rendered value comes from
  // the locale override map (messages), so `attrs` itself stays unset.
  let attrTranslationKeys: Record<string, string> | undefined;
  const htmlAttrs = PARSED_HTML_ATTRS;
  const skipAttrs = PARSED_SKIP_ATTRS;
  const isUppercaseTag = tagName.length > 0 && tagName[0] === tagName[0].toUpperCase() && tagName[0] !== tagName[0].toLowerCase();

  for (const attr of (opening.attributes as any[])) {
    if (attr.type !== 'JSXAttribute' || !attr.name || attr.name.type !== 'JSXIdentifier') continue;
    const attrName = attr.name.name as string;

    // `ref={X}` — capture the identifier name so it survives copy/
    // paste. Without this the parser dropped refs entirely (they
    // aren't in htmlAttrs and getAttr only handles string-literal
    // values), so pasting a node bound to a useScroll/useRef hook
    // produced "Target ref is defined but not hydrated" — the ref
    // declaration came along via the effects bundle but nothing on
    // the destination JSX attached it to an element.
    //
    // Stored with the `var:` sentinel (same convention as
    // identifier-valued style props) so generators that already
    // understand `var:` emit the identifier (not a string). The
    // paste-engine's id-rename pass rewrites the prefix portion
    // alongside the other var-style references.
    if (attrName === 'ref'
        && attr.value?.type === 'JSXExpressionContainer'
        && attr.value.expression.type === 'Identifier') {
      attrs.ref = `var:${attr.value.expression.name}`;
      continue;
    }

    // Navigation attrs on a link-like tag (`a` / `Link` / the
    // `motion.create(Link)` wrapper `MotionLink`) — capture string OR
    // expression form. An expression means the attr is a component
    // VARIABLE; store it `var:<name>` so the Link tool shows the purple
    // bound pill. This must run BEFORE the uppercase-instance branch:
    // `MotionLink`/`Link` are uppercase, so otherwise `href={var}` would
    // fall into the component-prop path (attrPropRefs) and never surface
    // as a nav variable.
    if ((attrName === 'href' || attrName === 'target' || attrName === 'rel'
          || attrName === 'data-smooth-scroll' || attrName === 'data-keep-params')
        && isLinkLikeTag(tagName)) {
      const navVal = getAttr(opening.attributes, attrName);
      if (navVal) {
        attrs[attrName] = navVal;
      } else if (attr.value?.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression as any;
        if (expr?.type === 'Identifier') attrs[attrName] = `var:${expr.name}`;
        else if (expr?.type === 'ConditionalExpression' && expr.test?.type === 'Identifier') attrs[attrName] = `var:${expr.test.name}`;
      }
      continue;
    }

    // `data-revyme-track` (A/B tracking id) — capturable on ANY element
    // (not just links), as a string OR an expression (a component
    // VARIABLE → `var:<name>` for the bound pill). Not gated on tag.
    if (attrName === 'data-revyme-track') {
      const tv = getAttr(opening.attributes, attrName);
      if (tv) {
        attrs[attrName] = tv;
      } else if (attr.value?.type === 'JSXExpressionContainer'
          && (attr.value.expression as any)?.type === 'Identifier') {
        attrs[attrName] = `var:${(attr.value.expression as any).name}`;
      }
      continue;
    }

    // `data-responsive` COMPUTED form (`={JSON.stringify({…})}`) — carries
    // live CMS field-refs that getAttr can't read. Split into the literal
    // overrides (→ attrs['data-responsive'] JSON, so existing
    // responsiveProps/variant parsing still works) + the field-refs
    // (→ responsivePropFieldBindings, lowered in expandComponent). The
    // STRING form falls through to getAttr below.
    if (attrName === 'data-responsive'
        && attr.value?.type === 'JSXExpressionContainer'
        && (attr.value.expression as any)?.type !== 'StringLiteral') {
      const parsed = parseComputedResponsiveAttr(attr.value.expression);
      if (parsed) {
        if (parsed.literalJson) attrs['data-responsive'] = parsed.literalJson;
        if (parsed.fieldBindings) responsivePropFieldBindings = parsed.fieldBindings;
      }
      continue;
    }

    if (isUppercaseTag && !skipAttrs.has(attrName)) {
      // Component prop — capture it
      const val = getAttr(opening.attributes, attrName);
      if (val) attrs[attrName] = val;
    } else if (htmlAttrs.includes(attrName)) {
      const val = getAttr(opening.attributes, attrName);
      if (val) {
        attrs[attrName] = val;
      } else if (attr.value?.type === 'JSXExpressionContainer') {
        // Expression-form HTML attr → a component VARIABLE. Two shapes
        // the Link tool's "Create Variable" produces:
        //   href={linkHref}                          → Identifier
        //   target={newTab ? '_blank' : undefined}   → Conditional(test=Identifier)
        // Store with the `var:` sentinel (same convention as `ref`
        // above + identifier-valued style props) so the Link tool can
        // render the purple bound-variable pill. The conditional case
        // records the TEST identifier — the boolean prop driving it.
        const expr = attr.value.expression as any;
        // Responsive raw-element attr (`type={__mq0 ? 'date' : 'text'}` /
        // `type={variant === 'm' ? … }`) → surface the BASE value so the
        // canvas + Input tool show the primary; the per-viewport/variant
        // value is read from code by the Input tool. Checked first so an
        // `__mq`/`variant` test isn't mistaken for a `var:` binding.
        const respBase = responsiveAttrFallback(expr);
        if (respBase != null) {
          attrs[attrName] = respBase;
          const full = parseResponsiveAttrExpr(expr, ctx.gateWidthMap);
          if (full && (Object.keys(full.viewport).length || Object.keys(full.variant).length)) {
            responsiveAttrsAccum[attrName] = { viewport: full.viewport, variant: full.variant };
          }
        } else if (expr?.type === 'CallExpression'
            && expr.callee?.type === 'Identifier'
            && expr.arguments?.length === 1
            && expr.arguments[0]?.type === 'StringLiteral') {
          // Translation-call attr — `placeholder={t('key')}` (any hook name).
          attrTranslationKeys = attrTranslationKeys ?? {};
          attrTranslationKeys[attrName] = expr.arguments[0].value as string;
          trace.action('parser:attr-translation-key', { attrName, key: expr.arguments[0].value });
        } else if (expr?.type === 'Identifier') {
          attrs[attrName] = `var:${expr.name}`;
        } else if (expr?.type === 'ConditionalExpression' && expr.test?.type === 'Identifier') {
          attrs[attrName] = `var:${expr.test.name}`;
        }
      }
    }
  }

  return { attrs, responsiveAttrsAccum, responsivePropFieldBindings, attrTranslationKeys };
}

/**
 * Component-instance EXPRESSION props — numeric/boolean literals ({500}, {true}),
 * boolean no-value attrs (`<Image fill />`), forwarded-prop refs (`prop={parentVar}`),
 * per-parent-variant conditional props and per-viewport prop variables. Shared by
 * BOTH walkers. NOTE: mutates `attrs` for the boolean / conditional-default cases,
 * exactly like the original in-walker loop did.
 */
function extractInstanceExpressionProps(opening: any, tagName: string, attrs: Record<string, string>, ctx: ParseCtx): {
  componentProps: Record<string, string>;
  attrConditional: Record<string, Record<string, string>>;
  attrConditionalVarRefs: Record<string, Record<string, string>>;
  attrPropRefs: Record<string, string>;
  responsiveAttrPropVars: Record<string, Record<number, string>>;
  responsiveAttrPropVals: Record<string, Record<number, string>>;
  responsiveAttrPropBandsAcc: Record<string, Record<number, number>>;
} {
  const skipAttrs = PARSED_SKIP_ATTRS;
  const isUppercaseTag = tagName.length > 0 && tagName[0] === tagName[0].toUpperCase() && tagName[0] !== tagName[0].toLowerCase();
  // Extract component expression props (numeric, boolean values from JSXExpressionContainer)
  // getAttr() only captures string literals — this captures {500}, {true}, etc.
  const componentProps: Record<string, string> = {};
  // Per-parent-variant prop overrides via ternary:
  //   initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'}
  // Captured here so expandComponent can pick the right child variant
  // styles per parent variant (without re-expanding the tree).
  const attrConditional: Record<string, Record<string, string>> = {};
  // Per-parent-variant CONDITIONAL branches that are VARIABLES (the per-variant hoist) → attr → variant
  // → varName. Lets a page-level instance OVERRIDE the branch via its own prop (the canvas equivalent of
  // the live `initialVariant={variant === 'v' ? someVar : base}` resolving against real props).
  const attrConditionalVarRefs: Record<string, Record<string, string>> = {};
  // Per-instance forwarded-prop refs: `<Child cprop={parentVar} />`.
  // Stored separately from `attrs` so we can resolve the default
  // value in the second pass (where propDefaults are known) AND
  // still drive expandComponent's outer→inner substitution. See the
  // `attrPropRefs` doc-comment on CanvasNode for why both are kept.
  const attrPropRefs: Record<string, string> = {};
  // Per-VIEWPORT VARIABLE on an instance prop (`prop={__mqN ? var : base}`) → per-prop maps.
  const responsiveAttrPropVars: Record<string, Record<number, string>> = {};
  const responsiveAttrPropVals: Record<string, Record<number, string>> = {};
  const responsiveAttrPropBandsAcc: Record<string, Record<number, number>> = {};
  if (isUppercaseTag) {
    for (const attr of (opening.attributes as any[])) {
      if (attr.type !== 'JSXAttribute' || !attr.name || attr.name.type !== 'JSXIdentifier') continue;
      const attrName = attr.name.name as string;
      if (skipAttrs.has(attrName)) continue;
      // Already captured as string by getAttr above
      if (attrs[attrName]) continue;
      if (attr.value === null || attr.value === undefined) {
        // Boolean JSX attribute with no value: <Image fill /> → fill="true"
        attrs[attrName] = 'true';
      } else if (attr.value?.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression;
        if (expr.type === 'NumericLiteral') {
          componentProps[attrName] = String(expr.value);
        } else if (expr.type === 'BooleanLiteral') {
          componentProps[attrName] = String(expr.value);
        } else if (expr.type === 'StringLiteral') {
          componentProps[attrName] = expr.value;
        } else if (expr.type === 'Identifier') {
          // Forwarded-prop ref: `<Child cprop={parentVar} />`. Record
          // the ref name; the second pass below will resolve it to
          // the parent file's default value (so the master canvas
          // shows inheritance visually) AND `expandComponent` will
          // override it with the outer instance's runtime attr at
          // page-level rendering. Skip the React-special `children`
          // identifier — that's content forwarding, not a prop ref.
          if (expr.name !== 'undefined' && expr.name !== 'children') {
            attrPropRefs[attrName] = expr.name;
          }
        } else if (expr.type === 'ConditionalExpression') {
          // Per-VIEWPORT VARIABLE: `prop={__mqN ? var : base}` (the inline-ternary rail; reuses
          // the text-ternary walker — same shape: identifier OR literal branches + base). Checked
          // FIRST because a `__mq` test isn't a `variant ===` test (walkVariantConditionalProp
          // would return null and the prop would be silently dropped).
          const rp = parseResponsiveTextExpr(expr, ctx.gateWidthMap, ctx.gateQueryMap);
          if (rp) {
            if (Object.keys(rp.vars).length > 0) responsiveAttrPropVars[attrName] = rp.vars;
            if (Object.keys(rp.values).length > 0) responsiveAttrPropVals[attrName] = rp.values;
            responsiveAttrPropBandsAcc[attrName] = rp.bands;
            // Base branch flows into the EXISTING rails: a variable base → attrPropRefs (cascading
            // binding), a literal base → componentProps (static value).
            if (rp.base?.kind === 'var' && rp.base.name !== 'undefined' && rp.base.name !== 'children') attrPropRefs[attrName] = rp.base.name;
            else if (rp.base?.kind === 'literal') componentProps[attrName] = rp.base.value;
          } else {
            // Ternary: initialVariant === 'X' ? 'Y' : ... (chain ok); a branch may be a VARIABLE
            // (per-variant hoist) → resolved to its default variant via earlyPageVarDefaults.
            const condResult = walkVariantConditionalProp(expr, ctx.earlyPageVarDefaults);
            if (condResult) {
              attrConditional[attrName] = condResult.map;
              // Which branches are VARIABLES → a page-level instance overrides them via its own prop.
              if (Object.keys(condResult.varRefs).length > 0) attrConditionalVarRefs[attrName] = condResult.varRefs;
              // Default branch becomes the static value so existing readers
              // (e.g. expandComponent's `instanceNode.attrs?.initialVariant`)
              // still see a sensible fallback when there's no per-variant
              // resolution context.
              attrs[attrName] = condResult.map['default'] ?? '';
            }
          }
        }
      }
    }
  }

  return {
    componentProps, attrConditional, attrConditionalVarRefs, attrPropRefs,
    responsiveAttrPropVars, responsiveAttrPropVals, responsiveAttrPropBandsAcc,
  };
}

/**
 * @param propOverrides Optional per-route TEMPLATE variable values to resolve bindings against
 *   INSTEAD of the param signature defaults. The canvas can't run Next.js (`usePathname()`), so the
 *   runtime `color3 = __tp.color3 ?? color3` reassignment is invisible to the static parser — without
 *   this, a template's per-route colors paint their `#…` DEFAULT on the canvas. Merged LAST into
 *   `propDefaults` so route values win for the base binding AND the per-viewport `mqvars` branches.
 */
// Per-node svg/path attribute traces fired once per element — 482 events for a
// single Figma-imported protractor, and each trace call snapshots + buffers.
// Aggregate into one summary per parse instead (2026-08-07 undo-perf hunt).
let _svgAttrCount = 0;

export function parseJSXToNodes(code: string, propOverrides?: Record<string, string>): Map<string, CanvasNode> {
  trace.fn('parser.parseJSXToNodes', { codeLength: code.length });
  const nodes = new Map<string, CanvasNode>();
  const ctx: ParseCtx = {
    code,
    nodes,
    idCounter: 0,
    gateQueryMap: {},
    gateWidthMap: {},
    parentStack: [],
    collectionContextStack: [],
    detailPageContext: null,
    pendingVisibilityByInnerId: new Map(),
    currentVariantConfig: [],
    earlyPageVarDefaults: {},
  };
  // Scan media-query gate consts up front (`const __mq0 = useMediaQuery('…')`).
  for (const m of code.matchAll(/const\s+(__mq\d+)\s*=\s*useMediaQuery\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    ctx.gateQueryMap[m[1]] = m[2];
    const w = /max-width:\s*(\d+)px/.exec(m[2]);
    if (w) ctx.gateWidthMap[m[1]] = parseInt(w[1], 10);
  }
  // Page-variable defaults — needed EARLY (before the node loop) so a per-parent-variant prop whose branch
  // is a VARIABLE (`initialVariant={variant === 'v6' ? someVar : base}`, the per-variant hoist) resolves to
  // the variable's default variant for the static canvas render. Deploy uses the live prop value.
  for (const pv of (parsePageVariables(code)?.variables ?? [])) {
    ctx.earlyPageVarDefaults[pv.name] = pv.default;
  }

  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    trace.action('parser.parseJSXToNodes:parseError', { codeLength: code.length });
    return nodes; // Return empty on parse error (user is typing)
  }

  // Parse all imports: CMS collections, package imports (next/link, next/image), etc.
  const cmsImports = new Map<string, string>(); // varName → slug
  const packageImports = new Set<string>(); // component names imported from packages (not local files)
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const source = stmt.source.value;

    // CMS: `import X from '@/cms/X.json'`
    const cmsMatch = source.match(/^@\/cms\/(.+)\.json$/);
    if (cmsMatch) {
      const slug = cmsMatch[1];
      for (const spec of stmt.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          cmsImports.set(spec.local.name, slug);
          trace.action('parser:cms-import-detected', { varName: spec.local.name, slug });
        }
      }
      continue;
    }

    // Package imports: next/link, next/image, framer-motion, etc.
    // These are NOT user components — they're built-in tags that the parser
    // should treat as regular elements (like <div>), not component references.
    if (!source.startsWith('.') && !source.startsWith('@/') && !source.startsWith('/')) {
      for (const spec of stmt.specifiers) {
        const name = spec.local.name;
        // Only track capitalized names (Link, Image, etc.) — lowercase are hooks/utils
        if (name[0] === name[0].toUpperCase()) {
          packageImports.add(name);
          trace.action('parser:package-import-detected', { name, source });
        }
      }
    }
  }

  // Pre-scan responsive Collection List configs:
  //   `const <cfgVar> = useResponsiveListConfig(base, vpOverrides, vpWidths, variant, variantOverrides)`
  // (emitted by cms-responsive-gen when a list gets a per-viewport/variant override).
  // Args are JSON object literals → convert to plain values so the `.map()` visitor
  // can attach base + per-viewport + per-variant partials onto collectionList.
  type RespDims = { filterGroup?: import('@/shared/types').FilterGroup | null; sort?: import('@/shared/types').SortConfig[] | null };
  const responsiveListConfigs = new Map<string, { base: RespDims; viewport: Record<string, RespDims>; variants: Record<string, RespDims> }>();
  {
    // BASE: absent dim → null (no base filter/sort). OVERRIDE: absent dim → omitted
    // (key NOT set) so it INHERITS base at resolve time — never wipes it to null.
    const toBaseDims = (v: any): RespDims => ({ filterGroup: v?.filter ?? null, sort: v?.sort ?? null });
    const toOverrideDims = (v: any): RespDims => {
      const d: RespDims = {};
      if (v && 'filter' in v) d.filterGroup = v.filter;
      if (v && 'sort' in v) d.sort = v.sort;
      return d;
    };
    const toOverrideMap = (v: any): Record<string, RespDims> => {
      const out: Record<string, RespDims> = {};
      if (v && typeof v === 'object') for (const k of Object.keys(v)) out[k] = toOverrideDims(v[k]);
      return out;
    };
    traverse(ast, {
      VariableDeclarator(path) {
        const n: any = path.node;
        if (n.id?.type !== 'Identifier' || n.init?.type !== 'CallExpression') return;
        if (n.init.callee?.type !== 'Identifier' || n.init.callee.name !== 'useResponsiveListConfig') return;
        const a = n.init.arguments || [];
        responsiveListConfigs.set(n.id.name, {
          base: toBaseDims(astLiteralToValue(a[0])),
          viewport: toOverrideMap(astLiteralToValue(a[1])),
          variants: toOverrideMap(astLiteralToValue(a[4])),
        });
        trace.action('parser:responsive-list-config', { cfgVar: n.id.name });
      },
    });
  }

  // Module-level `const X = motion.create(Y)` / `motion(Y)` wrappers (e.g.
  // `const MotionLink = motion.create(Link)`) are NOT user components — they
  // resolve to a framework element at runtime. Treat the LHS name as a
  // package-style leaf so the component-expansion pass doesn't try to load a
  // `@/components/MotionLink` file for it.
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) {
      if (d.id.type !== 'Identifier' || !d.init) continue;
      const init = d.init;
      const isMotionCreate = init.type === 'CallExpression'
        && ((init.callee.type === 'MemberExpression'
              && init.callee.object.type === 'Identifier' && init.callee.object.name === 'motion'
              && init.callee.property.type === 'Identifier' && init.callee.property.name === 'create')
            || (init.callee.type === 'Identifier' && init.callee.name === 'motion'));
      if (isMotionCreate) {
        packageImports.add(d.id.name);
        trace.action('parser:motion-wrapper-detected', { name: d.id.name });
      }
    }
  }

  // Parse the file's `const variantConfig = [...]` once up front so we can
  // resolve negative conditions like `variant !== 'X'` against the full
  // variant list (need to know all variants to know what "not X" means).
  ctx.currentVariantConfig = parseVariantConfigFromCode(code);

  // CMS Detail-page mode — file-scope binding context.
  //
  // When the file has `/** @cmsPage { kind: 'detail' } */`, the entire
  // function body is a TEMPLATE rendered against `const item = ...`. We
  // want the same `{item.field}` → `binding` detection that .map()
  // callbacks already use — but applied at any depth in the page tree.
  //
  // Kept SEPARATE from `collectionContextStack` because that stack also
  // drives `isCollectionTemplate=true` on every visited node, which
  // changes selection / hover / code-component-ghost behaviour. A detail page
  // doesn't have ghost copies; tagging every element as a template would
  // make the canvas behave like a .map() repeater.
  //
  // The `activeCtx` lookup below merges both (stack first, file-scope
  // fallback) so binding detection sees the right itemVar in either case
  // while `isCollectionTemplate` stays driven by the .map() stack only.
  const cmsPageMatch = code.match(/\/\*\*\s*@cmsPage\s*(\{[\s\S]*?\})\s*\*\//);
  if (cmsPageMatch) {
    try {
      const meta = JSON.parse(cmsPageMatch[1]);
      if (meta.kind === 'detail' && typeof meta.collection === 'string') {
        ctx.detailPageContext = { itemVar: 'item', source: meta.collection };
        trace.action('parser:detail-page-context', { source: meta.collection });
      }
    } catch {
      trace.error('parser:cms-page-meta-parse-failed', { raw: cmsPageMatch[1].slice(0, 80) });
    }
  }

  // Detect const array declarations: const faqData = [{ question: '...', answer: '...' }, ...]
  // These are used to detect inline .map() patterns (not CMS imports)
  const constArrays = new Map<string, Record<string, string>[]>();
  for (const stmt of ast.program.body) {
    // Handle: export default function Page() { const faqData = [...]; ... }
    // Also handle top-level const: const faqData = [...];
    const declarations: any[] = [];
    if (stmt.type === 'VariableDeclaration') {
      declarations.push(...stmt.declarations);
    }
    // Also scan inside the default export function body
    if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration) {
      const decl = stmt.declaration as any;
      if (decl.type === 'FunctionDeclaration' && decl.body?.body) {
        for (const bodyStmt of decl.body.body) {
          if (bodyStmt.type === 'VariableDeclaration') {
            declarations.push(...bodyStmt.declarations);
          }
        }
      }
    }
    // Also scan top-level function declarations (function Page() { ... })
    if (stmt.type === 'FunctionDeclaration' && stmt.body?.body) {
      for (const bodyStmt of (stmt as any).body.body) {
        if (bodyStmt.type === 'VariableDeclaration') {
          declarations.push(...bodyStmt.declarations);
        }
      }
    }

    for (const declarator of declarations) {
      if (declarator.type !== 'VariableDeclarator') continue;
      if (declarator.id?.type !== 'Identifier') continue;
      if (declarator.init?.type !== 'ArrayExpression') continue;

      const varName = declarator.id.name;
      const elements = declarator.init.elements;
      const items: Record<string, string>[] = [];
      let allObjects = true;

      for (const elem of elements) {
        if (!elem || elem.type !== 'ObjectExpression') { allObjects = false; break; }
        const obj: Record<string, string> = {};
        for (const prop of elem.properties) {
          if (prop.type !== 'ObjectProperty') continue;
          const key = prop.key.type === 'Identifier' ? prop.key.name :
                      prop.key.type === 'StringLiteral' ? prop.key.value : null;
          if (!key) continue;
          if (prop.value.type === 'StringLiteral') obj[key] = prop.value.value;
          else if (prop.value.type === 'NumericLiteral') obj[key] = String(prop.value.value);
          // Skip non-literal values but still include the object
        }
        items.push(obj);
      }

      if (allObjects && items.length > 0) {
        constArrays.set(varName, items);
        trace.action('parser:const-array-detected', { varName, itemCount: items.length, fields: Object.keys(items[0]) });
      }
    }
  }

  traverse(ast, {
    JSXElement: {
      enter(path) {
        const el = path.node as JSXElement;
        const opening = el.openingElement;

        // Get element tag name — handle motion.div, motion.span, etc.
        const tagName = resolveTagName(opening);

        // Skip <style> elements — they're for CSS injection, not canvas nodes
        if (tagName === 'style') {
          path.skip(); // don't visit children either
          return;
        }

        // AnimatePresence wrapper for variant visibility — wraps a
        // conditional `{cond && <Child />}` around a single element.
        // We want the inner Child to be processed AS IF it were a
        // direct child of AnimatePresence's parent (so its hierarchy
        // looks like the user's mental model), but with
        // `hiddenOnVariants` populated from parsing the condition.
        //
        // Approach: leave the AnimatePresence wrapper itself
        // invisible to the canvas-node tree (skip its own node
        // creation), but allow the recursion to continue into its
        // children — the inner JSXElement gets a normal node
        // entry. We stash the parsed `hiddenOnVariants` on a
        // side-map keyed by the inner element so the JSXElement
        // handler can attach it once that node is created.
        if (tagName === 'AnimatePresence') {
          for (const child of el.children) {
            if (child.type !== 'JSXExpressionContainer') continue;
            const expr = child.expression;
            if (expr.type !== 'LogicalExpression' || expr.operator !== '&&') continue;
            if (expr.right.type !== 'JSXElement') continue;
            const innerEl = expr.right;
            const innerOpening = innerEl.openingElement;
            const innerId = getAttr(innerOpening.attributes, 'data-id');
            if (!innerId) continue;
            // Parse the condition into a hidden-variants set.
            const allVariantsForParse = ctx.currentVariantConfig
              ? ctx.currentVariantConfig.map(v => v.name)
              : null;
            const hidden = parseVisibilityCondition(expr.left, allVariantsForParse);
            if (hidden && hidden.size > 0) {
              ctx.pendingVisibilityByInnerId.set(innerId, hidden);
            }
          }
          // Let the inner JSXElement traversal continue normally —
          // we don't `path.skip()` here. The early-return below
          // prevents AnimatePresence itself from creating a node
          // entry (so the Layers panel doesn't show it as a layer),
          // while babel's recursion still descends into its children.
          // The inner Frame's parent will therefore be AnimatePresence's
          // PARENT (the flex container), not AnimatePresence itself —
          // matching the user's mental model and keeping flex layout
          // working correctly (AnimatePresence renders no DOM element
          // at runtime; it's React-only).
          return;
        }

        // INVISIBLE WRAPPERS — React components that don't render any
        // DOM node of their own. They exist purely as React-tree
        // wrappers (LayoutGroup, MotionConfig, Fragment) and should
        // not appear in the Layers panel as authored elements. Skip
        // the node creation entirely; recursion continues into their
        // children so the children's parent resolves to the wrapper's
        // own parent.
        if (tagName === 'LayoutGroup'
            || tagName === 'MotionConfig'
            || tagName === 'Fragment'
            // Page-effects wrapper (renders {children} via the View Transitions
            // API) — pure infrastructure, never a user-authored layer.
            || tagName === 'PageTransitions') {
          return;
        }

        // Glide ("Flow") wrappers — a `<motion.div data-glide-item>` we inject
        // around each child of a Glide container purely as a layout-animation
        // member. It MUST stay a real box at runtime (display:contents would
        // break framer-motion's layout measurement), but it's editor-invisible:
        // skip the node so its child attaches to the Glide container itself —
        // no extra layer, no extra selection box, exactly like LayoutGroup above.
        const hasGlideItemMarker = (opening.attributes as any[]).some(a =>
          a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === 'data-glide-item'
        );
        if (hasGlideItemMarker) {
          return; // continue traversing children normally
        }

        // Background-video child: a `<video data-bg-video src="...">` element is
        // a managed background, not a regular canvas node. Peel its full config
        // onto the parent's `bgVideo` field, then skip it from traversal so it
        // doesn't get an auto-id'd CanvasNode entry of its own.
        const hasBgVideoMarker = (opening.attributes as any[]).some(a =>
          a.type === 'JSXAttribute' &&
          a.name?.type === 'JSXIdentifier' &&
          a.name.name === 'data-bg-video'
        );
        if (hasBgVideoMarker) {
          const src = getAttr(opening.attributes, 'src');
          const hostId = ctx.parentStack.length > 0 ? ctx.parentStack[ctx.parentStack.length - 1] : null;
          if (hostId && nodes.has(hostId) && src) {
            // Boolean attrs: present (with no value or any value) = true.
            const hasAttr = (n: string) => (opening.attributes as any[]).some(a =>
              a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === n
            );
            // Inline style: pull objectFit if present, default 'cover'.
            const styleObj = (opening.attributes as any[]).find(a =>
              a.type === 'JSXAttribute' && a.name?.name === 'style'
            );
            let objectFit = 'cover';
            if (styleObj?.value?.type === 'JSXExpressionContainer'
                && styleObj.value.expression?.type === 'ObjectExpression') {
              for (const p of styleObj.value.expression.properties) {
                if (p.type !== 'ObjectProperty' || p.computed) continue;
                const key = p.key.type === 'Identifier' ? p.key.name
                          : p.key.type === 'StringLiteral' ? p.key.value : null;
                if (key === 'objectFit' && p.value.type === 'StringLiteral') {
                  objectFit = p.value.value;
                  break;
                }
              }
            }
            const poster = getAttr(opening.attributes, 'poster');
            nodes.get(hostId)!.bgVideo = {
              src,
              autoPlay: hasAttr('autoPlay'),
              muted: hasAttr('muted'),
              loop: hasAttr('loop'),
              playsInline: hasAttr('playsInline'),
              controls: hasAttr('controls'),
              objectFit,
              ...(poster ? { poster } : {}),
            };
            trace.action('parser:bg-video-attached', { hostId, srcLength: src.length });
          }
          path.skip();
          return;
        }

        // Transparent wrappers — not visual elements, just JS logic.
        // Don't create a node, let children become children of the parent.
        if (tagName === 'MotionConfig' || tagName === 'LayoutGroup' || tagName === 'PageTransitions') {
          return; // continue traversing children normally
        }

        // Note: SVG shape children (polygon, path, etc.) inside <svg data-id="..."> are
        // intentionally NOT skipped in the parser. They get auto-IDs and become child nodes.
        // The Renderer handles deduplication by skipping innerHTML for SVG nodes.

        // Extract data-id
        const id = resolveElementId(opening.attributes as any[], ctx);

        // Extract data-name (sketch wrappers ALWAYS surface as "Sketch" — see resolveElementName).
        const name = resolveElementName(tagName, opening.attributes as any[]);

        // Extract style object + conditional styles (ternary expressions like order: variant === 'v1' ? 1 : 0)
        const { styles, conditionalStyles } = extractElementStyles(opening.attributes, ctx);

        // Extract HTML attributes (src, alt, href, etc.) + component expression
        // props ({500}, {true}, per-parent-variant ternaries, per-viewport prop
        // variables) — SHARED extraction functions (the canvasNodes walker calls
        // the same ones, so the two walk paths cannot drift apart).
        const { attrs, responsiveAttrsAccum, responsivePropFieldBindings, attrTranslationKeys } = extractElementAttrs(opening, tagName, ctx);
        const {
          componentProps, attrConditional, attrConditionalVarRefs, attrPropRefs,
          responsiveAttrPropVars, responsiveAttrPropVals, responsiveAttrPropBandsAcc,
        } = extractInstanceExpressionProps(opening, tagName, attrs, ctx);

        // Extract SVG attributes (cx, cy, d, points, fill, stroke, viewBox, etc.)
        if (isSvgTag(tagName)) {
          extractSvgAttrsInto(opening.attributes as any[], attrs, ctx, responsiveAttrsAccum);
          _svgAttrCount++; // aggregated below — see parser:svg-attrs-summary
        }

        // Extract text content (direct text children)
        // Also detect CMS data bindings: {item.name} → binding text
        let textContent = '';
        let textIsLiteral = false;
        let binding: CanvasNode['binding'] | undefined;
        let textVariable: string | undefined;
        let translationKey: string | undefined;
        // Per-variant text from a `{variant === 'x' ? 'a' : 'b'}` child.
        let conditionalText: Record<string, string> | null = null;
        // Per-variant TEXT-VARIABLE branches (variant → prop name) when a branch/fallback is a variable.
        let conditionalTextVariable: Record<string, string> | null = null;
        // Per-VIEWPORT text branches from a `{__mqN ? branch : base}` child (variable names / literal
        // values / band floors). Variable branches get resolved into `responsiveTextValues` post-pass.
        let responsiveTextVariables: Record<number, string> | null = null;
        let responsiveTextValues: Record<number, string> | null = null;
        let responsiveTextBands: Record<number, number> | null = null;
        // Per-variant CMS-binding overrides (raw element in a .map() inside a component master).
        let variantBindings: CanvasNode['variantBindings'] | undefined;
        // `activeCtx` drives `{item.field}` → `binding` detection. Inner
        // .map() context wins over the file-scope detail-page context so a
        // .map() inside a detail page's template still uses its own item
        // variable.
        // Text effects wrap their content in <RevymeSplitText>; look through it so every
        // detector below sees the real expression child (binding / variable / t() / ternary).
        const splitWrapper = findSplitTextWrapper(el);
        const contentEl = splitWrapper ?? el;
        const activeCtx = ctx.collectionContextStack.length > 0
          ? ctx.collectionContextStack[ctx.collectionContextStack.length - 1]
          : ctx.detailPageContext;
        for (const child of contentEl.children) {
          if (child.type === 'JSXText') {
            // JSX-proper whitespace (preserves a user's same-line trailing/
            // leading spaces, e.g. `Time - `; strips source indentation) — a
            // blanket `.trim()` here destroyed edge spaces on every read.
            const cleaned = cleanJsxText((child as JSXText).value);
            if (cleaned) textContent += cleaned;
          }
          if (child.type === 'JSXExpressionContainer' && child.expression.type === 'StringLiteral') {
            textContent += child.expression.value;
            // Mark as literal — the runtime value came from a JS string
            // literal, not raw JSX text, so any `<` / `{` it contains
            // is plain text (e.g. user pasted source code). Tells the
            // renderer to skip its `textContent.includes('<')` →
            // innerHTML fallback for this node.
            textIsLiteral = true;
          }
          // Detect {item.fieldName} text binding inside collection template
          if (activeCtx && child.type === 'JSXExpressionContainer'
              && child.expression.type === 'MemberExpression'
              && child.expression.object.type === 'Identifier'
              && (child.expression.object as any).name === activeCtx.itemVar
              && child.expression.property.type === 'Identifier') {
            binding = { field: (child.expression.property as any).name, property: 'text' };
            trace.action('parser:cms-text-binding', { nodeId: id, field: binding.field, itemVar: activeCtx.itemVar });
          }
          // Detect bare {propName} text — text content driven by a component
          // variable (e.g. `<p>{title}</p>` where Card has `title = 'Hello'`).
          // The post-resolve pass below substitutes the default value into
          // `textContent` once the function param defaults are extracted.
          // Skip if we already hit a collection MemberExpression on this child.
          if (child.type === 'JSXExpressionContainer'
              && child.expression.type === 'Identifier'
              && !textVariable) {
            textVariable = (child.expression as any).name;
          }
          // Detect next-intl translation calls — `{t('key')}` (any hook
          // variable name, single string-literal arg). The key is the marker
          // the canvas locale resolution uses to look the text up in
          // messages/{locale}.json — replacing the old string-`includes`
          // orphan gate, which silently dropped entries and left stale
          // other-locale text painted (the "Peintre stays in English" bug).
          if (child.type === 'JSXExpressionContainer'
              && child.expression.type === 'CallExpression'
              && (child.expression as any).callee?.type === 'Identifier'
              && (child.expression as any).arguments?.length === 1
              && (child.expression as any).arguments[0]?.type === 'StringLiteral'
              && !translationKey
              // useResponsiveText / other known calls are handled elsewhere.
              && (child.expression as any).callee.name !== 'useResponsiveText') {
            translationKey = (child.expression as any).arguments[0].value as string;
            trace.action('parser:translation-key', { nodeId: id, translationKey });
          }
          // Per-variant CMS text binding (inside a .map() in a component master):
          // `{initialVariant === 'variant-1' ? item.title : item.role}` → variantBindings.text
          // (the variant branches) + the base/else binding (node.binding or literal text).
          // Checked BEFORE the literal/variable conditionalText path below; only fires when
          // a branch references `itemVar.field` (else falls through).
          if (activeCtx && child.type === 'JSXExpressionContainer'
              && child.expression.type === 'ConditionalExpression') {
            const cms = walkVariantCmsText(child.expression, activeCtx.itemVar);
            if (cms) {
              if (cms.base && 'field' in cms.base) binding = { field: cms.base.field, property: 'text' };
              else if (cms.base && 'value' in cms.base) { textContent = cms.base.value; textIsLiteral = true; }
              if (Object.keys(cms.branches).length > 0) {
                variantBindings = variantBindings ?? {};
                variantBindings.text = cms.branches;
              }
              trace.action('parser:variant-cms-text', { nodeId: id, branches: Object.keys(cms.branches) });
            }
          }
          // Per-VIEWPORT text: `{__mqN ? branch : base}` → responsiveTextVariables/Values/Bands
          // (the text twin of the `mqvars` style ternary). Checked BEFORE the per-variant text path
          // (a `__mq`-gated test isn't a `variant === '…'` compare, so they don't overlap), but the
          // guard keeps it explicit. Variable branches are resolved to values in the post-pass.
          if (!variantBindings?.text && child.type === 'JSXExpressionContainer'
              && child.expression.type === 'ConditionalExpression') {
            const rt = parseResponsiveTextExpr(child.expression, ctx.gateWidthMap, ctx.gateQueryMap);
            if (rt) {
              if (Object.keys(rt.vars).length > 0) responsiveTextVariables = rt.vars;
              responsiveTextValues = { ...rt.values }; // literal branches resolved now
              responsiveTextBands = rt.bands;
              if (rt.base?.kind === 'var') { textVariable = rt.base.name; }
              else if (rt.base?.kind === 'literal') { textContent = rt.base.value; textIsLiteral = true; }
              trace.action('parser:responsive-text', { nodeId: id, vars: Object.keys(rt.vars), values: Object.keys(rt.values) });
            }
          }
          // Per-variant text: `{variant === 'v1' ? 'A' : 'B'}` → conditionalText.
          // The trailing literal is the `default` branch (primary variant); the
          // Renderer resolves the active variant the same way it does for
          // conditionalStyles.
          if (!variantBindings?.text && !responsiveTextValues && child.type === 'JSXExpressionContainer'
              && child.expression.type === 'ConditionalExpression') {
            const g = walkVariantTextGeneral(child.expression);
            if (g) {
              // Literal branches → conditionalText. Variable branches → conditionalTextVariable (per-variant
              // binding); their resolved values get baked into conditionalText in the post-resolve pass so
              // the Renderer paints the right text per variant. `textVariable` (any var) keeps the Content
              // control purple + triggers that resolve pass.
              conditionalText = { ...g.literals };
              if (Object.keys(g.vars).length > 0) {
                conditionalTextVariable = g.vars;
                textVariable = g.vars['default'] ?? Object.values(g.vars)[0];
              }
              textContent = g.literals['default'] ?? textContent;
              textIsLiteral = true;
              trace.action('parser:conditional-text', { nodeId: id, literals: Object.keys(g.literals), vars: Object.keys(g.vars) });
            }
          }
        }

        // Detect CMS attribute bindings: src={item.photo}, href={item.link}, alt={item.alt}
        // Multiple bindings supported: text binding goes in `binding`, attribute bindings
        // go in `attrBindings` array so src + alt can coexist.
        const attrBindings: Array<{ field: string; property: 'src' | 'href' | 'alt' }> = [];
        if (activeCtx) {
          const bindableAttrs: Array<{ attr: string; prop: 'src' | 'href' | 'alt' }> = [
            { attr: 'src', prop: 'src' },
            { attr: 'href', prop: 'href' },
            { attr: 'alt', prop: 'alt' },
          ];
          for (const { attr: attrName, prop } of bindableAttrs) {
            for (const a of (opening.attributes as any[])) {
              if (a.type !== 'JSXAttribute' || a.name?.name !== attrName) continue;
              if (a.value?.type === 'JSXExpressionContainer'
                  && a.value.expression.type === 'MemberExpression'
                  && a.value.expression.object.type === 'Identifier'
                  && a.value.expression.object.name === activeCtx.itemVar
                  && a.value.expression.property.type === 'Identifier') {
                attrBindings.push({ field: a.value.expression.property.name, property: prop });
                // Keep backward compat: first attr binding also goes in `binding` if no text binding
                if (!binding) {
                  binding = { field: a.value.expression.property.name, property: prop };
                }
                trace.action('parser:cms-attr-binding', { nodeId: id, field: a.value.expression.property.name, property: prop, itemVar: activeCtx.itemVar });
              }
            }
          }
        }

        // Text animation nodes: extract plain text by collapsing motion.span wrappers.
        // LEGACY ONLY — this tag-strips the raw source, which is what the build-time span
        // form required. A node using the runtime `<RevymeSplitText>` wrapper falls through
        // to the mixed-content path below, which preserves real `<br />` and never strips.
        const hasTextAnim = getAttr(opening.attributes, 'data-text-anim');
        if (hasTextAnim && !splitWrapper) {
          const openingEnd = path.node.openingElement.loc?.end;
          const closingStart = path.node.closingElement?.loc?.start;
          if (openingEnd && closingStart) {
            const lines = code.split('\n');
            let startIdx = 0;
            for (let i = 0; i < openingEnd.line - 1; i++) startIdx += lines[i].length + 1;
            startIdx += openingEnd.column;
            let endIdx = 0;
            for (let i = 0; i < closingStart.line - 1; i++) endIdx += lines[i].length + 1;
            endIdx += closingStart.column;
            const rawInner = code.slice(startIdx, endIdx);
            // Strip all JSX tags to get just the visible characters — but
            // PRESERVE <br/> line breaks (sentinel through the tag-strip +
            // whitespace collapse, restored as <br> at the end: the Renderer
            // sets text-node content via innerHTML, same as plain texts with
            // breaks). Without this a multi-line animated text folded to ONE
            // line on the canvas after reload while the preview kept the
            // breaks (live find 2026-07-23).
            textContent = rawInner
              .replace(/<br\s*\/?>/gi, '\u0000')
              .replace(/<[^>]*>/g, '').replace(/\{" "\}/g, ' ')
              .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
              .replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&quot;/g, '"')
              .replace(/\s+/g, ' ').trim()
              .replace(/\s*\u0000\s*/g, '<br>');
          }
          trace.fn('parser:text-anim-content', { nodeId: id, textContent });
        }

        // Per-viewport text overrides: element wrapped in
        //   {useResponsiveText('primary text', { 768: 'tablet text', ... })}
        // The hook resolves to the right variant per viewport at runtime so
        // each replica's React subtree renders its own value. Parser captures:
        //   • textContent ← primary string (first arg)
        //   • textOverrides ← { width-as-string : variant text } from second arg
        let textOverrides: Record<string, string> | undefined;
        let isTextOverridesContainer = false;
        if (!hasTextAnim || splitWrapper) {
          for (const child of contentEl.children) {
            if (child.type !== 'JSXExpressionContainer') continue;
            const expr = (child as any).expression;
            if (
              !expr ||
              expr.type !== 'CallExpression' ||
              expr.callee?.type !== 'Identifier' ||
              expr.callee.name !== 'useResponsiveText'
            ) continue;

            const args = expr.arguments;
            const primaryArg = args[0];
            const overridesArg = args[1];
            if (!primaryArg || primaryArg.type !== 'StringLiteral') continue;

            textContent = primaryArg.value;
            const overrides: Record<string, string> = {};
            if (overridesArg && overridesArg.type === 'ObjectExpression') {
              for (const prop of overridesArg.properties) {
                if (prop.type !== 'ObjectProperty') continue;
                let widthKey: string | null = null;
                if (prop.key.type === 'NumericLiteral') widthKey = String(prop.key.value);
                else if (prop.key.type === 'StringLiteral') widthKey = prop.key.value;
                if (!widthKey) continue;
                if (prop.value.type === 'StringLiteral') {
                  overrides[widthKey] = prop.value.value;
                }
              }
            }
            if (Object.keys(overrides).length > 0) {
              textOverrides = overrides;
            }
            isTextOverridesContainer = true;
            trace.fn('parser:text-overrides-detected', {
              nodeId: id, primaryLen: primaryArg.value.length, widths: Object.keys(overrides),
            });
            break;
          }
        }

        // Check for mixed/rich text content: element has only inline children (p, span, br, strong, etc.)
        // This covers: text + inline elements, OR only inline elements (e.g., <p>line1</p><p>line2</p>)
        // Detection is SHARED with the canvasNodes walker; the raw-source slice
        // into textContent below is main-walker-only (preserved difference).
        let hasMixedContent = false;
        // A wrapped text-anim node takes this path: its inner is real text (+ <br />), so
        // textContent becomes a genuine string instead of a tag-strip of N spans.
        if ((!hasTextAnim || splitWrapper) && !isTextOverridesContainer && isAllInlineMixedContent(contentEl)) {
          hasMixedContent = true;
          // Extract full inner content from source code using Babel locations
          const openingEnd = (splitWrapper ?? path.node).openingElement.loc?.end;
          const closingStart = (splitWrapper ?? path.node).closingElement?.loc?.start;
          if (openingEnd && closingStart) {
            const lines = code.split('\n');
            let startIdx = 0;
            for (let i = 0; i < openingEnd.line - 1; i++) startIdx += lines[i].length + 1;
            startIdx += openingEnd.column;

            let endIdx = 0;
            for (let i = 0; i < closingStart.line - 1; i++) endIdx += lines[i].length + 1;
            endIdx += closingStart.column;

            textContent = code.slice(startIdx, endIdx).trim();
          }
          trace.fn('parser:mixed-content-detected', { nodeId: id, childCount: el.children.length });
        }

        const parentId = ctx.parentStack.length > 0 ? ctx.parentStack[ctx.parentStack.length - 1] : null;

        // Detect canvas node (data-canvas-node="true" — lives on canvas, not in viewports)
        const isCanvasNode = getAttr(opening.attributes, 'data-canvas-node') === 'true';

        // Extract framer-motion variants prop reference
        // Handles: variants={navVariants} → motionVariantsRef = 'navVariants'
        let motionVariantsRef: string | null = null;
        for (const attr of opening.attributes) {
          if (attr.type === 'JSXAttribute' && (attr as JSXAttribute).name?.name === 'variants') {
            const val = (attr as JSXAttribute).value;
            if (val?.type === 'JSXExpressionContainer') {
              const expr = (val as JSXExpressionContainer).expression;
              if (expr.type === 'Identifier') {
                motionVariantsRef = (expr as any).name;
              } else if (
                expr.type === 'CallExpression'
                && (expr as any).callee?.name === '__applyInstanceSize'
                && (expr as any).arguments?.[0]?.type === 'Identifier'
              ) {
                // Instance-size-override wraps the root variants as
                // `variants={__applyInstanceSize(fooVariants, __instW, __instH)}`
                // (see instance-size-override.ts). The variant OBJECT is still
                // the first argument — resolve it so the canvas renders variants.
                motionVariantsRef = (expr as any).arguments[0].name;
              }
            }
          }
        }

        // Extract framer-motion direct animation props (whileHover, whileTap, etc.)
        const motionProps = extractMotionProps(opening.attributes as any[], ctx);

        // Add to parent's children
        const order = attachToParent(ctx, parentId, id);

        // Mixed content: skip traversing inline children — they're part of textContent
        if (hasMixedContent) {
          // path.skip() is called below after parentStack.push
        }

        // Determine if inside a collection template context
        const isCollectionTemplate = ctx.collectionContextStack.length > 0 ? true : undefined;

        const node: CanvasNode = createBaseNode({
          id, tagName, name, parentId, styles, conditionalStyles, attrs,
          textContent, hasMixedContent, textIsLiteral, order,
          isCanvasNode, motionVariantsRef, motionProps,
        });
        if (isCollectionTemplate) node.isCollectionTemplate = true;
        if (binding) node.binding = binding;
        if (conditionalText) node.conditionalText = conditionalText;
        if (conditionalTextVariable) node.conditionalTextVariable = conditionalTextVariable;
        if (responsiveTextVariables) node.responsiveTextVariables = responsiveTextVariables;
        if (responsiveTextValues) node.responsiveTextValues = responsiveTextValues;
        if (responsiveTextBands) node.responsiveTextBands = responsiveTextBands;
        if (variantBindings) node.variantBindings = variantBindings;
        if (attrBindings.length > 0) node.attrBindings = attrBindings;
        assignAttrExtras(node, {
          componentProps, responsiveAttrsAccum, attrConditional, attrConditionalVarRefs,
          attrPropRefs, responsiveAttrPropVars, responsiveAttrPropVals,
          responsiveAttrPropBandsAcc, responsivePropFieldBindings,
        });
        // textVariable is set when the JSX child was `{propName}` — leave the
        // marker; the post-resolve pass below substitutes the default text
        // into node.textContent once we have the function param defaults.
        if (textVariable) node.textVariable = textVariable;
        if (translationKey) node.translationKey = translationKey;
        if (attrTranslationKeys) node.attrTranslationKeys = attrTranslationKeys;
        if (textOverrides) node.textOverrides = textOverrides;

        // Detect style bindings: style={{ backgroundColor: item.bgColor }} inside .map() templates
        if (activeCtx) {
          const styleBindings = extractStyleBindings(opening.attributes, activeCtx.itemVar);
          if (styleBindings.length > 0) {
            node.styleBindings = styleBindings;
            trace.action('parser:style-bindings', { nodeId: id, bindings: styleBindings });
          }
          // Per-variant CMS style bindings (a `variant === 'v' ? … : item.field` ternary):
          // the else/base binding feeds styleBindings; the variant branches feed variantBindings.style.
          const vsb = extractVariantStyleBindings(opening.attributes, activeCtx.itemVar);
          if (vsb.base.length > 0) {
            const existing = node.styleBindings ?? [];
            node.styleBindings = [...existing, ...vsb.base.filter(b => !existing.some(e => e.styleProp === b.styleProp))];
          }
          if (Object.keys(vsb.variant).length > 0) {
            node.variantBindings = { ...(node.variantBindings ?? {}), style: vsb.variant };
            trace.action('parser:variant-cms-style', { nodeId: id, variants: Object.keys(vsb.variant) });
          }
          // Detect prop bindings: prop={item.field} on component props inside .map()
          const propBindings = extractPropBindings(opening.attributes, activeCtx.itemVar);
          if (propBindings.length > 0) {
            node.propBindings = propBindings;
            trace.action('parser:prop-bindings', { nodeId: id, bindings: propBindings });
          }
        }

        // Orphaned CMS prop bindings — `data-cms-orphan="prop:field,…"` left by a
        // detach (instance dragged out of a collection list). Parsed UNCONDITIONALLY
        // (a detached node has no `activeCtx`) so the panel can show "Missing" pills.
        // Format mirrors cms-detach-gen's serializeOrphanBindings.
        const orphanBindings = parseCmsOrphanBindings(opening.attributes as any[]);
        if (orphanBindings) {
          node.orphanBindings = orphanBindings;
          trace.action('parser:orphan-bindings', { nodeId: id, bindings: orphanBindings });
        }

        // Orphaned COMPONENT-VARIABLE bindings (`data-var-orphan`) — surface as the
        // same purple pills an in-scope binding shows (textVariable / styleVariables).
        applyVarOrphanBindings(node, opening.attributes as any[], id);
        applyTranslationOrphanKey(node, opening.attributes as any[], id);

        // If this element was wrapped in <AnimatePresence>{cond && <this/>}</AnimatePresence>,
        // attach the parsed condition's hidden-variants set now.
        const pendingHidden = ctx.pendingVisibilityByInnerId.get(id);
        if (pendingHidden && pendingHidden.size > 0) {
          node.hiddenOnVariants = pendingHidden;
          ctx.pendingVisibilityByInnerId.delete(id);
          trace.action('parser:attach-hidden-on-variants', {
            nodeId: id, hidden: Array.from(pendingHidden),
          });
        }

        nodes.set(id, node);

        // Opaque imported graphic: keep the svg's children OUT of the node
        // tree — serialize them for innerHTML injection instead (see
        // CanvasNode.graphicMarkup). path.skip() so clipPath/defs/mask/
        // gradient elements never become (broken) div nodes.
        if (isGraphicSvg(tagName, attrs)) {
          node.graphicMarkup = serializeJsxChildrenToSvgMarkup(el.children as any[]);
          node.textContent = '';
          trace.action('parser:graphic-svg-captured', { nodeId: id, markupLength: node.graphicMarkup.length });
          path.skip();
          return;
        }

        if (hasMixedContent || hasTextAnim || splitWrapper || isTextOverridesContainer) {
          // Skip traversing inline children — they're in textContent as raw JSX source
          // For text-anim: children are animation artifacts (motion.span), not structural nodes
          // For text-overrides: children are <span data-vp> per-viewport variants, captured in textOverrides
          path.skip();
          // Don't push to parentStack — path.skip() means exit won't fire
          return;
        }

        ctx.parentStack.push(id);
      },
      exit(path) {
        // Mirror the enter-side early-returns for invisible wrappers
        // (AnimatePresence/LayoutGroup/MotionConfig/Fragment). Those
        // returns DON'T push to parentStack, so this exit must NOT
        // pop. Without this guard, exiting an AnimatePresence wrapper
        // pops a real ancestor off the stack and subsequent siblings
        // get the wrong parentId — visible as "child node renders
        // outside its parent flex container after a hide".
        const el = path.node as JSXElement;
        const opening = el.openingElement;
        const tagName = resolveTagName(opening);
        if (tagName === 'AnimatePresence' || tagName === 'LayoutGroup'
            || tagName === 'MotionConfig' || tagName === 'Fragment'
            || tagName === 'style' || tagName === 'PageTransitions') {
          return;
        }
        // Glide wrappers (`<motion.div data-glide-item>`) are skipped on enter
        // WITHOUT a parentStack.push (they're editor-invisible). Mirror that here
        // — popping for them would over-pop a real ancestor and scramble the tree
        // (component internals leaking to the root, siblings re-parented).
        const isGlideItem = (opening.attributes as any[]).some(a =>
          a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier' && a.name.name === 'data-glide-item'
        );
        if (isGlideItem) {
          return;
        }
        ctx.parentStack.pop();
      },
    },

    // Detect .map() patterns: CMS imports ({team.map(...)}) and inline const arrays ({faqData.map(...)})
    // This fires before the template JSXElements inside are visited
    //
    // The .map() may sit at the end of a chain: `slug.filter(...).sort(...).slice(...).map(...)`.
    // Walk back through .filter / .sort / .slice / .filter (any chained
    // array methods) to reach the source identifier and capture the
    // intermediate call configs onto collectionList. The earlier
    // implementation bailed when callee.object wasn't an Identifier,
    // which silently broke any list with a Filter/Sort/Limit applied.
    CallExpression: {
      enter(path) {
        const callNode = path.node as any;
        // Must be .map() call: callee is MemberExpression with property 'map'
        if (callNode.callee?.type !== 'MemberExpression') return;
        if (callNode.callee.property?.type !== 'Identifier' || callNode.callee.property.name !== 'map') return;

        // Walk back through chained array methods to find the source identifier.
        // Capture filter/sort/slice configs along the way.
        let cursor = callNode.callee.object;
        let parsedFilter: import('@/shared/types').FilterGroup | null = null;
        let parsedSort: import('@/shared/types').SortConfig[] | null = null;
        let parsedLimit: number | null = null;
        let parsedOffset = 0;
        const SAFE_CHAIN = new Set(['filter', 'sort', 'slice']);
        while (cursor && cursor.type === 'CallExpression'
          && cursor.callee?.type === 'MemberExpression'
          && cursor.callee.property?.type === 'Identifier'
          && SAFE_CHAIN.has(cursor.callee.property.name)) {
          const method = cursor.callee.property.name;
          if (method === 'filter') {
            parsedFilter = parseFilterCallback(cursor.arguments?.[0]);
          } else if (method === 'sort') {
            parsedSort = parseSortCallback(cursor.arguments?.[0]);
          } else if (method === 'slice') {
            const sliceArgs = parseSliceArgs(cursor.arguments);
            parsedLimit = sliceArgs.limit;
            parsedOffset = sliceArgs.offset;
          }
          cursor = cursor.callee.object;
        }
        // LOCALIZED shape: the chain head is `localizeRows(slug, __activeLocale)`
        // (@revyme/runtime) — the source resolves per-locale field values at
        // RUNTIME, so the published site translates itself with no build step.
        // Unwrap to the slug so the list stays a first-class collection list in
        // the editor: same bindings, same CMS panel, same filter/sort round
        // trip. Without this the map source is an unresolvable call and the
        // whole list goes dark in the builder (which is exactly what a
        // hand-written locale filter did — user report 2026-08-09).
        if (cursor && cursor.type === 'CallExpression'
          && cursor.callee?.type === 'Identifier' && cursor.callee.name === 'localizeRows') {
          cursor = cursor.arguments?.[0];
        }
        // RESPONSIVE-UPGRADED shape: the chain head is `__applyListConfig(slug, cfgVar)`
        // (filter/sort live in the cfg, not the inline chain). Unwrap to the slug
        // identifier and pull base filter/sort + per-viewport/variant partials from
        // the pre-scanned config.
        let responsiveCfg: { base: RespDims; viewport: Record<string, RespDims>; variants: Record<string, RespDims> } | null = null;
        if (cursor && cursor.type === 'CallExpression'
          && cursor.callee?.type === 'Identifier' && cursor.callee.name === '__applyListConfig') {
          const slugArg = cursor.arguments?.[0];
          const cfgArg = cursor.arguments?.[1];
          if (cfgArg?.type === 'Identifier') responsiveCfg = responsiveListConfigs.get(cfgArg.name) ?? null;
          if (responsiveCfg) {
            parsedFilter = responsiveCfg.base.filterGroup ?? null;
            parsedSort = responsiveCfg.base.sort ?? null;
          }
          cursor = slugArg;  // slug identifier
        }
        // After unwinding the chain, the cursor must be a bare identifier.
        if (!cursor || cursor.type !== 'Identifier') return;
        const sourceVarName = cursor.name;
        const cmsSlug = cmsImports.get(sourceVarName);
        const inlineItems = constArrays.get(sourceVarName);
        if (!cmsSlug && !inlineItems) return; // Not a known variable — ignore

        // Extract the map callback parameter name
        const args = callNode.arguments;
        if (!args || args.length < 1) return;
        const callback = args[0];
        // Arrow function: (item) => (...) or item => (...)
        if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') return;
        const params = callback.params;
        if (!params || params.length < 1 || params[0].type !== 'Identifier') return;
        const itemVar = params[0].name;

        // Determine source string
        const source = cmsSlug ?? `__inline:${sourceVarName}`;

        trace.action('parser:map-detected', { sourceVar: sourceVarName, source, itemVar, isCms: !!cmsSlug, isInline: !!inlineItems });

        // Push collection context so nested JSXElements get isCollectionTemplate + binding detection
        ctx.collectionContextStack.push({ itemVar, source });

        // Find the parent JSXElement to set collectionList on it
        // Walk up the AST path to find the containing JSXElement
        let parentPath = path.parentPath;
        while (parentPath) {
          if (parentPath.node.type === 'JSXElement') {
            const parentOpening = (parentPath.node as any).openingElement;
            const parentDataId = getAttr(parentOpening.attributes, 'data-id');
            if (parentDataId && nodes.has(parentDataId)) {
              // Find the first data-id in the template body (the root template element)
              const templateRootId = findTemplateRootId(callback.body);
              const templateIds: Record<string, string> = {};
              if (templateRootId) {
                templateIds['default'] = templateRootId;
              }
              const parentNode = nodes.get(parentDataId)!;
              // Pagination round-trip: `data-pagination="<mode>:<perPage>"` marker on the
              // list container (written by cms-pagination-gen). The mechanism (slice +
              // useState + button/sentinel) lives in the JSX; this attr is the source of
              // truth for the panel's mode + items.
              let parsedPagination: import('@/shared/types').PaginationConfig | null = null;
              const pagAttr = getAttr(parentOpening.attributes, 'data-pagination');
              if (pagAttr) {
                const [m, n] = pagAttr.split(':');
                if ((m === 'loadMore' || m === 'infinite') && n) {
                  const sanitized = parentDataId.replace(/[^a-zA-Z0-9]/g, '');
                  parsedPagination = { mode: m, perPage: parseInt(n, 10) || 1, stateVar: 'vis' + sanitized.charAt(0).toUpperCase() + sanitized.slice(1) };
                }
              }
              parentNode.collectionList = {
                source,
                itemVar,
                templateIds,
                filterGroup: parsedFilter,
                sort: parsedSort,
                limit: parsedLimit,
                offset: parsedOffset || null,
                pagination: parsedPagination,
                responsive: responsiveCfg ? responsiveCfg.viewport : null,
                variantConfigs: responsiveCfg ? responsiveCfg.variants : null,
              };
              // For inline arrays, store the actual data on the parent node
              if (inlineItems) {
                parentNode.inlineMapData = inlineItems;
                trace.action('parser:inline-map-data-set', { parentId: parentDataId, source, itemCount: inlineItems.length });
              }
              trace.action('parser:collectionList-set', { parentId: parentDataId, source, itemVar, templateIds });
              // Stop ONLY once the REAL container is found. Glide ("Flow") and
              // motion inject TRANSPARENT wrapper JSXElements around a .map() —
              // <LayoutGroup>, <motion.div data-glide>, <AnimatePresence> — that
              // create no node in the tree. The old code broke at the FIRST
              // JSXElement unconditionally, so it bailed on LayoutGroup and the
              // collectionList never reached the grid → the canvas rendered EMPTY
              // ghost copies (only item 0 showed). Keep walking up past wrappers.
              break;
            }
          }
          parentPath = parentPath.parentPath!;
        }
      },
      exit(path) {
        const callNode = path.node as any;
        // Only pop for .map() calls on CMS imports or const arrays. Same
        // chain-walk as enter() so the stack stays balanced for chained
        // forms like `slug.filter(...).map(...)`.
        if (callNode.callee?.type !== 'MemberExpression') return;
        if (callNode.callee.property?.type !== 'Identifier' || callNode.callee.property.name !== 'map') return;
        let cur = callNode.callee.object;
        const SAFE = new Set(['filter', 'sort', 'slice']);
        while (cur && cur.type === 'CallExpression'
          && cur.callee?.type === 'MemberExpression'
          && cur.callee.property?.type === 'Identifier'
          && SAFE.has(cur.callee.property.name)) {
          cur = cur.callee.object;
        }
        // Mirror the enter-visitor's __applyListConfig unwrap so the stack balances
        // for responsive-upgraded lists.
        if (cur && cur.type === 'CallExpression'
          && cur.callee?.type === 'Identifier' && cur.callee.name === '__applyListConfig') {
          cur = cur.arguments?.[0];
        }
        if (!cur || cur.type !== 'Identifier') return;
        const sourceVarName = cur.name;
        if (!cmsImports.has(sourceVarName) && !constArrays.has(sourceVarName)) return;
        ctx.collectionContextStack.pop();
      },
    },
  });

  // Post-parse: resolve motionVariantsRef → motionVariants
  // Collect all referenced variant names from nodes
  const referencedVarNames = new Set<string>();
  for (const [, node] of nodes) {
    if (node.motionVariantsRef) referencedVarNames.add(node.motionVariantsRef);
  }
  // Extract all matching variant objects from the code
  const variantObjects = extractVariantObjects(code, referencedVarNames);
  // Prop defaults (function signature) — to resolve a VARIABLE value inside a variant object (the ` var:<prop>`
  // sentinel from extractVariantObjects) to a concrete value for the MASTER canvas. On a page, expandComponent
  // overrides it with the instance's prop value (same as the inline styleVariables path).
  const variantVarDefaults = extractComponentPropDefaults(ast);
  for (const [, node] of nodes) {
    if (node.motionVariantsRef && variantObjects.has(node.motionVariantsRef)) {
      const raw = variantObjects.get(node.motionVariantsRef)!;
      // CLONE (raw is shared across every node that references the same const — never mutate it) and resolve
      // each `@@VARREF:` sentinel → prop default; record the variable per variant/prop in motionVariantVariables.
      let varsByVariant: Record<string, Record<string, string>> | null = null;
      const resolved: Record<string, Record<string, string>> = {};
      for (const [vName, props] of Object.entries(raw)) {
        const outProps: Record<string, string> = {};
        for (const [pKey, pVal] of Object.entries(props)) {
          if (typeof pVal === 'string' && pVal.startsWith('@@VARREF:')) {
            const varName = pVal.slice(9);
            (varsByVariant ??= {})[vName] ??= {};
            varsByVariant[vName][pKey] = varName;
            const def = variantVarDefaults[varName];
            if (def !== undefined) outProps[pKey] = def; // unknown prop → drop (falls back to base/default entry)
          } else {
            outProps[pKey] = pVal;
          }
        }
        resolved[vName] = outProps;
      }
      node.motionVariants = resolved;
      if (varsByVariant) node.motionVariantVariables = varsByVariant;
    }
  }

  // Post-parse: derive `hiddenOnVariants` from the LEGACY pattern
  // (`variants['X'].display = 'none'`). Lets existing files round-trip
  // through the new system without source rewrites — every place that
  // reads `hiddenOnVariants` sees the right set, and a subsequent
  // variant-visibility write rewrites the JSX into the new
  // AnimatePresence + conditional render form.
  //
  // The AnimatePresence + conditional render pattern populates
  // `hiddenOnVariants` directly during AST walk (see the JSXExpression
  // Container handler) — this loop only fills the legacy case.
  for (const [, node] of nodes) {
    if (!node.motionVariants) continue;
    for (const [variantName, vStyles] of Object.entries(node.motionVariants)) {
      if (vStyles?.display === 'none') {
        if (!node.hiddenOnVariants) node.hiddenOnVariants = new Set();
        node.hiddenOnVariants.add(variantName);
      }
    }
  }

  // Post-parse: detect `const canvasNodes = (<>...</>)` after the export statement.
  // These are workspace-only canvas elements that live outside viewports.
  // Find the canvasNodes variable declaration in the AST program body.
  let canvasNodesJSX: any = null;
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of (stmt as any).declarations) {
      if (decl.type === 'VariableDeclarator'
          && decl.id?.type === 'Identifier'
          && decl.id.name === 'canvasNodes'
          && decl.init) {
        canvasNodesJSX = decl.init;
        trace.action('parser:canvasNodes-declaration-found', { initType: decl.init.type });
        break;
      }
    }
    if (canvasNodesJSX) break;
  }

  // Slot-connected canvas nodes are hoisted to `const cn_<id> = <jsx
  // data-canvas-node="true"/>` (the slot reference model — see slot-ops.ts),
  // so they live outside the `canvasNodes` fragment. Collect those JSX
  // roots so they parse as canvas nodes too.
  const slotConstRoots: any[] = [];
  for (const stmt of ast.program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of (stmt as any).declarations) {
      if (decl.type !== 'VariableDeclarator' || !decl.init) continue;
      if (decl.id?.type !== 'Identifier') continue;
      let init = decl.init;
      if (init.type === 'ParenthesizedExpression') init = init.expression;
      if (init.type !== 'JSXElement') continue;
      // A slot-connected canvas node — detected by the `cn_` const-name
      // convention (slotConstName) OR the `data-canvas-node` attr. The
      // name check matters for component-instance canvas nodes, which may
      // not carry the attr (fragment membership was their signal before).
      const isSlotConst = decl.id.name.startsWith('cn_')
        || getAttr(init.openingElement.attributes, 'data-canvas-node') === 'true';
      if (isSlotConst) slotConstRoots.push(init);
    }
  }

  if (canvasNodesJSX || slotConstRoots.length > 0) {
    // Unwrap parenthesized expression if needed: const canvasNodes = (<>...</>)
    let jsxRoot = canvasNodesJSX;
    if (jsxRoot && jsxRoot.type === 'ParenthesizedExpression') jsxRoot = jsxRoot.expression;

    // Walk direct JSXElement children of the fragment root
    // The root is typically a JSXFragment (<>...</>) or JSXElement
    let fragmentChildren: any[] = [];
    if (jsxRoot && jsxRoot.type === 'JSXFragment') {
      fragmentChildren = jsxRoot.children;
    } else if (jsxRoot && jsxRoot.type === 'JSXElement') {
      // In case it's wrapped in a single element rather than a fragment
      fragmentChildren = jsxRoot.children;
    }

    // Build a sub-AST with just the canvasNodes init expression as a program body
    // so we can traverse it with the same traverse tool
    const canvasNodeParentStack: string[] = [];

    function visitCanvasJSXElement(el: any): void {
      if (el.type !== 'JSXElement') return;
      const opening = el.openingElement;

      const tagName = resolveTagName(opening);

      // Skip non-visual wrappers.
      // PRESERVED walker difference: returning here drops the wrapper's whole
      // subtree (this walker recurses manually at the bottom), whereas the main
      // babel walker keeps descending so wrapper children re-parent upward.
      if (tagName === 'style' || tagName === 'MotionConfig' || tagName === 'LayoutGroup' || tagName === 'PageTransitions') {
        return;
      }

      const id = resolveElementId(opening.attributes, ctx);

      // The MAIN babel traverse (global) already visited this JSX and, for a
      // `.map()` collection list dropped on the canvas, detected the
      // `collectionList` + parsed the template element(s) as children. This
      // manual post-parse walker only recurses into JSXElement children — it
      // SKIPS the `{coll.map(...)}` JSXExpressionContainer — so without
      // carrying the main pass's result forward, `nodes.set` below would wipe
      // the collectionList and reset children to [] (symptom: a collection list
      // on the canvas renders as one collapsed empty box, no ghost rows).
      const existingCanvasNode = nodes.get(id);

      // Sketch wrappers in canvasNodes path: same naming override as the main
      // JSXElement handler (shared resolveElementName) — `data-sketch="true"`
      // always surfaces as "Sketch" so the editor labels are consistent
      // whether the wrapper lives in the page tree or in canvasNodes.
      const name = resolveElementName(tagName, opening.attributes as any[]);
      const { styles, conditionalStyles } = extractElementStyles(opening.attributes, ctx);

      // SAME attr + instance-expression-prop extraction as the main walker —
      // the canvas copy used to be a hand-maintained subset that silently
      // drifted (missing attrs, dropped expression props). One shared
      // implementation is the root fix for that bug class.
      const { attrs, responsiveAttrsAccum, responsivePropFieldBindings, attrTranslationKeys } = extractElementAttrs(opening, tagName, ctx);
      const {
        componentProps, attrConditional, attrConditionalVarRefs, attrPropRefs,
        responsiveAttrPropVars, responsiveAttrPropVals, responsiveAttrPropBandsAcc,
      } = extractInstanceExpressionProps(opening, tagName, attrs, ctx);

      // Extract SVG attributes (cx, cy, d, points, fill, stroke, viewBox, etc.)
      // Shared with the page-parser path. Without this, shapes drawn on the
      // canvas (which become canvas nodes via the `const canvasNodes = (<>...</>)`
      // fragment) lose their fill/width/height/stroke attrs and render invisible.
      if (isSvgTag(tagName)) {
        extractSvgAttrsInto(opening.attributes as any[], attrs, ctx, responsiveAttrsAccum);
        _svgAttrCount++; // aggregated — see parser:svg-attrs-summary
      }

      // Extract text content — CANVAS-SPECIFIC (preserved walker difference):
      // plain JSXText + `{"literal"}` children only. The main walker's richer
      // text extraction (CMS `{item.field}` bindings, `{prop}` text variables,
      // per-variant / per-viewport ternaries) needs function-scope context that
      // module-scope `canvasNodes` JSX cannot legally reference — the orphan
      // stashes (`data-var-orphan` / `data-cms-orphan`, applied below) replace
      // live bindings on this path.
      let textContent = '';
      let textIsLiteral = false;
      // Same wrapper carve-out as the main walker — see findSplitTextWrapper.
      const canvasSplitWrapper = findSplitTextWrapper(el);
      const canvasContentEl = canvasSplitWrapper ?? el;
      for (const child of canvasContentEl.children) {
        if (child.type === 'JSXText') {
          // JSX-proper whitespace — preserve same-line edge spaces (see the
          // main walker's twin site). canvasNodes text round-trips the same.
          const cleaned = cleanJsxText(child.value);
          if (cleaned) textContent += cleaned;
        }
        if (child.type === 'JSXExpressionContainer' && child.expression?.type === 'StringLiteral') {
          textContent += child.expression.value;
          // Wrapped in a JS string literal — text is plain runtime data,
          // not raw JSX. Renderer uses this to skip its `<` →
          // innerHTML fallback (see Renderer.shouldUseInnerHTML).
          textIsLiteral = true;
        }
      }

      // Check for mixed content (inline children) — detection SHARED with the
      // main walker, and so is the raw inner-JSX slice below.
      //
      // This walker used to SKIP that slice ("preserved walker difference"),
      // which left rich text on a CANVAS NODE modelled as
      // `hasMixedContent: true` + an EMPTY `textContent`. Nothing can paint
      // that: `shouldUseInnerHTML` bails on the empty string, so both
      // `buildNodeElement` and `patchElement` render the element blank. Style
      // some text inside a canvas node — colouring it wraps the content in the
      // one `<span>` that makes it "mixed" — and it vanished from the canvas on
      // every full rebuild (page switch / reload) even though the JSX still
      // held it (user report 2026-07-26; the file in their debug capture still
      // had `<span style={{color:…}}>Fraud protection, zero liability</span>`).
      const hasMixedContent = isAllInlineMixedContent(el);
      if (hasMixedContent) {
        const openingEnd = opening.loc?.end;
        const closingStart = (el as any).closingElement?.loc?.start;
        if (openingEnd && closingStart) {
          const lines = code.split('\n');
          let startIdx = 0;
          for (let i = 0; i < openingEnd.line - 1; i++) startIdx += lines[i].length + 1;
          startIdx += openingEnd.column;
          let endIdx = 0;
          for (let i = 0; i < closingStart.line - 1; i++) endIdx += lines[i].length + 1;
          endIdx += closingStart.column;
          textContent = code.slice(startIdx, endIdx).trim();
          trace.fn('parser:canvasNodes-mixed-content', { nodeId: id, length: textContent.length });
        }
      }

      const parentId = canvasNodeParentStack.length > 0 ? canvasNodeParentStack[canvasNodeParentStack.length - 1] : null;

      // Add to parent's children list
      const order = attachToParent(ctx, parentId, id);

      // Same `whileHover` / `whileTap` / `whileInView` / etc. extraction
      // as the main JSX path — without this, dragging a motion element
      // with hover onto the canvas dropped the animation row from the
      // Animation tool's detected list (motionProps stayed null →
      // `mp?.whileHover` undefined → no entry).
      const motionPropsCanvas = extractMotionProps(opening.attributes as any[], ctx);

      const node: CanvasNode = createBaseNode({
        id, tagName, name, parentId, styles, conditionalStyles, attrs,
        textContent, hasMixedContent, textIsLiteral, order,
        // Only top-level canvasNodes entries are canvas nodes; children are regular.
        isCanvasNode: !parentId,
        // Preserved walker difference: the variant-object resolution pass runs
        // BEFORE this walk, so a `variants={ref}` here could never resolve —
        // keep the ref null like this path always has.
        motionVariantsRef: null,
        motionProps: motionPropsCanvas,
      });

      assignAttrExtras(node, {
        componentProps, responsiveAttrsAccum, attrConditional, attrConditionalVarRefs,
        attrPropRefs, responsiveAttrPropVars, responsiveAttrPropVals,
        responsiveAttrPropBandsAcc, responsivePropFieldBindings,
      });
      if (attrTranslationKeys) node.attrTranslationKeys = attrTranslationKeys;

      // Orphaned component-variable bindings — a prop-bound node dragged onto the
      // canvas keeps its purple pill (Content/Style) via `data-var-orphan`. THIS is
      // the path that matters most: the live `{prop}` refs were swapped for literal
      // defaults here, so without this the canvas node loses its bound pill.
      applyVarOrphanBindings(node, opening.attributes as any[], id);
      applyTranslationOrphanKey(node, opening.attributes as any[], id);

      // Carry the main traverse's `.map()` result forward (see comment at
      // `existingCanvasNode`): keep the detected collectionList + inline data and
      // the template child(ren) it linked, so the canvas collection list resolves
      // its ghost rows exactly like one inside a viewport.
      if (existingCanvasNode?.collectionList) {
        node.collectionList = existingCanvasNode.collectionList;
        if (existingCanvasNode.inlineMapData) node.inlineMapData = existingCanvasNode.inlineMapData;
        node.children = [...existingCanvasNode.children];
        trace.action('parser:canvasNodes-collectionList-preserved', { id, source: existingCanvasNode.collectionList.source, children: node.children });
      }

      nodes.set(id, node);
      trace.action('parser:canvasNodes-element-added', { id, type: tagName, name, parentId, styleCount: Object.keys(styles).length });

      // Orphaned CMS prop bindings — `data-cms-orphan="prop:field,…"`. A detached
      // instance usually lives in `canvasNodes` (it was just dragged out of a
      // collection list), so this path MUST parse the stash too or the panel
      // never shows the "Missing" pill. Shared parseCmsOrphanBindings with the
      // main JSX walker above.
      const orphanBindings = parseCmsOrphanBindings(opening.attributes as any[]);
      if (orphanBindings) {
        node.orphanBindings = orphanBindings;
        trace.action('parser:canvasNodes-orphan-bindings', { nodeId: id, bindings: orphanBindings });
      }

      // Opaque imported graphic dragged onto the canvas: same treatment as
      // the main walker — children stay out of the node tree, markup rides
      // on the node for innerHTML injection (see CanvasNode.graphicMarkup).
      if (isGraphicSvg(tagName, attrs)) {
        node.graphicMarkup = serializeJsxChildrenToSvgMarkup(el.children as any[]);
        node.textContent = '';
        trace.action('parser:canvasNodes-graphic-svg-captured', { nodeId: id, markupLength: node.graphicMarkup.length });
      } else if (!hasMixedContent && !node.collectionList && !canvasSplitWrapper) {
        // A collection-list container's children are the `.map()` template — already
        // parsed by the main traverse and preserved above. Re-walking its JSXElement
        // children here would re-add/duplicate them; skip recursion for it.
        canvasNodeParentStack.push(id);
        for (const child of el.children) {
          if (child.type === 'JSXElement') {
            visitCanvasJSXElement(child);
          }
        }
        canvasNodeParentStack.pop();
      }
    }

    for (const child of fragmentChildren) {
      if (child.type === 'JSXElement') {
        visitCanvasJSXElement(child);
      }
    }

    // Hoisted slot-connected canvas nodes (`const cn_<id> = …`).
    for (const root of slotConstRoots) {
      visitCanvasJSXElement(root);
    }

    trace.action('parser:canvasNodes-parsed', {
      addedCount: fragmentChildren.filter((c: any) => c.type === 'JSXElement').length,
      slotConstCount: slotConstRoots.length,
    });
  }

  // ─── Resolve `var:propName` and {propName} bindings to defaults ────────
  // The JSX walk leaves:
  //   - Identifier-typed style values as `var:propName` strings (in
  //     node.styles[prop]),
  //   - bare `{propName}` text children as `node.textVariable = 'propName'`
  //     with empty / partial textContent.
  // Both are useless for canvas rendering as-is — `el.style.X = 'var:Y'`
  // is invalid CSS the browser drops, and a node with `textVariable` set
  // but no resolved text paints empty.
  //
  // Defaults come from TWO sources:
  //   1. Component prop defaults (function signature `({ x = 1 })`) — used
  //      by component master files.
  //   2. Page variable defaults (the @pageVariables annotation block) —
  //      used by regular page files. Their JSX shape is identical to the
  //      component case, so the parser can look in both maps; a file in
  //      practice only populates one.
  // The marker (`styleVariables[prop]` / `textVariable`) is preserved so
  // the variable system can still surface the purple bound state.
  const componentPropDefaults = extractComponentPropDefaults(ast);
  const pageVarConfig = parsePageVariables(code);
  const pageVarDefaults: Record<string, string> = {};
  if (pageVarConfig) {
    for (const v of pageVarConfig.variables) {
      pageVarDefaults[v.name] = v.default;
    }
  }
  // Component props win on key collision — they're file-local and explicit.
  // Page variables only fill in names the function signature doesn't define,
  // which on a regular page (no destructured params) is every name.
  // Route values (canvas template resolution) win over param/page-variable defaults.
  const propDefaults: Record<string, string> = { ...pageVarDefaults, ...componentPropDefaults, ...(propOverrides ?? {}) };
  if (Object.keys(propDefaults).length > 0) {
    let resolvedStyleCount = 0;
    let resolvedTextCount = 0;
    for (const node of nodes.values()) {
      // Styles
      for (const [styleProp, value] of Object.entries(node.styles)) {
        // Conditional bindings (`condvar:name:consequent:alternate`) — same
        // marker semantics as `var:`, but the resolved value picks one of
        // the two ternary branches based on the boolean variable's default.
        if (value.startsWith('condvar:')) {
          const parts = value.slice('condvar:'.length).split(':');
          if (parts.length < 3) continue;
          const propName = parts[0];
          const consequent = parts[1];
          // The alternate may itself contain colons (defensive); rejoin.
          const alternate = parts.slice(2).join(':');
          if (!(propName in propDefaults)) continue;
          const def = propDefaults[propName];
          // JS truthiness, NOT strict `=== 'true'` — a hoisted toggle bound to a variable can resolve to a
          // non-'true' truthy value (route value 'none' for Hide, etc.). Canonical truthiness: value-eval.
          node.styles[styleProp] = isTruthy(def) ? consequent : alternate;
          if (!node.styleVariables) node.styleVariables = {};
          node.styleVariables[styleProp] = propName;
          resolvedStyleCount++;
          continue;
        }
        // URL-wrapped prop ref (`backgroundImage: `url(${image})``). Resolve to
        // `url(<default>)` for the master tile, and record the styleVariable so
        // expandComponent propagates the per-row binding on the page canvas (the
        // ghost re-wraps the plain field value via formatBoundStyleValue).
        if (value.startsWith('urlvar:')) {
          const propName = value.slice('urlvar:'.length);
          if (!(propName in propDefaults)) continue;
          node.styles[styleProp] = `url(${propDefaults[propName]})`;
          if (!node.styleVariables) node.styleVariables = {};
          node.styleVariables[styleProp] = propName;
          resolvedStyleCount++;
          continue;
        }
        // Per-VIEWPORT variable binding marker (`mqvars:<base>||<w>=<branch>||…`). Resolve the BASE
        // (a `var:Name` → its default + styleVariables, or a literal) into node.styles, and each
        // per-viewport branch into responsiveStyleVariables (var name, for the pill) +
        // responsiveStyleValues (resolved value, for the canvas per-tile paint).
        if (value.startsWith('mqvars:')) {
          const parts = value.slice('mqvars:'.length).split('||');
          const base = parts[0];
          if (base.startsWith('var:')) {
            const bn = base.slice(4);
            node.styles[styleProp] = bn in propDefaults ? propDefaults[bn] : '';
            if (bn in propDefaults) {
              if (!node.styleVariables) node.styleVariables = {};
              node.styleVariables[styleProp] = bn;
            }
          } else {
            node.styles[styleProp] = base;
          }
          for (const seg of parts.slice(1)) {
            const eq = seg.indexOf('=');
            if (eq < 0) continue;
            // key = `<maxWidth>~<minWidth>` (the gate's exclusive band). minWidth 0 = no floor.
            const [wStr, minStr] = seg.slice(0, eq).split('~');
            const w = parseInt(wStr, 10);
            const minW = parseInt(minStr ?? '0', 10) || 0;
            const raw = seg.slice(eq + 1);
            if (!Number.isFinite(w)) continue;
            let val: string | null = null;
            if (raw.startsWith('var:')) {
              const vn = raw.slice(4);
              if (!(vn in propDefaults)) continue;
              val = propDefaults[vn];
              if (!node.responsiveStyleVariables) node.responsiveStyleVariables = {};
              if (!node.responsiveStyleVariables[styleProp]) node.responsiveStyleVariables[styleProp] = {};
              node.responsiveStyleVariables[styleProp][w] = vn;
            } else {
              val = raw;
            }
            if (val !== null) {
              if (!node.responsiveStyleValues) node.responsiveStyleValues = {};
              if (!node.responsiveStyleValues[styleProp]) node.responsiveStyleValues[styleProp] = {};
              node.responsiveStyleValues[styleProp][w] = val;
              if (!node.responsiveStyleBands) node.responsiveStyleBands = {};
              if (!node.responsiveStyleBands[styleProp]) node.responsiveStyleBands[styleProp] = {};
              node.responsiveStyleBands[styleProp][w] = minW;
            }
          }
          resolvedStyleCount++;
          continue;
        }
        if (!value.startsWith('var:')) continue;
        const propName = value.slice(4);
        if (!(propName in propDefaults)) continue;
        node.styles[styleProp] = propDefaults[propName];
        if (!node.styleVariables) node.styleVariables = {};
        node.styleVariables[styleProp] = propName;
        resolvedStyleCount++;
      }
      // Conditional-style VARIABLE branches: a ternary branch that is a component PROP
      // (`'--X': initialVariant === 'v' ? X : 'none'`) is parsed as `var:X` inside conditionalStyles.
      // Swap each `var:X` branch for the prop's resolved default (so the canvas paints the right
      // value per variant) AND record `conditionalStyleVariables[cssProp][variant] = X` so the control
      // shows the bound pill on that variant and Remove targets the right branch.
      if (node.conditionalStyles) {
        for (const [cssProp, branches] of Object.entries(node.conditionalStyles)) {
          for (const [variant, bv] of Object.entries(branches)) {
            if (!bv.startsWith('var:')) continue;
            const pn = bv.slice(4);
            if (!(pn in propDefaults)) continue;
            branches[variant] = propDefaults[pn];
            if (variant === 'default') {
              // The ternary FALLBACK variable is the BASE binding (the primary/'default' variant):
              // record it in `styleVariables` (where the base binding lives) + paint its resolved
              // value as the node's static style, NOT in conditionalStyleVariables['default'].
              if (!node.styleVariables) node.styleVariables = {};
              node.styleVariables[cssProp] = pn;
              node.styles[cssProp] = propDefaults[pn];
            } else {
              if (!node.conditionalStyleVariables) node.conditionalStyleVariables = {};
              if (!node.conditionalStyleVariables[cssProp]) node.conditionalStyleVariables[cssProp] = {};
              node.conditionalStyleVariables[cssProp][variant] = pn;
            }
            resolvedStyleCount++;
          }
        }
      }
      // OVERLAY-var bindings: a border (or other prop) bound through the node's `::after` via a CSS
      // custom property — `'--Y': prop` inline (→ styleVariables['--Y'] above) AND
      // `<cssProp>: var(--Y)` in the `::after` rule. Map the consumed CSS prop to the SAME variable
      // so the Styles tool's control (Border) shows the bound purple state, not an empty "Add".
      if (node.styleVariables || node.conditionalStyleVariables) {
        const nidEsc = node.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const afterM = new RegExp(`\\[data-(?:node-)?id="${nidEsc}"\\]::after\\s*\\{([^}]*)\\}`, 's').exec(code);
        if (afterM) {
          const varUse = /([\w-]+)\s*:\s*var\(--([\w-]+)\)/g;
          let vm: RegExpExecArray | null;
          while ((vm = varUse.exec(afterM[1])) !== null) {
            const cssProp = vm[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
            const customKey = `--${vm[2]}`;
            // Plain binding: `'--Y': prop` → mirror onto the consumed cssProp (border).
            const boundVar = node.styleVariables?.[customKey];
            if (boundVar) { (node.styleVariables ??= {})[cssProp] = boundVar; }
            // Per-variant binding: `'--Y': initialVariant === 'v' ? prop : …` → mirror the
            // variant→prop map onto the consumed cssProp so the pill is per-variant on Border too.
            const condVar = node.conditionalStyleVariables?.[customKey];
            if (condVar) {
              if (!node.conditionalStyleVariables) node.conditionalStyleVariables = {};
              node.conditionalStyleVariables[cssProp] = { ...(node.conditionalStyleVariables[cssProp] ?? {}), ...condVar };
            }
          }
        }
      }
      // Forwarded-prop refs on nested instance attrs. For each ref like
      // `<RoHuVu poon={poon2} />` (recorded as attrPropRefs.poon = 'poon2'),
      // substitute attrs.poon = propDefaults['poon2'] so the master canvas
      // renders the inheritance chain visually. At page-level rendering
      // expandComponent will override this with the outer instance's
      // runtime attr value (see project-parser.ts).
      if (node.attrPropRefs) {
        if (!node.attrs) node.attrs = {};
        for (const [attrName, refName] of Object.entries(node.attrPropRefs)) {
          if (!(refName in propDefaults)) continue;
          // Don't trample a literal that won the race somehow.
          if (node.attrs[attrName]) continue;
          node.attrs[attrName] = propDefaults[refName];
        }
      }
      // Text content
      if (node.textVariable && node.textVariable in propDefaults) {
        // Substitute resolved default — but only if textContent is empty
        // (don't blow away mixed text + variable cases). Keep the variable
        // marker either way so the Content control still goes purple.
        if (!node.textContent) {
          node.textContent = propDefaults[node.textVariable];
        }
        // Per-variant text variables: bake each variant's bound variable value into conditionalText so the
        // Renderer (which reads conditionalText[variant]) paints the right text. `default` (the fallback)
        // resolves from textVariable when it's the variable fallback.
        if (node.conditionalTextVariable) {
          for (const [variant, varName] of Object.entries(node.conditionalTextVariable)) {
            if (varName in propDefaults) {
              if (!node.conditionalText) node.conditionalText = {};
              node.conditionalText[variant] = propDefaults[varName];
            }
          }
        }
        if (node.conditionalText && node.conditionalText['default'] === undefined) {
          node.conditionalText['default'] = propDefaults[node.textVariable];
        }
        resolvedTextCount++;
      } else if (node.textVariable && !(node.textVariable in propDefaults)) {
        // Variable referenced but no matching prop default — drop the marker
        // so we don't pretend it's a known binding.
        delete node.textVariable;
      }
      // MIXED-CONTENT text (raw JSX slice, e.g. `<span style={{…}}>{content}</span>`):
      // a text variable bound INSIDE a wrapper span keeps the literal `{content}`
      // in the serialized slice — substitute known prop identifiers so the canvas
      // paints the default instead of the marker (or nothing). The single-word
      // `\{name\}` shape can't collide with JSX attribute braces in the slice
      // (`style={{ … }}` bodies contain spaces/quotes/colons). Records the first
      // substitution as `textVariable` so the panel shows the bound pill.
      if (node.hasMixedContent && node.textContent && node.textContent.includes('{')) {
        let firstVar: string | null = null;
        const substituted = node.textContent.replace(/\{([A-Za-z_$][\w$]*)\}/g, (m, name: string) => {
          if (!(name in propDefaults)) return m;
          if (!firstVar) firstVar = name;
          return propDefaults[name];
        });
        if (substituted !== node.textContent) {
          node.textContent = substituted;
          if (firstVar && !node.textVariable) node.textVariable = firstVar;
          resolvedTextCount++;
        }
      }
      // Per-VIEWPORT text-variable branches → resolve each to its value into responsiveTextValues
      // (the Renderer paints per tile). Independent of the base being var/literal, so it runs outside
      // the textVariable gate above. Literal branches were already filled during the JSX walk.
      if (node.responsiveTextVariables) {
        for (const [w, varName] of Object.entries(node.responsiveTextVariables)) {
          if (varName in propDefaults) {
            if (!node.responsiveTextValues) node.responsiveTextValues = {};
            node.responsiveTextValues[Number(w)] = propDefaults[varName];
          }
        }
      }
      // Per-VIEWPORT INSTANCE-PROP variable branches → resolve each var to its value into
      // responsiveAttrPropValues (expandComponent folds these into responsiveProps → per-tile styles).
      if (node.responsiveAttrPropVariables) {
        for (const [prop, byW] of Object.entries(node.responsiveAttrPropVariables)) {
          for (const [w, varName] of Object.entries(byW)) {
            if (varName in propDefaults) {
              if (!node.responsiveAttrPropValues) node.responsiveAttrPropValues = {};
              if (!node.responsiveAttrPropValues[prop]) node.responsiveAttrPropValues[prop] = {};
              node.responsiveAttrPropValues[prop][Number(w)] = propDefaults[varName];
            }
          }
        }
      }
    }
    if (resolvedStyleCount > 0 || resolvedTextCount > 0) {
      trace.action('parser:resolve-var-defaults', {
        resolvedStyleCount,
        resolvedTextCount,
        propCount: Object.keys(propDefaults).length,
      });
    }
  } else {
    // No prop defaults at all — drop any textVariable markers we set during
    // the walk. They're meaningless without a backing prop default to
    // resolve to (and would otherwise leave the Content control purple
    // pointing at a non-existent variable).
    for (const node of nodes.values()) {
      if (node.textVariable) delete node.textVariable;
    }
  }

  if (_svgAttrCount > 0) { trace.fn('parser:svg-attrs-summary', { count: _svgAttrCount }); _svgAttrCount = 0; }
  trace.fn('parser.parseJSXToNodes:done', { nodeCount: nodes.size, variantObjectCount: variantObjects.size });
  return nodes;
}

/**
 * Extract framer-motion variant objects from code.
 * Finds `const xxxVariants = { variantName: { prop: 'val', ... }, ... };`
 * Returns Map<varName, Record<variantName, Record<prop, value>>>
 */
function extractVariantObjects(code: string, referencedNames?: Set<string>): Map<string, Record<string, Record<string, string>>> {
  trace.fn('parser.extractVariantObjects', { codeLength: code.length, refNames: referencedNames ? [...referencedNames] : [] });
  const result = new Map<string, Record<string, Record<string, string>>>();

  // Match: const xxxVariants = { ... }; (names ending in Variants)
  // AND any const referenced by a variants={} prop
  const regex = /const\s+(\w+)\s*=\s*\{([\s\S]*?)\};/g;
  let match;

  while ((match = regex.exec(code)) !== null) {
    const varName = match[1];
    // Only parse objects that end in 'Variants' OR are referenced by a variants={} prop
    if (!varName.endsWith('Variants') && !(referencedNames?.has(varName))) continue;
    // Skip variantConfig (metadata, not animation data)
    if (varName === 'variantConfig') continue;
    const content = match[2];
    const variants: Record<string, Record<string, string>> = {};

    // Match each variant: name: { prop: 'val', ... } or 'name': { ... }
    const variantRegex = /(?:'([^']+)'|"([^"]+)"|(\w+))\s*:\s*\{([^}]*)\}/g;
    let vMatch;

    while ((vMatch = variantRegex.exec(content)) !== null) {
      const vName = vMatch[1] ?? vMatch[2] ?? vMatch[3];
      const props: Record<string, string> = {};
      const propsStr = vMatch[4];

      // Match each property: prop: 'val' or prop: "val" or prop: number.
      // The KEY may be a bare identifier (`backgroundColor`) OR a QUOTED CSS custom
      // property (`'--azefazef': 'none'`) — the latter is how an overlay-border variable
      // is detached per variant. A custom-prop key is quoted + hyphenated, so the bare
      // `\w+` alternative misses it; capture both forms.
      // The number alternation MUST allow a leading `-` — negative motion
      // props (e.g. `rotate: -13.3`) are common now that rotation is authored
      // as motion props. Without `-?` the prop was dropped entirely, so a
      // variant's negative rotate never reached the canvas and the tile fell
      // back to the base value (visible as the replica showing the wrong angle
      // while live preview animated correctly).
      // A bare IDENTIFIER value (`color: color`) is a VARIABLE reference — a component prop used INSIDE the
      // variant object so ONE variant's value is editable per page (the idiomatic framer-motion shape).
      // Quoted literals stay literal; an unquoted identifier (group 7) is stowed with a `@@VARREF:` sentinel
      // so the post-parse resolution can swap it for the prop's value AND record it as a per-variant style
      // variable (motionVariantVariables) for the panel + the component-instance override.
      const propRegex = /(?:'(--[\w-]+)'|"(--[\w-]+)"|(\w+))\s*:\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*))/g;
      let pMatch;
      while ((pMatch = propRegex.exec(propsStr)) !== null) {
        const pKey = pMatch[1] ?? pMatch[2] ?? pMatch[3];
        const lit = pMatch[4] ?? pMatch[5] ?? pMatch[6];
        props[pKey] = lit != null ? lit : `@@VARREF:${pMatch[7]}`;
      }

      variants[vName] = props;
    }

    if (Object.keys(variants).length > 0) {
      result.set(varName, variants);
    }
  }

  trace.fn('parser.extractVariantObjects:done', {
    count: result.size,
    names: [...result.keys()],
  });
  return result;
}

/**
 * Find the data-id of the first JSXElement in a .map() callback body.
 * Handles: (item) => (<div data-id="card">...</div>)
 *          (item) => <div data-id="card">...</div>
 *          (item) => { return (<div data-id="card">...</div>); }
 */
/** Convert a JSON-literal AST node (ObjectExpression/ArrayExpression/literals) to a
 *  plain JS value. Used to read the `useResponsiveListConfig(...)` JSON args. Returns
 *  undefined for anything non-literal (e.g. the `variant` identifier arg). */
function astLiteralToValue(n: any): any {
  if (!n) return undefined;
  switch (n.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return n.value;
    case 'NullLiteral':
      return null;
    case 'UnaryExpression':
      return n.operator === '-' ? -astLiteralToValue(n.argument) : undefined;
    case 'ArrayExpression':
      return n.elements.map((e: any) => astLiteralToValue(e));
    case 'ObjectExpression': {
      const o: Record<string, any> = {};
      for (const p of n.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const key = p.key.type === 'StringLiteral' ? p.key.value
          : p.key.type === 'Identifier' ? p.key.name
          : p.key.type === 'NumericLiteral' ? String(p.key.value) : null;
        if (key == null) continue;
        o[key] = astLiteralToValue(p.value);
      }
      return o;
    }
    default:
      return undefined;
  }
}

function findTemplateRootId(body: any): string | null {
  // body could be: JSXElement, ParenthesizedExpression wrapping JSXElement, or BlockStatement with ReturnStatement
  let jsxNode: any = body;
  // Unwrap parenthesized expression
  if (jsxNode.type === 'ParenthesizedExpression') {
    jsxNode = jsxNode.expression;
  }
  // Unwrap block statement with return
  if (jsxNode.type === 'BlockStatement') {
    for (const stmt of jsxNode.body) {
      if (stmt.type === 'ReturnStatement' && stmt.argument) {
        jsxNode = stmt.argument;
        break;
      }
    }
  }
  // Unwrap one more level of parenthesized expression
  if (jsxNode.type === 'ParenthesizedExpression') {
    jsxNode = jsxNode.expression;
  }
  // Now check if it's a JSXElement with data-id
  if (jsxNode.type === 'JSXElement') {
    const attrs = jsxNode.openingElement?.attributes;
    if (attrs) {
      return getAttr(attrs, 'data-id');
    }
  }
  return null;
}

/** Returns {startLine, endLine} (1-based) for a given data-id in the JSX code */
export function getNodeLineRange(code: string, nodeId: string, tagName?: string): { startLine: number; endLine: number } | null {
  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return null;
  }

  let result: { startLine: number; endLine: number } | null = null;

  // 1. Search by data-id attribute
  traverse(ast, {
    JSXElement(path) {
      if (result) return;
      const opening = path.node.openingElement;
      const id = getAttr(opening.attributes as any, 'data-id');
      if (id === nodeId && path.node.loc) {
        result = {
          startLine: path.node.loc.start.line,
          endLine: path.node.loc.end.line,
        };
        path.stop();
      }
    },
  });

  // 2. Fallback: search by component tag name (for <ComponentName /> without data-id)
  if (!result && tagName && /^[A-Z]/.test(tagName)) {
    // Count occurrence index from nodeId (auto_0 → 0, auto_1 → 1, etc.)
    const autoMatch = nodeId.match(/^auto_(\d+)$/);
    // Find all component instances of this tag name, match by occurrence
    const occurrenceIndex = 0;
    const targetOccurrence = autoMatch ? parseInt(autoMatch[1], 10) : 0;
    let componentOccurrence = 0;

    traverse(ast, {
      JSXElement(path) {
        if (result) return;
        const opening = path.node.openingElement;
        const name = opening.name;
        const elTagName = name.type === 'JSXIdentifier' ? name.name :
                          name.type === 'JSXMemberExpression' ? `${(name.object as any).name}.${name.property.name}` : null;

        if (elTagName === tagName && path.node.loc) {
          if (componentOccurrence === targetOccurrence) {
            result = {
              startLine: path.node.loc.start.line,
              endLine: path.node.loc.end.line,
            };
            path.stop();
          }
          componentOccurrence++;
        }
      },
    });
  }

  return result;
}

// ─── Collection chain config parsers ────────────────────────────────────
//
// These reverse what `cms-gen.ts:buildChainCode` emits — they don't have
// to handle arbitrary user-written `.filter()` / `.sort()` / `.slice()`,
// just the canonical shapes our generator produces. If a chain doesn't
// match the expected shape we return null and the renderer renders the
// unfiltered/unsorted/full list (graceful no-op).

function parseSliceArgs(args: any[] | undefined): { offset: number; limit: number | null } {
  // Generator shapes:
  //   `.slice(0, N)`        → limit N, offset 0          (plain limit)
  //   `.slice(M)`           → offset M, no limit         (start offset only)
  //   `.slice(M, K)`        → offset M, limit K-M        (end index → count)
  //   `.slice(0, visX)`     → offset 0, no NUMERIC limit (pagination — Identifier
  //                           2nd arg; pagination is detected via data-pagination)
  if (!args || args.length === 0) return { offset: 0, limit: null };
  const first = args[0];
  const offset = first?.type === 'NumericLiteral' && typeof first.value === 'number' ? first.value : 0;
  if (args.length < 2) return { offset, limit: null };
  const second = args[1];
  if (second?.type === 'NumericLiteral' && typeof second.value === 'number') {
    return { offset, limit: second.value - offset };
  }
  return { offset, limit: null };
}

/** Parse ONE sort key from a ConditionalExpression. Handles BOTH the legacy
 *  2-branch shape `a.F > b.F ? 1 : -1` AND the new 3-branch tiebreak shape
 *  `a.F > b.F ? 1 : a.F < b.F ? -1 : 0` — in both, the OUTER consequent
 *  (1 → asc, -1 → desc) is the direction discriminator, so the alternate's
 *  exact shape doesn't matter. */
function parseSortKey(cond: any): import('@/shared/types').SortConfig | null {
  if (!cond || cond.type !== 'ConditionalExpression') return null;
  const test = cond.test;
  if (!test || test.type !== 'BinaryExpression' || test.operator !== '>') return null;
  if (test.left?.type !== 'MemberExpression' || test.left.property?.type !== 'Identifier') return null;
  const field = test.left.property.name;
  const cons = cond.consequent;
  if (cons?.type === 'NumericLiteral' && cons.value === 1) return { field, direction: 'asc' };
  if (cons?.type === 'UnaryExpression' && cons.operator === '-') return { field, direction: 'desc' };
  return null;
}

function parseSortCallback(arg: any): import('@/shared/types').SortConfig[] | null {
  // Multi-key shape:  `(a, b) => (key0) || (key1) || ...` where each key is a
  // 3-branch conditional. Single key = one bare conditional (new or legacy).
  if (!arg || (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression')) return null;
  const body = arg.body;
  if (!body) return null;
  const keys: import('@/shared/types').SortConfig[] = [];
  const walk = (node: any): boolean => {
    if (node?.type === 'LogicalExpression' && node.operator === '||') {
      return walk(node.left) && walk(node.right); // left→right preserves precedence
    }
    const k = parseSortKey(node);
    if (!k) return false;
    keys.push(k);
    return true;
  };
  if (!walk(body)) return null;
  return keys.length > 0 ? keys : null;
}

function parseFilterCallback(arg: any): import('@/shared/types').FilterGroup | null {
  // Generator shape: `(item) => item.<field> <op> <value> [&& / ||] ...`
  // We only support a flat `&&`-joined or `||`-joined list of comparisons
  // that maps to FilterConfig — same surface the UI exposes.
  if (!arg || (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression')) return null;
  const body = arg.body;
  if (!body) return null;

  const filters: import('@/shared/types').FilterConfig[] = [];
  let combinator: 'and' | 'or' = 'and';

  // Peel the coercion wrappers the generator emits: `.slice(0, 10)` (date-only
  // day comparison), `String(X).toLowerCase()` → X, `X.toLowerCase()` → X, and
  // `String(X)` → X. Leaves a bare `item.field` / string-literal underneath.
  const unwrapStringCoerce = (n: any): any => {
    // Date-day: `String(item.field).slice(0, 10)` → `String(item.field)`.
    if (n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression'
      && n.callee.property?.type === 'Identifier' && n.callee.property.name === 'slice') {
      n = n.callee.object;
    }
    if (n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression'
      && n.callee.property?.type === 'Identifier' && n.callee.property.name === 'toLowerCase') {
      n = n.callee.object;
    }
    if (n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'String') {
      n = n.arguments?.[0];
    }
    return n;
  };

  function parseComparison(node: any): import('@/shared/types').FilterConfig | null {
    if (!node) return null;
    // .includes(...) / !.includes(...) for contains / not_contains. The generator
    // now emits a CASE-INSENSITIVE shape: `String(item.field).toLowerCase()
    // .includes(String("v").toLowerCase())` — unwrap toLowerCase()/String() on
    // BOTH the field and the value (back-compat: also reads the old bare form).
    if (node.type === 'CallExpression'
      && node.callee?.type === 'MemberExpression'
      && node.callee.property?.type === 'Identifier'
      && node.callee.property.name === 'includes') {
      const fieldNode = unwrapStringCoerce(node.callee.object);
      if (fieldNode?.type === 'MemberExpression' && fieldNode.property?.type === 'Identifier') {
        const field = fieldNode.property.name;
        const v = unwrapStringCoerce(node.arguments?.[0]);
        const value = v?.type === 'StringLiteral' || v?.type === 'NumericLiteral' ? v.value : '';
        return { field, operator: 'contains', value };
      }
    }
    if (node.type === 'UnaryExpression' && node.operator === '!') {
      const inner = parseComparison(node.argument);
      if (inner?.operator === 'contains') return { ...inner, operator: 'not_contains' };
      if (inner?.operator === 'equals') return { ...inner, operator: 'not_equals' };
      if (inner?.operator === 'exists') return { ...inner, operator: 'exists', value: false };
      return null;
    }
    if (node.type === 'BinaryExpression') {
      // Unwrap a date-day LHS (`String(item.field).slice(0, 10) === "2026-06-15"`)
      // back to the bare member so the date filter round-trips like any other.
      const left = unwrapStringCoerce(node.left);
      if (left?.type !== 'MemberExpression' || left.property?.type !== 'Identifier') return null;
      const field = left.property.name;
      const v = node.right;
      const value = v?.type === 'StringLiteral' || v?.type === 'NumericLiteral' ? v.value
        : v?.type === 'BooleanLiteral' ? v.value
        : '';
      const opMap: Record<string, import('@/shared/types').FilterConfig['operator']> = {
        '===': 'equals', '==': 'equals',
        '!==': 'not_equals', '!=': 'not_equals',
        '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
      };
      const op = opMap[node.operator];
      if (!op) return null;
      return { field, operator: op, value };
    }
    return null;
  }

  // `between` = `(item.F >= lo && item.F <= hi)` — an `&&` of two comparisons on
  // the SAME field. Must be recognized as ONE filter BEFORE `&&` is treated as a
  // combinator (else it splits into two gt/lt filters).
  function tryParseBetween(node: any): import('@/shared/types').FilterConfig | null {
    if (node?.type !== 'LogicalExpression' || node.operator !== '&&') return null;
    const L = node.left, R = node.right;
    if (L?.type !== 'BinaryExpression' || R?.type !== 'BinaryExpression') return null;
    if (L.operator !== '>=' || R.operator !== '<=') return null;
    // Unwrap a date-day LHS (`String(item.field).slice(0,10)`) so a date `between` round-trips.
    const fieldOf = (n: any) => { const m = unwrapStringCoerce(n?.left); return m?.type === 'MemberExpression' && m.property?.type === 'Identifier' ? m.property.name : null; };
    const lf = fieldOf(L), rf = fieldOf(R);
    if (!lf || lf !== rf) return null;
    const lit = (n: any) => (n?.type === 'NumericLiteral' || n?.type === 'StringLiteral') ? n.value : undefined;
    const lo = lit(L.right), hi = lit(R.right);
    if (lo === undefined || hi === undefined) return null;
    return { field: lf, operator: 'between', value: [lo, hi] };
  }

  // Dynamic-value filters (Phase 4) are guarded `||` predicates — must be matched
  // as ONE filter BEFORE `||` is treated as the combinator:
  //   search: `(var === '' || String(item.F).toLowerCase().includes(var.toLowerCase()))`
  //   date:   `(!var || item.F >= var)`
  function fieldFromIncludes(call: any): string | null {
    if (call?.type !== 'CallExpression' || call.callee?.type !== 'MemberExpression'
      || call.callee.property?.name !== 'includes') return null;
    let obj = call.callee.object;
    if (obj?.type === 'CallExpression' && obj.callee?.type === 'MemberExpression' && obj.callee.property?.name === 'toLowerCase') obj = obj.callee.object;
    if (obj?.type === 'CallExpression' && obj.callee?.type === 'Identifier' && obj.callee.name === 'String') obj = obj.arguments?.[0];
    return obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier' ? obj.property.name : null;
  }
  function tryParseDynamic(node: any): import('@/shared/types').FilterConfig | null {
    if (node?.type !== 'LogicalExpression' || node.operator !== '||') return null;
    const L = node.left, R = node.right;
    // search field
    if (L?.type === 'BinaryExpression' && (L.operator === '===' || L.operator === '==')
      && L.left?.type === 'Identifier' && L.right?.type === 'StringLiteral' && L.right.value === '') {
      const field = fieldFromIncludes(R);
      if (field) return { field, operator: 'contains', value: '', valueSource: 'searchField', valueVar: L.left.name };
    }
    // date field
    if (L?.type === 'UnaryExpression' && L.operator === '!' && L.argument?.type === 'Identifier'
      && R?.type === 'BinaryExpression' && R.operator === '>='
      && R.left?.type === 'MemberExpression' && R.left.property?.type === 'Identifier'
      && R.right?.type === 'Identifier' && R.right.name === L.argument.name) {
      return { field: R.left.property.name, operator: 'gte', value: '', valueSource: 'dateField', valueVar: L.argument.name };
    }
    return null;
  }

  function flatten(node: any): boolean {
    const dynamic = tryParseDynamic(node);
    if (dynamic) { filters.push(dynamic); return true; }
    const between = tryParseBetween(node);
    if (between) { filters.push(between); return true; }
    if (node?.type === 'LogicalExpression') {
      if (node.operator === '&&') combinator = 'and';
      else if (node.operator === '||') combinator = 'or';
      else return false;
      return flatten(node.left) && flatten(node.right);
    }
    const f = parseComparison(node);
    if (!f) return false;
    filters.push(f);
    return true;
  }

  if (!flatten(body)) return null;
  if (filters.length === 0) return null;
  return { combinator, filters };
}

/**
 * Extract framer-motion direct animation props (`whileHover`, `whileTap`,
 * `whileInView`, `initial`, `animate`, `transition`, `viewport`) from a
 * JSX opening element's attribute list.
 *
 * Three accepted shapes:
 *   - string literal:           `initial="hidden"`            → `{ _variantName: 'hidden' }`
 *   - string in expression:     `initial={"hidden"}`          → `{ _variantName: 'hidden' }`
 *   - object expression:        `whileHover={{ scale: 1.05 }}` → `{ scale: '1.05' }`
 *
 * Numeric literals are stringified; negative numbers (UnaryExpression
 * over a NumericLiteral) are handled. Other complex expressions
 * (arrays, nested objects, identifier refs) are skipped — the
 * AnimationTool only edits primitive values.
 *
 * Shared so the main JSX walker AND the `const canvasNodes = (<>...</>)`
 * walker produce identical `motionProps` payloads — without this, a
 * `motion.div whileHover={...}` dragged onto the canvas lost its motion
 * props during parsing and the Animation tool stopped detecting it.
 */
function extractMotionProps(attrs: (JSXAttribute | any)[], ctx: ParseCtx): CanvasNode['motionProps'] {
  const MOTION_PROP_NAMES = ['whileHover', 'whileTap', 'whileInView', 'initial', 'animate', 'exit', 'transition', 'viewport'];
  let motionProps: CanvasNode['motionProps'] = null;
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute') continue;
    const attrName = (attr as JSXAttribute).name?.name as string;
    if (!MOTION_PROP_NAMES.includes(attrName)) continue;
    const val = (attr as JSXAttribute).value;
    if (!val) continue;

    if (val.type === 'StringLiteral') {
      if (!motionProps) motionProps = {};
      (motionProps as any)[attrName] = { _variantName: (val as StringLiteral).value };
      continue;
    }

    if (val.type !== 'JSXExpressionContainer') continue;
    const expr = (val as JSXExpressionContainer).expression;

    if (expr.type === 'StringLiteral') {
      if (!motionProps) motionProps = {};
      (motionProps as any)[attrName] = { _variantName: (expr as StringLiteral).value };
      continue;
    }

    // Read a flat `{ key: literal, … }` object-expression into a Record.
    const readObj = (objExpr: any): Record<string, string> => {
      const out: Record<string, string> = {};
      if (objExpr?.type !== 'ObjectExpression') return out;
      for (const prop of (objExpr as ObjectExpression).properties) {
        if (prop.type !== 'ObjectProperty') continue;
        const oprop = prop as ObjectProperty;
        const key = oprop.key.type === 'Identifier' ? oprop.key.name :
                    oprop.key.type === 'StringLiteral' ? oprop.key.value : null;
        if (!key) continue;
        if (oprop.value.type === 'StringLiteral') out[key] = (oprop.value as StringLiteral).value;
        else if (oprop.value.type === 'NumericLiteral') out[key] = String((oprop.value as NumericLiteral).value);
        else if (oprop.value.type === 'BooleanLiteral') out[key] = String((oprop.value as any).value);
        else if (oprop.value.type === 'UnaryExpression' && (oprop.value as any).operator === '-'
          && (oprop.value as any).argument?.type === 'NumericLiteral') {
          out[key] = String(-(oprop.value as any).argument.value);
        }
        // `repeat: Infinity` (declarative Loop transitions) — Identifier, not a
        // literal. Capture it so a copied loop's transition round-trips on paste
        // (updateMotionPropInCode emits 'Infinity' unquoted).
        else if (oprop.value.type === 'Identifier' && (oprop.value as any).name === 'Infinity') {
          out[key] = 'Infinity';
        }
      }
      return out;
    };

    // Read the scope marker off a ternary test (`variant === 'x'` or `__mqN`).
    const markerFromTest = (test: any): string | null => {
      if (test?.type === 'BinaryExpression' && test.operator === '===' &&
          test.left?.type === 'Identifier' &&
          (test.left.name === 'variant' || test.left.name === 'initialVariant') &&
          test.right?.type === 'StringLiteral') {
        return `variant:${test.right.value}`;
      }
      if (test?.type === 'Identifier') return `gate:${test.name}`;  // viewport — query lives in the useMediaQuery const
      return null;
    };

    // Per-scope wrapped prop. Shapes:
    //   on/off:     `whileHover={variant === 'x' ? { … } : undefined}`
    //   responsive: `whileHover={__mq0 ? {override} : {base}}`
    //   chained:    `whileHover={__mq0 ? {t} : __mq1 ? {m} : {base}}` (one branch
    //               PER viewport/variant + a final base). Walk the WHOLE chain so
    //               every scope is captured — not just the outermost — and stash
    //               it as `_chain` (JSON [{marker, props}]) + the final `_base`
    //               object, so the tool can pick the branch for ANY viewport.
    //               (`_scope`/flat props stay = outermost override for back-compat.)
    let objExpr: any = expr;
    let scopeMarker: string | null = null;
    let baseObj: any = null;
    const chain: Array<{ marker: string | null; query?: string; props: Record<string, string> }> = [];
    if (expr.type === 'ConditionalExpression') {
      let cursor: any = expr;
      while (cursor?.type === 'ConditionalExpression') {
        if (cursor.consequent?.type === 'ObjectExpression') {
          const marker = markerFromTest(cursor.test);
          const gate = marker?.startsWith('gate:') ? marker.slice(5) : null;
          chain.push({ marker, query: gate ? ctx.gateQueryMap[gate] : undefined, props: readObj(cursor.consequent) });
        }
        cursor = cursor.alternate;
      }
      baseObj = cursor;                       // innermost alternate: {base} or `undefined`
      objExpr = (expr as any).consequent;     // outermost override drives flat props
      scopeMarker = chain[0]?.marker ?? null;
      if (objExpr?.type !== 'ObjectExpression') continue;
    }

    if (objExpr.type !== 'ObjectExpression') continue;
    const props: Record<string, string> = readObj(objExpr);
    if (scopeMarker) props._scope = scopeMarker;
    if (baseObj?.type === 'ObjectExpression') props._base = JSON.stringify(readObj(baseObj));
    if (chain.length > 0) props._chain = JSON.stringify(chain);
    if (Object.keys(props).some(k => !k.startsWith('_'))) {
      if (!motionProps) motionProps = {};
      (motionProps as any)[attrName] = props;
    }
  }
  return motionProps;
}

function getAttr(attrs: (JSXAttribute | any)[], name: string): string | null {
  for (const attr of attrs) {
    if (attr.type === 'JSXAttribute' && attr.name?.name === name) {
      if (attr.value?.type === 'StringLiteral') return attr.value.value;
      if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type === 'StringLiteral') {
        return attr.value.expression.value;
      }
    }
  }
  return null;
}

/**
 * Parse a COMPUTED `data-responsive` expression (`JSON.stringify({768:{prop:item.field, gap:16}})`
 * or a bare object literal) into its two halves:
 *   - `literalJson`: a JSON string of just the LITERAL overrides (+ `_bp`), so the
 *     existing `attrs['data-responsive']` consumers (responsiveProps / responsiveVariantMap)
 *     keep working unchanged;
 *   - `fieldBindings`: viewport width → { prop: fieldName } for the LIVE `item.field`
 *     member-expression values (any non-literal value), lowered later by expandComponent.
 * Returns null if the expression isn't an object/JSON.stringify(object).
 */
function parseComputedResponsiveAttr(expr: any): { literalJson: string | null; fieldBindings: Record<number, Record<string, string>> | null } | null {
  const objExpr = expr?.type === 'CallExpression' ? expr.arguments?.[0]
    : expr?.type === 'ObjectExpression' ? expr : null;
  if (!objExpr || objExpr.type !== 'ObjectExpression') return null;
  const keyName = (n: any): string | null =>
    n?.type === 'StringLiteral' ? n.value : n?.type === 'Identifier' ? n.name : n?.type === 'NumericLiteral' ? String(n.value) : null;
  const literal: Record<string, any> = {};
  let fieldBindings: Record<number, Record<string, string>> | null = null;
  for (const prop of objExpr.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const key = keyName(prop.key);
    if (key == null) continue;
    if (key === '_bp') {
      if (prop.value.type === 'ArrayExpression') {
        literal._bp = prop.value.elements.map((e: any) => (e?.type === 'NumericLiteral' ? e.value : null)).filter((n: any) => n != null);
      }
      continue;
    }
    if (prop.value.type !== 'ObjectExpression') continue;
    const vpWidth = parseInt(key, 10);
    for (const sub of prop.value.properties) {
      if (sub.type !== 'ObjectProperty') continue;
      const pk = keyName(sub.key);
      if (pk == null) continue;
      const v: any = sub.value;
      if (v.type === 'NumericLiteral' || v.type === 'StringLiteral' || v.type === 'BooleanLiteral') {
        if (!literal[key]) literal[key] = {};
        literal[key][pk] = v.value;
      } else if (v.type === 'MemberExpression' && v.property?.type === 'Identifier' && !isNaN(vpWidth)) {
        // Live CMS field-ref (`item.shortTitle`) → record { prop: fieldName }.
        if (!fieldBindings) fieldBindings = {};
        if (!fieldBindings[vpWidth]) fieldBindings[vpWidth] = {};
        fieldBindings[vpWidth][pk] = v.property.name;
      }
    }
  }
  const hasLiteralEntries = Object.keys(literal).some(k => k !== '_bp');
  return {
    literalJson: hasLiteralEntries ? JSON.stringify(literal) : null,
    fieldBindings,
  };
}

/** Detect item.field references inside style={{ ... }} for .map() style bindings. */
function extractStyleBindings(attrs: (JSXAttribute | any)[], itemVar: string): Array<{ styleProp: string; field: string }> {
  const bindings: Array<{ styleProp: string; field: string }> = [];
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute' || attr.name?.name !== 'style') continue;
    if (attr.value?.type !== 'JSXExpressionContainer') continue;
    const expr = attr.value.expression;
    if (expr.type !== 'ObjectExpression') continue;
    for (const prop of expr.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name :
                  prop.key.type === 'StringLiteral' ? prop.key.value : null;
      if (!key) continue;
      // Direct: `backgroundColor: item.brand`
      if (prop.value.type === 'MemberExpression'
          && prop.value.object.type === 'Identifier'
          && (prop.value.object as any).name === itemVar
          && prop.value.property.type === 'Identifier') {
        bindings.push({ styleProp: key, field: (prop.value.property as any).name });
        continue;
      }
      // Template-literal wrapper: `backgroundImage: \`url(${item.photo})\``.
      // Image bindings go through this shape because `background-image` needs
      // a `url(...)` wrapper, not a bare string. Detect a single `${item.X}`
      // expression inside the literal and record the field — the renderer's
      // existing styleBindings application overwrites the whole property
      // value, which is fine for url(...) too.
      if (prop.value.type === 'TemplateLiteral'
          && prop.value.expressions.length === 1) {
        const inner = prop.value.expressions[0];
        if (inner.type === 'MemberExpression'
            && inner.object.type === 'Identifier'
            && (inner.object as any).name === itemVar
            && inner.property.type === 'Identifier') {
          bindings.push({ styleProp: key, field: (inner.property as any).name });
        }
      }
    }
  }
  return bindings;
}

/**
 * Detect PER-VARIANT CMS style bindings: a style prop whose value is a `variant`/
 * `initialVariant` ternary with CMS-field branches —
 * `backgroundImage: initialVariant === 'variant-1' ? 'none' : `url(${item.image})``.
 * Returns the BASE binding (else branch `item.field` → a styleBinding so the renderer's
 * base path keeps working) + the per-variant branches (field → {field}; literal → {value}
 * for unbind→default). Only fires when at least one branch is a CMS field (else a pure
 * literal ternary stays with conditionalStyles).
 */
function extractVariantStyleBindings(
  attrs: (JSXAttribute | any)[],
  itemVar: string,
): { base: Array<{ styleProp: string; field: string }>; variant: Record<string, Record<string, { field: string } | { value: string }>> } {
  const base: Array<{ styleProp: string; field: string }> = [];
  const variant: Record<string, Record<string, { field: string } | { value: string }>> = {};
  const readVal = (n: any): { field: string } | { value: string } | null => {
    if (!n) return null;
    if (n.type === 'StringLiteral') return { value: n.value };
    if (n.type === 'MemberExpression' && !n.computed && n.object?.type === 'Identifier' && n.object.name === itemVar && n.property?.type === 'Identifier') return { field: n.property.name };
    if (n.type === 'TemplateLiteral' && n.expressions.length === 1) {
      const e = n.expressions[0];
      if (e.type === 'MemberExpression' && !e.computed && e.object?.type === 'Identifier' && e.object.name === itemVar && e.property?.type === 'Identifier') return { field: e.property.name };
    }
    return null;
  };
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute' || attr.name?.name !== 'style') continue;
    if (attr.value?.type !== 'JSXExpressionContainer' || attr.value.expression.type !== 'ObjectExpression') continue;
    for (const prop of attr.value.expression.properties) {
      if (prop.type !== 'ObjectProperty' || prop.value.type !== 'ConditionalExpression') continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : null;
      if (!key) continue;
      const branches: Record<string, { field: string } | { value: string }> = {};
      let hasField = false;
      let cursor: any = prop.value;
      let sawBranch = false;
      let bail = false;
      while (cursor?.type === 'ConditionalExpression'
        && cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '==='
        && cursor.test.left?.type === 'Identifier'
        && (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant')
        && cursor.test.right?.type === 'StringLiteral') {
        const v = readVal(cursor.consequent);
        if (v === null) { bail = true; break; } // non-CMS/literal branch → not ours
        if ('field' in v) hasField = true;
        if (cursor.test.right.value !== 'desktop') branches[cursor.test.right.value] = v;
        sawBranch = true;
        cursor = cursor.alternate;
      }
      if (bail || !sawBranch) continue;
      const baseVal = readVal(cursor);
      if (baseVal === null) continue;
      if ('field' in baseVal) hasField = true;
      if (!hasField) continue; // pure-literal ternary → conditionalStyles owns it
      if ('field' in baseVal) base.push({ styleProp: key, field: baseVal.field });
      for (const [vk, vv] of Object.entries(branches)) {
        if (!variant[vk]) variant[vk] = {};
        variant[vk][key] = vv;
      }
    }
  }
  return { base, variant };
}

/** Detect item.field references in component props: prop={item.field} */
function extractPropBindings(attrs: (JSXAttribute | any)[], itemVar: string): Array<{ prop: string; field: string; urlWrap?: boolean }> {
  const bindings: Array<{ prop: string; field: string; urlWrap?: boolean }> = [];
  const skipAttrs = new Set(['data-id', 'data-name', 'style', 'className', 'key', 'ref']);
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute' || !attr.name || attr.name.type !== 'JSXIdentifier') continue;
    const propName = attr.name.name as string;
    if (skipAttrs.has(propName) || propName.startsWith('data-')) continue;
    if (attr.value?.type !== 'JSXExpressionContainer') continue;
    const expr = attr.value.expression;
    // Detect item.fieldName
    if (expr.type === 'MemberExpression'
        && expr.object.type === 'Identifier'
        && (expr.object as any).name === itemVar
        && expr.property.type === 'Identifier') {
      bindings.push({ prop: propName, field: (expr.property as any).name });
      continue;
    }
    // WHOLE-VALUE image binding: prop={`url(${item.field})`} — a Make Component /
    // panel-bind on an image prop whose master uses the bare `backgroundImage: prop`
    // convention (image values carry the url() wrap; the CMS field holds a plain URL,
    // so the instance wraps at the binding site). Mirrors the master-side `urlvar:`
    // detection in extractStyles. Recorded with `urlWrap` so consumers that pass the
    // RAW field value to the prop (CodeComponentHost ghosts) re-apply the wrap.
    if (expr.type === 'TemplateLiteral'
        && expr.expressions?.length === 1
        && expr.expressions[0]?.type === 'MemberExpression'
        && (expr.expressions[0] as any).object?.type === 'Identifier'
        && (expr.expressions[0] as any).object.name === itemVar
        && (expr.expressions[0] as any).property?.type === 'Identifier'
        && String(expr.quasis?.[0]?.value?.raw ?? '').trimStart().toLowerCase().startsWith('url(')
        && String(expr.quasis?.[1]?.value?.raw ?? '').trimEnd() === ')') {
      bindings.push({ prop: propName, field: (expr.expressions[0] as any).property.name, urlWrap: true });
      trace.action('parser:prop-binding-urlwrap', { prop: propName, field: (expr.expressions[0] as any).property.name });
    }
  }
  return bindings;
}

function extractStyles(attrs: (JSXAttribute | any)[], ctx: ParseCtx): { styles: Record<string, string>; conditionalStyles: Record<string, Record<string, string>> | null } {
  const styles: Record<string, string> = {};
  let conditionalStyles: Record<string, Record<string, string>> | null = null;

  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute' || attr.name?.name !== 'style') continue;
    if (attr.value?.type !== 'JSXExpressionContainer') continue;

    const expr = (attr.value as JSXExpressionContainer).expression;
    if (expr.type !== 'ObjectExpression') continue;

    for (const prop of (expr as ObjectExpression).properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const oprop = prop as ObjectProperty;
      const key = oprop.key.type === 'Identifier' ? oprop.key.name :
                  oprop.key.type === 'StringLiteral' ? oprop.key.value : null;
      if (!key) continue;

      let value: string = '';
      if (oprop.value.type === 'StringLiteral') value = (oprop.value as StringLiteral).value;
      else if (oprop.value.type === 'NumericLiteral') value = String((oprop.value as NumericLiteral).value);
      // Negative numeric (e.g. `rotate: -27.7`) parses as a UnaryExpression
      // over a NumericLiteral — without this the inline motion prop is dropped
      // and the canvas can't resolve the rotation/translate.
      else if (oprop.value.type === 'UnaryExpression' && (oprop.value as any).operator === '-'
        && (oprop.value as any).argument?.type === 'NumericLiteral') {
        value = String(-(oprop.value as any).argument.value);
      }
      // Detect prop references: backgroundColor: bgColor → "var:bgColor"
      else if (oprop.value.type === 'Identifier') value = `var:${(oprop.value as any).name}`;
      // Detect a URL-WRAPPED prop ref: `backgroundImage: `url(${image})`` → "urlvar:image".
      // (A component master wraps an image PROP in url(); the bare-identifier case
      // above doesn't see it. `item.field` map refs are a MemberExpression, not a
      // bare Identifier, so they don't match here — those stay styleBindings.) The
      // resolve pass turns this into `url(<default>)` AND records styleVariables so
      // expandComponent propagates the per-row binding (ghost re-wraps via
      // formatBoundStyleValue). Renders identically in the editor AND on deploy.
      else if (oprop.value.type === 'TemplateLiteral'
        && (oprop.value as any).expressions?.length === 1
        && (oprop.value as any).expressions[0]?.type === 'Identifier'
        && String((oprop.value as any).quasis?.[0]?.value?.raw ?? '').trimStart().toLowerCase().startsWith('url(')) {
        value = `urlvar:${(oprop.value as any).expressions[0].name}`;
      }
      // Detect token references: backgroundColor: colors.primary → "token:colors.primary"
      else if (oprop.value.type === 'MemberExpression') {
        const obj = (oprop.value as any).object;
        const prop = (oprop.value as any).property;
        if (obj?.type === 'Identifier' && prop?.type === 'Identifier') {
          value = `token:${obj.name}.${prop.name}`;
        } else continue;
      }
      // Detect ternary: variant === 'variant-1' ? 1 : 0
      // Extracts { 'variant-1': '1', default: '0' } for the Renderer to resolve per viewport
      else if (oprop.value.type === 'ConditionalExpression') {
        const cond = oprop.value as any;
        // Boolean→visibility binding: `hideVar ? 'none' : ''`
        // Pattern: Identifier ? StringLiteral : StringLiteral. We encode it
        // with a `condvar:` prefix so the resolve pass can look up the
        // boolean variable's default and pick the right branch — same role
        // `var:` plays for direct identifier bindings, but with both arms
        // of the ternary preserved.
        if (
          cond.test?.type === 'Identifier' &&
          cond.consequent?.type === 'StringLiteral' &&
          cond.alternate?.type === 'StringLiteral'
        ) {
          const condVarName = cond.test.name;
          const consequent = cond.consequent.value;
          const alternate = cond.alternate.value;
          // Format: condvar:<name>:<consequent>:<alternate>
          // ':' is unambiguous because display/visibility values never
          // contain it (none / hidden / visible / '' / etc.).
          value = `condvar:${condVarName}:${consequent}:${alternate}`;
        }
        // Check pattern: variant === 'xxx' ? val : fallback
        // Accepts both `variant` (useState-driven, used when connections are
        // wired) and `initialVariant` (the parent's variant prop, used by
        // the per-parent-variant style writer for component instances).
        else if (cond.test?.type === 'BinaryExpression' && cond.test.operator === '===' &&
            cond.test.left?.type === 'Identifier' &&
            (cond.test.left.name === 'variant' || cond.test.left.name === 'initialVariant') &&
            cond.test.right?.type === 'StringLiteral') {
          // Walk the full chain so a 3+ way ternary surfaces all variant branches:
          //   variant === 'v1' ? 'a' : variant === 'v2' ? 'b' : 'c'
          //     → { v1: 'a', v2: 'b', default: 'c' }
          const branchMap: Record<string, string> = {};
          let cursor: any = cond;
          let valid = true;
          while (cursor?.type === 'ConditionalExpression') {
            const cTest = cursor.test;
            if (cTest?.type !== 'BinaryExpression' || cTest.operator !== '===' ||
                cTest.left?.type !== 'Identifier' ||
                (cTest.left.name !== 'variant' && cTest.left.name !== 'initialVariant') ||
                cTest.right?.type !== 'StringLiteral') {
              valid = false; break;
            }
            const branchName = cTest.right.value;
            const cons = cursor.consequent;
            // An Identifier branch is a component PROP applied on THIS variant — a per-variant
            // variable binding (`… ? X : 'none'`). Mark it `var:X`; the post-resolve pass swaps in
            // the prop's default for the canvas AND records it in `conditionalStyleVariables`.
            // A negative number (e.g. `rotate: … ? -203.1 : 0`) is a
            // UnaryExpression('-', NumericLiteral), not a NumericLiteral — handle
            // it so per-variant motion props (rotate/x/y/skew) extract correctly.
            const isNegNum = cons?.type === 'UnaryExpression' && cons.operator === '-' && cons.argument?.type === 'NumericLiteral';
            const branchVal = cons?.type === 'NumericLiteral' ? String(cons.value)
                              : cons?.type === 'StringLiteral' ? cons.value
                              : isNegNum ? String(-cons.argument.value)
                              : cons?.type === 'Identifier' ? `var:${cons.name}` : null;
            if (branchVal === null) { valid = false; break; }
            branchMap[branchName] = branchVal;
            cursor = cursor.alternate;
          }
          if (!valid) continue;
          // Final fallback is the BASE (primary/'default' variant) branch — a literal, a negative
          // number, OR an IDENTIFIER (the base VARIABLE binding, e.g. `? variantVar : baseVar`). The
          // identifier case is marked `var:Name`; the resolve pass routes it to `styleVariables`.
          let fallback: string | null = null;
          if (cursor?.type === 'NumericLiteral') fallback = String(cursor.value);
          else if (cursor?.type === 'StringLiteral') fallback = cursor.value;
          else if (cursor?.type === 'UnaryExpression' && cursor.operator === '-' && cursor.argument?.type === 'NumericLiteral') fallback = String(-cursor.argument.value);
          else if (cursor?.type === 'Identifier') fallback = `var:${cursor.name}`;
          if (fallback === null || Object.keys(branchMap).length === 0) continue;
          branchMap['default'] = fallback;
          if (!conditionalStyles) conditionalStyles = {};
          conditionalStyles[key] = branchMap;
          // Use default value as the static style
          value = fallback;
        }
        // Per-VIEWPORT variable binding: `__mq0 ? colorTablet : color1` (identifiers and/or
        // literals, possibly chained). The viewport analog of the per-variant ternary above —
        // mirrors responsive-attrs-gen but for STYLE props. Encode as an `mqvars:` marker
        // (`mqvars:<base>||<w>=<branch>||…`, each branch `var:Name` or a literal); the resolve
        // pass below has `propDefaults` + `gateWidthMap` and turns it into
        // responsiveStyleVariables / responsiveStyleValues + the resolved base binding.
        else if (cond.test?.type === 'Identifier' && /^__mq/.test((cond.test as any).name)) {
          const segs: string[] = [];
          let cursor: any = cond;
          let ok = true;
          while (cursor?.type === 'ConditionalExpression') {
            const t = cursor.test;
            if (t?.type !== 'Identifier' || !/^__mq/.test(t.name)) { ok = false; break; }
            const w = ctx.gateWidthMap[t.name];
            // The gate's min-width = this viewport's exclusive BAND floor (a Tablet override gated on
            // `(max-width:768) and (min-width:376)` must NOT paint Mobile). 0 for a bare max-width.
            const mn = /min-width:\s*([\d.]+)px/.exec(ctx.gateQueryMap[t.name] ?? '');
            const minW = mn ? parseInt(mn[1], 10) : 0;
            const c = cursor.consequent;
            const cm = c?.type === 'Identifier' ? `var:${c.name}`
              : c?.type === 'StringLiteral' ? c.value
              : c?.type === 'NumericLiteral' ? String(c.value) : null;
            if (cm === null || w == null) { ok = false; break; }
            segs.push(`${w}~${minW}=${cm}`);
            cursor = cursor.alternate;
          }
          if (!ok) continue;
          const bm = cursor?.type === 'Identifier' ? `var:${(cursor as any).name}`
            : cursor?.type === 'StringLiteral' ? (cursor as any).value
            : cursor?.type === 'NumericLiteral' ? String((cursor as any).value) : null;
          if (bm === null) continue;
          value = `mqvars:${bm}` + segs.map((s) => `||${s}`).join('');
        }
        else continue;
      }
      else continue;

      styles[key] = value;
    }
  }

  return { styles, conditionalStyles };
}

/**
 * Walk a JSX expression of the form
 *   `initialVariant === 'X' ? 'A' : 'B'`
 *   `variant === 'X' ? 'A' : variant === 'Y' ? 'B' : 'C'`
 * into a per-parent-variant map: { X: 'A', default: 'B' }.
 *
 * Used by the component-instance attr extractor so per-parent-variant prop
 * overrides survive into the canvas representation. Returns null when the
 * shape doesn't match (e.g. boolean test, non-variant identifier).
 */
/** General per-variant TEXT ternary walker. Each branch (and the fallback) may be a string LITERAL or an
 *  IDENTIFIER (a text variable). Returns the literal branches + the per-variant variable branches keyed by
 *  variant name (`default` = the trailing fallback). Handles every per-variant text shape:
 *    `{v === 'a' ? 'x' : 'y'}`            → literals {a:'x', default:'y'}
 *    `{v === 'a' ? 'x' : content}`         → literals {a:'x'},  vars {default:'content'}   (detach)
 *    `{v === 'a' ? content : 'y'}`         → literals {default:'y'}, vars {a:'content'}     (bind on variant)
 *  null when it isn't a variant ternary. */
function walkVariantTextGeneral(expr: any): { literals: Record<string, string>; vars: Record<string, string> } | null {
  const literals: Record<string, string> = {};
  const vars: Record<string, string> = {};
  let cursor: any = expr;
  let sawBranch = false;
  while (cursor?.type === 'ConditionalExpression') {
    const test = cursor.test;
    if (
      test?.type !== 'BinaryExpression' || test.operator !== '===' ||
      test.left?.type !== 'Identifier' ||
      (test.left.name !== 'initialVariant' && test.left.name !== 'variant') ||
      test.right?.type !== 'StringLiteral'
    ) return null;
    const key = test.right.value;
    if (cursor.consequent?.type === 'StringLiteral') literals[key] = cursor.consequent.value;
    else if (cursor.consequent?.type === 'Identifier') vars[key] = cursor.consequent.name;
    else return null;
    sawBranch = true;
    cursor = cursor.alternate;
  }
  if (cursor?.type === 'StringLiteral') literals['default'] = cursor.value;
  else if (cursor?.type === 'Identifier') vars['default'] = cursor.name;
  else return null;
  if (!sawBranch) return null;
  return { literals, vars };
}

/**
 * Per-VARIANT CMS text binding: `{initialVariant === 'variant-1' ? item.title : item.role}`.
 * Branches are `itemVar.field` member-expressions (CMS field) or string literals
 * (unbind→default). Returns the per-variant branches + the else/base branch, but ONLY
 * when at least one branch references `itemVar.field` (so a pure literal/variable ternary
 * still falls through to walkVariantTextGeneral). `null` otherwise.
 */
function walkVariantCmsText(
  expr: any,
  itemVar: string,
): { branches: Record<string, { field: string } | { value: string }>; base: { field: string } | { value: string } | null; hasField: boolean } | null {
  const branches: Record<string, { field: string } | { value: string }> = {};
  let hasField = false;
  const read = (n: any): { field: string } | { value: string } | null => {
    if (!n) return null;
    if (n.type === 'StringLiteral') return { value: n.value };
    if (n.type === 'MemberExpression' && !n.computed
      && n.object?.type === 'Identifier' && n.object.name === itemVar
      && n.property?.type === 'Identifier') { hasField = true; return { field: n.property.name }; }
    return null; // identifier (prop var) / other → not a CMS conditional
  };
  let cursor: any = expr;
  let sawBranch = false;
  while (cursor?.type === 'ConditionalExpression'
    && cursor.test?.type === 'BinaryExpression' && cursor.test.operator === '==='
    && cursor.test.left?.type === 'Identifier'
    && (cursor.test.left.name === 'initialVariant' || cursor.test.left.name === 'variant')
    && cursor.test.right?.type === 'StringLiteral') {
    const b = read(cursor.consequent);
    if (b === null) return null; // a non-CMS/non-literal branch → not ours
    if (cursor.test.right.value !== 'desktop') branches[cursor.test.right.value] = b;
    sawBranch = true;
    cursor = cursor.alternate;
  }
  if (!sawBranch) return null;
  const base = read(cursor);
  if (base === null) return null; // base must be a field or literal
  return hasField ? { branches, base, hasField } : null;
}

function walkVariantConditionalProp(expr: any, varDefaults?: Record<string, string>): { map: Record<string, string>; varRefs: Record<string, string> } | null {
  const map: Record<string, string> = {};
  const varRefs: Record<string, string> = {};
  let cursor: any = expr;

  // A branch is either a StringLiteral variant name, or a VARIABLE (Identifier) — the per-variant hoist
  // (`variant === 'v6' ? someVar : base`). Record a variable branch in `varRefs` (so a page-level instance
  // can OVERRIDE it via its own prop), and resolve it to the variable's default variant for the master-canvas
  // static render. Unknown identifier (no default) → null (caller drops the conditional gracefully).
  const resolveBranch = (node: any, key: string): string | null => {
    if (node?.type === 'StringLiteral') return node.value;
    // RAW literal branches — a per-variant CODE-COMPONENT prop (number
    // slider, toggle) writes `prop={initialVariant === 'Hover' ? 18 : 14}`;
    // quoted strings would poison toggles ("false" is truthy at runtime).
    if (node?.type === 'NumericLiteral') return String(node.value);
    if (node?.type === 'BooleanLiteral') return String(node.value);
    if (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'NumericLiteral') {
      return `-${node.argument.value}`;
    }
    if (node?.type === 'Identifier') {
      varRefs[key] = node.name;
      if (varDefaults && varDefaults[node.name] != null) return varDefaults[node.name].replace(/^["'](.*)["']$/s, '$1');
    }
    return null;
  };

  while (cursor?.type === 'ConditionalExpression') {
    const test = cursor.test;
    if (
      test?.type !== 'BinaryExpression' ||
      test.operator !== '===' ||
      test.left?.type !== 'Identifier' ||
      (test.left.name !== 'initialVariant' && test.left.name !== 'variant') ||
      test.right?.type !== 'StringLiteral'
    ) return null;

    const val = resolveBranch(cursor.consequent, test.right.value);
    if (val == null) return null;
    map[test.right.value] = val;
    cursor = cursor.alternate;
  }

  // Final fallback: a string literal OR a variable (resolved) — the `default` branch
  const fallback = resolveBranch(cursor, 'default');
  if (fallback == null) return null;
  map['default'] = fallback;

  return Object.keys(map).length > 0 ? { map, varRefs } : null;
}
