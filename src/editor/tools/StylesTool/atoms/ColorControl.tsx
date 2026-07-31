// ColorControl.tsx — Granular text-color (`color`) ToolAtom.
//
// Twin of BackgroundColorControl but bound to the `color` CSS property —
// used by the variable-editor registry so the variable modal can mount the
// real ColorPicker swatch when the user creates a `color` variable, instead
// of falling through to a plain text input.
//
// Stays minimal on purpose: the gradient-text path lives in the legacy
// TextColorControl (it requires multi-property writes + TipTap editing-mode
// awareness via useTextStyles, neither of which apply in variableDefault
// mode where there's no node to write to and no TipTap session).

import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { ColorInput } from '../../../controls';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import type { AtomProps } from '../../../controls/unified/types';

function ColorAtom() {
  const { value, onChange, onChangeLive, hasVariable } = useControlContext();
  // Show the variable-bound pill when this property is bound — same UX as
  // every other variabilizable atom in the panel, so the value column
  // matches what the ControlLabel's bound-state already advertises.
  if (hasVariable) return <VariableBoundPill propertyLabel="Color" />;
  return <ColorInput value={value || ''} onChange={onChange} onChangeLive={onChangeLive} showAlpha />;
}

export function ColorControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="color" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Color"><ColorAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
