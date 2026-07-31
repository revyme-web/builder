// Rotate3DControl.tsx — Paired Rotate X/Y ToolAtom (3D rotation).

import { ToolInput, ControlLabel } from '../../../controls';
import { UnifiedControlProvider, useControlContext, UsedByRow } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function Rotate3DAtom() {
  const { allProps, onChangeMultiple, mode, binding } = useControlContext();

  if (mode === 'direct' && binding.bound) {
    return <UsedByRow binding={binding} />;
  }
  const rx = allProps.rotateX || '0';
  const ry = allProps.rotateY || '0';

  return (
    <div className="flex items-center gap-1 w-full">
      <ToolInput value={rx} onChange={(v) => onChangeMultiple({ rotateX: v })} step={1} chevronLabel="X" />
      <ToolInput value={ry} onChange={(v) => onChangeMultiple({ rotateY: v })} step={1} chevronLabel="Y" />
    </div>
  );
}

export function Rotate3DControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="rotateX" defaultValue="0" mode={mode} {...mp}>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Rotate 3D" property="rotateX" plain={mode !== 'direct'} />
        <Rotate3DAtom />
      </div>
    </UnifiedControlProvider>
  );
}
