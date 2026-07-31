// motion-svg-variant-position.test.tsx — EMPIRICAL PINS of framer-motion's SVG
// variant-position mechanics (probe session 2026-06-11). The whole per-variant
// group-child position system (replica-context leftTopToXY deltas + the
// orchestrator's detach compensation + the Renderer fold) is built on these two
// facts. If either test starts failing after a framer-motion upgrade, the
// semantics must be revisited.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { motion } from 'framer-motion';

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function mount(variants: Record<string, Record<string, number>>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const App = ({ v }: { v: string }) => (
    <motion.svg viewBox="0 0 461 110" style={{ position: 'absolute', overflow: 'visible' }}>
      <motion.svg data-probe="child" variants={variants} initial="default" animate={v}
        x="-34" y="-35" width="200" height="61" viewBox="0 0 200 61" overflow="visible"
        transition={{ duration: 0 }}>
        <polygon points="100,0 200,61 0,61" fill="#3b82f6" />
      </motion.svg>
    </motion.svg>
  );
  return { root, host, App };
}

describe('framer-motion SVG variant position facts (nested motion.svg)', () => {
  it('FACT 1: plain x/y variants apply as a TRANSLATE transform, base attrs untouched', async () => {
    const { root, host, App } = mount({ default: { x: 0, y: 0 }, 'variant-1': { x: -24, y: 145 } });
    await act(async () => { root.render(<App v="default" />); });
    await act(async () => { await raf(); await raf(); });
    const el = host.querySelector('[data-probe="child"]') as SVGElement;
    await act(async () => { root.render(<App v="variant-1" />); });
    for (let i = 0; i < 12; i++) await act(async () => { await raf(); });
    expect(el.style.transform).toContain('translateX(-24px)');
    expect(el.style.transform).toContain('translateY(145px)');
    expect(el.getAttribute('x')).toBe('-34');
  });

  it('FACT 2: attrX/attrY in variants are IGNORED — never use them for per-variant positions', async () => {
    const { root, host, App } = mount({ default: { attrX: -34, attrY: -35 }, 'variant-1': { attrX: -58, attrY: 110 } });
    await act(async () => { root.render(<App v="default" />); });
    await act(async () => { await raf(); await raf(); });
    const el = host.querySelector('[data-probe="child"]') as SVGElement;
    await act(async () => { root.render(<App v="variant-1" />); });
    for (let i = 0; i < 12; i++) await act(async () => { await raf(); });
    expect(el.getAttribute('x')).toBe('-34');
    expect(el.style.transform || '').not.toContain('-58');
  });
});

describe('framer-motion SVG variant rotation facts (nested motion.svg)', () => {
  it('FACT 3: rotate in variants → style.transform rotate + motion-computed transformOrigin (no orbit)', async () => {
    const { root, host, App } = (() => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const variants = { default: { rotate: 0 }, 'variant-1': { rotate: 139.5 } };
      const App = ({ v }: { v: string }) => (
        <motion.svg viewBox="0 0 413 314" style={{ position: 'absolute', overflow: 'visible' }}>
          <motion.svg data-probe="rchild" variants={variants} initial="default" animate={v}
            x="317" y="197" width="143" height="79" viewBox="0 0 143 79" overflow="visible"
            transition={{ duration: 0 }}>
            <polygon points="71.5,0 143,79 0,79" fill="#3b82f6" />
          </motion.svg>
        </motion.svg>
      );
      return { root, host, App };
    })();
    await act(async () => { root.render(<App v="default" />); });
    await act(async () => { await raf(); await raf(); });
    const el = host.querySelector('[data-probe="rchild"]') as SVGElement;
    await act(async () => { root.render(<App v="variant-1" />); });
    for (let i = 0; i < 12; i++) await act(async () => { await raf(); });
    console.log('ROTATE style.transform=', el.style.transform, '| transformOrigin=', el.style.transformOrigin, '| transformBox=', (el.style as any).transformBox, '| attr-transform=', el.getAttribute('transform'));
    expect(el.style.transform).toContain('rotate(139.5deg)');
  });
});

describe('framer-motion SVG variant SIZE facts (nested motion.svg)', () => {
  const mountSize = (variants: Record<string, Record<string, unknown>>) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const App = ({ v }: { v: string }) => (
      <motion.svg viewBox="0 0 410 215" style={{ position: 'absolute', overflow: 'visible' }}>
        <motion.svg data-probe="schild" variants={variants as any} initial="default" animate={v}
          x="0" y="0" width="224" height="143" viewBox="0 0 370 143" overflow="visible"
          transition={{ duration: 0 }}>
          <path d="M0 0 L100 100" stroke="#aaa" />
        </motion.svg>
      </motion.svg>
    );
    return { root, host, App };
  };

  it('FACT 4: width in variants lands as style.width — which Chromium does NOT paint on a nested svg', async () => {
    // jsdom shows WHERE motion puts the value (style.width, attrs untouched).
    // A real-Chromium probe (playwright, 2026-06-12) showed that CSS
    // width/height on a NESTED <svg> are NOT painted — getBoundingClientRect
    // stayed at the attr size for style.width, even with !important; only the
    // ATTRIBUTE (and transforms) paint. So width/height in variant entries are
    // a DEAD channel for svg group children on BOTH renderers — per-variant
    // size must ride scaleX/scaleY (FACT 5), the same way the reference scales
    // vectors.
    const { root, host, App } = mountSize({ default: { x: 0 }, 'variant-1': { width: '341px', x: 0 } });
    await act(async () => { root.render(<App v="default" />); });
    await act(async () => { await raf(); await raf(); });
    const el = host.querySelector('[data-probe="schild"]') as SVGElement;
    await act(async () => { root.render(<App v="variant-1" />); });
    for (let i = 0; i < 12; i++) await act(async () => { await raf(); });
    expect(el.style.width).toBe('341px');      // motion wrote it...
    expect(el.getAttribute('width')).toBe('224'); // ...but never to the attr that paints
  });

  it('FACT 5: scaleX in variants → style.transform scaleX (the live-true size channel)', async () => {
    const { root, host, App } = mountSize({ default: { scaleX: 1, x: 0 }, 'variant-1': { scaleX: 1.5223, x: 58.5 } });
    await act(async () => { root.render(<App v="default" />); });
    await act(async () => { await raf(); await raf(); });
    const el = host.querySelector('[data-probe="schild"]') as SVGElement;
    await act(async () => { root.render(<App v="variant-1" />); });
    for (let i = 0; i < 12; i++) await act(async () => { await raf(); });
    expect(el.style.transform).toContain('scaleX(1.5223)');
    expect(el.style.transform).toContain('translateX(58.5px)');
    expect(el.getAttribute('width')).toBe('224');
  });
});
