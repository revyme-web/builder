import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';
import { setResponsiveAttrInCode } from '../generation/responsive-attrs-gen';

// PER-VIEWPORT FIT: a replica commit writes the svg wrapper's viewBox as a
// responsive attr ternary (`viewBox={__mq0 ? "…" : "…"}`). The parser's svg
// attr path used to only accept literals — a ternary silently DROPPED the
// whole attr (no base, no overrides → the fit box vanished on re-parse).
// Now: base → node.attrs.viewBox, overrides → node.responsiveAttrs.viewBox
// (same shape the Renderer's resolveResponsiveAttr consumes per replica tile).
describe('parser: responsive FIT viewBox round-trip', () => {
  const PAGE = `'use client';
import React from 'react';
import { useState, useEffect } from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative' }}>
      <svg data-id="t1-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{ width: '100%', height: 'auto' }} viewBox="0 0 1010 78">
        <foreignObject width="100%" height="100%" style={{ overflow: 'visible' }}>
          <p data-id="t1" data-name="Text" style={{ fontSize: '41px', position: 'relative', margin: '0' }}>Hello</p>
        </foreignObject>
      </svg>
    </div>
  );
}
`;

  test('literal viewBox parses into attrs (baseline)', () => {
    const node = parseJSXToNodes(PAGE).get('t1-svg');
    expect(node?.attrs?.viewBox).toBe('0 0 1010 78');
    expect(node?.responsiveAttrs?.viewBox).toBeUndefined();
  });

  test('responsive viewBox ternary parses into base + per-viewport overrides', () => {
    const withOverride = setResponsiveAttrInCode(PAGE, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    const node = parseJSXToNodes(withOverride).get('t1-svg');
    expect(node?.attrs?.viewBox).toBe('0 0 1010 78');                       // base (desktop)
    expect(node?.responsiveAttrs?.viewBox?.viewport?.[768]).toBe('0 0 1010 120'); // tablet override
  });

  test('two-breakpoint chain parses both overrides', () => {
    let code = setResponsiveAttrInCode(PAGE, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    code = setResponsiveAttrInCode(code, 't1-svg', 375, 'viewBox', '0 0 1010 150', '0 0 1010 78');
    const node = parseJSXToNodes(code).get('t1-svg');
    expect(node?.attrs?.viewBox).toBe('0 0 1010 78');
    expect(node?.responsiveAttrs?.viewBox?.viewport?.[768]).toBe('0 0 1010 120');
    expect(node?.responsiveAttrs?.viewBox?.viewport?.[375]).toBe('0 0 1010 150');
  });
});
