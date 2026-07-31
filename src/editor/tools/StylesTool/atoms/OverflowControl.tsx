// OverflowControl.tsx — Self-contained overflow ToolAtom.

import { ToolSelect } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { LocalePillOr } from '@/editor/controls/LocaleBoundPill';
import type { AtomProps } from '../../../controls/unified/types';
import { OVERFLOW_OPTIONS } from '../../../controls/css-property-options';

function OverflowAtom() {
  const { value, onChange } = useControlContext();
  return (
    <ToolSelect value={value || 'visible'} onChange={onChange}
      options={OVERFLOW_OPTIONS} />
  );
}

export function OverflowControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="overflow" defaultValue="visible" mode={mode} {...mp}>
      <ControlRow label="Overflow"><LocalePillOr property="overflow" label="Overflow"><OverflowAtom /></LocalePillOr></ControlRow>
    </UnifiedControlProvider>
  );
}

export function OverflowXControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="overflowX" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Overflow X"><OverflowAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}

export function OverflowYControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="overflowY" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Overflow Y"><OverflowAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
