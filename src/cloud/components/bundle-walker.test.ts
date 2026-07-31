import { describe, it, expect, beforeEach } from 'vitest';
import { walkBundle, hasLocalDeps } from './bundle-walker';
import { projectFS } from '@/code/project/project-fs';

// Walks a synthetic projectFS to verify the bundle-walker correctly:
//   - finds transitive `@/components/X` deps
//   - finds transitive `@/icons/X` deps
//   - skips external imports (`react`, `framer-motion`, `@revyme/runtime`)
//   - reports missing deps without aborting the walk
//   - dedupes diamond deps (A imports B and C, both import D)
//   - terminates on cycles (A imports B, B imports A — visited-set guards)

beforeEach(() => {
  // Reset projectFS to empty between tests. The InMemoryProjectFS has
  // no public `clear()`, so we delete every existing path.
  for (const path of projectFS.listFiles()) {
    projectFS.deleteFile(path);
  }
});

const TSX_HEADER = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`;

describe('walkBundle', () => {
  it('returns just the root for a single-file design component (no deps)', () => {
    projectFS.writeFile('components/Frame.tsx', `${TSX_HEADER}
function Frame({ style }) { return <motion.div style={style} />; }
export default withResponsiveProps(Frame);
`);

    const result = walkBundle('components/Frame.tsx');

    expect(result.missing).toEqual([]);
    expect(result.files.map(f => f.path)).toEqual(['components/Frame.tsx']);
  });

  it('walks a diamond dep graph and dedupes', () => {
    // Hero → Card, Sidebar; Card → Button; Sidebar → Button
    // Expected: Hero, Card, Sidebar, Button (each visited exactly once).
    projectFS.writeFile('components/Hero.tsx', `${TSX_HEADER}
import Card from '@/components/Card';
import Sidebar from '@/components/Sidebar';
function Hero({ style }) { return <motion.div style={style}><Card /><Sidebar /></motion.div>; }
export default withResponsiveProps(Hero);
`);
    projectFS.writeFile('components/Card.tsx', `${TSX_HEADER}
import Button from '@/components/Button';
function Card() { return <Button />; }
export default withResponsiveProps(Card);
`);
    projectFS.writeFile('components/Sidebar.tsx', `${TSX_HEADER}
import Button from '@/components/Button';
function Sidebar() { return <Button />; }
export default withResponsiveProps(Sidebar);
`);
    projectFS.writeFile('components/Button.tsx', `${TSX_HEADER}
function Button() { return <motion.button />; }
export default withResponsiveProps(Button);
`);

    const result = walkBundle('components/Hero.tsx');

    expect(result.missing).toEqual([]);
    const paths = result.files.map(f => f.path).sort();
    expect(paths).toEqual([
      'components/Button.tsx',
      'components/Card.tsx',
      'components/Hero.tsx',
      'components/Sidebar.tsx',
    ]);
  });

  it('walks both `@/components/` and `@/icons/` imports', () => {
    projectFS.writeFile('components/Hero.tsx', `${TSX_HEADER}
import Logo from '@/icons/Logo';
function Hero() { return <Logo />; }
export default withResponsiveProps(Hero);
`);
    projectFS.writeFile('icons/Logo.tsx', `${TSX_HEADER}
function Logo() { return <svg />; }
export default Logo;
`);

    const result = walkBundle('components/Hero.tsx');

    expect(result.missing).toEqual([]);
    expect(result.files.map(f => f.path).sort()).toEqual([
      'components/Hero.tsx',
      'icons/Logo.tsx',
    ]);
  });

  it('walks an icon-rooted bundle with icon->icon deps', () => {
    projectFS.writeFile('icons/Wrapper.tsx', `${TSX_HEADER}
import Inner from '@/icons/Inner';
function Wrapper() { return <Inner />; }
export default Wrapper;
`);
    projectFS.writeFile('icons/Inner.tsx', `${TSX_HEADER}
function Inner() { return <svg />; }
export default Inner;
`);

    const result = walkBundle('icons/Wrapper.tsx');

    expect(result.missing).toEqual([]);
    expect(result.files.map(f => f.path).sort()).toEqual([
      'icons/Inner.tsx',
      'icons/Wrapper.tsx',
    ]);
  });

  it('skips external imports (no traversal into them)', () => {
    projectFS.writeFile('components/Hero.tsx', `${TSX_HEADER}
import { motion } from 'framer-motion';
import { withCursor } from '@revyme/runtime';
import * as gsap from 'gsap';
function Hero() { return <motion.div />; }
export default withResponsiveProps(Hero);
`);

    const result = walkBundle('components/Hero.tsx');

    // External imports are ignored — only the root remains.
    expect(result.files.map(f => f.path)).toEqual(['components/Hero.tsx']);
    expect(result.missing).toEqual([]);
  });

  it('reports missing deps without aborting the walk', () => {
    projectFS.writeFile('components/Hero.tsx', `${TSX_HEADER}
import Card from '@/components/Card';   // present
import Ghost from '@/components/Ghost'; // missing
function Hero() { return <><Card /><Ghost /></>; }
export default withResponsiveProps(Hero);
`);
    projectFS.writeFile('components/Card.tsx', `${TSX_HEADER}
function Card() { return null; }
export default withResponsiveProps(Card);
`);

    const result = walkBundle('components/Hero.tsx');

    expect(result.files.map(f => f.path).sort()).toEqual([
      'components/Card.tsx',
      'components/Hero.tsx',
    ]);
    expect(result.missing).toEqual(['components/Ghost.tsx']);
  });

  it('terminates on cycles (A → B → A)', () => {
    projectFS.writeFile('components/A.tsx', `${TSX_HEADER}
import B from '@/components/B';
function A() { return <B />; }
export default withResponsiveProps(A);
`);
    projectFS.writeFile('components/B.tsx', `${TSX_HEADER}
import A from '@/components/A';
function B() { return <A />; }
export default withResponsiveProps(B);
`);

    const result = walkBundle('components/A.tsx');

    expect(result.files.map(f => f.path).sort()).toEqual([
      'components/A.tsx',
      'components/B.tsx',
    ]);
  });

  it('respects maxFiles cap', () => {
    // Build a long chain Root → C1 → C2 → … → C20
    projectFS.writeFile('components/Root.tsx', `${TSX_HEADER}
import C1 from '@/components/C1';
function Root() { return <C1 />; }
export default withResponsiveProps(Root);
`);
    for (let i = 1; i <= 20; i++) {
      const next = i < 20 ? `import C${i + 1} from '@/components/C${i + 1}';` : '';
      projectFS.writeFile(`components/C${i}.tsx`, `${TSX_HEADER}
${next}
function C${i}() { return null; }
export default withResponsiveProps(C${i});
`);
    }

    const result = walkBundle('components/Root.tsx', /* maxFiles */ 5);

    expect(result.files.length).toBeLessThanOrEqual(5);
  });
});

describe('hasLocalDeps', () => {
  it('returns true when source contains @/components/ import', () => {
    expect(hasLocalDeps(`import X from '@/components/X';`)).toBe(true);
  });

  it('returns true when source contains @/icons/ import', () => {
    expect(hasLocalDeps(`import X from '@/icons/X';`)).toBe(true);
  });

  it('returns false for components with only external imports', () => {
    expect(hasLocalDeps(`
import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
`)).toBe(false);
  });

  it('returns false for empty source', () => {
    expect(hasLocalDeps('')).toBe(false);
  });
});
