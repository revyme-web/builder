import { describe, it, expect } from 'vitest';
import { parseComponentSpec } from './parse';
import { compileComponentSpec, compileBundle } from './compile';
import { parseJSXToNodes } from '@/code/parsing/parser';
import { parseVariantConfig } from '@/code/variants/variant-config';
import type { ComponentSpec } from './types';

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
        base: { paint: { backgroundColor: '#ffffff' }, layout: { flexDirection: 'row' } },
        variantStyles: [{ variant: 'open', paint: { scale: 1.1 }, layout: { flexDirection: 'column' } }],
        children: ['panel'] },
      { kind: 'element', id: 'panel', tag: 'div', visibleIn: ['open'], base: { paint: {} } },
    ],
    connections: [
      { from: 'default', to: 'open', trigger: 'click', sourceElement: 'root' },
      { from: 'open', to: 'default', trigger: 'click', sourceElement: 'root' },
    ],
  };
}

describe('parseComponentSpec (round-trip stability)', () => {
  it('recovers variants, root, element ids and visibility', () => {
    const code = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    const spec = parseComponentSpec(code, 'Menu');

    expect(spec.variants.map((v) => v.name)).toEqual(['default', 'open']);
    expect(spec.rootId).toBe('root');
    expect(new Set(spec.elements.map((e) => e.id))).toEqual(new Set(['root', 'panel']));

    const panel = spec.elements.find((e) => e.id === 'panel')!;
    expect(panel.visibleIn).toEqual(['open']); // hidden on default → recovered
  });

  it('round-trips to semantically-equivalent code (same nodes + variants)', () => {
    const code1 = compileComponentSpec(menuSpec(), { nameFor, internalName: 'Menu' });
    const spec2 = parseComponentSpec(code1, 'Menu');
    const code2 = compileComponentSpec(spec2, { nameFor, internalName: 'Menu' });

    const n1 = parseJSXToNodes(code1);
    const n2 = parseJSXToNodes(code2);
    expect(new Set(n2.keys())).toEqual(new Set(n1.keys()));
    expect(parseVariantConfig(code2).map((v) => v.name)).toEqual(parseVariantConfig(code1).map((v) => v.name));
  });

  it('recovers a nested instance as an instance element', () => {
    const files = compileBundle({
      entry: 'Card',
      components: [
        { name: 'Card', displayName: 'Card', isNew: false, rootId: 'card',
          variants: [{ name: 'default', label: 'Default', kind: 'interactive' }, { name: 'big', label: 'Big', kind: 'interactive' }],
          elements: [
            { kind: 'element', id: 'card', tag: 'div', visibleIn: ['default', 'big'], base: { paint: {} }, children: ['badge'] },
            { kind: 'instance', id: 'badge', component: 'Badge', visibleIn: ['default', 'big'], defaultInnerVariant: 'small' },
          ], connections: [] },
        { name: 'Badge', displayName: 'Badge', isNew: true, rootId: 'b',
          variants: [{ name: 'default', label: 'Default', kind: 'option' }],
          elements: [{ kind: 'element', id: 'b', tag: 'span', visibleIn: ['default'], base: { paint: {} } }], connections: [] },
      ],
    });
    const card = files.find((f) => f.specName === 'Card')!;
    const spec = parseComponentSpec(card.code, 'Card');
    const badge = spec.elements.find((e) => e.id === 'badge');
    expect(badge?.kind).toBe('instance');
  });
});
