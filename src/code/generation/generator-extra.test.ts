import { describe, test, expect, beforeEach } from 'vitest';
import {
  removeNodeInCode,
  updateNodeInCode,
} from './generator-crud';
import {
  updateVariantStyleInCode,
  rewriteContainerBreakpoints,
  rewriteResponsiveBreakpoints,
  rewriteResponsiveTextBreakpoints,
  resolveResizedKeys,
  addResponsiveBreakpoint,
  removeResponsiveBreakpoint,
} from './generator-styles';
import {
  updateKeyframesInCode,
  removeKeyframesFromCode,
  updateMotionPropInCode,
  removeMotionPropFromCode,
  updateVariantEntryTransition,
  updateMotionConfigTransition,
  readTransitionVarRef,
  setElementTransitionVar,
  setVariantTransitionPropVar,
  setMotionConfigBaseVar,
  revertVariantTransition,
  formatTransitionObj,
} from './generator-motion';
import { parseJSXToNodes } from '../parsing/parser';
import { syncViewportWidths } from '../stores/viewport-store';

// ─── removeNodeInCode ────────────────────────────────────────────────────────

describe('removeNodeInCode', () => {
  test('removes a simple element with text', () => {
    const code = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="x" style={{width: '100px', height: '50px'}}>text</div>
</div>`;
    const result = removeNodeInCode(code, 'x');
    expect(result).not.toContain('data-id="x"');
    expect(result).toContain('data-id="root"');
  });

  test('removes a self-closing element', () => {
    const code = `<div data-id="root" style={{position: 'relative'}}>
  <img data-id="x" style={{width: '100px'}} />
  <div data-id="keep" style={{width: '50px'}}></div>
</div>`;
    const result = removeNodeInCode(code, 'x');
    expect(result).not.toContain('data-id="x"');
    expect(result).toContain('data-id="keep"');
  });

  test('removes a variant-solo child WITH its AnimatePresence + conditional wrapper (no dangling &&)', () => {
    // Regression: deleting a variant-solo child left `{variant === 'X' && }` →
    // `Unexpected token` → babel rejected the mutation → delete blocked.
    const code = `<motion.div data-id="root" animate={variant}>
    <AnimatePresence mode="popLayout">{variant === "variant-1" && <motion.div data-id="solo" variants={soloVariants} initial={initialVariant} style={{ width: '270px' }} key="solo" data-replica-solo="variant-1" animate={variant}></motion.div>}</AnimatePresence>
  </motion.div>`;
    const result = removeNodeInCode(code, 'solo');
    expect(result).not.toContain('data-id="solo"');
    // Whole conditional + AnimatePresence wrapper gone — no dangling tokens.
    expect(result).not.toContain('&&');
    expect(result).not.toContain('AnimatePresence');
    expect(result).toContain('data-id="root"');
  });

  test('removes a SELF-CLOSING variant-solo child with its conditional wrapper', () => {
    const code = `<motion.div data-id="root">
    <AnimatePresence mode="popLayout">{variant !== "variant-2" && <Comp data-id="solo" data-replica-solo="variant-1" />}</AnimatePresence>
  </motion.div>`;
    const result = removeNodeInCode(code, 'solo');
    expect(result).not.toContain('data-id="solo"');
    expect(result).not.toContain('&&');
    expect(result).not.toContain('AnimatePresence');
    expect(result).toContain('data-id="root"');
  });

  test('removes element with children but preserves siblings', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="parent" style={{}}>
    <p data-id="child" style={{}}>Hello</p>
  </div>
  <div data-id="sibling" style={{}}>Keep me</div>
</div>`;
    const result = removeNodeInCode(code, 'parent');
    expect(result).not.toContain('data-id="parent"');
    expect(result).not.toContain('data-id="child"');
    expect(result).toContain('data-id="sibling"');
    expect(result).toContain('data-id="root"');
  });

  test('removes element in middle of siblings', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="a" style={{}}>A</div>
  <div data-id="b" style={{}}>B</div>
  <div data-id="c" style={{}}>C</div>
</div>`;
    const result = removeNodeInCode(code, 'b');
    expect(result).not.toContain('data-id="b"');
    expect(result).toContain('data-id="a"');
    expect(result).toContain('data-id="c"');
    // Verify node tree still parses correctly
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('root')!.children).toContain('a');
    expect(nodes.get('root')!.children).toContain('c');
    expect(nodes.get('root')!.children).not.toContain('b');
  });

  test('no-op for non-existent node ID', () => {
    const code = `<div data-id="root" style={{}}><div data-id="a" style={{}}>A</div></div>`;
    const result = removeNodeInCode(code, 'nonexistent');
    expect(result).toBe(code);
  });

  test('removes JSX element even when data-id appears in CSS @media rules', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 1440px) {
      [data-id="myframe"] { display: none !important; }
    }
    @media (max-width: 768px) {
      [data-id="myframe"] { display: none !important; }
    }
  \`}</style>
  <div data-id="hero" style={{width: '100%'}}>Hero</div>
  <div data-id="myframe" style={{position: 'relative', width: '300px'}}>
    <p data-id="child">Content</p>
  </div>
</div>;
}`;
    const result = removeNodeInCode(code, 'myframe');
    // JSX element must be removed
    expect(result).not.toMatch(/<div data-id="myframe"/);
    expect(result).not.toContain('data-id="child"');
    // CSS references are cleaned up too
    expect(result).not.toContain('[data-id="myframe"]');
    // Other elements preserved
    expect(result).toContain('data-id="hero"');
    expect(result).toContain('data-id="root"');
  });
});

// ─── updateNodeInCode — inline transform → motion props (motion.* only) ─────

describe('updateNodeInCode — transform on motion vs plain elements', () => {
  test('motion.* element: transform: rotate() → rotate prop + clears transform', () => {
    const code = `<motion.div data-id="bar" style={{ position: 'absolute', transform: 'rotate(27deg)' }}></motion.div>`;
    const out = updateNodeInCode(code, 'bar', { transform: 'rotate(40deg)' });
    expect(out).toMatch(/rotate:\s*["']?40["']?/);
    expect(out).not.toContain('rotate(40deg)');       // old CSS transform gone
  });

  test('plain element: transform stays as CSS (page nodes are not motion)', () => {
    const code = `<div data-id="bar" style={{ position: 'absolute' }}></div>`;
    const out = updateNodeInCode(code, 'bar', { transform: 'rotate(40deg)' });
    expect(out).toContain('rotate(40deg)');           // kept as CSS transform
    expect(out).not.toMatch(/[^(]rotate:\s*["']?40/); // not converted to a motion prop
  });
});

// ─── updateNodeInCode — CSS collision fallback ──────────────────────────────

describe('updateNodeInCode — CSS collision with data-id in @media', () => {
  test('updates JSX element styles when data-id appears in CSS @media rules first', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 1440px) {
      [data-id="myframe"] { display: none !important; }
    }
    @media (max-width: 768px) {
      [data-id="myframe"] { display: none !important; }
    }
  \`}</style>
  <div data-id="hero" style={{width: '100%'}}>Hero</div>
  <div data-id="myframe" style={{position: 'relative', width: '300px'}}>
    <p data-id="child">Content</p>
  </div>
</div>;
}`;
    const result = updateNodeInCode(code, 'myframe', { color: 'red' });
    // The JSX element should now have color (AST path may use double quotes)
    expect(result).toMatch(/color:\s*["']red["']/);
    // Original styles should be preserved
    expect(result).toMatch(/position:\s*["']relative["']/);
    expect(result).toMatch(/width:\s*["']300px["']/);
    // CSS rules should be unchanged
    expect(result).toContain('[data-id="myframe"]');
    expect(result).toContain('@media (max-width: 1440px)');
    // Other elements preserved
    expect(result).toContain('data-id="hero"');
    expect(result).toContain('data-id="root"');
  });

  test('updates existing style property when data-id appears in CSS first', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="box"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="box" style={{width: '300px', height: '200px'}}>Content</div>
</div>;
}`;
    const result = updateNodeInCode(code, 'box', { width: '500px' });
    // The JSX element should have updated width (fast path finds CSS first, falls to AST)
    expect(result).toMatch(/width:\s*["']500px["']/);
    // Height should be preserved
    expect(result).toMatch(/height:\s*["']200px["']/);
    // CSS rule should be unchanged
    expect(result).toContain('[data-id="box"]');
  });

  test('updates single-line element with CSS @media on earlier lines', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="myframe"] { left: 370px !important; top: 128px !important; }
    }
  \`}</style>
    <p data-id="heading" style={{position: "absolute", fontSize: '32px', left: '70px', top: '54px'}}>Page 3</p>
    <div data-id="myframe" data-name="Frame" style={{position: 'absolute', width: '173px', height: '173px', left: '210px', top: '248px'}}></div>
</div>;
}`;
    const result = updateNodeInCode(code, 'myframe', { left: '89px', top: '65px' });
    // The frame's inline position must be updated
    expect(result).toContain("left: '89px'");
    expect(result).toContain("top: '65px'");
    // The frame must NOT still have old position
    expect(result).not.toContain("left: '210px'");
    expect(result).not.toContain("top: '248px'");
    // Heading must NOT be affected
    expect(result).toContain("left: '70px'"); // heading unchanged
    // CSS must be unchanged
    expect(result).toContain('left: 370px !important');
  });

  test('element with MANY attributes — long gap between data-id and style={{', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="card"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="card" data-name="Feature Card" className="card-primary" onClick={handleClick} onMouseEnter={onHover} aria-label="Feature card component" role="article" tabIndex={0} style={{position: 'absolute', width: '400px', height: '300px', left: '100px', top: '50px'}}>
    <p data-id="title" style={{fontSize: '24px'}}>Title</p>
  </div>
</div>;
}`;
    const result = updateNodeInCode(code, 'card', { width: '500px', left: '200px' });
    // The JSX element should have updated properties
    expect(result).toContain("width: '500px'");
    expect(result).toContain("left: '200px'");
    // Old values must be gone
    expect(result).not.toMatch(/width:\s*['"]400px['"]/);
    expect(result).not.toMatch(/left:\s*['"]100px['"]/);
    // Other attributes preserved
    expect(result).toContain('data-name="Feature Card"');
    expect(result).toContain('aria-label="Feature card component"');
    // Height preserved
    expect(result).toContain("height: '300px'");
    // CSS rule unchanged
    expect(result).toContain('[data-id="card"]');
    expect(result).toContain('width: 100% !important');
  });

  test('CSS block with template literal backticks containing > characters', () => {
    // The backtick ` starts a template literal inside {`...`}. The same-tag detection
    // must NOT treat > inside backtick-delimited content as a tag close.
    // In our CSS style blocks, the outer structure is {\`...\`} where backticks
    // delimit CSS. A > inside CSS selectors (like child combinators) must not
    // confuse the same-tag check.
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="panel"] > .inner { display: flex !important; }
      [data-id="panel"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="panel" style={{position: 'absolute', width: '300px', height: '200px'}}>
    <div className="inner">Content</div>
  </div>
</div>;
}`;
    const result = updateNodeInCode(code, 'panel', { width: '500px' });
    // Must update the JSX element, not fail
    expect(result).toContain("width: '500px'");
    expect(result).not.toMatch(/width:\s*['"]300px['"]/);
    // CSS rules preserved (including the > child combinator)
    expect(result).toContain('[data-id="panel"] > .inner');
    expect(result).toContain('width: 100% !important');
    // Height preserved
    expect(result).toContain("height: '200px'");
  });

  test('multiple @media rules for the same data-id across different breakpoints', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 1440px) {
      [data-id="sidebar"] { left: 900px !important; width: 300px !important; }
    }
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="sidebar"] { left: 0px !important; width: 100% !important; top: auto !important; }
    }
    @media (max-width: 375px) {
      [data-id="sidebar"] { display: none !important; }
    }
  \`}</style>
  <div data-id="main" style={{width: '100%'}}>Main</div>
  <div data-id="sidebar" style={{position: 'absolute', width: '250px', height: '600px', left: '1000px', top: '0px'}}>
    <p data-id="sidebar-title" style={{fontSize: '18px'}}>Sidebar</p>
  </div>
</div>;
}`;
    const result = updateNodeInCode(code, 'sidebar', { width: '280px', left: '1100px' });
    // JSX element updated
    expect(result).toContain("width: '280px'");
    expect(result).toContain("left: '1100px'");
    // Old JSX values gone
    expect(result).not.toMatch(/width:\s*['"]250px['"]/);
    expect(result).not.toMatch(/left:\s*['"]1000px['"]/);
    // All three CSS breakpoint rules preserved
    expect(result).toContain('@media (max-width: 1440px)');
    expect(result).toContain('@media (max-width: 768px)');
    expect(result).toContain('@media (max-width: 375px)');
    expect(result).toContain('left: 900px !important');
    expect(result).toContain('width: 100% !important');
    expect(result).toContain('display: none !important');
    // Height and other styles preserved
    expect(result).toContain("height: '600px'");
    expect(result).toContain("top: '0px'");
    // Children preserved
    expect(result).toContain('data-id="sidebar-title"');
  });

  test('element immediately after </style> closing tag', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="banner"] { height: 200px !important; }
    }
  \`}</style><div data-id="banner" style={{position: 'absolute', width: '100%', height: '400px'}}>Banner</div>
</div>;
}`;
    const result = updateNodeInCode(code, 'banner', { height: '350px' });
    // JSX element updated despite being right after </style>
    expect(result).toContain("height: '350px'");
    expect(result).not.toMatch(/height:\s*['"]400px['"]/);
    // CSS preserved
    expect(result).toContain('height: 200px !important');
    // Width preserved
    expect(result).toContain("width: '100%'");
  });

  test('element with JSX expression attributes like onClick={() => {}} between data-id and style', () => {
    // The {} in onClick={() => {}} could confuse brace counting — but the
    // same-tag check only looks for unquoted `>`, not brace depth.
    // The `>` inside `() => {}` is actually `=>`, which contains `>`.
    // But it's preceded by `=`, so it's `=>` not a closing tag `>`.
    // Actually the char scan treats every `>` as a potential close.
    // The arrow `=>` has a `>` that is NOT a closing tag.
    // The same-tag check must handle this correctly.
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="btn"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="btn" onClick={() => { console.log('click'); }} onMouseEnter={() => {}} style={{position: 'absolute', width: '200px', height: '50px'}}>Click me</div>
</div>;
}`;
    const result = updateNodeInCode(code, 'btn', { width: '250px' });
    // NOTE: The `>` in `=>` causes the fast path to skip this occurrence
    // (it thinks the `>` closes the tag). The AST fallback handles it correctly.
    // The AST path may use double quotes for values, so match both.
    expect(result).toMatch(/width:\s*["']250px["']/);
    expect(result).not.toMatch(/width:\s*['"]200px['"]/);
    // Height preserved
    expect(result).toMatch(/height:\s*["']50px["']/);
    // CSS preserved
    expect(result).toContain('[data-id="btn"]');
    expect(result).toContain('width: 100% !important');
  });

  test('removing a property (empty string value) when CSS collision exists', () => {
    const code = `export default function Page() {
  return <div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) {
      [data-id="card"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="card" style={{position: 'absolute', width: '300px', height: '200px', borderRadius: '8px'}}>
    <p data-id="text" style={{fontSize: '16px'}}>Hello</p>
  </div>
</div>;
}`;
    const result = updateNodeInCode(code, 'card', { borderRadius: '' });
    // borderRadius must be removed from the JSX element
    expect(result).not.toContain('borderRadius');
    // Other styles preserved
    expect(result).toMatch(/position:\s*["']absolute["']/);
    expect(result).toMatch(/width:\s*["']300px["']/);
    expect(result).toMatch(/height:\s*["']200px["']/);
    // CSS rule unchanged
    expect(result).toContain('[data-id="card"]');
    expect(result).toContain('width: 100% !important');
    // Children preserved
    expect(result).toContain('data-id="text"');
  });
});

// ─── updateVariantStyleInCode ────────────────────────────────────────────────

describe('updateVariantStyleInCode', () => {
  const CODE_WITH_VARIANTS = `export default function Page() {
const boxVariants = {
  default: {},
  hover: { opacity: '0.8', scale: '1.1' },
};

return (
  <div data-id="root" style={{position: 'relative'}}>
    <motion.div data-id="box" variants={boxVariants} style={{width: '100px'}}></motion.div>
  </div>
);
}`;

  test('updates existing variant entry properties', () => {
    const result = updateVariantStyleInCode(CODE_WITH_VARIANTS, 'box', 'hover', { opacity: '0.5' });
    // The hover variant should now have opacity 0.5
    expect(result).toContain("opacity: 0.5");
    // scale should remain (non-numeric stays quoted)
    expect(result).toContain("scale: '1.1'");
  });

  test('creates new variant entry with auto-created variants object and motion.* conversion', () => {
    const code = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <div data-id="card" style={{width: '200px'}}>Hello</div>
  </div>
);
}`;
    const result = updateVariantStyleInCode(code, 'card', 'hover', { opacity: '0.8', scale: '1.05' });
    // Should create a variants const
    expect(result).toContain('cardVariants');
    // Should convert <div to <motion.div
    expect(result).toContain('<motion.div data-id="card"');
    // Should add variants prop
    expect(result).toContain('variants={cardVariants}');
    // Should contain the variant values
    expect(result).toContain("opacity: 0.8");
    expect(result).toContain("scale: 1.05");
  });

  test('adds framer-motion import when not present', () => {
    const code = `export default function Page() {
return (
  <div data-id="root" style={{position: 'relative'}}>
    <div data-id="btn" style={{width: '100px'}}>Click</div>
  </div>
);
}`;
    const result = updateVariantStyleInCode(code, 'btn', 'active', { scale: '0.95' });
    expect(result).toContain("import { motion } from 'framer-motion'");
  });

  test('handles variant names with hyphens (quoted keys)', () => {
    const code = `export default function Page() {
const navVariants = {
  default: {},
};

return (
  <div data-id="root" style={{position: 'relative'}}>
    <motion.div data-id="nav" variants={navVariants} style={{width: '100px'}}></motion.div>
  </div>
);
}`;
    const result = updateVariantStyleInCode(code, 'nav', 'variant-1', { opacity: '0' });
    // Should create a quoted key entry
    expect(result).toContain("'variant-1'");
    expect(result).toContain("opacity: 0");
  });

  // ─── Component-instance routing ─────────────────────────────────────────────
  // PascalCase tags don't accept framer-motion's `variants` prop and CAN'T be
  // converted to `motion.<ComponentName>` (the proxy only handles HTML tags
  // — `motion.RoFeWe` falls through to `<rofewe>` HTML, which makes the
  // nested instance disappear from preview). For these we must write per-
  // parent-variant style overrides as inline JSX ternaries.

  test('component instance: writes inline ternary in style on non-default variant', () => {
    const code = `function QiZoDu({ style, initialVariant = 'default' }) {
  return (
    <motion.div data-id="parent" style={{ position: 'absolute' }}>
      <RoFeWe data-id="child" style={{ position: 'absolute', left: '53px', top: '42px' }} />
    </motion.div>
  );
}`;
    const result = updateVariantStyleInCode(code, 'child', 'variant-1', { left: '178px', top: '110px' });
    // Tag stays as RoFeWe (NOT motion.RoFeWe) — that would render as <rofewe> HTML
    expect(result).toContain('<RoFeWe data-id="child"');
    expect(result).not.toContain('motion.RoFeWe');
    // No variants={...} prop added — RoFeWe wouldn't forward it anyway
    expect(result).not.toContain('childVariants');
    expect(result).not.toContain('variants={');
    // Inline ternary written for left/top
    expect(result).toContain("left: initialVariant === 'variant-1' ? '178px' : '53px'");
    expect(result).toContain("top: initialVariant === 'variant-1' ? '110px' : '42px'");
  });

  test('component instance: appends prop when style had no entry for it', () => {
    const code = `function Foo({ style, initialVariant = 'default' }) {
  return (
    <RoFeWe data-id="child" style={{ position: 'absolute' }} />
  );
}`;
    const result = updateVariantStyleInCode(code, 'child', 'variant-1', { left: '178px' });
    expect(result).toContain('<RoFeWe data-id="child"');
    expect(result).toContain("left: initialVariant === 'variant-1' ? '178px' : ''");
  });

  test('component instance: writing default branch updates existing literal', () => {
    const code = `function Foo({ style, initialVariant = 'default' }) {
  return (
    <RoFeWe data-id="child" style={{ left: '53px' }} />
  );
}`;
    const result = updateVariantStyleInCode(code, 'child', 'default', { left: '99px' });
    expect(result).toContain("left: '99px'");
    // No ternary needed when only default branch present
    expect(result).not.toContain('initialVariant ===');
  });

  test('component instance: existing ternary is updated per-variant', () => {
    const code = `function Foo({ style, initialVariant = 'default' }) {
  return (
    <RoFeWe data-id="child" style={{ left: initialVariant === 'variant-1' ? '178px' : '53px' }} />
  );
}`;
    const result = updateVariantStyleInCode(code, 'child', 'variant-1', { left: '200px' });
    expect(result).toContain("left: initialVariant === 'variant-1' ? '200px' : '53px'");
  });

  test('component instance: uses `variant` when parent has useState(initialVariant)', () => {
    // When the parent has connections the runtime variant is `variant`
    // (from `useState(initialVariant)`) — the ternary must key off that.
    const code = `function Foo({ style, initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  return (
    <RoFeWe data-id="child" style={{ position: 'absolute' }} />
  );
}`;
    const result = updateVariantStyleInCode(code, 'child', 'variant-1', { left: '50px' });
    expect(result).toContain("left: variant === 'variant-1' ? '50px' : ''");
  });
});

// ─── updateKeyframesInCode / removeKeyframesFromCode ─────────────────────────

describe('updateKeyframesInCode', () => {
  const CODE_WITH_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
      <style>{\`
    @media (max-width: 768px) {
      [data-id="box"] { width: 100% !important; }
    }
      \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;

  const CODE_NO_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;

  test('creates keyframes in existing style block', () => {
    const keyframeCSS = `@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}`;
    const result = updateKeyframesInCode(CODE_WITH_STYLE, 'fadeIn', keyframeCSS);
    expect(result).toContain('@keyframes fadeIn');
    expect(result).toContain('from { opacity: 0; }');
    expect(result).toContain('to { opacity: 1; }');
    // Original container rules should still be present
    expect(result).toContain('@media (max-width: 768px)');
  });

  test('creates style block when none exists', () => {
    const keyframeCSS = `@keyframes slideIn {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}`;
    const result = updateKeyframesInCode(CODE_NO_STYLE, 'slideIn', keyframeCSS);
    expect(result).toContain('<style>');
    expect(result).toContain('@keyframes slideIn');
    expect(result).toContain('transform: translateX(-100%)');
  });

  test('updates existing keyframes', () => {
    const codeWithKeyframes = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
      <style>{\`
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
      \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;
    const newKeyframeCSS = `@keyframes fadeIn {
  0% { opacity: 0; transform: scale(0.9); }
  100% { opacity: 1; transform: scale(1); }
}`;
    const result = updateKeyframesInCode(codeWithKeyframes, 'fadeIn', newKeyframeCSS);
    // Should have the new version, not the old
    expect(result).toContain('transform: scale(0.9)');
    expect(result).not.toContain('from { opacity: 0; }');
  });
});

describe('removeKeyframesFromCode', () => {
  test('removes keyframes from style block', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
      <style>{\`
    @media (max-width: 768px) {
      [data-id="box"] { width: 100% !important; }
    }
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
      \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;
    const result = removeKeyframesFromCode(code, 'fadeIn');
    expect(result).not.toContain('@keyframes fadeIn');
    // Container rules should be preserved
    expect(result).toContain('@media (max-width: 768px)');
    // Still has style block
    expect(result).toContain('<style>');
  });
});

// ─── updateMotionPropInCode / removeMotionPropFromCode ───────────────────────

describe('updateMotionPropInCode', () => {
  test('adds new motion prop to non-motion element', () => {
    const code = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="box" style={{width: '100px', height: '100px'}}>Hello</div>
</div>`;
    const result = updateMotionPropInCode(code, 'box', 'whileHover', { scale: '1.1', opacity: '0.8' });
    // Should convert to motion.div
    expect(result).toContain('motion.div');
    // Should add framer-motion import
    expect(result).toContain("from 'framer-motion'");
    // Should add whileHover prop
    expect(result).toContain('whileHover=');
    expect(result).toContain('scale: 1.1');
    // 0.8 is numeric, so it won't be quoted
    expect(result).toContain('opacity: 0.8');
  });

  test('updates existing motion prop', () => {
    const code = `import { motion } from 'framer-motion';
<div data-id="root" style={{position: 'relative'}}>
  <motion.div data-id="box" whileHover={{ scale: 1.1 }} style={{width: '100px'}}>Hello</motion.div>
</div>`;
    const result = updateMotionPropInCode(code, 'box', 'whileHover', { scale: '1.2', y: '-5' });
    // The new prop should replace the old
    expect(result).toContain('whileHover=');
    expect(result).toContain('scale: 1.2');
    // Should not duplicate the import
    const importCount = (result.match(/from 'framer-motion'/g) || []).length;
    expect(importCount).toBe(1);
  });

  test('handles element that is already motion.*', () => {
    const code = `import { motion } from 'framer-motion';
<div data-id="root" style={{position: 'relative'}}>
  <motion.div data-id="box" style={{width: '100px'}}>Hello</motion.div>
</div>`;
    const result = updateMotionPropInCode(code, 'box', 'whileTap', { scale: '0.95' });
    // Should NOT double-convert to motion.motion.div
    expect(result).not.toContain('motion.motion');
    expect(result).toContain('motion.div');
    expect(result).toContain('whileTap=');
    expect(result).toContain('scale: 0.95');
  });

  // ─── Component-instance routing ─────────────────────────────────────────────
  // PascalCase tags (component instances) can't be `motion.*`. Setting a
  // `transition` directly on `<MoJiBa>` is silently ignored at runtime —
  // we wrap with `<MotionConfig>` so the transition propagates to motion
  // descendants instead. Non-transition motion props are skipped on a
  // component instance because they have no effect on a regular React
  // component.

  test('component instance + transition: wraps in <MotionConfig> instead of breaking the tag', () => {
    const code = `import { motion } from 'framer-motion';
import MoJiBa from '@/components/MoJiBa';
function Foo() {
  return (
    <motion.div data-id="root" style={{ position: 'relative' }}>
      <MoJiBa data-id="child" style={{ position: 'absolute' }} />
    </motion.div>
  );
}`;
    const result = updateMotionPropInCode(code, 'child', 'transition', { type: 'spring', duration: '0.5', bounce: '0.25' });
    // Tag stays as MoJiBa — NOT motion.mojiba (would render as <mojiba>)
    expect(result).toContain('<MoJiBa data-id="child"');
    expect(result).not.toContain('motion.mojiba');
    expect(result).not.toContain('motion.MoJiBa');
    // MotionConfig wrapper around the instance
    expect(result).toMatch(/<MotionConfig\s+transition=\{\{[^}]*type:\s*'spring'[^}]*duration:\s*0\.5[^}]*\}\}>/);
    expect(result).toContain('</MotionConfig>');
    // MotionConfig is added to the framer-motion import
    expect(result).toMatch(/import\s*\{[^}]*MotionConfig[^}]*\}\s*from\s*['"]framer-motion['"]/);
  });

  test('component instance + transition update: replaces existing MotionConfig wrapper', () => {
    const code = `import { motion, MotionConfig } from 'framer-motion';
import MoJiBa from '@/components/MoJiBa';
function Foo() {
  return (
    <motion.div data-id="root" style={{ position: 'relative' }}>
      <MotionConfig transition={{ type: 'spring', duration: 0.3 }}>
        <MoJiBa data-id="child" style={{ position: 'absolute' }} />
      </MotionConfig>
    </motion.div>
  );
}`;
    const result = updateMotionPropInCode(code, 'child', 'transition', { type: 'spring', duration: '0.8' });
    // Old wrapper is updated, not duplicated
    const wrapperCount = (result.match(/<MotionConfig\s+transition=/g) || []).length;
    expect(wrapperCount).toBe(1);
    expect(result).toContain('duration: 0.8');
    expect(result).not.toContain('duration: 0.3');
  });

  test('component instance + non-transition motion prop: silently skipped (no breakage)', () => {
    const code = `import MoJiBa from '@/components/MoJiBa';
function Foo() {
  return (
    <MoJiBa data-id="child" style={{ position: 'absolute' }} />
  );
}`;
    const result = updateMotionPropInCode(code, 'child', 'whileHover', { scale: '1.1' });
    // Tag preserved
    expect(result).toContain('<MoJiBa data-id="child"');
    // No motion.mojiba breakage
    expect(result).not.toContain('motion.mojiba');
    // No whileHover prop added (would be silently ignored anyway)
    expect(result).not.toContain('whileHover');
  });
});

// ─── updateMotionConfigTransition: return-form variants ─────────────────────
// The codegen emits component files using `return <LayoutGroup>...` (no
// parens). The legacy writer only handled the parens form, so transition
// writes silently no-op'd on real component files. Verify both shapes
// wrap correctly.

describe('updateMotionConfigTransition: return shapes', () => {
  test('wraps inside LayoutGroup when return uses no parens', () => {
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
function Foo({ initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div data-id="root" animate={initialVariant} style={{}} />
  </LayoutGroup>;
}
export default Foo;`;
    const result = updateMotionConfigTransition(code, { type: 'spring', duration: '3.65', bounce: '0.2' });
    expect(result).toMatch(/<MotionConfig\s+transition=\{\{[^}]*type:\s*'spring'[^}]*duration:\s*3\.65[^}]*\}\}>/);
    expect(result).toContain('</MotionConfig>');
    // Must live INSIDE LayoutGroup, not around it
    const layoutOpen = result.indexOf('<LayoutGroup>');
    const motionConfigOpen = result.indexOf('<MotionConfig');
    const motionConfigClose = result.indexOf('</MotionConfig>');
    const layoutClose = result.indexOf('</LayoutGroup>');
    expect(layoutOpen).toBeLessThan(motionConfigOpen);
    expect(motionConfigClose).toBeLessThan(layoutClose);
    // MotionConfig got added to imports
    expect(result).toMatch(/import\s*\{[^}]*MotionConfig[^}]*\}\s*from\s*['"]framer-motion['"]/);
  });

  test('wraps inside LayoutGroup when return uses parens', () => {
    const code = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
function Foo() {
  return (
    <LayoutGroup>
      <motion.div data-id="root" style={{}} />
    </LayoutGroup>
  );
}`;
    const result = updateMotionConfigTransition(code, { type: 'spring', duration: '0.5' });
    expect(result).toMatch(/<MotionConfig\s+transition=/);
    expect(result).toContain('</MotionConfig>');
  });

  test('updates existing wrapper in place (no duplication)', () => {
    const code = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
function Foo() {
  return <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', duration: 0.3 }}>
      <motion.div data-id="root" style={{}} />
    </MotionConfig>
  </LayoutGroup>;
}`;
    const result = updateMotionConfigTransition(code, { type: 'spring', duration: '0.9' });
    const wrapperCount = (result.match(/<MotionConfig/g) || []).length;
    expect(wrapperCount).toBe(1);
    expect(result).toContain('duration: 0.9');
    expect(result).not.toContain('duration: 0.3');
  });

  test('removes wrapper when transition is null', () => {
    const code = `import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
function Foo() {
  return <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', duration: 0.3 }}>
      <motion.div data-id="root" style={{}} />
    </MotionConfig>
  </LayoutGroup>;
}`;
    const result = updateMotionConfigTransition(code, null);
    expect(result).not.toContain('MotionConfig transition');
    expect(result).not.toContain('</MotionConfig>');
  });
});

// ─── updateVariantEntryTransition: auto-create variants const ─────────────
//
// When a node has `animate={variant}` (connections wired) but NO existing
// `variants={X}` const, setting a per-variant transition would silently
// no-op. The writer now auto-creates an empty variants const so the
// transition entry has somewhere to land.

describe('updateVariantEntryTransition: auto-create', () => {
  test('creates variants const + variants prop when none exist', () => {
    const code = `import { motion } from 'framer-motion';
function Foo() {
  const [variant, setVariant] = useState('default');
  return (
    <motion.div data-id="root" animate={variant} layout={true} style={{ position: 'absolute' }}>
      hi
    </motion.div>
  );
}
export default Foo;`;
    const result = updateVariantEntryTransition(code, 'root', 'variant-1', { type: 'spring', duration: '0.5' });
    // Const created with default + variant-1 entries
    expect(result).toMatch(/const\s+\w+Variants\s*=\s*\{[\s\S]*default:\s*\{\}/);
    expect(result).toContain("'variant-1':");
    // Transition lands in the variant-1 entry
    expect(result).toMatch(/'variant-1':\s*\{\s*transition:\s*\{[^}]*type:\s*'spring'[^}]*duration:\s*0\.5[^}]*\}/);
    // variants prop was wired onto the JSX
    expect(result).toMatch(/data-id="root"\s+variants=\{\w+Variants\}/);
  });

  test('reuses existing variants const when present', () => {
    const code = `import { motion } from 'framer-motion';
const rootVariants = {
  default: {},
  'variant-1': {},
};
function Foo() {
  const [variant, setVariant] = useState('default');
  return (
    <motion.div data-id="root" variants={rootVariants} animate={variant} style={{ position: 'absolute' }}>
      hi
    </motion.div>
  );
}`;
    const result = updateVariantEntryTransition(code, 'root', 'variant-1', { type: 'spring', duration: '0.5' });
    // Doesn't create a second variants const
    const constCount = (result.match(/const\s+\w+Variants\s*=/g) || []).length;
    expect(constCount).toBe(1);
    // Transition added to existing entry
    expect(result).toMatch(/'variant-1':\s*\{\s*transition:\s*\{[^}]*duration:\s*0\.5/);
  });

  test('no-op when transition is null and no variants const exists', () => {
    const code = `import { motion } from 'framer-motion';
function Foo() {
  return <motion.div data-id="root" style={{}} />;
}`;
    const result = updateVariantEntryTransition(code, 'root', 'variant-1', null);
    expect(result).toBe(code);
  });

  // Per-viewport transition RESET (the X on a replica in VariantTransitionControl): null strips just that
  // entry's transition while keeping the entry + its other props + the other variants → the tile falls back
  // to the base <MotionConfig>.
  test('null strips an existing variant-entry transition, keeps the entry + siblings', () => {
    const code = `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': { opacity: 1, transition: { type: 'spring', duration: '0.5' } },
};
function Foo() {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} /></motion.div>;
}`;
    const result = updateVariantEntryTransition(code, 'box', 'variant-1', null);
    expect(result).not.toMatch(/transition:/);          // override stripped
    expect(result).toMatch(/'variant-1':\s*\{[^}]*opacity:\s*1/); // entry + other props kept
    expect(result).toMatch(/default:\s*\{\}/);           // sibling variant untouched
  });

  // The VARIABLE case (transition bound to a component/page variable → `transition: ergerg`, an identifier).
  // The old object-only strip missed it: a null reset no-op'd (dead binding left) and a re-write duplicated
  // the key → the corrupt `transition: '{, transition: …}'` the per-viewport remove produced.
  const VAR_CODE = `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': { opacity: 1, transition: ergerg },
};
function Foo() {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} /></motion.div>;
}`;
  test('null strips a variant-entry transition VARIABLE binding (identifier), reverts to base', () => {
    const result = updateVariantEntryTransition(VAR_CODE, 'box', 'variant-1', null);
    expect(result).not.toContain('ergerg');              // variable binding gone
    expect(result).not.toMatch(/transition\s*:/);        // no dangling transition key
    expect(result).toMatch(/'variant-1':\s*\{[^}]*opacity:\s*1/); // entry + other props kept
  });
  test('writing a literal over a transition VARIABLE replaces it — no duplicate key', () => {
    const result = updateVariantEntryTransition(VAR_CODE, 'box', 'variant-1', { type: 'spring', duration: '0.5' });
    expect((result.match(/transition\s*:/g) || []).length).toBe(1); // exactly one transition key
    expect(result).not.toContain('ergerg');              // identifier replaced
    expect(result).toMatch(/transition:\s*\{[^}]*spring/); // now an object literal
  });

  // STRING value containing braces (`transition: '{}'`) — the reported `'variant-1': {{}' }` crash: a
  // `[^,{}]+` strip stopped at the brace INSIDE the string. The quote-aware scanner consumes the whole string.
  test("null strips a STRING transition value containing braces (the {{}' corruption case)", () => {
    const code = `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': { opacity: 1, transition: '{}' },
};
function Foo() {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} /></motion.div>;
}`;
    const result = updateVariantEntryTransition(code, 'box', 'variant-1', null);
    expect(result).not.toMatch(/transition\s*:/);        // stripped, no dangling key
    expect(result).not.toContain("{{");                  // not the corrupt `{{}' }`
    expect(result).toMatch(/'variant-1':\s*\{[^}]*opacity:\s*1/); // sibling prop kept
    expect(() => parseJSXToNodes(result)).not.toThrow(); // VALID code (the crash repro)
  });
  test('null strips transition when it is the ONLY entry prop, leaving an empty entry (no dangling comma)', () => {
    const code = `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': { transition: '{}' },
};
function Foo() {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} /></motion.div>;
}`;
    const result = updateVariantEntryTransition(code, 'box', 'variant-1', null);
    expect(result).toMatch(/'variant-1':\s*\{\s*\}/);    // empty entry, no `{ , }`
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
});

// PER-VARIANT TRANSITION VARIABLE system (Phase 1 generators): a transition variable is the framer-motion
// transition bound to a variable IDENTIFIER — `variantObj['v1'] = { transition: v1Var }` (per-variant, native)
// or `<MotionConfig transition={baseVar}>` (base). NOT style.transition.
describe('transition VARIABLE bindings', () => {
  const ENTRY = (entry: string) => `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': ${entry},
};
function Foo() {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} /></motion.div>;
}`;

  test('updateVariantEntryTransition writes a variable identifier (varRef) into the variant entry', () => {
    const result = updateVariantEntryTransition(ENTRY('{ opacity: 1 }'), 'box', 'variant-1', null, 'myTransVar');
    expect(result).toMatch(/'variant-1':\s*\{[^}]*transition:\s*myTransVar/);
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
  test('varRef REPLACES an existing object transition (no duplicate key, no leftover object)', () => {
    const result = updateVariantEntryTransition(ENTRY("{ transition: { type: 'spring', duration: '0.5' } }"), 'box', 'variant-1', null, 'myVar');
    expect((result.match(/transition\s*:/g) || []).length).toBe(1);
    expect(result).toMatch(/transition:\s*myVar/);
    expect(result).not.toContain('spring');
  });
  test('readTransitionVarRef detects a per-variant MotionConfig-ternary identifier (cascades to children)', () => {
    const tern = `import { motion, MotionConfig } from 'framer-motion';
function Foo({ transition = {} }) {
  return <MotionConfig transition={variant === 'variant-1' ? v1Var : transition}><motion.div data-id="box" /></MotionConfig>;
}`;
    expect(readTransitionVarRef(tern, 'box', 'variantEntry', 'variant-1')).toBe('v1Var');
    // a LITERAL branch → null (an override, not a variable)
    expect(readTransitionVarRef(tern.replace('v1Var', "{ type: 'spring' }"), 'box', 'variantEntry', 'variant-1')).toBe(null);
    // no MotionConfig ternary → null
    expect(readTransitionVarRef(`<motion.div data-id="box" style={{}} />`, 'box', 'variantEntry', 'variant-1')).toBe(null);
  });
  test('formatTransitionObj → object literal (numeric keys unquoted) — instance writes transition={{…}} not a string', () => {
    expect(formatTransitionObj({ type: 'spring', duration: '0.5', bounce: '0.9', delay: '0' }))
      .toBe("{ type: 'spring', duration: 0.5, bounce: 0.9, delay: 0 }");
  });
  test('setVariantTransitionPropVar writes a FUNCTION-SCOPE ternary, strips the module-scope object override', () => {
    const code = `import { motion } from 'framer-motion';
const boxVariants = {
  default: {},
  'variant-1': { transition: { type: 'tween', duration: '0.3' } },
};
function Foo({ transition = {} }) {
  return <motion.div data-id="root"><motion.div data-id="box" variants={boxVariants} style={{}} /></motion.div>;
}`;
    const result = setVariantTransitionPropVar(code, 'box', 'variant-1', 'v1Var', 'transition');
    // function-scope element ternary (NOT the module-scope variant object → no undefined-identifier crash)
    expect(result).toMatch(/transition=\{initialVariant === 'variant-1' \? v1Var : transition\}/);
    expect(readTransitionVarRef(result, 'box', 'variantEntry', 'variant-1')).toBe('v1Var');
    expect(result).not.toMatch(/'variant-1':\s*\{[^}]*transition\s*:/); // module-scope object transition stripped
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
  test('revertVariantTransition strips an element-ternary VARIABLE AND a variant-object LITERAL → back to base', () => {
    const tern = `import { motion } from 'framer-motion';
function Foo({ transition = {} }) {
  return <motion.div data-id="box" transition={initialVariant === 'variant-1' ? v1Var : transition} style={{}} />;
}`;
    const r1 = revertVariantTransition(tern, 'box', 'variant-1');
    expect(r1).not.toContain('v1Var');           // ternary variable gone
    expect(r1).not.toMatch(/transition=\{/);     // element transition prop removed → inherits base
    expect(() => parseJSXToNodes(r1)).not.toThrow();
    const lit = `import { motion } from 'framer-motion';
const boxVariants = { default: {}, 'variant-1': { transition: { type: 'tween', duration: '0.3' } } };
function Foo() { return <motion.div data-id="box" variants={boxVariants} />; }`;
    const r2 = revertVariantTransition(lit, 'box', 'variant-1');
    expect(r2).toMatch(/'variant-1':\s*\{\s*\}/); // variant-object literal stripped
    expect(() => parseJSXToNodes(r2)).not.toThrow();
  });
  test('setVariantTransitionPropVar gates on the LIVE `variant` state when the component has connections', () => {
    // a component with connections has `animate={['default', variant]}` → the per-variant transition must gate
    // on the live `variant` STATE so framer-motion applies the TARGET variant's transition AS IT ANIMATES.
    const code = `import { motion } from 'framer-motion';
function Foo({ transition = {} }) {
  return <motion.div data-id="box" variants={boxVariants} style={{}} animate={['default', variant]} />;
}`;
    const result = setVariantTransitionPropVar(code, 'box', 'variant-1', 'v1Var', 'transition');
    expect(result).toMatch(/transition=\{variant === 'variant-1' \? v1Var : transition\}/);
    expect(result).not.toMatch(/initialVariant === 'variant-1'/);
    expect(readTransitionVarRef(result, 'box', 'variantEntry', 'variant-1')).toBe('v1Var');
  });
  test('setVariantTransitionPropVar puts the per-variant transition on MotionConfig (cascade), strips stale element ternary', () => {
    // mirrors the reported component: MotionConfig base + a stale element-prop ternary on the root → the child
    // (which actually animates) inherited MotionConfig, so the per-variant transition never reached it.
    const code = `import { motion, MotionConfig } from 'framer-motion';
function Foo({ transition2 = {}, transition3 = {} }) {
  return <MotionConfig transition={transition2}><motion.div data-id="root" transition={variant === 'variant-1' ? transition3 : transition2} animate={['default', variant]} /></MotionConfig>;
}`;
    const result = setVariantTransitionPropVar(code, 'root', 'variant-1', 'transition3', 'transition2');
    expect(result).toMatch(/<MotionConfig\s+transition=\{variant === 'variant-1' \? transition3 : transition2\}/); // cascades
    expect(result).not.toMatch(/data-id="root"[^>]*transition=\{/); // stale element ternary removed
    expect(readTransitionVarRef(result, 'root', 'variantEntry', 'variant-1')).toBe('transition3');
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
  test('setVariantTransitionPropVar CHAINS per-variant transitions — adding one never erases another', () => {
    const base = `import { motion, MotionConfig } from 'framer-motion';
function Foo({ transition2 = {} }) {
  return <MotionConfig transition={transition2}><motion.div data-id="root" animate={['default', variant]} /></MotionConfig>;
}`;
    const one = setVariantTransitionPropVar(base, 'root', 'variant-1', 'transition3', 'transition2');
    expect(one).toMatch(/transition=\{variant === 'variant-1' \? transition3 : transition2\}/);
    // add a SECOND variant — variant-1's binding must SURVIVE
    const two = setVariantTransitionPropVar(one, 'root', 'variant-2', 'transition4', 'transition2');
    expect(two).toMatch(/variant === 'variant-2' \? transition4 :/);
    expect(two).toMatch(/variant === 'variant-1' \? transition3 :/); // NOT erased
    expect(two).not.toContain('undefined');                         // base preserved (was the bug)
    expect(readTransitionVarRef(two, 'root', 'variantEntry', 'variant-1')).toBe('transition3');
    expect(readTransitionVarRef(two, 'root', 'variantEntry', 'variant-2')).toBe('transition4');
    expect(() => parseJSXToNodes(two)).not.toThrow();
    // revert ONE branch keeps the other
    const reverted = revertVariantTransition(two, 'root', 'variant-1');
    expect(reverted).not.toMatch(/variant === 'variant-1'/);
    expect(reverted).toMatch(/variant === 'variant-2' \? transition4 : transition2/);
  });
  test('setVariantTransitionPropVar onRoot=false puts a CHILD individual transition on its OWN element prop, not MotionConfig', () => {
    const code = `import { motion, MotionConfig } from 'framer-motion';
function Foo({ transition2 = {} }) {
  return <MotionConfig transition={transition2}><motion.div data-id="root"><motion.div data-id="child" animate={['default', variant]} /></motion.div></MotionConfig>;
}`;
    const result = setVariantTransitionPropVar(code, 'child', 'variant-1', 'childVar', 'undefined', false);
    expect(result).toMatch(/data-id="child"[^>]*transition=\{variant === 'variant-1' \? childVar : undefined\}/); // child's own
    expect(result).toMatch(/<MotionConfig\s+transition=\{transition2\}/); // MotionConfig cascade UNCHANGED
    expect(readTransitionVarRef(result, 'child', 'variantEntry', 'variant-1')).toBe('childVar'); // reads child's own first
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
  test('setMotionConfigBaseVar sets the PRIMARY (base) without overriding per-variant branches', () => {
    const chain = `<MotionConfig transition={variant === 'variant-1' ? transition2 : variant === 'variant-2' ? transition4 : undefined}><div data-id="root" /></MotionConfig>`;
    const result = setMotionConfigBaseVar(chain, 'transition');
    // per-variant branches survive, only the base (undefined) becomes the primary var
    expect(result).toMatch(/variant === 'variant-1' \? transition2 :/);
    expect(result).toMatch(/variant === 'variant-2' \? transition4 :/);
    expect(result).toMatch(/: transition\}/);            // base set to the primary var
    expect(result).not.toContain('undefined');
    expect(readTransitionVarRef(result, 'root', 'motionConfig')).toBe('transition'); // primary read = base
    // a single-value MotionConfig is just replaced
    expect(setMotionConfigBaseVar(`<MotionConfig transition={old}><div/></MotionConfig>`, 'neu')).toContain('transition={neu}');
  });
  test('revertVariantTransition reverts a MotionConfig per-variant ternary to its base', () => {
    const code = `import { motion, MotionConfig } from 'framer-motion';
function Foo() {
  return <MotionConfig transition={variant === 'variant-1' ? transition3 : transition2}><motion.div data-id="root" /></MotionConfig>;
}`;
    const result = revertVariantTransition(code, 'root', 'variant-1');
    expect(result).toMatch(/<MotionConfig\s+transition=\{transition2\}/);
    expect(result).not.toContain('transition3');
    expect(() => parseJSXToNodes(result)).not.toThrow();
  });
  test('setElementTransitionVar binds + replaces transition={var} on the element tag', () => {
    const inserted = setElementTransitionVar(`<motion.div data-id="box" style={{}} />`, 'box', 'myVar');
    expect(inserted).toMatch(/data-id="box"[^>]*transition=\{myVar\}/);
    expect(readTransitionVarRef(inserted, 'box', 'elementProp')).toBe('myVar');
    const replaced = setElementTransitionVar(`<motion.div data-id="box" transition={{ type: 'spring' }} style={{}} />`, 'box', 'myVar');
    expect(replaced).toMatch(/transition=\{myVar\}/);
    expect(replaced).not.toContain('spring');
  });
  test('updateMotionConfigTransition(null) removes a VARIABLE-bound wrapper without unbalancing (delete-crash repro)', () => {
    const code = `import { motion, MotionConfig, LayoutGroup } from 'framer-motion';
function Foo() {
  return (<LayoutGroup><MotionConfig transition={eergerg}><motion.div data-id="root" style={{}} /></MotionConfig></LayoutGroup>);
}`;
    const result = updateMotionConfigTransition(code, null);
    expect(result).not.toContain('<MotionConfig');   // opening tag gone (was the bug: only closing was stripped)
    expect(result).not.toContain('</MotionConfig>');  // closing tag gone
    expect(() => parseJSXToNodes(result)).not.toThrow(); // balanced JSX, no "Failed to parse"
  });
  test('updateMotionConfigTransition writes + reads a MotionConfig variable identifier', () => {
    const base = `import { motion, LayoutGroup } from 'framer-motion';
function Foo() {
  return (<LayoutGroup><motion.div data-id="root" style={{}} /></LayoutGroup>);
}`;
    const result = updateMotionConfigTransition(base, null, 'baseVar');
    expect(result).toMatch(/<MotionConfig\s+transition=\{baseVar\}>/);
    expect(readTransitionVarRef(result, 'root', 'motionConfig')).toBe('baseVar');
    // and switching it back to an object literal replaces the identifier cleanly
    const obj = updateMotionConfigTransition(result, { type: 'spring', duration: '0.5' });
    expect(obj).toMatch(/<MotionConfig\s+transition=\{\{[^}]*spring/);
    expect(readTransitionVarRef(obj, 'root', 'motionConfig')).toBe(null);
  });
});

describe('removeMotionPropFromCode', () => {
  test('removes motion prop from element', () => {
    const code = `<div data-id="root" style={{position: 'relative'}}>
  <motion.div data-id="box" whileHover={{ scale: 1.1 }} style={{width: '100px'}}>Hello</motion.div>
</div>`;
    const result = removeMotionPropFromCode(code, 'box', 'whileHover');
    expect(result).not.toContain('whileHover');
    // Element should still exist
    expect(result).toContain('data-id="box"');
    expect(result).toContain("width: '100px'");
  });
});

// ─── rewriteResponsiveBreakpoints ────────────────────────────────────────────

describe('rewriteResponsiveBreakpoints', () => {
  test('re-keys the resized breakpoint entry AND refreshes _bp', () => {
    const code = `<X data-id="i" data-responsive='{"375":{"initialVariant":"variant-2"},"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    // Tablet 768 → 800
    const out = rewriteResponsiveBreakpoints(code, 768, 800, [1440, 800, 375]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp['800']).toEqual({ initialVariant: 'variant-1' });  // moved to the new width
    expect(resp['768']).toBeUndefined();                            // old key gone
    expect(resp['375']).toEqual({ initialVariant: 'variant-2' });   // untouched
    expect(resp._bp).toEqual([1440, 800, 375]);                     // _bp refreshed
  });

  test('rewrites EVERY data-responsive in the file (page instance + canvas node)', () => {
    const code = `<A data-id="a" data-responsive='{"768":{"initialVariant":"v1"},"_bp":[1440,768,375]}' /><B data-id="b" data-responsive='{"768":{"initialVariant":"v2"},"_bp":[1440,768,375]}' />`;
    const out = rewriteResponsiveBreakpoints(code, 768, 800, [1440, 800, 375]);
    expect(out).not.toMatch(/"768":/);
    expect((out.match(/"800":/g) || []).length).toBe(2);
  });

  test('mobile resize (375 → 414) re-keys only the mobile entry', () => {
    const code = `<X data-id="i" data-responsive='{"375":{"initialVariant":"variant-2"},"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    const out = rewriteResponsiveBreakpoints(code, 375, 414, [1440, 768, 414]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp['414']).toEqual({ initialVariant: 'variant-2' });
    expect(resp['768']).toEqual({ initialVariant: 'variant-1' });
    expect(resp._bp).toEqual([1440, 768, 414]);
  });

  test('no entry at the resized width: only _bp refreshes (primary resize)', () => {
    const code = `<X data-id="i" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    const out = rewriteResponsiveBreakpoints(code, 1440, 1600, [1600, 768, 375]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp['768']).toEqual({ initialVariant: 'variant-1' });
    expect(resp._bp).toEqual([1600, 768, 375]);
  });

  test('no-op for code without data-responsive', () => {
    const code = `<div data-id="x" style={{ width: '10px' }} />`;
    expect(rewriteResponsiveBreakpoints(code, 768, 800, [1440, 800, 375])).toBe(code);
  });
});

describe('addResponsiveBreakpoint', () => {
  test('adding a viewport refreshes _bp INSTANTLY (new width appears)', () => {
    const code = `<X data-id="i" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    // Add an Ultra Wide viewport at 2586, source = desktop 1440 (no variant entry to copy)
    const out = addResponsiveBreakpoint(code, 2586, 1440, [2586, 1440, 768, 375]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp._bp).toEqual([2586, 1440, 768, 375]);   // new width present immediately
    expect(resp['768']).toEqual({ initialVariant: 'variant-1' });  // existing entry untouched
    expect(resp['2586']).toBeUndefined();               // desktop source had no entry → none copied
  });

  test('a new viewport cloned from a replica inherits the source variant entry', () => {
    const code = `<X data-id="i" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    // Add 800 from source tablet 768 → inherit variant-1
    const out = addResponsiveBreakpoint(code, 800, 768, [1440, 800, 768, 375]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp['800']).toEqual({ initialVariant: 'variant-1' });
    expect(resp._bp).toEqual([1440, 800, 768, 375]);
  });
});

describe('removeResponsiveBreakpoint', () => {
  test('deleting a viewport drops its entry AND removes it from _bp', () => {
    const code = `<X data-id="i" data-responsive='{"375":{"initialVariant":"variant-2"},"768":{"initialVariant":"variant-1"},"_bp":[1440,768,375]}' />`;
    // Delete tablet 768
    const out = removeResponsiveBreakpoint(code, 768, [1440, 375]);
    const resp = JSON.parse(out.match(/data-responsive='([^']*)'/)![1]);
    expect(resp['768']).toBeUndefined();                // keyed entry gone
    expect(resp['375']).toEqual({ initialVariant: 'variant-2' });
    expect(resp._bp).toEqual([1440, 375]);              // _bp no longer lists 768
  });

  test('applies to every instance in the file', () => {
    // Each instance keeps a 375 override so the attr survives — when the LAST
    // override is deleted the whole data-responsive attr is now removed (see
    // the cleanup test below).
    const code = `<A data-id="a" data-responsive='{"768":{"initialVariant":"v1"},"375":{"initialVariant":"v3"},"_bp":[1440,768,375]}' /><B data-id="b" data-responsive='{"768":{"initialVariant":"v2"},"375":{"initialVariant":"v4"},"_bp":[1440,768,375]}' />`;
    const out = removeResponsiveBreakpoint(code, 768, [1440, 375]);
    expect(out).not.toMatch(/"768":/);
    expect((out.match(/"_bp":\[1440,375\]/g) || []).length).toBe(2);
  });

  test('drops the whole data-responsive attr when the last override goes', () => {
    const code = `<A data-id="a" data-responsive='{"768":{"initialVariant":"v1"},"_bp":[1440,768,375]}' />`;
    const out = removeResponsiveBreakpoint(code, 768, [1440, 375]);
    expect(out).not.toContain('data-responsive');
  });
});

// ─── rewriteContainerBreakpoints ─────────────────────────────────────────────

describe('rewriteContainerBreakpoints', () => {
  beforeEach(() => {
    syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });
  });

  test('rewrites breakpoint width in @media rules', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="box"] { width: 100% !important; }
    }
  \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;
    // Rewrite tablet from 768 to 800
    syncViewportWidths({ desktop: 1440, tablet: 800, mobile: 375 });
    const result = rewriteContainerBreakpoints(code, 768, 800);
    // Should now have 800px instead of 768px
    expect(result).toContain('max-width: 800px');
    expect(result).not.toContain('max-width: 768px');
    // Should still have the box rule
    expect(result).toContain('[data-id="box"]');
    expect(result).toContain('width: 100% !important');
  });

  test('returns unchanged when no style block', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;
    const result = rewriteContainerBreakpoints(code, 768, 800);
    expect(result).toBe(code);
  });

  test('handles multiple breakpoints', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="box"] { width: 100% !important; }
    }
    @media (max-width: 375px) {
      [data-id="box"] { width: 50% !important; }
    }
  \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
</div>`;
    // Rename tablet 768 → 800
    syncViewportWidths({ desktop: 1440, tablet: 800, mobile: 375 });
    const result = rewriteContainerBreakpoints(code, 768, 800);
    // 800px should exist, 768px should not
    expect(result).toContain('max-width: 800px');
    expect(result).not.toContain('max-width: 768px');
    // 375px rule should still exist
    expect(result).toContain('max-width: 375px');
    expect(result).toContain('width: 50% !important');
    // min-width boundary for 800px should be 376px (375 + 1)
    // Inclusive lower bound — see the fractional-viewport gap fix in getMinWidth.
    expect(result).toContain('min-width: 375.02px');
  });
});

describe('removeNodeInCode — orphaned variant consts cleanup', () => {
  const COMP = `'use client';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'F', x:0,y:0, isPrimary:true }];
const keepVariants = { default: { color: '#fff' } };
const goneVariants = { default: { color: '#000' } };
const rootVariants = { default: { width: '100px' } };
function Foo({ style, initialVariant = 'default' }) {
  return <LayoutGroup>
    <motion.div data-id="root" variants={rootVariants} initial={initialVariant} animate={initialVariant} style={{ position: 'absolute' }}>
      <motion.div data-id="keep" variants={keepVariants} animate={initialVariant} style={{ position: 'relative' }}></motion.div>
      <motion.div data-id="gone" variants={goneVariants} animate={initialVariant} style={{ position: 'relative' }}></motion.div>
    </motion.div>
  </LayoutGroup>;
}`;

  test('deleting a variant element removes its orphaned variant const, keeps the others', () => {
    const out = removeNodeInCode(COMP, 'gone');
    expect(out).not.toContain('data-id="gone"');
    // Orphaned const removed.
    expect(out).not.toContain('const goneVariants');
    // Still-referenced consts kept.
    expect(out).toContain('const keepVariants');
    expect(out).toContain('const rootVariants');
    // variantConfig (ends in 'Config') untouched.
    expect(out).toContain('const variantConfig');
  });

  test('also collects a const wrapped via __applyInstanceSize', () => {
    const wrapped = COMP.replace('variants={goneVariants}', 'variants={__applyInstanceSize(goneVariants, w, h)}');
    const out = removeNodeInCode(wrapped, 'gone');
    expect(out).not.toContain('const goneVariants');
    expect(out).toContain('const keepVariants');
  });
});

// ─── Viewport-resize width sync: drift heal + crossing + text overrides ──────
// A viewport whose bands/keys DRIFTED from its width (an earlier resize whose
// sync didn't run) must still carry its styles along on the NEXT resize —
// otherwise the tile silently loses every override ("mobile at 392, bands
// keyed 375, resize to 1329 → styles gone", 2026-08-06).

describe('viewport-resize width sync (drift heal)', () => {
  test('orphan @media band claimed by the resized viewport', () => {
    // Mobile viewport is 392, but its band drifted to 375 (orphan).
    syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 1329 }); // AFTER resize 392→1329
    const code = `<div data-id="root">
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="a"] { font-size: 20px !important; }
    }
    @media (max-width: 375px) {
      [data-id="a"] { font-size: 30px !important; }
    }
  \`}</style>
</div>`;
    const out = rewriteContainerBreakpoints(code, 392, 1329);
    expect(out).toContain('max-width: 1329px');
    expect(out).toContain('font-size: 30px');
    expect(out).not.toContain('max-width: 375px'); // orphan claimed, not stranded
  });

  test('crossing resize keeps both bands correct (mobile grows past tablet)', () => {
    syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 1329 });
    const code = `<div data-id="root">
  <style>{\`
    @media (max-width: 768px) and (min-width: 375.02px) {
      [data-id="a"] { font-size: 20px !important; }
    }
    @media (max-width: 375px) {
      [data-id="a"] { font-size: 30px !important; }
    }
  \`}</style>
</div>`;
    const out = rewriteContainerBreakpoints(code, 375, 1329);
    // Mobile band becomes the widest non-primary; tablet floor recomputed.
    expect(out).toMatch(/max-width: 1329px\) and \(min-width: 768.02px/);
    expect(out).toMatch(/@media \(max-width: 768px\)\s*\{/);
  });

  test('orphan data-responsive key claimed by the resized viewport', () => {
    const code = `<A data-id="a" data-responsive='{"375":{"initialVariant":"v-mobile"},"768":{"initialVariant":"v-tablet"},"_bp":[1440,768,375]}' />`;
    const out = rewriteResponsiveBreakpoints(code, 392, 1329, [1440, 1329, 768]);
    expect(out).toContain('"1329":{"initialVariant":"v-mobile"}');
    expect(out).not.toContain('"375":{');
    expect(out).toContain('"_bp":[1440,1329,768]');
  });

  test('useResponsiveText overrides re-key + vpWidths refresh (incl. orphan)', () => {
    const code = `<p data-id="t">{useResponsiveText("Base text", {
      768: "Tablet text",
      375: "Mobile <span style=\\"font-size: 14px\\">rich</span>"
    }, [1440, 768, 375])}</p>`;
    const out = rewriteResponsiveTextBreakpoints(code, 392, 1329, [1440, 1329, 768]);
    expect(out).toContain('1329: "Mobile');           // orphan 375 claimed
    expect(out).toContain('768: "Tablet text"');      // untouched neighbor
    expect(out).toContain('[1440, 1329, 768]');       // widths list refreshed
    expect(out).toContain('rich</span>');             // rich value intact
  });

  test('useResponsiveText no-op without the hook or when width unchanged', () => {
    const plain = `<p data-id="t">hello</p>`;
    expect(rewriteResponsiveTextBreakpoints(plain, 375, 900, [1440, 900])).toBe(plain);
    const withHook = `<p>{useResponsiveText("a", { 375: "b" }, [1440, 375])}</p>`;
    expect(rewriteResponsiveTextBreakpoints(withHook, 375, 375, [1440, 375])).toBe(withHook);
  });
});

// ─── resolveResizedKeys: ordinal drift resolution (the REAL drifted file) ────

describe('resolveResizedKeys (ordinal ownership)', () => {
  test('exact match wins', () => {
    expect(resolveResizedKeys([768, 375], 375, [1440, 768, 375])).toEqual([375]);
  });

  test('REAL trace case: config mobile=375, band keyed 756 (proximity would give it to tablet)', () => {
    // present [768, 756]; old vps [1440, 768, 375]; tablet owns 768 exactly →
    // the single orphan 756 maps to the single band-less vp (mobile 375).
    expect(resolveResizedKeys([768, 756], 375, [1440, 375, 768])).toEqual([756]);
  });

  test('doubly-drifted: both bands orphaned, ordinal pairs them', () => {
    // present [900, 300]; vps [1440, 768, 375] → ownerless [768, 375];
    // orphans desc [900, 300] → tablet↔900, mobile↔300.
    expect(resolveResizedKeys([900, 300], 768, [1440, 768, 375])).toEqual([900]);
    expect(resolveResizedKeys([900, 300], 375, [1440, 768, 375])).toEqual([300]);
  });

  test('no orphans → nothing claimed; primary resize claims nothing', () => {
    expect(resolveResizedKeys([768], 375, [1440, 768, 375])).toEqual([]);
    expect(resolveResizedKeys([768, 756], 1440, [1440, 768, 375])).toEqual([]);
  });

  test('end-to-end: the drifted 756 mobile band moves on resize 375 → 1400', () => {
    syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 1400 }); // AFTER resize
    const code = `<div data-id="root">
  <style>{\`
    @media (max-width: 768px) and (min-width: 392.02px) {
      [data-id="a"] { font-size: 20px !important; }
    }
    @media (max-width: 756px) {
      [data-id="a"] { font-size: 30px !important; }
    }
  \`}</style>
</div>`;
    const out = rewriteContainerBreakpoints(code, 375, 1400);
    expect(out).toContain('max-width: 1400px');
    expect(out).toContain('font-size: 30px');
    expect(out).not.toContain('max-width: 756px');
    // Tablet stale min-floor (392.02) recomputed from the CURRENT set too.
    expect(out).not.toContain('392.02px');
  });
});

// ─── Animate-back seed: CSS-initial fallback (sticky variant residue) ────────
// framer-motion never resets a prop the target variant doesn't mention. A
// variant-only `flex`/`pointerEvents` with `default: {}` STUCK after any pass
// through that variant (Nav logo centered on desktop after a breakpoint
// crossing; buttons unclickable via pointerEvents residue — live find
// 2026-08-06). When the base style carries no value, the default entry now
// seeds the CSS INITIAL.

describe('ensureDefaultHasBaseValues — CSS-initial fallback', () => {
  const NAV_LIKE = `export default function Page() {
const wrapVariants = {
  default: {},
  'variant-4': { pointerEvents: 'none' },
};

return (
  <div data-id="root" style={{position: 'relative'}}>
    <motion.div data-id="wrap" variants={wrapVariants} style={{display: 'flex', alignItems: 'center'}}></motion.div>
  </div>
);
}`;

  test('variant write of flex (no base flex) seeds default with the CSS initial', () => {
    const result = updateVariantStyleInCode(NAV_LIKE, 'wrap', 'variant-4', { flex: '1 0 0px' });
    expect(result).toMatch(/default:\s*\{[^}]*flex: '0 1 auto'/);
    expect(result).toMatch(/'variant-4':\s*\{[^}]*flex: '1 0 0px'/);
  });

  test('heal path: ANY write to the variant unions its existing keys — pointerEvents residue gets its default seed', () => {
    // variant-4 already carries pointerEvents (older write, default empty) —
    // writing an unrelated prop must seed pointerEvents: 'auto' on default.
    const result = updateVariantStyleInCode(NAV_LIKE, 'wrap', 'variant-4', { paddingTop: '8px' });
    expect(result).toMatch(/default:\s*\{[^}]*pointerEvents: 'auto'/);
  });

  test('inline base still wins over the fallback', () => {
    const withBase = NAV_LIKE.replace("style={{display: 'flex', alignItems: 'center'}}", "style={{display: 'flex', flex: '0 0 auto'}}");
    const result = updateVariantStyleInCode(withBase, 'wrap', 'variant-4', { flex: '1 0 0px' });
    expect(result).toMatch(/default:\s*\{[^}]*flex: '0 0 auto'/);
    expect(result).not.toMatch(/default:\s*\{[^}]*flex: '0 1 auto'/);
  });

  test('INHERITED props are never force-seeded (no wrong initials)', () => {
    const result = updateVariantStyleInCode(NAV_LIKE, 'wrap', 'variant-4', { color: '#fff' });
    // color has no CSS_NEUTRAL_FALLBACK entry — default stays without it.
    expect(result).not.toMatch(/default:\s*\{[^}]*color:/);
  });
});
