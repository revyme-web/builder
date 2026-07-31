// user-preferences-store.ts — Editor preferences that persist across
// reloads. Stored in localStorage under `Revyme:prefs:<key>` so they
// survive page refresh + project switch (preferences are per-USER, not
// per-project).
//
// Mirrors the larger builder-side preferences store
// (`builder/src/builder/context/atoms/user-preferences-store.ts`) but
// keeps things minimal — these atoms only define WHAT prefs exist; the
// File → Preferences submenu reads/writes them. Wiring each pref to its
// downstream behavior (auto-pan speed → DragCoordinator,
// `directSelectionEnabled` → SelectionOverlay, etc.) is per-feature work
// done as each toggle gets connected to a real consumer.

import { atomWithStorage } from 'jotai/utils';

// ─── Types ─────────────────────────────────────────────────────────────────

export type AutoPanSpeed = 'low' | 'mid' | 'high';

interface AutoPanSpeedValues {
  /** Canvas pan velocity (px/frame) when the cursor is FULLY into a
   *  side panel — i.e., the ramp's MAX. */
  maxScrollSpeed: number;
  /** Canvas pan velocity (px/frame) at 1 px past the canvas boundary
   *  — i.e., the ramp's floor. */
  minScrollSpeed: number;
}

/** Numeric values consumed by `computeAutoPanDelta` in `AutoPan.ts`.
 *  `mid` preserves the Revyme default before this pref was wired
 *  (the legacy `AUTOPAN_MIN_SPEED = 0.4` / `AUTOPAN_MAX_SPEED = 3.2`
 *  in `transform/constants.ts`). `low` is ~half mid, `high` is ~2x —
 *  noticeably different feel without the panel-edge ramp going so fast
 *  the user overshoots their target. */
export const AUTO_PAN_SPEED_VALUES: Record<AutoPanSpeed, AutoPanSpeedValues> = {
  low:  { maxScrollSpeed: 1.5, minScrollSpeed: 0.3 },
  mid:  { maxScrollSpeed: 3.2, minScrollSpeed: 0.4 },
  high: { maxScrollSpeed: 6.5, minScrollSpeed: 0.7 },
};

// ─── Atoms ─────────────────────────────────────────────────────────────────
// Each `atomWithStorage` reads from localStorage on first access and
// writes back on every set. Keys are namespaced under `Revyme:prefs:`
// so they don't collide with other per-user state in the same origin.

/** Direct selection: when ON, click selects the deepest element under
 *  the cursor — the common default in web-oriented builders. When OFF,
 *  double-click is required to "enter" a container before its children
 *  become selectable, the two-step model familiar from design tools. */
export const directSelectionEnabledAtom = atomWithStorage<boolean>(
  'revyme:prefs:directSelectionEnabled', true,
);

/** Auto-pan speed for edge scrolling during drag. */
export const autoPanSpeedAtom = atomWithStorage<AutoPanSpeed>(
  'revyme:prefs:autoPanSpeed', 'mid',
);

/** Auto focus layers: when ON, selecting a node also opens the
 *  Pages & Layers panel and scrolls the matching layer into view. */
export const autoFocusLayersAtom = atomWithStorage<boolean>(
  'revyme:prefs:autoFocusLayers', false,
);

/** Show rulers: when ON, horizontal + vertical rulers render along
 *  the canvas edges with px-tick marks. */
export const showRulersAtom = atomWithStorage<boolean>(
  'revyme:prefs:showRulers', false,
);

/** Use smooth zoom: when ON, scroll-wheel + Ctrl+= / Ctrl+- zoom
 *  operations animate to the target scale instead of snapping. */
export const useSmoothZoomAtom = atomWithStorage<boolean>(
  'revyme:prefs:useSmoothZoom', true,
);

/** Show pixel grid: when ON and zoom > 500%, faint 1px grid lines
 *  appear on the canvas to help with pixel-level alignment. */
export const showPixelGridAtom = atomWithStorage<boolean>(
  'revyme:prefs:showPixelGrid', true,
);
