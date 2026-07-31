import { describe, test, expect } from 'vitest';
import {
  parsePageInteractionsForNode,
  parseAllPageInteractions,
  setterName,
  varNameFromSetter,
  attrForTrigger,
  triggerForAttr,
} from './page-interactions';
import {
  addPageInteractionInCode,
  removePageInteractionInCode,
} from '../generation/page-interactions-gen';
import { addPageVariableInCode } from './page-variables';

// ─── Setter naming helpers ─────────────────────────────────────────────────

describe('setter name conversion', () => {
  test('setterName camelizes', () => {
    expect(setterName('fade')).toBe('setFade');
    expect(setterName('isOpen')).toBe('setIsOpen');
    expect(setterName('a')).toBe('setA');
  });

  test('varNameFromSetter undoes the conversion', () => {
    expect(varNameFromSetter('setFade')).toBe('fade');
    expect(varNameFromSetter('setIsOpen')).toBe('isOpen');
    expect(varNameFromSetter('setA')).toBe('a');
  });

  test('varNameFromSetter rejects malformed inputs', () => {
    expect(varNameFromSetter('handleClick')).toBeNull();
    expect(varNameFromSetter('set')).toBeNull();
    expect(varNameFromSetter('SetFade')).toBeNull(); // lowercase `set` required
  });
});

describe('trigger ↔ attr mapping', () => {
  test('attrForTrigger', () => {
    expect(attrForTrigger('click')).toBe('onClick');
    expect(attrForTrigger('mouseEnter')).toBe('onMouseEnter');
    expect(attrForTrigger('mouseLeave')).toBe('onMouseLeave');
  });

  test('triggerForAttr round-trip', () => {
    expect(triggerForAttr('onClick')).toBe('click');
    expect(triggerForAttr('onMouseEnter')).toBe('mouseEnter');
    expect(triggerForAttr('onMouseLeave')).toBe('mouseLeave');
    expect(triggerForAttr('onSubmit')).toBeNull();
  });
});

// ─── Parser ────────────────────────────────────────────────────────────────

describe('parsePageInteractionsForNode', () => {
  test('extracts a single setter call from onClick', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={() => setFade(0.5)} />;
}`;
    const result = parsePageInteractionsForNode(code, 'btn');
    expect(result).toEqual([
      { nodeId: 'btn', trigger: 'click', varName: 'fade', value: '0.5' },
    ]);
  });

  test('extracts setters from a block-body handler', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={() => { setFade(0); setBrand('#ff0000'); }} />;
}`;
    const result = parsePageInteractionsForNode(code, 'btn');
    expect(result).toHaveLength(2);
    // Order is alphabetical by varName when the same trigger has multiple setters.
    expect(result.map(r => r.varName).sort()).toEqual(['brand', 'fade']);
  });

  test('extracts string, number, boolean, and negative numeric args', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={() => { setText('hello'); setN(42); setB(true); setNeg(-3.14); }} />;
}`;
    const result = parsePageInteractionsForNode(code, 'btn');
    const byVar = Object.fromEntries(result.map(r => [r.varName, r.value]));
    expect(byVar).toEqual({ text: 'hello', n: '42', b: 'true', neg: '-3.14' });
  });

  test('extracts from multiple triggers on same node', () => {
    const code = `
function Page() {
  return <div data-id="btn"
    onMouseEnter={() => setFade(0)}
    onMouseLeave={() => setFade(1)}
  />;
}`;
    const result = parsePageInteractionsForNode(code, 'btn');
    expect(result).toEqual([
      { nodeId: 'btn', trigger: 'mouseEnter', varName: 'fade', value: '0' },
      { nodeId: 'btn', trigger: 'mouseLeave', varName: 'fade', value: '1' },
    ]);
  });

  test('ignores non-setter calls', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={() => { console.log('ok'); doSomething(); setFade(0.5); }} />;
}`;
    const result = parsePageInteractionsForNode(code, 'btn');
    expect(result).toHaveLength(1);
    expect(result[0].varName).toBe('fade');
  });

  test('ignores non-literal arguments (expressions, refs)', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={() => setFade(getValue())} />;
}`;
    expect(parsePageInteractionsForNode(code, 'btn')).toEqual([]);
  });

  test('ignores named-handler refs (preserves user code)', () => {
    const code = `
function Page() {
  return <div data-id="btn" onClick={handleClick} />;
}`;
    expect(parsePageInteractionsForNode(code, 'btn')).toEqual([]);
  });

  test('returns [] when nodeId not found', () => {
    const code = `function Page() { return <div data-id="other" />; }`;
    expect(parsePageInteractionsForNode(code, 'btn')).toEqual([]);
  });
});

describe('parseAllPageInteractions', () => {
  test('finds interactions across multiple nodes', () => {
    const code = `
function Page() {
  return (<>
    <button data-id="a" onClick={() => setFade(0)}>A</button>
    <button data-id="b" onClick={() => setFade(1)}>B</button>
  </>);
}`;
    const result = parseAllPageInteractions(code);
    expect(result.map(r => r.nodeId).sort()).toEqual(['a', 'b']);
  });
});

// ─── Generator: add ────────────────────────────────────────────────────────

describe('addPageInteractionInCode', () => {
  const baseCode = (extra = '') => `'use client';

/** @pageVariables {
  "variables": [
    { "name": "fade", "type": "number", "default": "1" },
    { "name": "brand", "type": "color", "default": "#ff0000" },
    { "name": "open", "type": "boolean", "default": "false" }
  ]
} */
function Page() {
  return <div data-id="btn"${extra ? ' ' + extra : ''}>x</div>;
}`;

  test('attaches a fresh handler to a node with none', () => {
    const out = addPageInteractionInCode(baseCode(), 'btn', 'click', 'fade', '0.5');
    expect(out).toMatch(/onClick=\{\(\) => setFade\(0\.5\)\}/);
  });

  test('uses correct literal type — color → string, number → numeric, boolean → bool', () => {
    const out1 = addPageInteractionInCode(baseCode(), 'btn', 'click', 'brand', '#0099ff');
    expect(out1).toMatch(/setBrand\(['"]#0099ff['"]\)/);
    const out2 = addPageInteractionInCode(baseCode(), 'btn', 'click', 'open', 'true');
    expect(out2).toMatch(/setOpen\(true\)/);
    const out3 = addPageInteractionInCode(baseCode(), 'btn', 'click', 'fade', '0.7');
    expect(out3).toMatch(/setFade\(0\.7\)/);
  });

  test('promotes single-call handler to block when adding a different setter', () => {
    let code = addPageInteractionInCode(baseCode(), 'btn', 'click', 'fade', '0');
    code = addPageInteractionInCode(code, 'btn', 'click', 'brand', '#ff0000');
    // Both calls present in same handler
    expect(code).toMatch(/setFade\(0\)/);
    expect(code).toMatch(/setBrand\(['"]#ff0000['"]\)/);
    // Block body shape
    expect(code).toMatch(/onClick=\{\(\) => \{[\s\S]*setFade\(0\)[\s\S]*setBrand[\s\S]*\}/);
  });

  test('updates existing setter for same varName (no duplicate)', () => {
    let code = addPageInteractionInCode(baseCode(), 'btn', 'click', 'fade', '0');
    code = addPageInteractionInCode(code, 'btn', 'click', 'fade', '0.7');
    expect(code).toMatch(/setFade\(0\.7\)/);
    expect(code).not.toMatch(/setFade\(0\)/);
    // Single call (no block since only one setter).
    expect(code).toMatch(/onClick=\{\(\) => setFade\(0\.7\)\}/);
  });

  test('does not touch a named-handler attribute', () => {
    const code = baseCode('onClick={handleClick}');
    const out = addPageInteractionInCode(code, 'btn', 'click', 'fade', '0.5');
    // The named handler stays; no setter appended in front of it.
    expect(out).toMatch(/onClick=\{handleClick\}/);
  });
});

// ─── Generator: remove ─────────────────────────────────────────────────────

describe('removePageInteractionInCode', () => {
  const codeWithBoth = `'use client';
/** @pageVariables { "variables": [{"name":"fade","type":"number","default":"1"},{"name":"brand","type":"color","default":"#fff"}] } */
function Page() {
  return <div data-id="btn" onClick={() => { setFade(0); setBrand('#ff0000'); }}>x</div>;
}`;

  test('removes one setter from a multi-setter handler', () => {
    const out = removePageInteractionInCode(codeWithBoth, 'btn', 'click', 'fade');
    expect(out).not.toMatch(/setFade/);
    expect(out).toMatch(/setBrand/);
  });

  test('collapses block back to expression when one statement remains', () => {
    const out = removePageInteractionInCode(codeWithBoth, 'btn', 'click', 'fade');
    // Single-statement → collapsed (no block braces around the body).
    expect(out).toMatch(/onClick=\{\(\) => setBrand/);
  });

  test('removes the attribute entirely when last setter goes', () => {
    const single = `function Page() { return <div data-id="btn" onClick={() => setFade(0)} />; }`;
    const out = removePageInteractionInCode(single, 'btn', 'click', 'fade');
    expect(out).not.toMatch(/onClick=/);
  });

  test('no-op when interaction not found', () => {
    const code = `function Page() { return <div data-id="btn" />; }`;
    expect(removePageInteractionInCode(code, 'btn', 'click', 'fade')).toBe(code);
  });
});

// ─── End-to-end round-trip via parser ──────────────────────────────────────

describe('round-trip', () => {
  test('add → parse → remove → parse', () => {
    let code = `'use client';
function Page() { return <div data-id="btn">x</div>; }`;
    code = addPageVariableInCode(code, { name: 'fade', type: 'number', default: '1' });

    code = addPageInteractionInCode(code, 'btn', 'click', 'fade', '0.5');
    expect(parsePageInteractionsForNode(code, 'btn')).toEqual([
      { nodeId: 'btn', trigger: 'click', varName: 'fade', value: '0.5' },
    ]);

    code = removePageInteractionInCode(code, 'btn', 'click', 'fade');
    expect(parsePageInteractionsForNode(code, 'btn')).toEqual([]);
  });
});
