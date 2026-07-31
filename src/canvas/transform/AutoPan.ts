// AutoPan.ts — Edge-pan loop for drag / marquee / creator gestures.
//
// While the user is dragging a node (or drawing a marquee / frame / shape /
// text), the canvas pans automatically when the cursor approaches an edge.
// This is the Revyme port of the auto-pan that lives in the sibling
// `builder/` project (src/builder/context/canvas-controller.tsx). Same
// quadratic velocity ramp, same asymmetric edge zones (wider left/right to
// account for the editor's side panels).
//
// Architecture:
//   - One RAF loop, multiple tenants. Each tenant (drag, marquee, creators)
//     sets a flag via `setActive(true/false)`; the loop ticks while at
//     least one is active.
//   - The loop reads the latest mouse position (set via `trackMouse(e)`)
//     and computes a per-axis pan velocity from the cursor's distance to
//     each edge.
//   - On each tick: `transformManager.pan(dx, dy)` moves the canvas, then
//     `onPanTick(dx, dy, scale)` runs the tenant's compensation hook —
//     usually bumping the drag's `startMouse` so the next regular onMove
//     resumes from the compensated baseline (the dragged element appears
//     to stay anchored under the cursor).
//
// Contrast with the existing `computeEdgeAutoPan` in InputHandler.ts: that
// helper is mouse-driven (only ticks on mousemove → stops moving when the
// user holds the cursor still at the edge). This module runs on RAF, so
// the canvas keeps panning as long as the cursor is in the edge zone.

import { getDefaultStore } from 'jotai';
import { transformManager } from './TransformManager';
import {
  AUTOPAN_LEFT_EDGE,
  AUTOPAN_RIGHT_EDGE,
  AUTOPAN_VERTICAL_EDGE,
} from './constants';
import { autoPanSpeedAtom, AUTO_PAN_SPEED_VALUES } from '@/code/stores/user-preferences-store';
import { trace } from '@/shared/debug-trace';

// ─── Edge math ─────────────────────────────────────────────────────────────

/**
 * Compute per-frame pan velocity (in screen px) for the cursor's current
 * position relative to the canvas container.
 *
 * Trigger rule: the cursor must be PHYSICALLY OUTSIDE the canvas area —
 * over the left toolbar, the properties panel, or above/below the canvas
 * region. While the cursor is anywhere inside the canvas (no matter how
 * close to a panel boundary) the pan stays at zero. Speed ramps with how
 * deep into the panel the cursor sits: 1 px past the boundary = min
 * speed, deeper than the panel's full width = capped at max speed.
 *
 * This differs from a pure "edge band" approach where panning starts a
 * few hundred px BEFORE the cursor reaches the panel. Users on canvas-
 * poc found the early trigger jarring — they expect auto-pan to kick in
 * when the cursor visibly enters a panel, not while it's still hovering
 * the canvas.
 *
 * Sign convention: positive `dx` pans the canvas RIGHT (so visible
 * content scrolls left → cursor pulls in from the LEFT panel). Mirrors
 * transformManager.pan().
 */
export function computeAutoPanDelta(
  clientX: number,
  clientY: number,
  containerRect: DOMRect,
): { dx: number; dy: number } {
  // Distance the cursor sits OUTSIDE each edge (negative when inside).
  // Width-of-corresponding-panel acts as the "fully into the panel = max
  // speed" cap — `AUTOPAN_LEFT_EDGE` etc. now represent panel widths,
  // not in-canvas trigger zones.
  const overshootLeft = containerRect.left - clientX;        // > 0 when over left panel
  const overshootRight = clientX - containerRect.right;       // > 0 when over right panel
  const overshootTop = containerRect.top - clientY;           // > 0 when above canvas
  const overshootBottom = clientY - containerRect.bottom;     // > 0 when below canvas

  // Read the live pref each tick — cheap atom get, lets the user tune
  // speed mid-drag (rare, but supported). `mid` preserves the legacy
  // 0.4 / 3.2 ramp; low/high scale ~0.5x and ~2x respectively.
  const speedLevel = getDefaultStore().get(autoPanSpeedAtom);
  const { minScrollSpeed: minSpeed, maxScrollSpeed: maxSpeed } =
    AUTO_PAN_SPEED_VALUES[speedLevel];

  const ramp = (overshoot: number, depth: number): number => {
    if (overshoot <= 0) return 0;
    const pct = Math.min(1, overshoot / depth);
    return minSpeed + (maxSpeed - minSpeed) * pct;
  };

  // Pan canvas RIGHT (positive dx) when cursor is over the LEFT panel,
  // pulling in content from off-screen to the left.
  const left = ramp(overshootLeft, AUTOPAN_LEFT_EDGE);
  const right = -ramp(overshootRight, AUTOPAN_RIGHT_EDGE);
  const up = ramp(overshootTop, AUTOPAN_VERTICAL_EDGE);
  const down = -ramp(overshootBottom, AUTOPAN_VERTICAL_EDGE);

  return { dx: left + right, dy: up + down };
}

// ─── RAF loop ──────────────────────────────────────────────────────────────

/** Per-tick callback. Fired AFTER the canvas has been panned. */
type AutoPanTickFn = (dx: number, dy: number, scale: number) => void;

interface AutoPanController {
  /**
   * Notify the loop of the current cursor position. Call from any
   * mouse/pointer-move handler that's relevant during a tenant gesture
   * (drag, marquee, creator). The loop uses the latest position so even
   * if the cursor stops moving at an edge, panning continues.
   */
  trackMouse: (e: { clientX: number; clientY: number }) => void;
  /**
   * Toggle a tenant's "active" flag. The loop ticks while at least one
   * tenant is active; goes idle (RAF cancelled) when all are false. Names
   * are arbitrary strings — pick anything stable per tenant
   * (`'drag'`, `'marquee'`, `'frame-creator'`, …).
   */
  setActive: (tenant: string, active: boolean) => void;
  /**
   * Subscribe to per-tick updates. The callback fires AFTER the canvas
   * has been panned, giving subscribers a chance to compensate / redraw
   * (drag bumps its anchor, creators re-emit their draw with the last
   * cursor position). Returns an unsubscribe function. Multiple
   * subscribers are supported and all fire each tick — no ordering
   * guarantees.
   */
  onTick: (fn: AutoPanTickFn) => () => void;
  /**
   * Subscribe to "loop went idle" — fires synchronously the moment the
   * last tenant deactivates (i.e. `activeTenants.size` transitions from
   * >0 to 0). Used by Canvas to clear the `canvasInteracting` debounce
   * the transformManager subscriber leaves dangling: every `pan()` call
   * during the loop sets the flag to true with a 100 ms debounce-back-to-
   * false, so when a creator runs `flushNow()` immediately after an
   * auto-panned mouseup, the renderer's interacting-flag check still
   * sees TRUE and suppresses the bridge.render → the new node lands in
   * code but never paints until the user does something else.
   * Returns an unsubscribe function.
   */
  onIdle: (fn: () => void) => () => void;
  /** Detach listeners + cancel any running RAF. Use on unmount. */
  destroy: () => void;
}

/**
 * Create the shared auto-pan loop bound to a canvas container element.
 * Returns a controller; nothing happens until a tenant calls `setActive`
 * and `trackMouse` is fed cursor positions.
 */
export function attachAutoPan(container: HTMLElement): AutoPanController {
  const activeTenants = new Set<string>();
  const lastMouse = { x: 0, y: 0 };
  const tickListeners = new Set<AutoPanTickFn>();
  const idleListeners = new Set<() => void>();
  let rafId: number | null = null;

  const tick = () => {
    rafId = null;
    if (activeTenants.size === 0) return;
    const rect = container.getBoundingClientRect();
    const { dx, dy } = computeAutoPanDelta(lastMouse.x, lastMouse.y, rect);
    if (dx !== 0 || dy !== 0) {
      transformManager.pan(dx, dy);
      const scale = transformManager.getTransform().scale;
      // Snapshot the listener set so a listener that unsubscribes itself
      // mid-fire doesn't trip the iterator.
      const listeners = Array.from(tickListeners);
      for (const fn of listeners) {
        try {
          fn(dx, dy, scale);
        } catch (err) {
          trace.error('autopan:tick-callback-failed', err);
        }
      }
    }
    // Keep ticking as long as a tenant is active. We don't bail when the
    // cursor leaves the edge zone — the next tick just produces zero
    // delta. This avoids the start/stop flicker of a "near-edge" predicate.
    if (activeTenants.size > 0) {
      rafId = requestAnimationFrame(tick);
    }
  };

  return {
    trackMouse: (e) => {
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
    },
    setActive: (tenant, active) => {
      const wasIdle = activeTenants.size === 0;
      if (active) activeTenants.add(tenant);
      else activeTenants.delete(tenant);
      trace.action('autopan:set-active', { tenant, active, total: activeTenants.size });
      if (wasIdle && activeTenants.size > 0 && rafId === null) {
        rafId = requestAnimationFrame(tick);
      }
      // Fire idle listeners synchronously the moment the last tenant
      // deactivates so callers can clear lingering state (canvas-
      // interacting debounce, etc.) before any post-gesture work runs.
      if (!wasIdle && activeTenants.size === 0) {
        const fns = Array.from(idleListeners);
        for (const fn of fns) {
          try { fn(); } catch (err) { trace.error('autopan:idle-callback-failed', err); }
        }
      }
    },
    onTick: (fn) => {
      tickListeners.add(fn);
      return () => { tickListeners.delete(fn); };
    },
    onIdle: (fn) => {
      idleListeners.add(fn);
      return () => { idleListeners.delete(fn); };
    },
    destroy: () => {
      activeTenants.clear();
      tickListeners.clear();
      idleListeners.clear();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}

// ─── Module-level access for creators ──────────────────────────────────────
//
// The creators (frame, text, shape, layout) live as imperative top-level
// functions called from Canvas.tsx — they don't hold a reference to the
// AutoPan controller. Stash a singleton so any creator can call
// `getAutoPan()?.setActive(...)` + `onTick(...)` without needing the
// controller threaded through every callback. Set by Canvas.tsx after
// `attachAutoPan`.

let activeAutoPan: AutoPanController | null = null;

export function setActiveAutoPan(ctrl: AutoPanController | null): void {
  activeAutoPan = ctrl;
}

export function getActiveAutoPan(): AutoPanController | null {
  return activeAutoPan;
}
