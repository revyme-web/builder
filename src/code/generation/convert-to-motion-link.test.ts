import { describe, test, expect } from 'vitest';
import { convertToMotionLinkInCode } from './generator-attrs';

describe('convertToMotionLinkInCode', () => {
  const base = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';

function Card() {
  return <motion.div data-id="frame-1" style={{ width: '100px' }}></motion.div>;
}
export default Card;`;

  test('renames the tag to MotionLink and injects the motion.create(Link) const', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    expect(r).toMatch(/<MotionLink\b/);
    expect(r).toMatch(/<\/MotionLink>/);
    expect(r).not.toMatch(/<motion\.div data-id="frame-1"/);
    expect(r).toMatch(/const MotionLink = motion\.create\(Link\)/);
  });

  test('the const is inserted after the imports', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    const importIdx = r.lastIndexOf('import ');
    const declIdx = r.indexOf('const MotionLink');
    expect(declIdx).toBeGreaterThan(importIdx);
  });

  test('the const lands on its OWN line (not squished onto an import)', () => {
    const r = convertToMotionLinkInCode(base, 'frame-1');
    const declLine = r.split('\n').find((l) => l.includes('const MotionLink'))!;
    expect(declLine.trim()).toBe('const MotionLink = motion.create(Link);');
    // The line must NOT also contain an import statement.
    expect(declLine).not.toMatch(/\bimport\b/);
  });

  test('idempotent — does not duplicate the const on a second pass', () => {
    const once = convertToMotionLinkInCode(base, 'frame-1');
    const twice = convertToMotionLinkInCode(once, 'frame-1');
    const matches = twice.match(/const MotionLink = motion\.create\(Link\)/g) || [];
    expect(matches.length).toBe(1);
  });

  test('no-op when the data-id is not found', () => {
    expect(convertToMotionLinkInCode(base, 'missing')).toBe(base);
  });

  test('preserves children of the converted element', () => {
    const withChild = `import { motion } from 'framer-motion';
function Card() {
  return <motion.div data-id="frame-1"><motion.span data-id="t">hi</motion.span></motion.div>;
}
export default Card;`;
    const r = convertToMotionLinkInCode(withChild, 'frame-1');
    expect(r).toMatch(/<MotionLink[^>]*>\s*<motion\.span data-id="t">hi<\/motion\.span>\s*<\/MotionLink>/);
  });
});
