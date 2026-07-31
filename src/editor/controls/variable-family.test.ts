import { describe, it, expect } from 'vitest';
import { acceptedVariableFamilies, resolveVariableIconKey } from './VariableTypeIcon';

// The "Set Variable" submenu (ControlLabel) only offers variables whose FAMILY matches the control's.
// A control resolving to 'generic' suppresses the whole submenu — so every bindable control must map
// to a concrete family, and every typed variable must resolve to one even when orphaned (×-unbound).
describe('control ↔ variable family matching (Set Variable submenu)', () => {
  it('Hide/Wrap toggle controls accept the boolean family (display was missing → no Set Variable)', () => {
    expect(acceptedVariableFamilies('display')).toEqual(['boolean']);
    expect(acceptedVariableFamilies('visibility')).toEqual(['boolean']);
    expect(acceptedVariableFamilies('flexWrap')).toEqual(['boolean']);
  });

  it('a typed page-var resolves to its family by declared type, even with no live binding', () => {
    expect(resolveVariableIconKey({ pageVarType: 'boolean' })).toBe('boolean');
    expect(resolveVariableIconKey({ pageVarType: 'number' })).toBe('number');
    expect(resolveVariableIconKey({ pageVarType: 'color' })).toBe('color');
    expect(resolveVariableIconKey({ property: 'display' })).toBe('boolean'); // via the CSS prop too
  });

  it('regression: Fill accepts color/gradient/image; numeric/option controls unchanged', () => {
    expect(acceptedVariableFamilies('backgroundColor')).toEqual(['color', 'gradient', 'image']);
    expect(acceptedVariableFamilies('opacity')).toEqual(['number']);
    expect(acceptedVariableFamilies('flexDirection')).toEqual(['option']);
  });
});
