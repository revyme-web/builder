import { describe, test, expect } from 'vitest';
import {
  parsePropMeta, getPropDescription, getPropType, getPropOptions, getPropLabel,
  setPropDescriptionInCode, setPropTypeInCode, setPropOptionsInCode, setPropLabelInCode,
  getPropNumberMeta, setPropNumberMetaInCode, getPropVariantOf, setPropVariantOfInCode,
} from './prop-meta';

describe('prop-meta variantOf (variant-variable → component identity)', () => {
  test('set/get round-trips + coexists with label', () => {
    let code = `'use client';\nfn`;
    code = setPropLabelInCode(code, 'startTrialButtonVariant', 'Start1');
    code = setPropVariantOfInCode(code, 'startTrialButtonVariant', 'StartTrialButton');
    expect(getPropVariantOf(code, 'startTrialButtonVariant')).toBe('StartTrialButton');
    expect(getPropLabel(code, 'startTrialButtonVariant')).toBe('Start1');
    // survives a parse → serialize cycle (label edit) — the variantOf must persist
    code = setPropLabelInCode(code, 'startTrialButtonVariant', 'Renamed Label');
    expect(getPropVariantOf(code, 'startTrialButtonVariant')).toBe('StartTrialButton');
  });
  test('empty tag REMOVES it (and prunes the entry if now empty)', () => {
    let code = `'use client';\nfn`;
    code = setPropVariantOfInCode(code, 'v', 'Comp');
    code = setPropVariantOfInCode(code, 'v', '');
    expect(getPropVariantOf(code, 'v')).toBe('');
    expect(code).not.toContain('@propMeta'); // entry was only variantOf → block dropped
  });
});

describe('prop-meta', () => {
  test('parsePropMeta returns {} when no block present', () => {
    expect(parsePropMeta(`function Foo({ x = '1px' }) {}`)).toEqual({});
  });

  test('parsePropMeta reads object-form entries (type + description + options)', () => {
    const code = `/** @propMeta {"zefzef":{"type":"border","description":"Card border"},"size":{"type":"option","options":["sm","lg"]}} */\nfn`;
    expect(parsePropMeta(code)).toEqual({
      zefzef: { type: 'border', description: 'Card border' },
      size: { type: 'option', options: ['sm', 'lg'] },
    });
  });

  test('parsePropMeta reads LEGACY string entries as description-only', () => {
    const code = `/** @propMeta {"zefzef":"Card border"} */\nfn`;
    expect(parsePropMeta(code)).toEqual({ zefzef: { description: 'Card border' } });
  });

  test('parsePropMeta returns {} on malformed JSON (no throw)', () => {
    expect(parsePropMeta(`/** @propMeta {bad json} */\nfn`)).toEqual({});
  });

  test('getters read individual fields', () => {
    const code = `/** @propMeta {"c":{"type":"color","description":"Brand","options":["a","b"]}} */\nfn`;
    expect(getPropDescription(code, 'c')).toBe('Brand');
    expect(getPropType(code, 'c')).toBe('color');
    expect(getPropOptions(code, 'c')).toEqual(['a', 'b']);
    expect(getPropType(code, 'missing')).toBe('');
    expect(getPropOptions(code, 'missing')).toEqual([]);
  });

  test('setPropTypeInCode inserts a fresh block after the use-client directive', () => {
    const code = `'use client';\n\nfunction Card({ count = 0 }) {}`;
    const out = setPropTypeInCode(code, 'count', 'number');
    expect(out).toContain(`/** @propMeta {"count":{"type":"number"}} */`);
    expect(out.indexOf(`'use client'`)).toBeLessThan(out.indexOf('@propMeta'));
    expect(getPropType(out, 'count')).toBe('number');
  });

  test('type + description + options coexist on one prop (independent upserts)', () => {
    let code = `function Card({ size = 'sm' }) {}`;
    code = setPropTypeInCode(code, 'size', 'option');
    code = setPropDescriptionInCode(code, 'size', 'T-shirt size');
    code = setPropOptionsInCode(code, 'size', ['sm', 'md', 'lg']);
    expect(parsePropMeta(code).size).toEqual({ type: 'option', description: 'T-shirt size', options: ['sm', 'md', 'lg'] });
    // Only one block exists.
    expect(code.match(/@propMeta/g)?.length).toBe(1);
  });

  test('clearing the last field drops the entry, then the block', () => {
    let code = `/** @propMeta {"a":{"description":"one"}} */\nfn`;
    code = setPropDescriptionInCode(code, 'a', '');
    expect(code).not.toContain('@propMeta');
  });

  test('setPropOptionsInCode trims + drops empties; [] removes options', () => {
    let code = setPropOptionsInCode(`fn`, 'size', [' sm ', '', 'lg']);
    expect(getPropOptions(code, 'size')).toEqual(['sm', 'lg']);
    code = setPropOptionsInCode(code, 'size', []);
    expect(code).not.toContain('@propMeta');
  });

  test('label (friendly display name) coexists with type/description', () => {
    let code = `function Card({ overflow = 'visible' }) {}`;
    code = setPropTypeInCode(code, 'overflow', 'option');
    code = setPropLabelInCode(code, 'overflow', 'Overflow 2');
    expect(getPropLabel(code, 'overflow')).toBe('Overflow 2');
    expect(parsePropMeta(code).overflow).toEqual({ type: 'option', label: 'Overflow 2' });
    // Empty label clears it.
    code = setPropLabelInCode(code, 'overflow', '');
    expect(getPropLabel(code, 'overflow')).toBe('');
  });

  test('number meta (min/max/step/unit/control) round-trips, keeping 0', () => {
    let code = `function Card({ opacity = 1 }) {}`;
    code = setPropTypeInCode(code, 'opacity', 'number');
    code = setPropNumberMetaInCode(code, 'opacity', { min: 0, max: 1, step: 0.01, unit: 'None', control: 'slider' });
    expect(getPropNumberMeta(code, 'opacity')).toEqual({ min: 0, max: 1, step: 0.01, unit: 'None', control: 'slider' });
    expect(parsePropMeta(code).opacity).toEqual({ type: 'number', min: 0, max: 1, step: 0.01, unit: 'None', control: 'slider' });
  });

  test('number meta: null clears a field, undefined leaves it', () => {
    let code = setPropNumberMetaInCode(`fn`, 'n', { min: 0, max: 100, step: 1, control: 'stepper' });
    code = setPropNumberMetaInCode(code, 'n', { max: null }); // clear max only
    expect(getPropNumberMeta(code, 'n')).toEqual({ min: 0, step: 1, control: 'stepper' });
    code = setPropNumberMetaInCode(code, 'n', { step: 2 }); // leave min/control, change step
    expect(getPropNumberMeta(code, 'n')).toEqual({ min: 0, step: 2, control: 'stepper' });
  });

  test('number meta coexists with type + label', () => {
    let code = `function Card({ rot = 0 }) {}`;
    code = setPropTypeInCode(code, 'rot', 'number');
    code = setPropLabelInCode(code, 'rot', 'Rotation');
    code = setPropNumberMetaInCode(code, 'rot', { min: 0, max: 360, step: 1, unit: 'deg' });
    expect(parsePropMeta(code).rot).toEqual({ type: 'number', label: 'Rotation', min: 0, max: 360, step: 1, unit: 'deg' });
  });

  test('setProp* upserts an existing block without duplicating it', () => {
    let code = `/** @propMeta {"a":{"type":"number"}} */\nfn`;
    code = setPropTypeInCode(code, 'b', 'color');
    expect(parsePropMeta(code)).toEqual({ a: { type: 'number' }, b: { type: 'color' } });
    expect(code.match(/@propMeta/g)?.length).toBe(1);
  });
});
