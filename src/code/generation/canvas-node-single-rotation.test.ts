// The canvas applies BOTH the `transform` string and the `rotate` property, so
// a node carrying the same angle in both is rotated twice: -190.3° became
// -380.6°, a 180° flip that made a flex column's children look reordered on
// drag-out (user report 2026-09-20).
//
// The two writes happen in DIFFERENT mutations of one flush — the move's fold
// writes `rotate` while no transform exists yet, the drag's own updateStyles
// adds the `transform` after — so this is a sweep over the finished batch.

import { describe, it, expect } from 'vitest';
import { enforceSingleRotationChannelInCode } from './generator-crud';

const WRAP = (style: string) => `'use client';
import React from 'react';
const canvasNodes = <>
  <div data-id="box" data-canvas-node="true" style={{${style}}} />
</>;
`;

const styleOf = (code: string) => code.match(/style=\{\{([\s\S]*?)\}\}/)?.[1] ?? '';

describe('enforceSingleRotationChannelInCode', () => {
  it('drops `rotate` when `transform` already rotates', () => {
    const out = enforceSingleRotationChannelInCode(WRAP(
      ` width: '10px', rotate: "-190.3", transform: 'rotate(-190.3deg) skewX(0deg)' `,
    ));
    expect(styleOf(out)).not.toMatch(/rotate:\s*["']/);
    expect(styleOf(out)).toMatch(/transform:/);
    expect(styleOf(out)).toMatch(/width/);
  });

  it('keeps `rotate` when the transform carries no rotation', () => {
    const src = WRAP(` rotate: "45", transform: 'translateX(-50%)' `);
    expect(enforceSingleRotationChannelInCode(src)).toBe(src);
  });

  it('keeps `rotate` when there is no transform at all', () => {
    const src = WRAP(` rotate: "45", width: '10px' `);
    expect(enforceSingleRotationChannelInCode(src)).toBe(src);
  });

  it('never touches styles outside canvasNodes', () => {
    const src = `'use client';
import React from 'react';
function C() {
  return <div data-id="inside" style={{ rotate: "45", transform: 'rotate(45deg)' }} />;
}
export default C;
const canvasNodes = <>
  <div data-id="out" style={{ width: '5px' }} />
</>;
`;
    expect(enforceSingleRotationChannelInCode(src)).toBe(src);
  });

  it('is a no-op with no canvasNodes, and is idempotent', () => {
    expect(enforceSingleRotationChannelInCode('const x = 1;')).toBe('const x = 1;');
    const once = enforceSingleRotationChannelInCode(WRAP(` rotate: "-190.3", transform: 'rotate(-190.3deg)' `));
    expect(enforceSingleRotationChannelInCode(once)).toBe(once);
  });
});
