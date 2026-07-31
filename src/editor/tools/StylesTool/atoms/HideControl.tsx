// HideControl.tsx — Self-contained display:none toggle ToolAtom.

import { ToolSegmentedControl } from '../../../controls';
import { YES_NO_OPTIONS } from '../../../controls/css-property-options';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';
import { trace } from '@/shared/debug-trace';

function HideAtom() {
  const { value, onChange } = useControlContext();
  // Writing `display: ''` on unhide is fine — `updateNodeStyles`
  // (node-ops.ts) auto-substitutes `'flex'` / `'grid'` when the node
  // has flex/grid props, so the layout is preserved across hide/
  // unhide without per-button logic.
  return (
    <ToolSegmentedControl
      value={value === 'none' ? 'yes' : 'no'}
      onChange={(v) => { trace.action('hide:toggle', { value: v }); onChange(v === 'yes' ? 'none' : ''); }}
      options={YES_NO_OPTIONS}
      size="sm" />
  );
}

export function HideControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="display" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Hide"><HideAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
