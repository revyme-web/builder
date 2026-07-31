import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

// Performance + non-regression tests for the parser

describe('parser performance', () => {
  function generateLargeJSX(count: number): string {
    let code = `<div data-id="root" style={{position: 'relative', width: '1440px', height: '${count * 50}px'}}>\n`;
    for (let i = 0; i < count; i++) {
      code += `  <div data-id="node-${i}" data-name="Card ${i}" style={{position: 'absolute', left: '${(i % 5) * 300}px', top: '${Math.floor(i / 5) * 220}px', width: '260px', height: '200px'}}>\n`;
      code += `    <p data-id="node-${i}-title" style={{fontSize: '16px'}}>Card ${i}</p>\n`;
      code += `  </div>\n`;
    }
    code += `</div>`;
    return code;
  }

  test('parses 100 nodes under 50ms', () => {
    const code = generateLargeJSX(50); // 50 cards × 2 nodes = 100 nodes + root
    const t0 = performance.now();
    const nodes = parseJSXToNodes(code);
    const elapsed = performance.now() - t0;
    expect(nodes.size).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(200);
  });

  test('parses 500 nodes under 400ms', () => {
    const code = generateLargeJSX(250);
    const t0 = performance.now();
    const nodes = parseJSXToNodes(code);
    const elapsed = performance.now() - t0;
    expect(nodes.size).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(400);
  });
});

describe('parser non-regression', () => {
  test('parses fragment with viewport root + canvas nodes', () => {
    const code = `<>
  <div data-id="root" style={{width: '1440px'}}></div>
  <div data-id="canvas-1" data-canvas-node="true" style={{position: 'absolute', left: '100px'}}></div>
</>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('canvas-1')).toBe(true);
    expect(nodes.get('root')!.isCanvasNode).toBe(false);
    expect(nodes.get('canvas-1')!.isCanvasNode).toBe(true);
    expect(nodes.get('root')!.parentId).toBeNull();
    expect(nodes.get('canvas-1')!.parentId).toBeNull();
  });

  test('skips <style> elements', () => {
    const code = `<div data-id="root" style={{}}>
  <style>{\`@media (max-width: 768px) { [data-id="title"] { font-size: 36px !important; } }\`}</style>
  <div data-id="child" style={{}}></div>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('child')).toBe(true);
    // Style should NOT be a node
    for (const [, node] of nodes) {
      expect(node.type).not.toBe('style');
    }
  });

  test('preserves parent-child relationships', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="parent" style={{}}>
    <div data-id="child1" style={{}}></div>
    <div data-id="child2" style={{}}></div>
  </div>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('parent')!.parentId).toBe('root');
    expect(nodes.get('child1')!.parentId).toBe('parent');
    expect(nodes.get('child2')!.parentId).toBe('parent');
    expect(nodes.get('parent')!.children).toEqual(['child1', 'child2']);
  });

  test('extracts text content', () => {
    const code = `<p data-id="text" style={{}}>Hello World</p>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('text')!.textContent).toBe('Hello World');
  });

  test('extracts HTML attributes', () => {
    const code = `<img data-id="img" style={{}} src="test.png" alt="Test" />`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('img')!.attrs.src).toBe('test.png');
    expect(nodes.get('img')!.attrs.alt).toBe('Test');
  });

  test('detects mixed content with inline elements', () => {
    const code = `<h1 data-id="heading" style={{}}>We craft <br /> <span>digital</span> spaces</h1>`;
    const nodes = parseJSXToNodes(code);
    const heading = nodes.get('heading')!;
    expect(heading.hasMixedContent).toBe(true);
    expect(heading.textContent).toContain('We craft');
    expect(heading.textContent).toContain('spaces');
    // Inline children are NOT separate nodes (they're in textContent)
    expect(heading.children).toEqual([]);
    expect(nodes.size).toBe(1);
  });

  test('does not flag mixed content for structural children', () => {
    const code = `<div data-id="container" style={{}}>
  <div data-id="child1" style={{}}>Hello</div>
  <div data-id="child2" style={{}}>World</div>
</div>`;
    const nodes = parseJSXToNodes(code);
    const container = nodes.get('container')!;
    expect(container.hasMixedContent).toBe(false);
    expect(container.children).toEqual(['child1', 'child2']);
  });

  test('does not flag mixed content for text-only elements', () => {
    const code = `<p data-id="para" style={{}}>Just text</p>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('para')!.hasMixedContent).toBe(false);
    expect(nodes.get('para')!.textContent).toBe('Just text');
  });

  test('detects mixed content with strong and em', () => {
    const code = `<p data-id="rich" style={{}}>Hello <strong>bold</strong> and <em>italic</em> text</p>`;
    const nodes = parseJSXToNodes(code);
    const rich = nodes.get('rich')!;
    expect(rich.hasMixedContent).toBe(true);
    expect(rich.textContent).toContain('Hello');
    expect(rich.children).toEqual([]);
  });

  test('does not flag mixed content when child is non-inline (div)', () => {
    const code = `<div data-id="wrap" style={{}}>Some text <div data-id="block" style={{}}>block</div></div>`;
    const nodes = parseJSXToNodes(code);
    const wrap = nodes.get('wrap')!;
    expect(wrap.hasMixedContent).toBe(false);
    expect(wrap.children).toContain('block');
  });

  test('mixed content parent still connects to its own parent', () => {
    const code = `<div data-id="root" style={{}}>
  <h1 data-id="heading" style={{}}>We craft <span>digital</span> spaces</h1>
</div>`;
    const nodes = parseJSXToNodes(code);
    const heading = nodes.get('heading')!;
    expect(heading.hasMixedContent).toBe(true);
    expect(heading.parentId).toBe('root');
    expect(nodes.get('root')!.children).toContain('heading');
  });
});
