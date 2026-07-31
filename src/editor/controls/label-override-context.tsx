// label-override-context.tsx — Override the hardcoded label rendered by
// rich-atom rows (FillControl, BorderControl, ShadowControl, …) without
// forking every atom. Same pattern as `hoist-context` — a single context
// the rich atoms' internal `ControlRow` consults before falling back to
// its own `label="…"` prop.
//
// Why this exists. When the user hoists a prop and lands on the page-
// level instance editor, the rich atom (FillControl) renders its built-in
// `<ControlRow label="Background">`. That ignores the user's chosen
// variable name — so the row reads as a generic "Background" with the
// user's hoisted variable name nowhere in sight. Wrapping the atom in
// `<LabelOverrideProvider label={prop.name} subLabel="Background"/>`
// lets every ControlRow underneath pick up the row's prop name as the
// PRIMARY label and demote the atom's own "Background" to the
// SECONDARY (sub-label) line, matching the rest of the row layout.
//
// Outside the provider the atoms behave exactly as before — same
// hardcoded labels, no two-line layout. Zero blast radius on the
// non-instance code paths.

import React, { createContext, useContext } from 'react';

interface LabelOverride {
  /** Primary label — replaces the atom's hardcoded `label` prop. */
  label: string;
  /** Secondary label shown muted beneath. Pass the atom's own label
   *  here (e.g. "Background") so the user can still read what the row
   *  controls in CSS terms. Falsy = single-line. */
  subLabel?: string;
  /** Per-viewport override state. When true the row's ControlLabel goes
   *  accent + exposes the "Reset Override" menu item (onResetOverride) — the
   *  SAME system a direct ControlLabel uses. Lets the rich atoms (color/image)
   *  in ComponentPropsTool's replica instance-prop rows show the override
   *  affordance like every other control label. */
  overridden?: boolean;
  onResetOverride?: () => void;
}

const LabelOverrideContext = createContext<LabelOverride | null>(null);

export function LabelOverrideProvider({ label, subLabel, overridden, onResetOverride, children }: {
  label: string;
  subLabel?: string;
  overridden?: boolean;
  onResetOverride?: () => void;
  children: React.ReactNode;
}) {
  return (
    <LabelOverrideContext.Provider value={{ label, subLabel, overridden, onResetOverride }}>
      {children}
    </LabelOverrideContext.Provider>
  );
}

export function useLabelOverride(): LabelOverride | null {
  return useContext(LabelOverrideContext);
}

/**
 * Convenience for a rich atom's MAIN row: returns the override's variable
 * name + sub-label when wrapped in a `LabelOverrideProvider` (the
 * ComponentPropsTool instance-prop rows), or the atom's own default label
 * otherwise. Atoms that render their main row via `ControlLabel` directly
 * (Image / Shadow / Filter / Gradient / Mask / ClipPath / Border / Transform)
 * call this so a variable bound to them shows "<varName>" big + the atom's
 * label small — matching the `ControlRow`-based atoms (Color, etc.). Popup
 * sub-labels keep their own explicit labels (they don't call this), so the
 * override never leaks into nested controls.
 */
export function useOverriddenLabel(defaultLabel: string): { label: string; subLabel?: string } {
  const o = useContext(LabelOverrideContext);
  return { label: o?.label ?? defaultLabel, subLabel: o?.subLabel };
}
