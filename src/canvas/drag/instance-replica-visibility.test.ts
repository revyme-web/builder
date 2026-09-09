// instance-replica-visibility.test.ts — the unhide value an instance entering a
// replica restores in the entered band (never `unset`: the canvas wrapper <div>
// would collapse to inline; never a blind `block`: the live band rule lands on
// the master ROOT, whose own display must come back).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryProjectFS } from '@/code/project/project-fs';
import { isInstanceLike, instanceReplicaUnhideDisplay } from './instance-replica-visibility';

vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));

const FLEX_MASTER = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function Card({ style, ...rest }) {
  return (
    <motion.div data-id="card-root" {...rest} style={{ position: 'relative', display: 'flex', gap: '8px', ...style }}>
      <p data-id="card-text" style={{ position: 'relative' }}>Card</p>
    </motion.div>
  );
}
export default withResponsiveProps(Card);
`;

const NO_DISPLAY_MASTER = FLEX_MASTER.replace("display: 'flex', gap: '8px', ", '');

function fsWith(files: Record<string, string>): InMemoryProjectFS {
  return new InMemoryProjectFS(new Map(Object.entries(files)));
}

describe('isInstanceLike', () => {
  it('design instances, code components and componentFile-bearing tags are instances', () => {
    expect(isInstanceLike({ type: 'Card', isComponentInstance: true })).toBe(true);
    expect(isInstanceLike({ type: 'Shader', isCodeComponent: true })).toBe(true);
    expect(isInstanceLike({ type: 'Card', componentFile: 'components/Card.tsx' })).toBe(true);
  });
  it('plain tags and expansion DESCENDANTS are not', () => {
    expect(isInstanceLike({ type: 'div' })).toBe(false);
    expect(isInstanceLike({ type: 'Link' })).toBe(false);
    // A descendant inside an expansion carries the instance id — it is not the tag.
    expect(isInstanceLike({ type: 'div', componentFile: 'components/Card.tsx', componentInstanceId: 'inst-1' })).toBe(false);
    expect(isInstanceLike(null)).toBe(false);
  });
});

describe('instanceReplicaUnhideDisplay', () => {
  it("the tag's own authored display wins", () => {
    expect(instanceReplicaUnhideDisplay({ type: 'Card', isComponentInstance: true, styles: { display: 'grid' } }, null, fsWith({}))).toBe('grid');
  });

  it("the replica-entry hide baseline (`none`) on the tag is NOT an authored display", () => {
    const nodes = new Map([
      ['inst-1:card-root', { componentInstanceId: 'inst-1', isComponentRoot: true, styles: { display: 'flex' } }],
    ]);
    const node = { type: 'Card', isComponentInstance: true, styles: { display: 'none' }, children: ['inst-1:card-root'] };
    expect(instanceReplicaUnhideDisplay(node, nodes, fsWith({}))).toBe('flex');
  });

  it('reads the expanded root from the node cache (design instance on the canvas)', () => {
    const nodes = new Map([
      ['inst-1:card-root', { componentInstanceId: 'inst-1', isComponentRoot: true, styles: { display: 'grid' } }],
    ]);
    const node = { type: 'Card', isComponentInstance: true, styles: { position: 'absolute' }, children: ['inst-1:card-root'] };
    expect(instanceReplicaUnhideDisplay(node, nodes, fsWith({}))).toBe('grid');
  });

  it('falls back to the master FILE root when the cache has no expansion (paste / toolbar)', () => {
    const fs = fsWith({ 'components/Card.tsx': FLEX_MASTER });
    expect(instanceReplicaUnhideDisplay({ type: 'Card', componentFile: 'components/Card.tsx', styles: {} }, null, fs)).toBe('flex');
    // By tag name through the component registry when no file is known.
    expect(instanceReplicaUnhideDisplay({ type: 'Card', isComponentInstance: true, styles: {} }, null, fs)).toBe('flex');
  });

  it('a master root with no display of its own → block', () => {
    const fs = fsWith({ 'components/Card.tsx': NO_DISPLAY_MASTER });
    expect(instanceReplicaUnhideDisplay({ type: 'Card', componentFile: 'components/Card.tsx', styles: {} }, null, fs)).toBe('block');
  });

  it('a LOCAL code component parses its own root display (never a blind block)', () => {
    // Its root is a plain element we can read — forcing `block` on a flex (or
    // inline) root broke the layout on the very tile the instance shows on.
    const fs = fsWith({ 'components/Shader.tsx': FLEX_MASTER });
    expect(instanceReplicaUnhideDisplay({ type: 'Shader', isCodeComponent: true, componentFile: 'components/Shader.tsx', styles: {} }, null, fs)).toBe('flex');
  });

  it('a CDN component → block: its source is fetched async (and may be closed), so the root is unknowable at drop time', () => {
    expect(instanceReplicaUnhideDisplay({ type: 'Widget', isComponentInstance: true, componentFile: 'https://cdn.example.com/widget.js', styles: {} }, null, fsWith({}))).toBe('block');
    expect(instanceReplicaUnhideDisplay({ type: 'Widget', isCodeComponent: true, componentFile: 'https://assets.revyme.app/components/abc.js', styles: {} }, null, fsWith({}))).toBe('block');
  });

  it('keyword resets on the root never leak into the band (they collapse the wrapper)', () => {
    const nodes = new Map([
      ['inst-1:card-root', { componentInstanceId: 'inst-1', isComponentRoot: true, styles: { display: 'unset' } }],
    ]);
    const node = { type: 'Card', isComponentInstance: true, styles: {}, children: ['inst-1:card-root'] };
    expect(instanceReplicaUnhideDisplay(node, nodes, fsWith({}))).toBe('block');
  });
});
