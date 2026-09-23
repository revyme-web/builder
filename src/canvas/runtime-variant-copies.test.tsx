/** @vitest-environment node */
// Every breakpoint's variant, in the HTML the server sends.
//
// The pre-hydration stylesheet can restyle and hide what the server rendered,
// but not create what it didn't: a burger gated by `initialVariant ===
// 'variant-2'` is false on the server, so it only appeared at hydration (the
// residual flash after the 0.0.26 fix). Rendering one copy per distinct variant
// and letting CSS pick removes that — the reference builder's approach, except the copies live
// only in the render, never in the source.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { motion } from 'framer-motion';
import withResponsiveProps from '../../../runtime/src/withResponsiveProps';
import { planVariantCopies, copiesCss } from '../../../runtime/src/variant-ssr-copies';

function Navbar({ style, initialVariant = 'default', ...rest }: any) {
  return (
    <motion.div data-id="nav-root" {...rest} style={style}>
      {initialVariant !== 'variant-2' && <div data-id="links">Adidas Nike</div>}
      {initialVariant === 'variant-2' && <div data-id="burger">burger</div>}
    </motion.div>
  );
}
const W = withResponsiveProps(Navbar as any);
const RESP = JSON.stringify({ 450: { initialVariant: 'variant-2' }, 810: { initialVariant: 'variant-1' }, _bp: [450, 810, 1440] });

describe('planVariantCopies', () => {
  it('is one copy per DISTINCT variant, widest first', () => {
    const c = planVariantCopies({ 450: 'variant-2', 810: 'variant-1' }, 'default', 'nav-1');
    expect(c.map((x) => x.variant)).toEqual(['default', 'variant-1', 'variant-2']);
    expect(c[0].maxWidth).toBeNull();          // the base design, widest
    expect(c[2].maxWidth).toBe(450);
  });

  it('shares ONE copy between bands that render the same variant', () => {
    // Tablet and phone both show the mobile design — the reference builder ships two copies
    // here, not three, and so do we.
    const c = planVariantCopies({ 450: 'variant-2', 810: 'variant-2' }, 'default', 'nav-1');
    expect(c.map((x) => x.variant)).toEqual(['default', 'variant-2']);
    expect(c[1].maxWidth).toBe(810);           // spans both bands
  });

  it('makes no copies when every band shows the same design', () => {
    expect(planVariantCopies({ 450: 'default' }, 'default', 'nav-1')).toEqual([]);
    expect(planVariantCopies({}, 'default', 'nav-1')).toEqual([]);
  });

  it('hides each copy outside its own band', () => {
    const css = copiesCss(planVariantCopies({ 450: 'variant-2' }, 'default', 'nav-1'));
    expect(css).toContain('@media (max-width: 450px)');    // hides the base
    expect(css).toContain('@media (min-width: 450.02px)'); // hides the mobile copy
  });
});

describe('the server HTML', () => {
  const html = renderToString(<W data-id="nav-1" data-responsive={RESP} />);

  it('carries BOTH the desktop links and the mobile burger', () => {
    expect(html).toContain('Adidas Nike');
    expect(html).toContain('burger');
  });

  it('ships the media queries that pick between them', () => {
    expect(html).toContain('display: none !important');
    expect(html).toMatch(/@media \(max-width: 450px\)/);
  });

  it('wraps each copy in a layout-neutral display:contents span', () => {
    expect(html.match(/display:contents/g)?.length).toBe(3);   // one per distinct variant
  });
});

// ANIMATED instances used to be excluded — several copies would have handed
// framer-motion several targets for one scroll effect, so they fell back to a
// pre-hydration stylesheet that could restyle but never create the mobile-only
// element. Now the copies go INSIDE the wrapper: one ref, one set of
// MotionValues, every variant beneath it. That retired the stylesheet and the
// generated statics it needed.
describe('an animated instance (forwarded ref / MotionValues)', () => {
  const ref = React.createRef<HTMLDivElement>();
  const html = renderToString(<W ref={ref} data-id="nav-1" data-responsive={RESP} />);

  it('still ships every variant', () => {
    expect(html).toContain('Adidas Nike');
    expect(html).toContain('burger');
  });

  it('keeps ONE wrapper — the single target a scroll effect measures', () => {
    // The copies sit INSIDE it, so the markup opens with the wrapper and the
    // `display: contents` spans are nested. (Each copy's root also carries the
    // instance id — deliberate, so per-viewport `[data-id]` rules still hit it —
    // hence the structural check rather than counting ids.)
    expect(html.startsWith('<div data-id="nav-1"')).toBe(true);
    const firstSpan = html.indexOf('display:contents');
    const firstClose = html.indexOf('</div>');
    expect(firstSpan).toBeGreaterThan(0);
    expect(firstSpan).toBeLessThan(firstClose);   // nested, not a sibling
  });
});
