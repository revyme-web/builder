// OffsetControl.tsx — Paired X/Y offset ToolAtom.

import { ToolInput, ControlLabel } from '../../../controls';
import { UnifiedControlProvider, useControlContext, UsedByRow } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function OffsetAtom() {
  const { allProps, onChangeMultiple, mode, binding } = useControlContext();

  if (mode === 'direct' && binding.bound) {
    return <UsedByRow binding={binding} />;
  }

  const xVal = allProps.x || '0';
  const yVal = allProps.y || '0';

  return (
    <div className="flex items-center gap-1 w-full">
      <ToolInput value={xVal} onChange={(v) => onChangeMultiple({ x: v })} step={1} chevronLabel="X" />
      <ToolInput value={yVal} onChange={(v) => onChangeMultiple({ y: v })} step={1} chevronLabel="Y" />
    </div>
  );
}

export function OffsetControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="x" defaultValue="0" mode={mode} {...mp}>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Offset" property="x" plain={mode !== 'direct'} />
        <OffsetAtom />
      </div>
    </UnifiedControlProvider>
  );
}
