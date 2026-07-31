import { describe, test, expect } from 'vitest';
import {
  parseTemplateProps,
  serializeTemplateProps,
  updateTemplatePropsInCode,
  setTemplatePropInCode,
  stripTemplateProps,
} from './template-props';

const PAGE = (annotations: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "width": 1440, "isPrimary": true, "order": 0 }] } */
${annotations}
import React from 'react';
export default function Page() { return <div data-id="root" />; }`;

describe('template-props parse', () => {
  test('returns {} when no block', () => {
    expect(parseTemplateProps(PAGE(''))).toEqual({});
  });
  test('parses a block into a string map', () => {
    const code = PAGE(`/** @templateProps { "scrollSection": "leadership-section", "ctaText": "Hi" } */\n`);
    expect(parseTemplateProps(code)).toEqual({ scrollSection: 'leadership-section', ctaText: 'Hi' });
  });
  test('malformed JSON → {}', () => {
    expect(parseTemplateProps(PAGE(`/** @templateProps { bad } */\n`))).toEqual({});
  });
});

describe('template-props update/set', () => {
  test('inserts a block after @canvas', () => {
    const out = updateTemplatePropsInCode(PAGE(''), { scrollSection: 'hero' });
    expect(out).toContain('@templateProps');
    expect(parseTemplateProps(out)).toEqual({ scrollSection: 'hero' });
    // block sits after @canvas, before the import
    expect(out.indexOf('@templateProps')).toBeGreaterThan(out.indexOf('@canvas'));
    expect(out.indexOf('@templateProps')).toBeLessThan(out.indexOf("import React"));
  });

  test('replaces an existing block (no duplication)', () => {
    let out = updateTemplatePropsInCode(PAGE(''), { a: '1' });
    out = updateTemplatePropsInCode(out, { a: '2', b: '3' });
    expect((out.match(/@templateProps/g) || []).length).toBe(1);
    expect(parseTemplateProps(out)).toEqual({ a: '2', b: '3' });
  });

  test('empty map removes the block', () => {
    let out = updateTemplatePropsInCode(PAGE(''), { a: '1' });
    out = updateTemplatePropsInCode(out, {});
    expect(out).not.toContain('@templateProps');
  });

  test('setTemplatePropInCode sets one + empty value removes it', () => {
    let out = setTemplatePropInCode(PAGE(''), 'scrollSection', 'hero');
    expect(parseTemplateProps(out)).toEqual({ scrollSection: 'hero' });
    out = setTemplatePropInCode(out, 'scrollSection', '');
    expect(parseTemplateProps(out)).toEqual({});
    expect(out).not.toContain('@templateProps');
  });

  test('serialize drops empty values', () => {
    expect(serializeTemplateProps({ a: 'x', b: '' })).toContain('"a"');
    expect(serializeTemplateProps({ a: 'x', b: '' })).not.toContain('"b"');
  });

  test('strip removes the block', () => {
    const out = updateTemplatePropsInCode(PAGE(''), { a: '1' });
    expect(stripTemplateProps(out)).not.toContain('@templateProps');
  });
});
