// control-registry.ts — Centralized control registry mapping CSS property names to control definitions.
//
// Resolution chain in resolveControl():
//   1. REGISTRY has a numeric or custom entry → return it
//   2. getCSSPropertyOptions() returns options → return { type: 'select', options }
//   3. Otherwise → return null
//
// Only numeric and custom entries are stored explicitly. Select entries are
// auto-detected via css-property-options.ts so the two sources stay in sync.

import { ComponentType } from 'react';
import { getCSSPropertyOptions, CSSOption, YES_NO_OPTIONS } from './css-property-options';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ControlRenderProps {
  property: string;
  value: string;
  onChange: (value: string) => void;
  label: string;
}

export type ControlDef =
  | { type: 'custom'; component: ComponentType<ControlRenderProps> }
  | { type: 'numeric'; min?: number; max?: number; step?: number }
  | { type: 'select'; options: CSSOption[] }
  /** Two-or-three-way choice rendered as a button group rather than a dropdown.
   *  `map`/`unmap` translate between the CSS value and the segment value, so a
   *  property whose real values aren't the button labels (font-style's
   *  `italic`/`normal` behind Yes/No) still rides the generic control. */
  | { type: 'segmented'; options: CSSOption[]; map: (cssValue: string) => string; unmap: (segment: string) => string };

// ─── Registry ────────────────────────────────────────────────────────────────

/** Internal store — only holds numeric and custom entries. */
const REGISTRY = new Map<string, ControlDef>();

// Numeric controls with known ranges
REGISTRY.set('gap',           { type: 'numeric', min: 0,   max: 200, step: 1 });
REGISTRY.set('rowGap',        { type: 'numeric', min: 0,   max: 200, step: 1 });
REGISTRY.set('columnGap',     { type: 'numeric', min: 0,   max: 200, step: 1 });
REGISTRY.set('columnCount',   { type: 'numeric', min: 1,   max: 12,  step: 1 });
REGISTRY.set('opacity',       { type: 'numeric', min: 0,   max: 1,   step: 0.01 });
REGISTRY.set('fontSize',      { type: 'numeric', min: 0,   max: 200, step: 1 });
REGISTRY.set('lineHeight',    { type: 'numeric', min: 0,   max: 5,   step: 0.1 });
// letterSpacing: px values live in a narrow band (headlines ~-2..2, spaced
// caps ~1..5) — the old -10..50 / 0.5 range made the slider land on unusable
// values after a 2px drag. Fine-grained 0.01 steps, tight range (typing in
// the input still accepts anything outside it).
REGISTRY.set('letterSpacing', { type: 'numeric', min: -2,  max: 5,   step: 0.01 });
REGISTRY.set('borderWidth',   { type: 'numeric', min: 0,   max: 20,  step: 1 });
REGISTRY.set('flexGrow',     { type: 'numeric', min: 0,   max: 10,  step: 1 });
REGISTRY.set('flexShrink',   { type: 'numeric', min: 0,   max: 10,  step: 1 });
REGISTRY.set('order',        { type: 'numeric', min: -10, max: 10,  step: 1 });
// Sticky offset — the scroll distance at which a position:sticky element sticks.
REGISTRY.set('top',          { type: 'numeric', min: -9999, max: 9999, step: 1 });

// Italic. A two-value property reads as a button group, not a dropdown — same
// shape as Hide. The CSS values stay real (`italic`/`normal`) so this writes
// through the identical textStyle-mark path as the Cmd+I shortcut; only the
// LABELS are Yes/No. `oblique` maps to Yes rather than showing as neither.
REGISTRY.set('fontStyle', {
  type: 'segmented',
  options: YES_NO_OPTIONS,
  map: (v) => (v && v.trim().toLowerCase().startsWith('oblique')) || v === 'italic' ? 'yes' : 'no',
  unmap: (seg) => (seg === 'yes' ? 'italic' : 'normal'),
});

// ─── API ─────────────────────────────────────────────────────────────────────

/**
 * Resolve a CSS property name to a control definition.
 *
 * Resolution order:
 *   1. Explicit REGISTRY entry (numeric or custom)
 *   2. Known CSS enum options from getCSSPropertyOptions()
 *   3. null — caller decides what to render (text input, color picker, etc.)
 */
export function resolveControl(property: string): ControlDef | null {
  // 1. Explicit registry entry takes priority
  const registered = REGISTRY.get(property);
  if (registered !== undefined) {
    return registered;
  }

  // 2. Auto-detect select from css-property-options
  const options = getCSSPropertyOptions(property);
  if (options !== null) {
    return { type: 'select', options };
  }

  // 3. Unknown property
  return null;
}
