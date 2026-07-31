// NumberVariableEditor.tsx — The editor for a Number variable's value, matching the reference's ControlType.Number.
//
// A Number variable carries min/max/step/unit + a Control preference (slider vs stepper) in its @propMeta.
// This renders the value editor accordingly:
//   - control 'slider'  → a drag slider (min/max/step) + a numeric input
//   - control 'stepper' → a numeric input + a − / + stepper
// The `unit` is a display suffix in the input (the stored value stays a raw number — React re-applies the
// unit for px-properties; unitless props like opacity keep it raw). Used by the Variable modal's Default
// row and the component-instance editor so both look/behave the same.

import ToolSlider from './ToolSlider';
import ToolPlusMinus from './ToolPlusMinus';
import ToolInput from './ToolInput';
import type { PropNumberMeta } from '@/code/components/prop-meta';

interface Props {
  /** Raw number as a string (e.g. "0.97", "16"). */
  value: string;
  /** Commit a new raw-number string. */
  onChange: (value: string) => void;
  /** Live updates during a slider drag (optional — falls back to onChange). */
  onChangeLive?: (value: string) => void;
  meta?: PropNumberMeta;
}

export default function NumberVariableEditor({ value, onChange, onChangeLive, meta }: Props) {
  const control = meta?.control ?? 'slider';
  const step = meta?.step ?? 1;
  const unit = meta?.unit && meta.unit !== 'None' ? meta.unit : undefined;
  const num = parseFloat(value);
  const safeNum = Number.isFinite(num) ? num : (meta?.min ?? 0);

  // Slider/stepper arithmetic drifts (0.37 + 0.01 → 0.38000000000000006). Round to the step's decimal
  // precision and strip trailing zeros so the input shows a clean "0.38", not "0.38000".
  const stepDecimals = (() => { const s = String(step); const i = s.indexOf('.'); return i === -1 ? 0 : s.length - i - 1; })();
  const clean = (v: number) => String(parseFloat(v.toFixed(stepDecimals)));

  if (control === 'stepper') {
    return (
      <div className="flex items-center gap-2 w-full">
        <ToolInput value={value} onChange={onChange} step={step} chevronLabel={unit} />
        <ToolPlusMinus
          value={safeNum}
          onChange={(v) => onChange(clean(v))}
          min={meta?.min ?? -Infinity}
          max={meta?.max ?? Infinity}
          step={step}
        />
      </div>
    );
  }

  // Slider needs concrete bounds; fall back to a sensible 0–100 when unbounded.
  const min = meta?.min ?? 0;
  const max = meta?.max ?? 100;
  return (
    <div className="flex items-center gap-2 w-full">
      <ToolSlider
        value={safeNum}
        min={min}
        max={max}
        step={step}
        onChange={(v) => (onChangeLive ?? onChange)(clean(v))}
        onCommit={(v) => onChange(clean(v))}
      />
      <ToolInput value={value} onChange={onChange} step={step} chevronLabel={unit} />
    </div>
  );
}
