// scroll-variant-render.test.ts — a scroll-variant instance must render its BASE
// (default) variant on the static canvas, NOT an empty shell AND NOT the scroll `from`.
// The instance's `initialVariant={…Sv}` is a runtime expression the parser can't resolve;
// Scroll Variant is RUNTIME-only config, so its `from`/`to` must NOT repaint the canvas
// (changing From used to repaint every tile). The canvas falls back to the component's
// base styles (which carry the default variant's values).
import { describe, it, expect } from 'vitest';
import { parseProjectFile } from './project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';

const COMPONENT = `
import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const heroVariants = {
  default: { backgroundColor: '#ff0000' },
  'variant-1': { backgroundColor: '#0000ff' },
};
function Hero({ style, initialVariant = 'default', ref }: { style?: React.CSSProperties; initialVariant?: string; ref?: React.Ref<any> }) {
  return (
    <LayoutGroup><MotionConfig>
      <motion.div data-id="hero-root" ref={ref} data-name="Hero" variants={heroVariants}
        initial={initialVariant} animate={initialVariant}
        style={{ position: 'absolute', width: '300px', height: '200px', backgroundColor: '#ff0000', ...style }}>
        <p data-id="hero-title" style={{ position: 'relative', fontSize: '20px' }}>Hi</p>
      </motion.div>
    </MotionConfig></LayoutGroup>
  );
}
export default withResponsiveProps(Hero);
`;

function pageWith(from: string) {
  return `
import React, { useRef } from 'react';
import { useInView } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  const heroSvRef = useRef(null);
  const heroSvInView = useInView(heroSvRef, { margin: '0px 0px -90% 0px' });
  const heroSv = heroSvInView ? 'variant-1' : '${from}';
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <Hero data-scroll-variant='{"trigger":"layerInView","from":"${from}","to":"variant-1","start":"top","replay":true}' ref={heroSvRef} initialVariant={heroSv} data-id="hero1" data-name="Hero" style={{ position: 'absolute', left: '170px', top: '313px' }} />
    </div>
  );
}
`;
}

function fs(from: string) {
  return new InMemoryProjectFS(new Map([
    ['app/page.tsx', pageWith(from)],
    ['components/Hero.tsx', COMPONENT],
  ]));
}

describe('Scroll Variant — static render shows the BASE variant (not the scroll `from`)', () => {
  it('renders the instance (not an empty shell) with the BASE/default variant styles', () => {
    const nodes = parseProjectFile('app/page.tsx', fs('default'));
    const root = nodes.get('hero1:hero-root');
    expect(root).toBeDefined();                       // not an empty shell
    expect(root!.styles.backgroundColor).toBe('#ff0000'); // default variant base
    // children still expand
    expect(nodes.get('hero1:hero-title')).toBeDefined();
  });

  it('a non-default `from` (variant-1) does NOT repaint the canvas — stays on the base', () => {
    // Scroll `from` is runtime-only; the static canvas keeps the base (default) variant.
    const nodes = parseProjectFile('app/page.tsx', fs('variant-1'));
    const root = nodes.get('hero1:hero-root');
    expect(root).toBeDefined();
    expect(root!.styles.backgroundColor).toBe('#ff0000'); // base/default — NOT variant-1's #0000ff
  });

  // canvasVariant = the explicit display choice the user had when the Scroll Variant was
  // added. It's preserved INDEPENDENTLY of from/to, so the static canvas keeps showing the
  // user's pick (here variant-1 → #0000ff), and changing from/to never repaints it.
  it('renders the spec\'s `canvasVariant` (the preserved user pick), independent of `from`', () => {
    const page = `
import React, { useState } from 'react';
import { useScroll } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  const [heroSv, setHeroSv] = useState('default');
  const { scrollY } = useScroll();
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <Hero data-scroll-variant='{"trigger":"onScroll","from":"default","to":"variant-1","direction":"down","replay":true,"canvasVariant":"variant-1"}' initialVariant={heroSv} data-id="hero1" data-name="Hero" style={{ position: 'absolute', left: '170px', top: '313px' }} />
    </div>
  );
}
`;
    const projFs = new InMemoryProjectFS(new Map([
      ['app/page.tsx', page],
      ['components/Hero.tsx', COMPONENT],
    ]));
    const nodes = parseProjectFile('app/page.tsx', projFs);
    const root = nodes.get('hero1:hero-root');
    expect(root).toBeDefined();
    // canvasVariant=variant-1 wins over the scroll `from`=default → variant-1 styles on canvas.
    expect(root!.styles.backgroundColor).toBe('#0000ff');
  });
});
