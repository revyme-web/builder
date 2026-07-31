// SvgShapeTool.tsx — Properties panel for SVG shape elements.
// Two-section layout matching the reference's compact SVG panel:
//
//   Styles   — wrapper CSS (Opacity, Visible, Rotate) + inner Fill attr
//   Stroke   — inner shape attrs (color, width, style, cap, join)
//
// Wrapper-CSS controls (Opacity / Rotate) reuse the shared StylesTool
// atoms which write through `updateStyle()` from the ControlProvider —
// same write path as every other element. Visible toggles `display`.
//
// Inner-shape controls (Fill, Stroke*) write SVG presentation attributes
// to the *child* shape element (the <rect>/<path>/<ellipse> inside the
// <svg> wrapper). This needs a different write path:
//   READS  — from `nodesAtom`. The wrapper's `children` are the inner
//            shape CanvasNodes; their `attrs` map carries the props.
//   WRITES — `queueMutation({ type: 'updateSvgAttrs' })` for source
//            persistence + bridge.setAttribute (or the index-based
//            setChildShapeAttribute fallback) for instant iframe-DOM
//            feedback.
//
// During shape-edit mode the iframe SVG's children are bare elements
// written by the path-editor library — they have no `data-node-id`, so
// the index-based bridge call is the only way to reach them. Source
// mutation is also skipped in that mode; the commit-time
// `replaceSvgInner` fired on shape-edit exit serializes the full SVG
// (including these attrs) and writes it back to source in one batch.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSection, ToolInput, ToolSegmentedControl, ToolSelect, ToolPlusMinus, ColorInput, ToolDivider } from '../controls';
import ControlLabel from '../controls/ControlLabel';
import { LocalizeGate } from '../controls/localize-gate';
import { useControl } from '../controls/ControlProvider';
import { OpacityControl } from './StylesTool/atoms/OpacityControl';
import { RotateControl } from './StylesTool/atoms/RotateControl';
import { HideControl } from './StylesTool/atoms/HideControl';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getViewportPrefix, findSvgShapeChild, getActiveFilePath } from '@/canvas/node-ops';
import { getReplicaContext } from '@/canvas/drag/replica-context';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { interactingViewportWidthAtom, isReplicaViewportAtom, isComponentVariantViewportAtom, activeComponentVariantAtom } from '@/code/stores/viewport-store';
import { containerOverridesAtom, getOverridesAtWidth } from '@/code/stores/container-query-store';
import { toKebab } from '@/shared/css-utils';
import { modifyProjectFile } from '@/code/project/modify-file';
import { ensureShapeChildIds } from '@/code/generation/generator-attrs';
import { useNodesComputed } from '@/code/stores/node-family';
import { selectedPointAtom, shapeEditingIdAtom } from '@/code/stores/shape-edit-store';
import { selectedIdsAtom, getNodesSnapshot } from '@/code/stores/store';
import type { CanvasNode } from '@/code/parsing/parser';
import { resolveShapeAttrTargets } from './svg-shape-targets';
import { trace } from '@/shared/debug-trace';

// SVG presentation attributes that are ALSO valid CSS properties — so a
// per-tile (variant / viewport) override can ride the CSS cascade on top of the
// shared base attribute, exactly like geometry's `d`. Mapped to the camelCase
// style key the routing pipeline expects (it kebab-izes for `@media` CSS and
// keeps camelCase for the variants object). `data-stroke-align` is NOT here: it
// has no CSS property (it's faked via clip-path/paint-order at render), so it
// can't be a per-tile override and stays a shared base attribute.
const CSS_ROUTABLE_SHAPE_ATTRS: Record<string, string> = {
  'fill': 'fill',
  'stroke': 'stroke',
  'stroke-width': 'strokeWidth',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'fill-opacity': 'fillOpacity',
  'stroke-opacity': 'strokeOpacity',
};

// Wrappers whose inner shapes we've already stamped with stable data-ids this
// session — so a continuous color/stroke drag doesn't re-run the (flushing)
// source stamp every tick. ensureShapeChildIds is idempotent, so a stale entry
// only skips a redundant no-op, never corrupts.
const _stampedShapeWrappers = new Set<string>();

// ─── Helpers ───────────────────────────────────────────────────────────────

function getStrokeStyle(dasharray: string): 'solid' | 'dashed' | 'dotted' {
  if (!dasharray || dasharray === 'none') return 'solid';
  const parts = dasharray.split(/[,\s]+/).map(Number);
  if (parts.length === 0 || parts.every(p => p === 0)) return 'solid';
  // Dotted is "0,<gap>" with linecap=round (rendered as round dots
  // by the browser) — detect by the leading zero.
  if (parts[0] === 0) return 'dotted';
  if (parts.length >= 2 && parts[0] <= 3 && parts[1] <= 3) return 'dotted';
  return 'dashed';
}

/** Build a `stroke-dasharray` value from a single standard
 *  "Array" number. Dashed pattern → `<n>,<n/2>`; dotted pattern →
 *  `0,<n>` (combined with stroke-linecap=round = round dots `n`
 *  apart). Keeps the logic in one place so the Style selector and
 *  the Array input emit identical formats. */
function dasharrayFromArray(n: number, style: 'dashed' | 'dotted'): string {
  if (style === 'dotted') return `0,${n}`;
  return `${n},${Math.max(1, Math.round(n / 2))}`;
}

// standard icons for the Style / Cap / Join segmented controls.
// Each icon is a small SVG that visually represents the property
// being toggled — so the user reads meaning straight off the icon
// instead of squinting at "Butt" / "Round" / "Square" text labels.

// ── Style: Solid / Dash / Dot ────────────────────────────────────
// Icon is rendered at 18×14 (same height as Cap/Join icons below) so
// the segmented-control buttons line up vertically. The stroke itself
// sits centered at y=7.
function StyleIcon({ style }: { style: 'solid' | 'dashed' | 'dotted' }) {
  const dasharray =
    style === 'dashed' ? '4 3'
    : style === 'dotted' ? '0 3'
    : undefined;
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden>
      <line
        x1="1" y1="7" x2="17" y2="7"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray={dasharray}
        strokeLinecap={style === 'dotted' ? 'round' : 'butt'}
      />
    </svg>
  );
}

// ── Cap: Butt / Round / Square ────────────────────────────────────
// Self-illustrating: a thick short horizontal stroke with the actual
// `stroke-linecap` applied. The icon IS the result — Butt's stroke
// terminates flat at the endpoints, Round bulges out as a semicircle
// past them, Square extends past them with sharp corners. Stroke
// width 6 on a 14px-tall viewBox makes the cap profile fill roughly
// half the icon height so the differences read at a glance instead
// of having to squint at three near-identical pictograms.
//
// The line's geometric span (x=4..14) is narrower than the viewBox
// (18 wide) so Round / Square's cap extensions (3px each side) have
// room to render in-frame instead of getting clipped.
function CapIcon({ cap }: { cap: 'butt' | 'round' | 'square' }) {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden>
      <line
        x1="4" y1="7" x2="14" y2="7"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap={cap}
      />
    </svg>
  );
}

// ── Join: Miter / Round / Bevel ───────────────────────────────────
// Self-illustrating: an L-shape with the actual `stroke-linejoin`
// applied. Miter pokes the corner out as a sharp triangle, Round
// curves it smoothly, Bevel cuts it flat across the corner. Stroke
// width 4 on a 16×16 viewBox makes the join profile clearly visible
// at the corner. Round line-caps on the open endpoints so the cap
// styling at the ends doesn't compete visually with the join styling
// at the corner — keeps focus on the corner shape difference.
function JoinIcon({ join }: { join: 'miter' | 'round' | 'bevel' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 13 L4 4 L13 4"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin={join}
        fill="none"
      />
    </svg>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function SvgShapeTool() {
  const { nodeId, node, vpId, styles, updateStyle } = useControl();

  const selectedPoint = useAtomValue(selectedPointAtom);
  const childIndex = selectedPoint?.shapeIndex ?? 0;

  // Multi-select: Fill/Stroke must apply to EVERY selected SVG shape, not just
  // the primary the panel reads from (CLAUDE.md: operations iterate ALL selected
  // ids). `updateStyle` (wrapper CSS) already fans out via ControlProvider, but
  // the inner-shape attr writers below target one nodeId — so they resolve the
  // full target list themselves (live find 2026-07-24).
  const selectedIds = useAtomValue(selectedIdsAtom);

  const shapeEditingId = useAtomValue(shapeEditingIdAtom);
  const isInShapeEdit = shapeEditingId !== null && nodeId === shapeEditingId;

  // Resolve target inner-shape CanvasNode from cached node tree.
  const shapeNode = useNodesComputed(
    (nodes) => findSvgShapeChild(node, nodes, childIndex)?.node ?? null,
    [node, childIndex],
  );

  // Buffer of attr edits made during shape-edit mode (source mutation
  // deferred to commit time so the path-editor library's drag-time DOM
  // writes aren't fought by the renderer).
  const [pendingOverrides, setPendingOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    setPendingOverrides({});
  }, [nodeId, childIndex]);

  // ─── Per-tile override resolution (responsive replica/variant) ───────────
  // A CSS-routable shape attr edited on a replica lands as a per-tile @media CSS override keyed by the
  // inner shape's stable data-id — the SAME `shapeId` the write path targets. The controls MUST read the
  // RESOLVED value (base ⊕ this tile's override) or they show stale base values on the replica (the bug:
  // canvas shows the override, panel shows base). Also drives the blue "Reset Override" indicator.
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const replicaWidth = useAtomValue(interactingViewportWidthAtom);
  const isReplica = useAtomValue(isReplicaViewportAtom);
  const isComponentVariant = useAtomValue(isComponentVariantViewportAtom);
  const activeVariant = useAtomValue(activeComponentVariantAtom);
  const inNonDefaultVariant = isComponentVariant && !!activeVariant && activeVariant !== 'default';
  const shapeId = shapeNode
    ? (shapeNode.id.startsWith(`${nodeId}-g`) ? shapeNode.id : `${nodeId}-g${childIndex}`)
    : '';

  // The ACTIVE override source for this shape, with CAMELCASE keys (`strokeWidth`, `strokeLinecap`, …):
  //   • component non-default variant → the inner shape's variant object (`shapeNode.motionVariants[v]`)
  //   • page replica                  → the @media map (`getOverridesAtWidth`, also camelCase)
  // Empty in the primary / base context. Detection (`isAttrOverridden`) just checks membership here, so it
  // works for BOTH variants and page replicas without branching.
  const rawTileOverrides = useMemo<Record<string, string>>(() => {
    if (inNonDefaultVariant) {
      return (shapeNode?.motionVariants?.[activeVariant!] ?? {}) as Record<string, string>;
    }
    if (isReplica && replicaWidth && shapeId) {
      return Object.fromEntries(getOverridesAtWidth(containerOverrides, shapeId, replicaWidth));
    }
    return {};
  }, [inNonDefaultVariant, activeVariant, shapeNode, isReplica, replicaWidth, shapeId, containerOverrides]);

  // Base shapeNode.attrs are KEBAB (`stroke-width`) and the reads below use kebab, so convert each override
  // key to kebab → it OVERWRITES the base attr (else `attrs['stroke-width']` keeps the base '0').
  const tileOverrides = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [camelKey, value] of Object.entries(rawTileOverrides)) out[toKebab(camelKey)] = value;
    return out;
  }, [rawTileOverrides]);

  // base attrs ⊕ this tile's overrides (variant or @media) ⊕ in-flight shape-edit buffer.
  const attrs = { ...(shapeNode?.attrs ?? {}), ...tileOverrides, ...pendingOverrides };

  // Overridden when the active source has the prop. Check the CAMELCASE key the sources store
  // (`stroke-width` → `strokeWidth`). `stroke`/`fill` are single-word so they matched either way — which
  // is why Color worked but the compound stroke props (Width/Style/Cap/Join) didn't light up.
  const isAttrOverridden = (svgKey: string): boolean =>
    (CSS_ROUTABLE_SHAPE_ATTRS[svgKey] ?? svgKey) in rawTileOverrides;

  // Resolve every SVG shape the write should hit. Single-select → just the
  // primary (with its selectedPoint childIndex). Multi-select → every selected
  // `<svg>` node, each targeting its OWN shape child at index 0.
  const resolveAttrTargets = useCallback(
    () => resolveShapeAttrTargets(
      selectedIds,
      { nodeId, shapeNode, childIndex },
      getNodesSnapshot(),
      (svg, nodes, idx) => findSvgShapeChild(svg, nodes, idx)?.node ?? null,
    ),
    [selectedIds, nodeId, shapeNode, childIndex],
  );

  // Commit one shape-attr write to ONE target shape (per-tile routing included).
  const applyAttrToTarget = useCallback((
    tNodeId: string, tShapeNode: CanvasNode | null, tChildIndex: number, key: string, value: string,
  ) => {
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setAttribute?: (n: string, vp: string, attr: string, value: string | null) => void;
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };

    // PER-TILE routing: on a non-primary tile (component variant OR page replica)
    // a fill/stroke/cap/join change must land on THAT tile only — writing the
    // base `updateSvgAttrs` attribute bleeds it to every tile (the bug). These
    // attrs are also CSS properties, so route them as a per-tile CSS OVERRIDE
    // (variants object / `@media`) the same way geometry's `d` is routed; the
    // base attribute stays the cross-tile fallback. The override targets the
    // inner path's stable data-id, so stamp the shapes first (once per wrapper).
    const camelKey = CSS_ROUTABLE_SHAPE_ATTRS[key];
    const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
    if (!ctx.isPrimary && camelKey && tShapeNode) {
      const alreadyStamped = tShapeNode.id.startsWith(`${tNodeId}-g`);
      if (!alreadyStamped && !_stampedShapeWrappers.has(tNodeId)) {
        modifyProjectFile(getActiveFilePath(), code => ensureShapeChildIds(code, tNodeId).code);
        flushNow();
        _stampedShapeWrappers.add(tNodeId);
      }
      const sid = alreadyStamped ? tShapeNode.id : `${tNodeId}-g${tChildIndex}`;
      for (const u of ctx.styleUpdate(sid, { [camelKey]: value })) queueMutation(u as any);
      // Instant iframe feedback on THIS tile only (vpPrefix-scoped element).
      bridge.setChildShapeAttribute?.(tNodeId, vpPrefix, tChildIndex, key, value === '' ? null : value);
      flushNow();
      return;
    }

    queueMutation({ type: 'updateSvgAttrs', nodeId: tNodeId, attrs: { [key]: value }, childIndex: tChildIndex });
    // Always go through `setChildShapeAttribute` (parent SVG nodeId + childIndex)
    // rather than `setAttribute(shapeChildId, …)`. Inner-shape `data-id`s
    // (auto_1, auto_2…) restart their counter per SVG, so multiple SVGs in
    // the same file routinely share an `auto_N` id. `setAttribute` matches
    // by data-id only and hits the first one in DOM — writing the live-DOM
    // update to the wrong shape until the next full re-render corrects it.
    bridge.setChildShapeAttribute?.(tNodeId, vpPrefix, tChildIndex, key, value === '' ? null : value);
  }, [vpId]);

  // ─── Inner-shape attr writer (Fill, Stroke*) ─────────────────────────────
  const updateAttr = useCallback((key: string, value: string) => {
    if (!nodeId) return;
    trace.action('svg-shape-tool:updateAttr', { nodeId, childIndex, key, value, isInShapeEdit, selCount: selectedIds.length });

    if (isInShapeEdit) {
      // Shape-edit is single-shape by definition — write the primary only.
      const vpPrefix = getViewportPrefix(vpId);
      const bridge = getCanvasBridge() as {
        setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
      };
      bridge.setChildShapeAttribute?.(nodeId, vpPrefix, childIndex, key, value === '' ? null : value);
      setPendingOverrides(prev => ({ ...prev, [key]: value }));
      return;
    }

    // Fan out to EVERY selected shape (single-select → just the primary).
    for (const t of resolveAttrTargets()) applyAttrToTarget(t.nodeId, t.shapeNode, t.childIndex, key, value);
  }, [nodeId, vpId, childIndex, isInShapeEdit, selectedIds, resolveAttrTargets, applyAttrToTarget]);

  // ─── Live (per-frame) inner-shape attr writer ────────────────────────────
  // Picker-drag / chevron-hold feedback: paint THIS tile's shape via the bridge
  // only (vpPrefix-scoped, no source write, no flushNow re-render). The full
  // `updateAttr` — with its per-tile/primary mutation-queue commit — fires once
  // on release. Routing the per-frame callback straight to `updateAttr` is what
  // made the Fill/Stroke pickers low-FPS (queueMutation + flushNow every frame).
  const updateAttrLive = useCallback((key: string, value: string) => {
    if (!nodeId) return;
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    // Live feedback fans out to every selected shape (same targets as the commit)
    // so a picker/chevron drag paints all selected shapes at once, not just the
    // primary. Bridge-only (no source write) — the commit lands on release.
    for (const t of resolveAttrTargets()) {
      bridge.setChildShapeAttribute?.(t.nodeId, vpPrefix, t.childIndex, key, value === '' ? null : value);
    }
    // Shape-edit mode commits via the pending-override buffer, not the queue —
    // mirror `updateAttr`'s shape-edit branch so a live drag still records.
    if (isInShapeEdit) setPendingOverrides(prev => ({ ...prev, [key]: value }));
  }, [nodeId, vpId, childIndex, isInShapeEdit, resolveAttrTargets]);

  // ─── Reset a per-tile override ("Reset Override" menu item) ───────────────
  // Drops THIS tile's @media / variant CSS override for the prop so the shared
  // base attribute shows through again. Empty value = remove property (the same
  // convention the generators + every other Reset Override uses); flushNow's
  // re-render rebuilds the element from source (override gone) and re-injects the
  // container CSS without that rule, so the tile reverts to base immediately.
  const resetAttrOverride = useCallback((svgKey: string) => {
    if (!nodeId || !shapeNode) return;
    const camelKey = CSS_ROUTABLE_SHAPE_ATTRS[svgKey];
    if (!camelKey) return;
    const ctx = getReplicaContext(vpId, getActiveFilePath(), getViewportWidths());
    if (ctx.isPrimary) return;
    const sid = shapeNode.id.startsWith(`${nodeId}-g`) ? shapeNode.id : `${nodeId}-g${childIndex}`;
    trace.action('svg-shape-tool:reset-override', { nodeId, shapeId: sid, svgKey });
    for (const u of ctx.styleUpdate(sid, { [camelKey]: '' })) queueMutation(u as any);
    flushNow();
  }, [nodeId, vpId, childIndex, shapeNode]);

  if (!node || node.type !== 'svg' || !shapeNode) return null;

  // Render a shape-attr label with the responsive blue indicator + "Reset
  // Override" — shown only on a replica/variant that has its own value for the
  // shape's `svgKey`. `syntheticProp` keeps each row's menu/value lookups
  // distinct (these props aren't real CSS keys in the style map); the three hide
  // flags strip Create-Variable / Reset-Style / Bind-to-Field so the menu holds
  // ONLY "Reset Override" — and the chevron auto-hides when there's nothing to
  // show (no override → empty menu → plain-looking, non-interactive label).
  const shapeLabel = (label: string, syntheticProp: string, svgKey: string) => (
    <ControlLabel
      label={label}
      property={syntheticProp}
      overridden={isAttrOverridden(svgKey)}
      onResetOverride={() => resetAttrOverride(svgKey)}
      hideCreateVariable
      hideResetStyle
      hideCmsBinding
    />
  );

  // ─── Read inner-shape attrs ─────────────────────────────────────────────
  const fill = attrs.fill || '#000000';
  const stroke = attrs.stroke || '';
  const strokeWidth = attrs['stroke-width'] || attrs.strokeWidth || '1';
  const strokeDasharray = attrs['stroke-dasharray'] || attrs.strokeDasharray || '';
  const strokeLinecap = attrs['stroke-linecap'] || attrs.strokeLinecap || 'butt';
  const strokeLinejoin = attrs['stroke-linejoin'] || attrs.strokeLinejoin || 'miter';
  // Stroke alignment is faked at render time via clip-path (Inside) and
  // paint-order (Outside) — see `applyStrokeAlignment` in Renderer.ts.
  // Source-of-truth is the `data-stroke-align` attr on the shape.
  const strokeAlign = attrs['data-stroke-align'] || 'center';
  const strokeStyle = getStrokeStyle(strokeDasharray);
  // standard "Array" — single number that scales the dash/gap
  // pattern. Which slot we read depends on style:
  //   dashed → `<n>,<n/2>` → arrayValue = parts[0] (the dash length)
  //   dotted → `0,<n>`     → arrayValue = parts[1] (the gap; the
  //                          leading 0 is the dot itself)
  // Falls back to a sensible default when dasharray is empty (Solid
  // style) so the input never reads NaN before the user picks a
  // dashed / dotted pattern.
  const arrayValue = (() => {
    const parts = strokeDasharray.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n));
    if (parts.length > 0) {
      if (strokeStyle === 'dotted') {
        const gap = parts[1];
        if (gap && gap > 0) return gap;
      } else {
        const dash = parts[0];
        if (dash && dash > 0) return dash;
      }
    }
    return strokeStyle === 'dotted' ? 2 : 8;
  })();

  // (Visible toggle now uses the shared `HideControl` atom — see render.)

  return (
    // Shapes can't be localized — SVG presentation attrs (fill/stroke/…) and
    // the wrapper CSS rows here have no per-locale story, so the "Localize"
    // menu item is suppressed on EVERY control in this tool, including the
    // shared Opacity/Hide/Rotate atoms (user request 2026-07-24). Mirrors the
    // AnimationTool/OverlayTool gates.
    <LocalizeGate hidden>
      {/* ─── Styles ───────────────────────────────────────────────────── */}
      {/* In shape-edit mode only the Fill is meaningful — Opacity / Visible /
          Rotate apply to the SVG wrapper and conflict with editing the path
          vertices (toggling Visible mid-edit would hide what the user is
          editing; Rotate would skew the live anchor handle math). Hide
          them so the panel stays focused on path-shape attributes. */}
      <ToolSection title="Styles">
        {!isInShapeEdit && <OpacityControl />}

        {/* Hide — reuse the shared atom so the SvgShapeTool's "is this
            element rendered" toggle matches the Yes/No semantics +
            label + write routing every other element type uses. The
            ad-hoc "Visible Yes/No" version that lived here drifted
            from the standard — same DOM result (display:'none' vs ''),
            different copy, separate solo-replica / @container routing.
            Reusing HideControl keeps the user model consistent. */}
        {!isInShapeEdit && <HideControl />}

        {/* Fill — always shown */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Fill', '__svg-fill', 'fill')}
          <div className="flex items-center gap-2 w-full">
            <ColorInput
              value={fill}
              onChange={v => updateAttr('fill', v)}
              onChangeLive={v => updateAttrLive('fill', v)}
              showAlpha
            />
          </div>
        </div>

        {!isInShapeEdit && <RotateControl />}
      </ToolSection>

      {/* Divider matches the rule the PropertiesPanel uses between
          top-level tools (Position → Size → SvgShapeTool). Without it
          the Stroke section bleeds into the Styles section above and
          reads as a sub-heading instead of its own block. */}
      <ToolDivider />

      {/* ─── Stroke ──────────────────────────────────────────────────── */}
      <ToolSection title="Stroke" collapsible defaultOpen>
        {/* Stroke color */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Color', '__svg-stroke', 'stroke')}
          <div className="flex items-center gap-2 w-full">
            <ColorInput
              value={stroke || '#000000'}
              onChange={v => updateAttr('stroke', v)}
              onChangeLive={v => updateAttrLive('stroke', v)}
              showAlpha
            />
          </div>
        </div>

        {/* Width — paired with a +/- toggle (same pattern as the
            Shadow X / Y / Blur rows) so the user can nudge stroke
            thickness without typing. SVG `stroke-width` is unitless
            in user-space units, so we parse/format as a plain int. */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Width', '__svg-stroke-width', 'stroke-width')}
          <div className="flex items-center gap-2 w-full">
            <ToolInput
              value={strokeWidth}
              onChange={v => updateAttr('stroke-width', v)}
              onChangeLive={v => updateAttrLive('stroke-width', v)}
              onCommit={v => updateAttr('stroke-width', v)}
              step={1}
            />
            <ToolPlusMinus
              value={Number.parseFloat(strokeWidth) || 0}
              onChange={(v) => updateAttr('stroke-width', String(Math.max(0, v)))}
              min={0}
              max={100}
            />
          </div>
        </div>

        {/* Align — Center / Inside / Outside. SVG natively strokes
            centered on the path edge; Inside and Outside are faked at
            render time (clip-path / paint-order, see `applyStrokeAlignment`
            in Renderer.ts). Source carries only `data-stroke-align`. */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Align" property="__svg-stroke-align" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolSelect
              value={strokeAlign}
              onChange={v => updateAttr('data-stroke-align', v === 'center' ? '' : v)}
              options={[
                { value: 'center',  label: 'Center'  },
                { value: 'inside',  label: 'Inside'  },
                { value: 'outside', label: 'Outside' },
              ]}
            />
          </div>
        </div>

        {/* Style: Solid / Dashed / Dotted. Switching style reseeds
            the dasharray with the current `arrayValue` so the user's
            spacing choice carries between style changes (the reference
            parity). */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Style', '__svg-stroke-style', 'stroke-dasharray')}
          <div className="flex items-center gap-2 w-full">
            <ToolSegmentedControl
              value={strokeStyle}
              onChange={v => {
                if (v === 'solid') updateAttr('stroke-dasharray', '');
                else updateAttr('stroke-dasharray', dasharrayFromArray(arrayValue, v as 'dashed' | 'dotted'));
              }}
              options={[
                { value: 'solid',  icon: <StyleIcon style="solid" /> },
                { value: 'dashed', icon: <StyleIcon style="dashed" /> },
                { value: 'dotted', icon: <StyleIcon style="dotted" /> },
              ]}
              size="sm"
            />
          </div>
        </div>

        {/* Array — scales the dash/gap spacing (design-tool parity). The
            single number is mapped to a real `stroke-dasharray` based
            on current style: dashed → `<n>,<n/2>`, dotted → `0,<n>`
            (with strokeLinecap=round = round dots `n` apart). Hidden
            when Style is Solid because there's nothing to space. */}
        {strokeStyle !== 'solid' && (
          <div className="flex items-center justify-between w-full">
            {shapeLabel('Array', '__svg-stroke-array', 'stroke-dasharray')}
            <div className="flex items-center gap-2 w-full">
              <ToolInput
                value={String(arrayValue)}
                onChange={v => updateAttr('stroke-dasharray', dasharrayFromArray(Math.max(1, Number.parseFloat(v) || 1), strokeStyle))}
                step={1}
              />
              <ToolPlusMinus
                value={arrayValue}
                onChange={v => updateAttr('stroke-dasharray', dasharrayFromArray(Math.max(1, v), strokeStyle))}
                min={1}
                max={500}
              />
            </div>
          </div>
        )}

        {/* Cap — icons render the property they represent (a tiny
            horizontal stroke with the cap style applied). */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Cap', '__svg-linecap', 'stroke-linecap')}
          <div className="flex items-center gap-2 w-full">
            <ToolSegmentedControl
              value={strokeLinecap}
              onChange={v => updateAttr('stroke-linecap', v)}
              options={[
                { value: 'butt',   icon: <CapIcon cap="butt" /> },
                { value: 'round',  icon: <CapIcon cap="round" /> },
                { value: 'square', icon: <CapIcon cap="square" /> },
              ]}
              size="sm"
            />
          </div>
        </div>

        {/* Join — same self-illustrating trick (L-shape with the
            join style applied). */}
        <div className="flex items-center justify-between w-full">
          {shapeLabel('Join', '__svg-linejoin', 'stroke-linejoin')}
          <div className="flex items-center gap-2 w-full">
            <ToolSegmentedControl
              value={strokeLinejoin}
              onChange={v => updateAttr('stroke-linejoin', v)}
              options={[
                { value: 'miter', icon: <JoinIcon join="miter" /> },
                { value: 'round', icon: <JoinIcon join="round" /> },
                { value: 'bevel', icon: <JoinIcon join="bevel" /> },
              ]}
              size="sm"
            />
          </div>
        </div>
      </ToolSection>
    </LocalizeGate>
  );
}
