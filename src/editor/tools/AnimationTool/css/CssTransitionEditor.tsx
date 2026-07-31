// AnimationTool/css/CssTransitionEditor.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ToolInput, ToolSelect } from '../../../controls';

// ─── CSS transition editor ───────────────────────────────────────────────────

// ToolSegmentedControl is already imported from the controls barrel at the top of the file.
import type { TransitionData } from '@/shared/animation-utils';

const CSS_TRANSITION_PROPERTIES = [
  { label: 'All', value: 'all' },
  { label: 'Opacity', value: 'opacity' },
  { label: 'Transform', value: 'transform' },
  { label: 'Background', value: 'background-color' },
  { label: 'Color', value: 'color' },
  { label: 'Border', value: 'border' },
  { label: 'Box Shadow', value: 'box-shadow' },
  { label: 'Width', value: 'width' },
  { label: 'Height', value: 'height' },
  { label: 'Padding', value: 'padding' },
  { label: 'Margin', value: 'margin' },
];

const CSS_EASING_OPTIONS = [
  { label: 'Ease', value: 'ease' },
  { label: 'Ease In', value: 'ease-in' },
  { label: 'Ease Out', value: 'ease-out' },
  { label: 'Ease In-Out', value: 'ease-in-out' },
  { label: 'Linear', value: 'linear' },
];

export function CssTransitionEditor({ transition, onChange }: {
  transition: TransitionData;
  onChange: (t: TransitionData) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <ControlLabel label="Property" property="" plain />
        <ToolSelect
          value={transition.property}
          onChange={(v) => onChange({ ...transition, property: v })}
          options={CSS_TRANSITION_PROPERTIES}
        />
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Duration" property="" plain />
        <ToolInput
          value={String(transition.duration)}
          onChange={(v) => onChange({ ...transition, duration: parseFloat(v) || 0.3 })}
          step={0.1}
          chevronLabel="s"
        />
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Easing" property="" plain />
        <ToolSelect
          value={transition.easing}
          onChange={(v) => onChange({ ...transition, easing: v })}
          options={CSS_EASING_OPTIONS}
        />
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Delay" property="" plain />
        <ToolInput
          value={String(transition.delay)}
          onChange={(v) => onChange({ ...transition, delay: parseFloat(v) || 0 })}
          step={0.1}
          chevronLabel="s"
        />
      </div>
    </div>
  );
}
