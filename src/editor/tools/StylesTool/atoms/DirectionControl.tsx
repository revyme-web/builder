// DirectionControl.tsx — flex-direction ToolAtom: the row(→) / column(↓) arrow segmented control.
//
// Direction is its OWN variable type (like Shadow/Border) — NOT a generic toggle/option. Registered in
// variable-editor-registry for `flexDirection` so a Direction variable's default (in the modal) and its
// per-instance value (in the component tool) both render this exact arrow control, mirroring the inline
// Direction row in LayoutTool. The icons match LayoutTool's so the two read identically.

import { ToolSegmentedControl } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

const DIRECTION_OPTIONS = [
  {
    value: 'row',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
      </svg>
    ),
  },
  {
    value: 'column',
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" />
      </svg>
    ),
  },
];

function DirectionAtom() {
  const { value, onChange } = useControlContext();
  return (
    <ToolSegmentedControl
      value={value === 'column' ? 'column' : 'row'}
      onChange={onChange}
      options={DIRECTION_OPTIONS}
      size="sm"
    />
  );
}

export function DirectionControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="flexDirection" defaultValue="row" mode={mode} {...mp}>
      <ControlRow label="Direction"><DirectionAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
