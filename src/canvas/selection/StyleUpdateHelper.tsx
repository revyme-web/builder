// StyleUpdateHelper.tsx — Tooltip showing live values during resize, rotate, etc.
// Follows bottom-right of the element. Shows dimensions (W×H), rotation (°),
// gap (px), padding (px), radius (px), font size (px/vw).

import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { styleHelperAtom, registerStyleHelperSetter } from './style-helper-store';
import type { StyleHelperState } from './style-helper-store';
import StyleIndicator, { measurementColors } from '@/design-system/StyleIndicator';
import { isComponentFileAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

const OFFSET_X = 40;
const OFFSET_Y = 40;

export default function StyleUpdateHelper() {
  const state = useAtomValue(styleHelperAtom);
  const setState = useSetAtom(styleHelperAtom);
  // Component master files use the secondary (purple) accent throughout
  // the editor — selection outlines, layer panel, ControlLabel hover, the
  // ComponentBreadcrumb, etc. Mirror that here so the resize/rotate
  // tooltip fits the same convention: blue on pages, purple on
  // component masters.
  const isComponentFile = useAtomValue(isComponentFileAtom);

  useEffect(() => {
    registerStyleHelperSetter(setState);
    trace.action('style-helper:registered');
  }, [setState]);

  if (!state.show || !state.type) return null;

  const x = state.position.x + OFFSET_X;
  const y = state.position.y + OFFSET_Y;
  const text = renderText(state);
  if (!text) return null;

  // Gap keeps its dedicated pink (`#f472b6`) — it's a layout-relationship
  // affordance, not a per-element value, and the pink reads as the
  // shared "spacing" color across the editor's gap UI.
  const measure = measurementColors(isComponentFile);
  const color = state.type === 'gap' ? '#f472b6' : measure.color;
  // Gap's pink is a fixed brand colour; white reads on it. Everything else
  // takes the measurement pair so fill and label can never mismatch.
  const fg = state.type === 'gap' ? '#ffffff' : measure.fg;

  return (
    <StyleIndicator x={x} y={y} color={color} fg={fg}>
      {text}
    </StyleIndicator>
  );
}

function renderText(state: StyleHelperState): string | null {
  switch (state.type) {
    case 'dimensions':
      if (!state.dimensions) return null;
      return `${Math.round(state.dimensions.width)}${state.dimensions.widthUnit || state.dimensions.unit} × ${Math.round(state.dimensions.height)}${state.dimensions.heightUnit || state.dimensions.unit}`;

    case 'rotate':
      return `${Math.round(state.value ?? 0)}°`;

    case 'fontSize':
      if (state.isMixed) return 'Mixed';
      if (state.unit === 'vw') return `${(state.value ?? 0).toFixed(2)}${state.unit}`;
      return `${Math.round(state.value ?? 0)}${state.unit || 'px'}`;

    case 'gap':
    case 'padding':
    case 'radius':
      return `${Math.round(state.value ?? 0)}px`;

    default:
      return null;
  }
}
