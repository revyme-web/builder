import { describe, it, expect } from 'vitest';
import { setPropTypeInCode, setPropOptionsInCode, getPropType, getPropOptions, getPropOptionsLocked } from './prop-meta';

// CSS-enum variables (justify/align/wrap/…) store `optionsLocked: true` so the Variable modal renders
// a plain, non-editable select — the values are fixed by the CSS property and an editable list would
// let the user type an arbitrary value that breaks it.
describe('@propMeta locked CSS-enum options', () => {
  it('stores + reads type=option, options, and optionsLocked', () => {
    let code = `function C({ justify = "center" }) { return null; }`;
    code = setPropTypeInCode(code, 'justify', 'option');
    code = setPropOptionsInCode(code, 'justify', ['flex-start', 'center', 'space-between'], true);
    expect(getPropType(code, 'justify')).toBe('option');
    expect(getPropOptions(code, 'justify')).toEqual(['flex-start', 'center', 'space-between']);
    expect(getPropOptionsLocked(code, 'justify')).toBe(true);
    expect(code).toContain('"optionsLocked":true');
  });

  it('a normal (user-defined) option list is NOT locked → editable list', () => {
    let code = `function C({ pick = "a" }) { return null; }`;
    code = setPropOptionsInCode(code, 'pick', ['a', 'b']); // no locked arg
    expect(getPropOptionsLocked(code, 'pick')).toBe(false);
    expect(code).not.toContain('optionsLocked');
  });
});
