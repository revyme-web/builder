// PinControl.tsx — Pin grid matching old builder's exact layout:
//   Top input (centered, 80px)
//   [Left input 80px] [3×3 pin grid 96px] [Right input 80px]
//   Bottom input (centered, 80px)
// Pin buttons: T/L/R/B with blue highlight when active, center = pin/unpin all.
// Inputs always visible, disabled when pin is inactive.

import { useCallback, useMemo, useEffect, useRef } from 'react';
import { useLivePreview } from '../../hooks/useLivePreview';
import { useAtomValue } from 'jotai';
import { canvasInteractingAtom, getNodeFromCache } from '@/code/stores/store';
import { containerOverridesAtom } from '@/code/stores/container-query-store';
import { viewportsConfigAtom } from '@/code/stores/viewport-store';
import { ToolInput } from '../../controls';
import { getPinState, mergeVariantPinStyles, type PinSide } from '@/shared/pin-utils';
import { isPrimaryViewport } from '@/shared/constants';
import { type VisualRect, toPercentageCenter, toFixedPin, toInsetMode, fromInsetMode, stripTranslateTransforms, buildAxisCenterTransform, centeringChannel, extractAxisTranslate } from '@/shared/position-utils';
import { applyReplicaClearSemantics } from './replica-clears';
import { trace } from '@/shared/debug-trace';
import { captureVisualRect } from '@/canvas/visual-rect';
import { findNodeComputedStyle } from '@/canvas/node-ops';
import { livePinValues } from './live-pin-values';
import { pinFieldDisplayPx, pinFieldCommitValue, paintedPinPx } from './pin-field-units';
import { translateOffsetPx } from '@/canvas/resize/size-input-compensation';
import { pinFieldEditWrite, isHorizontalSide } from './pin-field-resize';
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
      // Live position values: the LAYOUT box (rotation undone), each side in
      // the SOURCE's own unit, only for the sides the source declares — so a
      // pan shows the same numbers as rest and a drag ends where it lands
      // (see live-pin-values.ts). Source styles are read from the cache so a
      // mid-gesture inset write (resize) is reflected.
      const liveStylesNow = getNodeFromCache(nodeId)?.styles ?? styles;
      const rect = captureVisualRect(nodeId, vpId);
      if (rect) {
        const pos = livePinValues({ styles: liveStylesNow, rect, parentWidth: rect.parentWidth, parentHeight: rect.parentHeight });
        setLivePos((prev) =>
          prev && prev.left === pos.left && prev.top === pos.top && prev.right === pos.right && prev.bottom === pos.bottom
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
        // COMPONENT VARIANT tile: the tile's pins live in motionVariants,
        // not the cache's base styles — without this merge, any interaction
        // (even a canvas PAN sets canvasInteracting) flipped the badges to
        // the MASTER's pins and useLivePreview held them after (user report
        // 2026-08-26: "pan restores all the pin sides"). Values may lag the
        // entry mid-drag but px/%/auto CLASSIFICATION — all pins read — is
        // value-independent.
        effectiveStyles = mergeVariantPinStyles(
          effectiveStyles,
          liveNode.motionVariants,
          !vpId || isPrimaryViewport(vpId) ? 'default' : vpId,
        );
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

  // Parent box for percent↔px on the fields. A percent side has to be resolved
  // against it or the field shows the percent NUMBER as px and commits it back
  // as px (see pin-field-units.ts). Re-read whenever a displayed value changes
  // — captureVisualRect is a rect-cache read, no iframe round trip.
  const parentBox = useMemo(
    () => captureVisualRect(nodeId, vpId),
    [nodeId, vpId, displayLeft, displayTop, displayRight, displayBottom],
  );
  const parentW = parentBox?.parentWidth ?? 0;
  const parentH = parentBox?.parentHeight ?? 0;

  // A side the source does not declare still has a real painted distance. Show
  // it, or the field reads 0 and the first chevron throws the element against
  // that edge (see paintedPinPx).
  const painted = useMemo(
    () => parentBox
      ? paintedPinPx(parentBox,
          translateOffsetPx(styles.transform, 'x', parentBox.width),
          translateOffsetPx(styles.transform, 'y', parentBox.height))
      : null,
    [parentBox, styles.transform],
  );
  const fieldPx = (side: PinSide, source: string, total: number): number =>
    source ? pinFieldDisplayPx(source, total) : (painted?.[side] ?? 0);

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
  // Shared implementation — see canvas/visual-rect.ts (also used by the shape
  // position model in resize start / align / X-Y fields).
  const captureRectViaBridge = useCallback((): VisualRect | null => captureVisualRect(nodeId, vpId), [nodeId, vpId]);

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

    // Non-primary channel: '' clears of base-carried props must become
    // explicit neutrals ('auto'), else the deleted variant/band key just
    // re-exposes the base value — unpinning R/B on a variant kept them
    // pinned (user report 2026-08-26).
    newStyles = applyReplicaClearSemantics(nodeId, vpId, newStyles);
    // MOTION-SHORTHAND CENTERING: this node centres via motion `x`/`y`, not a
    // CSS translate string (how the rotation commit stores a pin). Route the
    // toggled axis into that channel and never emit `transform` for it — on a
    // motion element `transform: ''` is the rotation RESET (wipes the entry's
    // rotate), and mixing channels doubles the shift (Renderer folds string
    // then shorthands; live find 2026-09-05). The generators evict any stale
    // string translate on the x/y write.
    if (centeringChannel(styles) === 'shorthand' && typeof newStyles.transform === 'string') {
      const axis = isHoriz ? 'x' : 'y';
      const part = extractAxisTranslate(newStyles.transform, axis);
      newStyles[axis] = part ? part.replace(/^translate[XY]\(\s*|\s*\)$/g, '') : '';
      const visuals = stripTranslateTransforms(newStyles.transform);
      if (visuals) newStyles.transform = visuals; else delete newStyles.transform;
    }
    trace.action('pin:toggle', { nodeId, side, wasPinned, newStyles, rect, elTransform: styles.transform, elLeft: styles.left, elTop: styles.top });
    onUpdateMultiple(newStyles);
    // Lock dynamic pinning — user has expressed an explicit pin choice.
    // Cleared on next reparent (AbsoluteInFrameStrategy strips it).
    lockNodePinning(nodeId);
  }, [styles, pins, nodeId, vpId, captureRectViaBridge, onUpdateMultiple]);

  const handlePinAll = useCallback(() => {
    const rect = captureRectViaBridge();
    if (!rect) return;

    // Same non-primary clear translation as handlePinToggle: unpin-all's
    // right/bottom '' and pin-all's width/height/transform '' leak the base
    // value back on a variant/band channel without it.
    if (allPinned) {
      // Unpin all → percentage centering mode
      const newStyles = toPercentageCenter(rect, styles.transform);
      onUpdateMultiple(applyReplicaClearSemantics(nodeId, vpId, newStyles));
    } else {
      // Pin all → full inset mode (no width/height, strip translate centering)
      const h = toInsetMode('horizontal', rect);
      const v = toInsetMode('vertical', rect);
      const stripped = stripTranslateTransforms(styles.transform);
      onUpdateMultiple(applyReplicaClearSemantics(nodeId, vpId, { ...h, ...v, transform: stripped || '' }));
    }
    trace.action('pin:toggle-all', { nodeId, allPinned });
    lockNodePinning(nodeId);
  }, [allPinned, nodeId, vpId, styles.transform, captureRectViaBridge, onUpdateMultiple]);

  // A chevron drag is ONE gesture, anchored to the state it started from —
  // exactly what `resize:start` captures (startWidth/startHeight) and what
  // every frame of a handle drag measures against. Deriving each frame from the
  // PREVIOUS one instead makes the zero crossing oscillate: the box mirrors to
  // 1px, the next step shrinks that 1px back to 0, and it ping-pongs 0-1-0-1
  // instead of growing back out (user report 2026-09-20). Anchored to the
  // start, the size is `startSize − totalDelta`, which passes through zero and
  // keeps going.
  const gesture = useRef<{ side: PinSide; startValue: number; box: VisualRect | null } | null>(null);
  useEffect(() => { gesture.current = null; }, [nodeId, vpId]);

  /** What the field reads right now, in px — the base of a fresh gesture. */
  const currentFieldPx = useCallback((side: PinSide) => fieldPx(
    side,
    side === 'left' ? displayLeft : side === 'right' ? displayRight : side === 'top' ? displayTop : displayBottom,
    isHorizontalSide(side) ? parentW : parentH,
  ), [displayLeft, displayRight, displayTop, displayBottom, parentW, parentH, painted]);

  const writeField = useCallback((side: PinSide, value: string, live: boolean) => {
    const valuePx = parseFloat(value);
    if (!Number.isFinite(valuePx)) { onUpdate(side, value); lockNodePinning(nodeId); return; }

    // A live frame continues the gesture; anything else (arrow key, typed
    // value) is its own one-shot measured from the current state.
    let g = gesture.current;
    if (!live || !g || g.side !== side) {
      g = { side, startValue: currentFieldPx(side), box: captureRectViaBridge() };
      if (live) gesture.current = g; else gesture.current = null;
    }

    const write = pinFieldEditWrite({
      side, valuePx, basePx: g.startValue, styles, box: g.box,
      parentWidth: g.box?.parentWidth ?? 0,
      parentHeight: g.box?.parentHeight ?? 0,
      matrixStr: findNodeComputedStyle(nodeId, vpId, 'transform') || 'none',
    });
    const keys = Object.keys(write);
    if (keys.length === 1 && keys[0] === side) {
      // A plain move: keep the caller's own unit handling (a % source stays %).
      onUpdate(side, value);
    } else {
      // Same clear semantics as handlePinToggle — on a variant/band channel a
      // '' would re-expose the base value instead of removing the property.
      const newStyles = applyReplicaClearSemantics(nodeId, vpId, write);
      trace.action('pin:field-edge-resize', { nodeId, side, value, live, startValue: g.startValue, newStyles });
      onUpdateMultiple(newStyles);
    }
    // Typing a value into a pin field counts as a manual pin choice.
    lockNodePinning(nodeId);
  }, [onUpdate, onUpdateMultiple, nodeId, vpId, styles, captureRectViaBridge, currentFieldPx]);

  const handleValueChange = useCallback((side: PinSide, value: string) => writeField(side, value, false), [writeField]);
  const handleValueLive = useCallback((side: PinSide, value: string) => writeField(side, value, true), [writeField]);
  // The release value, written as the gesture's last frame so the committed
  // state matches the number the field ends on, then the gesture closes.
  const handleValueCommit = useCallback((side: PinSide, value: string) => {
    writeField(side, value, true);
    gesture.current = null;
  }, [writeField]);

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
          {/* Whole numbers on display; the source keeps its precision (see
              ToolInput.roundLengthForDisplay — these fields pass a bare number,
              so they round here). */}
          <ToolInput
            value={`${Math.round(fieldPx('top', displayTop, parentH))}`}
            onChange={(v) => handleValueChange('top', pinFieldCommitValue(v, displayTop, parentH))}
            onChangeLive={(v) => handleValueLive('top', pinFieldCommitValue(v, displayTop, parentH))}
            onCommit={(v) => handleValueCommit('top', pinFieldCommitValue(v, displayTop, parentH))}
          />
        </div>
      </div>

      {/* Middle row: Left input + Pin grid + Right input */}
      <div className="flex items-center justify-center gap-2">
        {/* Left input */}
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${Math.round(fieldPx('left', displayLeft, parentW))}`}
            onChange={(v) => handleValueChange('left', pinFieldCommitValue(v, displayLeft, parentW))}
            onChangeLive={(v) => handleValueLive('left', pinFieldCommitValue(v, displayLeft, parentW))}
            onCommit={(v) => handleValueCommit('left', pinFieldCommitValue(v, displayLeft, parentW))}
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
            value={`${Math.round(fieldPx('right', displayRight, parentW))}`}
            onChange={(v) => handleValueChange('right', pinFieldCommitValue(v, displayRight, parentW))}
            onChangeLive={(v) => handleValueLive('right', pinFieldCommitValue(v, displayRight, parentW))}
            onCommit={(v) => handleValueCommit('right', pinFieldCommitValue(v, displayRight, parentW))}
          />
        </div>
      </div>

      {/* Bottom input — centered, 80px */}
      <div className="flex justify-center">
        <div style={{ width: 80 }}>
          <ToolInput
            value={`${Math.round(fieldPx('bottom', displayBottom, parentH))}`}
            onChange={(v) => handleValueChange('bottom', pinFieldCommitValue(v, displayBottom, parentH))}
            onChangeLive={(v) => handleValueLive('bottom', pinFieldCommitValue(v, displayBottom, parentH))}
            onCommit={(v) => handleValueCommit('bottom', pinFieldCommitValue(v, displayBottom, parentH))}
          />
        </div>
      </div>
    </div>
  );
}
