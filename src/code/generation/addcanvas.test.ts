import { describe, test, it, expect } from 'vitest';
import { addCanvasNodeInCode, addNodeInCode, updateNodeInCode, moveNodeInCode, flattenVariantConditionalStylesInCode, inlineCanvasNodePropRefsInCode, stripCanvasNodeMotionRefsInCode, stashCanvasNodeConnectionsInCode, setCanvasNodeConnectionInCode } from './generator-crud';
import { findJSXDataIdIndex } from './generator-utils';
import { updateVariantStyleInCode } from './generator-styles';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = (_traverse as any).default || _traverse;
import { parseJSX } from '../parsing/ast-utils';
import { parseJSXToNodes } from '../parsing/parser';

import { removeNodeInCode } from './generator-crud';

describe('canvas-node variant connections (data-conn-target)', () => {
  test('stash: a dragged-out node’s on*={() => setVariant(…)} → data-conn-target + handler stripped (no module-scope crash)', () => {
    const code = `function C() { const [variant, setVariant] = React.useState('default'); return <div/>; }
const canvasNodes = <>
  <motion.div data-id="d1" data-canvas-node="true" onTap={() => setVariant('variant-1')} style={{ left: '5px' }}></motion.div>
  <motion.div data-id="d2" data-canvas-node="true" onHoverStart={() => setVariant('variant-2')} style={{ left: '9px' }}></motion.div>
</>;`;
    const out = stashCanvasNodeConnectionsInCode(code);
    expect(out).toContain('data-conn-target="variant-1:click"');
    expect(out).toContain('data-conn-target="variant-2:mouseEnter"');
    expect(out.slice(out.indexOf('canvasNodes'))).not.toMatch(/onTap=|onHoverStart=/); // crashing handlers gone
  });
  test('create: writes/replaces data-conn-target on a canvas node', () => {
    const code = `const canvasNodes = <>\n  <div data-id="x" data-canvas-node="true" style={{ left: '5px' }}></div>\n</>;`;
    const a = setCanvasNodeConnectionInCode(code, 'x', 'variant-1', 'click');
    expect(a).toContain('data-conn-target="variant-1:click"');
    const b = setCanvasNodeConnectionInCode(a, 'x', 'variant-2', 'mouseEnter');
    expect(b).toContain('data-conn-target="variant-2:mouseEnter"');
    expect(b).not.toContain('variant-1:click'); // replaced, not duplicated
  });
});

describe('stripCanvasNodeMotionRefsInCode', () => {
  test('strips variant/animation JSX attrs + unwraps {variant && <el>} so a dragged-out subtree has no undefined module-scope refs', () => {
    const code = `import { motion, AnimatePresence } from 'framer-motion';
const vConsts = { default: { left: '28%' } };
function PoHeWo({ initialVariant = 'default', transition5 = {} }) {
  const [variant] = React.useState(initialVariant);
  return <div />;
}
const canvasNodes = <>
  <motion.div data-id="a" variants={vConsts} initial={['default', initialVariant]} animate={['default', variant]} layout={true} data-canvas-node="true" style={{ left: '28%' }}>
    <AnimatePresence mode="popLayout">{variant === "variant-1" && <motion.div data-id="b" transition={variant === 'variant-1' ? transition5 : undefined} animate={['default', variant]} data-replica-solo="variant-1" style={{ left: '97px' }}></motion.div>}</AnimatePresence>
    <motion.div data-id="c" transition={{ type: 'spring', stiffness: 300 }} style={{ left: '5px' }}></motion.div>
  </motion.div>
</>;`;
    const out = stripCanvasNodeMotionRefsInCode(code);
    const ast = parse(out, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    let globals: string[] = [];
    traverse(ast, { Program(p: any) { globals = Object.keys(p.scope.globals || {}); } });
    expect(globals).not.toContain('variant');         // animate/transition refs stripped
    expect(globals).not.toContain('initialVariant');   // initial ref stripped
    expect(globals).not.toContain('transition5');       // transition ternary ref stripped
    expect(out).toContain('data-id="b"');               // inner element unwrapped, not deleted
    expect(out).not.toMatch(/variant === "variant-1" &&/);
    expect(out).not.toMatch(/animate=\{\['default', variant\]\}/);
    // a node's OWN LITERAL transition is KEPT (follows the node; valid at module scope)
    expect(out).toMatch(/data-id="c"[^>]*transition=\{\{\s*type: 'spring'/);
  });
});

describe('addCanvasNodeInCode', () => {
  test('creates canvasNodes fragment when none exists (after export default function)', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}></div>
  );
}`;
    const result = addCanvasNodeInCode(code, {
      id: 'canvas-1', type: 'div', styles: { position: 'absolute', left: '100px', top: '50px' },
    });
    expect(result).toContain('const canvasNodes = (<>');
    expect(result).toContain('</>)');
    expect(result).toContain('data-id="canvas-1"');
    expect(result).toContain('data-canvas-node="true"');
    // canvasNodes block should be AFTER the export default function closing brace
    const exportEnd = result.indexOf('}', result.indexOf('export default function'));
    const canvasNodesStart = result.indexOf('const canvasNodes');
    expect(canvasNodesStart).toBeGreaterThan(exportEnd);
  });

  test('handles destructured TS-typed params (e.g. LayoutClient signature)', () => {
    // Regression: previously `findExportDefaultEndIdx` matched the first
    // `{` after the function name, which on a layout-style signature
    // landed inside the destructuring pattern (`{ children }`) — so the
    // canvasNodes block was injected mid-signature, corrupting the file.
    const code = `'use client';

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{ position: 'relative', width: '100%' }}>
      {children}
    </div>
  );
}
`;
    const result = addCanvasNodeInCode(code, {
      id: 'frame-1', type: 'div', styles: { position: 'absolute', left: '100px', top: '50px' },
    });
    // Must NOT split the function signature — original code stays intact.
    expect(result).toContain("export default function LayoutClient({ children }: { children: React.ReactNode })");
    // canvasNodes block should land AFTER the function body closer, not
    // inside the signature.
    const fnSignatureIdx = result.indexOf('export default function LayoutClient');
    const fnBodyOpenIdx = result.indexOf('return (', fnSignatureIdx);
    const canvasNodesIdx = result.indexOf('const canvasNodes');
    expect(canvasNodesIdx).toBeGreaterThan(fnBodyOpenIdx);
    // The injected node should still be present.
    expect(result).toContain('data-id="frame-1"');
  });

  test('creates canvasNodes fragment when none exists (after withResponsiveProps export)', () => {
    const code = `function Hero({ style }) {
  return (
    <motion.div data-id="root" style={{width: '400px', ...style}}></motion.div>
  );
}

export default withResponsiveProps(Hero);`;
    const result = addCanvasNodeInCode(code, {
      id: 'c1', type: 'div', styles: { position: 'absolute', left: '0px' },
    });
    expect(result).toContain('const canvasNodes = (<>');
    expect(result).toContain('data-id="c1"');
    // Should appear after the export default line
    const exportIdx = result.indexOf('export default withResponsiveProps(Hero);');
    const canvasNodesIdx = result.indexOf('const canvasNodes');
    expect(canvasNodesIdx).toBeGreaterThan(exportIdx);
  });

  test('appends to existing canvasNodes fragment', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}></div>
  );
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute', left: '0px'}}></div>
</>);
`;
    const result = addCanvasNodeInCode(code, {
      id: 'c2', type: 'div', styles: { position: 'absolute', left: '200px', top: '100px' },
    });
    expect(result).toContain('data-id="c1"');
    expect(result).toContain('data-id="c2"');
    // Should still have exactly one canvasNodes declaration
    const matches = result.match(/const canvasNodes/g);
    expect(matches).toHaveLength(1);
    // Both nodes should be inside the fragment
    const fragStart = result.indexOf('const canvasNodes');
    expect(result.indexOf('data-id="c2"')).toBeGreaterThan(fragStart);
  });

  test('appends to existing canvasNodes fragment WITHOUT parens', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}></div>
  );
}

const canvasNodes = <>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute', left: '0px'}}></div>
</>;
`;
    const result = addCanvasNodeInCode(code, {
      id: 'c2', type: 'div', styles: { position: 'absolute', left: '200px', top: '100px' },
    });
    expect(result).toContain('data-id="c1"');
    expect(result).toContain('data-id="c2"');
    const matches = result.match(/const canvasNodes/g);
    expect(matches).toHaveLength(1);
  });

  test('works with export default function pattern', () => {
    const code = `export default function Page() {
  return (
    <div data-id="root" style={{}}></div>
  );
}`;
    const result = addCanvasNodeInCode(code, {
      id: 'cv1', type: 'div', styles: { left: '10px' },
    });
    expect(result).toContain('const canvasNodes = (<>');
    expect(result).toContain('data-id="cv1"');
    expect(result).toContain('data-canvas-node="true"');
  });

  test('canvas node with text content', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}`;
    const result = addCanvasNodeInCode(code, {
      id: 'note-1', type: 'div', styles: { position: 'absolute' }, textContent: 'Hello world',
    });
    expect(result).toContain('Hello world');
    expect(result).toContain('data-id="note-1"');
  });

  test('canvas node with data-name attribute', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}`;
    const result = addCanvasNodeInCode(code, {
      id: 'frame-1', type: 'div', styles: { position: 'absolute' }, name: 'My Frame',
    });
    expect(result).toContain('data-name="My Frame"');
  });

  test('fallback: appends at end when no export default found', () => {
    // Raw JSX or unusual file without export default
    const code = `const x = 1;\nconst y = 2;`;
    const result = addCanvasNodeInCode(code, {
      id: 'c1', type: 'div', styles: { left: '0px' },
    });
    expect(result).toContain('const canvasNodes = (<>');
    expect(result).toContain('data-id="c1"');
  });

  test('round-trip: add → parse → verify isCanvasNode=true', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px', height: '900px'}}></div>
  );
}`;
    const result = addCanvasNodeInCode(code, {
      id: 'c1', type: 'div', styles: { position: 'absolute', left: '100px', top: '50px' },
    });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('c1')).toBeDefined();
    expect(nodes.get('c1')?.isCanvasNode).toBe(true);
    expect(nodes.get('c1')?.styles.position).toBe('absolute');
    expect(nodes.get('c1')?.styles.left).toBe('100px');
    // Root should not be a canvas node
    expect(nodes.get('root')?.isCanvasNode).toBe(false);
  });

  test('round-trip: add multiple → parse → all are canvas nodes', () => {
    let code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}></div>
  );
}`;
    code = addCanvasNodeInCode(code, {
      id: 'c1', type: 'div', styles: { position: 'absolute', left: '0px' },
    });
    code = addCanvasNodeInCode(code, {
      id: 'c2', type: 'div', styles: { position: 'absolute', left: '200px' },
    });
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('c1')?.isCanvasNode).toBe(true);
    expect(nodes.get('c2')?.isCanvasNode).toBe(true);
    expect(nodes.get('root')?.isCanvasNode).toBe(false);
  });

  test('JSON-valued attrs (data-instance-fx) are single-quoted so the canvas node parses', () => {
    // Dragging out a replica with scroll/fx carries `data-instance-fx='<json>'` onto the detached
    // canvas node. Double-quoting the JSON (`data-instance-fx="{"hover"…`) crashed the parser with
    // "Unexpected token". serializeJSXAttr must single-quote any value containing a double quote.
    const code = `export default function Home() {\n  return (<div data-id="root"></div>);\n}`;
    const fx = '{"hover":{"to":{"scale":1.05}},"speed":110,"transform":{"to":{"opacity":1,"scale":1}}}';
    const result = addCanvasNodeInCode(code, {
      id: 'detach-1', type: 'TaVuLe', name: 'Frame',
      attrs: { 'data-instance-fx': fx, 'data-responsive': '{"768":{"initialVariant":"variant-1"}}' },
      styles: { position: 'absolute', left: '100px', top: '50px', width: '200px', height: '120px' },
    });
    // Single-quoted JSON, parseable, JSON round-trips intact.
    expect(result).toContain(`data-instance-fx='${fx}'`);
    const nodes = parseJSXToNodes(result);          // would throw on the old double-quoted output
    expect(nodes.get('detach-1')?.isCanvasNode).toBe(true);
    expect(JSON.parse(nodes.get('detach-1')!.attrs!['data-instance-fx'])).toMatchObject({ speed: 110 });
  });

  test('flattenVariantConditionalStylesInCode: resolves initialVariant ternary to default branch', () => {
    // A component-internal node moved to canvasNodes keeps a `display: initialVariant === ... ? ...`
    // conditional referencing the (now out-of-scope) prop → "undefined identifier" crash.
    const code = `const canvasNodes = (<>\n  <ViTiPa data-id="kid" style={{ position: 'absolute', left: '0px', display: initialVariant === 'variant-2' ? 'none' : '' }}></ViTiPa>\n</>);`;
    const out = flattenVariantConditionalStylesInCode(code, 'kid');
    expect(out).not.toMatch(/initialVariant ===/);   // ternary gone (no undefined ref)
    expect(out).not.toMatch(/\bdisplay:/);            // empty default → property removed
    expect(out).toMatch(/left: '0px'/);               // static styles untouched
    expect(parseJSX(out)).not.toBeNull();
  });

  test('flattenVariantConditionalStylesInCode: non-empty default branch is KEPT (not dropped)', () => {
    const code = `const canvasNodes = (<>\n  <Box data-id="b" style={{ flexDirection: variant === 'variant-1' ? 'row' : 'column', order: initialVariant === 'variant-1' ? 1 : 0 }}></Box>\n</>);`;
    const out = flattenVariantConditionalStylesInCode(code, 'b');
    expect(out).not.toMatch(/===/);
    expect(out).toMatch(/flexDirection: 'column'/);   // default branch baked
    expect(out).toMatch(/order: 0/);                  // numeric default baked (unquoted)
  });

  test('flattenVariantConditionalStylesInCode: no-op when the node has no variant conditional', () => {
    const code = `const canvasNodes = (<>\n  <Box data-id="b" style={{ left: '5px', display: 'flex' }}></Box>\n</>);`;
    expect(flattenVariantConditionalStylesInCode(code, 'b')).toBe(code);
  });

  test('inlineCanvasNodePropRefsInCode: inlines a plain component-prop ref in a canvas node style', () => {
    // The reported crash: a node dragged out of a variant keeps `boxShadow: <prop>`, but the prop is
    // a function param — undefined at module-scope canvasNodes ("References undefined identifier").
    const code = `function Frame({ style, zegzegzegezg = "0px 4px 8px rgba(0,0,0,0.25)", zjefoizjefoizjef = "" }) {
  return <div data-id="root"></div>;
}
export default Frame;

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{ position: 'absolute', left: '50px', boxShadow: zjefoizjefoizjef }}></div>
  <div data-id="c2" data-canvas-node="true" style={{ position: 'absolute', left: '90px', boxShadow: zegzegzegezg }}></div>
</>);`;
    const out = inlineCanvasNodePropRefsInCode(code);
    // Both prop refs resolved to their default literals — no dangling identifiers.
    expect(out).not.toMatch(/boxShadow:\s*zjefoizjefoizjef/);
    expect(out).not.toMatch(/boxShadow:\s*zegzegzegezg/);
    expect(out).toMatch(/boxShadow:\s*"0px 4px 8px rgba\(0,0,0,0\.25\)"/);
    expect(out).toMatch(/boxShadow:\s*""/);   // empty default → empty literal
    expect(parseJSX(out)).not.toBeNull();
  });

  test('inlineCanvasNodePropRefsInCode: resolves a per-variant ternary ref to all-literals', () => {
    const code = `function Frame({ zefzef = "54px solid #b84242" }) {
  return <div data-id="root"></div>;
}
const canvasNodes = (<>
  <div data-id="c1" style={{ "--border": initialVariant === 'variant-1' ? zefzef : 'none' }}></div>
</>);`;
    const out = inlineCanvasNodePropRefsInCode(code);
    // zefzef inlined; initialVariant is NOT a prop with a default here so it remains — but the user's
    // real components always have initialVariant defaulted, so the common case is fully literal.
    expect(out).not.toMatch(/\?\s*zefzef\s*:/);
    expect(out).toMatch(/"54px solid #b84242"/);
  });

  test('inlineCanvasNodePropRefsInCode: leaves module-scope const refs untouched', () => {
    const code = `const sharedShadow = "0 0 0 #000";
const canvasNodes = (<>
  <div data-id="c1" style={{ boxShadow: sharedShadow }}></div>
</>);`;
    // No component function / no prop defaults → no-op (sharedShadow is valid at module scope).
    expect(inlineCanvasNodePropRefsInCode(code)).toBe(code);
  });

  test('inlineCanvasNodePropRefsInCode: no-op when there is no canvasNodes fragment', () => {
    const code = `function Frame({ x = "1px" }) { return <div data-id="root" style={{ boxShadow: x }}></div>; }`;
    expect(inlineCanvasNodePropRefsInCode(code)).toBe(code);
  });

  test('fast path — no Babel parse needed', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{width: '1440px'}}></div>);
}`;
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      addCanvasNodeInCode(code, { id: `c${i}`, type: 'div', styles: { left: '0px' } });
    }
    const elapsed = performance.now() - t0;
    // Should be < 50ms for 100 iterations (string concat, no Babel)
    expect(elapsed).toBeLessThan(200);
  });
});

describe('removeNodeInCode on canvasNodes fragment', () => {
  test('removes a canvas node from canvasNodes fragment', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute', left: '0px'}}></div>
  <div data-id="c2" data-canvas-node="true" style={{position: 'absolute', left: '200px'}}></div>
</>);
`;
    const result = removeNodeInCode(code, 'c1');
    expect(result).not.toContain('data-id="c1"');
    expect(result).toContain('data-id="c2"');
    // Root should still be intact
    expect(result).toContain('data-id="root"');
  });

  test('removes the only canvas node from canvasNodes fragment', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute'}}></div>
</>);
`;
    const result = removeNodeInCode(code, 'c1');
    expect(result).not.toContain('data-id="c1"');
    // Root should still be intact
    expect(result).toContain('data-id="root"');
  });

  test('does not affect viewport nodes when removing canvas node', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
      <div data-id="child1" style={{width: '100px'}}></div>
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute'}}></div>
</>);
`;
    const result = removeNodeInCode(code, 'c1');
    expect(result).toContain('data-id="child1"');
    expect(result).toContain('data-id="root"');
    expect(result).not.toContain('data-id="c1"');
  });
});

describe('canvas nodes full flow', () => {
  test('add + update + remove canvas node in canvasNodes fragment', () => {
    let code = `function Page() { return <div data-id="root" style={{}}></div>; }
export default Page;`;

    // Add
    code = addCanvasNodeInCode(code, {
      id: 'f1', type: 'div', styles: { position: 'absolute', width: '100px', left: '50px' }, name: 'Frame',
    });
    expect(code).toContain('const canvasNodes');
    expect(code).toContain('data-id="f1"');

    // Parse
    let nodes = parseJSXToNodes(code);
    expect(nodes.get('f1')?.isCanvasNode).toBe(true);
    expect(nodes.get('f1')?.styles.width).toBe('100px');

    // Update style
    code = updateNodeInCode(code, 'f1', { width: '200px' });
    nodes = parseJSXToNodes(code);
    expect(nodes.get('f1')?.styles.width).toBe('200px');

    // Remove
    code = removeNodeInCode(code, 'f1');
    expect(code).not.toContain('data-id="f1"');
  });

  test('add multiple canvas nodes, update one, remove another', () => {
    let code = `export default function Home() {
  return (<div data-id="root" style={{width: '1440px'}}></div>);
}`;

    // Add two canvas nodes
    code = addCanvasNodeInCode(code, {
      id: 'a1', type: 'div', styles: { position: 'absolute', left: '0px', width: '100px' },
    });
    code = addCanvasNodeInCode(code, {
      id: 'a2', type: 'div', styles: { position: 'absolute', left: '200px', width: '150px' },
    });

    let nodes = parseJSXToNodes(code);
    expect(nodes.get('a1')?.isCanvasNode).toBe(true);
    expect(nodes.get('a2')?.isCanvasNode).toBe(true);
    expect(nodes.get('root')?.isCanvasNode).toBe(false);

    // Update a2 style
    code = updateNodeInCode(code, 'a2', { width: '300px' });
    nodes = parseJSXToNodes(code);
    expect(nodes.get('a2')?.styles.width).toBe('300px');
    expect(nodes.get('a1')?.styles.width).toBe('100px'); // a1 unchanged

    // Remove a1
    code = removeNodeInCode(code, 'a1');
    expect(code).not.toContain('data-id="a1"');
    expect(code).toContain('data-id="a2"');
    expect(code).toContain('data-id="root"');

    // Remaining a2 is still valid
    nodes = parseJSXToNodes(code);
    expect(nodes.get('a2')?.isCanvasNode).toBe(true);
    expect(nodes.get('a2')?.styles.width).toBe('300px');
  });
});

describe('moveNodeInCode with canvasNodes', () => {
  test('moves canvas node into another canvas node (removes from fragment root)', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{}}></div>;
}

const canvasNodes = (<>
  <div data-id="parent-cn" data-canvas-node="true" style={{position: 'absolute', width: '300px', left: '0px', top: '0px'}}></div>
  <div data-id="child-cn" data-canvas-node="true" style={{position: 'absolute', width: '100px', left: '500px', top: '500px'}}></div>
</>);`;

    const result = moveNodeInCode(code, 'child-cn', 'parent-cn', { left: '50px', top: '30px' });

    // child-cn should appear only ONCE (inside parent-cn)
    const matches = result.match(/data-id="child-cn"/g);
    expect(matches).toHaveLength(1);

    // Parse and verify parent relationship
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('child-cn')?.parentId).toBe('parent-cn');
    expect(nodes.get('child-cn')?.isCanvasNode).toBe(false); // child, not top-level
    expect(nodes.get('parent-cn')?.isCanvasNode).toBe(true);
  });

  test('dragging a .map() TEMPLATE body to canvas empties the map (=> null), no duplicate', () => {
    const code = `import advisors from '@/cms/advisors.json';
export default function Page() {
  return <div data-id="root">{advisors.map((item, idx) => <Card key={idx} data-id="tpl" image={item.image} />)}</div>;
}`;
    const result = moveNodeInCode(code, 'tpl', null, { left: '10px', top: '10px' }, undefined, true);
    // The template appears ONLY ONCE (in canvasNodes) — NOT left behind in the
    // map as a duplicate data-id (the bug).
    expect(result.match(/data-id="tpl"/g)).toHaveLength(1);
    // The `.map()` SURVIVES as an empty, refillable collection list (the reference
    // "Empty State") — its body is now `null`, not the moved node.
    expect(result).toMatch(/advisors\.map\(\(item, idx\)\s*=>\s*null\)/);
    // The node landed in canvasNodes.
    expect(result).toContain('const canvasNodes = (<>');
    expect(result).toContain('data-canvas-node');
  });

  test('dragging a canvas node INTO an empty-map container REFILLS it as the .map() template (key added)', () => {
    const code = `import advisors from '@/cms/advisors.json';
export default function Page() {
  return <div data-id="wrap">{advisors.map((item, idx) => null)}</div>;
}

const canvasNodes = (<>
  <Card data-id="tpl" data-canvas-node="true" data-cms-orphan="image:image,name:name" style={{ width: '100px' }} />
</>);`;
    const result = moveNodeInCode(code, 'tpl', 'wrap', undefined, undefined, false);
    // The dropped node becomes the `.map()` template body — not a sibling, not null.
    expect(result).not.toMatch(/=>\s*null/);
    expect(result).toMatch(/advisors\.map\(\(item, idx\)\s*=>\s*<Card/);
    // key={idx} added for React reconciliation.
    expect(result).toContain('key={idx}');
    // Moved out of canvasNodes (single occurrence, canvas attr stripped). The
    // data-cms-orphan stash stays — the move path rehydrates it separately.
    expect(result.match(/data-id="tpl"/g)).toHaveLength(1);
    expect(result).not.toContain('data-canvas-node="true"');
  });

  test('moves canvas node child OUT to become top-level canvas node', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{}}></div>;
}

const canvasNodes = (<>
  <div data-id="parent-cn" data-canvas-node="true" style={{position: 'absolute', width: '300px', left: '0px', top: '0px'}}>
    <div data-id="nested" style={{position: 'absolute', width: '100px', left: '50px', top: '30px'}}></div>
  </div>
</>);`;

    const result = moveNodeInCode(code, 'nested', null, { left: '200px', top: '200px' }, undefined, true);

    // nested should appear only ONCE
    const matches = result.match(/data-id="nested"/g);
    expect(matches).toHaveLength(1);

    // Parse and verify it's now top-level
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('nested')?.parentId).toBeNull();
    expect(nodes.get('nested')?.isCanvasNode).toBe(true);
    // data-canvas-node should be added
    expect(result).toContain('data-canvas-node');
  });
});

describe('moveNodeInCode exit-to-canvas — variant-family prop stripping', () => {
  // The exit-to-canvas path strips `variants` / `initial` / `animate` /
  // `layoutId` because the typical case is `animate={variant}` /
  // `initial={initialVariant}` — references to function-scope vars that
  // don't exist at canvas root. But OBJECT-LITERAL `animate={{ rotate:
  // 360 }}` is a standalone animation (Loop, simple Animate) and MUST
  // survive the exit. Same for `initial={{ scale: 0 }}`. User-reported
  // bug: dragging a rotating frame out to the canvas killed the
  // rotation.

  test('keeps animate={{...}} object literal when moving to canvas', () => {
    const code = `export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.div data-id="spinner" style={{width: '100px'}} animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity }}></motion.div>
  </div>);
}`;
    const result = moveNodeInCode(code, 'spinner', null, { left: '0px', top: '0px' }, undefined, true);
    // animate={{ rotate: 360 }} must be preserved (standalone animation)
    expect(result).toMatch(/animate=\{\{\s*rotate:\s*360\s*\}\}/);
    // transition is never stripped — independent prop
    expect(result).toContain('repeat: Infinity');
  });

  test('keeps initial={{...}} object literal when moving to canvas', () => {
    const code = `export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.div data-id="fader" style={{width: '100px'}} initial={{ opacity: 0 }} animate={{ opacity: 1 }}></motion.div>
  </div>);
}`;
    const result = moveNodeInCode(code, 'fader', null, { left: '0px', top: '0px' }, undefined, true);
    expect(result).toMatch(/initial=\{\{\s*opacity:\s*0\s*\}\}/);
    expect(result).toMatch(/animate=\{\{\s*opacity:\s*1\s*\}\}/);
  });

  test('strips animate={variantName} identifier ref when moving to canvas', () => {
    // The dangerous case: at canvas root `variant` is undefined.
    const code = `export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.div data-id="vchild" style={{width: '100px'}} variants={someVariants} animate={variant} initial={initialVariant}></motion.div>
  </div>);
}`;
    const result = moveNodeInCode(code, 'vchild', null, { left: '0px', top: '0px' }, undefined, true);
    expect(result).not.toContain('animate={variant}');
    expect(result).not.toContain('initial={initialVariant}');
    expect(result).not.toContain('variants=');
  });

  test('strips the variant-LIST wiring and folds the default rotation when moving to canvas', () => {
    // The inheritance dialect: animate={['default', variant]} — an
    // ArrayExpression of names/identifiers is a variant binding (missed
    // 2026-06-12: the refs survived into module-scope canvasNodes and the
    // validator blocked every later mutation). The default entry's rotate
    // is the PRIMARY's rotation — it folds into the canvas-node channel
    // (inline style `rotate`) so the exited shape keeps its look.
    const code = `const shapeVariants = {
  default: { x: 0, y: 0, rotate: 122.5 },
  'variant-1': { rotate: -30 }
};
export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.svg data-id="vlist" variants={shapeVariants} initial={['default', initialVariant]} animate={['default', variant]} x="10" y="10" width="50" height="40" viewBox="0 0 50 40" style={{ transformBox: 'view-box', transformOrigin: '35px 30px' }}>
      <path d="M0 0 L10 10z" />
    </motion.svg>
  </div>);
}`;
    const result = moveNodeInCode(code, 'vlist', null, { left: '0px', top: '0px' }, undefined, true);
    expect(result).not.toContain('initialVariant');
    expect(result).not.toContain("animate={['default'");
    expect(result).not.toContain('variants=');
    // the primary's rotation folded into the canvas-node style channel
    expect(result).toMatch(/rotate:\s*["']122.5["']/);
  });

  test('strips animate="variantName" string-literal binding when moving to canvas', () => {
    const code = `export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.div data-id="sb" style={{width: '100px'}} variants={someVariants} animate="hidden" initial="visible"></motion.div>
  </div>);
}`;
    const result = moveNodeInCode(code, 'sb', null, { left: '0px', top: '0px' }, undefined, true);
    expect(result).not.toContain('animate="hidden"');
    expect(result).not.toContain('initial="visible"');
    expect(result).not.toContain('variants=');
  });

  test('always strips variants={...} and layoutId regardless of value shape', () => {
    const code = `export default function Page() {
  return (<div data-id="root" style={{width: '1440px'}}>
    <motion.div data-id="combo" style={{width: '100px'}} variants={vRef} layoutId="hero" animate={{ scale: 1 }}></motion.div>
  </div>);
}`;
    const result = moveNodeInCode(code, 'combo', null, { left: '0px', top: '0px' }, undefined, true);
    expect(result).not.toContain('variants=');
    expect(result).not.toContain('layoutId=');
    // The standalone animate stays
    expect(result).toMatch(/animate=\{\{\s*scale:\s*1\s*\}\}/);
  });

  test('inlines a component-prop style ref (boxShadow: prop) when moving a variant child to canvas', () => {
    // User-reported crash: dragging a variant child that has `boxShadow: <prop>` out to the canvas
    // produced `boxShadow: <prop>` in module-scope canvasNodes → "References undefined identifier".
    const code = `function ZoMaFe({ style, initialVariant = 'default', zegzegzegezg = "0px 4px 8px rgba(0,0,0,0.25)" }) {
  return <LayoutGroup>
    <motion.div data-id="root" style={{ ...style }}>
      <motion.div data-id="kid" variants={kidVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'absolute', width: '114px', left: '334px', top: '163px', boxShadow: zegzegzegezg }}></motion.div>
    </motion.div>
  </LayoutGroup>;
}
export default ZoMaFe;`;
    const result = moveNodeInCode(code, 'kid', null, { left: '0px', top: '0px' }, undefined, true);
    // The prop ref is resolved to its literal default — no dangling identifier at module scope.
    expect(result).not.toMatch(/boxShadow:\s*zegzegzegezg/);
    expect(result).toMatch(/boxShadow:\s*"0px 4px 8px rgba\(0,0,0,0\.25\)"/);
    // variant-family props still stripped
    expect(result).not.toContain('animate={initialVariant}');
    expect(result).not.toContain('variants=');
    expect(parseJSX(result)).not.toBeNull();
  });
});

describe('updateNodeInCode on canvasNodes fragment', () => {
  test('updates styles on a canvas node in canvasNodes fragment', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute', left: '0px', top: '0px'}}></div>
</>);
`;
    const result = updateNodeInCode(code, 'c1', { left: '150px', top: '75px' });
    expect(result).toContain("left: '150px'");
    expect(result).toContain("top: '75px'");
    expect(result).not.toContain("left: '0px'");
    expect(result).not.toContain("top: '0px'");
  });

  test('findJSXDataIdIndex finds canvas node data-id', () => {
    const code = `export default function Home() {
  return (<div data-id="root" style={{}}></div>);
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute'}}></div>
</>);
`;
    const idx = findJSXDataIdIndex(code, 'c1');
    expect(idx).toBeGreaterThan(-1);
    expect(code.slice(idx, idx + 12)).toBe('data-id="c1"');
  });

  test('updates do not affect viewport nodes', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
      <div data-id="child1" style={{width: '100px'}}></div>
    </div>
  );
}

const canvasNodes = (<>
  <div data-id="c1" data-canvas-node="true" style={{position: 'absolute', left: '0px'}}></div>
</>);
`;
    const result = updateNodeInCode(code, 'c1', { left: '300px' });
    expect(result).toContain("width: '100px'"); // child1 unchanged
    expect(result).toContain("width: '1440px'"); // root unchanged
    expect(result).toContain("left: '300px'"); // c1 updated
  });
});

describe('canvas node entry into variant — mutation sequence', () => {
  test('moveNode + updateVariantStyle(default, display:none) + updateVariantStyle(variant-1, left/top) — no duplicate default', () => {
    let code = `import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Frame', x: 365, y: 0 },
];
function Comp({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" data-name="Frame" style={{ position: 'relative', width: '200px', height: '400px', ...style }}>
    </motion.div>
  </LayoutGroup>);
}
export default withResponsiveProps(Comp);
const canvasNodes = (<>
  <div data-id="cn-1" data-name="Frame" data-canvas-node="true" style={{position: 'absolute', width: '80px', height: '60px', left: '100px', top: '-200px'}}></div>
</>);`;

    // Step 1: move canvas node into root
    code = moveNodeInCode(code, 'cn-1', 'root', { position: 'absolute', left: '10px', top: '20px' });
    expect(code).toContain('data-id="cn-1"');

    // Step 2: hide in default variant
    code = updateVariantStyleInCode(code, 'cn-1', 'default', { display: 'none' });

    // Step 3: hide in variant-1 (position)
    code = updateVariantStyleInCode(code, 'cn-1', 'variant-1', { left: '50px', top: '100px' });

    // Should have exactly ONE 'default' key (not two)
    const variantsBlock = code.match(/const \w+Variants = \{[\s\S]*?\};/);
    expect(variantsBlock).toBeTruthy();
    const defaultCount = (variantsBlock![0].match(/default\s*:/g) || []).length;
    expect(defaultCount).toBe(1); // MUST be 1, not 2

    // The single default entry should contain display: 'none'
    expect(variantsBlock![0]).toContain("display: 'none'");
  });
});

// ─── updateNodeInCodeFast scoping fix ──────────────────────────────────────────

describe('updateNodeInCodeFast — style scoping', () => {
  test('element WITHOUT style attribute — fast path returns null, AST path creates style', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
      <div data-id="child1"></div>
    </div>
  );
}`;
    // updateNodeInCode should fall back to AST and add style attribute
    const result = updateNodeInCode(code, 'child1', { width: '200px' });
    // AST generator may use double quotes — check parsed value instead
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('child1')?.styles.width).toBe('200px');
    // Original root should be unchanged
    expect(nodes.get('root')?.styles.width).toBe('1440px');
  });

  test('element WITH style attribute — fast path works normally', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
      <div data-id="child1" style={{width: '100px', height: '50px'}}></div>
    </div>
  );
}`;
    const result = updateNodeInCode(code, 'child1', { width: '200px' });
    expect(result).toContain("width: '200px'");
    expect(result).toContain("height: '50px'");
    // Root unchanged
    expect(result).toContain("width: '1440px'");
  });

  test('component instance followed by div — updating instance does NOT modify next element order', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
      <CoZoTi data-id="inst1" data-name="Hero" style={{width: '400px'}} />
      <div data-id="child2" style={{order: '1', width: '100px'}}></div>
    </div>
  );
}`;
    // Update inst1 — should NOT touch child2's order
    const result = updateNodeInCode(code, 'inst1', { width: '500px' });
    expect(result).toContain("width: '500px'");
    // child2's order should be untouched
    expect(result).toContain("order: '1'");
    // Parse to verify both nodes
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('inst1')?.styles.width).toBe('500px');
    expect(nodes.get('child2')?.styles.order).toBe('1');
    expect(nodes.get('child2')?.styles.width).toBe('100px');
  });
});

// ─── removeNodeInCode — motion.* tag matching ──────────────────────────────────

describe('removeNodeInCode — motion.* tags', () => {
  test('removes <motion.div data-id="x">children</motion.div> correctly', () => {
    const code = `function Comp({ style }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" style={{width: '400px', ...style}}>
      <motion.div layout={true} data-id="child1" style={{width: '100px'}}>
        <motion.p layout={true} data-id="text1" style={{fontSize: '16px'}}>Hello</motion.p>
      </motion.div>
      <motion.div layout={true} data-id="child2" style={{width: '200px'}}></motion.div>
    </motion.div>
  </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;

    const result = removeNodeInCode(code, 'child1');
    // child1 and its nested text1 should be removed
    expect(result).not.toContain('data-id="child1"');
    expect(result).not.toContain('data-id="text1"');
    // child2 and root should remain
    expect(result).toContain('data-id="child2"');
    expect(result).toContain('data-id="root"');
  });

  test('removes self-closing motion.div', () => {
    const code = `function Comp({ style }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" style={{width: '400px', ...style}}>
      <motion.div layout={true} data-id="child1" style={{width: '100px'}} />
      <motion.div layout={true} data-id="child2" style={{width: '200px'}}></motion.div>
    </motion.div>
  </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;

    const result = removeNodeInCode(code, 'child1');
    expect(result).not.toContain('data-id="child1"');
    expect(result).toContain('data-id="child2"');
    expect(result).toContain('data-id="root"');
  });

  test('handles nested motion.div of same tag type', () => {
    const code = `function Comp({ style }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" style={{width: '400px', ...style}}>
      <motion.div layout={true} data-id="parent1" style={{width: '300px'}}>
        <motion.div layout={true} data-id="nested1" style={{width: '100px'}}></motion.div>
      </motion.div>
    </motion.div>
  </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;

    // Remove parent1 — should also remove nested1
    const result = removeNodeInCode(code, 'parent1');
    expect(result).not.toContain('data-id="parent1"');
    expect(result).not.toContain('data-id="nested1"');
    expect(result).toContain('data-id="root"');
  });
});

// ─── addNodeInCode — motion.* auto-conversion for component files ──────────────

describe('addNodeInCode — motion.* auto-conversion', () => {
  test('adding node to component file with withResponsiveProps → motion.div with layout={true}', () => {
    const code = `import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Comp({ style }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" style={{width: '400px', ...style}}>
    </motion.div>
  </LayoutGroup>);
}
export default withResponsiveProps(Comp);`;

    const result = addNodeInCode(code, 'root', {
      id: 'new-child',
      type: 'div',
      styles: { width: '100px', height: '50px' },
    });

    expect(result).toContain('motion.div');
    expect(result).toContain('data-id="new-child"');
    expect(result).toContain('layout={true}');
    // Parse to verify it's a valid child
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('new-child')).toBeDefined();
    expect(nodes.get('new-child')?.parentId).toBe('root');
  });

  test('adding node to component file with variantConfig → motion.div with layout={true}', () => {
    const code = `import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'Card' }];
function Card({ style }) {
  return (<LayoutGroup>
    <motion.div layout={true} data-id="root" style={{width: '300px', ...style}}>
    </motion.div>
  </LayoutGroup>);
}
export default Card;`;

    const result = addNodeInCode(code, 'root', {
      id: 'inner',
      type: 'p',
      styles: { fontSize: '16px' },
      textContent: 'Hello',
    });

    // Should be motion.p, not plain p
    expect(result).toContain('motion.p');
    expect(result).toContain('data-id="inner"');
    expect(result).toContain('layout={true}');
    expect(result).toContain('Hello');
  });

  test('adding node to regular page file does NOT convert to motion.*', () => {
    const code = `export default function Home() {
  return (
    <div data-id="root" style={{width: '1440px'}}>
    </div>
  );
}`;

    const result = addNodeInCode(code, 'root', {
      id: 'new-child',
      type: 'div',
      styles: { width: '100px' },
    });

    // Should be plain div, not motion.div
    expect(result).not.toContain('motion.div');
    expect(result).toContain('data-id="new-child"');
    expect(result).not.toContain('layout={true}');
  });
});

describe('addCanvasNodeInCode — carries framer-motion props onto the detached node', () => {
  const PAGE = `export default function Page() {
  return <div data-id="root"></div>;
}`;
  it('emits a motion.<tag> with whileHover when the node has motionProps', () => {
    const out = addCanvasNodeInCode(PAGE, {
      id: 'detach-1', type: 'div', name: 'Frame',
      styles: { position: 'absolute', width: '100px' },
      motionProps: { whileHover: { scale: '1.05', rotate: '40' } },
    });
    expect(out).toContain('<motion.div data-id="detach-1"');
    expect(out).toContain('whileHover={{ scale: 1.05, rotate: 40 }}');
    expect(out).toContain('data-canvas-node="true"');
    expect(out).toContain('</motion.div>');
  });
  it('stays a plain <div> when there are no motionProps', () => {
    const out = addCanvasNodeInCode(PAGE, {
      id: 'detach-2', type: 'div', styles: { width: '100px' },
    });
    expect(out).toContain('<div data-id="detach-2"');
    expect(out).not.toContain('motion.div');
  });
  it('drops marker keys (_scope/_base) and skips empty props', () => {
    const out = addCanvasNodeInCode(PAGE, {
      id: 'detach-3', type: 'div', styles: { width: '100px' },
      motionProps: { whileHover: { scale: '1.05', _scope: 'gate:__mq0', _base: '{}' } as any },
    });
    expect(out).toContain('whileHover={{ scale: 1.05 }}');
    expect(out).not.toContain('_scope');
    expect(out).not.toContain('_base');
  });
  it('quotes string values but leaves numbers/arrays bare', () => {
    const out = addCanvasNodeInCode(PAGE, {
      id: 'detach-4', type: 'div', styles: { width: '100px' },
      motionProps: { whileHover: { backgroundColor: '#ff0000', scale: '1.2' } },
    });
    expect(out).toContain("backgroundColor: '#ff0000'");
    expect(out).toContain('scale: 1.2');
  });
});

describe('moveNodeInCode — svg shape dragged out of component → plain canvas node', () => {
  const COMP = `function C({ initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div data-id="frame-1" style={{ position: 'absolute' }}>
      <motion.svg layout={true} data-id="shape-2" data-name="Triangle" viewBox="0 0 98 128" style={{ position: 'absolute', width: '98px', height: '128px' }}>
        <motion.path data-id="shape-2-g0" fill="#3b82f6" d="M49,0 L98,128 L0,128 Z" />
      </motion.svg>
    </motion.div>
  </LayoutGroup>;
}
export default C;`;

  test('demotes motion.svg/motion.path → svg/path and drops layout (so group-svgs can find it)', () => {
    const out = moveNodeInCode(COMP, 'shape-2', null, { left: '58px', top: '238px' }, undefined, true);
    expect(out).toContain('<svg');
    expect(out).not.toMatch(/<motion\.svg/);
    expect(out).not.toMatch(/<motion\.path/);
    expect(out).not.toContain('layout={true}');
    expect(out).toContain('canvasNodes');
  });

  test('keeps motion wrapper when a standalone animation survives the exit', () => {
    const anim = COMP.replace('layout={true}', 'layout={true} animate={{ rotate: 360 }}');
    const out = moveNodeInCode(anim, 'shape-2', null, { left: '0px', top: '0px' }, undefined, true);
    expect(out).toMatch(/<motion\.svg/);
    expect(out).toContain('animate={{');
  });
});
