import { describe, it, expect } from 'vitest';
import { resolveVariableIconKey } from './VariableTypeIcon';

describe('resolveVariableIconKey', () => {
  it('maps page-variable types', () => {
    expect(resolveVariableIconKey({ pageVarType: 'color' })).toBe('color');
    expect(resolveVariableIconKey({ pageVarType: 'number' })).toBe('number');
    expect(resolveVariableIconKey({ pageVarType: 'text' })).toBe('text');
    expect(resolveVariableIconKey({ pageVarType: 'boolean' })).toBe('boolean');
    expect(resolveVariableIconKey({ pageVarType: 'image' })).toBe('image');
    expect(resolveVariableIconKey({ pageVarType: 'componentCursor' })).toBe('generic');
  });

  it('maps CSS properties to icons', () => {
    expect(resolveVariableIconKey({ property: 'backgroundColor' })).toBe('color');
    expect(resolveVariableIconKey({ property: 'color' })).toBe('color');
    expect(resolveVariableIconKey({ property: 'borderRadius' })).toBe('radius');
    expect(resolveVariableIconKey({ property: 'boxShadow' })).toBe('shadow');
    expect(resolveVariableIconKey({ property: 'border' })).toBe('border');
    // Opacity is a single number → the Number glyph (the reference model: no "opacity variable", just a Number).
    expect(resolveVariableIconKey({ property: 'opacity' })).toBe('number');
    expect(resolveVariableIconKey({ property: 'backgroundImage' })).toBe('image');
  });

  it('maps boolean visibility/wrap controls to the toggle glyph', () => {
    expect(resolveVariableIconKey({ property: 'flexWrap' })).toBe('boolean');
    expect(resolveVariableIconKey({ property: 'visibility' })).toBe('boolean');
  });

  it('maps text content to the text family and enum/align controls to the option family', () => {
    expect(resolveVariableIconKey({ property: 'textContent' })).toBe('text');
    expect(resolveVariableIconKey({ property: 'flexDirection' })).toBe('option');
    expect(resolveVariableIconKey({ property: 'alignItems' })).toBe('option');
    expect(resolveVariableIconKey({ property: 'justifyContent' })).toBe('option');
    expect(resolveVariableIconKey({ property: 'textAlign' })).toBe('option');
  });

  it('maps dimension/spacing props to the number glyph', () => {
    expect(resolveVariableIconKey({ property: 'width' })).toBe('number');
    expect(resolveVariableIconKey({ property: 'paddingTop' })).toBe('number');
    expect(resolveVariableIconKey({ property: 'fontSize' })).toBe('number');
    expect(resolveVariableIconKey({ property: 'gap' })).toBe('number');
  });

  it('pageVarType wins over property when both present', () => {
    expect(resolveVariableIconKey({ pageVarType: 'boolean', property: 'backgroundColor' })).toBe('boolean');
  });

  it('falls back to value inference for orphan variables (no property)', () => {
    expect(resolveVariableIconKey({ value: '#c13b48' })).toBe('color');
    expect(resolveVariableIconKey({ value: '1px solid #000' })).toBe('border');
    expect(resolveVariableIconKey({ value: '0px 4px 8px rgba(0,0,0,0.25)' })).toBe('shadow');
  });

  it('defaults to generic when nothing resolves', () => {
    expect(resolveVariableIconKey({})).toBe('generic');
    expect(resolveVariableIconKey({ value: '12px' })).toBe('generic'); // ambiguous dimension
    expect(resolveVariableIconKey({ property: 'someUnknownProp' })).toBe('generic');
  });
});
