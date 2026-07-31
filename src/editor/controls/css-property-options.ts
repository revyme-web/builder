// css-property-options.ts — Known enum values for CSS properties.
//
// CSS properties that accept a fixed set of keywords get their options listed here.
// Used by StyleField to auto-render a select dropdown when the property is known.
// This is NOT a control registry — it's just CSS spec knowledge.
//
// Properties NOT listed here auto-detect from value type:
//   numeric → slider + number
//   color → color picker
//   text → text input

import { CURSOR_NAMES, cursorLabel } from '../tools/CursorTool/cursor-icons';

export interface CSSOption {
  value: string;
  label: string;
}

/** Shared overflow options (used by overflow, overflowX, overflowY) */
export const OVERFLOW_OPTIONS: CSSOption[] = [
  { value: 'visible', label: 'visible' },
  { value: 'hidden', label: 'hidden' },
  { value: 'scroll', label: 'scroll' },
  { value: 'clip', label: 'clip' },
];

const OPTIONS: Record<string, CSSOption[]> = {
  // Layout
  display: [
    { value: 'block', label: 'block' },
    { value: 'flex', label: 'flex' },
    { value: 'grid', label: 'grid' },
    { value: 'inline', label: 'inline' },
    { value: 'inline-flex', label: 'inline-flex' },
    { value: 'inline-grid', label: 'inline-grid' },
    { value: 'none', label: 'none' },
  ],
  flexDirection: [
    { value: 'row', label: 'row' },
    { value: 'column', label: 'column' },
    { value: 'row-reverse', label: 'row-reverse' },
    { value: 'column-reverse', label: 'column-reverse' },
  ],
  flexWrap: [
    { value: 'nowrap', label: 'nowrap' },
    { value: 'wrap', label: 'wrap' },
    { value: 'wrap-reverse', label: 'wrap-reverse' },
  ],
  // Fixed axis-neutral labels (Start/Center/End/Space …) — variable creation
  // and StyleField selects share these; values stay raw CSS (deploy truth).
  alignItems: [
    { value: 'flex-start', label: 'Start' },
    { value: 'center', label: 'Center' },
    { value: 'flex-end', label: 'End' },
  ],
  justifyContent: [
    { value: 'flex-start', label: 'Start' },
    { value: 'center', label: 'Center' },
    { value: 'flex-end', label: 'End' },
    { value: 'space-between', label: 'Space Between' },
    { value: 'space-around', label: 'Space Around' },
    { value: 'space-evenly', label: 'Space Evenly' },
  ],
  alignSelf: [
    { value: 'auto', label: 'auto' },
    { value: 'flex-start', label: 'flex-start' },
    { value: 'center', label: 'center' },
    { value: 'flex-end', label: 'flex-end' },
    { value: 'stretch', label: 'stretch' },
    { value: 'baseline', label: 'baseline' },
  ],

  // Position
  position: [
    { value: 'relative', label: 'Relative' },
    { value: 'absolute', label: 'Absolute' },
    { value: 'fixed', label: 'Fixed' },
    { value: 'sticky', label: 'Sticky' },
  ],

  // Overflow (shared — overflow, overflowX, overflowY are identical)
  overflow: OVERFLOW_OPTIONS,
  overflowX: OVERFLOW_OPTIONS,
  overflowY: OVERFLOW_OPTIONS,

  // Text
  textAlign: [
    { value: 'left', label: 'left' },
    { value: 'center', label: 'center' },
    { value: 'right', label: 'right' },
    { value: 'justify', label: 'justify' },
  ],
  fontWeight: [
    { value: '100', label: '100' },
    { value: '200', label: '200' },
    { value: '300', label: '300' },
    { value: '400', label: '400' },
    { value: '500', label: '500' },
    { value: '600', label: '600' },
    { value: '700', label: '700' },
    { value: '800', label: '800' },
    { value: '900', label: '900' },
  ],
  textDecoration: [
    { value: 'none', label: 'none' },
    { value: 'underline', label: 'underline' },
    { value: 'line-through', label: 'line-through' },
    { value: 'overline', label: 'overline' },
  ],
  textTransform: [
    { value: 'none', label: 'none' },
    { value: 'uppercase', label: 'uppercase' },
    { value: 'lowercase', label: 'lowercase' },
    { value: 'capitalize', label: 'capitalize' },
  ],
  whiteSpace: [
    { value: 'normal', label: 'normal' },
    { value: 'nowrap', label: 'nowrap' },
    { value: 'pre', label: 'pre' },
    { value: 'pre-wrap', label: 'pre-wrap' },
    { value: 'pre-line', label: 'pre-line' },
  ],
  textOverflow: [
    { value: '', label: 'none' },
    { value: 'clip', label: 'clip' },
    { value: 'ellipsis', label: 'ellipsis' },
  ],

  // Writing mode
  writingMode: [
    { value: 'horizontal-tb', label: 'Horizontal' },
    { value: 'vertical-rl', label: 'Vertical RL' },
    { value: 'vertical-lr', label: 'Vertical LR' },
  ],

  // Text decoration sub-properties
  textDecorationLine: [
    { value: 'none', label: 'None' },
    { value: 'underline', label: 'Underline' },
    { value: 'overline', label: 'Overline' },
    { value: 'line-through', label: 'Line Through' },
  ],
  textDecorationStyle: [
    { value: 'solid', label: 'Solid' },
    { value: 'double', label: 'Double' },
    { value: 'dotted', label: 'Dotted' },
    { value: 'dashed', label: 'Dashed' },
    { value: 'wavy', label: 'Wavy' },
  ],

  // Visibility
  visibility: [
    { value: 'visible', label: 'visible' },
    { value: 'hidden', label: 'hidden' },
  ],
  pointerEvents: [
    { value: 'auto', label: 'auto' },
    { value: 'none', label: 'none' },
  ],
  // EVERY CSS cursor (the same full list as the Cursor tool's grid) so a hoisted cursor VARIABLE's select
  // offers all choices — not the abbreviated set. (The grid popup didn't open in the variable contexts, so the
  // cursor variable is an `option` with the complete keyword list, like the justify variable.)
  cursor: CURSOR_NAMES.map((c) => ({ value: c, label: cursorLabel(c) })),

  // Object fit
  objectFit: [
    { value: 'cover', label: 'cover' },
    { value: 'contain', label: 'contain' },
    { value: 'fill', label: 'fill' },
    { value: 'none', label: 'none' },
    { value: 'scale-down', label: 'scale-down' },
  ],
};

/** Get enum options for a CSS property, or null if it's not an enum property */
export function getCSSPropertyOptions(property: string): CSSOption[] | null {
  return OPTIONS[property] ?? null;
}

/** Get direction-aware options for alignItems (cross-axis) */
export function getAlignOptions(_flexDirection?: string): CSSOption[] {
  // Fixed axis-neutral labels regardless of flex direction —
  // the direction-aware Top/Left flipping confused more than it helped.
  return [
    { value: 'flex-start', label: 'Start' },
    { value: 'center', label: 'Center' },
    { value: 'flex-end', label: 'End' },
  ];
}

/** Options for justifyContent (main-axis) — fixed axis-neutral labels */
export function getJustifyOptions(_flexDirection?: string): CSSOption[] {
  return [
    { value: 'flex-start', label: 'Start' },
    { value: 'center', label: 'Center' },
    { value: 'flex-end', label: 'End' },
    { value: 'space-between', label: 'Space Between' },
    { value: 'space-around', label: 'Space Around' },
    { value: 'space-evenly', label: 'Space Evenly' },
  ];
}

/** Align-self / justify-self options (used by flex + grid child controls) */
export const SELF_ALIGN_OPTIONS: CSSOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'flex-start', label: 'Start' },
  { value: 'center', label: 'Center' },
  { value: 'flex-end', label: 'End' },
  { value: 'stretch', label: 'Stretch' },
];

/** Generic yes/no toggle options */
export const YES_NO_OPTIONS: CSSOption[] = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];
