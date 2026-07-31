// PerspectiveControl.tsx — Perspective slider ToolAtom.

import { ToolSlider, ToolInput } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function PerspectiveAtom() {
  const { value, onChange } = useControlContext();
  const num = parseFloat(value || '0');
  return (
    <div className="flex items-center gap-2 w-full">
      <ToolSlider value={num} min={0} max={2000} step={10}
        onChange={(v) => onChange(String(v > 0 && v < 300 ? 300 : v))} />
      <ToolInput value={value || '0'}
        onChange={(v) => { const n = parseFloat(v) || 0; onChange(String(n > 0 && n < 300 ? 300 : n)); }}
        step={10} />
    </div>
  );
}

export function PerspectiveControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="perspective" defaultValue="0" mode={mode} {...mp}>
      <ControlRow label="Perspective"><PerspectiveAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
