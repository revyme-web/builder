// generator-utils.test.ts — Tests for the shared generation primitives that
// were consolidated in phase-9 (9.1i render-return splice, 9.2a close-tag
// matcher, 9.2b style-object end, 9.2c import splicing, 9.2d/e tag-attr
// helpers, 9.2f media-query gate scan). Behavior locked here is what ~40
// former per-file copies relied on.

import { describe, it, expect } from 'vitest';
import {
  findMatchingCloseTagIndex,
  findStyleObjectEnd,
  insertBeforeRenderReturn,
  insertAfterLastImportLine,
  ensureNamedImport,
  stripTagAttrBalanced,
  extractObjectEntryBalanced,
  setTagAttr,
  getJsonAttr,
  setJsonAttr,
  stripJsonAttr,
  scanGates,
} from './generator-utils';

describe('findMatchingCloseTagIndex', () => {
  it('balances same-name nested opens/closes', () => {
    const code = '<div a><div b></div></div>';
    const idx = findMatchingCloseTagIndex(code, 'div', '<div a>'.length);
    expect(code.slice(idx)).toBe('</div>');
    expect(idx).toBe(code.length - '</div>'.length);
  });

  it('skips self-closing same-tag children (no closer to balance)', () => {
    const code = '<div a><div dot />\n<div dot /></div>';
    const idx = findMatchingCloseTagIndex(code, 'div', '<div a>'.length);
    expect(idx).toBe(code.length - '</div>'.length);
  });

  it('ignores longer tag names sharing the prefix', () => {
    const code = '<div a><divider></divider></div>';
    const idx = findMatchingCloseTagIndex(code, 'div', '<div a>'.length);
    expect(idx).toBe(code.length - '</div>'.length);
  });

  it('is string-aware inside attribute expressions (`>` in a string)', () => {
    const code = `<div a><div title={'a > b'}></div></div>`;
    const idx = findMatchingCloseTagIndex(code, 'div', '<div a>'.length);
    expect(idx).toBe(code.length - '</div>'.length);
  });

  it('returns -1 for an unbalanced tag', () => {
    expect(findMatchingCloseTagIndex('<div a><div b></div>', 'div', 7)).toBe(-1);
  });
});

describe('findStyleObjectEnd', () => {
  it('returns the index OF the closing brace', () => {
    const code = `style={{ color: 'red' }}`;
    const objStart = 'style={{'.length;
    const end = findStyleObjectEnd(code, objStart);
    expect(code[end]).toBe('}');
    expect(code.slice(objStart, end)).toBe(" color: 'red' ");
  });

  it('skips braces inside quoted values', () => {
    const code = `style={{ content: '}{', width: '10px' }} rest`;
    const end = findStyleObjectEnd(code, 'style={{'.length);
    expect(code.slice(end)).toBe('}} rest');
  });

  it('handles nested object values', () => {
    const code = `viewport={{ once: true, amount: { min: 0.3 } }}>`;
    const end = findStyleObjectEnd(code, 'viewport={{'.length);
    expect(code.slice(end)).toBe('}}>');
  });

  it('returns -1 when unbalanced', () => {
    expect(findStyleObjectEnd('style={{ a: 1 ', 'style={{'.length)).toBe(-1);
  });
});

describe('insertBeforeRenderReturn', () => {
  it('splices text before the component return line', () => {
    const code = `function Page() {\n  return (\n    <div />\n  );\n}`;
    const out = insertBeforeRenderReturn(code, '  const x = 1;')!;
    // Anchor is the START of the `  return (` line, so the text lands on the
    // line above and the return keeps its own indent (plus the helper's `  `).
    expect(out).toContain('{\n  const x = 1;\n');
    expect(out.indexOf('const x = 1;')).toBeLessThan(out.indexOf('return ('));
    expect(out).toContain('return (\n    <div />');
  });

  it('returns null when there is no render return', () => {
    expect(insertBeforeRenderReturn('const a = 1;', 'x')).toBeNull();
  });

  it('does not anchor on a nested callback return', () => {
    const code = `function Page() {\n  const f = () => { return fn(1); };\n  return (\n    <div />\n  );\n}`;
    const out = insertBeforeRenderReturn(code, '  const x = 1;')!;
    expect(out.indexOf('const x = 1;')).toBeGreaterThan(out.indexOf('return fn(1);'));
  });
});

describe('insertAfterLastImportLine', () => {
  it('inserts on its own line after the last import', () => {
    const code = `import a from 'a';\nimport b from 'b';\n\nconst x = 1;\n`;
    const out = insertAfterLastImportLine(code, `import c from 'c';`);
    expect(out).toBe(`import a from 'a';\nimport b from 'b';\nimport c from 'c';\n\nconst x = 1;\n`);
  });

  it('returns null when the file has no imports', () => {
    expect(insertAfterLastImportLine(`const x = 1;\n`, `import c from 'c';`)).toBeNull();
  });
});

describe('ensureNamedImport', () => {
  it('merges missing names into an existing import', () => {
    const code = `import { useState } from 'react';\nconst x = 1;`;
    expect(ensureNamedImport(code, 'react', ['useState', 'useEffect']))
      .toBe(`import { useState, useEffect } from 'react';\nconst x = 1;`);
  });

  it('preserves an existing default specifier', () => {
    const code = `import React from 'react';\nconst x = 1;`;
    expect(ensureNamedImport(code, 'react', ['useEffect']))
      .toBe(`import React, { useEffect } from 'react';\nconst x = 1;`);
  });

  it('adds a required default specifier', () => {
    const code = `import { useState } from 'react';\n`;
    expect(ensureNamedImport(code, 'react', [], { ensureDefault: 'React' }))
      .toBe(`import React, { useState } from 'react';\n`);
  });

  it('is a no-op when everything is present', () => {
    const code = `import React, { useState } from 'react';\n`;
    expect(ensureNamedImport(code, 'react', ['useState'], { ensureDefault: 'React' })).toBe(code);
  });

  it("creates a fresh import after 'use client' when the module is absent", () => {
    const code = `'use client';\nconst x = 1;`;
    expect(ensureNamedImport(code, '@revyme/runtime', ['playSketchDraw']))
      .toBe(`'use client';\nimport { playSketchDraw } from '@revyme/runtime';\nconst x = 1;`);
  });

  it('creates a fresh import at the top without a directive', () => {
    expect(ensureNamedImport(`const x = 1;`, 'react', ['useEffect']))
      .toBe(`import { useEffect } from 'react';\nconst x = 1;`);
  });
});

describe('stripTagAttrBalanced', () => {
  it("strips quoted attrs (attr='…')", () => {
    expect(stripTagAttrBalanced(`<div data-x='{"a":1}' id="k"`, 'data-x')).toBe(`<div id="k"`);
  });

  it('strips brace-balanced expression attrs with NESTED braces', () => {
    const tag = `<div initialVariant={cond ? { a: 1 } : { b: 2 }} id="k"`;
    expect(stripTagAttrBalanced(tag, 'initialVariant')).toBe(`<div id="k"`);
  });

  it('leaves the tag alone when the attr is absent', () => {
    expect(stripTagAttrBalanced('<div id="k"', 'data-x')).toBe('<div id="k"');
  });
});

describe('setTagAttr / getJsonAttr / setJsonAttr / stripJsonAttr', () => {
  const code = `<div data-id="n1" style={{ color: 'red' }}>hi</div>`;

  it('round-trips a JSON spec on the opening tag', () => {
    const withSpec = setJsonAttr(code, 'n1', 'data-fx', { hover: { scale: 1.1 } });
    expect(getJsonAttr(withSpec, 'n1', 'data-fx')).toEqual({ hover: { scale: 1.1 } });
    const stripped = stripJsonAttr(withSpec, 'n1', 'data-fx');
    expect(stripped).toBe(code);
  });

  it('replaces an existing value instead of duplicating', () => {
    const a = setJsonAttr(code, 'n1', 'data-fx', { a: 1 });
    const b = setJsonAttr(a, 'n1', 'data-fx', { b: 2 });
    expect(b.match(/data-fx=/g)!.length).toBe(1);
    expect(getJsonAttr(b, 'n1', 'data-fx')).toEqual({ b: 2 });
  });

  it('setTagAttr accepts raw expression values', () => {
    const out = setTagAttr(code, 'n1', 'ref', '{myRef}');
    expect(out).toContain('<div ref={myRef} data-id="n1"');
  });

  it('returns null / original code for a missing node', () => {
    expect(getJsonAttr(code, 'nope', 'data-fx')).toBeNull();
    expect(setTagAttr(code, 'nope', 'x', "'1'")).toBe(code);
  });

  it('getJsonAttr returns null for malformed JSON', () => {
    const bad = `<div data-id="n1" data-fx='{oops'>x</div>`;
    expect(getJsonAttr(bad, 'n1', 'data-fx')).toBeNull();
  });
});

describe('scanGates', () => {
  it('maps bare and BANDED max-width gates', () => {
    const code = [
      `const __mq1 = useMediaQuery('(max-width: 375px)');`,
      `const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');`,
    ].join('\n');
    const gates = scanGates(code);
    expect(gates.get('__mq1')).toBe(375);
    expect(gates.get('__mq2')).toBe(768);
  });

  it('ignores non-max-width queries', () => {
    expect(scanGates(`const __mq1 = useMediaQuery('(orientation: portrait)');`).size).toBe(0);
  });
});

// ─── extractObjectEntryBalanced ───────────────────────────────────────────────
// Read-side twin of removeObjectEntryBalanced (the Wisp Top Nav clone,
// 2026-08-12): a `\{[^}]*\}` capture stops at the FIRST `}`, so a nested
// value truncated the copied entry one brace short.

describe('extractObjectEntryBalanced', () => {
  const obj = `
  default: {
    backgroundColor: '#fff',
    boxShadow: 'none'
  },
  'variant-1': {
    paddingTop: '14px',
    transition: {
      ease: 'easeIn'
    }
  },`;

  it('captures a NESTED value whole — braces balanced', () => {
    const out = extractObjectEntryBalanced(obj, 'variant-1');
    expect(out).toContain("transition: {");
    expect(out).toContain("ease: 'easeIn'");
    // balanced: as many closes as opens
    expect((out!.match(/\{/g) ?? []).length).toBe((out!.match(/\}/g) ?? []).length);
  });

  it('bare keys match without chewing into longer names', () => {
    const tricky = `mydefault: { a: 1 }, default: { b: 2 }`;
    expect(extractObjectEntryBalanced(tricky, 'default')).toBe('{ b: 2 }');
  });

  it('a key that OPENS the source matches too', () => {
    expect(extractObjectEntryBalanced(`default: { a: 1 }`, 'default')).toBe('{ a: 1 }');
  });

  it('null when the key is absent or the braces never balance', () => {
    expect(extractObjectEntryBalanced(obj, 'variant-9')).toBeNull();
    expect(extractObjectEntryBalanced(`'variant-1': { a: 1`, 'variant-1')).toBeNull();
  });

  it('a brace inside a STRING value does not skew the walk', () => {
    expect(extractObjectEntryBalanced(`'variant-1': { content: 'a}b' }`, 'variant-1'))
      .toBe("{ content: 'a}b' }");
  });
});
