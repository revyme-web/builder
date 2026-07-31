import { describe, test, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  bindStyleToPageVariableInCode,
  unbindStyleFromPageVariableInCode,
  syncPageVariableHooks,
  dormantizePageVarBindingsInCanvas,
  neutralizeMissingSearchFieldsInCode,
  renamePageVariableHookInCode,
} from './page-variables-gen';
import { addPageVariableInCode } from '../features/page-variables';

// ─── dormantizePageVarBindingsInCanvas ────────────────────────────────────

describe('dormantizePageVarBindingsInCanvas', () => {
  // A search field + dynamic CMS filter pasted onto the canvas → references the
  // page useState var `searchTitle3` at module scope (would crash).
  const CODE = `'use client';
/** @pageVariables {"variables":[{"name":"searchTitle3","type":"text","default":""}]} */
import React, { useState } from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  const [searchTitle3, setSearchTitle3] = useState("");
  return <div data-id="root" />;
}
const canvasNodes = (<>
  <input data-id="i" data-search-field="searchTitle3" value={searchTitle3} style={{ width: '100%' }} />
  <div data-id="l">{blog.filter(item => (searchTitle3 === '' || String(item.title).toLowerCase().includes(searchTitle3.toLowerCase()))).map((item, idx) => <div data-id="r" key={idx}>{item.title}</div>)}</div>
</>);`;

  const out = dormantizePageVarBindingsInCanvas(CODE);

  test('neutralizes the value={var} binding', () => {
    expect(out).not.toContain('value={searchTitle3}');
    expect(out).toContain('value={""}');
  });

  test('neutralizes the dynamic filter predicate', () => {
    expect(out).not.toMatch(/\(\s*searchTitle3 ===/);
    expect(out).toContain('"" === \'\'');
  });

  test('leaves the data-search-field STRING attribute untouched', () => {
    expect(out).toContain('data-search-field="searchTitle3"');
  });

  test('no live (module-scope) searchTitle3 reference remains in the fragment', () => {
    const frag = out.slice(out.indexOf('const canvasNodes'));
    // the only allowed occurrence is inside the data-search-field string
    expect(frag.replace(/data-search-field="searchTitle3"/g, '')).not.toContain('searchTitle3');
  });

  test('the page function body is untouched (its useState still references the var)', () => {
    expect(out).toContain('const [searchTitle3, setSearchTitle3] = useState("")');
  });

  test('result is valid, parseable code', () => {
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  test('idempotent', () => {
    expect(dormantizePageVarBindingsInCanvas(out)).toBe(out);
  });

  // Cross-page paste: the search field references `searchTitle3`, but the TARGET
  // page only declares `opacity`. The undeclared var must be neutralized (missing,
  // not a crash) via its data-search-field marker.
  const CROSS = `'use client';
/** @pageVariables {"variables":[{"name":"opacity","type":"number","default":"1"}]} */
import React, { useState } from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  const [opacity, setOpacity] = useState(1);
  return <div data-id="root" />;
}
const canvasNodes = <>
  <input data-id="i" data-search-field="searchTitle3" value={searchTitle3} style={{ width: '100%' }} />
  <div data-id="l">{blog.filter(item => (searchTitle3 === '' || String(item.title).toLowerCase().includes(searchTitle3.toLowerCase()))).map((item, idx) => <div data-id="r" key={idx}>{item.title}</div>)}</div>
</>;`;

  test('neutralizes a search var the target page does NOT declare (missing, not crash)', () => {
    const o = dormantizePageVarBindingsInCanvas(CROSS);
    expect(o).not.toContain('value={searchTitle3}');
    expect(o).toContain('value={""}');
    expect(o).toContain('data-search-field="searchTitle3"'); // marker kept for re-attach
    const frag = o.slice(o.indexOf('const canvasNodes'));
    expect(frag.replace(/data-search-field="searchTitle3"/g, '')).not.toContain('searchTitle3');
    expect(() => transform(o, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });
});

describe('neutralizeMissingSearchFieldsInCode (viewport paste, undeclared var)', () => {
  // A Search Field pasted into a VIEWPORT (page tree) of a page that doesn't declare
  // the var → undeclared `searchReadTime` ref → crash. Must neutralize (Missing).
  const PAGE = `'use client';
/** @pageVariables {"variables":[{"name":"opacity","type":"number","default":"1"}]} */
import React, { useState } from 'react';
import blog from '@/cms/blog.json';
export default function Page() {
  const [opacity, setOpacity] = useState(1);
  return <div data-id="root" style={{ opacity: opacity }}>
    <input data-id="sf" data-search-field="searchReadTime" value={searchReadTime} style={{ width: '100%' }} />
    <div data-id="list">{blog.filter(item => (searchReadTime === '' || String(item.readTime).toLowerCase().includes(searchReadTime.toLowerCase()))).map((item, idx) => <div data-id="r" key={idx}>{item.readTime}</div>)}</div>
  </div>;
}`;
  const out = neutralizeMissingSearchFieldsInCode(PAGE);

  test('neutralizes the undeclared search var in the page tree', () => {
    expect(out).not.toContain('value={searchReadTime}');
    expect(out).toContain('value={""}');
    expect(out).not.toMatch(/\(\s*searchReadTime ===/);
  });

  test('keeps the marker (→ Missing chip) and leaves a declared var (opacity) alone', () => {
    expect(out).toContain('data-search-field="searchReadTime"');
    expect(out).toContain('opacity: opacity'); // declared → untouched
  });

  test('produces valid code', () => {
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
  });

  test('no-op when the search var IS declared', () => {
    const declaredPage = PAGE
      .replace('"name":"opacity","type":"number","default":"1"', '"name":"opacity","type":"number","default":"1"},{"name":"searchReadTime","type":"text","default":""')
      .replace('const [opacity, setOpacity] = useState(1);', 'const [opacity, setOpacity] = useState(1);\n  const [searchReadTime, setSearchReadTime] = useState("");');
    expect(neutralizeMissingSearchFieldsInCode(declaredPage)).toBe(declaredPage);
  });

  test('idempotent', () => {
    expect(neutralizeMissingSearchFieldsInCode(out)).toBe(out);
  });
});

// ─── bindStyleToPageVariableInCode ────────────────────────────────────────

describe('bindStyleToPageVariableInCode', () => {
  test('replaces inline literal with identifier', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: 0.5 }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'fade');
    expect(out).toContain('opacity: fade');
    expect(out).not.toContain('opacity: 0.5');
  });

  test('replaces string literal with identifier', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ backgroundColor: '#ff0000' }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'backgroundColor', 'brand');
    expect(out).toContain('backgroundColor: brand');
    expect(out).not.toContain("'#ff0000'");
  });

  test('adds property as identifier when missing', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ width: '100px' }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'fade');
    expect(out).toContain('opacity: fade');
    expect(out).toContain("width: '100px'");
  });

  test('adds style attribute when missing entirely', () => {
    const code = `
function Page() {
  return <div data-id="box" />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'fade');
    expect(out).toContain('style={{');
    expect(out).toContain('opacity: fade');
  });

  test('idempotent — re-binding same name is a no-op', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: fade }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'fade');
    expect(out.replace(/\s+/g, ' ')).toBe(code.replace(/\s+/g, ' '));
  });

  test('does not touch a different node id', () => {
    const code = `
function Page() {
  return (<>
    <div data-id="a" style={{ opacity: 0.5 }} />
    <div data-id="b" style={{ opacity: 0.5 }} />
  </>);
}`;
    const out = bindStyleToPageVariableInCode(code, 'a', 'opacity', 'fade');
    expect(out).toContain('data-id="a" style={{ opacity: fade }}'.replace(/\s+/g, ' '));
    // 'b' still has the literal
    expect(out.match(/opacity: 0.5/g)?.length).toBe(1);
  });

  test('refuses to overwrite an unrelated identifier expression', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: someOther }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'fade');
    expect(out).toContain('someOther');
  });

  // Boolean → display/visibility uses a ternary, not a bare identifier — a
  // bare `display: hideVar` would render as `display: true` (broken CSS).
  // Instead the generator emits `display: hideVar ? 'none' : ''` so the
  // boolean's truth maps to the right CSS keyword at runtime.
  test('boolean → display emits ternary `display: hideVar ? \'none\' : \'\'`', () => {
    const code = `
/** @pageVariables { "variables": [{"name":"hideVar","type":"boolean","default":"false"}] } */
function Page() {
  return <div data-id="box" style={{ display: 'flex' }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'display', 'hideVar');
    // Ternary present
    expect(out).toMatch(/display:\s*hideVar\s*\?\s*['"]none['"]\s*:\s*['"]['"]/);
    // No bare identifier
    expect(out).not.toMatch(/display:\s*hideVar(?!\s*\?)/);
  });

  test('boolean → visibility emits ternary `visibility: hideVar ? \'hidden\' : \'\'`', () => {
    const code = `
/** @pageVariables { "variables": [{"name":"hideVar","type":"boolean","default":"false"}] } */
function Page() {
  return <div data-id="box" />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'visibility', 'hideVar');
    expect(out).toMatch(/visibility:\s*hideVar\s*\?\s*['"]hidden['"]\s*:\s*['"]['"]/);
  });

  test('non-display boolean variable still emits a bare identifier', () => {
    // Boolean variables only get the ternary on visibility-style props.
    // Other properties (e.g. a hypothetical bound to opacity) keep the
    // plain identifier shape — even though the runtime rendering wouldn't
    // make sense, the generator stays out of the way.
    const code = `
/** @pageVariables { "variables": [{"name":"flagVar","type":"boolean","default":"false"}] } */
function Page() {
  return <div data-id="box" style={{ opacity: 1 }} />;
}`;
    const out = bindStyleToPageVariableInCode(code, 'box', 'opacity', 'flagVar');
    expect(out).toMatch(/opacity:\s*flagVar(?!\s*\?)/);
  });
});

describe('unbindStyleFromPageVariableInCode — ternary shape', () => {
  test('replaces ternary with literal CSS value', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ display: hideVar ? 'none' : '' }} />;
}`;
    const out = unbindStyleFromPageVariableInCode(code, 'box', 'display', 'none');
    expect(out).toMatch(/display:\s*['"]none['"]/);
    expect(out).not.toMatch(/hideVar\s*\?/);
  });

  test('removes the property entirely when literal is empty', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ display: hideVar ? 'none' : '' }} />;
}`;
    const out = unbindStyleFromPageVariableInCode(code, 'box', 'display', '');
    expect(out).not.toMatch(/display/);
    expect(out).not.toMatch(/hideVar/);
  });
});

// ─── unbindStyleFromPageVariableInCode ────────────────────────────────────

describe('unbindStyleFromPageVariableInCode', () => {
  test('replaces identifier with literal value', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: fade }} />;
}`;
    const out = unbindStyleFromPageVariableInCode(code, 'box', 'opacity', '0.5');
    expect(out).toMatch(/opacity: ['"]0\.5['"]/);
    expect(out).not.toContain('opacity: fade');
  });

  test('removes the style property entirely when literal is empty', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: fade, width: '100px' }} />;
}`;
    const out = unbindStyleFromPageVariableInCode(code, 'box', 'opacity', '');
    expect(out).not.toContain('opacity');
    expect(out).toContain("width: '100px'");
  });

  test('no-op when property is already a literal', () => {
    const code = `
function Page() {
  return <div data-id="box" style={{ opacity: 0.5 }} />;
}`;
    const out = unbindStyleFromPageVariableInCode(code, 'box', 'opacity', '0.7');
    expect(out).toContain('opacity: 0.5');
  });
});

// ─── syncPageVariableHooks ────────────────────────────────────────────────

describe('syncPageVariableHooks', () => {
  test('emits useState for a referenced declared variable', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div style={{ opacity: fade }} />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    const out = syncPageVariableHooks(code);
    expect(out).toMatch(/const \[fade, setFade\] = useState\(0\.5\)/);
  });

  test('does NOT emit useState for an unreferenced declared variable', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    const out = syncPageVariableHooks(code);
    expect(out).not.toMatch(/useState/);
  });

  test('removes useState declaration when variable becomes unreferenced', () => {
    let code = `'use client';\n\nfunction Page() {\n  const [fade, setFade] = useState(0.5);\n  return <div />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    const out = syncPageVariableHooks(code);
    expect(out).not.toMatch(/useState/);
  });

  test('idempotent — second pass does nothing', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div style={{ opacity: fade }} />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    const first = syncPageVariableHooks(code);
    const second = syncPageVariableHooks(first);
    expect(second.trim()).toBe(first.trim());
  });

  test('boolean default emits boolean literal', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div data-show={isOpen} />;\n}`;
    code = addPageVariableInCode(code, { name: 'isOpen', type: 'boolean', default: 'true' });
    const out = syncPageVariableHooks(code);
    expect(out).toMatch(/useState\(true\)/);
  });

  test('color default emits string literal', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div style={{ backgroundColor: brand }} />;\n}`;
    code = addPageVariableInCode(code, { name: 'brand', type: 'color', default: '#ff00ff' });
    const out = syncPageVariableHooks(code);
    expect(out).toMatch(/useState\(['"]#ff00ff['"]\)/);
  });

  test('multiple variables — useState for each referenced one only', () => {
    let code = `'use client';\n\nfunction Page() {\n  return <div style={{ opacity: fade, color: brand }} />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    code = addPageVariableInCode(code, { name: 'brand', type: 'color', default: '#ff0000' });
    code = addPageVariableInCode(code, { name: 'unused', type: 'text', default: 'hi' });
    const out = syncPageVariableHooks(code);
    expect(out).toMatch(/const \[fade,/);
    expect(out).toMatch(/const \[brand,/);
    expect(out).not.toMatch(/const \[unused,/);
  });

  test('leaves unrelated useState declarations alone', () => {
    let code = `'use client';\n\nfunction Page() {\n  const [count, setCount] = useState(0);\n  return <div style={{ opacity: fade }} />;\n}`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '0.5' });
    const out = syncPageVariableHooks(code);
    expect(out).toMatch(/useState\(0\)/); // user's own count untouched
    expect(out).toMatch(/const \[fade,/);
  });
});

describe('renamePageVariableHookInCode — keeps annotation/hook/setter in sync on rename', () => {
  test('renames the useState value, setter, and every reference', () => {
    const code = `'use client';
/** @pageVariables { "variables": [{ "name": "color", "type": "color", "default": "#fff" }] } */
import { useState } from 'react';
export default function Page() {
  const [color, setColor] = useState("#fff");
  return <div data-id="root" style={{ backgroundColor: color }} onClick={() => setColor("#000")} />;
}`;
    const out = renamePageVariableHookInCode(code, 'color', 'test');
    expect(out).toMatch(/const \[test, setTest\] = useState/);
    expect(out).not.toMatch(/\bsetColor\b/);
    expect(out).not.toMatch(/backgroundColor: color\b/);
    expect(out).toMatch(/backgroundColor: test/);
    expect(out).toMatch(/setTest\(/);
  });

  test('no-op when the hook pair is absent (already-mismatched / unrelated)', () => {
    const code = `export default function Page() { return <div data-id="root" />; }`;
    expect(renamePageVariableHookInCode(code, 'color', 'test')).toBe(code);
  });

  test('no-op when old === new', () => {
    const code = `export default function Page() { const [x, setX] = (0); return null; }`;
    expect(renamePageVariableHookInCode(code, 'x', 'x')).toBe(code);
  });
});
