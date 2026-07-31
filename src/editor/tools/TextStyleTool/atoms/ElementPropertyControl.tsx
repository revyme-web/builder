// ElementPropertyControl.tsx — Element-level CSS property control.
// For properties like textTransform, whiteSpace, writingMode that read from node styles (not TipTap marks).
// Uses resolveControl() for control type detection, falls back to text input.

import { ToolInput, ToolSelect, ControlLabel } from '../../../controls';
import { resolveControl } from '../../../controls/control-registry';
import { useControl } from '../../../controls/ControlProvider';
import { trace } from '@/shared/debug-trace';

interface ElementPropertyControlProps {
  property: string;
  label: string;
  /** External value (for preset editing mode) */
  value?: string;
  /** External onChange (for preset editing mode) */
  onChange?: (value: string) => void;
}

export function ElementPropertyControl({ property, label, value: externalValue, onChange: externalOnChange }: ElementPropertyControlProps) {
  const isExternal = externalValue !== undefined && externalOnChange !== undefined;
  const ctrl = isExternal ? null : useControl(); // eslint-disable-line react-hooks/rules-of-hooks
  const value = isExternal ? externalValue! : (ctrl!.styles[property] || '');
  const setValue = isExternal ? externalOnChange! : (v: string) => ctrl!.updateStyle(property, v);
  const registryDef = resolveControl(property);

  trace.fn('ElementPropertyControl:render', { property, label, value, isExternal, controlType: registryDef?.type });

  if (registryDef?.type === 'select') {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label={label} property={property} plain={isExternal} />
        <ToolSelect value={value} onChange={setValue} options={registryDef.options} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property={property} plain={isExternal} />
      <ToolInput value={value} onChange={setValue} text />
    </div>
  );
}
