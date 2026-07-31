// transform/CameraAnimator.ts — Smooth animated camera transitions.
// Eased zoom/pan with cancellation support.
// All camera commands that need animation go through here.

import { transformManager } from './TransformManager';
import { trace } from '@/shared/debug-trace';
import { getDefaultStore } from 'jotai';
import { useSmoothZoomAtom } from '@/code/stores/user-preferences-store';

/** Ease-out cubic: fast start, smooth deceleration */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

let animationFrameId: number | null = null;
const onAnimStart: (() => void) | null = null;
const onAnimEnd: (() => void) | null = null;

/** Cancel any running animation */
function cancelAnimation(): void {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    trace.action('camera:animation-cancelled');
  }
}

/**
 * Move camera instantly (no animation).
 */
export function moveCanvasTo(x: number, y: number, scale: number): void {
  cancelAnimation();
  trace.fn('camera.moveCanvasTo', { x, y, scale });
  transformManager.setTransform({ x, y, scale });
}

/**
 * Animate camera to target position with easing.
 * @param duration — animation duration in ms (default 300)
 */
export function animateCanvasTo(
  targetX: number,
  targetY: number,
  targetScale: number,
  duration: number = 300,
): void {
  cancelAnimation();

  // Smooth-zoom pref OFF → snap directly to the target. Routing through
  // moveCanvasTo skips the easing loop entirely so the user gets
  // single-frame jumps for every zoom-to-fit / Ctrl++/− / variant pan
  // in the codebase. Single chokepoint — every camera command
  // (`zoomIn`/`zoomOut`/`zoomTo100`/`zoomToFit`/`panToNode`/etc.) goes
  // through this function, so flipping the pref controls all of them.
  if (!getDefaultStore().get(useSmoothZoomAtom)) {
    moveCanvasTo(targetX, targetY, targetScale);
    return;
  }

  trace.fn('camera.animateCanvasTo', { targetX, targetY, targetScale, duration });

  onAnimStart?.();

  const start = transformManager.getTransform();
  const startTime = performance.now();

  const animate = (currentTime: number) => {
    if (animationFrameId === null) return; // cancelled

    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(progress);

    const currentX = start.x + (targetX - start.x) * eased;
    const currentY = start.y + (targetY - start.y) * eased;
    const currentScale = start.scale + (targetScale - start.scale) * eased;

    transformManager.setTransform({ x: currentX, y: currentY, scale: currentScale });

    if (progress < 1) {
      animationFrameId = requestAnimationFrame(animate);
    } else {
      animationFrameId = null;
      // Ensure final values are exact
      transformManager.setTransform({ x: targetX, y: targetY, scale: targetScale });
      onAnimEnd?.();
      trace.action('camera:animation-complete', { targetX, targetY, targetScale });
    }
  };

  animationFrameId = requestAnimationFrame(animate);
}
