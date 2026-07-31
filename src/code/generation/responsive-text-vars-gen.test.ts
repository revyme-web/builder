import { describe, it, expect } from 'vitest';
import {
  setResponsiveTextVariableInCode,
  resetResponsiveTextVariableInCode,
  setResponsiveTextBaseInCode,
  parseResponsiveTextVarInCode,
} from './responsive-text-vars-gen';
import { parseJSXToNodes } from '../parsing/parser';

const layout = (child: string) => `'use client';
import React, { useState } from 'react';
function useMediaQuery(q){ const [m,s]=useState(false); return m; }
export default function LayoutClient({ children, header = "Ready to change", tabletHeader = "Tablet Title" }) {
  return <div data-id="root" data-responsive='{"_bp":[375,768,1440]}'><p data-id="p-1" style={{ color: 'white' }}>${child}</p></div>;
}`;

describe('responsive-text-vars-gen — codegen', () => {
  it('FREEZE a literal on tablet (per-viewport REMOVE), keep the base variable', () => {
    const out = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, '"Ready to change"', 'header');
    expect(out).toContain('(__mq0 ? "Ready to change" : header)');
    expect(out).toContain("useMediaQuery('(max-width: 768px) and (min-width: 375.02px)')"); // banded
  });

  it('BIND a different variable on tablet, keep the base variable; parse round-trips', () => {
    const out = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, 'tabletHeader', 'header');
    expect(out).toContain('(__mq0 ? tabletHeader : header)');
    const r = parseResponsiveTextVarInCode(out, 'p-1');
    expect(r.base).toBe('header');
    expect(r.byViewport.get(768)).toBe('tabletHeader');
  });

  it('reset reverts the tile to the cascaded base + drops the orphan gate', () => {
    let c = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, 'tabletHeader', 'header');
    c = resetResponsiveTextVariableInCode(c, 'p-1', 768);
    expect(c).toContain('>{header}</p>');
    expect(c).not.toMatch(/__mq0 = useMediaQuery/);
  });

  it('setBase replaces only the fallback, keeping the per-viewport branch', () => {
    let c = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, 'tabletHeader', 'header');
    c = setResponsiveTextBaseInCode(c, 'p-1', '"Plain Base"');
    expect(c).toContain('(__mq0 ? tabletHeader : "Plain Base")');
  });

  it('PLAIN-TEXT base → quoted fallback (valid JS, not bare words)', () => {
    // Child is raw JSX text, no `{…}`. Binding a var must quote the base, else `… : Ready to change`
    // is a syntax error. Regression for the per-viewport text override on an unbound text node.
    const out = setResponsiveTextVariableInCode(layout('Ready to change'), 'p-1', 768, 'tabletHeader', '"Ready to change"');
    expect(out).toContain('(__mq0 ? tabletHeader : "Ready to change")');
    expect(out).not.toMatch(/:\s*Ready to change\)/); // never bare words
  });
});

describe('responsive-text-vars — round-trip through the parser', () => {
  it('FREEZE literal → responsiveTextValues + band, base var intact', () => {
    const out = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, '"Frozen Here"', 'header');
    const node = parseJSXToNodes(out).get('p-1')!;
    expect(node.responsiveTextValues?.[768]).toBe('Frozen Here');
    expect(node.responsiveTextBands?.[768]).toBe(375);
    expect(node.textVariable).toBe('header');
    expect(node.textContent).toBe('Ready to change');
    expect(node.responsiveTextVariables).toBeFalsy();
  });

  it('BIND variable → resolved value (purple pill) + base var', () => {
    const out = setResponsiveTextVariableInCode(layout('{header}'), 'p-1', 768, 'tabletHeader', 'header');
    const node = parseJSXToNodes(out).get('p-1')!;
    expect(node.responsiveTextVariables?.[768]).toBe('tabletHeader');
    expect(node.responsiveTextValues?.[768]).toBe('Tablet Title');
    expect(node.textVariable).toBe('header');
  });
});
