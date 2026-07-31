// variable-editor-registry.test.ts
// Lock in coverage of the atoms that ship in StylesTool and confirm fallback.

import { describe, it, expect } from 'vitest';
import {
  resolveVariableEditor,
  listRegisteredVariableProperties,
  registerVariableEditor,
} from './variable-editor-registry';

describe('variable-editor-registry', () => {
  // The properties we promise to handle in the modal with the rich, atom-based
  // editor. Anything in StylesTool's right-panel layout should be here.
  const REQUIRED_PROPERTIES = [
    'backgroundColor', 'background', 'backgroundImage',
    'color', 'boxShadow', 'filter', 'mask', 'clipPath',
    'borderRadius', 'border',
    'padding', 'margin',
    'overflow', 'display', 'flexDirection',
    'transform', 'zIndex', 'opacity',
    'transition',
  ];

  it('resolves every required CSS property to a non-null atom', () => {
    const missing: string[] = [];
    for (const prop of REQUIRED_PROPERTIES) {
      if (!resolveVariableEditor(prop)) missing.push(prop);
    }
    expect(missing).toEqual([]);
  });

  it('returns null for unmapped properties (caller falls back to text/numeric)', () => {
    expect(resolveVariableEditor('totallyMadeUpProperty')).toBeNull();
    expect(resolveVariableEditor('')).toBeNull();
  });

  it('exposes a stable list for downstream tests / docs', () => {
    const registered = listRegisteredVariableProperties();
    expect(new Set(registered)).toEqual(new Set(REQUIRED_PROPERTIES));
  });

  it('registerVariableEditor adds new entries (used by feature modules)', () => {
    const fakeAtom = (() => null) as any;
    registerVariableEditor('myCustomProp', fakeAtom);
    expect(resolveVariableEditor('myCustomProp')).toBe(fakeAtom);
  });
});
