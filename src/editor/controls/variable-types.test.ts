import { describe, it, expect } from 'vitest';
import { getVariableType } from './variable-types';

// `@pageVariables` stores PRIMITIVE types ('boolean'/'text'/…); the editor's VariableTypeId is
// 'toggle'/'plainText'/… . getVariableType must resolve BOTH so an ORPHAN variable (×-unbound, no live
// binding to infer from) keeps its proper Default editor instead of falling back to a plain text input.
// This is the general fix — the VariableModal's render switches on activeTypeDef.editor, so resolving
// the typeDef is all that's needed for EVERY type, not just Hide.
describe('getVariableType normalizes page-var primitives → editor typeDef', () => {
  it('boolean → toggle (Yes/No editor)', () => {
    expect(getVariableType('boolean')?.id).toBe('toggle');
    expect(getVariableType('boolean')?.editor).toBe('toggle');
  });
  it('text → plainText (text editor)', () => {
    expect(getVariableType('text')?.id).toBe('plainText');
  });
  it('number/color/image already coincide with their typeId', () => {
    expect(getVariableType('number')?.editor).toBe('number');
    expect(getVariableType('color')?.id).toBe('color');
    expect(getVariableType('image')?.id).toBe('image');
  });
  it('a real VariableTypeId still resolves unchanged', () => {
    expect(getVariableType('toggle')?.id).toBe('toggle');
    expect(getVariableType('option')?.id).toBe('option');
    expect(getVariableType('border')?.id).toBe('border');
  });
  it('unknown / undefined → undefined', () => {
    expect(getVariableType(undefined)).toBeUndefined();
    expect(getVariableType('nope')).toBeUndefined();
  });
});

describe('noDefault types — the modal hides their Default row', () => {
  // A link's value only means something per-instance ("where does THIS card
  // go"), so a default is noise (user report 2026-08-26); cursors never had
  // one. Every other type keeps its Default editor.
  it('link and componentCursor are noDefault', () => {
    expect(getVariableType('link')?.noDefault).toBe(true);
    expect(getVariableType('componentCursor')?.noDefault).toBe(true);
  });
  it('value-carrying types are NOT noDefault', () => {
    for (const id of ['plainText', 'number', 'color', 'toggle', 'option', 'image', 'border', 'shadow']) {
      expect(getVariableType(id)?.noDefault ?? false).toBe(false);
    }
  });
});
