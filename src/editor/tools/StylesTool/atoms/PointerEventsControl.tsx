// PointerEventsControl.tsx — Self-contained pointer-events ToolAtom.
// Toggles whether the element receives pointer events (`auto`) or passes
// them through to whatever is behind (`none`). Useful for decorative
// overlays, animated effects, ghost layers, etc.

import { ToolSelect } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

const POINTER_EVENTS_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
];

function PointerEventsAtom() {
  const { value, onChange } = useControlContext();
  return (
    <ToolSelect
      value={value || 'auto'}
      onChange={onChange}
      options={POINTER_EVENTS_OPTIONS}
    />
  );
}

export function PointerEventsControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="pointerEvents" defaultValue="auto" mode={mode} {...mp}>
      <ControlRow label="Pointer"><PointerEventsAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
