// @vitest-environment jsdom
// EMPIRICAL PIN: how the canvas tile painter treats per-variant SIZE on an
// svg GROUP CHILD. Real parser + real renderNodes on the live YuReKa shape.
//
// The LEGACY width-px entry lands as style.width — which Chromium does NOT
// paint on a nested <svg> (real-browser probe 2026-06-12; jsdom can't see
// painting, so the first tests only pin WHERE the value goes). The REAL size
// channel is scaleX/scaleY folded into the style transform — pinned last.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/code/project/project-fs', () => ({
  projectFS: {
    readFile: () => '', listFiles: () => [], exists: () => false,
    writeFile: () => {}, deleteFile: () => {},
  },
}));

import { parseJSXToNodes } from '@/code/parsing/parser';
import { renderNodes } from '@/canvas/Renderer';

const CODE = `'use client';
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [{ name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true }, { name: 'variant-1', label: 'Frame', x: 977, y: 0 }];
const vectorMqa48i655Variants = {
  default: { left: '184px', top: '137px' },
};
const pathMqa484iy1Variants = {
  default: { x: 0, y: 0 },
  'variant-1': { width: '341px', x: 0, y: 0 },
};

function YuReKa({ style, initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-mqa0cxy2-4" data-name="Frame" style={{ position: 'absolute', width: '777px', height: '488px', backgroundColor: '#ffb3ba', overflow: 'hidden', ...style }} animate={variant}>
    <motion.svg data-id="vector-mqa48i65-5" variants={vectorMqa48i655Variants} initial={initialVariant} animate={variant} data-name="Group" viewBox="0 0 410 215" preserveAspectRatio="none" style={{ position: 'absolute', left: '184px', top: '137px', width: '410px', height: '215px', overflow: "visible" }}><motion.svg data-id="path-mqa484iy-1" variants={pathMqa484iy1Variants} initial={initialVariant} animate={variant} data-name="Path" x="0" y="0" width="224" height="143" viewBox="0 0 370 143" preserveAspectRatio="none" overflow="visible" style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}>
    <path data-id="path-mqa484iy-1-g0" d="M 125.40053 0 L 369.362897 20.093294 z" fill="none" stroke="#AAAAAA" strokeWidth="16"></path>
  </motion.svg></motion.svg>
  </motion.div>
    </LayoutGroup>;
}
export default withResponsiveProps(YuReKa);
`;

describe('variant tile paints svg group-child width from the variant entry', () => {
  it('variant-1 tile: squiggle wrapper gets style.width 341px', () => {
    // jsdom lacks CSS.escape (used by applyStrokeAlignment selectors).
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const nodes = parseJSXToNodes(CODE);
    const squiggle = nodes.get('path-mqa484iy-1');
    console.log('PARSED motionVariants:', JSON.stringify(squiggle?.motionVariants));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 777, x: 0, y: 0, isPrimary: true },
      { id: 'variant-1', width: 777, x: 977, y: 0 },
    ] as any;
    renderNodes(container, nodes, null, () => {}, viewports, CODE);
    const tileEl = container.querySelector('[data-node-id="variant-1-path-mqa484iy-1"]') as SVGElement | null;
    const primaryEl = container.querySelector('[data-node-id="path-mqa484iy-1"]') as SVGElement | null;
    console.log('TILE  style.width:', JSON.stringify(tileEl?.style.width), '| attr width:', tileEl?.getAttribute('width'), '| transform:', JSON.stringify(tileEl?.style.transform));
    console.log('PRIM  style.width:', JSON.stringify(primaryEl?.style.width), '| attr width:', primaryEl?.getAttribute('width'));
    expect(tileEl).toBeTruthy();
    expect(tileEl!.style.width).toBe('341px');
    expect(primaryEl!.style.width).toBe('');
  });

  it('PATCH transition: width added to an already-rendered tile applies on re-render', () => {
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const BEFORE = CODE.replace("'variant-1': { width: '341px', x: 0, y: 0 }", "'variant-1': { x: 0, y: 0 }");
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 777, x: 0, y: 0, isPrimary: true },
      { id: 'variant-1', width: 777, x: 977, y: 0 },
    ] as any;
    // First render — no width override yet (the pre-resize state).
    renderNodes(container, parseJSXToNodes(BEFORE), null, () => {}, viewports, BEFORE);
    const tileEl = container.querySelector('[data-node-id="variant-1-path-mqa484iy-1"]') as SVGElement;
    expect(tileEl.style.width).toBe('');
    // Second render — the committed width arrives (post-flush re-render).
    renderNodes(container, parseJSXToNodes(CODE), null, () => {}, viewports, CODE);
    const tileEl2 = container.querySelector('[data-node-id="variant-1-path-mqa484iy-1"]') as SVGElement;
    expect(tileEl2).toBe(tileEl); // patched in place, not rebuilt
    console.log('PATCHED tile style.width:', JSON.stringify(tileEl2.style.width));
    expect(tileEl2.style.width).toBe('341px');
    // And removing it clears the inline style (stale-clear).
    renderNodes(container, parseJSXToNodes(BEFORE), null, () => {}, viewports, BEFORE);
    expect(tileEl2.style.width).toBe('');
  });

  it('SCALE channel: scaleX/x in the variant entry fold into the tile transform', () => {
    (globalThis as any).CSS = (globalThis as any).CSS ?? {};
    (globalThis as any).CSS.escape = (globalThis as any).CSS.escape ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
    const SCALED = CODE.replace(
      "'variant-1': { width: '341px', x: 0, y: 0 }",
      "'variant-1': { scaleX: 1.5223, x: 58.5, y: 0 }",
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const viewports = [
      { id: 'desktop', width: 777, x: 0, y: 0, isPrimary: true },
      { id: 'variant-1', width: 777, x: 977, y: 0 },
    ] as any;
    renderNodes(container, parseJSXToNodes(SCALED), null, () => {}, viewports, SCALED);
    const tileEl = container.querySelector('[data-node-id="variant-1-path-mqa484iy-1"]') as SVGElement;
    expect(tileEl.style.transform).toContain('scaleX(1.5223)');
    expect(tileEl.style.transform).toContain('translateX(58.5px)');
    // base attrs untouched (shared geometry), no dead CSS width
    expect(tileEl.getAttribute('width')).toBe('224');
    expect(tileEl.style.width).toBe('');
    // the carrier from source styles is painted inline
    expect((tileEl.style as any).transformBox).toBe('fill-box');
    // primary tile is neutral (scaleX: 1 default folds to nothing or identity)
    const primaryEl = container.querySelector('[data-node-id="path-mqa484iy-1"]') as SVGElement;
    expect(primaryEl.style.transform || '').not.toContain('scaleX(1.5223)');
  });
});
