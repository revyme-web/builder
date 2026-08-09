// transform/InputHandler.ts — Canvas input event handling.
// Routes wheel, pointer, and touch events to TransformManager.
// Key behavior: regular scroll = pan, ctrl/cmd+scroll = zoom.
//
// Does NOT wire keyboard shortcuts — that's for a future KeyboardManager.
// This only handles events that need to be attached to the canvas DOM element.

import { transformManager } from './TransformManager';
import {
  ZOOM_WHEEL_SENSITIVITY, ZOOM_PINCH_SENSITIVITY, PINCH_MAX_DELTA, ZOOM_MAX_DELTA,
} from './constants';
import { trace } from '@/shared/debug-trace';

/**
 * Is this a TRACKPAD PINCH rather than a deliberate modifier + scroll?
 *
 * The browser gives no flag for it — a pinch is SYNTHESISED as a ctrl-wheel —
 * so this reads two signals:
 *
 * 1. `metaKey` means the user is physically holding Cmd, which no synthesised
 *    pinch ever sets. That is a deliberate zoom and keeps the slower wheel
 *    speed. Without this check, Cmd + two-finger scroll on a trackpad emits the
 *    same small pixel deltas as a pinch and got the pinch's much faster rate —
 *    "that one is going way too fast" (user report 2026-08-09).
 * 2. Otherwise, magnitude: a pinch streams small pixel deltas, the smallest
 *    mouse notch is ~100. `deltaMode` matters too — Firefox reports a mouse
 *    wheel in LINES (deltaMode 1, deltaY ≈ 3), which would look tiny and be
 *    misread as a pinch.
 *
 * Residual ambiguity: Ctrl + two-finger scroll on a trackpad is indistinguish-
 * able from a pinch by event shape alone, and reads as a pinch here. On macOS
 * the OS takes that gesture for screen zoom so it rarely reaches the page, and
 * on Windows it is the same intent at a slightly different speed. Separating
 * them would need physical key tracking, which is unreliable across the canvas
 * iframe boundary — not worth the fragility.
 *
 * Getting it wrong is not dangerous, only mis-tuned: one frame zooms at the
 * other rate, then self-corrects.
 */
export function isTrackpadPinch(
  e: Pick<WheelEvent, 'deltaMode' | 'deltaY'> & { metaKey?: boolean },
): boolean {
  if (e.metaKey) return false;
  return e.deltaMode === 0 && Math.abs(e.deltaY) < PINCH_MAX_DELTA;
}

/** Multiplicative zoom factor for one wheel event. Exponential so the gesture
 *  is symmetric: pinching in and back out returns to the exact starting scale,
 *  which the previous linear form did not. */
export function wheelZoomFactor(
  e: Pick<WheelEvent, 'deltaMode' | 'deltaY'> & { metaKey?: boolean },
): number {
  const k = isTrackpadPinch(e) ? ZOOM_PINCH_SENSITIVITY : ZOOM_WHEEL_SENSITIVITY;
  const delta = Math.max(-ZOOM_MAX_DELTA, Math.min(ZOOM_MAX_DELTA, e.deltaY));
  return Math.exp(-delta * k);
}

// ─── Wheel Handler ──────────────────────────────────────────────────────────

/**
 * Handle wheel events on the canvas container.
 * - Regular scroll → pan
 * - Ctrl/Cmd + scroll → zoom at cursor
 * - Pinch on trackpad → zoom (browsers send ctrlKey=true for pinch)
 */
export function handleWheel(e: WheelEvent, containerRect: DOMRect): void {
  e.preventDefault();

  const anchorX = e.clientX - containerRect.left;
  const anchorY = e.clientY - containerRect.top;

  if (e.ctrlKey || e.metaKey) {
    // Zoom — ctrl+scroll or trackpad pinch (browser sets ctrlKey for both).
    // The factor is multiplicative, so the change stays proportional to the
    // current zoom: at 10% a step moves the scale far less in absolute terms
    // than at 400%, which is what makes zooming feel linear to the hand.
    // Sensitivity is per input device — see constants.ts.
    const factor = wheelZoomFactor(e);
    transformManager.zoomByFactor(anchorX, anchorY, factor);
    trace.action('input:zoom', {
      factor, pinch: isTrackpadPinch(e), deltaY: e.deltaY, anchorX, anchorY,
    });
  } else {
    // Pan — regular scroll / trackpad two-finger swipe
    transformManager.pan(-e.deltaX, -e.deltaY);
    trace.action('input:pan', { dx: -e.deltaX, dy: -e.deltaY });
  }
}

// ─── Pointer Pan (middle mouse + hand tool) ─────────────────────────────────
// Middle mouse: handled entirely via native pointer events + pointer capture.
// Hand tool: handled via React mouse events (left-click when hand mode active).

let panState: { startX: number; startY: number; source: 'middle' | 'hand' } | null = null;

/**
 * Attach native pointer event listeners to a container for middle-mouse panning.
 * Uses pointer capture so the browser never activates auto-scroll.
 * Call once from a useEffect. Returns cleanup function.
 */
export function attachMiddleMousePan(container: HTMLElement, onPanStateChange: (panning: boolean) => void): () => void {
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    container.setPointerCapture(e.pointerId);
    panState = { startX: e.clientX, startY: e.clientY, source: 'middle' };
    onPanStateChange(true);
    trace.action('input:middle-mouse-down', { pointerId: e.pointerId });
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!panState || panState.source !== 'middle') return;
    const dx = e.clientX - panState.startX;
    const dy = e.clientY - panState.startY;
    panState.startX = e.clientX;
    panState.startY = e.clientY;
    transformManager.pan(dx, dy);
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!panState || panState.source !== 'middle') return;
    if (e.button !== 1) return;
    try { container.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    panState = null;
    onPanStateChange(false);
    trace.action('input:pan-up', { source: 'middle' });
  };

  // Capture phase so we beat the browser's auto-scroll
  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onPointerMove, true);
  container.addEventListener('pointerup', onPointerUp, true);
  // Prevent auxclick (middle-click context menu in some browsers)
  const preventAux = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
  container.addEventListener('auxclick', preventAux, true);

  return () => {
    container.removeEventListener('pointerdown', onPointerDown, true);
    container.removeEventListener('pointermove', onPointerMove, true);
    container.removeEventListener('pointerup', onPointerUp, true);
    container.removeEventListener('auxclick', preventAux, true);
  };
}

/**
 * Start panning via hand tool (left-click, button 0, when hand tool is active).
 * Called from React mouse handlers.
 */
export function handleHandToolDown(e: MouseEvent): boolean {
  if (e.button !== 0) return false;
  e.preventDefault();
  panState = { startX: e.clientX, startY: e.clientY, source: 'hand' };
  trace.action('input:hand-tool-down');
  return true;
}

/**
 * Continue hand-tool panning. Returns true if handled.
 */
export function handleHandToolMove(e: MouseEvent): boolean {
  if (!panState || panState.source !== 'hand') return false;
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  panState.startX = e.clientX;
  panState.startY = e.clientY;
  transformManager.pan(dx, dy);
  return true;
}

/**
 * End hand-tool panning. Returns true if handled.
 */
export function handleHandToolUp(): boolean {
  if (!panState || panState.source !== 'hand') return false;
  panState = null;
  trace.action('input:pan-up', { source: 'hand' });
  return true;
}

export function isPanning(): boolean {
  return panState !== null;
}

// ─── Space + Drag Pan ───────────────────────────────────────────────────────

let spaceBarDown = false;
let spacePanState: { startX: number; startY: number } | null = null;

export function setSpaceBarDown(down: boolean): void {
  spaceBarDown = down;
  if (!down && spacePanState) {
    spacePanState = null;
    trace.action('input:space-pan-end');
  }
}

export function isSpaceBarDown(): boolean {
  return spaceBarDown;
}

export function handleSpacePanDown(e: MouseEvent): boolean {
  if (!spaceBarDown) return false;
  e.preventDefault();
  spacePanState = { startX: e.clientX, startY: e.clientY };
  trace.action('input:space-pan-start');
  return true;
}

export function handleSpacePanMove(e: MouseEvent): boolean {
  if (!spacePanState) return false;
  const dx = e.clientX - spacePanState.startX;
  const dy = e.clientY - spacePanState.startY;
  spacePanState.startX = e.clientX;
  spacePanState.startY = e.clientY;
  transformManager.pan(dx, dy);
  return true;
}

export function handleSpacePanUp(): boolean {
  if (!spacePanState) return false;
  spacePanState = null;
  trace.action('input:space-pan-end');
  return true;
}

export function isSpacePanning(): boolean {
  return spacePanState !== null;
}

// ─── Touch Events (trackpad / mobile) ───────────────────────────────────────

interface TouchState {
  active: boolean;
  lastDistance: number;
  lastMidpoint: { x: number; y: number };
}

const touchState: TouchState = { active: false, lastDistance: 0, lastMidpoint: { x: 0, y: 0 } };

