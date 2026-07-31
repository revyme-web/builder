// ComponentPropsPanel.tsx — Controls sidebar for Component Editor.
// Uses the EXACT same control components as ComponentPropsTool.
// Rendered as a right sidebar column in the editor layout.

import type { ComponentControlDef } from '@/code/components/controls-parser';
import { ToolRow, ToolInput, ToolSlider, ToolSelect, ToolSegmentedControl } from '../controls';
import ColorInput from '../controls/ColorInput';
import UploadControl from '../controls/UploadControl';
import { trace } from '@/shared/debug-trace';

const YES_NO_OPTIONS = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];

interface ComponentPropsPanelProps {
  controls: Record<string, ComponentControlDef>;
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
}

export default function ComponentPropsPanel({ controls, values, onChange }: ComponentPropsPanelProps) {
  const entries = Object.entries(controls);

  trace.fn('ComponentPropsPanel.render', { controlCount: entries.length });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center h-9 border-b border-[var(--border-light)] px-3">
        <span className="text-[11px] font-semibold text-[var(--text-secondary)]">Controls</span>
      </div>

      {/* Controls list */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide px-3 py-2">
        {entries.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--text-disabled)]">
            No @controls defined
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {entries.map(([propName, controlDef]) => {
              const currentValue = String(values[propName] ?? controlDef.default ?? '');

              switch (controlDef.type) {
                case 'slider':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ToolSlider
                        value={parseFloat(currentValue) || (controlDef.default as number)}
                        onChange={(v) => onChange(propName, v)}
                        min={controlDef.min ?? 0}
                        max={controlDef.max ?? 100}
                        step={controlDef.step ?? 1}
                      />
                      <ToolInput
                        value={currentValue}
                        onChange={(v) => onChange(propName, parseFloat(v) || 0)}
                        step={controlDef.step ?? 1}
                      />
                    </ToolRow>
                  );
                case 'color':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ColorInput
                        value={currentValue || String(controlDef.default)}
                        onChange={(v) => onChange(propName, v)}
                      />
                    </ToolRow>
                  );
                case 'text':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ToolInput
                        value={currentValue}
                        onChange={(v) => onChange(propName, v)}
                        text
                      />
                    </ToolRow>
                  );
                case 'number':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ToolInput
                        value={currentValue}
                        onChange={(v) => onChange(propName, parseFloat(v) || 0)}
                        step={controlDef.step ?? 1}
                      />
                    </ToolRow>
                  );
                case 'toggle':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ToolSegmentedControl
                        value={currentValue === 'true' ? 'yes' : 'no'}
                        onChange={(v) => onChange(propName, v === 'yes')}
                        options={YES_NO_OPTIONS}
                      />
                    </ToolRow>
                  );
                case 'select':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <ToolSelect
                        value={currentValue}
                        onChange={(v) => onChange(propName, v)}
                        options={(controlDef.options || []).map(o => ({ label: o.label, value: o.value }))}
                      />
                    </ToolRow>
                  );
                case 'upload':
                  return (
                    <ToolRow key={propName} label={controlDef.label}>
                      <UploadControl
                        value={currentValue}
                        onChange={(v) => onChange(propName, v)}
                        accept={controlDef.accept || 'image/*'}
                        multiple={controlDef.multiple}
                      />
                    </ToolRow>
                  );
                default:
                  return null;
              }
            })}
          </div>
        )}
      </div>
    </div>
  );
}
