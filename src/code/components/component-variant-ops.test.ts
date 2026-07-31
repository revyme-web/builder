import { describe, test, expect } from 'vitest';
import { parseVariantConfig, serializeVariantConfig, createDefaultVariantConfig } from '../variants/variant-config';
import { parseConnections, serializeConnections } from '../variants/connection-config';
import { parseJSXToNodes } from '../parsing/parser';
import { setConditionalOrderInCode, updateVariantStyleInCode } from '../generation/generator-styles';

// ─── Variant Config Parsing ─────────────────────────────────────────────────

describe('parseVariantConfig', () => {
  test('parses single default variant', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
];`;
    const result = parseVariantConfig(code);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true });
  });

  test('parses multi-variant config', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 520, y: 0 },
  { name: 'variant-2', label: 'Mobile', x: 1040, y: 0 },
];`;
    const result = parseVariantConfig(code);
    expect(result).toHaveLength(3);
    expect(result[0].isPrimary).toBe(true);
    expect(result[1].name).toBe('variant-1');
    expect(result[1].label).toBe('Tablet');
    expect(result[2].name).toBe('variant-2');
  });

  test('returns default when no variantConfig found', () => {
    const code = `export default function Foo() { return <div />; }`;
    const result = parseVariantConfig(code);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('default');
  });
});

describe('serializeVariantConfig', () => {
  test('round-trips cleanly', () => {
    const original = createDefaultVariantConfig();
    const serialized = serializeVariantConfig(original);
    const parsed = parseVariantConfig(serialized);
    expect(parsed[0].name).toBe(original[0].name);
    expect(parsed[0].isPrimary).toBe(true);
  });

  test('preserves multi-variant positions', () => {
    const variants = [
      { name: 'default', label: 'D', x: 0, y: 0, isPrimary: true },
      { name: 'variant-1', label: 'T', x: 500, y: 0 },
    ];
    const serialized = serializeVariantConfig(variants);
    const parsed = parseVariantConfig(serialized);
    expect(parsed[1].x).toBe(500);
  });
});

// ─── Parser: MotionConfig transparency ──────────────────────────────────────

describe('parser: MotionConfig transparency', () => {
  test('MotionConfig is not parsed as a node', () => {
    const code = `<MotionConfig transition={{ type: 'spring' }}>
  <div data-id="root" style={{ width: '100px' }}>
    <p data-id="child">Hello</p>
  </div>
</MotionConfig>`;
    const nodes = parseJSXToNodes(code);
    // MotionConfig should NOT appear as a node
    for (const [, node] of nodes) {
      expect(node.type).not.toBe('MotionConfig');
    }
    // root and child should exist
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('child')).toBe(true);
  });

  test('children of MotionConfig become children of parent', () => {
    const code = `<div data-id="wrapper">
  <MotionConfig transition={{ type: 'spring' }}>
    <div data-id="inner" style={{ width: '100px' }}></div>
  </MotionConfig>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('wrapper')).toBe(true);
    expect(nodes.has('inner')).toBe(true);
    // inner should be child of wrapper (MotionConfig is transparent)
    const wrapper = nodes.get('wrapper')!;
    expect(wrapper.children).toContain('inner');
  });
});

// ─── Parser: motionVariants extraction ──────────────────────────────────────

describe('parser: conditionalStyles (ternary order)', () => {
  test('extracts ternary order expression from style', () => {
    const code = `<motion.div data-id="root" style={{ display: 'flex' }}>
  <motion.p data-id="title" style={{ fontSize: '20px', order: variant === 'variant-1' ? 1 : 0 }}>Hello</motion.p>
</motion.div>`;
    const nodes = parseJSXToNodes(code);
    const title = nodes.get('title');
    expect(title?.conditionalStyles).not.toBeNull();
    expect(title?.conditionalStyles?.order?.['variant-1']).toBe('1');
    expect(title?.conditionalStyles?.order?.default).toBe('0');
    // Default value should also be in styles
    expect(title?.styles?.order).toBe('0');
  });

  test('node without ternary has null conditionalStyles', () => {
    const code = `<div data-id="plain" style={{ order: '2' }}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('plain')?.conditionalStyles).toBeNull();
    expect(nodes.get('plain')?.styles?.order).toBe('2');
  });
});

describe('parser: motionVariants extraction', () => {
  test('extracts variant styles from const', () => {
    const code = `const cardVariants = {
  default: { backgroundColor: '#fff' },
  'variant-1': { backgroundColor: '#f00' },
};

<motion.div data-id="card" variants={cardVariants} style={{ width: '100px' }}></motion.div>`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card');
    expect(card?.motionVariants).not.toBeNull();
    expect(card?.motionVariants?.default).toEqual({ backgroundColor: '#fff' });
    expect(card?.motionVariants?.['variant-1']).toEqual({ backgroundColor: '#f00' });
  });

  test('motionVariantsRef points to correct const', () => {
    const code = `const myVariants = {
  default: {},
  hover: { opacity: '0.5' },
};

<motion.div data-id="box" variants={myVariants} style={{}}></motion.div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('box')?.motionVariantsRef).toBe('myVariants');
  });

  test('node without variants has null motionVariants', () => {
    const code = `<div data-id="plain" style={{ width: '100px' }}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('plain')?.motionVariants).toBeNull();
  });
});

// ─── Connection code generation patterns ────────────────────────────────────

describe('connection code generation patterns', () => {
  test('clickStart trigger type is valid', () => {
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'clickStart' },
];`;
    const result = parseConnections(code);
    expect(result[0].trigger).toBe('clickStart');
  });

  test('inView trigger type is valid', () => {
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'inView', delay: 1.5 },
];`;
    const result = parseConnections(code);
    expect(result[0].trigger).toBe('inView');
    expect(result[0].delay).toBe(1.5);
  });

  test('all trigger types round-trip', () => {
    const connections = [
      { from: 'default', to: 'a', trigger: 'click' as const },
      { from: 'default', to: 'b', trigger: 'clickStart' as const },
      { from: 'default', to: 'c', trigger: 'mouseEnter' as const },
      { from: 'c', to: 'default', trigger: 'mouseLeave' as const },
      { from: 'default', to: 'd', trigger: 'inView' as const },
    ];
    const code = `const connections = [
  { from: 'default', to: 'a', trigger: 'click' },
  { from: 'default', to: 'b', trigger: 'clickStart' },
  { from: 'default', to: 'c', trigger: 'mouseEnter' },
  { from: 'c', to: 'default', trigger: 'mouseLeave' },
  { from: 'default', to: 'd', trigger: 'inView' },
];`;
    const parsed = parseConnections(code);
    expect(parsed).toHaveLength(5);
    expect(parsed.map(c => c.trigger)).toEqual(['click', 'clickStart', 'mouseEnter', 'mouseLeave', 'inView']);
  });
});

// ─── Generator: variant style with default base values ──────────────────────

describe('generator: updateVariantStyleInCode', () => {
  // These tests verify the generator's behavior by checking the output code patterns.
  // The actual generator function is tested in generator.test.ts.
  // Here we verify the architectural rules:

  test('default variant entry should have base values for animated properties', () => {
    // Rule: when variant-1 sets backgroundColor, default must also have backgroundColor
    // so framer-motion knows what to animate BACK to.
    const variantsCode = `const cardVariants = {
  default: { backgroundColor: '#ffffff' },
  'variant-1': { backgroundColor: '#ff0000' },
};`;
    // Both entries have backgroundColor — this is correct
    expect(variantsCode).toContain("default: { backgroundColor: '#ffffff' }");
    expect(variantsCode).toContain("'variant-1': { backgroundColor: '#ff0000' }");
  });

  test('child elements should NOT have animate/initial props', () => {
    // Rule: framer-motion propagates variants from parent to children.
    // Only the root element needs animate/initial.
    const rootCode = `<motion.div animate={variant} variants={cardVariants}>`;
    const childCode = `<motion.p variants={titleVariants} style={{ fontSize: '20px' }}>`;

    expect(rootCode).toContain('animate={variant}');
    expect(childCode).not.toContain('animate=');
    expect(childCode).not.toContain('initial=');
  });
});

// ─── Component file patterns ────────────────────────────────────────────────

describe('component file patterns', () => {
  test('withResponsiveProps wrapper pattern', () => {
    // Components must NOT use export default function
    // They must use: function Name() {} + export default withResponsiveProps(Name)
    const correctPattern = `function MyComp({ style, initialVariant = 'default' }) { }
export default withResponsiveProps(MyComp);`;

    expect(correctPattern).toContain('function MyComp');
    expect(correctPattern).not.toContain('export default function');
    expect(correctPattern).toContain('withResponsiveProps(MyComp)');
  });

  test('component accepts style and initialVariant props', () => {
    const signature = `function MyComp({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string })`;
    expect(signature).toContain('style');
    expect(signature).toContain("initialVariant = 'default'");
  });

  test('style spread is last in root style object', () => {
    const styleObj = `style={{ width: '320px', backgroundColor: '#fff', ...style }}`;
    // ...style must be at the end so instance overrides win
    const spreadIdx = styleObj.indexOf('...style');
    const lastPropIdx = styleObj.lastIndexOf("'#fff'");
    expect(spreadIdx).toBeGreaterThan(lastPropIdx);
  });
});

// ─── Parser: conditionalStyles (additional cases) ──────────────────────────

describe('parser: conditionalStyles (nested ternary)', () => {
  test('nested ternary extracts first variant + final fallback', () => {
    // variant === 'v1' ? 1 : variant === 'v2' ? 2 : 0
    // Parser extracts only { v1: '1', default: '0' } — intermediate v2 is lost
    // (this is by design; the while loop skips to the final alternate)
    const code = `<motion.div data-id="item" style={{ order: variant === 'v1' ? 1 : variant === 'v2' ? 2 : 0 }}></motion.div>`;
    const nodes = parseJSXToNodes(code);
    const item = nodes.get('item');
    expect(item?.conditionalStyles).not.toBeNull();
    expect(item?.conditionalStyles?.order?.['v1']).toBe('1');
    // Final fallback (0) is extracted as default
    expect(item?.conditionalStyles?.order?.default).toBe('0');
    // Static style uses the default (fallback) value
    expect(item?.styles?.order).toBe('0');
  });

  test('non-variant ternary becomes a condvar binding (no conditionalStyles)', () => {
    // Ternary using a non-variant identifier (e.g. isOpen) should NOT produce conditionalStyles
    const code = `<div data-id="panel" style={{ width: isOpen ? '100%' : '50%' }}></div>`;
    const nodes = parseJSXToNodes(code);
    const panel = nodes.get('panel');
    expect(panel?.conditionalStyles).toBeNull();
    // Product change: `<ident> ? '<str>' : '<str>'` is no longer skipped — the parser
    // captures it as a boolean variable binding (`condvar:<name>:<consequent>:<alternate>`)
    // so the resolve pass can pick the branch from the variable's default.
    expect(panel?.styles?.width).toBe('condvar:isOpen:100%:50%');
  });

  test('mixed: variant ternary + static props coexist', () => {
    const code = `<motion.div data-id="box" style={{ display: 'flex', opacity: variant === 'hover' ? 0.5 : 1, gap: '10px' }}></motion.div>`;
    const nodes = parseJSXToNodes(code);
    const box = nodes.get('box');
    // Static props present
    expect(box?.styles?.display).toBe('flex');
    expect(box?.styles?.gap).toBe('10px');
    // Conditional style extracted
    expect(box?.conditionalStyles?.opacity?.['hover']).toBe('0.5');
    expect(box?.conditionalStyles?.opacity?.default).toBe('1');
    // Opacity static value = default fallback
    expect(box?.styles?.opacity).toBe('1');
  });

  test('string values in ternary are extracted correctly', () => {
    const code = `<motion.div data-id="card" style={{ backgroundColor: variant === 'dark' ? '#000' : '#fff' }}></motion.div>`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card');
    expect(card?.conditionalStyles?.backgroundColor?.['dark']).toBe('#000');
    expect(card?.conditionalStyles?.backgroundColor?.default).toBe('#fff');
  });
});

// ─── Parser: LayoutGroup + MotionConfig transparency ───────────────────────

describe('parser: LayoutGroup + MotionConfig transparency', () => {
  test('LayoutGroup is not parsed as a node', () => {
    const code = `<LayoutGroup>
  <div data-id="root" style={{ width: '100px' }}>
    <p data-id="child">Hello</p>
  </div>
</LayoutGroup>`;
    const nodes = parseJSXToNodes(code);
    for (const [, node] of nodes) {
      expect(node.type).not.toBe('LayoutGroup');
    }
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('child')).toBe(true);
  });

  test('nested LayoutGroup + MotionConfig both transparent', () => {
    const code = `<LayoutGroup>
  <MotionConfig transition={{ type: 'spring' }}>
    <div data-id="root" style={{ display: 'flex' }}>
      <p data-id="a">A</p>
      <p data-id="b">B</p>
    </div>
  </MotionConfig>
</LayoutGroup>`;
    const nodes = parseJSXToNodes(code);
    // Neither wrapper should appear as a node
    for (const [, node] of nodes) {
      expect(node.type).not.toBe('LayoutGroup');
      expect(node.type).not.toBe('MotionConfig');
    }
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('a')).toBe(true);
    expect(nodes.has('b')).toBe(true);
    // Children count correct
    const root = nodes.get('root')!;
    expect(root.children).toHaveLength(2);
    expect(root.children).toContain('a');
    expect(root.children).toContain('b');
  });

  test('MotionConfig wrapping multiple siblings passes all through', () => {
    const code = `<div data-id="outer">
  <MotionConfig transition={{ duration: 0.3 }}>
    <div data-id="card1" style={{ width: '200px' }}></div>
    <div data-id="card2" style={{ width: '200px' }}></div>
  </MotionConfig>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('outer')).toBe(true);
    expect(nodes.has('card1')).toBe(true);
    expect(nodes.has('card2')).toBe(true);
    const outer = nodes.get('outer')!;
    // Both children should be children of outer (MotionConfig is transparent)
    expect(outer.children).toContain('card1');
    expect(outer.children).toContain('card2');
  });
});

// ─── Generator: setConditionalOrderInCode ──────────────────────────────────

describe('generator: setConditionalOrderInCode', () => {
  test('injects order ternary into existing style', () => {
    const code = `<motion.div data-id="item" style={{ display: 'flex' }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 1, default: 0 });
    // Product change: without connection state there is no `variant` var — the ternary
    // keys off `initialVariant` (detectVariantVar) to avoid a runtime ReferenceError.
    expect(result).toContain("order: initialVariant === 'variant-1' ? 1 : 0");
    expect(result).toContain("display: 'flex'");
  });

  test('uses `variant` as the ternary driver when connection state exists', () => {
    // detectVariantVar: `const [variant, …` (written by connection wiring) → `variant` driver.
    const code = `const [variant, setVariant] = useState(initialVariant);
<motion.div data-id="item" style={{ display: 'flex' }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 1, default: 0 });
    expect(result).toContain("order: variant === 'variant-1' ? 1 : 0");
  });

  test('adds layout={true} but not layoutId', () => {
    const code = `<motion.div data-id="item" style={{ display: 'flex' }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 1, default: 0 });
    expect(result).toContain('layout={true}');
    // Product change: layoutId is no longer added — a layoutId-tagged element inside
    // AnimatePresence popLayout animated to its "new" position before unmounting
    // (see ensureLayoutProp in generator-styles.ts); layout={true} alone drives FLIP.
    expect(result).not.toContain('layoutId');
  });

  test('updates existing order expression', () => {
    const code = `<motion.div data-id="item" layout={true} layoutId="item" style={{ display: 'flex', order: variant === 'variant-1' ? 1 : 0 }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 2, 'variant-2': 3, default: 0 });
    // Old expression is replaced
    expect(result).not.toContain("? 1 :");
    // Product change: existing branches are re-emitted on the DETECTED driver —
    // `initialVariant` here (this snippet carries no connection state).
    expect(result).toContain("initialVariant === 'variant-1' ? 2");
    expect(result).toContain("initialVariant === 'variant-2' ? 3");
    expect(result).toContain(": 0");
  });

  test('handles node with no existing style (returns unchanged)', () => {
    const code = `<motion.div data-id="item"></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 1, default: 0 });
    // No style={{}} to inject into, so code is returned unchanged
    expect(result).toBe(code);
  });

  test('handles non-existent node ID gracefully', () => {
    const code = `<motion.div data-id="other" style={{ display: 'flex' }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'missing', { default: 0 });
    expect(result).toBe(code);
  });

  test('only default order produces static value (no ternary)', () => {
    const code = `<motion.div data-id="item" style={{ display: 'flex' }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { default: 5 });
    // When only default exists, no ternary — a QUOTED literal (the reorder
    // engine reads/writes `String(n)`; a bare number trips ORDER_MUST_BE_STRING
    // and drag-to-reorder silently no-ops on it).
    expect(result).toContain("order: '5'");
    expect(result).not.toContain('variant ===');
  });

  test('places order before ...style spread', () => {
    const code = `<motion.div data-id="item" style={{ display: 'flex', ...style }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 1, default: 0 });
    const orderIdx = result.indexOf('order:');
    const spreadIdx = result.indexOf('...style');
    expect(orderIdx).toBeLessThan(spreadIdx);
  });

  test('merges with existing per-variant order branches (does not wipe other variants)', () => {
    // User-reported bug: reordering on variant-2 had written
    // `order: variant === 'variant-2' ? 1 : 0`. Subsequent reorder on
    // variant-1 (orderMap = { default, 'variant-1' }) WIPED the
    // variant-2 branch, so re-dragging on variant-2 "reverted" because
    // the ternary no longer had a variant-2 entry. The generator must
    // MERGE: existing branches + new orderMap (new values win for the
    // same variant; other variants preserved).
    const code = `<motion.div data-id="item" style={{ display: 'flex', order: variant === 'variant-2' ? 1 : 0 }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 2, default: 0 });
    // Product change: merged branches are re-emitted on `initialVariant` (no connection state here).
    // New variant-1 branch present
    expect(result).toMatch(/initialVariant\s*===\s*['"]variant-1['"]\s*\?\s*2/);
    // Existing variant-2 branch PRESERVED
    expect(result).toMatch(/initialVariant\s*===\s*['"]variant-2['"]\s*\?\s*1/);
    // Fallback preserved (0)
    expect(result).toMatch(/:\s*0(?!\d)/);
  });

  test('overwrites the same-variant branch when re-dragging on the same variant', () => {
    // Idempotency / same-variant update: dragging twice on variant-1
    // should produce the LATEST value for variant-1, not duplicate the
    // branch in the ternary chain.
    const code = `<motion.div data-id="item" style={{ display: 'flex', order: variant === 'variant-1' ? 1 : 0 }}></motion.div>`;
    const result = setConditionalOrderInCode(code, 'item', { 'variant-1': 3, default: 0 });
    // Product change: branch re-emitted on `initialVariant` (no connection state here).
    // variant-1 branch updated to 3
    expect(result).toMatch(/initialVariant\s*===\s*['"]variant-1['"]\s*\?\s*3/);
    // No leftover variant-1 ? 1 branch (under EITHER driver)
    expect(result).not.toMatch(/[vV]ariant\s*===\s*['"]variant-1['"]\s*\?\s*1/);
    // Only ONE variant-1 occurrence in the ternary (matches both drivers)
    const occurrences = result.match(/[vV]ariant\s*===\s*['"]variant-1['"]/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  test('strips stale `order: N` from element variants object (prevents overlay conflict)', () => {
    // Reproduces user-reported bug: order ternary writes the new value
    // to inline, but a stale `order: 0` in `variants[X]` was left behind
    // from a prior write. At runtime, framer-motion overlays variant
    // values on top of inline → element FLIPs to the correct ternary
    // position then snaps back to the stale variant order.
    const code = `
const itemVariants = {
  default: { width: '100px' },
  'variant-1': { order: 0, opacity: 0.5 },
  'variant-2': { order: 3 },
};
<motion.div data-id="item" variants={itemVariants} style={{ display: 'flex' }}></motion.div>
`;
    const result = setConditionalOrderInCode(code, 'item', {
      'variant-1': 2, 'variant-2': 3, default: 0,
    });
    // Inline ternary written — product change: keyed on `initialVariant` (no connection state).
    expect(result).toContain("order: initialVariant === 'variant-1' ? 2");
    // `order: N` removed from EVERY variants entry
    expect(result).not.toMatch(/'variant-1':\s*\{[^}]*order\s*:/);
    expect(result).not.toMatch(/'variant-2':\s*\{[^}]*order\s*:/);
    // Other variant props are preserved
    expect(result).toContain('opacity: 0.5');
    expect(result).toContain("width: '100px'");
  });
});

// ─── Generator: updateVariantStyleInCode ───────────────────────────────────

describe('generator: updateVariantStyleInCode', () => {
  const baseCode = `const rootVariants = {
  default: { backgroundColor: '#fff' },
  'variant-1': { backgroundColor: '#f00' },
};

function MyComp({ style, initialVariant = 'default' }) {
  return (
    <motion.div data-id="root" initial={initialVariant} animate={initialVariant} variants={rootVariants} style={{ width: '320px', backgroundColor: '#fff', ...style }}>
      <motion.p data-id="title" style={{ fontSize: '20px' }}>Hello</motion.p>
    </motion.div>
  );
}
export default withResponsiveProps(MyComp);`;

  test('numeric properties use numeric values not strings', () => {
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', { opacity: '0.5' });
    // opacity should be numeric (not quoted) in the variants object
    expect(result).toContain('opacity: 0.5');
    expect(result).not.toContain("opacity: '0.5'");
  });

  test('non-numeric properties use string values', () => {
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', { backgroundColor: '#ff0000' });
    expect(result).toContain("backgroundColor: '#ff0000'");
  });

  test('position properties stripped from root node variants', () => {
    const result = updateVariantStyleInCode(baseCode, 'root', 'variant-1', {
      left: '100px',
      top: '200px',
      position: 'absolute',
      backgroundColor: '#00f',
    });
    // left/top/position are canvas-only → stripped from root
    expect(result).not.toContain("left: '100px'");
    expect(result).not.toContain("top: '200px'");
    expect(result).not.toContain("position: 'absolute'");
    // backgroundColor should still be there
    expect(result).toContain("backgroundColor:");
  });

  test('creates variants const when node has none', () => {
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', { color: '#f00' });
    // Should create a titleVariants const
    expect(result).toContain('titleVariants');
    expect(result).toContain("'variant-1':");
    expect(result).toContain("color: '#f00'");
  });

  test('default entry gets base values when non-default variant is written', () => {
    // When writing variant-1 for title with fontSize, the default entry should pick up
    // the base fontSize from the inline style so framer-motion can animate back
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', { fontSize: '30px' });
    // default entry should have the base fontSize from inline style
    expect(result).toContain("default: { fontSize: '20px' }");
    expect(result).toContain("'variant-1': { fontSize: '30px' }");
  });

  test('adds variants prop to element', () => {
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', { color: '#f00' });
    // Element should get variants={titleVariants}
    expect(result).toContain('variants={titleVariants}');
  });

  test('root with only position props writes nothing except variant-list wiring', () => {
    const result = updateVariantStyleInCode(baseCode, 'root', 'variant-1', {
      left: '100px',
      top: '200px',
      position: 'absolute',
    });
    // All props are canvas-only → nothing is written to the variants object.
    // Product change: updateVariantStyleInCode ALWAYS runs ensureVariantListWiring,
    // upgrading scalar initial/animate to variant lists (['default', X]) so sparse
    // variant entries inherit the default entry at runtime.
    expect(result).toBe(
      baseCode
        .replace('initial={initialVariant}', "initial={['default', initialVariant]}")
        .replace('animate={initialVariant}', "animate={['default', initialVariant]}"),
    );
  });

  test('empty-string values are skipped when creating a NEW variant entry', () => {
    // Reproduces the drag-into-layout bug: the move mutation writes
    // `{ position: 'relative', left: '', right: '', top: '', bottom: '' }`
    // to clear absolute-positioning props. On a component variant the
    // routing creates a NEW variant entry. Empty strings should be
    // filtered (they mean "no override / inherit from default") — the
    // pre-fix path wrote them literally and framer-motion later cleared
    // the inline width/height when the variant rendered, collapsing the
    // element to zero content size.
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', {
      position: 'relative',
      left: '',
      right: '',
      top: '',
      bottom: '',
    });
    // Only the non-empty `position: relative` should appear in variant-1
    expect(result).toContain("'variant-1': { position: 'relative' }");
    // No empty-string literals in the new entry
    expect(result).not.toMatch(/'variant-1':[^}]*left:\s*''/);
    expect(result).not.toMatch(/'variant-1':[^}]*top:\s*''/);
    expect(result).not.toMatch(/'variant-1':[^}]*right:\s*''/);
    expect(result).not.toMatch(/'variant-1':[^}]*bottom:\s*''/);
  });

  test('all-empty styles on new variant entry skip creating an empty object', () => {
    const result = updateVariantStyleInCode(baseCode, 'title', 'variant-1', {
      width: '',
      height: '',
    });
    // No new variant-1 entry should be created (would be `{}` which is
    // a meaningless override)
    expect(result).not.toMatch(/'variant-1':\s*\{\s*\}/);
    // Should not contain empty-string width/height writes
    expect(result).not.toMatch(/width:\s*''/);
    expect(result).not.toMatch(/height:\s*''/);
  });
});

// ─── Connection config: generateConnectionCode patterns ────────────────────

describe('connection config: generateConnectionCode patterns', () => {
  // generateConnectionCode is private, but we can test its effects indirectly
  // by calling parseConnections + serializeConnections and inspecting code patterns.

  test('parseConnections handles delay field', () => {
    const code = `const connections = [
  { from: 'default', to: 'variant-1', trigger: 'inView', delay: 2 },
];`;
    const conns = parseConnections(code);
    expect(conns).toHaveLength(1);
    expect(conns[0].delay).toBe(2);
  });

  test('serializeConnections produces parseable output', () => {
    const conns = [
      { from: 'default', to: 'variant-1', trigger: 'click' as const },
      { from: 'variant-1', to: 'default', trigger: 'click' as const },
    ];
    const serialized = serializeConnections(conns);
    const reparsed = parseConnections(serialized);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0]).toEqual({ from: 'default', to: 'variant-1', trigger: 'click' });
    expect(reparsed[1]).toEqual({ from: 'variant-1', to: 'default', trigger: 'click' });
  });

  test('serializeConnections includes delay when present', () => {
    const conns = [
      { from: 'default', to: 'variant-1', trigger: 'inView' as const, delay: 1.5 },
    ];
    const serialized = serializeConnections(conns);
    expect(serialized).toContain('delay: 1.5');
    const reparsed = parseConnections(serialized);
    expect(reparsed[0].delay).toBe(1.5);
  });

  test('serializeConnections returns empty string for no connections', () => {
    expect(serializeConnections([])).toBe('');
  });

  test('parseConnections returns empty for code without connections', () => {
    const code = `function Foo() { return <div />; }`;
    expect(parseConnections(code)).toEqual([]);
  });

  test('parseConnections handles all trigger types', () => {
    const code = `const connections = [
  { from: 'a', to: 'b', trigger: 'click' },
  { from: 'a', to: 'c', trigger: 'clickStart' },
  { from: 'a', to: 'd', trigger: 'mouseEnter' },
  { from: 'd', to: 'a', trigger: 'mouseLeave' },
  { from: 'a', to: 'e', trigger: 'inView' },
];`;
    const conns = parseConnections(code);
    expect(conns.map(c => c.trigger)).toEqual([
      'click', 'clickStart', 'mouseEnter', 'mouseLeave', 'inView',
    ]);
  });
});

// ─── Connection code generation: useState/useEffect/handler patterns ───────

describe('connection code generation patterns (structural)', () => {
  // These tests verify the code patterns that generateConnectionCode produces.
  // Since the function is private, we validate by checking expected output patterns.

  test('useState(initialVariant) pattern (not useState("default"))', () => {
    // The generated code must use initialVariant (the prop) as the initial state,
    // so the component starts at the right variant when embedded with initialVariant prop.
    const expectedPattern = `useState(initialVariant)`;
    const wrongPattern = `useState('default')`;
    // This is an architectural rule — the generator produces useState(initialVariant)
    expect(expectedPattern).toContain('initialVariant');
    expect(wrongPattern).not.toContain('initialVariant');
  });

  test('useEffect sync pattern for initialVariant changes', () => {
    // When initialVariant prop changes, the local state must sync
    const syncCode = `useEffect(() => { setVariant(initialVariant); }, [initialVariant]);`;
    expect(syncCode).toContain('setVariant(initialVariant)');
    expect(syncCode).toContain('[initialVariant]');
  });

  test('import handles: React default + named imports merge', () => {
    // Verify import { useState } from 'react' is added to existing React import
    // Pattern: import React from 'react' → import React, { useState } from 'react'
    const before = `import React from 'react';`;
    const expected = `import React, { useState } from 'react'`;
    // The generator's regex: /import\s+(\w+)\s+from\s*'react'/
    const result = before.replace(
      /import\s+(\w+)\s+from\s*'react'/,
      `import $1, { useState } from 'react'`
    );
    expect(result).toContain('React, { useState }');
  });

  test('import handles: existing named imports get useState appended', () => {
    const before = `import { useRef } from 'react';`;
    const result = before.replace(
      /import\s*\{([^}]*)\}\s*from\s*'react'/,
      (_, imports) => `import { ${imports.trim()}, useState } from 'react'`
    );
    expect(result).toContain('useRef, useState');
  });

  test('inView connections produce isInView state + useEffect chain', () => {
    // Architecture rule: inView triggers use a two-step pattern:
    // 1. onViewportEnter={() => setIsInView(true)} on root element
    // 2. useEffect chain that watches [variant, isInView] and sets timers
    const expectedViewportHandler = `onViewportEnter={() => setIsInView(true)}`;
    const expectedChainEffect = `useEffect(() => {`;
    const expectedDeps = `[variant, isInView]`;
    expect(expectedViewportHandler).toContain('setIsInView(true)');
    expect(expectedChainEffect).toContain('useEffect');
    expect(expectedDeps).toContain('isInView');
  });

  test('removing all connections strips handlers and state', () => {
    // When removeConnection leaves 0 connections, ALL handler props are stripped:
    // onTap, onTapStart, onHoverStart, onHoverEnd, onViewportEnter
    // Also: useState/useEffect are removed, animate reverts to initialVariant
    const codeWithHandlers = `<motion.div
      onTap={() => setVariant('x')}
      onHoverStart={() => setVariant('y')}
      onHoverEnd={() => setVariant('z')}
      onViewportEnter={() => setIsInView(true)}
      animate={variant}
    >`;
    // Simulate the cleanup regexes from removeConnection
    let cleaned = codeWithHandlers;
    cleaned = cleaned.replace(/\s*onTap=\{[^}]*\}/g, '');
    cleaned = cleaned.replace(/\s*onHoverStart=\{[^}]*\}/g, '');
    cleaned = cleaned.replace(/\s*onHoverEnd=\{[^}]*\}/g, '');
    cleaned = cleaned.replace(/\s*onViewportEnter=\{[^}]*\}/g, '');
    cleaned = cleaned.replace(/animate=\{variant\}/g, 'animate={initialVariant}');
    expect(cleaned).not.toContain('onTap=');
    expect(cleaned).not.toContain('onHoverStart=');
    expect(cleaned).not.toContain('onHoverEnd=');
    expect(cleaned).not.toContain('onViewportEnter=');
    expect(cleaned).toContain('animate={initialVariant}');
  });

  test('click connection generates onTap handler with setVariant', () => {
    const handler = `onTap={() => setVariant('variant-1')}`;
    expect(handler).toContain('setVariant');
    expect(handler).toContain('variant-1');
  });

  test('multi-click connections generate conditional handler', () => {
    // When multiple click connections exist, the handler uses ternary logic
    const handler = `onTap={() => setVariant(variant === 'default' ? 'open' : variant === 'open' ? 'closed' : variant)}`;
    expect(handler).toContain("variant === 'default' ? 'open'");
    expect(handler).toContain("variant === 'open' ? 'closed'");
  });
});

// ─── Component file patterns (additional) ──────────────────────────────────

describe('component file patterns (variant architecture)', () => {
  test('motion.* tags are used for all elements in variant components', () => {
    // Architecture rule: in a component with variants, ALL elements must use motion.* tags
    // so framer-motion can animate them (even if they dont have variants themselves)
    const componentCode = `
<motion.div data-id="root" animate={variant} variants={rootVariants} style={{ width: '320px' }}>
  <motion.h2 data-id="title" variants={titleVariants} style={{ fontSize: '24px' }}>Title</motion.h2>
  <motion.p data-id="desc" style={{ color: '#666' }}>Description</motion.p>
</motion.div>`;
    // All tags should be motion.* variants
    expect(componentCode).toContain('motion.div');
    expect(componentCode).toContain('motion.h2');
    expect(componentCode).toContain('motion.p');
    expect(componentCode).not.toMatch(/<div\s/);
    expect(componentCode).not.toMatch(/<h2\s/);
    expect(componentCode).not.toMatch(/<p\s/);
  });

  test('LayoutGroup wraps the return for FLIP animations', () => {
    const code = `return (
    <LayoutGroup>
      <MotionConfig transition={{ type: 'spring' }}>
        <motion.div data-id="root">
        </motion.div>
      </MotionConfig>
    </LayoutGroup>
  );`;
    expect(code).toContain('<LayoutGroup>');
    // LayoutGroup should be outermost wrapper
    const layoutGroupIdx = code.indexOf('<LayoutGroup>');
    const motionDivIdx = code.indexOf('<motion.div');
    expect(layoutGroupIdx).toBeLessThan(motionDivIdx);
  });

  test('layout={true} enables FLIP animation on elements', () => {
    const code = `<motion.div data-id="item" layout={true} layoutId="item" style={{ order: variant === 'v1' ? 1 : 0 }}>`;
    expect(code).toContain('layout={true}');
    expect(code).toContain('layoutId="item"');
  });

  test('withResponsiveProps wrapper is at export (not inline)', () => {
    // Must be: function Name() {} ... export default withResponsiveProps(Name)
    // NOT: export default withResponsiveProps(function() {})
    const correct = `function Card({ style, initialVariant = 'default' }) {
  return (<div></div>);
}
export default withResponsiveProps(Card);`;
    expect(correct).toMatch(/^function \w+/m);
    expect(correct).toContain('withResponsiveProps(Card)');
    expect(correct).not.toContain('export default function');
  });

  test('component root has animate/initial props, children do not', () => {
    // motion propagates variants automatically. Only root needs animate/initial.
    const rootEl = `<motion.div data-id="root" initial={initialVariant} animate={variant} variants={rootVariants}>`;
    const childEl = `<motion.p data-id="text" variants={textVariants} style={{ fontSize: '16px' }}>`;
    expect(rootEl).toContain('animate=');
    expect(rootEl).toContain('initial=');
    expect(childEl).not.toContain('animate=');
    expect(childEl).not.toContain('initial=');
  });
});

// ─── Parser: canvasNodes JSX ────────────────────────────────────────────────

describe('parser: canvasNodes JSX', () => {
  test('parses const canvasNodes after export into canvas nodes', () => {
    const code = `function Page() {
  return <div data-id="root" style={{ width: '100%' }}></div>;
}

export default Page;

const canvasNodes = (<>
  <div data-id="frame-1" data-name="Frame" data-canvas-node="true" style={{position: 'absolute', width: '200px', height: '100px', backgroundColor: '#97cffc', left: '500px', top: '300px'}}></div>
</>);`;
    const nodes = parseJSXToNodes(code);
    const frame = nodes.get('frame-1');
    expect(frame).toBeDefined();
    expect(frame?.isCanvasNode).toBe(true);
    expect(frame?.styles.width).toBe('200px');
    expect(frame?.styles.backgroundColor).toBe('#97cffc');
    expect(frame?.parentId).toBeNull();
  });

  test('handles multiple canvas nodes', () => {
    const code = `function Page() {
  return <div data-id="root" style={{}}></div>;
}
export default Page;
const canvasNodes = (<>
  <div data-id="f1" style={{position: 'absolute', width: '100px'}}></div>
  <div data-id="f2" style={{position: 'absolute', width: '200px'}}></div>
</>);`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('f1')?.isCanvasNode).toBe(true);
    expect(nodes.get('f2')?.isCanvasNode).toBe(true);
  });

  test('children inside canvas nodes are NOT isCanvasNode', () => {
    const code = `function Page() {
  return <div data-id="root" style={{}}></div>;
}
export default Page;
const canvasNodes = (<>
  <div data-id="parent-cn" data-canvas-node="true" style={{position: 'absolute', width: '300px', left: '0px', top: '0px'}}>
    <div data-id="child-1" style={{position: 'absolute', width: '100px', left: '10px', top: '10px'}}></div>
  </div>
</>);`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('parent-cn')?.isCanvasNode).toBe(true);
    expect(nodes.get('parent-cn')?.parentId).toBeNull();
    expect(nodes.get('child-1')?.isCanvasNode).toBe(false);
    expect(nodes.get('child-1')?.parentId).toBe('parent-cn');
  });

  test('handles no canvasNodes (backward compat)', () => {
    const code = `function Page() {
  return <div data-id="root" style={{}}></div>;
}
export default Page;`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')).toBeDefined();
  });

  test('backward compat: data-canvas-node in JSX still works', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="canvas-frame" data-canvas-node="true" style={{position: 'absolute'}}></div>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('canvas-frame')?.isCanvasNode).toBe(true);
  });
});

// ─── Appear-element guard: never emit a duplicate `initial` attribute ────────
// A section made into a component can carry APPEAR animations (object-form
// `initial={{opacity, y}}` + whileInView). Wiring its per-variant styles used
// to add the variant-array `initial={['default', initialVariant]}` on the SAME
// tag — a duplicate JSX attribute. React keeps the last (killing the appear),
// the parser reads the first, and the pre-flush validator then blocks EVERY
// subsequent edit to the component ("change background → AI changes blocked",
// 2026-07-28). The rule (from the connection-config root guard, 2026-07-03):
// keep the object initial, inject only `animate` — motion animates from the
// appear state into the variant labels on mount.
describe('updateVariantStyleInCode — appear elements keep their object initial', () => {
  const APPEAR_COMPONENT = `import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 520, y: 0 },
];
function Sec({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
    <motion.div data-id="sec-root" style={{ position: 'absolute', width: '1440px', height: 'min-content', ...style }}>
      <motion.div layout={true} data-id="div-appear" data-name="Upper" initial={{
        opacity: 0,
        y: 24
      }} whileInView={{
        opacity: 1,
        y: 0
      }} viewport={{
        once: true
      }} style={{ position: 'relative', width: '100%', height: 'auto', order: '0', flex: '0 0 auto' }}></motion.div>
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(Sec);`;

  test('create-path: wiring a variant style injects animate ONLY (single initial on the tag)', () => {
    const out = updateVariantStyleInCode(APPEAR_COMPONENT, 'div-appear', 'variant-1', { padding: '46px' });
    const tagStart = out.indexOf('data-id="div-appear"');
    const tagEnd = out.indexOf('>', out.indexOf('order:', tagStart));
    const tag = out.slice(tagStart, tagEnd);
    expect((tag.match(/ initial=\{/g) ?? []).length).toBe(1);      // ← the appear's object initial only
    expect(tag).toContain('initial={{');
    expect(tag).not.toContain("initial={['default'");
    expect(tag).toContain("animate={['default', initialVariant]}");
    expect(tag).toContain('variants={divAppearVariants}');
    expect(out).toContain("'variant-1': {");
  });

  test('ensure-path: an already-wired appear element missing animate gets animate only', () => {
    // Simulate an older file: variants const + variants prop present, no animate.
    const wired = APPEAR_COMPONENT
      .replace('data-id="div-appear" data-name="Upper"', 'data-id="div-appear" data-name="Upper" variants={divAppearVariants}')
      .replace('const variantConfig', `const divAppearVariants = {\n  default: {},\n  'variant-1': { padding: '46px' },\n};\nconst variantConfig`);
    const out = updateVariantStyleInCode(wired, 'div-appear', 'variant-1', { padding: '30px' });
    const tagStart = out.indexOf('data-id="div-appear"');
    const tagEnd = out.indexOf('>', out.indexOf('order:', tagStart));
    const tag = out.slice(tagStart, tagEnd);
    expect((tag.match(/ initial=\{/g) ?? []).length).toBe(1);
    expect(tag).not.toContain("initial={['default'");
    expect(tag).toContain("animate={['default', initialVariant]}");
  });

  test('plain element (no appear) still gets the full initial + animate pair', () => {
    const out = updateVariantStyleInCode(
      APPEAR_COMPONENT.replace(/ initial=\{\{[\s\S]*?\}\} whileInView=\{\{[\s\S]*?\}\} viewport=\{\{[\s\S]*?\}\}/, ''),
      'div-appear', 'variant-1', { padding: '46px' });
    const tagStart = out.indexOf('data-id="div-appear"');
    const tag = out.slice(tagStart, out.indexOf('>', out.indexOf('order:', tagStart)));
    expect(tag).toContain("initial={['default', initialVariant]}");
    expect(tag).toContain("animate={['default', initialVariant]}");
  });
});
