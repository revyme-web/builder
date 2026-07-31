// LinkSmoothScrollControl.tsx — Toggle for smooth scroll behavior on anchor links.

import { ToolSegmentedControl, ControlLabel } from '../../controls';
import { useHoistMenuItem } from '../../controls/hoist-context';
import { trace } from '@/shared/debug-trace';

interface LinkSmoothScrollControlProps {
  value: boolean;
  onChange: (smooth: boolean) => void;
  /** Per-viewport override on a replica → the label goes purple + offers Reset Override. */
  overridden?: boolean;
  onResetOverride?: () => void;
}

export default function LinkSmoothScrollControl({ value, onChange, overridden, onResetOverride }: LinkSmoothScrollControlProps) {
  trace.fn('LinkSmoothScrollControl:render', { value, overridden });
  const hoistItem = useHoistMenuItem();

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Smooth Scroll" property="data-smooth-scroll" plain={!hoistItem} overridden={overridden} onResetOverride={onResetOverride} />
      <div className="flex items-center gap-2 w-full">
        <ToolSegmentedControl
          value={value ? 'yes' : 'no'}
          onChange={(val) => {
            const smooth = val === 'yes';
            trace.action('link-smooth-scroll:change', { smooth });
            onChange(smooth);
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
