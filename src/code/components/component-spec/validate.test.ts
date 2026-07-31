import { describe, it, expect } from 'vitest';
import { validateBundle } from './validate';
import type { ComponentBundle, ComponentSpec } from './types';

/** A minimal sound spec: root div with a button, default + open variants,
 *  a click connection default→open on the button. */
function soundSpec(overrides: Partial<ComponentSpec> = {}): ComponentSpec {
  return {
    name: 'Menu',
    displayName: 'Menu',
    isNew: true,
    rootId: 'root',
    variants: [
      { name: 'default', label: 'Default', kind: 'interactive' },
      { name: 'open', label: 'Open', kind: 'interactive' },
    ],
    elements: [
      { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'open'], base: { paint: { backgroundColor: '#fff' } }, children: ['btn'] },
      { kind: 'element', id: 'btn', tag: 'button', visibleIn: ['default', 'open'], base: { paint: {} } },
    ],
    connections: [
      { from: 'default', to: 'open', trigger: 'click', sourceElement: 'btn' },
      { from: 'open', to: 'default', trigger: 'click', sourceElement: 'btn' },
    ],
    ...overrides,
  };
}

function bundle(spec: ComponentSpec): ComponentBundle {
  return { entry: spec.name, components: [spec] };
}

describe('validateBundle', () => {
  it('passes a sound bundle', () => {
    expect(validateBundle(bundle(soundSpec()))).toEqual([]);
  });

  it('flags a bad entry', () => {
    const b = bundle(soundSpec());
    b.entry = 'Nope';
    expect(validateBundle(b).map((v) => v.code)).toContain('BAD_ENTRY');
  });

  it('flags a dead element (visible nowhere)', () => {
    const spec = soundSpec();
    spec.elements[1].visibleIn = [];
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('DEAD_ELEMENT');
  });

  it('flags visibleIn referencing an unknown variant', () => {
    const spec = soundSpec();
    spec.elements[1].visibleIn = ['ghost'];
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('BAD_VARIANT_REF');
  });

  it('flags an unreachable interactive variant', () => {
    const spec = soundSpec();
    spec.connections = []; // nothing leads to 'open'
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('UNREACHABLE_VARIANT');
  });

  it('flags a FLAT element list (no tree edges) with ONE actionable TREE_NOT_WIRED violation', () => {
    // The model's most common failure: every element emitted, none wired.
    const spec = soundSpec();
    spec.elements = [
      { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'open'], base: { paint: {} } },
      { kind: 'element', id: 'a', tag: 'span', visibleIn: ['default', 'open'], base: { paint: {} } },
      { kind: 'element', id: 'b', tag: 'span', visibleIn: ['default', 'open'], base: { paint: {} } },
    ];
    spec.connections = [];
    spec.variants = [{ name: 'default', label: 'Default', kind: 'option' }, { name: 'open', label: 'Open', kind: 'option' }];
    const codes = validateBundle(bundle(spec)).map((v) => v.code);
    expect(codes).toContain('TREE_NOT_WIRED');
    expect(codes).not.toContain('ORPHAN_ELEMENT'); // one instruction, not N repeats
  });

  it('keeps precise ORPHAN_ELEMENT messages when the tree is only PARTIALLY wired', () => {
    const spec = soundSpec(); // root.children = ['btn'] — tree has edges
    spec.elements.push({ kind: 'element', id: 'stray', tag: 'span', visibleIn: ['default', 'open'], base: { paint: {} } });
    const violations = validateBundle(bundle(spec));
    expect(violations.map((v) => v.code)).toContain('ORPHAN_ELEMENT');
    expect(violations.map((v) => v.code)).not.toContain('TREE_NOT_WIRED');
  });

  it('does NOT flag offsets without position (CSS-inert; the compiler strips them)', () => {
    const spec = soundSpec();
    (spec.elements[1] as any).base = { paint: { left: '93px', top: '80px' } };
    expect(validateBundle(bundle(spec))).toEqual([]);
  });

  it('flags an element kind missing its tag', () => {
    const spec = soundSpec();
    // @ts-expect-error — simulate a flat-schema object missing tag
    spec.elements[1] = { kind: 'element', id: 'btn', visibleIn: ['default', 'open'], base: { paint: {} } };
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('MISSING_TAG');
  });

  it('flags an instance referencing an unknown component', () => {
    const spec = soundSpec();
    spec.elements.push({ kind: 'instance', id: 'inner', component: 'Ghost', visibleIn: ['default', 'open'] });
    spec.elements[0].children = ['btn', 'inner'];
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('UNKNOWN_COMPONENT');
  });

  it('accepts an instance referencing an existing (registry) component', () => {
    const spec = soundSpec();
    spec.elements.push({ kind: 'instance', id: 'inner', component: 'Hero', visibleIn: ['default', 'open'] });
    spec.elements[0].children = ['btn', 'inner'];
    expect(validateBundle(bundle(spec), new Set(['Hero']))).toEqual([]);
  });

  it('flags a bad root', () => {
    const spec = soundSpec();
    spec.rootId = 'nope';
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('BAD_ROOT');
  });

  it('flags an orphan element', () => {
    const spec = soundSpec();
    spec.elements.push({ kind: 'element', id: 'lost', tag: 'div', visibleIn: ['default'], base: { paint: {} } });
    // not referenced by any children[]
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('ORPHAN_ELEMENT');
  });

  it('flags a cyclic tree', () => {
    const spec = soundSpec();
    spec.elements[1].children = ['root']; // btn -> root -> btn
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('CYCLIC_TREE');
  });

  it('flags a manual connection onto an interaction-state variant', () => {
    const spec = soundSpec({
      variants: [
        { name: 'default', label: 'Default', kind: 'interactive' },
        { name: 'default-hover', label: 'Hover', kind: 'interactive', interaction: { type: 'hover', of: 'default' } },
      ],
      connections: [{ from: 'default', to: 'default-hover', trigger: 'mouseEnter' }],
    });
    spec.elements = [
      { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'default-hover'], base: { paint: {} } },
    ];
    spec.rootId = 'root';
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('MANUAL_INTERACTION_CONNECTION');
  });

  it('flags delay on a non-inView connection', () => {
    const spec = soundSpec();
    spec.connections[0] = { from: 'default', to: 'open', trigger: 'click', delay: 2, sourceElement: 'btn' };
    expect(validateBundle(bundle(spec)).map((v) => v.code)).toContain('DELAY_ON_NON_INVIEW');
  });
});
