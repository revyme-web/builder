// PinControl.tsx — Pin grid matching old builder's exact layout:
//   Top input (centered, 80px)
//   [Left input 80px] [3×3 pin grid 96px] [Right input 80px]
//   Bottom input (centered, 80px)
// Pin buttons: T/L/R/B with blue highlight when active, center = pin/unpin all.
// Inputs always visible, disabled when pin is inactive.

import { useCallback, useMemo, useEffect } from 'react';
import { useLivePreview } from '../../hooks/useLivePreview';
import { useAtomValue } from 'jotai';
import { canvasInteractingAtom, getNodesSnapshot, getNodeFromCache } from '@/code/stores/store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { ToolInput } from '../../controls';
import { getPinState, parsePx, type PinSide } from '@/shared/pin-utils';
import { findNodeRect, findNodeComputedStyles, findNodeParentInnerSize } from '@/canvas/node-ops';
import { transformManager } from '@/canvas/transform';
import { type VisualRect, toPercentageCenter, toFixedPin, toInsetMode, fromInsetMode, stripTranslateTransforms, buildAxisCenterTransform } from '@/shared/position-utils';
import { trace } from '@/shared/debug-trace';
import { queueMutation } from '@/code/mutation/mutation-queue';

/** Mark a node as user-pinned so AbsoluteInFrameStrategy stops auto-
 *  picking pin sides on drag. Cleared automatically on any reparent. */
function lockNodePinning(nodeId: string): void {
  queueMutation({
    type: 'updateHtmlAttrs',
    nodeId,
    attrs: { 'data-pinned': 'true' },
  });
}

interface Props {
  styles: Record<string, string>;
  nodeId: string;
  vpId: string;
  onUpdate: (key: string, value: string) => void;
  onUpdateMultiple: (styles: Record<string, string>) => void;
}

export default function PinControl({ styles, nodeId, vpId, onUpdate, onUpdateMultiple }: Props) {
  const isInteracting = useAtomValue(canvasInteractingAtom);
  const containerOverrides = useAtomValue(containerOverridesAtom);
  const viewportsConfig = useAtomValue(viewportsConfigAtom);

  // Live pin-side state during drag. The dynamic-pin strategy mutates
  // `_cachedNodes` per frame via `updateNodeInCache` but doesn't bump
  // `nodesAtom` (a global bump cascades render loops through other
  // components — e.g. SketchEditOverlay). Instead, this RAF poll reads
  // styles directly from the cache via `getNodeFromCache` to drive the
  // T/L/R/B badges live. Cleared on drag end so the prop `styles`
  // (post-commit) takes over.
  // Cleared when styles catch up after the drag commits.
  const [livePins, setLivePins] = useLivePreview<ReturnType<typeof getPinState>>([styles.left, styles.top, styles.right, styles.bottom]);

  // Live position values during drag/resize. The strategies write per-frame
  // movement via `transform: translate()` (compositor-only) — inline left/top
  // and getComputedStyle('left') don't change until commit, so polling those
  // would freeze the inputs at lift values. Instead derive live values from
  // the bridge's rectCache (which reflects the transform offset) by
  // subtracting the parent's screen rect — same math as `captureRectViaBridge`
  // below, but inlined to avoid re-running on every nodes-atom update.
  const [livePos, setLivePos] = useLivePreview<Record<string, string>>([styles.left, styles.top, styles.right, styles.bottom]);
  useEffect(() => {
    if (!isInteracting) return;
    let rafId: number;
    const poll = () => {
      const node = getNodesSnapshot().get(nodeId);
      const parentId = node?.parentId ?? null;
      const elScreen = findNodeRect(nodeId, vpId);
      const parentScreen = parentId ? findNodeRect(parentId, vpId) : null;
      if (elScreen && parentScreen && parentId) {
        const scale = transformManager.getTransform().scale || 1;
        // ALL dimensions derived from the live rectCache, NOT from
        // computedCache. Reason: during inset resize the strategy
        // writes `right`/`bottom` per frame; the rectCache picks that
        // up immediately (it's polled from getBoundingClientRect every
        // render cycle), but the computedCache only refreshes when
        // canvasInteractingAtom releases — so `findNodeComputedStyles`
        // returns the PRE-RESIZE width/height during the drag.
        // Falling back to that stale width here meant `right = parentW
        // - left - staleW` was wrong → the right/bottom inputs froze
        // while only left/top updated. Using `elScreen.width / scale`
        // gives the live width on every frame.
        const elW = elScreen.width / scale;
        const elH = elScreen.height / scale;
        const parentInner = findNodeParentInnerSize(nodeId, vpId);
        const parentW = parentInner.width || parentScreen.width / scale;
        const parentH = parentInner.height || parentScreen.height / scale;
        const parentBorders = findNodeComputedStyles(parentId, vpId, ['borderLeftWidth', 'borderTopWidth']);
        const borderL = parseFloat(parentBorders.borderLeftWidth) || 0;
        const borderT = parseFloat(parentBorders.borderTopWidth) || 0;
        const left = Math.round((elScreen.left - parentScreen.left) / scale - borderL);
        const top = Math.round((elScreen.top - parentScreen.top) / scale - borderT);
        const right = Math.round(parentW - left - elW);
        const bottom = Math.round(parentH - top - elH);
        const pos = { left: `${left}px`, top: `${top}px`, right: `${right}px`, bottom: `${bottom}px` };
        setLivePos((prev) =>
          prev?.left === pos.left && prev?.top === pos.top && prev?.right === pos.right && prev?.bottom === pos.bottom
            ? prev
            : pos,
        );
      }
      // Live pin-side detection from the imperative cache (bypasses
      // jotai). Tracks the dynamic-pin / resize strategies' per-frame
      // `updateNodeInCache(id, cs)` writes for T/L/R/B badge flips.
      //
      // Merge active-viewport @media replica overrides on top of base
      // styles before deriving pins — without this, a replica that was
      // pinned with full inset (left+right+top+bottom on tablet only)
      // shows only base pins (typically just L/T) during resize because
      // the cache holds the BASE styles, not the viewport-effective
      // merged styles. The Position panel would visibly de-select R/B
      // mid-resize and re-select them on mouseup (when React re-renders
      // with the merged ControlProvider styles). Merging here keeps
      // the badges stable across the whole interaction.
      const liveNode = getNodeFromCache(nodeId);
      if (liveNode) {
        const baseStyles = liveNode.styles ?? {};
        const currentVpConfig = viewportsConfig.find(v => v.id === vpId);
        const currentVpMaxWidth = currentVpConfig?.width ?? 0;
        const replicaProps = containerOverrides.get(nodeId)?.get(currentVpMaxWidth);
        let effectiveStyles: Record<string, string> = baseStyles;
        if (replicaProps && replicaProps.size > 0) {
          effectiveStyles = { ...baseStyles };
          for (const [prop, val] of replicaProps) {
            // `auto` from the inset-pin auto-emit (generator-styles.ts)
            // means "compute from insets" — equivalent to NOT having
            // that property for pin detection. Same with empty string
            // (delete-property convention).
            if (val === '' || val === 'auto') delete effectiveStyles[prop];
            else effectiveStyles[prop] = val;
          }
        }
        const newPins = getPinState(effectiveStyles);
        setLivePins((prev) =>
          prev
            && prev.left === newPins.left && prev.right === newPins.right
            && prev.top === newPins.top && prev.bottom === newPins.bottom
            ? prev
            : newPins,
        );
      }
      rafId = requestAnimationFrame(poll);
    };
    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [isInteracting, nodeId, vpId, containerOverrides, viewportsConfig]);

  // Pin-side badges: live during interaction, prop styles otherwise.
  const pins = useMemo(() => livePins ?? getPinState(styles), [livePins, styles]);
  // Use live values during interaction, styles otherwise
  const displayLeft = livePos?.left || styles.left || '';
  const displayTop = livePos?.top || styles.top || '';
  const displayRight = livePos?.right || styles.right || '';
  const displayBottom = livePos?.bottom || styles.bottom || '';
  const allPinned = pins.left && pins.top && pins.right && pins.bottom;

  /**
   * Capture the element's visual rect via the bridge — works in iframe mode
   * where the canvas DOM lives in the sandbox. Returns parent-relative px
   * coordinates that compensate for any `translate(-50%)` centering applied
   * via inline transform.
   *
   * Position math:
   *   • elScreen / parentScreen are bridge-supplied border-box BCRs in parent
   *     screen space. Their delta divided by canvas scale is the layout offset
   *     of the element from the parent's BORDER edge.
   *   • Parent dimensions use clientWidth/clientHeight (padding box) — that's
   *     the containing block CSS uses to resolve absolute children's left/top.
   *   • For elements styled with `translate(-50%)` (percent-center mode), BCR
   *     already shows the visually centered position, so no further fix needed
   *     for non-rotated parents. Rotated parents fall back to inline-style math.
   */
  const captureRectViaBridge = useCallback((): VisualRect | null => {
    const node = getNodesSnapshot().get(nodeId);
    const parentId = node?.parentId;
    if (!parentId) return null;
    const scale = transformManager.getTransform().scale || 1;

    const elScreen = findNodeRect(nodeId, vpId);
    const parentScreen = findNodeRect(parentId, vpId);
    if (!elScreen || !parentScreen) return null;

    const computed = findNodeComputedStyles(nodeId, vpId, ['width', 'height']);
    const width = parseFloat(computed.width) || elScreen.width / scale;
    const height = parseFloat(computed.height) || elScreen.height / scale;

    const parentInner = findNodeParentInnerSize(nodeId, vpId);
    const parentWidth = parentInner.width || parentScreen.width / scale;
    const parentHeight = parentInner.height || parentScreen.height / scale;

    // CSS `left`/`right` for absolute children resolve against the parent's
    // PADDING box, not the border box. The BCR delta gives us offset from the
    // border edge, so subtract parent border widths to land in padding-box
    // coordinates. Skipping this caused inset values to drift each toggle on
    // parents with borders.
    const parentBorders = findNodeComputedStyles(parentId, vpId, ['borderLeftWidth', 'borderTopWidth']);
    const borderL = parseFloat(parentBorders.borderLeftWidth) || 0;
    const borderT = parseFloat(parentBorders.borderTopWidth) || 0;

    // Parent-relative LAYOUT-BOX top-left (not the AABB top-left).
    // `elScreen` is the rotated/scaled SCREEN AABB — for a rotated
    // element the AABB is shifted from the layout box by
    // `(aabbW - layoutW) / 2` on each axis (with default `transform-
    // origin: 50% 50%` the AABB centre coincides with the layout-box
    // centre). Treating `elScreen.left` as the layout-box left would
    // place the layout box at the AABB edge after a pin commit —
    // since the transform reapplies on top, the painted AABB then
    // shifts again, producing the jump-on-toggle the user reported.
    // The fix: derive layout-box top-left from the AABB centre via
    // `layoutLeft = aabbCenterX - layoutW / 2`. Collapses to the
    // original formula for non-rotated elements (aabbW = layoutW).
    const aabbCssW = elScreen.width / scale;
    const aabbCssH = elScreen.height / scale;
    const aabbLeft = (elScreen.left - parentScreen.left) / scale - borderL;
    const aabbTop = (elScreen.top - parentScreen.top) / scale - borderT;
    const left = aabbLeft + (aabbCssW - width) / 2;
    const top = aabbTop + (aabbCssH - height) / 2;

    const centerX = left + width / 2;
    const centerY = top + height / 2;
    const centerXPercent = parentWidth > 0 ? (centerX / parentWidth) * 100 : 50;
    const centerYPercent = parentHeight > 0 ? (centerY / parentHeight) * 100 : 50;

    trace.action('pin:capture-rect', {
      nodeId, vpId, parentId,
      elScreen: { left: elScreen.left, top: elScreen.top, width: elScreen.width, height: elScreen.height },
      parentScreen: { left: parentScreen.left, top: parentScreen.top, width: parentScreen.width, height: parentScreen.height },
      scale, borderL, borderT, parentWidth, parentHeight,
      result: { left, top, width, height },
    });

    return { left, top, width, height, parentWidth, parentHeight, centerXPercent, centerYPercent };
  }, [nodeId, vpId]);

  const handlePinToggle = useCallback((side: PinSide) => {
    // Capture visual rect BEFORE any changes (bridge-aware, works in iframe mode)
    const rect = captureRectViaBridge();
    if (!rect) return;
    const wasPinned = pins[side];
    const oppSide = side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top';
    const oppPinned = pins[oppSide as PinSide];
    const isHoriz = side === 'left' || side === 'right';

    let newStyles: Record<string, string>;

    if (wasPinned) {
      // ─── UNPINNING ───
      if (oppPinned) {
        // Was inset mode → exit inset, restore dimension
        newStyles = fromInsetMode(side, rect);
      } else {
        // Was single pin → check if ANY pin remains on EITHER axis
        const otherAxisHasPin = isHoriz
          ? (pins.top || pins.bottom)
          : (pins.left || pins.right);
        const thisAxisHasOtherPin = oppPinned; // already false here

        // Count total remaining pins after this unpin
        const remainingPins = [
          isHoriz ? false : pins.left,   // don't count this axis
          isHoriz ? false : pins.right,
          !isHoriz ? false : pins.top,
          !isHoriz ? false : pins.bottom,
        ].concat([otherAxisHasPin]).filter(Boolean).length;

        if (remainingPins === 0) {
          // No pins left at all → percentage center mode
          newStyles = toPercentageCenter(rect, styles.transform);
        } else {
          // Other axis still has pins — convert this side from px to percentage
          // so it maintains visual position but isFixedPx() returns false (= unpinned)
          // Unpinning ONE axis converts it to percentage-center; the OTHER axis
          // must render byte-identical. `buildAxisCenterTransform` keeps the
          // other axis's existing translate (e.g. an icon centered on both axes
          // via `translate(-50%, -50%)` — unpinning left kept `translateY(-50%)`
          // so it no longer jumped down half its height; live find 2026-07-24).
          if (isHoriz) {
            const pct = rect.parentWidth > 0 ? ((rect.left + rect.width / 2) / rect.parentWidth) * 100 : 50;
            newStyles = {
              [side]: '',
              left: `${pct.toFixed(4)}%`,
              transform: buildAxisCenterTransform('x', styles.transform),
              width: `${Math.round(rect.width)}px`,
            };
          } else {
            const pct = rect.parentHeight > 0 ? ((rect.top + rect.height / 2) / rect.parentHeight) * 100 : 50;
            newStyles = {
              [side]: '',
              top: `${pct.toFixed(4)}%`,
              transform: buildAxisCenterTransform('y', styles.transform),
              height: `${Math.round(rect.height)}px`,
            };
          }
        }
      }
    } else {
      // ─── PINNING ───
      if (oppPinned) {
        // Opposite already pinned → enter inset mode
        newStyles = toInsetMode(isHoriz ? 'horizontal' : 'vertical', rect);

        // Strip translate centering ONLY for the pinned axis.
        // The other axis may still use percentage + translate centering.
        const t = styles.transform || '';
        const otherAxisInPercent = isHoriz
          ? styles.top?.includes('%')
          : styles.left?.includes('%');

        if (otherAxisInPercent) {
          // Keep the OTHER axis's translate, strip only this axis's
          const visualTransforms = stripTranslateTransforms(t);
          const keepTranslate = isHoriz ? 'translateY(-50%)' : 'translateX(-50%)';
          newStyles.transform = visualTransforms
            ? `${keepTranslate} ${visualTransforms}`
            : keepTranslate;
        } else {
          // No percentage on other axis — strip all translates
          const stripped = stripTranslateTransforms(t);
          newStyles.transform = stripped || '';
        }
      } else {
        // Single pin — pin this side, REMOVE the opposite side's value
        // (CSS ignores bottom when top+height both set, and vice versa)
        newStyles = toFixedPin(side, rect);

        // Remove the opposite side so CSS uses our pinned side for positioning
        newStyles[oppSide] = '';

        // Set explicit dimensions — but ONLY on axes that aren't in inset mode.
        // If L+R are both pinned (horizontal inset), width comes from insets, not explicit.
        const hInset = isHoriz ? false : (pins.left && pins.right); // this axis isn't inset (we're adding a single pin)
        const vInset = !isHoriz ? false : (pins.top && pins.bottom);
        if (!hInset) newStyles.width = `${Math.round(rect.width)}px`;
        if (!vInset) newStyles.height = `${Math.round(rect.height)}px`;

        // Handle transform: strip translate centering for pinned axis,
        // keep single-axis centering for the other axis if it's in % mode
        const t = styles.transform || '';
        const hasTranslateCentering = t.includes('translate(-50%') || t.includes('translateX(-50%') || t.includes('translateY(-50%');
        if (hasTranslateCentering) {
          const visualTransforms = stripTranslateTransforms(styles.transform);
          const otherAxisInPercent = isHoriz
            ? styles.top?.includes('%')
            : styles.left?.includes('%');

          if (otherAxisInPercent) {
            // Keep centering on the OTHER axis only
            const singleAxisTranslate = isHoriz ? 'translateY(-50%)' : 'translateX(-50%)';
            newStyles.transform = visualTransforms
              ? `${singleAxisTranslate} ${visualTransforms}`
              : singleAxisTranslate;
          } else {
            newStyles.transform = visualTransforms || '';
          }
        }
      }
    }

    trace.action('pin:toggle', { nodeId, side, wasPinned, newStyles, rect, elTransform: styles.transform, elLeft: styles.left, elTop: styles.top });
    onUpdateMultiple(newStyles);
    // Lock dynamic pinning — user has expressed an explicit pin choice.
    // Cleared on next reparent (AbsoluteInFrameStrategy strips it).
    lockNodePinning(nodeId);
  }, [styles, pins, nodeId, captureRectViaBridge, onUpdateMultiple]);

  const handlePinAll = useCallback(() => {
    const rect = captureRectViaBridge();
    if (!rect) return;

    if (allPinned) {
      // Unpin all → percentage centering mode
      const newStyles = toPercentageCenter(rect, styles.transform);
      onUpdateMultiple(newStyles);
    } else {
      // Pin all → full inset mode (no width/height, strip translate centering)
      const h = toInsetMode('horizontal', rect);
      const v = toInsetMode('vertical', rect);
      const stripped = stripTranslateTransforms(styles.transform);
      onUpdateMultiple({ ...h, ...v, transform: stripped || '' });
    }
    trace.action('pin:toggle-all', { nodeId, allPinned });
    lockNodePinning(nodeId);
  }, [allPinned, nodeId, styles.transform, captureRectViaBridge, onUpdateMultiple]);

  const handleValueChange = useCallback((side: PinSide, value: string) => {
    onUpdate(side, value);
    // Typing a value into a pin field counts as a manual pin choice.
    lockNodePinning(nodeId);
  }, [onUpdate, nodeId]);

  // Pin button component
  const PinBtn = ({ side }: { side: PinSide }) => {
    const active = pins[side];
    return (
      <button
        onClick={() => handlePinToggle(side)}
        className={`flex items-center justify-center text-xs font-medium cut-corners transition-colors cursor-pointer ${active
          ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
          : 'bg-[var(--control-bg)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]'
        }`}
      >
        {side[0].toUpperCase()}
      </button>
    );
  };

  return (
    <div className="flex flex-col w-full space-y-3">
      {/* Top input — centered, 80px */}
      <div className="flex justify-center mt-2">
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${parsePx(displayTop)}`}
            onChange={(v) => handleValueChange('top', v.includes('px') ? v : `${v}px`)}
          />
        </div>
      </div>

      {/* Middle row: Left input + Pin grid + Right input */}
      <div className="flex items-center justify-center gap-2">
        {/* Left input */}
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${parsePx(displayLeft)}`}
            onChange={(v) => handleValueChange('left', v.includes('px') ? v : `${v}px`)}
          />
        </div>

        {/* 3×3 Pin grid */}
        <div className="grid grid-cols-3 grid-rows-3 gap-2" style={{ width: 96, height: 96 }}>
          <div />
          <PinBtn side="top" />
          <div />
          <PinBtn side="left" />
          {/* Center — pin/unpin all */}
          <button
            onClick={handlePinAll}
            className={`cut-corners transition-colors cursor-pointer hover:bg-[var(--bg-hover)] ${allPinned ? 'bg-[var(--accent)] opacity-20' : 'bg-[var(--border-light)]'}`}
          />
          <PinBtn side="right" />
          <div />
          <PinBtn side="bottom" />
          <div />
        </div>

        {/* Right input */}
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${parsePx(displayRight)}`}
            onChange={(v) => handleValueChange('right', v.includes('px') ? v : `${v}px`)}
          />
        </div>
      </div>

      {/* Bottom input — centered, 80px */}
      <div className="flex justify-center">
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${parsePx(displayBottom)}`}
            onChange={(v) => handleValueChange('bottom', v.includes('px') ? v : `${v}px`)}
          />
        </div>
      </div>
    </div>
  );
}
