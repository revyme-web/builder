// TextFillControl.tsx — Text background highlight control.
// Reads from text.get('backgroundColor'), uses ColorInput with onRemove.
// Shows mixed gradient when isMixed.

import { ColorInput, ControlLabel, ControlActionRow, ColorSwatch, RemoveButton } from '../../../controls';
import { LegacyVariableBoundPill } from '../../../controls/VariableBoundPill';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useControl } from '../../../controls/ControlProvider';
import { CmsBoundPill } from '../../../controls/CmsBoundPill';
import { mixedColorGradient } from '../text-helpers';
import { trace } from '@/shared/debug-trace';

export function TextFillControl() {
  const text = useTextStyles();
  const { cmsBinding, getValueSource, removeVariable } = useControl();
  const fillResult = text.get('backgroundColor');
  const value = fillResult.value;
  const hasNone = !value || value === 'transparent' || value === 'none';

  trace.fn('TextFillControl:render', { value, hasNone, isMixed: fillResult.isMixed, isEditing: text.isEditing });

  // CMS-bound: blue pill in the value column, same pattern as ContentControl
  // and TextColorControl. Takes priority over the normal swatch + value.
  if (cmsBinding?.getBindingForProperty('backgroundColor')) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Fill" property="backgroundColor" />
        <CmsBoundPill property="backgroundColor" fallbackValue={value || ''} />
      </div>
    );
  }

  // Variable-bound: swap the swatch button for the variable pill, mirroring
  // TextColorControl. Uses the legacy `getValueSource` so the bound state
  // matches what ControlLabel detects (it looks at the same source). Without
  // this branch, binding `backgroundColor: someVar` showed two-line
  // bound label but the value column still rendered a yellow color swatch.
  const fillVarSource = getValueSource('backgroundColor');
  const isFillVar = fillVarSource.source === 'prop' && !!fillVarSource.ref;
  if (isFillVar) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Fill" property="backgroundColor" />
        <LegacyVariableBoundPill
          property="backgroundColor"
          propertyLabel="Fill"
          variableRef={fillVarSource.ref!}
          currentValue={value || ''}
          removeVariable={removeVariable}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Fill" property="backgroundColor" />
      {fillResult.isMixed ? (
        <ControlActionRow onClick={() => text.set('backgroundColor', fillResult.mixedValues?.[0] || '#ffff00')}>
          <ColorSwatch style={{ background: mixedColorGradient(fillResult.mixedValues || []) }} />
          <span className="text-xs truncate flex-1 text-[var(--text-secondary)]">Mixed</span>
          <RemoveButton onClick={() => text.set('backgroundColor', '')} />
        </ControlActionRow>
      ) : (
        <ColorInput
          // `value` is only the PICKER's starting color. With no fill set the
          // row renders the checkerboard + "Add" (see `empty`) instead of
          // painting that fallback as if it were the real value — an unset
          // text fill showed a solid yellow swatch reading `#FFFF00`, which
          // looks like an applied fill (user report 2026-08-10). Matches the
          // Styles Fill row's empty state.
          value={value || '#ffff00'}
          empty={hasNone}
          onChange={(c) => text.set('backgroundColor', c)}
          onChangeLive={(c) => text.setLive('backgroundColor', c)}
          showAlpha
          onRemove={hasNone ? undefined : () => text.set('backgroundColor', '')}
        />
      )}
    </div>
  );
}
