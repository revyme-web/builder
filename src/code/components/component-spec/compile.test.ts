import { describe, it, expect } from 'vitest';
import { compileBundle, compileComponentSpec } from './compile';
import { parseJSXToNodes } from '@/code/parsing/parser';
import type { ComponentBundle, ComponentSpec } from './types';

const nameFor = (n: string) => n;

function menuSpec(): ComponentSpec {
  return {
    name: 'Menu', displayName: 'Menu', isNew: false, rootId: 'root',
    variants: [
      { name: 'default', label: 'Default', kind: 'interactive' },
      { name: 'open', label: 'Open', kind: 'interactive' },
    ],
    elements: [
      { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'open'],
        base: { paint: { backgroundColor: '#ffffff' }, layout: { flexDirection: 'row', gap: '8px' } },
        variantStyles: [{ variant: 'open', layout: { flexDirection: 'column' } }],
        children: ['btn', 'panel'] },
      { kind: 'element', id: 'btn', tag: 'button', visibleIn: ['default', 'open'],
        base: { paint: { backgroundColor: '#111111' } },
        variantStyles: [{ variant: 'open', paint: { scale: 1.1 } }] },
      // panel only visible when open → AnimatePresence
      { kind: 'element', id: 'panel', tag: 'div', visibleIn: ['open'], base: { paint: {} } },
    ],
    connections: [
      { from: 'default', to: 'open', trigger: 'click', sourceElement: 'btn' },
      { from: 'open', to: 'default', trigger: 'click', sourceElement: 'btn' },
    ],
  };
}

describe('compileComponentSpec', () => {
  it('emits a file that PARSES through the real parser', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBeGreaterThan(0);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('btn')).toBe(true);
  });

  it('emits the canonical skeleton', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    expect(code).toContain("import { withResponsiveProps } from '@revyme/runtime';");
    expect(code).toContain('/** @name "Menu" */');
    expect(code).toContain('const variantConfig =');
    expect(code).toContain('export default withResponsiveProps(Menu);');
    expect(code).toContain('<motion.div');
  });

  it('routes layout to a ternary and paint to a variant object with neutral default', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    // layout prop became a ternary, not a variant-object value
    expect(code).toMatch(/flexDirection:\s*(initialVariant|variant) === 'open' \? 'column' : 'row'/);
    // btn scale variant object: default carries the neutral scale: 1
    expect(code).toMatch(/const btnVariants = \{[\s\S]*default: \{[^}]*scale: 1[\s\S]*'open': \{[^}]*scale: 1\.1/);
  });

  it('wraps a partially-visible element in AnimatePresence', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    expect(code).toContain('<AnimatePresence');
    expect(code).toContain('data-id="panel"');
  });

  it('generates connection state + a gated handler', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    expect(code).toContain('const connections =');
    expect(code).toMatch(/useState\(initialVariant\)/);
    // Guarded handler form (no-match branches never call setVariant — the
    // bubbled-ancestor-clobber fix, 2026-08-06).
    expect(code).toMatch(/onTap=\{\(\) => \{\s*const _n = variant === 'default' \? 'open'/);
    expect(code).toMatch(/if \(_n\) setVariant\(_n\);/);
  });

  it('emits a MotionConfig spring so transitions are smooth', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    expect(code).toMatch(/<MotionConfig transition=\{\{ type: 'spring'/);
  });

  it('folds a display:none variant delta into AnimatePresence (no display toggle in the variant object)', () => {
    // The model tries to hide a pane via display:'none' (the bug from real output).
    const spec: ComponentSpec = {
      name: 'Tabs', displayName: 'Tabs', isNew: false, rootId: 'root',
      variants: [
        { name: 'default', label: 'Overview', kind: 'interactive' },
        { name: 'tab2', label: 'Details', kind: 'interactive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'tab2'], base: { paint: {} }, children: ['pane'] },
        // visibleIn says both, but the model also set display flex/none per variant
        { kind: 'element', id: 'pane', tag: 'div', visibleIn: ['default', 'tab2'],
          base: { paint: { display: 'flex' } as any },
          variantStyles: [{ variant: 'tab2', paint: { display: 'none' } as any }] },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Tabs' });
    // pane is wrapped in AnimatePresence, hidden in tab2
    expect(code).toContain('<AnimatePresence');
    expect(code).toContain('data-id="pane"');
    // and display NEVER leaks into a variant object or inline style
    expect(code).not.toMatch(/display:\s*'none'/);
    expect(code).not.toMatch(/paneVariants/); // display was the only paint → no variant object
  });

  it('keeps legit CSS (gradients, borders, cursor) but drops transform/transition/animation', () => {
    const spec: ComponentSpec = {
      name: 'Btn', displayName: 'Btn', isNew: false, rootId: 'root',
      variants: [{ name: 'default', label: 'Default', kind: 'interactive' }, { name: 'hover', label: 'Hover', kind: 'interactive' }],
      elements: [{
        kind: 'element', id: 'root', tag: 'button', visibleIn: ['default', 'hover'],
        base: { paint: {
          backgroundImage: 'linear-gradient(135deg, #6366f1, #4f46e5)',
          border: '1px solid #fff', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.3)',
          transition: 'all 0.2s ease', transform: 'rotate(5deg)',
        } as any },
        variantStyles: [{ variant: 'hover', paint: { scale: 1.03 } }],
      }],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Btn' });
    expect(code).toContain('backgroundImage');     // legit — kept
    expect(code).toContain('cursor');              // legit — kept
    expect(code).toMatch(/scale: 1\.03/);          // motion number — kept
    expect(code).not.toContain('transition:');     // CSS transition — dropped (use MotionConfig)
    expect(code).not.toContain("transform:");      // CSS transform — dropped (use motion props)
  });

  it('does NOT wrap a child in AnimatePresence when its parent already hides it (no redundant nesting)', () => {
    // nav header: desktop-only nav group with links inside; mobile-only hamburger.
    const spec: ComponentSpec = {
      name: 'Header', displayName: 'Header', isNew: false, rootId: 'root',
      variants: [
        { name: 'desktop', label: 'Desktop', kind: 'responsive' },
        { name: 'mobile-closed', label: 'Mobile Closed', kind: 'interactive' },
        { name: 'mobile-opened', label: 'Mobile Opened', kind: 'interactive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['desktop', 'mobile-closed', 'mobile-opened'], base: { paint: {} }, children: ['nav', 'burger'] },
        // desktop-only nav group + its links (links inherit the nav's hiding)
        { kind: 'element', id: 'nav', tag: 'div', visibleIn: ['desktop'], base: { paint: {} }, children: ['link1', 'link2'] },
        { kind: 'element', id: 'link1', tag: 'a', visibleIn: ['desktop'], base: { paint: {} } },
        { kind: 'element', id: 'link2', tag: 'a', visibleIn: ['desktop'], base: { paint: {} } },
        // mobile-only hamburger (child of root, so it needs its own wrapper)
        { kind: 'element', id: 'burger', tag: 'button', visibleIn: ['mobile-closed', 'mobile-opened'], base: { paint: {} } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Header' });

    // exactly TWO AnimatePresence wrappers: the nav group and the hamburger —
    // NOT one per link (that was the bug that collapsed the layout).
    const apCount = (code.match(/<AnimatePresence/g) ?? []).length;
    expect(apCount).toBe(2);
    // the links render, but are NOT individually gated
    expect(code).toContain('data-id="link1"');
    expect(code).toContain('data-id="link2"');
    expect(code).not.toMatch(/<AnimatePresence[^>]*>\{[^}]*&&\s*<motion\.a data-id="link1"/);
  });

  it('injects canvas style defaults: display:flex on containers, position/flex on children', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    // root has children + flexDirection → explicit flex container (the schema has
    // no display, so without this every compiled layout collapses to a block stack)
    expect(code).toMatch(/data-id="root"[^<>]*style=\{\{ display: 'flex'/);
    // children get the creator conventions so drag/resize behave
    expect(code).toMatch(/data-id="btn"[^<>]*style=\{\{[^}]*position: 'relative'/);
    expect(code).toMatch(/data-id="btn"[^<>]*style=\{\{[^}]*flex: '0 0 auto'/);
    // root still spreads ...style last
    expect(code).toMatch(/\.\.\.style \}\}/);
  });

  it('injects display:grid when grid layout props are present', () => {
    const spec: ComponentSpec = {
      name: 'Grid', displayName: 'Grid', isNew: false, rootId: 'root',
      variants: [{ name: 'default', label: 'Default', kind: 'option' }],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default'],
          base: { paint: {}, layout: { gridTemplateColumns: '1fr 1fr', gap: '12px' } }, children: ['cell'] },
        { kind: 'element', id: 'cell', tag: 'div', visibleIn: ['default'], base: { paint: {} } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Grid' });
    expect(code).toMatch(/data-id="root"[^<>]*style=\{\{ display: 'grid'/);
  });

  it('strips CSS-inert offsets (left/top without ANY position on the element)', () => {
    const spec: ComponentSpec = {
      name: 'Jnk', displayName: 'Jnk', isNew: false, rootId: 'root',
      variants: [{ name: 'default', label: 'Default', kind: 'option' }],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default'], base: { paint: {} }, children: ['kid'] },
        // static flex child with offset junk — inert in CSS, must not survive
        { kind: 'element', id: 'kid', tag: 'a', visibleIn: ['default'],
          base: { paint: { color: '#fff', left: '93px', top: '80px' } as any } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Jnk' });
    expect(code).not.toContain("left: '93px'");
    expect(code).not.toContain("top: '80px'");
    expect(code).toContain("color: '#fff'");
  });

  it('respects an explicit position:absolute (no relative/flex defaults forced on it)', () => {
    const spec: ComponentSpec = {
      name: 'Pin', displayName: 'Pin', isNew: false, rootId: 'root',
      variants: [{ name: 'default', label: 'Default', kind: 'option' }],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default'], base: { paint: {} }, children: ['knob'] },
        { kind: 'element', id: 'knob', tag: 'div', visibleIn: ['default'],
          base: { paint: { position: 'absolute', left: '24px', top: '12px' } as any } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Pin' });
    expect(code).toMatch(/data-id="knob"[^<>]*position: 'absolute'/);
    expect(code).toMatch(/left: '24px'/);
    expect(code).not.toMatch(/data-id="knob"[^<>]*position: 'relative'/);
    expect(code).not.toMatch(/data-id="knob"[^<>]*flex: '0 0 auto'/);
  });

  it('normalizes junk deltas: values repeated in EVERY variant collapse into base', () => {
    // The real failure: the model wrote borderRadius/gap identically into every
    // variant delta → junk variant objects + degenerate ternaries ending in ''.
    const spec: ComponentSpec = {
      name: 'Hdr', displayName: 'Hdr', isNew: false, rootId: 'root',
      variants: [
        { name: 'desktop', label: 'Desktop', kind: 'responsive' },
        { name: 'mobile', label: 'Mobile', kind: 'responsive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['desktop', 'mobile'],
          base: { paint: {} },
          variantStyles: [
            { variant: 'desktop', paint: { borderRadius: '2px' }, layout: { gap: '16px' } },
            { variant: 'mobile', paint: { borderRadius: '2px' }, layout: { gap: '16px' } },
          ],
          children: ['child'] },
        { kind: 'element', id: 'child', tag: 'span', visibleIn: ['desktop', 'mobile'],
          base: { paint: { color: '#fff' } },
          // delta equal to base → dropped → no variant object at all
          variantStyles: [{ variant: 'mobile', paint: { color: '#fff' } }] },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Hdr' });
    // promoted to base: plain values, no ternary chain, no variant object
    expect(code).toContain("gap: '16px'");
    expect(code).not.toMatch(/gap: initialVariant ===/);
    expect(code).toContain("borderRadius: '2px'");
    expect(code).not.toContain('rootVariants');
    expect(code).not.toContain('childVariants');
  });

  it('falls back to the CSS initial value (never empty string) in layout ternaries', () => {
    const spec: ComponentSpec = {
      name: 'Col', displayName: 'Col', isNew: false, rootId: 'root',
      variants: [
        { name: 'default', label: 'Default', kind: 'option' },
        { name: 'stacked', label: 'Stacked', kind: 'option' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'stacked'],
          base: { paint: {} }, // no base flexDirection
          variantStyles: [{ variant: 'stacked', layout: { flexDirection: 'column' } }],
          children: ['kid'] },
        { kind: 'element', id: 'kid', tag: 'span', visibleIn: ['default', 'stacked'], base: { paint: {} } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Col' });
    // else-branch is the CSS initial 'row', NOT '' (which means "remove property")
    expect(code).toContain("flexDirection: initialVariant === 'stacked' ? 'column' : 'row'");
  });

  it('emits visibility wrappers with the LIVE variant identifier when connections exist', () => {
    // connections run before visibility in compile, so the wrapper condition is
    // born reactive — no fragile post-hoc initialVariant→variant migration.
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    expect(code).toMatch(/variant !== ['"]default['"]/);
    expect(code).not.toMatch(/initialVariant !== ['"]/);
  });

  it('strips position/offsets from the ROOT (canvas owns artboard placement)', () => {
    // The model put position:'relative' on the root — applied via the variants
    // object it re-anchors the master artboard and the variants pile up.
    const spec: ComponentSpec = {
      name: 'Hdr', displayName: 'Hdr', isNew: false, rootId: 'root',
      variants: [
        { name: 'desktop', label: 'Desktop', kind: 'responsive' },
        { name: 'mobile', label: 'Mobile', kind: 'responsive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['desktop', 'mobile'],
          base: { paint: { backgroundColor: '#000', position: 'relative', left: '4px' } as any },
          variantStyles: [{ variant: 'mobile', paint: { position: 'relative', top: '2px' } as any }],
          children: ['kid'] },
        { kind: 'element', id: 'kid', tag: 'span', visibleIn: ['desktop', 'mobile'], base: { paint: {} } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Hdr' });
    // stripping emptied the deltas → no variant object; bg renders inline, sans position
    expect(code).not.toContain('rootVariants');
    expect(code).not.toMatch(/data-id="root"[^<>]*style=\{\{[^}]*position:/);
    expect(code).not.toContain("left: '4px'");
    expect(code).not.toContain("top: '2px'");
    expect(code).toContain('#000'); // legit paint kept
  });

  it('emits a variant-object entry for EVERY variant (motion has no missing-key fallback)', () => {
    const spec: ComponentSpec = {
      name: 'Hdr', displayName: 'Hdr', isNew: false, rootId: 'root',
      variants: [
        { name: 'desktop', label: 'Desktop', kind: 'responsive' },
        { name: 'mobile-closed', label: 'Mobile Closed', kind: 'interactive' },
        { name: 'mobile-opened', label: 'Mobile Opened', kind: 'interactive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['desktop', 'mobile-closed', 'mobile-opened'],
          base: { paint: {} }, children: ['line'] },
        // delta ONLY for mobile-opened — desktop/mobile-closed must still get entries
        { kind: 'element', id: 'line', tag: 'span', visibleIn: ['desktop', 'mobile-closed', 'mobile-opened'],
          base: { paint: { backgroundColor: '#fff' } },
          variantStyles: [{ variant: 'mobile-opened', paint: { rotate: 45 } }] },
      ],
      connections: [
        { from: 'mobile-closed', to: 'mobile-opened', trigger: 'click', sourceElement: 'line' },
        { from: 'mobile-opened', to: 'mobile-closed', trigger: 'click', sourceElement: 'line' },
      ],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Hdr' });
    // all three named entries present — animate back to mobile-closed resolves rotate: 0
    expect(code).toMatch(/'desktop': \{[^}]*backgroundColor: '#fff'/);
    expect(code).toMatch(/'mobile-closed': \{[^}]*rotate: 0/);
    expect(code).toMatch(/'mobile-opened': \{[^}]*rotate: 45/);
  });

  it("appear defaults to the element's OWN visibleIn minus primary, not every variant", () => {
    const spec: ComponentSpec = {
      name: 'Hdr', displayName: 'Hdr', isNew: false, rootId: 'root',
      variants: [
        { name: 'desktop', label: 'Desktop', kind: 'responsive' },
        { name: 'mobile-closed', label: 'Mobile Closed', kind: 'responsive' },
        { name: 'mobile-opened', label: 'Mobile Opened', kind: 'responsive' },
      ],
      elements: [
        { kind: 'element', id: 'root', tag: 'div', visibleIn: ['desktop', 'mobile-closed', 'mobile-opened'],
          base: { paint: {} }, children: ['drawer'] },
        { kind: 'element', id: 'drawer', tag: 'div', visibleIn: ['mobile-opened'],
          base: { paint: {} }, appear: { from: { opacity: 0, y: -15 } } },
      ],
      connections: [],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Hdr' });
    expect(code).toMatch(/initial=\{initialVariant === 'mobile-opened' \? \{ opacity: 0, y: -15 \} : initialVariant\}/);
    expect(code).not.toMatch(/initialVariant === 'mobile-closed' \? \{ opacity: 0/);
  });

  it('emits a per-variant enter animation as an initial ternary', () => {
    const spec: ComponentSpec = {
      name: 'Card', displayName: 'Card', isNew: false, rootId: 'root',
      variants: [{ name: 'default', label: 'Default', kind: 'interactive' }, { name: 'open', label: 'Open', kind: 'interactive' }],
      elements: [{
        kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'open'],
        base: { paint: {} },
        appear: { from: { opacity: 0, y: 30 }, inVariants: ['open'] },
      }],
      connections: [{ from: 'default', to: 'open', trigger: 'click', sourceElement: 'root' }],
    };
    const code = compileComponentSpec(spec, { nameFor, internalName: 'Card' });
    // connections exist → condition migrated to `variant === 'open'`
    expect(code).toMatch(/initial=\{variant === 'open' \? \{ opacity: 0, y: 30 \} : initialVariant\}/);
  });
});

describe('compileBundle — nested instances + make-component', () => {
  function bundle(): ComponentBundle {
    return {
      entry: 'Card',
      components: [
        {
          name: 'Card', displayName: 'Card', isNew: false, rootId: 'card',
          variants: [
            { name: 'default', label: 'Default', kind: 'interactive' },
            { name: 'big', label: 'Big', kind: 'interactive' },
          ],
          elements: [
            { kind: 'element', id: 'card', tag: 'div', visibleIn: ['default', 'big'], base: { paint: {} }, children: ['badge'] },
            // nested instance, inner variant varies per parent variant
            { kind: 'instance', id: 'badge', component: 'Badge', visibleIn: ['default', 'big'],
              innerVariantByParent: [{ parent: 'big', child: 'large' }], defaultInnerVariant: 'small' },
          ],
          connections: [],
        },
        {
          name: 'Badge', displayName: 'Badge', isNew: true, rootId: 'b',
          variants: [
            { name: 'default', label: 'Default', kind: 'option' },
            { name: 'small', label: 'Small', kind: 'option' },
            { name: 'large', label: 'Large', kind: 'option' },
          ],
          elements: [{ kind: 'element', id: 'b', tag: 'span', visibleIn: ['default', 'small', 'large'], base: { paint: {} } }],
          connections: [],
        },
      ],
    };
  }

  it('compiles both files; the parent imports + instantiates the child with a per-parent inner variant', () => {
    const files = compileBundle(bundle());
    expect(files).toHaveLength(2);
    const card = files.find((f) => f.specName === 'Card')!;
    const badge = files.find((f) => f.specName === 'Badge')!;

    // child got a fresh internal name; parent imports THAT name
    expect(badge.isNew).toBe(true);
    expect(card.code).toContain(`import ${badge.internalName} from '@/components/${badge.internalName}';`);
    expect(card.code).toContain(`<${badge.internalName} `);
    // per-parent inner variant ternary
    expect(card.code).toMatch(/initialVariant=\{initialVariant === 'big' \? 'large' : 'small'\}/);

    // both files parse
    expect(parseJSXToNodes(card.code).has('card')).toBe(true);
    expect(parseJSXToNodes(badge.code).has('b')).toBe(true);
  });
});
