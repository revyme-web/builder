import { describe, test, expect } from 'vitest';
import { parseVariantConfig, serializeVariantConfig, createDefaultVariantConfig, hasInteractionState, getInteractionStatesForVariant } from './variant-config';

describe('variant-config', () => {
  test('createDefaultVariantConfig returns single primary variant', () => {
    const configs = createDefaultVariantConfig();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe('default');
    expect(configs[0].label).toBe('Default');
    expect(configs[0].isPrimary).toBe(true);
  });

  test('parseVariantConfig extracts variant metadata', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 100, y: 200, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];

export default function Foo() { return <div />; }`;

    const configs = parseVariantConfig(code);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({ name: 'default', label: 'Default', x: 100, y: 200, isPrimary: true });
    expect(configs[1]).toEqual({ name: 'variant-1', label: 'Hover', x: 500, y: 0, isPrimary: false });
  });

  test('parseVariantConfig falls back to default when no config found', () => {
    const code = `export default function Foo() { return <div />; }`;
    const configs = parseVariantConfig(code);
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe('default');
  });

  test('parseVariantConfig uses name as label fallback', () => {
    const code = `const variantConfig = [
  { name: 'default', x: 0, y: 0, isPrimary: true },
  { name: 'open', x: 500, y: 0 },
];`;
    const configs = parseVariantConfig(code);
    expect(configs[0].label).toBe('default'); // no explicit label → falls back to name
    expect(configs[1].label).toBe('open');
  });

  test('serializeVariantConfig produces parseable output', () => {
    const original = [
      { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
      { name: 'variant-1', label: 'Hover', x: 600, y: 300 },
    ];
    const serialized = serializeVariantConfig(original);
    expect(serialized).toContain("name: 'default'");
    expect(serialized).toContain("label: 'Default'");
    expect(serialized).toContain("isPrimary: true");
    expect(serialized).toContain("name: 'variant-1'");
    expect(serialized).toContain("label: 'Hover'");

    // Round-trip: parse the serialized output
    const reparsed = parseVariantConfig(serialized);
    expect(reparsed).toHaveLength(2);
    expect(reparsed[0].name).toBe('default');
    expect(reparsed[0].x).toBe(0);
    expect(reparsed[1].name).toBe('variant-1');
    expect(reparsed[1].x).toBe(600);
  });

  test('parseVariantConfig round-trips interactionType + parentVariant', () => {
    const original = [
      { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
      { name: 'default-hover', label: 'Default - Hover', x: 0, y: 600,
        interactionType: 'hover' as const, parentVariant: 'default' },
      { name: 'default-pressed', label: 'Default - Pressed', x: 600, y: 600,
        interactionType: 'pressed' as const, parentVariant: 'default' },
    ];
    const serialized = serializeVariantConfig(original);
    expect(serialized).toContain("interactionType: 'hover'");
    expect(serialized).toContain("parentVariant: 'default'");
    expect(serialized).toContain("interactionType: 'pressed'");

    const reparsed = parseVariantConfig(serialized);
    expect(reparsed).toHaveLength(3);
    expect(reparsed[1].interactionType).toBe('hover');
    expect(reparsed[1].parentVariant).toBe('default');
    expect(reparsed[2].interactionType).toBe('pressed');
    expect(reparsed[2].parentVariant).toBe('default');
    // Plain entries DON'T carry the optional fields
    expect(reparsed[0].interactionType).toBeUndefined();
    expect(reparsed[0].parentVariant).toBeUndefined();
  });

  test('hasInteractionState detects existing hover/pressed states', () => {
    const configs = [
      { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
      { name: 'default-hover', label: 'Hover', x: 0, y: 600,
        interactionType: 'hover' as const, parentVariant: 'default' },
    ];
    expect(hasInteractionState(configs, 'default', 'hover')).toBe(true);
    expect(hasInteractionState(configs, 'default', 'pressed')).toBe(false);
    expect(hasInteractionState(configs, 'variant-1', 'hover')).toBe(false);
  });

  test('getInteractionStatesForVariant returns only states for that source', () => {
    const configs = [
      { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
      { name: 'variant-1', label: 'Variant 1', x: 600, y: 0 },
      { name: 'default-hover', label: 'Default - Hover', x: 0, y: 600,
        interactionType: 'hover' as const, parentVariant: 'default' },
      { name: 'variant-1-pressed', label: 'Variant 1 - Pressed', x: 600, y: 600,
        interactionType: 'pressed' as const, parentVariant: 'variant-1' },
    ];
    const defaultStates = getInteractionStatesForVariant(configs, 'default');
    expect(defaultStates).toHaveLength(1);
    expect(defaultStates[0].interactionType).toBe('hover');

    const v1States = getInteractionStatesForVariant(configs, 'variant-1');
    expect(v1States).toHaveLength(1);
    expect(v1States[0].interactionType).toBe('pressed');
  });
});
