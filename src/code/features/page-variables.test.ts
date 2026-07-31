import { describe, test, expect } from 'vitest';
import {
  parsePageVariables,
  serializePageVariables,
  updatePageVariablesInCode,
  stripPageVariables,
  addPageVariableInCode,
  removePageVariableInCode,
  updatePageVariableInCode,
  getPageVariables,
  defaultForType,
  type PageVariable,
} from './page-variables';

// ─── parse / serialize round-trip ──────────────────────────────────────────

describe('parsePageVariables', () => {
  test('returns null when no annotation block', () => {
    const code = `'use client';\nfunction Page() { return <div/>; }`;
    expect(parsePageVariables(code)).toBeNull();
  });

  test('parses an empty variables array', () => {
    const code = `/** @pageVariables { "variables": [] } */\nfunction Page() {}`;
    expect(parsePageVariables(code)).toEqual({ variables: [] });
  });

  test('parses a single number variable', () => {
    const code = `/** @pageVariables {
  "variables": [
    { "name": "fade", "type": "number", "default": "0.5" }
  ]
} */\n`;
    expect(parsePageVariables(code)).toEqual({
      variables: [{ name: 'fade', type: 'number', default: '0.5' }],
    });
  });

  test('parses all four primitive types', () => {
    const code = `/** @pageVariables {
  "variables": [
    { "name": "n",  "type": "number",  "default": "1"       },
    { "name": "t",  "type": "text",    "default": "hello"   },
    { "name": "b",  "type": "boolean", "default": "false"   },
    { "name": "c",  "type": "color",   "default": "#ff0000" }
  ]
} */`;
    const parsed = parsePageVariables(code);
    expect(parsed?.variables).toHaveLength(4);
    expect(parsed?.variables.map(v => v.type)).toEqual(['number', 'text', 'boolean', 'color']);
  });

  test('preserves queryParam when present', () => {
    const code = `/** @pageVariables {
  "variables": [
    { "name": "category", "type": "text", "default": "all", "queryParam": "cat" }
  ]
} */`;
    expect(parsePageVariables(code)?.variables[0].queryParam).toBe('cat');
  });

  test('returns null on malformed JSON (does not throw)', () => {
    const code = `/** @pageVariables { not valid json } */`;
    expect(parsePageVariables(code)).toBeNull();
  });

  test('coerces non-string default to string', () => {
    const code = `/** @pageVariables {
  "variables": [{ "name": "n", "type": "number", "default": 42 }]
} */`;
    expect(parsePageVariables(code)?.variables[0].default).toBe('42');
  });
});

// ─── serialize round-trip ────────────────────────────────────────────────────

describe('serializePageVariables', () => {
  test('round-trips through parse', () => {
    const original: PageVariable[] = [
      { name: 'fade', type: 'number', default: '0.5' },
      { name: 'tag',  type: 'text',   default: 'all', queryParam: 'q' },
    ];
    const serialized = serializePageVariables({ variables: original });
    const parsed = parsePageVariables(serialized);
    expect(parsed?.variables).toEqual(original);
  });

  test('omits queryParam from output when not set', () => {
    const out = serializePageVariables({
      variables: [{ name: 'n', type: 'number', default: '1' }],
    });
    expect(out).not.toContain('queryParam');
  });
});

// ─── updatePageVariablesInCode ──────────────────────────────────────────────

describe('updatePageVariablesInCode', () => {
  test('inserts after use client when no block exists', () => {
    const code = `'use client';\n\nfunction Page() { return <div/>; }`;
    const out = updatePageVariablesInCode(code, {
      variables: [{ name: 'fade', type: 'number', default: '1' }],
    });
    expect(out).toMatch(/'use client';\s*\n\s*\/\*\*\s*@pageVariables/);
    expect(out).toContain('function Page()');
  });

  test('replaces existing block in place', () => {
    const code = `/** @pageVariables { "variables": [{"name":"old","type":"text","default":"x"}] } */\nfunction Page() {}`;
    const out = updatePageVariablesInCode(code, {
      variables: [{ name: 'fresh', type: 'number', default: '2' }],
    });
    expect(out).not.toContain('"name": "old"');
    expect(out).toContain('"name": "fresh"');
    expect((out.match(/@pageVariables/g) ?? []).length).toBe(1);
  });

  test('inserts after @canvas block when present', () => {
    const code = `'use client';\n/** @canvas { "viewports": [], "positions": {} } */\nfunction Page() {}`;
    const out = updatePageVariablesInCode(code, {
      variables: [{ name: 'fade', type: 'number', default: '1' }],
    });
    const canvasIdx = out.indexOf('@canvas');
    const varsIdx = out.indexOf('@pageVariables');
    expect(canvasIdx).toBeGreaterThan(-1);
    expect(varsIdx).toBeGreaterThan(canvasIdx);
  });

  test('inserts at top when no use client / no canvas block', () => {
    const code = `function Page() { return <div/>; }`;
    const out = updatePageVariablesInCode(code, {
      variables: [{ name: 'n', type: 'number', default: '1' }],
    });
    expect(out.indexOf('@pageVariables')).toBeLessThan(out.indexOf('function Page'));
  });
});

// ─── strip ───────────────────────────────────────────────────────────────────

describe('stripPageVariables', () => {
  test('removes block', () => {
    const code = `/** @pageVariables { "variables": [] } */\nfunction Page() {}`;
    expect(stripPageVariables(code)).toBe('function Page() {}');
  });

  test('no-op when block missing', () => {
    const code = `function Page() {}`;
    expect(stripPageVariables(code)).toBe(code);
  });
});

// ─── CRUD helpers ────────────────────────────────────────────────────────────

describe('addPageVariableInCode', () => {
  test('adds first variable to a clean file', () => {
    const code = `'use client';\nfunction Page() {}`;
    const out = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    expect(getPageVariables(out)).toEqual([{ name: 'fade', type: 'number', default: '1' }]);
  });

  test('appends a second variable', () => {
    let code = `'use client';\nfunction Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    code = addPageVariableInCode(code, { name: 'tag', type: 'text', default: 'all' });
    expect(getPageVariables(code).map(v => v.name)).toEqual(['fade', 'tag']);
  });

  test('rejects duplicate name (no-op)', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    const before = code;
    code = addPageVariableInCode(code, { name: 'fade', type: 'text', default: 'oops' });
    expect(code).toBe(before);
  });
});

describe('removePageVariableInCode', () => {
  test('removes a variable by name', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    code = addPageVariableInCode(code, { name: 'tag', type: 'text', default: 'all' });
    code = removePageVariableInCode(code, 'fade');
    expect(getPageVariables(code).map(v => v.name)).toEqual(['tag']);
  });

  test('strips the whole block when removing the last variable', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    code = removePageVariableInCode(code, 'fade');
    expect(code).not.toContain('@pageVariables');
  });

  test('no-op when variable missing', () => {
    const code = `function Page() {}`;
    expect(removePageVariableInCode(code, 'doesNotExist')).toBe(code);
  });
});

describe('updatePageVariableInCode', () => {
  test('changes default value', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    code = updatePageVariableInCode(code, 'fade', { default: '0.5' });
    expect(getPageVariables(code)[0].default).toBe('0.5');
  });

  test('renames a variable', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });
    code = updatePageVariableInCode(code, 'fade', { name: 'opacity' });
    expect(getPageVariables(code)[0].name).toBe('opacity');
  });

  test('adds queryParam', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'tag', type: 'text', default: 'all' });
    code = updatePageVariableInCode(code, 'tag', { queryParam: 'q' });
    expect(getPageVariables(code)[0].queryParam).toBe('q');
  });

  test('clears queryParam when set to empty string', () => {
    let code = `function Page() {}`;
    code = addPageVariableInCode(code, { name: 'tag', type: 'text', default: 'all', queryParam: 'q' });
    code = updatePageVariableInCode(code, 'tag', { queryParam: '' });
    expect(getPageVariables(code)[0].queryParam).toBeUndefined();
  });
});

describe('defaultForType', () => {
  test('per-type defaults', () => {
    expect(defaultForType('number')).toBe('1');
    expect(defaultForType('text')).toBe('');
    expect(defaultForType('boolean')).toBe('false');
    expect(defaultForType('color')).toBe('#000000');
    expect(defaultForType('image')).toBe('');
  });
});

describe('pageVariableTypeForProperty', () => {
  test.each([
    ['opacity', 'number'],
    ['fontWeight', 'number'],
    ['lineHeight', 'number'],
    ['rotate', 'number'],
    ['scale', 'number'],
  ])('%s → number', async (prop, expected) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBe(expected);
  });

  test.each([
    ['color', 'color'],
    ['backgroundColor', 'color'],
    ['borderColor', 'color'],
    ['fill', 'color'],
    ['stroke', 'color'],
  ])('%s → color', async (prop, expected) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBe(expected);
  });

  test.each([
    ['backgroundImage', 'image'],
    ['background', 'image'],
    ['maskImage', 'image'],
    ['src', 'image'],
  ])('%s → image (proper picker, not text)', async (prop, expected) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBe(expected);
  });

  test.each([
    ['textContent', 'text'],
    ['alt', 'text'],
    ['href', 'text'],
  ])('%s → text', async (prop, expected) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBe(expected);
  });

  test.each([
    ['display', 'boolean'],
    ['visibility', 'boolean'],
  ])('%s → boolean (visibility-style, ternary binding)', async (prop, expected) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBe(expected);
  });

  test.each([
    'overflow', 'cursor', 'flexDirection',
  ])('%s → null (enum-like, no compatible variable type)', async (prop) => {
    const { pageVariableTypeForProperty } = await import('./page-variables');
    expect(pageVariableTypeForProperty(prop)).toBeNull();
  });
});

describe('isConditionalDisplayProperty', () => {
  test('display and visibility are conditional', async () => {
    const { isConditionalDisplayProperty } = await import('./page-variables');
    expect(isConditionalDisplayProperty('display')).toBe(true);
    expect(isConditionalDisplayProperty('visibility')).toBe(true);
    expect(isConditionalDisplayProperty('opacity')).toBe(false);
  });
});

describe('conditionalBranchesFor', () => {
  test('display → none / empty', async () => {
    const { conditionalBranchesFor } = await import('./page-variables');
    expect(conditionalBranchesFor('display')).toEqual({ consequent: 'none', alternate: '' });
  });

  test('visibility → hidden / empty', async () => {
    const { conditionalBranchesFor } = await import('./page-variables');
    expect(conditionalBranchesFor('visibility')).toEqual({ consequent: 'hidden', alternate: '' });
  });

  test('non-visibility property → null', async () => {
    const { conditionalBranchesFor } = await import('./page-variables');
    expect(conditionalBranchesFor('opacity')).toBeNull();
  });
});
