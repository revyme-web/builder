import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import { updateMotionPropInCode, removeMotionPropFromCode } from './generator-motion';

const parses = (code: string) => {
  parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  return true;
};

// A Next.js <Link> on a plain page (footer nav style), as the editor emits it.
const PAGE_WITH_LINK = `'use client';
import React from 'react';
import Link from 'next/link';

export default function Page() {
  return <div data-id="root" style={{ display: 'flex' }}>
    <Link data-id="footer-col-product-l0" data-name="Link" href="#" style={{ width: 'auto', height: 'auto', order: '1', flex: '0 0 auto', margin: 0, fontSize: '14px', color: 'var(--color-white-60)', textDecoration: 'none' }}>Advisors</Link>
  </div>;
}`;

describe('updateMotionPropInCode — motion prop on a <Link>', () => {
  const out = updateMotionPropInCode(PAGE_WITH_LINK, 'footer-col-product-l0', 'whileHover', { opacity: '0.6', scale: '1.05' });

  test('produces valid JSX', () => { expect(parses(out)).toBe(true); });

  test('converts <Link> → <MotionLink> (motion props are ignored on a plain Link)', () => {
    expect(out).toMatch(/<MotionLink data-id="footer-col-product-l0"/);
    expect(out).toMatch(/<\/MotionLink>/);
    expect(out).not.toMatch(/<Link data-id="footer-col-product-l0"/);
    // never the broken motion.motionlink form
    expect(out).not.toContain('motion.motionlink');
  });

  test('injects the motion.create(Link) const once', () => {
    expect(out).toMatch(/const MotionLink = motion\.create\(Link\)/);
    expect((out.match(/const MotionLink = motion\.create\(Link\)/g) || []).length).toBe(1);
  });

  test('applies whileHover with the given props (numbers unquoted)', () => {
    expect(out).toMatch(/whileHover=\{\{ opacity: 0\.6, scale: 1\.05 \}\}/);
  });

  test('keeps the link content + href + data-id', () => {
    expect(out).toContain('href="#"');
    expect(out).toContain('>Advisors</MotionLink>');
    expect(out).toContain('data-id="footer-col-product-l0"');
  });

  test('a SECOND motion prop applies to the existing MotionLink — no re-convert, no double const', () => {
    const out2 = updateMotionPropInCode(out, 'footer-col-product-l0', 'whileTap', { scale: '0.95' });
    expect(parses(out2)).toBe(true);
    expect(out2).toMatch(/whileTap=\{\{ scale: 0\.95 \}\}/);
    expect(out2).toMatch(/whileHover=\{\{ opacity: 0\.6, scale: 1\.05 \}\}/);
    expect((out2.match(/const MotionLink = motion\.create\(Link\)/g) || []).length).toBe(1);
    expect(out2).not.toContain('motion.motionlink');
  });
});

describe('removeMotionPropFromCode — motion prop on a MotionLink', () => {
  test('strips the whileHover attribute (MotionLink stays, still a valid link)', () => {
    const added = updateMotionPropInCode(PAGE_WITH_LINK, 'footer-col-product-l0', 'whileHover', { opacity: '0.6' });
    const removed = removeMotionPropFromCode(added, 'footer-col-product-l0', 'whileHover');
    expect(parses(removed)).toBe(true);
    expect(removed).not.toContain('whileHover');
    // MotionLink is left in place — removal does not try to unwrap a MotionConfig.
    expect(removed).toMatch(/<MotionLink data-id="footer-col-product-l0"/);
    expect(removed).not.toContain('<MotionConfig');
    expect(removed).toContain('>Advisors</MotionLink>');
  });

  test('transition on a MotionLink is a real attribute, removed inline (not a MotionConfig unwrap)', () => {
    const added = updateMotionPropInCode(PAGE_WITH_LINK, 'footer-col-product-l0', 'transition', { type: 'spring', duration: '0.3' });
    expect(added).toMatch(/transition=\{\{[^}]*type: 'spring'/);
    expect(added).not.toContain('<MotionConfig');
    const removed = removeMotionPropFromCode(added, 'footer-col-product-l0', 'transition');
    expect(parses(removed)).toBe(true);
    expect(removed).not.toContain('transition=');
    expect(removed).toMatch(/<MotionLink data-id="footer-col-product-l0"/);
  });
});
