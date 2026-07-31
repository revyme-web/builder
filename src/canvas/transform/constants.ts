// transform/constants.ts — Canvas transform constants.

export const MIN_SCALE = 0.02;   // 2% — matches the reference
export const MAX_SCALE = 32;     // 3200% — matches the reference
export const ZOOM_STEP = 0.1;    // 10% per keyboard zoom
export const ZOOM_WHEEL_SENSITIVITY = 0.002; // for ctrl+scroll zoom

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
