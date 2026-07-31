import React, { useRef, useLayoutEffect, useEffect } from 'react';
import { repositionSignalOps } from '@/canvas/drag/reposition-signal';
import { trace } from '@/shared/debug-trace';
import type { ScreenCorners } from '@/canvas/resize/geometry-utils';

// Tunables for the selection reposition fade.
const FADE_MS = 120;   // duration of the fade-in
const MOVE_PX = 0.5;   // centre move (px) that counts as the box reaching its new slot
// Safety-net ONLY. The real reveal is the corners-MOVE (drag spot → new slot) — it
// fires EXACTLY when the async remeasure lands, however long that takes. This timer
// just un-sticks the overlay if a remeasure never arrives, so it MUST outlast the
// worst-case remeasure: at 8 frames a slow drop fired this BEFORE the move landed →
// reveal at the stale drag spot = the intermittent flash. The overlay always mounts
// at the stale spot (it's hidden mid-drag, mounts on drop before the remeasure), so
// the "mounts already-settled, no move to detect" case this guards ~never happens —
// making it long is free.
const REVEAL_FALLBACK_FRAMES = 45;
// Reveal when the corners have been STABLE this many consecutive frames while
// hidden. Since the fast drop path (reparentLive + emitRectAndCornersFor-
// Element + the deferred structural fan-out) lands the node's rect BEFORE the
// overlay even mounts, the "mounts already-settled" case became the NORM for
// reparent/unparent drops — there's no move left to detect, and the reveal
// silently rode the 45-frame (~750ms) fallback: the "selection overlay takes
// half a second to reappear after reparent" report. Every remeasure source is
// imperative now (reparentLive / restoreNode emit rects within ~2-4 frames of
// the drop), so 8 quiet frames (~130ms) safely means "settled" — a genuinely
// stale mount would have seen its move by then (and the move branch reveals
// first).
const STABLE_REVEAL_FRAMES = 8;
const KEYFRAME = 'revyme-selection-fade-in';

// Inject the keyframe once (parent-frame overlay; a single global <style>).
let _kfInjected = false;
function ensureKeyframe(): void {
  if (_kfInjected || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.textContent = `@keyframes ${KEYFRAME}{from{opacity:0}to{opacity:1}}`;
  document.head.appendChild(style);
  _kfInjected = true;
}

interface SelectionFadeProps {
  /** The selection's current screen corners — used to detect the new-slot settle. */
  corners: ScreenCorners | null;
  /** Optional LIVE cornersCache read (bypasses the React prop poll). The fast
   *  drop path freshens the cache within ~60ms of mouseup, but the `corners`
   *  prop rides an rAF poll that the post-drop long tasks starve — probing the
   *  cache directly lets the reveal fire at the FIRST available frame after
   *  the remeasure lands instead of waiting out the whole busy window. */
  liveCornersProbe?: () => ScreenCorners | null;
  children: React.ReactNode;
}

/**
 * Higher-order wrapper that hides its children (one shared opacity) the moment a
 * drag strategy COMMITS a layout reposition, then SMOOTHLY fades them back in
 * (~0.5s) once the selection's rect remeasures to the node's new slot.
 *
 * Why hide-then-fade: the overlay is UNMOUNTED while dragging and MOUNTS on drop,
 * and the `restoreNode` DOM move is an async bridge round-trip — so the overlay
 * first paints at the STALE drag (cursor) position before snapping to the new
 * slot. A plain fade would fade IN at that stale spot, then jump. Hiding until
 * the corners actually change to the new slot means the user never sees it.
 *
 * The reposition pulse (`repositionSignalOps`) fires BEFORE this remounts, so we
 * claim it two ways: a live subscription (if we happen to be mounted) AND a
 * `consume()` on mount (the normal case — overlay appears on drop). Triggered
 * ONLY by that pulse (layout reorder); it does NOT fade on click-SELECT (no
 * pulse → instant), resize (box tracks the handle live; never signals), or
 * pan/zoom.
 *
 * The fade replays via a CSS-animation restart on a ref (no React re-mount, so
 * handle refs / pointer capture survive).
 */
export default function SelectionFade({ corners, liveCornersProbe, children }: SelectionFadeProps) {
  ensureKeyframe();
  const ref = useRef<HTMLDivElement>(null);
  const lastCenter = useRef<{ cx: number; cy: number } | null>(null);
  const pendingReveal = useRef(false);
  const revealRaf = useRef<number | null>(null);
  // Bumped whenever the corners prop delivers a DIFFERENT centre — the hide
  // ticker below watches it to detect stability (see STABLE_REVEAL_FRAMES).
  const centerEpoch = useRef(0);
  // Latest live-cache probe (render-scoped closure → ref so the ticker always
  // calls the current one).
  const probeRef = useRef<(() => ScreenCorners | null) | undefined>(liveCornersProbe);
  probeRef.current = liveCornersProbe;

  // reveal via a ref so the effects don't carry it in their dep arrays (it
  // closes over stable refs only). `animate` → imperative fade restart;
  // otherwise un-hide instantly.
  const revealRef = useRef<(animate: boolean) => void>(() => {});
  revealRef.current = (animate: boolean) => {
    if (!pendingReveal.current) return;
    pendingReveal.current = false;
    if (revealRaf.current != null) { cancelAnimationFrame(revealRaf.current); revealRaf.current = null; }
    const el = ref.current;
    if (animate && el) {
      // IMPERATIVE fade restart — the old setNonce → effect path needed a
      // React render, which the post-drop long tasks starve for hundreds of
      // ms (the reveal fired at ~67ms but the opacity only cleared when React
      // got around to the nonce commit at ~450ms). Direct DOM writes make the
      // fade start the same frame the reveal decision is made.
      el.style.opacity = '';
      el.style.animation = 'none';
      void el.offsetHeight; // reflow so the animation restarts from 0
      el.style.animation = `${KEYFRAME} ${FADE_MS}ms ease-out`;
    } else if (el) {
      el.style.opacity = '';
      el.style.animation = 'none';
    }
    trace.action('selection-fade:reveal', { animate });
  };

  // Hide NOW + arm the reveal. The DOM write is synchronous so opacity:0 lands
  // before the next paint (whether called from the mount-check below or the live
  // subscription inside the drop event).
  const beginHideRef = useRef<() => void>(() => {});
  beginHideRef.current = () => {
    const el = ref.current;
    if (!el) return;
    el.style.animation = 'none';
    el.style.opacity = '0';
    pendingReveal.current = true;
    trace.action('selection-fade:repo-hide', {});
    // Safety net only (see REVEAL_FALLBACK_FRAMES). The real reveal is the
    // corners-watch firing when the rect changes from the stale drag spot to the
    // new slot — which lands whenever the async remeasure does. This timer must
    // outlast that, so it only ever fires if a remeasure never arrives.
    if (revealRaf.current != null) cancelAnimationFrame(revealRaf.current);
    let frames = 0;
    let stableFrames = 0;
    let epochAtLastTick = centerEpoch.current;
    // Hide-time centre — the live-probe reveal compares the CURRENT cache
    // against this to detect "the remeasure landed" without waiting for the
    // (rAF-starved) corners prop to catch up. Prefer the PROBE's value (the
    // cache still holds the pre-drop rect at hide time): on the normal path
    // the hide runs in the mount useLayoutEffect BEFORE the corners effect has
    // ever populated lastCenter, so the prop-derived centre is null there.
    const probedAtHide = probeRef.current?.();
    const hideCenter = probedAtHide
      ? { cx: (probedAtHide.TL.x + probedAtHide.BR.x) / 2, cy: (probedAtHide.TL.y + probedAtHide.BR.y) / 2 }
      : (lastCenter.current ? { ...lastCenter.current } : null);
    const tick = () => {
      if (!pendingReveal.current) { revealRaf.current = null; return; }
      // LIVE-CACHE reveal (primary for the fast drop path): the bridge's
      // cornersUpdate lands in the cache between the parent's long tasks —
      // long before the overlay's poll delivers a new `corners` prop. The
      // moment the cache centre differs from the hide-time centre, the node's
      // remeasured slot is known → fade in at the FIRST available frame.
      const probed = probeRef.current?.();
      if (probed && hideCenter) {
        const pcx = (probed.TL.x + probed.BR.x) / 2;
        const pcy = (probed.TL.y + probed.BR.y) / 2;
        const remeasured = Math.abs(pcx - hideCenter.cx) > MOVE_PX || Math.abs(pcy - hideCenter.cy) > MOVE_PX;
        // Only reveal once the overlay's PAINTED position (lastCenter — what
        // the React-rendered lines actually show) has caught up with the
        // cache — otherwise we'd un-hide stale lines at the pre-drop spot and
        // resurrect the old mouseup blink.
        const lc = lastCenter.current;
        const contentFresh = !!lc && Math.abs(lc.cx - pcx) <= MOVE_PX && Math.abs(lc.cy - pcy) <= MOVE_PX;
        if (remeasured && contentFresh) {
          revealRef.current(true);
          return;
        }
      }
      // STABILITY reveal: the fast drop path can settle the rect BEFORE the
      // overlay mounts (drop-back-in-place → no move at all). If the corners
      // haven't changed for STABLE_REVEAL_FRAMES straight, the box is at its
      // final slot — fade it in instead of riding the long fallback.
      if (centerEpoch.current === epochAtLastTick) {
        if (++stableFrames >= STABLE_REVEAL_FRAMES) { revealRef.current(true); return; }
      } else {
        epochAtLastTick = centerEpoch.current;
        stableFrames = 0;
      }
      if (++frames >= REVEAL_FALLBACK_FRAMES) { revealRef.current(true); return; }
      revealRaf.current = requestAnimationFrame(tick);
    };
    revealRaf.current = requestAnimationFrame(tick);
  };

  // MOUNT CHECK (the normal case): the overlay appears on drop, AFTER the pulse
  // fired. Claim the latched flag and hide pre-paint (useLayoutEffect runs before
  // the first paint of the mounted overlay, so the stale drag frame is hidden).
  useLayoutEffect(() => {
    if (repositionSignalOps.consume()) beginHideRef.current();
  }, []);

  // LIVE SUBSCRIPTION (rare: overlay happened to stay mounted across the drop) —
  // hide synchronously inside the drop event.
  useEffect(() => {
    const unsub = repositionSignalOps.subscribe(() => {
      if (repositionSignalOps.consume()) beginHideRef.current();
    });
    return unsub;
  }, []);

  // Reveal on the first real settle while hidden. With no hide pending this is a
  // pure baseline update, so click-select stays instant (no fade path at all).
  useLayoutEffect(() => {
    if (!corners) { lastCenter.current = null; return; }
    const cx = (corners.TL.x + corners.BR.x) / 2;
    const cy = (corners.TL.y + corners.BR.y) / 2;
    const p = lastCenter.current;
    lastCenter.current = { cx, cy };
    const moved = !!p && (Math.abs(p.cx - cx) > MOVE_PX || Math.abs(p.cy - cy) > MOVE_PX);
    if (moved || !p) centerEpoch.current++; // any delivery of a new centre resets the stability clock
    if (!pendingReveal.current || !p) return;
    if (moved) {
      revealRef.current(true); // settled at the new slot → fade in
    }
  }, [corners]);

  // Cancel any pending fallback rAF on unmount.
  useLayoutEffect(() => () => {
    if (revealRaf.current != null) cancelAnimationFrame(revealRaf.current);
  }, []);

  // position:fixed + inset:0 + pointer-events:none = a transparent group box
  // that doesn't reposition the (also position:fixed, viewport-relative)
  // children or intercept pointer events; its opacity hides/animates them all
  // together. Rendered after the hover/parent highlights so it stacks above.
  return (
    <div ref={ref} data-selection-fade="" style={{ position: 'fixed', inset: 0, pointerEvents: 'none' }}>
      {children}
    </div>
  );
}
