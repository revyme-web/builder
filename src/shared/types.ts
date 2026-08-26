// shared/types.ts — Core type definitions.
// NOTE: CanvasNode lives in code/parser.ts (the real, active definition).
// NodeMap is re-exported here using parser's CanvasNode for compatibility.

import type { CanvasNode } from '@/code/parsing/parser';

// ─── Node Map ─────────────────────────────────────────────────────────────

export type NodeMap = Map<string, CanvasNode>;

// ─── Canvas ────────────────────────────────────────────────────────────────

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Screen-space corner quad of a (possibly rotated/skewed) element.
 *  Produced by geometry-utils' corner readers; lives here (leaf) so
 *  node-ops and others can type against it without import cycles. */
export interface ScreenCorners {
  TL: Point;  // top-left
  TR: Point;  // top-right
  BR: Point;  // bottom-right
  BL: Point;  // bottom-left
}

export interface Point {
  x: number;
  y: number;
}

// ─── Drag ──────────────────────────────────────────────────────────────────

export interface DraggedNode {
  id: string;
  startLeft: number;
  startTop: number;
  mouseOffsetX: number;
  mouseOffsetY: number;
  width: number;
  height: number;
  startParentId: string | null;
  /** Optional transform override carried through strategy switches. Set by
   *  exiting strategies that mutated the source `transform` (e.g.
   *  stripped a `translate(...)`). The receiving strategy seeds its
   *  `originalTransforms` with this so per-frame writes don't re-compose
   *  with the stale source value (`context.nodes` may not have re-parsed
   *  the commit yet at switch time). */
  transformOverride?: string;
  /** The parent the GESTURE originally lifted this node out of — carried
   *  through mid-drag exit handoffs so the receiving strategy can treat a
   *  return to that parent (any viewport tile — data-ids match across
   *  replicas) differently from entering a foreign frame: the back-to-parent
   *  placeholder shows only there (2026-08-26). Never mutated by later
   *  entries/exits within the same gesture. */
  exitSourceParentId?: string | null;
}

export interface PendingUpdate {
  nodeId: string;
  type: 'style' | 'move' | 'reorder' | 'add' | 'remove' | 'updateContainerStyle' | 'updateVariantStyle' | 'setVariantVisibility' | 'setConditionalOrder' | 'setConditionalStyle' | 'clearContainerStyles' | 'updateStyles' | 'duplicateCollectionToCanvas';
  styles?: Record<string, string>;
  newParentId?: string | null;
  newIndex?: number;
  /** For move: id of the VISIBLE sibling the node must be spliced BEFORE in
   *  the JSX. `newIndex` is a VISUAL-space index; splicing it positionally
   *  breaks whenever JSX order diverges from visual order (CSS `order`
   *  reorders, template-injected `<style>` children, siblings missing from
   *  the rect walk). The anchor id is immune to every index-space mismatch.
   *  Generators use it first and fall back to `newIndex`. */
  insertBeforeId?: string;
  descriptor?: NewNodeDescriptor;
  maxWidth?: number;
  variantName?: string;
  orderMap?: Record<string, number>;
  /** For setConditionalStyle — the layout prop + its value for `variantName`. */
  prop?: string;
  value?: string;
  /** When moving to root: true = mark as canvas node (hoisted), false = keep in viewport hierarchy */
  canvasNode?: boolean;
  /** For setVariantVisibility — see mutation-queue.ts. */
  hiddenVariants?: string[];
  allVariants?: string[];
  /** For duplicateCollectionToCanvas — the collection-list `source` slug (CMS) /
   *  inline prefix the dragged `.map()` repeater binds to. */
  cmsSource?: string;
  /** For duplicateCollectionToCanvas — the unique id-rename suffix applied to the
   *  cloned container + every descendant data-id (e.g. `-cabc123`). */
  cloneSuffix?: string;
}

export interface NewNodeDescriptor {
  tag: string;
  id?: string;
  name?: string;
  styles: Record<string, string>;
  attrs?: Record<string, string>;
  textContent?: string;
  children?: NewNodeDescriptor[];
  /** When set, after this descriptor is added the canvas queues a
   *  bindToCmsCollection mutation against the FIRST CHILD's id, turning
   *  the first child into a `.map()` template over the named collection.
   *  Used by the Insert panel's CMS section — drag a collection and the
   *  drop creates a stack with a placeholder Item already wired up. */
  cmsCollectionSlug?: string;
}

// ─── Snap ──────────────────────────────────────────────────────────────────

export interface SnapGuide {
  axis: 'x' | 'y';
  position: number;
  type: 'edge' | 'center';
  referenceId: string;
}

export interface SnapResult {
  x: number;
  y: number;
  snappedX: boolean;
  snappedY: boolean;
  guides: SnapGuide[];
  spacingGuides: SpacingGuide[];
}

export interface SpacingGuide {
  axis: 'h' | 'v';
  distance: number;
  segments: SpacingSegment[];
}

export interface SpacingSegment {
  start: number;
  end: number;
  crossMin: number;
  crossMax: number;
}

// ─── Resize ────────────────────────────────────────────────────────────────

type ResizeHandle =
  | 'n' | 's' | 'e' | 'w'
  | 'ne' | 'nw' | 'se' | 'sw';

// ─── Viewport ──────────────────────────────────────────────────────────────

export interface ViewportConfig {
  id: string;
  label: string;
  width: number;
  /** Viewport height. Either a fixed pixel number (e.g. `900`) or the
   *  string `'auto'` when the viewport is content-driven. Stored
   *  explicitly even in the auto case so the @canvas block round-trips
   *  the user's choice — the alternative (omitting the field) made
   *  "Height = auto" indistinguishable from "Height never set" and
   *  prevented the SizeTool from writing the matching `height: 'auto'`
   *  back onto the root div's JSX style. `undefined` is still accepted
   *  on the read path for backward compat with older projects. */
  height?: number | 'auto';
  isPrimary: boolean;
  order: number;
  x: number;
  y: number;
}

// ─── Overlay ───────────────────────────────────────────────────────────────

// ─── Locale ────────────────────────────────────────────────────────────────

export interface Locale {
  code: string;
  name: string;
  flag?: string;
  isDefault: boolean;
  fallback?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────

// ─── History ───────────────────────────────────────────────────────────────

// ─── Drop ──────────────────────────────────────────────────────────────────

export interface DropTarget {
  parentId: string;
  index: number;
  position: 'before' | 'after' | 'inside';
}

// ─── Distance Indicators ───────────────────────────────────────────────────

// ─── CMS Collections ────────────────────────────────────────────────────────

export interface CollectionSchema {
  name: string;
  slug: string;
  fields: FieldDefinition[];
  layouts?: LayoutDefinition[];
}

interface LayoutDefinition {
  id: string;
  name: string;
}

export interface FieldDefinition {
  id: string;
  name: string;
  type: 'text' | 'textarea' | 'richtext' | 'number' | 'boolean' | 'date'
      | 'image' | 'file' | 'link' | 'url' | 'color' | 'enum' | 'tags' | 'slug'
      | 'reference' | 'multi-reference';
  required?: boolean;
  translatable?: boolean;
  description?: string;      // optional help text for the item editor
  options?: string[];        // for enum/select type
  referenceCollection?: string;
  defaultValue?: any;
  source?: string;           // for slug: auto-generate from this field
  min?: number;              // number: min value; multi-reference: min count
  max?: number;              // number: max value; multi-reference: max count
  step?: number;             // number: increment step
  maxLength?: number;        // text/textarea/richtext: character limit
}

export interface CollectionItem {
  _id: string;
  _slug: string;
  _status: 'published' | 'draft';
  _layout?: string;
  _publishAt?: string;
  _createdAt: string;
  _updatedAt: string;
  [fieldId: string]: any;
}

export interface FilterConfig {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains'
          | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'not_in' | 'exists' | 'between';
  /** Static value. For `between` it's a `[min, max]` tuple. */
  value: any;
  /** Dynamic value source (Phase 4 — search field / date picker bound to a page
   *  variable). When set (not 'static'), the predicate reads `valueVar` at runtime
   *  instead of the literal `value`. */
  valueSource?: 'static' | 'searchField' | 'dateField';
  /** Page-variable name driving a dynamic filter (when valueSource !== 'static'). */
  valueVar?: string;
}

export interface FilterGroup {
  combinator: 'and' | 'or';
  filters: FilterConfig[];
}

export interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
}

/** Pagination config for a collection list. `loadMore` = a button reveals the next
 *  page; `infinite` = an IntersectionObserver sentinel reveals on scroll. Both ride a
 *  `visibleCount` useState in the page source (deploy-correct plain React). */
export interface PaginationConfig {
  mode: 'loadMore' | 'infinite';
  perPage: number;
  /** The useState var holding how many items are currently shown. */
  stateVar: string;
}

// ─── Localization / i18n ────────────────────────────────────────────────────

export interface I18nConfig {
  defaultLocale: string;
  locales: LocaleConfig[];
}

export interface LocaleConfig {
  code: string;
  label: string;
  direction?: 'ltr' | 'rtl';
  fallback?: string;
}

export interface NodeOverride {
  /** Primary-viewport (desktop) localized text. Mirrors `node.textContent`'s
   *  role for the responsive system: if `textOverrides[<vpWidth>]` is missing
   *  for the current viewport bucket, the renderer falls back to this. */
  text?: string;
  /** RICH-TEXT nodes only: the node's inner JSX with every `{t('key')}` run
   *  substituted with the locale-resolved message text. The renderer's
   *  innerHTML path renders THIS instead of the raw `node.textContent` so
   *  translated runs paint inside their styled spans (never `el.textContent`
   *  — that would flatten the spans). */
  innerJsx?: string;
  /** Per-viewport localized text, keyed by viewport width as a string
   *  (e.g. `{ "768": "Tablet text", "375": "Mobile text" }`). Mirrors the
   *  shape of `node.textOverrides` (the `useResponsiveText` map) so the
   *  renderer can apply identical bucket logic — current width → smallest
   *  configured viewport >= width → look up bucket. Lets users localize
   *  per breakpoint independently. */
  textOverrides?: Record<string, string>;
  styles?: Record<string, string>;
  props?: Record<string, any>;
  visible?: boolean;
}

// ─── Design Presets (CSS Custom Properties) ─────────────────────────────────

export interface PresetToken {
  /** Variable name without -- prefix (e.g. 'brand-color', 'heading-size') */
  name: string;
  /** Current value (e.g. '#6366f1', '48px') */
  value: string;
  /** Display category */
  category: 'color' | 'typography' | 'spacing' | 'margin' | 'radius' | 'shadow' | 'border' | 'image' | 'video' | 'other';
  /** Optional display label */
  label?: string;
}

// ─── Overlay Types ───────────────────────────────────────────────────────

/** Config stored on the overlay node (data-overlay attribute) */
export interface OverlayConfig {
  type: 'relative' | 'fixed';
  triggerId: string;
  side: 'top' | 'right' | 'bottom' | 'left';
  align: 'start' | 'center' | 'end';
  offsetX: number;
  offsetY: number;
  /** Viewport-edge collision handling: 'auto' clamps the overlay into the
   *  viewport with `collisionPadding` px of breathing room; 'none' positions
   *  purely from side/align/offset. Default 'auto'. */
  collision?: 'auto' | 'none';
  /** Min distance (px) kept from viewport edges when collision is 'auto'. Default 20. */
  collisionPadding?: number;
  /** Per-viewport overrides keyed by replica breakpoint WIDTH (e.g. "768").
   *  Mirrors the @media responsive model: the base fields are the PRIMARY
   *  (desktop) config; each key is a replica breakpoint; resolution cascades
   *  smallest-matching-key-wins (see `resolveOverlayConfigForWidth`). Only the
   *  position-ish fields are overridable per viewport — `type`/`triggerId` are
   *  shared. */
  responsive?: Record<string, OverlayConfigOverride>;
  /** Sorted list of ALL viewport breakpoint widths (incl. primary) at the time
   *  an override was last written. Lets resolution map a width to its OWNING
   *  viewport so a viewport with no override falls back to BASE — never to a
   *  larger replica's override. Mirrors the variant system's `_bp`. */
  responsiveBp?: number[];
  /** Per-VARIANT overrides keyed by variant NAME (design-component analog of
   *  `responsive`: variants are the replica analog of page viewports, but keyed
   *  by name not width). The default variant uses the base fields; each key is a
   *  non-default variant. Exact-keyed (no breakpoint cascade). Resolved by
   *  `resolveOverlayConfig` BEFORE the width path. */
  responsiveVariant?: Record<string, OverlayConfigOverride>;

  // ─── FIXED-overlay (modal/dialog) fields — ignored for relative ───────────
  /** Backdrop fill: any CSS color (hex incl. alpha, rgba, etc.). Default
   *  'rgba(0,0,0,0.5)'. The full-viewport scrim behind the modal content. */
  fill?: string;
  /** Whether pressing the backdrop (outside the content) closes the modal.
   *  Default true. */
  dismissible?: boolean;
  /** Stacking order of the modal layer. Default 100. */
  zIndex?: number;
  /** Page scroll while the modal is open: 'block' locks body scroll (default),
   *  'auto' leaves the page scrollable behind it. */
  pageScroll?: 'auto' | 'block';
  /** Appear ENTER transition (framer-motion transition object as a flat string
   *  map, the shape TransitionPanel reads/writes — type/duration/ease/delay/
   *  stiffness…). Default a tween easeIn. */
  enterTransition?: Record<string, string>;
  /** Appear EXIT transition (same shape). Default a tween easeOut. */
  exitTransition?: Record<string, string>;
  /** When true, Exit transition stays identical to Enter (the lock in the panel).
   *  Default true. */
  easingLinked?: boolean;
  /** Component-instance trigger ONLY: when the overlay opens, switch the source
   *  instance to this variant; on close it reverts to its base variant. Empty/
   *  undefined = no variant switch. */
  onOpenVariant?: string;
}

/** The subset of OverlayConfig fields that can be overridden per viewport (page
 *  replica) AND per design-component variant. `onOpenVariant` is here so a
 *  component-instance overlay can switch the instance to a DIFFERENT variant per
 *  viewport / per outer-component variant. */
export type OverlayConfigOverride = Partial<Pick<OverlayConfig,
  'side' | 'align' | 'offsetX' | 'offsetY' | 'collision' | 'collisionPadding' | 'onOpenVariant'>>;

/** What `updateOverlayConfig` may patch: the per-viewport override fields PLUS
 *  the modal-level base fields (fill/dismissible/zIndex/pageScroll), which are
 *  written to the BASE config only (vpWidth = null), never as a replica override. */
export type OverlayConfigPatch = OverlayConfigOverride &
  Partial<Pick<OverlayConfig, 'fill' | 'dismissible' | 'zIndex' | 'pageScroll' | 'enterTransition' | 'exitTransition' | 'easingLinked' | 'onOpenVariant'>>;

/** Config stored on the trigger node (data-overlay-trigger attribute) */
export interface OverlayTriggerConfig {
  targetId: string;
  /** 'event' = the trigger is a component INSTANCE event (standard component
   *  event); the instance fires `eventName` from inside its master, which opens
   *  the overlay. */
  trigger: 'click' | 'hover' | 'event';
  dismiss: 'outside' | 'click' | 'escape';
  /** When `trigger === 'event'`: which component-instance event prop fires it. */
  eventName?: string;
}

// ─── Locale Types ────────────────────────────────────────────────────────

export interface LocaleOverrides {
  pages: {
    [filePath: string]: {
      [nodeId: string]: NodeOverride;
    };
  };
  collections: {
    [collectionSlug: string]: {
      [itemId: string]: {
        [fieldId: string]: any;
      };
    };
  };
}
