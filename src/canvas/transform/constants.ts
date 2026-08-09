// transform/constants.ts — Canvas transform constants.

export const MIN_SCALE = 0.02;   // 2% — matches the reference
export const MAX_SCALE = 32;     // 3200% — matches the reference
export const ZOOM_STEP = 0.1;    // 10% per keyboard zoom
// ─── Wheel / pinch zoom ─────────────────────────────────────────────────────
//
// ONE GESTURE, TWO VERY DIFFERENT EVENT STREAMS. Browsers report a trackpad
// pinch as a wheel event with `ctrlKey` set, identical in shape to holding Ctrl
// and turning a mouse wheel — but the magnitudes are nothing alike:
//
//   mouse wheel notch   |deltaY| ≈ 100–120, a handful of events
//   trackpad pinch      |deltaY| ≈ 1–20, streamed continuously
//
// A single sensitivity can't serve both. Tuned for the mouse (0.002), a whole
// pinch gesture sums to ~200 of delta and only ≈1.5× the zoom — so zooming to
// an element took five separate pinches (user report 2026-08-09).
//
// Both are applied EXPONENTIALLY: `scale *= exp(-deltaY * k)`. The old linear
// `scale + (-deltaY * k * scale)` is only the first-order approximation of
// that, and it isn't symmetric — pinching in and back out left you at a
// different zoom than you started. Exponential round-trips exactly.
//
// To retune: the zoom factor over a gesture is `exp(totalDelta * k)`. A full
// trackpad pinch is roughly 200 of total delta, so 0.011 ≈ 9× per gesture —
// one pinch reaches an element instead of five. This is the number to nudge if
// it ever wants to feel different; nothing else needs to change.
export const ZOOM_WHEEL_SENSITIVITY = 0.002;  // ctrl + mouse wheel
export const ZOOM_PINCH_SENSITIVITY = 0.011;  // trackpad pinch — 5.5× the wheel

/** Above this, a `ctrlKey` wheel event is a mouse notch rather than a pinch.
 *  Real pinches stay well under it; the smallest mouse notch is ~100. */
export const PINCH_MAX_DELTA = 50;

/** Per-event delta ceiling. A momentum flick or a high-resolution wheel can
 *  emit several hundred in one event, which exponentiates into a jarring jump. */
export const ZOOM_MAX_DELTA = 120;

// Animation durations (ms)
export const ANIM_ZOOM_STEP = 150;    // zoom in/out keyboard shortcut
export const ANIM_ZOOM_TO_100 = 300;  // zoom to 100%
export const ANIM_ZOOM_TO_FIT = 400;  // zoom to fit content
export const ANIM_PAN_TO_NODE = 300;  // pan to center on node

// Auto-pan zones — measured from the canvas container's edge inward. The
// left/right values are wider than top/bottom because the editor's left
// toolbar (308 px, see TimelineSheet's `left-[308px]`) and right properties
// panel (260 px, see PropertiesPanel's `w-[260px]`) sit OUTSIDE the canvas
// container; we want panning to start as the cursor approaches those panels.
// Outside the container entirely (cursor over a panel during drag) → max
// speed, same as builder's behavior.
//
// Per-frame velocity (min/max) is now per-user via `autoPanSpeedAtom` +
// `AUTO_PAN_SPEED_VALUES` in `code/stores/user-preferences-store.ts`.
// `AutoPan.computeAutoPanDelta` reads the atom each tick.
export const AUTOPAN_LEFT_EDGE = 308;
export const AUTOPAN_RIGHT_EDGE = 260;
export const AUTOPAN_VERTICAL_EDGE = 50;

// Zoom clamping for fit operations
export const FIT_MIN_SCALE = 0.1;
export const FIT_MAX_SCALE = 2;
export const FIT_PADDING = 100; // px padding around content when fitting
