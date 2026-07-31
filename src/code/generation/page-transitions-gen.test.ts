import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  injectPageTransitionsInCode,
  PAGE_EFFECTS_RUNTIME_SOURCE,
  PAGE_TRANSITIONS_SOURCE,
  pageEffectsDataPath,
  pageTransitionsPath,
} from './page-transitions-gen';
import { buildViewTransitionCSS } from './view-transition-css';
import { createDefaultSide } from '../project/page-effects-config';

const parsesTsx = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
const parsesTs = (code: string) =>
  expect(() => transform(code, { presets: ['typescript'], filename: 'f.ts' })).not.toThrow();

const LAYOUT_CLIENT = `'use client';
import React from 'react';
export default function LayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div data-id="root" data-name="Layout" style={{ position: 'relative' }}>
      {children}
    </div>
  );
}
`;

describe('page-transitions-gen: injectPageTransitionsInCode', () => {
  it('wraps {children} + adds the import', () => {
    const out = injectPageTransitionsInCode(LAYOUT_CLIENT);
    expect(out).toContain('<PageTransitions>{children}</PageTransitions>');
    expect(out).toContain("import { PageTransitions } from './page-transitions';");
    parsesTsx(out);
  });
  it('is idempotent', () => {
    const once = injectPageTransitionsInCode(LAYOUT_CLIENT);
    expect(injectPageTransitionsInCode(once)).toBe(once);
  });
  it('no-op when there is no {children}', () => {
    const noKids = `export default function L() { return <div/>; }`;
    expect(injectPageTransitionsInCode(noKids)).toBe(noKids);
  });
});

describe('page-transitions-gen: generated source files', () => {
  it('the controller component is valid TSX', () => {
    parsesTsx(PAGE_TRANSITIONS_SOURCE);
    expect(PAGE_TRANSITIONS_SOURCE).toContain("import { PAGE_EFFECTS } from './page-effects'");
    expect(PAGE_TRANSITIONS_SOURCE).toContain('startViewTransition');
    expect(PAGE_TRANSITIONS_SOURCE).toContain('addEventListener(\'click\', onClick, true)'); // capture phase
  });
  it('the runtime helpers module is valid TS', () => {
    parsesTs(PAGE_EFFECTS_RUNTIME_SOURCE);
  });
  it('path helpers sit next to the LayoutClient', () => {
    expect(pageEffectsDataPath('app/(Body)/LayoutClient.tsx')).toBe('app/(Body)/page-effects.ts');
    expect(pageTransitionsPath('app/(Body)/LayoutClient.tsx')).toBe('app/(Body)/page-transitions.tsx');
  });
});

describe('page-transitions-gen: deployed runtime matches the editor builder (no drift)', () => {
  // eval the generated standalone helpers and compare buildViewTransitionCSS output.
  function loadRuntime(): { buildViewTransitionCSS: (e?: any, n?: any) => string } {
    const src = PAGE_EFFECTS_RUNTIME_SOURCE.replace(/export function/g, 'function');
     
    const factory = new Function(src + '\nreturn { buildViewTransitionCSS };');
    return factory();
  }
  const rt = loadRuntime();
  const cases = [
    [createDefaultSide(), { ...createDefaultSide(), opacity: 0 }],
    [undefined, { ...createDefaultSide(), offsetX: 100 }],
    [{ ...createDefaultSide(), opacity: 0 }, undefined],
    [undefined, { ...createDefaultSide(), mask: { type: 'circle', originX: 50, originXUnit: 'rel', originY: 50, originYUnit: 'rel' } }],
    [undefined, { ...createDefaultSide(), transition: { kind: 'spring', stiffness: 200, damping: 12, mass: 1, duration: 0, delay: 0 } }],
  ] as const;
  cases.forEach(([exit, enter], i) => {
    it(`case ${i}: deployed CSS === editor CSS`, () => {
      expect(rt.buildViewTransitionCSS(exit as any, enter as any)).toBe(buildViewTransitionCSS(exit as any, enter as any));
    });
  });
});
