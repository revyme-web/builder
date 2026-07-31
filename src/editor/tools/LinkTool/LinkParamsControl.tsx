// LinkParamsControl.tsx — "Parameters" Keep/Ignore toggle.
// Keep → the current page's URL query string is forwarded to the link on
// click (runtime onClick, see syncParamsHandlerInCode). Ignore → bare href.
// Stored as `data-keep-params="true"` (absent = Ignore).

import { ToolSegmentedControl, ControlLabel } from '../../controls';
import { useHoistMenuItem } from '../../controls/hoist-context';
import { trace } from '@/shared/debug-trace';

interface LinkParamsControlProps {
  value: boolean;
  onChange: (keep: boolean) => void;
}

export default function LinkParamsControl({ value, onChange }: LinkParamsControlProps) {
  trace.fn('LinkParamsControl:render', { value });
  const hoistItem = useHoistMenuItem();

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Parameters" property="data-keep-params" plain={!hoistItem} />
      <div className="flex items-center gap-2 w-full">
        <ToolSegmentedControl
          value={value ? 'keep' : 'ignore'}
          onChange={(val) => {
            const keep = val === 'keep';
            trace.action('link-params:change', { keep });
            onChange(keep);
          }}
          options={[
            { value: 'keep', label: 'Keep' },
            { value: 'ignore', label: 'Ignore' },
          ]}
          size="sm"
        />
      </div>
    </div>
  );
}
