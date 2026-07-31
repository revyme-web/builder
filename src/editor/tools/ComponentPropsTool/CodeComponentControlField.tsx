// ComponentPropsTool/CodeComponentControlField.tsx — lifted verbatim from
// ComponentPropsTool.tsx (Phase 7 god-file split, item 7.5).

import type { ComponentControlDef } from '@/code/components/controls-parser';
import { ToolInput, ToolSelect, ToolSegmentedControl } from '../../controls';
import { YES_NO_OPTIONS } from '../../controls/css-property-options';
import ColorInput from '../../controls/ColorInput';
import UploadControl from '../../controls/UploadControl';
import ImageListControl from '../ImageListControl';
import NumberVariableEditor from '../../controls/NumberVariableEditor';
import { FontFamilyControl } from '../TextStyleTool/atoms/FontFamilyControl';

/**
 * Render a Code component `@control` as an editable field — the SAME control the user
 * sees in the code-component tool (color picker for `color`, slider+input for
 * `slider`/`number`, segmented for `toggle`, select for `select`, upload for
 * `upload`). Used in two places where a code-component-bound value would otherwise fall
 * to a bare text input:
 *   1. The VariableModal's "Default Value" when creating a variable FROM a
 *      code component control.
 *   2. The page-instance editor of a design component whose prop forwards into
 *      a code component control (e.g. `<FilmGrain intensity={prop} />`).
 *
 * `onChangeLive` (optional) fires continuously during drag for instant canvas
 * preview; `onChange` commits. In the modal there's no live preview, so only
 * `onChange` is passed.
 */
export function CodeComponentControlField({
  controlDef,
  value,
  onChange,
  onChangeLive,
}: {
  controlDef: ComponentControlDef;
  value: string;
  onChange: (v: string) => void;
  onChangeLive?: (v: string) => void;
}) {
  const defaultStr = controlDef.default != null && typeof controlDef.default === 'object'
    ? JSON.stringify(controlDef.default)
    : String(controlDef.default ?? '');

  switch (controlDef.type) {
    case 'color':
      return (
        <ColorInput
          value={value || defaultStr}
          onChange={onChange}
          onChangeLive={onChangeLive}
        />
      );
    case 'slider':
    case 'number': {
      // Same number editor as a Number variable — bounded/`slider` → slider+input, else input + −/+ stepper.
      const control: 'slider' | 'stepper' = controlDef.type === 'slider'
        || (controlDef.min !== undefined && controlDef.max !== undefined && !controlDef.displayStepper)
        ? 'slider' : 'stepper';
      return (
        <NumberVariableEditor
          value={value}
          onChange={onChange}
          onChangeLive={onChangeLive}
          meta={{ control, min: controlDef.min, max: controlDef.max, step: controlDef.step ?? 1 }}
        />
      );
    }
    case 'toggle':
      return (
        <ToolSegmentedControl
          value={value === 'true' ? 'yes' : 'no'}
          onChange={(v) => onChange(v === 'yes' ? 'true' : 'false')}
          options={YES_NO_OPTIONS}
          size="sm"
        />
      );
    case 'select':
      return (
        <ToolSelect
          value={value}
          onChange={onChange}
          options={(controlDef.options || []).map(o => ({ label: o.label, value: o.value }))}
        />
      );
    case 'imageList':
      return (
        <ImageListControl
          label={controlDef.label}
          value={value}
          onChange={onChange}
          uploadSource={controlDef.uploadSource || 'uploaded'}
        />
      );
    case 'upload':
      return (
        <UploadControl
          value={value}
          onChange={onChange}
          accept={controlDef.accept || 'image/*'}
          multiple={controlDef.multiple || false}
          uploadSource={controlDef.uploadSource || 'uploaded'}
        />
      );
    case 'font':
      return <FontFamilyControl value={value} onChange={onChange} />;
    default:
      return <ToolInput value={value} onChange={onChange} text />;
  }
}
