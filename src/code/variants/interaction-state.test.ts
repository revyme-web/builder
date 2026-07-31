import { describe, test, expect } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { parseVariantConfig, hasInteractionState } from './variant-config';
import { parseConnections } from './connection-config';
import { addInteractionState } from './variant-ops';

const FILE = 'components/Card.tsx';

const BASE_CODE = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Card', x: 0, y: 0, isPrimary: true },
];

const cardVariants = {
  default: { backgroundColor: '#fff', scale: 1 },
};

function Card({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
      <motion.div data-id="root" variants={cardVariants} initial={initialVariant} style={{ position: 'absolute', ...style }} />
    </LayoutGroup>
  );
}

export default withResponsiveProps(Card);
`;

describe('addInteractionState', () => {
  test('hover only — adds variant entry, copies styles, wires source ↔ hover bidirectional', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    const result = addInteractionState(FILE, 'default', 'hover');
    expect(result).not.toBeNull();

    const updated = projectFS.readFile(FILE)!;
    const configs = parseVariantConfig(updated);
    expect(configs).toHaveLength(2);

    const hover = configs.find(c => c.name === 'default-hover');
    expect(hover).toBeDefined();
    expect(hover!.interactionType).toBe('hover');
    expect(hover!.parentVariant).toBe('default');
    expect(hover!.label).toBe('Card - Hover');

    // Variants object got a 'default-hover' key copied from 'default'
    expect(updated).toContain("'default-hover':");
    expect(updated).toContain("backgroundColor: '#fff'"); // copied

    // Connections: source mouseEnter → hover, hover mouseLeave → source
    const conns = parseConnections(updated);
    expect(conns).toContainEqual({ from: 'default', to: 'default-hover', trigger: 'mouseEnter' });
    expect(conns).toContainEqual({ from: 'default-hover', to: 'default', trigger: 'mouseLeave' });
    expect(conns).toHaveLength(2);
  });

  test('pressed only — wires source clickStart → pressed, pressed click → source', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    addInteractionState(FILE, 'default', 'pressed');
    const updated = projectFS.readFile(FILE)!;
    const conns = parseConnections(updated);

    expect(conns).toContainEqual({ from: 'default', to: 'default-pressed', trigger: 'clickStart' });
    expect(conns).toContainEqual({ from: 'default-pressed', to: 'default', trigger: 'click' });
    expect(conns).toHaveLength(2);
  });

  test('skips creating duplicate state', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    const first = addInteractionState(FILE, 'default', 'hover');
    expect(first).not.toBeNull();

    const second = addInteractionState(FILE, 'default', 'hover');
    expect(second).toBeNull();

    const configs = parseVariantConfig(projectFS.readFile(FILE)!);
    // Still only 2 entries: default + default-hover
    expect(configs).toHaveLength(2);
  });

  test('returns null when source variant does not exist', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    const result = addInteractionState(FILE, 'nonexistent', 'hover');
    expect(result).toBeNull();
  });

  test('chain rewrite — adding pressed when hover exists wires through hover', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    // Step 1: hover first
    addInteractionState(FILE, 'default', 'hover');
    let conns = parseConnections(projectFS.readFile(FILE)!);
    expect(conns).toHaveLength(2);

    // Step 2: pressed — should NOT pair with source directly
    addInteractionState(FILE, 'default', 'pressed');
    conns = parseConnections(projectFS.readFile(FILE)!);

    // Existing source ↔ hover stays
    expect(conns).toContainEqual({ from: 'default', to: 'default-hover', trigger: 'mouseEnter' });
    expect(conns).toContainEqual({ from: 'default-hover', to: 'default', trigger: 'mouseLeave' });
    // Chain: hover clickStart → pressed, pressed click → hover (NOT source)
    expect(conns).toContainEqual({ from: 'default-hover', to: 'default-pressed', trigger: 'clickStart' });
    expect(conns).toContainEqual({ from: 'default-pressed', to: 'default-hover', trigger: 'click' });

    // No direct source ↔ pressed
    expect(conns).not.toContainEqual({ from: 'default', to: 'default-pressed', trigger: 'clickStart' });
    expect(conns).not.toContainEqual({ from: 'default-pressed', to: 'default', trigger: 'click' });
    expect(conns).toHaveLength(4);

    // Both states exist now
    const configs = parseVariantConfig(projectFS.readFile(FILE)!);
    expect(hasInteractionState(configs, 'default', 'hover')).toBe(true);
    expect(hasInteractionState(configs, 'default', 'pressed')).toBe(true);
  });

  test('chain rewrite — adding hover when pressed exists rewrites pressed click → hover', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    // Step 1: pressed first → source clickStart → pressed, pressed click → source
    addInteractionState(FILE, 'default', 'pressed');
    let conns = parseConnections(projectFS.readFile(FILE)!);
    expect(conns).toContainEqual({ from: 'default-pressed', to: 'default', trigger: 'click' });

    // Step 2: hover — should rewrite pressed click → hover
    addInteractionState(FILE, 'default', 'hover');
    conns = parseConnections(projectFS.readFile(FILE)!);

    // Source clickStart → pressed STAYS
    expect(conns).toContainEqual({ from: 'default', to: 'default-pressed', trigger: 'clickStart' });
    // New: hover wired up
    expect(conns).toContainEqual({ from: 'default', to: 'default-hover', trigger: 'mouseEnter' });
    expect(conns).toContainEqual({ from: 'default-hover', to: 'default', trigger: 'mouseLeave' });
    expect(conns).toContainEqual({ from: 'default-hover', to: 'default-pressed', trigger: 'clickStart' });
    // Pressed click goes to HOVER now, not source
    expect(conns).toContainEqual({ from: 'default-pressed', to: 'default-hover', trigger: 'click' });
    expect(conns).not.toContainEqual({ from: 'default-pressed', to: 'default', trigger: 'click' });
  });

  test('positionOverride wins over default placement', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    addInteractionState(FILE, 'default', 'hover', { x: 1234, y: 5678 });
    const configs = parseVariantConfig(projectFS.readFile(FILE)!);
    const hover = configs.find(c => c.name === 'default-hover')!;
    expect(hover.x).toBe(1234);
    expect(hover.y).toBe(5678);
  });

  test('default placement tucks second state next to existing sibling', () => {
    resetProjectFS(new Map([[FILE, BASE_CODE]]));

    // First: hover lands at (default.x, default.y + 400 + 200) = (0, 600)
    addInteractionState(FILE, 'default', 'hover');
    let configs = parseVariantConfig(projectFS.readFile(FILE)!);
    const hover = configs.find(c => c.name === 'default-hover')!;
    expect(hover.x).toBe(0);
    expect(hover.y).toBe(600);

    // Second (no override): pressed should sit to the right of hover
    addInteractionState(FILE, 'default', 'pressed');
    configs = parseVariantConfig(projectFS.readFile(FILE)!);
    const pressed = configs.find(c => c.name === 'default-pressed')!;
    expect(pressed.x).toBe(hover.x + 600);
    expect(pressed.y).toBe(hover.y);
  });
});
