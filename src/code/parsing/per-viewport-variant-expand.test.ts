// per-viewport-variant-expand.test.ts — a per-viewport VARIANT variable on a component instance
// (`initialVariant={__mq2 ? tabletVar : baseVar}`) must resolve to the expanded node's
// responsiveVariantMap[vpWidth] so the canvas switches the variant PER TILE.
import { describe, it, expect } from 'vitest';
import { parseProjectFile } from './project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';

const BTN_TSX = `
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }];
const btnVariants = { default: { backgroundColor: 'red' }, 'variant-1': { backgroundColor: 'blue' } };
function Button({ style, initialVariant = 'default' }) {
  return <LayoutGroup><motion.div data-id="btn" data-name="Button" variants={btnVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} style={{ position: 'relative', width: '100px', height: '40px', ...style }}></motion.div></LayoutGroup>;
}
export default withResponsiveProps(Button);
`;

const LAYOUT_TSX = `'use client';
/** @pageVariables { "variables": [
  { "name": "btnTabletVar", "type": "text", "default": "variant-1" },
  { "name": "btnBaseVar", "type": "text", "default": "default" }
] } */
import React, { useState } from 'react';
import Button from '@/components/Button';
function useMediaQuery(q) { const [m] = useState(false); return m; }
export default function LayoutClient({ btnTabletVar = "variant-1", btnBaseVar = "default" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="root" data-name="Layout" style={{ position: 'relative' }}>
    <Button data-id="btn1" data-name="Button" style={{ position: 'relative' }} initialVariant={__mq2 ? btnTabletVar : btnBaseVar} />
  </div>;
}
`;

function makeFS() {
  return new InMemoryProjectFS(new Map([
    ['app/layout-client.tsx', LAYOUT_TSX],
    ['components/Button.tsx', BTN_TSX],
  ]));
}

describe('per-viewport variant variable → responsiveVariantMap on the expanded canvas node', () => {
  it('resolves the tablet variant variable (default → variant-1) into responsiveVariantMap[768]', () => {
    const nodes = parseProjectFile('app/layout-client.tsx', makeFS());
    // The expanded Button root carries the per-tile variant map.
    let root: any = null;
    for (const [, n] of nodes) {
      if (n.responsiveVariantMap && n.responsiveVariantMap[768]) { root = n; break; }
    }
    expect(root).toBeTruthy();
    expect(root!.responsiveVariantMap![768]).toBe('variant-1'); // tablet tile → variant-1 (the per-viewport var's value)
    // CRITICAL: the inline-ternary per-viewport variant must NOT clear motionVariants (the expansion's
    // parent-driven clear keyed on data-responsive only, wrongly wiping the variant styles for the inline
    // rail → the tile resolved 'variant-1' but had no entry → fell back to the baked default). The
    // 'variant-1' entry (its styles) MUST survive so resolveVariantStyles can paint it.
    expect(root!.motionVariants?.['variant-1']).toBeTruthy();
    expect(root!.motionVariants!['variant-1'].backgroundColor).toBe('blue');
  });
});
