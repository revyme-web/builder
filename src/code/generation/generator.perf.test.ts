import { describe, test, expect } from 'vitest';
import { updateNodeInCode, addNodeInCode, addCanvasNodeInCode } from './generator-crud';
import { parseJSXToNodes } from '../parsing/parser';

// Performance + non-regression tests for the generator

function generateLargeCode(count: number): string {
  let code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>\n`;
  for (let i = 0; i < count; i++) {
    code += `  <div data-id="node-${i}" style={{position: 'absolute', left: '${i * 10}px', top: '${i * 10}px', width: '100px', height: '100px'}}></div>\n`;
  }
  code += `</div>`;
  return code;
}

describe('generator performance', () => {
  test('updateNodeInCode fast path on 500 nodes under 5ms', () => {
    const code = generateLargeCode(500);
    const t0 = performance.now();
    const result = updateNodeInCode(code, 'node-250', { left: '999px' });
    const elapsed = performance.now() - t0;
    expect(result).toContain("left: '999px'");
    expect(elapsed).toBeLessThan(5); // fast path = regex, should be ~0.1ms
  });

  test('addCanvasNodeInCode is O(1) string concat', () => {
    const code = generateLargeCode(500);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      addCanvasNodeInCode(code, { id: `c${i}`, type: 'div', styles: { left: '0px' } });
    }
    const elapsed = performance.now() - t0;
    // 50 iterations of string concat should be under 10ms (no Babel)
    expect(elapsed).toBeLessThan(50);
  });

  test('addNodeInCode with AST on 100 nodes under 50ms', () => {
    const code = generateLargeCode(100);
    const t0 = performance.now();
    addNodeInCode(code, 'root', {
      id: 'new-node', type: 'div', styles: { width: '100px' },
    });
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('generator non-regression', () => {
  test('updateNodeInCode preserves other nodes', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="a" style={{left: '10px', top: '20px'}}></div>
  <div data-id="b" style={{left: '30px', top: '40px'}}></div>
</div>`;
    const result = updateNodeInCode(code, 'a', { left: '999px' });
    // a should be updated
    expect(result).toContain("left: '999px'");
    // b should be unchanged
    expect(result).toContain("left: '30px'");
  });

  test('addNodeInCode produces parseable JSX', () => {
    const code = `<div data-id="root" style={{}}></div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'child', type: 'div', styles: { width: '100px', height: '50px' },
    });
    // Should parse without error
    // parseJSXToNodes imported at top
    const nodes = parseJSXToNodes(result);
    expect(nodes.has('child')).toBe(true);
    expect(nodes.get('child')!.parentId).toBe('root');
  });

  test('addCanvasNodeInCode produces parseable JSX with canvas flag', () => {
    const code = `<div data-id="root" style={{}}></div>`;
    const result = addCanvasNodeInCode(code, {
      id: 'canvas-1', type: 'div', styles: { position: 'absolute' },
    });
    // parseJSXToNodes imported at top
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('canvas-1')?.isCanvasNode).toBe(true);
  });
});
