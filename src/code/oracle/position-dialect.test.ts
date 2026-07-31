import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

/** Wrap a body of elements in a valid page skeleton. */
const page = (rootChildren: string) => `'use client';

/** @canvas { "viewports": [], "positions": {} } */

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      ${rootChildren}
    </div>
  );
}`;

describe('position pin dialect', () => {
  it('bounces right/bottom percentages in inline styles (the glow-blob case)', () => {
    const code = page(`<div data-id="glow" data-name="Glow" style={{ position: 'absolute', right: '15%', top: '30%', width: '600px' }} />`);
    const vs = checkFile(code, { kind: 'page' });
    expect(codes(vs)).toContain('PIN_PERCENT_RIGHT_BOTTOM');
    expect(vs.find((x) => x.code === 'PIN_PERCENT_RIGHT_BOTTOM')?.message).toContain('px-only');
  });

  it('bounces bottom percentages hidden in ternary branches', () => {
    const code = page(`<div data-id="badge" style={{ position: 'absolute', bottom: true ? '10%' : '20px' }} />`);
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('PIN_PERCENT_RIGHT_BOTTOM');
  });

  it('bounces numeric-zero offsets (renders, but pins show unset)', () => {
    const code = page(`<header data-id="nav" style={{ position: 'absolute', top: 0, left: 0 }} />`);
    const vs = checkFile(code, { kind: 'page' });
    expect(codes(vs)).toContain('PIN_VALUE_NOT_PX');
    expect(codes(vs).filter((c) => c === 'PIN_VALUE_NOT_PX')).toHaveLength(2);
  });

  it('allows right/bottom in px, and left/top percentages', () => {
    const code = page(`<div data-id="pin" style={{ position: 'absolute', right: '24px', bottom: '40px', left: '10%', top: '5%' }} />`);
    expect(codes(checkFile(code, { kind: 'page' }))).not.toContain('PIN_PERCENT_RIGHT_BOTTOM');
  });

  it('allows the sanctioned centering pattern (left/top % + translate-only transform)', () => {
    const code = page(`<div data-id="center" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} />`);
    const vs = checkFile(code, { kind: 'page' });
    expect(codes(vs)).not.toContain('TRANSFORM_STRING');
    expect(codes(vs)).not.toContain('PIN_PERCENT_RIGHT_BOTTOM');
  });

  it('still bounces non-translate transform strings', () => {
    const code = page(`<div data-id="rot" style={{ transform: 'rotate(20deg) translateX(-50%)' }} />`);
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('TRANSFORM_STRING');
  });

  it("bounces the 'transparent' color keyword (color controls can't represent it)", () => {
    const code = page(`<button data-id="cta" style={{ backgroundColor: 'transparent', color: '#ffffff' }}>Go</button>`);
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('TRANSPARENT_COLOR');

    const ok = page(`<button data-id="cta" style={{ backgroundColor: 'rgba(0, 0, 0, 0)', color: '#ffffff' }}>Go</button>`);
    expect(codes(checkFile(ok, { kind: 'page' }))).not.toContain('TRANSPARENT_COLOR');
  });

  it('bounces the inset shorthand', () => {
    const code = page(`<div data-id="full" style={{ position: 'absolute', inset: '10px 20px' }} />`);
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('INSET_SHORTHAND');
  });

  it('bounces right/bottom percentages inside the responsive style block', () => {
    const code = page(`<style>{\`
      @media (max-width: 768px) {
        [data-id="glow"] { right: 8%; }
      }
    \`}</style>`);
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('PIN_PERCENT_RIGHT_BOTTOM');
  });

  it('bounces keyframe arrays in animate (Loop editor speaks single targets) but allows single-target loops', () => {
    const marquee = page(`<div data-id="ticker" style={{ display: 'flex' }}>
      <div data-id="ticker-inner" style={{ display: 'flex' }} animate={{ x: [0, -1200] }} transition={{ ease: 'linear', duration: 30, repeat: Infinity }} />
    </div>`);
    const vs = checkFile(marquee, { kind: 'page' });
    expect(codes(vs)).toContain('LOOP_KEYFRAME_ARRAY');
    expect(vs.find((x) => x.code === 'LOOP_KEYFRAME_ARRAY')!.message).toContain('Marquee');

    const single = page(`<div data-id="spinner" style={{ display: 'flex' }} animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: 'linear' }} />`);
    expect(codes(checkFile(single, { kind: 'page' }))).not.toContain('LOOP_KEYFRAME_ARRAY');
  });

  it('allows fixed on direct children of root, bounces it deeper', () => {
    const ok = page(`<header data-id="nav" style={{ position: 'fixed', top: '0px' }} />`);
    expect(codes(checkFile(ok, { kind: 'page' }))).not.toContain('FIXED_DEPTH');

    const nested = page(`<section data-id="wrap" style={{ display: 'flex' }}>
      <div data-id="float" style={{ position: 'fixed', top: '0px' }} />
    </section>`);
    expect(codes(checkFile(nested, { kind: 'page' }))).toContain('FIXED_DEPTH');
  });
});
