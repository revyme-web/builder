// BackgroundColorControl.tsx — Granular background-color only ToolAtom.
// For use in variable editors, scroll stops, etc. where you want just the color, not the full Fill popup.

import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { ColorInput } from '../../../controls';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import type { AtomProps } from '../../../controls/unified/types';

function BackgroundColorAtom() {
  const { value, onChange, onChangeLive, hasVariable } = useControlContext();
  if (hasVariable) return <VariableBoundPill propertyLabel="Background" />;
  return <ColorInput value={value || ''} onChange={onChange} onChangeLive={onChangeLive} />;
}

export function BackgroundColorControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="backgroundColor" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Background"><BackgroundColorAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
