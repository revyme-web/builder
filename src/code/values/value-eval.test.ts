import { describe, it, expect } from 'vitest';
import { isTruthy, toNumber, unquote, coerceScalar, evaluate } from './value-eval';

describe('value-eval: isTruthy (canonical toggle OFF-states)', () => {
  it('OFF states → false', () => {
    for (const off of ['false', '', '0', 'undefined', 'null', 'no', 'No']) {
      expect(isTruthy(off)).toBe(false);
    }
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(undefined)).toBe(false);
  });
  it('everything else → true (matches live `prop ? a : b`)', () => {
    for (const on of ['true', 'none', 'yes', 'Yes', 'block', 'flex', '1', '46px', 'NaN', 'anything']) {
      expect(isTruthy(on)).toBe(true);
    }
  });
});

describe('value-eval: toNumber ({n,unit,ok}, never NaN-leaks)', () => {
  it('parses number + unit', () => {
    expect(toNumber('16px')).toEqual({ n: 16, unit: 'px', ok: true });
    expect(toNumber('16')).toEqual({ n: 16, unit: '', ok: true });
    expect(toNumber('1.5rem')).toEqual({ n: 1.5, unit: 'rem', ok: true });
    expect(toNumber('50%')).toEqual({ n: 50, unit: '%', ok: true });
    expect(toNumber('-0.5em')).toEqual({ n: -0.5, unit: 'em', ok: true });
    expect(toNumber('.5')).toEqual({ n: 0.5, unit: '', ok: true });
    expect(toNumber('100vh')).toEqual({ n: 100, unit: 'vh', ok: true });
  });
  it('non-numeric → ok:false, n:0 (no NaN leak)', () => {
    for (const bad of ['', 'auto', 'calc(100% - 10px)', 'rgb(0,0,0)', null, undefined]) {
      const r = toNumber(bad as any);
      expect(r.ok).toBe(false);
      expect(r.n).toBe(0);
    }
  });
  it('unwraps a corrupted numeric literal before parsing', () => {
    expect(toNumber('"46px"')).toEqual({ n: 46, unit: 'px', ok: true });   // the `"\"46px\""` bug
    expect(toNumber('\\"46px\\"')).toEqual({ n: 46, unit: 'px', ok: true });
  });
});

describe('value-eval: unquote (conservative, whole-value only)', () => {
  it('strips whole-value wrapping quotes', () => {
    expect(unquote('"46px"')).toBe('46px');
    expect(unquote("'46px'")).toBe('46px');
    expect(unquote('\\"46px\\"')).toBe('46px');
    expect(unquote('46px')).toBe('46px');           // already clean — no change
  });
  it('LEAVES legitimate quoted CSS intact (closing quote not at end)', () => {
    expect(unquote('"Helvetica Neue", sans-serif')).toBe('"Helvetica Neue", sans-serif');
    expect(unquote('rgb(0,0,0)')).toBe('rgb(0,0,0)');
    expect(unquote('0px none rgb(0, 0, 0)')).toBe('0px none rgb(0, 0, 0)');
  });
});

describe('value-eval: coerceScalar (shared CodeComponentHost/sandbox body)', () => {
  it('coerces unambiguous scalars only', () => {
    expect(coerceScalar('true')).toBe(true);
    expect(coerceScalar('false')).toBe(false);
    expect(coerceScalar('42')).toBe(42);
    expect(coerceScalar('-3.5')).toBe(-3.5);
  });
  it('keeps unit-bearing + non-scalar strings as strings (matches old gated behavior)', () => {
    expect(coerceScalar('16px')).toBe('16px');     // NOT coerced — has a unit
    expect(coerceScalar('hello')).toBe('hello');
    expect(coerceScalar('rgb(0,0,0)')).toBe('rgb(0,0,0)');
  });
  it('passes non-strings through untouched', () => {
    expect(coerceScalar(7)).toBe(7);
    expect(coerceScalar(true)).toBe(true);
    const obj = { a: 1 }; expect(coerceScalar(obj)).toBe(obj);
  });
});

describe('value-eval: evaluate (type-driven)', () => {
  it('boolean → isTruthy', () => {
    expect(evaluate('none', 'boolean')).toBe(true);
    expect(evaluate('false', 'boolean')).toBe(false);
  });
  it('number → parsed number, non-numeric falls back to raw (never silently 0)', () => {
    expect(evaluate('16px', 'number')).toBe(16);
    expect(evaluate('42', 'number')).toBe(42);
    expect(evaluate('auto', 'number')).toBe('auto');   // fallback, not 0
  });
  it('text/color/image → raw unchanged (quotes may be legitimate)', () => {
    expect(evaluate('"Helvetica", sans-serif', 'text')).toBe('"Helvetica", sans-serif');
    expect(evaluate('rgb(1,2,3)', 'color')).toBe('rgb(1,2,3)');
    expect(evaluate('/img/x.png', 'image')).toBe('/img/x.png');
  });
});
