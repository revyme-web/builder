// RotateControl.tsx — Self-contained rotate ToolAtom (motion prop).
//
// Two write paths:
//   - Plain elements / top-level <svg>: CSS `transform: 'rotate(Xdeg)'`.
//     `transform` is the universally-supported pipeline every browser folds
//     into the composed matrix from `getComputedStyle(...).transform` and
//     `SVGGraphicsElement.getScreenCTM()`.
//   - SVG shape wrappers (a <svg> with an inner path/polygon/…): the SVG
//     `transform="rotate(angle cx cy)"` ATTRIBUTE on the inner shape. CSS
//     rotation on a NESTED <svg> orbits because its transform-origin defaults
//     to `0 0`; the explicit-pivot attribute has no such ambiguity. Mirrors
//     how the reference stores SVG rotation.
//
// Read path: parses the rotate value out of the inner shape's transform
// attribute (SVG shapes) or the CSS transform string (everything else).

import { ToolSlider, ToolInput } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { useControl } from '../../../controls/ControlProvider';
import type { AtomProps } from '../../../controls/unified/types';
import { useNodesComputed } from '@/code/stores/node-family';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { useAtomValue } from 'jotai';
import { styleHelperAtom } from '@/canvas/selection/style-helper-store';
import { findSvgShapeChild, findNodeComputedStyles, getViewportPrefix, isPrimaryViewport, getActiveFilePath } from '@/canvas/node-ops';
import { isComponentFilePath } from '@/code/project/active-file-store';
import { parseSvgRotate, mergeSvgRotate, svgPivotStyles, commitVariantRotation, applyVariantRotatePreviewBase } from '@/canvas/resize/RotateManager';
import { motionPropsToCSSTransform } from '@/shared/motion-transform';
import { useRef } from 'react';

/** Extract the degree value from a CSS transform string like
 *  `rotate(72deg)` / `rotate(72)` / `matrix(...)`. Returns 0 when no
 *  rotation is present or the string is unparseable. */
function parseRotateDeg(transform: string): number {
  if (!transform || transform === 'none') return 0;
  // Direct `rotate(Xdeg)` or `rotate(X)` — common case.
  const m = transform.match(/rotate\(\s*(-?[\d.]+)\s*(deg|rad|turn)?\s*\)/);
  if (m) {
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    const unit = (m[2] || 'deg').toLowerCase();
    if (unit === 'rad') return n * (180 / Math.PI);
    if (unit === 'turn') return n * 360;
    return n;
  }
  // Matrix form `matrix(a, b, c, d, e, f)` — derive angle from (a, b).
  const mm = transform.match(/^matrix\(\s*([^)]+)\)/);
  if (mm) {
    const parts = mm[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length >= 6 && parts.every(Number.isFinite)) {
      return Math.atan2(parts[1], parts[0]) * (180 / Math.PI);
    }
  }
  return 0;
}

function RotateAtom() {
  const { value, onChange, onChangeMultiple, allProps, mode } = useControlContext();
  const { nodeId, node, vpId, updateMultipleStyles, updateStyle } = useControl();
  // Debounce for the motion-channel commit (declared before any early
  // return — rules of hooks).
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SVG shape wrapper → rotate via the inner shape's `transform` ATTRIBUTE.
  // Resolved here (hook — must live ABOVE the non-direct early return).
  const { shapeChild, parentIsSvg } = useNodesComputed(
    (nodes) => ({
      shapeChild: (nodeId && node) ? findSvgShapeChild(node, nodes) : null,
      parentIsSvg: !!(node?.parentId && nodes.get(node.parentId)?.type === 'svg'),
    }),
    [nodeId, node],
  );

  const isDirect = mode === 'direct' || mode === 'htmlAttr';

  // Non-direct modes (cssKeyframe / scrollStop / motionVariant / variant)
  // write rotate as a motion-style `rotate` PROP on the parent prop map
  // (keyframe stops, scroll stops, variant entries), NOT as a CSS
  // `transform: rotate(Xdeg)` on the actual element. Otherwise the rotate
  // slider in a hover/tap popup would land in the source-code inline
  // style of the node and apply at rest, before the hover/tap ever fires.
  if (!isDirect) {
    const num = parseFloat(allProps?.rotate || '0') || 0;
    // Non-direct modes use the value as a literal stop value (scroll stop,
    // variant entry, keyframe stop). 0 is meaningful — "rotate to 0
    // degrees", not "remove this property". The 0-→-'' shortcut from the
    // direct-CSS path silently dropped From-rotate-0 stops from scroll
    // transform code generation, which broke the interpolation entirely
    // because the generator's `outputs.some(v => v === '')` guard skipped
    // the whole rotate channel.
    const write = (n: number) => {
      onChangeMultiple({ rotate: String(n) });
    };
    const writeRaw = (s: string) => {
      const n = parseFloat(s);
      if (!Number.isFinite(n)) { onChange(s); return; }
      write(n);
    };
    return (
      <div className="flex items-center gap-2 w-full">
        <ToolSlider value={num} min={-360} max={360} step={1} onChange={write} />
        <ToolInput value={String(Math.round(num * 10) / 10)} onChange={writeRaw} step={1} chevronLabel="deg" />
      </div>
    );
  }

  let num: number;
  let write: (n: number) => void;

  // MOTION CHANNEL (component files): rotation lives in the variants const —
  // default entry on the primary, variants[vpId] on a replica (the unified
  // rotation channel; the rotate HANDLE writes the same way). Read the
  // merged entry; write through the shared commit. Without this branch the
  // panel showed 0° for rotated group children and a slider write would have
  // forked back into the legacy attr channel (live report 2026-06-12).
  const mvAll = node?.motionVariants as Record<string, Record<string, string | number>> | undefined;
  // LIVE SYNC WITH THE CANVAS HANDLE. RotateManager pushes the in-progress
  // angle into styleHelperAtom every onMove (`{ type: 'rotate', value }`).
  // The slider reads it during an active rotate so the track + number field
  // move WITH the handle, instead of freezing at the stale source value until
  // mouseup (live ask 2026-09-05). Ignored when the badge isn't a rotate one.
  const liveHelper = useAtomValue(styleHelperAtom);
  const liveRotate = (liveHelper.show && liveHelper.type === 'rotate')
    ? (liveHelper.value ?? null) : null;

  const isPrimTile = isPrimaryViewport(vpId);
  const mergedEntryRotate = mvAll
    ? (isPrimTile ? mvAll.default?.rotate : (mvAll[vpId]?.rotate ?? mvAll.default?.rotate))
    : undefined;
  const isMotionRotateChannel = !!nodeId && !!node && isComponentFilePath(getActiveFilePath())
    && (parentIsSvg || !isPrimTile || mergedEntryRotate != null)
    && shapeChild != null;

  if (nodeId && node && isMotionRotateChannel) {
    num = parseFloat(String(mergedEntryRotate ?? '')) || 0;
    write = (n: number) => {
      // Instant visual: fold the live angle over the merged entry on THIS
      // tile (same per-tick patch as the rotate handle); commit debounced —
      // commitVariantRotation runs the full normalize+migration+flush
      // pipeline, too heavy per slider tick.
      const entryName = isPrimTile ? 'default' : vpId;
      const merged = { ...(mvAll?.default ?? {}), ...(isPrimTile ? {} : (mvAll?.[entryName] ?? {})) };
      // The entry can carry a RAW css `transform` — a %-position centering
      // `translate(-50%, -50%)` — that is NOT a motion x/y prop, so
      // motionPropsToCSSTransform silently DROPS it and the preview jumps by
      // half the element. The rotate HANDLE keeps it (its mergeRotation
      // preview preserves non-rotation parts), so slider != handle offset
      // (live find 2026-09-05, X-arm on variant-1). Compose the base
      // transform's non-rotate parts back in front of the motion fold.
      const baseCss = typeof merged.transform === 'string'
        ? merged.transform.replace(/\s*rotate\([^)]*\)/gi, '').trim()
        : '';
      const motionFold = motionPropsToCSSTransform({ ...merged, rotate: n });
      const folded = baseCss ? `${baseCss} ${motionFold}`.trim() : motionFold;
      // Pivot carrier + legacy-attr clear FIRST, or the slider preview spins
      // around the wrapper's default origin and compounds with an old
      // rotate() attr — offset for the whole drag, snapping right only at
      // the debounced commit (same fix as the rotate handle, 2026-09-05).
      applyVariantRotatePreviewBase(nodeId, getViewportPrefix(vpId), vpId);
      getCanvasBridge().patchStyles(nodeId, getViewportPrefix(vpId), { transform: folded }, true);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => {
        commitVariantRotation(nodeId, vpId, n);
      }, 250);
    };
  } else if (nodeId && node && shapeChild) {
    const existing = parseSvgRotate(shapeChild.node.attrs?.transform);
    // Read: prefer the inner shape's rotate() attr, fall back to a legacy CSS
    // transform on the <svg> wrapper (pre-attribute-rotation source).
    num = existing ? existing.angle : parseRotateDeg(node.styles?.transform || '');
    write = (n: number) => {
      // Pivot (cx,cy) in the shape's user space: reuse the one baked into an
      // existing rotate(a cx cy), else the painted-geometry bbox center.
      let cx: number, cy: number;
      if (existing) {
        cx = existing.cx;
        cy = existing.cy;
      } else {
        const bbox = findNodeComputedStyles(nodeId, vpId, ['__bboxX', '__bboxY', '__bboxWidth', '__bboxHeight']);
        const bx = parseFloat(bbox.__bboxX);
        const by = parseFloat(bbox.__bboxY);
        const bw = parseFloat(bbox.__bboxWidth);
        const bh = parseFloat(bbox.__bboxHeight);
        if (![bx, by, bw, bh].every(Number.isFinite)) {
          // No geometry bbox — fall back to the CSS path so rotation still works.
          if (n === 0) onChange('');
          else updateMultipleStyles({ transform: `rotate(${n}deg)`, transformOrigin: '50% 50%' });
          return;
        }
        cx = bx + bw / 2;
        cy = by + bh / 2;
      }
      const attr = mergeSvgRotate(shapeChild.node.attrs?.transform || '', n, cx, cy);
      // Source persistence + instant iframe-DOM feedback — same dual-write
      // pattern SvgShapeTool uses for fill/stroke attrs.
      queueMutation({ type: 'updateSvgAttrs', nodeId, attrs: { transform: attr }, childIndex: 0 });
      const bridge = getCanvasBridge() as {
        setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
      };
      bridge.setChildShapeAttribute?.(nodeId, getViewportPrefix(vpId), 0, 'transform', attr || null);
      // Drop any legacy CSS transform on the <svg> wrapper so it can't fight the attr.
      if (node.styles?.transform) updateStyle('transform', '');
    };
  } else {
    // `value` is the CSS `transform` value as stored. Parse degrees out.
    num = parseRotateDeg(value || '');
    // A GROUP <svg> (or any svg that fell through the shape-attr path)
    // rotates via a CSS transform on the wrapper. SVG elements default
    // their `transform-origin` to `0 0`, so `rotate()` orbits the top-left
    // corner ("crazy weird"). We pivot on the PAINTED-CONTENT centre — NOT
    // the box centre — because a group whose child was dragged outside the
    // original box (stale, not-yet-refit: child `y="-1133"` while the box
    // is `0 0 1370 389`) has its visible content far off the box, and
    // box-centre rotation would swing it in a huge arc. `getBBox` (served
    // as `__bbox*`) gives the content bbox in user units; the group's
    // viewBox is always `0 0 W H` at 1:1, so those units are px from the
    // border-box top-left. `transform-box: border-box` + an explicit
    // `Npx Npx` origin pins the pivot to the content centre deterministically
    // (no reliance on fill-box's browser-specific outer-svg semantics). The
    // selection overlay tracks it because `cornersForElement` derives the
    // rotated corners from the SAME rendered box (getBoxQuads).
    const isSvg = node?.type === 'svg';
    write = (n: number) => {
      // Empty string at zero so the property round-trips as "no rotation"
      // and doesn't accumulate a dead `transform: rotate(0deg)` in source.
      if (n === 0) {
        if (isSvg) updateMultipleStyles({ transform: '', transformBox: '', transformOrigin: '' });
        else onChange('');
      } else if (isSvg) {
        updateMultipleStyles({
          transform: `rotate(${n}deg)`,
          ...(nodeId ? svgPivotStyles(nodeId, vpId) : { transformBox: 'fill-box', transformOrigin: 'center' }),
        });
      } else {
        updateMultipleStyles({
          transform: `rotate(${n}deg)`,
          transformOrigin: '50% 50%',
        });
      }
    };
  }

  const writeRaw = (s: string) => {
    const n = parseFloat(s);
    if (!Number.isFinite(n)) {
      // Allow partial input ("-", "") to round-trip for the CSS path; the
      // SVG path has no string-valued style to fall back to.
      if (!shapeChild) onChange(s);
      return;
    }
    write(n);
  };
  const shownNum = liveRotate ?? num;
  return (
    <div className="flex items-center gap-2 w-full">
      <ToolSlider value={shownNum} min={-360} max={360} step={1} onChange={write} />
      <ToolInput value={String(Math.round(shownNum * 10) / 10)} onChange={writeRaw} step={1} chevronLabel="deg" />
    </div>
  );
}

export function RotateControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="transform" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Rotate"><RotateAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
