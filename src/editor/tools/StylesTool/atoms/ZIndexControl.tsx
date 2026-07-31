// ZIndexControl.tsx — Self-contained z-index ToolAtom with +/- stepper.

import { ToolInput } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function ZIndexAtom() {
  const { value, onChange } = useControlContext();
  const num = parseInt(value || '0', 10) || 0;

  return (
    <div className="flex items-center gap-1.5 w-full">
      <div className="flex-1">
        <ToolInput value={value || 'auto'} onChange={onChange} step={1} />
      </div>
      <button
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-[var(--control-border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--control-border-hover)] cursor-pointer text-sm"
        onClick={() => onChange(String(num - 1))}
      >−</button>
      <button
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md border border-[var(--control-border)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:border-[var(--control-border-hover)] cursor-pointer text-sm"
        onClick={() => onChange(String(num + 1))}
      >+</button>
    </div>
  );
}

export function ZIndexControl({ mode = 'direct', ...modeProps }: AtomProps) {
  return (
    <UnifiedControlProvider property="zIndex" defaultValue="" mode={mode} {...modeProps}>
      <ControlRow label="Z-Index">
        <ZIndexAtom />
      </ControlRow>
    </UnifiedControlProvider>
  );
}
