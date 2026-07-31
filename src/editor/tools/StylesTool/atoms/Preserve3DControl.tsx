// Preserve3DControl.tsx — Transform-style preserve-3d toggle ToolAtom.

import { ToolSegmentedControl } from '../../../controls';
import { YES_NO_OPTIONS } from '../../../controls/css-property-options';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function Preserve3DAtom() {
  const { value, onChange } = useControlContext();
  return (
    <div className="w-full">
      <ToolSegmentedControl
        value={value === 'preserve-3d' ? 'yes' : 'no'}
        onChange={(v) => onChange(v === 'yes' ? 'preserve-3d' : '')}
        options={YES_NO_OPTIONS}
        size="sm" />
    </div>
  );
}

export function Preserve3DControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="transformStyle" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Preserve 3D"><Preserve3DAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
