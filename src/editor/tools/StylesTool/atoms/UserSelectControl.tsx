// UserSelectControl.tsx — Self-contained user-select ToolAtom.
// Controls whether text inside the element can be selected by the user.
// Common values: `auto` (browser default, usually selectable), `none`
// (block selection — useful for buttons / chrome), `text` (force text-
// selection cursor), `all` (single click selects all the contents).

import { ToolSelect } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

const USER_SELECT_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
  { value: 'text', label: 'Text' },
  { value: 'all', label: 'All' },
];

function UserSelectAtom() {
  const { value, onChange } = useControlContext();
  return (
    <ToolSelect
      value={value || 'auto'}
      onChange={onChange}
      options={USER_SELECT_OPTIONS}
    />
  );
}

export function UserSelectControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="userSelect" defaultValue="auto" mode={mode} {...mp}>
      <ControlRow label="User Select"><UserSelectAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
