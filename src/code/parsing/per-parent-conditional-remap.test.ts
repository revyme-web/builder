import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { parseProjectFile, clearComponentParseCache } from './project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';
import { resolveVariantStyles } from '@/canvas/Renderer';
import type { CanvasNode } from './parser';

// The LeCeJo shape: LAYOUT props (flexDirection) live as inline `variant === 'x'`
// ternaries → parser folds them into conditionalStyles keyed by the CHILD's OWN
// variant names. A `visible` child hides on variant-4 via AnimatePresence.
const CHILD = `'use client';
import { motion, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-4' }];
function LeCeJo({ style, initialVariant = 'default' }) {
  return <motion.div data-id="lc-root" data-name="LeCeJo"
    initial={['default', initialVariant]} animate={['default', initialVariant]}
    variants={{ default: {}, 'variant-4': {} }}
    style={{ position: 'absolute', width: '921px', height: '418px', display: 'flex', flexDirection: initialVariant === 'variant-4' ? 'column' : 'row', ...style }}>
    <AnimatePresence>{initialVariant !== 'variant-4' && <motion.p data-id="lc-caption" data-name="Caption" style={{ position: 'relative', width: 'auto', height: 'auto' }}>row-only</motion.p>}</AnimatePresence>
  </motion.div>;
}
export default withResponsiveProps(LeCeJo);`;

// The Make-Component output shape: nested instance mapped to the child's
// responsive variant per PARENT variant via the initialVariant ternary.
const PARENT = `'use client';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import LeCeJo from '@/components/LeCeJo';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'variant-1' }, { name: 'variant-2' }];
function Section({ style, initialVariant = 'default' }) {
  return <motion.div data-id="sec-root" data-name="Section" style={{ position: 'absolute', width: '1440px', height: 'min-content', display: 'flex', flexDirection: 'column', ...style }}>
    <LeCeJo initialVariant={initialVariant === 'variant-1' ? 'variant-4' : initialVariant === 'variant-2' ? 'variant-4' : 'default'} data-responsive='{"375":{"initialVariant":"variant-4"},"768":{"initialVariant":"variant-4"},"_bp":[375,768,1440]}' data-id="lc" data-name="Frame" style={{ order: '1', position: 'relative' }} />
  </motion.div>;
}
export default withResponsiveProps(Section);`;

function expandParent(): Map<string, CanvasNode> {
  clearComponentParseCache();
  const fs = new InMemoryProjectFS(new Map([
    ['components/Section.tsx', PARENT],
    ['components/LeCeJo.tsx', CHILD],
  ]));
  return parseProjectFile('components/Section.tsx', fs);
}

// ─── conditionalStyles + hiddenOnVariants remap by PARENT variant ────────────
// motionVariants were already remapped; layout ternaries (conditionalStyles)
// and AnimatePresence visibility (hiddenOnVariants) were NOT — inside the
// master the tiles resolve with PARENT variant names, so the child's
// `{'variant-4': 'column'}` never matched and every tile rendered the row
// (user report 2026-07-28: canvas row, live preview column).
describe('expandComponent — per-parent remap of conditionalStyles + hiddenOnVariants', () => {
  it('remaps the flexDirection ternary to parent variant keys', () => {
    const nodes = expandParent();
    const rootId = [...nodes.keys()].find(k => k.endsWith(':lc-root'))!;
    const node = nodes.get(rootId)!;
    const fd = node.conditionalStyles?.flexDirection as Record<string, string> | undefined;
    expect(fd).toBeTruthy();
    expect(fd!['variant-1']).toBe('column');
    expect(fd!['variant-2']).toBe('column');
    expect(fd!['variant-4']).toBeUndefined(); // child-name keys are gone
    // The renderer resolves per PARENT tile: variant-1/2 → column, default → base row.
    expect(resolveVariantStyles(node, 'variant-1').flexDirection).toBe('column');
    expect(resolveVariantStyles(node, 'variant-2').flexDirection).toBe('column');
    expect(resolveVariantStyles(node, 'default').flexDirection ?? node.styles.flexDirection).toBe('row');
  });

  it('remaps hiddenOnVariants: the row-only caption hides on the mapped parent tiles', () => {
    const nodes = expandParent();
    const capId = [...nodes.keys()].find(k => k.endsWith(':lc-caption'))!;
    const hidden = nodes.get(capId)!.hiddenOnVariants;
    expect(hidden?.has('variant-1')).toBe(true);
    expect(hidden?.has('variant-2')).toBe(true);
    expect(hidden?.has('default') ?? false).toBe(false);
  });
});
