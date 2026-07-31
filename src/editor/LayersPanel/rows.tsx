// LayersPanel/rows.tsx — FlatLayer type, row icons, LayerRow + RenameInput, and the
// row-adjacent pure helpers (display/order cascade resolvers + selection sets) —
// lifted verbatim from LayersPanel.tsx (Phase 7 god-file split, item 7.7).

import React, { useState, useRef, useEffect } from 'react';
import type { CanvasNode } from '@/code/parsing/parser';
import { isFrameTag, isTextTag } from '@/shared/constants';
import { useIsViewer } from '@/code/stores/viewer-mode-store';
import { isVectorSetComponentFile } from '@/code/project/active-file-store';
import { DesktopViewportIcon, TabletViewportIcon, MobileViewportIcon, ComponentClusterIcon, CmsIcon, CmsItemIcon } from '@/shared/icons';
import { IconSetIcon } from '@/editor/left-toolbar/panels/LibraryPanel/items/IconSetRow';
import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FlatLayer {
  /** Unique key for this row (viewport-prefixed for node rows: "desktop:features") */
  id: string;
  /** The real node ID (without viewport prefix). Null for viewport header rows. */
  nodeId: string | null;
  node: CanvasNode;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  /** Which viewport this row belongs to */
  viewportId?: string;
  viewportLabel?: string;
  viewportWidth?: number;
  /** True for variant headers in component mode (uses component icon instead of viewport icon) */
  isVariantHeader?: boolean;
  /** This node is a collection-list CONTAINER (`.map()` over a CMS collection)
   *  → stacked CMS icon, like the left menu. */
  isCmsContainer?: boolean;
  /** This node is the collection-list TEMPLATE ROW (the `.map()` body root, the
   *  one record) → single-cylinder CMS item icon. NOT its descendants. */
  isCmsItem?: boolean;
}

// ─── Frame Icon (matches old builder) ─────────────────────────────────────

const FrameIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4" y="4" width="16" height="16" rx="2" fill="#bababa" />
  </svg>
);

const ComponentIcon = ComponentClusterIcon;

// ─── Overlay Icon ──────────────────────────────────────────────────────────
// A panel floating OVER a base panel — the layer glyph for overlay nodes
// (fixed/relative), replacing the generic frame square so overlays read at a
// glance in the tree. Neutral #bababa to match FrameIcon.
const OverlayIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* base panel (behind) */}
    <rect x="3.25" y="3.25" width="13" height="13" rx="3" stroke="#bababa" strokeWidth="2" fill="none" />
    {/* overlay panel (in front, offset down-right) */}
    <rect x="9" y="9" width="11.75" height="11.75" rx="3" fill="#bababa" />
  </svg>
);

// ─── Text Icon ───────────────────────────────────────────────────────────────
// A "T" glyph for text nodes (p / h1-6 / span / a / …) so they read as text in
// the tree instead of falling through to the generic frame square. Neutral
// #bababa to match FrameIcon.
const TextIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 6.5h12M12 6.5v11" stroke="#bababa" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

/** Walk up `parentId` from `nodeId` to see if it sits inside `overlayId`'s
 *  subtree (the overlay node itself counts). Used to keep overlay-edit mode
 *  active while the user selects a CHILD of the edited overlay, and exit it
 *  when they click somewhere outside. */
export function isNodeUnderOverlay(nodeId: string, overlayId: string, nodes: Map<string, CanvasNode>): boolean {
  let cur = nodes.get(nodeId);
  let guard = 0;
  while (cur && guard++ < 500) {
    if (cur.id === overlayId) return true;
    if (!cur.parentId) return false;
    cur = nodes.get(cur.parentId);
  }
  return false;
}

/** Pick the viewport device icon by WIDTH, not by a hardcoded id match —
 *  so custom-added viewports (Laptop, iPhone 15 Pro Max, …) get a proper
 *  device icon instead of falling through to the generic frame icon.
 *  < 768 → mobile, < 1024 → tablet, ≥ 1024 → desktop. */
function ViewportIcon({ width, size = 14 }: { width?: number; size?: number }) {
  const w = width ?? 1280;
  if (w < 768) return <MobileViewportIcon size={size} />;
  if (w < 1024) return <TabletViewportIcon size={size} />;
  return <DesktopViewportIcon size={size} />;
}

/** Resolve whether a node is effectively hidden when rendered in the given
 *  viewport / variant. Combines:
 *
 *    1. Base style (`node.styles.display === 'none'`) — hides everywhere.
 *    2. Per-viewport @media override (page replicas) — `containerOverrides`
 *       parsed from the active file's <style> block.
 *    3. Per-variant `motionVariants[variantName].display` (component master).
 *    4. Conditional styles (`node.conditionalStyles.display[variantName]`).
 *
 *  The eye-shut indicator and the toggle handler both rely on this so the
 *  layer for a tablet/mobile replica reflects an `@media (max-width: 768)
 *  { display: none }` rule, and the layer for a non-default variant
 *  reflects a `cardVariants.hover = { display: 'none' }` override.
 */
export function resolveDisplayForLayer(
  node: CanvasNode,
  layerVpId: string | undefined,
  vpConfigs: Array<{ id: string; width: number; isPrimary: boolean }>,
  containerOverrides: Map<string, Map<number, Map<string, string>>>,
  isComponentFile: boolean,
): { isHidden: boolean; source: 'base' | 'override' | 'variant' | 'conditional' } {
  // `hiddenOnVariants` (AnimatePresence) is the primary per-variant visibility
  // signal — if this layer's variant is in it, it's hidden. If NOT in it, fall
  // through to the display cascade (a stale/baked `display:none` from an older
  // component can still hide it). 'desktop'/no-viewport map to 'default'.
  if (node.hiddenOnVariants && node.hiddenOnVariants.size > 0) {
    const variantForLayer = !layerVpId || layerVpId === 'desktop' ? 'default' : layerVpId;
    if (node.hiddenOnVariants.has(variantForLayer)) {
      return { isHidden: true, source: 'variant' };
    }
  }

  const base = node.styles.display ?? '';
  const motionVariants = node.motionVariants as Record<string, Record<string, string>> | null | undefined;

  // Cascade order: base inline style → default-variant override →
  // (per-viewport) variant / conditional / @container override. Each
  // layer can BOTH hide AND un-hide — `variant-2: { display: '' }`
  // means "remove the inline `display: none`, become visible on
  // variant-2". The previous implementation early-returned the
  // moment `base === 'none'`, so variants couldn't un-hide; the eye
  // icon stayed crossed-out on the variant where the node was
  // actually visible AND clicking it wrote `display: 'none'` to the
  // variant override that ALREADY contained the un-hide value, so
  // the toggle was a no-op (it set what was already there).
  //
  // We track BOTH effective display + the highest-priority source
  // that contributed it so the toggle handler can write to the
  // correct layer (variant / override / inline). Cascades from
  // weakest to strongest; later layers overwrite earlier ones.

  let effective = base;
  let source: 'base' | 'override' | 'variant' | 'conditional' = 'base';

  if (!layerVpId) {
    // No viewport context: apply the default-variant override on top of
    // base (e.g. layers-panel preview, primary viewport on a master).
    if (motionVariants?.default && 'display' in motionVariants.default) {
      effective = motionVariants.default.display ?? '';
      source = 'variant';
    }
    return { isHidden: effective === 'none', source };
  }

  const vp = vpConfigs.find(v => v.id === layerVpId);

  // Component-master rendering: framer-motion variants are INDEPENDENT.
  // Variant-1's effective styles are `inline + variant-1`, NOT
  // `inline + default + variant-1`. A property set in `default` but
  // absent from `variant-1` does NOT cascade — the runtime keeps the
  // last-rendered value, which for the initial paint is the inline
  // base. So when resolving a non-primary variant's row, we IGNORE
  // `default` and read `inline + variant-N` only.
  //
  // For the PRIMARY variant row (default), we DO apply the
  // default-variant override on top of base — that's the "default
  // styles for default view" semantic.
  //
  // `vpConfigs` comes from the `@canvas` block parser, which only
  // exists on page files. Component master files declare their
  // variants in `variantConfig` instead — so `vp` is undefined for
  // variant ids like `'variant-1'`. Fall back to the convention that
  // any vpId other than `'desktop'` is a non-primary variant.
  if (isComponentFile && layerVpId !== 'desktop') {
    const variantName = layerVpId;
    const variantStyles = motionVariants?.[variantName];
    if (variantStyles && 'display' in variantStyles) {
      effective = variantStyles.display ?? '';
      source = 'variant';
    } else {
      const conditionalDisplay = node.conditionalStyles?.display?.[variantName];
      if (conditionalDisplay !== undefined) {
        effective = conditionalDisplay;
        source = 'conditional';
      }
      // No display in this variant entry AND a per-variant entry
      // EXISTS for this variant — framer-motion semantics: the
      // element is being driven by the variants animation system, so
      // its display is the variant-1 value (none specified = no
      // change from prior frame, which for canvas's initial render
      // resolves to the variants prop's own iframe-side compute).
      // Mirror what the canvas paints: a non-default variant entry
      // that doesn't override display reads as VISIBLE (not the
      // inline base 'none'), because framer-motion holds the previous
      // animated state and the variants prop being present means the
      // element participates in the variants system. The inline
      // `display: 'none'` baseline only applies on the PRIMARY/default
      // viewport (where the default variant's display is the source
      // of truth).
      else if (variantStyles) {
        effective = '';
        source = 'variant';
      }
    }
  } else if (isComponentFile && layerVpId === 'desktop') {
    // Primary (default) viewport on a component master: apply the
    // default-variant override on top of inline base.
    if (motionVariants?.default && 'display' in motionVariants.default) {
      effective = motionVariants.default.display ?? '';
      source = 'variant';
    }
  } else if (!isComponentFile) {
    // Page files: still apply the default-variant override on every
    // viewport (instances of a component on a page paint through the
    // default variant for the primary viewport too).
    if (motionVariants?.default && 'display' in motionVariants.default) {
      effective = motionVariants.default.display ?? '';
      source = 'variant';
    }
  }

  // Layer 3: page replica `@container` / `@media` override.
  if (!isComponentFile && vp && !vp.isPrimary) {
    const override = containerOverrides.get(node.id)?.get(vp.width)?.get('display');
    if (override !== undefined) {
      effective = override;
      source = 'override';
    }
  }

  return { isHidden: effective === 'none', source };
}

/**
 * Cascade-aware resolution of a node's effective CSS `order` for the layer's
 * viewport context. Mirrors `getEffectiveDisplay`'s cascade order so the
 * Layers tree visual sort matches the canvas paint order byte-for-byte:
 *
 *   base inline `node.styles.order`
 *     → default-variant override (`motionVariants.default.order`)
 *     → variant-specific override (`motionVariants[vp].order`) OR
 *       conditional ternary (`conditionalStyles.order[vp]`)
 *     → page-replica `@container` override (containerOverrides)
 *
 * Returns `null` when the node has no explicit order anywhere in the cascade —
 * the caller (sortChildrenByVisualOrder) uses that to short-circuit the sort
 * when NO sibling carries explicit `order`, preserving JSX order in that
 * common case. Grid-track placement strings (`'1 / 3'`) parse as NaN via
 * parseInt and are treated as `null` for sort purposes — they don't act
 * like flex `order` and can't be sequenced linearly.
 */
function getEffectiveOrder(
  node: CanvasNode,
  layerVpId: string | null,
  vpConfigs: Array<{ id: string; width: number; isPrimary: boolean }>,
  containerOverrides: Map<string, Map<number, Map<string, string>>>,
  isComponentFile: boolean,
): number | null {
  const motionVariants = node.motionVariants as Record<string, Record<string, string>> | null | undefined;
  const conditionalStyles = (node as unknown as { conditionalStyles?: Record<string, Record<string, string | number>> }).conditionalStyles;

  const parse = (val: string | number | undefined | null): number | null => {
    if (val == null || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const n = parseInt(val, 10);
    return Number.isFinite(n) && String(n) === val.trim() ? n : null;
  };

  let effective: number | null = parse(node.styles.order);

  if (!layerVpId) {
    if (motionVariants?.default && 'order' in motionVariants.default) {
      const v = parse(motionVariants.default.order);
      if (v != null) effective = v;
    }
    return effective;
  }

  const vp = vpConfigs.find(v => v.id === layerVpId);

  if (isComponentFile && layerVpId !== 'desktop') {
    const variantName = layerVpId;
    const variantStyles = motionVariants?.[variantName];
    if (variantStyles && 'order' in variantStyles) {
      const v = parse(variantStyles.order);
      if (v != null) effective = v;
    } else {
      const cond = conditionalStyles?.order?.[variantName];
      const v = parse(cond);
      if (v != null) effective = v;
    }
  } else if (isComponentFile && layerVpId === 'desktop') {
    if (motionVariants?.default && 'order' in motionVariants.default) {
      const v = parse(motionVariants.default.order);
      if (v != null) effective = v;
    }
    const condDefault = conditionalStyles?.order?.['default'];
    const v = parse(condDefault);
    if (v != null) effective = v;
  } else if (!isComponentFile) {
    if (motionVariants?.default && 'order' in motionVariants.default) {
      const v = parse(motionVariants.default.order);
      if (v != null) effective = v;
    }
  }

  if (!isComponentFile && vp && !vp.isPrimary) {
    const override = containerOverrides.get(node.id)?.get(vp.width)?.get('order');
    const v = parse(override);
    if (v != null) effective = v;
  }

  return effective;
}

/**
 * Stable-sort a list of child ids by their effective CSS `order` so the
 * Layers panel mirrors the canvas's visual order. Two short-circuits:
 *
 *   1. Parent is not flex/grid → CSS `order` has no effect, return as-is.
 *   2. No child has explicit order → JSX iteration order IS visual order,
 *      return as-is (cheap path for the common case).
 *
 * Tie-break by original JSX index keeps stable order among siblings that
 * share the same numeric order (CSS spec: equal order → source order).
 *
 * Without this sort the tree shows JSX order while the canvas paints in
 * CSS-order order — drag-reorder a flex child in the canvas, the canvas
 * shifts, the tree row doesn't move, user thinks the drop didn't fire.
 */
export function sortChildrenByVisualOrder(
  parent: CanvasNode | null | undefined,
  childIds: readonly string[],
  layerVpId: string | null,
  nodes: Map<string, CanvasNode>,
  vpConfigs: Array<{ id: string; width: number; isPrimary: boolean }>,
  containerOverrides: Map<string, Map<number, Map<string, string>>>,
  isComponentFile: boolean,
): string[] {
  if (!parent || childIds.length < 2) return [...childIds];
  const display = parent.styles?.display || '';
  if (display !== 'flex' && display !== 'inline-flex' && display !== 'grid' && display !== 'inline-grid') {
    return [...childIds];
  }

  let anyExplicit = false;
  const indexed = childIds.map((id, idx) => {
    const child = nodes.get(id);
    if (!child) return { id, order: 0, idx };
    const order = getEffectiveOrder(child, layerVpId, vpConfigs, containerOverrides, isComponentFile);
    if (order != null) anyExplicit = true;
    return { id, order: order ?? 0, idx };
  });
  if (!anyExplicit) return [...childIds];

  indexed.sort((a, b) => a.order !== b.order ? a.order - b.order : a.idx - b.idx);
  return indexed.map(o => o.id);
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

/** Precompute selection-related Sets for all layer rows in O(n). */
export function computeSelectionSets(
  selectedLayerId: string | null,
  layers: FlatLayer[],
  nodes: Map<string, CanvasNode>,
): {
  childOfSelectedSet: Set<string>;
  highlightedChildrenSet: Set<string>;
  lastHighlightedChildSet: Set<string>;
} {
  const childOf = new Set<string>();
  const highlightedChildren = new Set<string>();
  const lastHighlighted = new Set<string>();

  if (!selectedLayerId) return { childOfSelectedSet: childOf, highlightedChildrenSet: highlightedChildren, lastHighlightedChildSet: lastHighlighted };

  // Viewport header selected (e.g., "__vp_desktop") — all children are highlighted
  if (selectedLayerId.startsWith('__vp_')) {
    const vpId = selectedLayerId.replace('__vp_', '');
    // Find all layers in this viewport and mark them as children. Canvas
    // nodes (data-canvas-node="true") are walked with vpId='desktop' for
    // rendering purposes but they're NOT children of any variant/viewport
    // header — they're free-floating. Skip them so selecting the default
    // variant on a component file doesn't paint canvas nodes with the
    // child-of-selected highlight.
    for (const layer of layers) {
      if (layer.viewportId !== vpId) continue;
      if (layer.id === selectedLayerId) continue;
      if (layer.node?.isCanvasNode) continue;
      childOf.add(layer.id);
    }
    // Viewport row has highlighted children if it has any layers
    if (childOf.size > 0) highlightedChildren.add(selectedLayerId);
    // Last highlighted child
    for (let i = layers.length - 1; i >= 0; i--) {
      if (childOf.has(layers[i].id)) { lastHighlighted.add(layers[i].id); break; }
    }
    return { childOfSelectedSet: childOf, highlightedChildrenSet: highlightedChildren, lastHighlightedChildSet: lastHighlighted };
  }

  const colonIdx = selectedLayerId.indexOf(':');
  if (colonIdx === -1) return { childOfSelectedSet: childOf, highlightedChildrenSet: highlightedChildren, lastHighlightedChildSet: lastHighlighted };

  const selVp = selectedLayerId.substring(0, colonIdx);
  const selNodeId = selectedLayerId.substring(colonIdx + 1);

  const selectedNode = nodes.get(selNodeId);
  if (!selectedNode) return { childOfSelectedSet: childOf, highlightedChildrenSet: highlightedChildren, lastHighlightedChildSet: lastHighlighted };

  // `seenDesc` bounds the recursion: a corrupt node map with a parent cycle
  // blew this walk with a stack overflow and crashed the whole LayersPanel
  // (collection-list drag-out, 2026-07-29).
  const seenDesc = new Set<string>([selNodeId]);
  function collectDescendants(nodeId: string) {
    const node = nodes.get(nodeId);
    if (!node) return;
    for (const childId of node.children) {
      if (seenDesc.has(childId)) {
        trace.error('layers:collect-descendants-cycle', { selNodeId, childId });
        continue;
      }
      seenDesc.add(childId);
      const layerId = `${selVp}:${childId}`;
      childOf.add(layerId);
      collectDescendants(childId);
    }
  }
  collectDescendants(selNodeId);

  const layerIdSet = new Set(layers.map(l => l.id));
  if (selectedNode.children.some(childId => layerIdSet.has(`${selVp}:${childId}`))) {
    highlightedChildren.add(selectedLayerId);
  }

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!childOf.has(layer.id)) continue;
    const next = layers[i + 1];
    if (!next || !childOf.has(next.id)) {
      lastHighlighted.add(layer.id);
    }
  }

  return { childOfSelectedSet: childOf, highlightedChildrenSet: highlightedChildren, lastHighlightedChildSet: lastHighlighted };
}

// ─── Layer Row (pure — no useMemo, no layers array) ──────────────────────

export const LayerRow = React.memo(function LayerRow({
  layer, isSelected, isMapTemplate, isChildOfSelected, hasHighlightedChildren, isLastHighlightedChild,
  isDragOver, dropPosition, dropDepth, isDragging, effectiveHidden,
  onSelect, onToggleExpand, onDragStart, onContextMenu, onToggleLock, onToggleVisibility,
  isRenaming, onRenameCommit, onVariantRenameCommit, onDoubleClickLayout, isComponentMode,
}: {
  layer: FlatLayer;
  isSelected: boolean;
  isMapTemplate: boolean;
  isComponentMode: boolean;
  isChildOfSelected: boolean;
  hasHighlightedChildren: boolean;
  isLastHighlightedChild: boolean;
  isDragOver: boolean;
  dropPosition: 'before' | 'after' | 'inside' | null;
  dropDepth: number;
  isDragging: boolean;
  /** Resolved hidden state for THIS row's viewport / variant — `true` when
   *  base styles, an @media replica override, OR a motionVariant entry sets
   *  `display: 'none'` for the layer's viewport. Used to drive the eye-shut
   *  icon AND the toggle direction so clicking on a hidden replica's row
   *  removes the @media/variant override instead of writing it again. */
  effectiveHidden: boolean;
  onSelect: (layerId: string, nodeId: string, e?: React.MouseEvent) => void;
  onToggleExpand: (id: string) => void;
  onDragStart: (e: React.MouseEvent, layerId: string, nodeId: string) => void;
  onContextMenu: (e: React.MouseEvent, nodeId: string | null) => void;
  onToggleLock: (nodeId: string) => void;
  onToggleVisibility: (nodeId: string, layerVpId?: string) => void;
  isRenaming: boolean;
  onRenameCommit: (nodeId: string, newName: string) => void;
  onVariantRenameCommit: (variantVpId: string, newLabel: string) => void;
  onDoubleClickLayout: (node: CanvasNode) => void;
}) {
  const { id, node, depth, hasChildren, isExpanded } = layer;
  // Viewers get single-click select + expand only. Drag-reorder,
  // context menu, double-click navigation, and the lock/visibility
  // toggles are all edit affordances and stay disabled.
  const isViewer = useIsViewer();
  const textRef = useRef<HTMLSpanElement>(null);

  // The layer name ALWAYS truncates to the visible width (graceful ellipsis,
  // never a hard clip at the panel edge) and expands as the tree is scrolled
  // right. Rather than a per-row scroll listener, we measure the text's indent
  // ONCE per layout change and let CSS `calc` do the rest — reading the
  // --layers-sx (scrollLeft) / --layers-vw (visible width) vars the scroll
  // container publishes, so every row's truncation updates on scroll with no
  // JS. `textIndent` is the text's left offset within the scroll CONTENT.
  const [textIndent, setTextIndent] = useState<number | null>(null);
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const scroll = el.closest('[data-layers-scroll]') as HTMLElement | null;
    if (!scroll) return;
    const indent = el.getBoundingClientRect().left - scroll.getBoundingClientRect().left - 8 + scroll.scrollLeft;
    setTextIndent(indent);
  }, [depth, hasChildren, isExpanded, node.name, node.type, layer.viewportWidth, layer.isVariantHeader]);

  // Row classes
  // 'group' + the hover/selection background now live on the row WRAPPER and
  // the separate background layer respectively (see JSX). The content row sits
  // ABOVE that layer via z-[1].
  let rowClass = 'flex items-center gap-2 py-1.5 transition-all duration-150 select-none relative z-[1]';
  if (isDragging) rowClass += ' opacity-40';

  // Background style. 20 px indent step matches the Pages panel — each
  // nested child's CHEVRON column lands directly under its parent's
  // ICON column (standard). Parent row at depth 0 begins at
  // `pl-3 (12 px)`; chevron (~14) + gap (~6) put the parent's icon
  // at ~32 px, which is exactly `20 + 12` — depth-1's `paddingLeft`.
  //
  // Previous values: 24 px crept barely past parent's icon; 40 px
  // shoved children way past parent's text. 20 px sits the alignment
  // the user confirmed against the reference.
  const s: React.CSSProperties = {
    paddingLeft: `${12 + depth * 20}px`,
    paddingRight: '8px',
    cursor: isDragging ? 'grabbing' : 'default',
    width: '100%',
  };

  // A vector — either a plain SVG group (excl. the FIT-text `-svg` wrapper) OR a
  // VECTOR-SET INSTANCE (its componentFile points at icons/
  // or a vectors CDN url) — is NOT a code component. On
  // PAGES it gets the vector (shapes) icon in regular ACCENT, never the purple
  // code treatment. Inside a component master purple wins for EVERY row —
  // vectors and groups included — matching the canvas-side rule "all elements
  // on a master use --accent-secondary" (Rule 8, 00-ai-instructions.md).
  const isContainerSetInstance = isVectorSetComponentFile(node.componentFile);
  const isSvgVector = (node.type === 'svg' && !node.id.endsWith('-svg')) || isContainerSetInstance;
  // Map template nodes use orange, component mode/instances use purple, regular nodes use blue
  const isComponentInstance = !!node.componentFile;
  const usePurple = isComponentMode || (isComponentInstance && !isSvgVector);
  const selColor = isMapTemplate ? 'rgb(249, 115, 22)' : usePurple ? 'var(--accent-secondary)' : 'var(--accent)';
  const selColorFaded = isMapTemplate
    ? 'rgba(249, 115, 22, 0.2)'
    : usePurple
      ? 'color-mix(in srgb, var(--accent-secondary) 20%, transparent)'
      : 'color-mix(in srgb, var(--accent) 20%, transparent)';

  // The selection/child background lives on a SEPARATE, viewport-pinned layer
  // (rendered in the JSX below) so it can stay inset from both edges while the
  // row content scrolls horizontally. Here we only set the row's TEXT color;
  // the color + corner radii go onto `bgStyle`.
  const bgStyle: React.CSSProperties = {};
  if (isSelected) {
    s.color = '#fff';
    bgStyle.backgroundColor = selColor;
    bgStyle.borderTopLeftRadius = 'var(--radius-md)';
    bgStyle.borderTopRightRadius = 'var(--radius-md)';
    bgStyle.borderBottomLeftRadius = hasHighlightedChildren ? '0' : 'var(--radius-md)';
    bgStyle.borderBottomRightRadius = hasHighlightedChildren ? '0' : 'var(--radius-md)';
  } else if (isChildOfSelected) {
    // Faded (low-opacity) highlight → use the theme's primary text so it's
    // readable in BOTH modes (white-on-light-blue was unreadable in light
    // mode). The fully-selected row above keeps #fff — its bg is the
    // saturated accent, dark enough for white in either theme.
    s.color = 'var(--text-primary)';
    bgStyle.backgroundColor = selColorFaded;
    if (isLastHighlightedChild) {
      bgStyle.borderBottomLeftRadius = 'var(--radius-md)';
      bgStyle.borderBottomRightRadius = 'var(--radius-md)';
    }
  }

  const isVpHeader = !layer.nodeId;

  return (
    <div className="group relative">
      {/* Viewport-pinned selection / hover background. It's absolutely
          positioned and sized to the panel's VISIBLE width minus padding, then
          counter-translated by the horizontal scroll offset (CSS vars set on
          the scroll container) — so it always keeps a left+right inset and
          never bleeds to the edges, no matter how far the tree is scrolled. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute top-0 bottom-0 z-0 ${!isSelected && !isChildOfSelected ? 'rounded-md group-hover:bg-[var(--bg-hover)]' : ''}`}
        style={{
          left: 0,
          width: 'calc(var(--layers-vw, 100%) - 16px)',
          transform: 'translateX(var(--layers-sx, 0px))',
          ...bgStyle,
        }}
      />
      <div
        data-layer-id={id}
        data-layer-node-id={layer.nodeId || ''}
        data-layer-depth={depth}
        data-layer-is-frame={isFrameTag(node.type) ? 'true' : ''}
        onMouseDown={(e) => { if (!isViewer && !isVpHeader && layer.nodeId && e.button === 0) onDragStart(e, layer.id, layer.nodeId); }}
        onContextMenu={(e) => { e.preventDefault(); if (!isViewer && layer.nodeId) onContextMenu(e, layer.nodeId); }}
        onClick={(e) => {
          // All click handling (including double-click rename + shift/cmd
          // additive multi-select) is in the parent — pass the event through.
          if (layer.nodeId) {
            onSelect(id, layer.nodeId, e);
          } else if (isVpHeader) {
            if (layer.isVariantHeader) {
              // Variant header IS the master/variant root — it's `children[0]`.
              const rootId = node.children[0];
              if (rootId) onSelect(id, rootId, e);
            } else {
              // Page viewport header → select the page ROOT (not its first
              // child). Pass '' so the parent resolves it to the merged
              // `layout::root` (templated page) or `root`, exactly like
              // clicking the viewport header on the canvas.
              onSelect(id, '', e);
            }
          }
        }}
        onDoubleClick={() => {
          if (isViewer) return;
          if (node.fromLayout) onDoubleClickLayout(node);
        }}
        className={rowClass}
        style={s}
      >
        {/* Drop indicators — match the row's SELECTION color (`selColor`): purple
            (`--accent-secondary`) inside a design component master / template page,
            orange for a map template, blue (`--accent`) otherwise. */}
        {isDragOver && dropPosition === 'before' && (
          <>
            <div className="absolute top-0 right-0 h-0.5 z-50" style={{ left: `${32 + dropDepth * 16}px`, backgroundColor: selColor }} />
            <div className="absolute w-2 h-2 bg-white rounded-full border-2 z-50" style={{ left: `${32 + dropDepth * 16}px`, top: '-3px', transform: 'translateX(-50%)', borderColor: selColor }} />
          </>
        )}
        {isDragOver && dropPosition === 'after' && (
          <>
            <div className="absolute bottom-0 right-0 h-0.5 z-50" style={{ left: `${32 + dropDepth * 16}px`, backgroundColor: selColor }} />
            <div className="absolute w-2 h-2 bg-white rounded-full border-2 z-50" style={{ left: `${32 + dropDepth * 16}px`, bottom: '-3px', transform: 'translateX(-50%)', borderColor: selColor }} />
          </>
        )}
        {isDragOver && dropPosition === 'inside' && (
          <div className="absolute inset-0 rounded-md pointer-events-none z-50" style={{ boxShadow: `inset 0 0 0 2px ${selColor}` }} />
        )}

        {/* Expand/Collapse — chevron button when the row has children,
         *  empty placeholder of the same width otherwise. The placeholder
         *  keeps the icon column aligned across leaf rows and chevron
         *  rows at the same depth, AND lands a nested leaf's icon under
         *  the parent's text column (instead of under the parent's icon).
         *  Previously omitted; user reported that nested leaves landed
         *  flush against their parent's icon and asked for "one slot
         *  further" — adding the placeholder gives that slot back. */}
        {/* Leading cluster (chevron + type icon). On deeply-nested rows the
            indent would push it off the right edge, so we clamp it with a
            scroll-driven translateX: it never moves past (visible-right -
            reserve), so all the clamped rows' icons line up on one vertical
            line; as you scroll right the clamp relaxes and each cluster
            "dominoes" back to its true indent. `sticky` doesn't engage for a
            mid-row flex item here, hence the explicit transform. The constant
            = px-2(16) + lock/eye reserve(56) + cluster width(~42) + this row's
            indent(12 + depth*20). */}
        <div
          className="flex items-center gap-2 shrink-0 relative z-10"
          style={{ transform: `translateX(min(0px, calc(var(--layers-sx, 0px) + var(--layers-vw, 9999px) - ${72 + depth * 20}px)))` }}
        >
        {hasChildren ? (
          <button
            draggable={false}
            onClick={(e) => { e.stopPropagation(); onToggleExpand(id); }}
            className="w-4 h-4 flex items-center justify-center rounded shrink-0 transition-colors hover:bg-[var(--bg-active)]"
            style={{ color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--text-secondary)' }}
          >
            {isExpanded ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            )}
          </button>
        ) : (
          <span className="w-4 h-4 shrink-0" aria-hidden="true" />
        )}

        {/* Icon */}
        <div className="shrink-0" style={{
          color: isVpHeader
            ? (isSelected ? '#fff' : 'var(--accent)')
            : isSelected ? '#fff' : (node.isCanvasNode || isSvgVector)
              // Vector/canvas-node icons: blue on pages, purple on a master —
              // same component-mode rule as the row selection color above.
              ? (isComponentMode ? 'var(--accent-secondary)' : 'var(--accent)')
              : 'var(--text-secondary)',
          opacity: node.fromLayout ? 0.5 : 1,
        }}>
          {isVpHeader && layer.isVariantHeader ? <span style={{ color: isSelected ? '#fff' : 'var(--accent-secondary)' }}><ComponentIcon size={14} /></span>
            : isSvgVector ? <IconSetIcon />
            : isVpHeader ? <ViewportIcon width={layer.viewportWidth} size={14} />
            : node.isChildrenSlot ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18" />
              </svg>
            ) : node.fromLayout ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (node.componentFile || (isComponentMode && !node.parentId && !node.isCanvasNode)) ? <span style={{ color: isSelected ? '#fff' : 'var(--accent-secondary)' }}>{node.isCodeComponent ? (
              <svg width="14" height="14" viewBox="0 0 24 24"><g fill="none"><path d="M0 0h24v24H0z" /><path fill="currentColor" d="M14.62 2.662a1.5 1.5 0 0 1 1.04 1.85l-4.431 15.787a1.5 1.5 0 0 1-2.889-.81L12.771 3.7a1.5 1.5 0 0 1 1.85-1.039ZM7.56 6.697a1.5 1.5 0 0 1 0 2.12L4.38 12l3.182 3.182a1.5 1.5 0 1 1-2.122 2.121L1.197 13.06a1.5 1.5 0 0 1 0-2.12l4.242-4.243a1.5 1.5 0 0 1 2.122 0Zm8.88 2.12a1.5 1.5 0 1 1 2.12-2.12l4.243 4.242a1.5 1.5 0 0 1 0 2.121l-4.242 4.243a1.5 1.5 0 1 1-2.122-2.121L19.621 12z" /></g></svg>
            ) : <ComponentIcon size={14} />}</span>
            : layer.isCmsContainer ? <span style={{ color: isSelected ? '#fff' : 'var(--accent)' }}><CmsIcon width={14} height={14} /></span>
            : layer.isCmsItem ? <span style={{ color: isSelected ? '#fff' : 'var(--accent)' }}><CmsItemIcon size={14} /></span>
            : node.attrs?.['data-overlay'] ? <OverlayIcon size={14} />
            : isTextTag(node.type) ? <TextIcon size={14} />
            : <FrameIcon size={14} />}
        </div>
        </div>

        {/* Name — inline rename input when active. Variant headers route
         *  the commit through `onVariantRenameCommit` so the new value
         *  lands in `variantConfig[*].label` (the user-facing display
         *  name) instead of writing a `data-name` attribute on a node
         *  that doesn't exist for the synthetic header row. */}
        {isRenaming ? (
          <RenameInput
            initialName={node.name || node.type}
            onCommit={(name) => {
              if (layer.isVariantHeader && layer.viewportId) {
                onVariantRenameCommit(layer.viewportId, name);
              } else if (layer.nodeId) {
                onRenameCommit(layer.nodeId, name);
              }
            }}
          />
        ) : (
          <span
            ref={textRef}
            className="text-xs font-medium select-none transition-colors whitespace-nowrap overflow-hidden text-ellipsis"
            style={{
              color: isSelected ? '#fff' : isChildOfSelected ? 'var(--text-primary)' : 'var(--text-secondary)',
              opacity: node.fromLayout ? 0.5 : 1,
              // Always fit the visible width (sx + vw) minus this text's indent
              // and a reserve for the sticky lock/eye icons + edge padding.
              // Updates on horizontal scroll purely via the CSS vars → the name
              // expands as you scroll right and never overflows the edge.
              maxWidth: textIndent != null
                ? `calc(var(--layers-sx, 0px) + var(--layers-vw, 100%) - ${Math.max(0, Math.round(textIndent) + 60)}px)`
                : undefined,
            }}
          >
            {node.isChildrenSlot ? '{children}' : (node.name || node.type)}
          </span>
        )}

        {/* Spacer to push actions to the right */}
        <div className="flex-1" />

        {/* Lock & Visibility actions — visible on hover, always visible when hidden/locked */}
        {!isViewer && !isVpHeader && layer.nodeId && (() => {
          // Use the row-level `effectiveHidden` from the resolver (which
          // already cascades base + default-variant + per-variant + @media
          // overrides). The previous `|| node.styles.display === 'none'`
          // fallback short-circuited the resolver for any node with
          // inline `display: 'none'` baked in — exactly the case where
          // a non-default variant un-hides via `display: ''`.
          const isHidden = effectiveHidden;
          const isLocked = node.styles.pointerEvents === 'none';
          const alwaysShow = isHidden || isLocked;
          return (
            <div className={`flex items-center gap-0.5 shrink-0 sticky right-2 z-10 transition-opacity ${alwaysShow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <button
                draggable={false}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleLock(layer.nodeId!); }}
                className="p-0.5 rounded hover:bg-[var(--bg-hover)] transition-colors"
                title={isLocked ? 'Unlock layer' : 'Lock layer'}
              >
                {isLocked ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isSelected ? 'rgba(255,255,255,0.6)' : '#666'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isSelected ? 'rgba(255,255,255,0.6)' : '#666'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 5-5 5 5 0 0 1 5 5v4" /><line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                )}
              </button>
              <button
                draggable={false}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(layer.nodeId!, layer.viewportId); }}
                className="p-0.5 rounded hover:bg-[var(--bg-hover)] transition-colors"
                title={isHidden ? 'Show layer' : 'Hide layer'}
              >
                {isHidden ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isSelected ? 'rgba(255,255,255,0.6)' : '#666'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isSelected ? 'rgba(255,255,255,0.6)' : '#666'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          );
        })()}

        {/* Viewport width badge */}
        {layer.viewportWidth && (
          <span className="text-xs shrink-0 sticky right-2 z-10" style={{ color: isSelected ? '#fff' : 'var(--accent)', fontWeight: 500 }}>
            {layer.viewportWidth}
          </span>
        )}
      </div>
    </div>
  );
});

// ─── Inline Rename Input ────────────────────────────────────────────────────

function RenameInput({ initialName, onCommit }: { initialName: string; onCommit: (name: string) => void }) {
  const [value, setValue] = React.useState(initialName);
  const [active, setActive] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const onCommitRef = React.useRef(onCommit);
  onCommitRef.current = onCommit;
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    // Wait for React to finish rendering, then focus + enable blur handler
    const t = setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
        setActive(true); // Only NOW enable onBlur
      }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  const finish = (val: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommitRef.current(val.trim() || initialName);
  };

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => { e.stopPropagation(); setValue(e.target.value); }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value);
        if (e.key === 'Escape') finish(initialName);
      }}
      onBlur={() => { if (active) finish(value); }}
      // `-my-0.5` cancels `py-0.5`'s height contribution so the row stays exactly as tall as the static
      // label (which has no padding) — the white pill keeps its padding but doesn't grow the row.
      className="text-xs font-medium leading-4 bg-white text-black border-0 outline-none px-1 py-0.5 -my-0.5 box-border rounded w-full"
      style={{ minWidth: 40 }}
    />
  );
}
