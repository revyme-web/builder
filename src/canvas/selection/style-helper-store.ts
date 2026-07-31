// style-helper-store.ts — State for the StyleUpdateHelper tooltip.
// Shows contextual info (dimensions, rotation, gap, padding, font size, radius)
// near the cursor during resize, rotate, gap drag, etc.
// Callers: ResizeManager, RotateManager, GapHandles, PaddingHandles, FontSizeHandle, etc.

import { atom } from 'jotai';
import { trace } from '@/shared/debug-trace';

export interface StyleHelperDimensions {
  width: number;
  height: number;
  unit: 'px' | '%';
  widthUnit?: string;
  heightUnit?: string;
}

export type StyleHelperType = 'dimensions' | 'gap' | 'rotate' | 'radius' | 'fontSize' | 'padding';

export interface StyleHelperState {
  show: boolean;
  type: StyleHelperType | null;
  /** Screen-space position (near bottom-right of element or cursor) */
  position: { x: number; y: number };
  /** Single numeric value (for gap, radius, padding, rotate, fontSize) */
  value?: number;
  /** Unit string (px, %, vw, deg) */
  unit?: string;
  /** For fontSize mixed state */
  isMixed?: boolean;
  /** For dimensions type (width × height) */
  dimensions?: StyleHelperDimensions;
}

const initialState: StyleHelperState = {
  show: false,
  type: null,
  position: { x: 0, y: 0 },
};

export const styleHelperAtom = atom<StyleHelperState>(initialState);

// ─── Imperative operations (callable from non-React code) ─────────────

let _setter: ((state: StyleHelperState) => void) | null = null;

/** Must be called once from a React component that has write access to the atom */
export function registerStyleHelperSetter(setter: (state: StyleHelperState) => void) {
  _setter = setter;
}

export const styleHelperOps = {
  show(params: {
    type: StyleHelperType;
    position: { x: number; y: number };
    value?: number;
    unit?: string;
    isMixed?: boolean;
    dimensions?: StyleHelperDimensions;
  }) {
    trace.action('style-helper:show', { type: params.type, value: params.value, dimensions: params.dimensions });
    _setter?.({
      show: true,
      type: params.type,
      position: params.position,
      value: params.value,
      unit: params.unit,
      isMixed: params.isMixed,
      dimensions: params.dimensions,
    });
  },

  hide() {
    trace.action('style-helper:hide');
    _setter?.(initialState);
  },
};
