// variable-editor-registry.ts — Maps a CSS property to the atom component
// used to edit its value inside the VariableModal's "Default Value" section.
//
// The modal mounts the resolved atom in `mode='variableDefault'` so the user
// gets the same compound editor (Shadow popup, Filter editor, Border builder,
// padding shorthand, etc.) they already know from the right properties panel,
// instead of a generic numeric/text input that ignores property semantics.
//
// Atoms registered here MUST:
//   - Accept the unified `AtomProps` ({ mode, externalValue, externalOnChange })
//     so the modal's defaultValue buffer flows through the unified provider.
//   - Render correctly when there is no selected node (nodeId === null in
//     `variableDefault` mode). Atoms that read selection state (popup anchors,
//     map context, etc.) must guard those paths.
//
// Atoms that don't yet meet those constraints (TextStyleTool atoms still on
// the legacy ControlProvider) are intentionally NOT registered. They fall
// back to the modal's simple numeric/select/text dispatch via control-registry.
// They can be added here as they migrate to the unified provider.

import type { ComponentType } from 'react';
import type { AtomProps } from './unified/types';
import {
  OpacityControl,
  ShadowControl,
  FilterControl,
  RadiusControl,
  PaddingControl,
  MarginControl,
  OverflowControl,
  HideControl,
  DirectionControl,
  BorderControl,
  MaskControl,
  ClipPathControl,
  TransformControl,
  ZIndexControl,
  BackgroundColorControl,
  ColorControl,
  GradientControl,
  ImageControl,
  TransitionVariableEditor,
} from '../tools/StylesTool/atoms';

/** Atom component compatible with the unified `variableDefault` mode. */
export type VariableEditorAtom = ComponentType<AtomProps>;

/**
 * CSS property → atom registry. Only includes atoms verified to render
 * correctly with `mode='variableDefault'` (Phase 1d audit).
 */
const VARIABLE_EDITOR_REGISTRY = new Map<string, VariableEditorAtom>([
  // Visual / fill
  // FillControl is the rich multi-tab editor for the "Fill" row, but the
  // per-tab variable choices each bind to a more specific CSS property:
  //   - backgroundColor → BackgroundColorControl (solid color picker)
  //   - background      → GradientControl       (gradient editor)
  //   - backgroundImage → ImageControl          (image picker)
  // The Fill submenu opens whichever modal matches the user's choice.
  ['backgroundColor', BackgroundColorControl],
  ['background',      GradientControl],
  ['backgroundImage', ImageControl],
  ['color',           ColorControl],  // text color — uses ColorInput swatch + picker
  ['boxShadow',       ShadowControl],
  ['filter',          FilterControl],
  ['mask',            MaskControl],
  ['clipPath',        ClipPathControl],
  ['borderRadius',    RadiusControl],
  ['border',          BorderControl],

  // Spacing
  ['padding',         PaddingControl],
  ['margin',          MarginControl],

  // Layout / overflow
  ['overflow',        OverflowControl],
  ['display',         HideControl],
  // Direction is its own control (row→/column↓ arrows), like Shadow/Border — never a toggle/option.
  ['flexDirection',   DirectionControl],

  // Transform-ish
  ['transform',       TransformControl],
  ['zIndex',          ZIndexControl],
  ['opacity',         OpacityControl],

  // Synthetic property — transition isn't a CSS property the parser
  // stores in node.styles, but the variable system uses 'transition'
  // as the binding key when the user promotes the value via the
  // Transition row's Create Variable menu. The editor wraps
  // TransitionPanel and serialises the object as JSON in the modal's
  // string buffer.
  ['transition',      TransitionVariableEditor],
  // NOTE: web cursor (CSS `cursor`) deliberately has NO dedicated editor here — its grid popup didn't open in
  // the variable contexts. Instead it's an `option` variable whose select offers EVERY cursor keyword (see
  // css-property-options `cursor`), like the justify variable. Registering an editor here would set
  // hasDedicatedEditor → suppress the 'option' typing, so leave it OUT on purpose.
]);

/**
 * Resolve a CSS property to its variable-editor atom.
 *
 * Returns `null` for unmapped properties — the modal then falls back to the
 * simple numeric/select/text dispatch from control-registry.ts.
 */
export function resolveVariableEditor(property: string): VariableEditorAtom | null {
  return VARIABLE_EDITOR_REGISTRY.get(property) ?? null;
}

/**
 * Test-only: list every property registered. Used by registry tests to assert
 * coverage of the atoms shipped in StylesTool.
 */
export function listRegisteredVariableProperties(): string[] {
  return Array.from(VARIABLE_EDITOR_REGISTRY.keys());
}

/**
 * Register a custom atom for a property. Allows feature code (e.g. text-style
 * atoms once they migrate to the unified provider) to extend the registry
 * without modifying this file. Last write wins.
 */
export function registerVariableEditor(property: string, atom: VariableEditorAtom): void {
  VARIABLE_EDITOR_REGISTRY.set(property, atom);
}
