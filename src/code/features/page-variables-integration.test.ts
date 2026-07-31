// Integration smoke: simulate the create-variable-from-property click flow
// end-to-end, the same way ControlProvider/queueMutation would dispatch it.

import { describe, test, expect } from 'vitest';
import { addPageVariableInCode, parsePageVariables } from './page-variables';
import {
  bindStyleToPageVariableInCode,
  syncPageVariableHooks,
} from '../generation/page-variables-gen';

// Simulates: user opens VariableModal on Opacity, types "zefezefzezef", clicks
// Create. ControlProvider dispatches addPageVariable + bindStylePageVariable.
// Queue applies them in order; bind also runs syncPageVariableHooks.

describe('page-variables integration: create-from-property', () => {
  const startingCode = `'use client';

function Page() {
  return <div data-id="box" style={{ opacity: 1 }} />;
}

export default Page;
`;

  test('addPageVariable + bindStylePageVariable produces a parseable annotation', () => {
    let code = startingCode;
    // 1. addPageVariable
    code = addPageVariableInCode(code, { name: 'zefezefzezef', type: 'number', default: '1' });
    // 2. bindStylePageVariable + syncPageVariableHooks (mirrors mutation-queue dispatch)
    code = syncPageVariableHooks(
      bindStyleToPageVariableInCode(code, 'box', 'opacity', 'zefezefzezef'),
    );

    // Annotation block must be present and parseable
    expect(code).toContain('@pageVariables');
    const parsed = parsePageVariables(code);
    expect(parsed).not.toBeNull();
    expect(parsed?.variables).toEqual([
      { name: 'zefezefzezef', type: 'number', default: '1' },
    ]);
  });

  test('JSX identifier replaced literal', () => {
    let code = startingCode;
    code = addPageVariableInCode(code, { name: 'zefezefzezef', type: 'number', default: '1' });
    code = syncPageVariableHooks(
      bindStyleToPageVariableInCode(code, 'box', 'opacity', 'zefezefzezef'),
    );

    expect(code).toContain('opacity: zefezefzezef');
    expect(code).not.toContain('opacity: 1 ');
  });

  test('useState declaration emitted at function top', () => {
    let code = startingCode;
    code = addPageVariableInCode(code, { name: 'zefezefzezef', type: 'number', default: '1' });
    code = syncPageVariableHooks(
      bindStyleToPageVariableInCode(code, 'box', 'opacity', 'zefezefzezef'),
    );
    expect(code).toMatch(/const \[zefezefzezef, setZefezefzezef\] = useState\(1\)/);
  });

  test('round-trip: write then re-read returns the same variable', () => {
    let code = startingCode;
    code = addPageVariableInCode(code, { name: 'zefezefzezef', type: 'number', default: '1' });
    code = syncPageVariableHooks(
      bindStyleToPageVariableInCode(code, 'box', 'opacity', 'zefezefzezef'),
    );
    // Now simulate "modal reopens" — read the variables list from this code
    const list = parsePageVariables(code)?.variables ?? [];
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('zefezefzezef');
  });

  // Boolean → display/visibility round-trip. The generator emits a ternary
  // (`display: hideVar ? 'none' : ''`); the parser must detect that shape
  // and resolve to the right branch based on the boolean variable's default.
  // Without this round-trip the bound pill wouldn't appear back on the
  // canvas after a refresh.
  describe('boolean → display ternary round-trip', () => {
    test('default=false resolves display to empty (visible state)', async () => {
      const { parseJSXToNodes } = await import('../parsing/parser');
      let code = `'use client';
function Page() { return <div data-id="box" style={{ display: 'flex' }} />; }`;
      code = addPageVariableInCode(code, { name: 'hideVar', type: 'boolean', default: 'false' });
      code = syncPageVariableHooks(
        bindStyleToPageVariableInCode(code, 'box', 'display', 'hideVar'),
      );
      const nodes = parseJSXToNodes(code);
      const node = nodes.get('box');
      // Empty alternate → display style absent (or empty)
      expect(node?.styles.display ?? '').toBe('');
      // Marker is set so the bound pill renders
      expect(node?.styleVariables?.display).toBe('hideVar');
    });

    test('default=true resolves display to "none" (hidden state)', async () => {
      const { parseJSXToNodes } = await import('../parsing/parser');
      let code = `'use client';
function Page() { return <div data-id="box" style={{ display: 'flex' }} />; }`;
      code = addPageVariableInCode(code, { name: 'hideVar', type: 'boolean', default: 'true' });
      code = syncPageVariableHooks(
        bindStyleToPageVariableInCode(code, 'box', 'display', 'hideVar'),
      );
      const nodes = parseJSXToNodes(code);
      const node = nodes.get('box');
      expect(node?.styles.display).toBe('none');
      expect(node?.styleVariables?.display).toBe('hideVar');
    });

    test('useState emits the right boolean default', async () => {
      let code = `'use client';
function Page() { return <div data-id="box" style={{ display: 'flex' }} />; }`;
      code = addPageVariableInCode(code, { name: 'hideVar', type: 'boolean', default: 'true' });
      code = syncPageVariableHooks(
        bindStyleToPageVariableInCode(code, 'box', 'display', 'hideVar'),
      );
      expect(code).toMatch(/useState\(true\)/);
    });
  });

  test('starting code with @canvas + use client + an existing setup', () => {
    const canvasCode = `'use client';
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440 }
  ],
  "positions": {}
} */

function Page() {
  return <div data-id="box" style={{ opacity: 1 }} />;
}

export default Page;
`;
    let code = canvasCode;
    code = addPageVariableInCode(code, { name: 'zefezefzezef', type: 'number', default: '1' });
    code = syncPageVariableHooks(
      bindStyleToPageVariableInCode(code, 'box', 'opacity', 'zefezefzezef'),
    );
    // @canvas block intact
    expect(code).toContain('@canvas');
    // @pageVariables present and parseable
    const parsed = parsePageVariables(code);
    expect(parsed?.variables[0]?.name).toBe('zefezefzezef');
  });
});
