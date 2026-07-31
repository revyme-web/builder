// LinkNewTabControl.tsx — Toggle for target="_blank" on links.

import { ToolSegmentedControl, ControlLabel } from '../../controls';
import { useHoistMenuItem } from '../../controls/hoist-context';
import { trace } from '@/shared/debug-trace';

interface LinkNewTabControlProps {
  value: boolean;
  onChange: (newTab: boolean) => void;
  /** Per-viewport override on a replica → the "New Tab" label goes purple + offers Reset Override. */
  overridden?: boolean;
  onResetOverride?: () => void;
}

export default function LinkNewTabControl({ value, onChange, overridden, onResetOverride }: LinkNewTabControlProps) {
  trace.fn('LinkNewTabControl:render', { value, overridden });
  // When LinkTool wraps this in a HoistMenuItemProvider (component master),
  // the label goes non-plain so its chevron surfaces the "Create Variable"
  // item — letting `target` become a component variable.
  const hoistItem = useHoistMenuItem();

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="New Tab" property="target" plain={!hoistItem} overridden={overridden} onResetOverride={onResetOverride} />
      <div className="flex items-center gap-2 w-full">
        <ToolSegmentedControl
          value={value ? 'yes' : 'no'}
          onChange={(val) => {
            const newTab = val === 'yes';
            trace.action('link-new-tab:change', { newTab });
            onChange(newTab);
          }}
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
          size="sm"
        />
      </div>
    </div>
  );
}
