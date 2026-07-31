import { describe, it, expect } from 'vitest';
import { setScrollVariantInCode } from '@/code/generation/scroll-variant-gen';
import { syncImports, validateGeneratedCode } from './mutation-queue';

const PAGE = `'use client';
import React from 'react';
import Hero from '@/components/Hero';
export default function Page() {
  return (<div data-id="root"><Hero data-id="hero" initialVariant="default" /></div>);
}`;

describe('Scroll Variant — imports synced before validation', () => {
  it('all three triggers validate clean once syncImports adds the hooks', () => {
    const specs = [
      { trigger: 'onScroll' as const, from: 'default', to: 'phone', direction: 'down' as const, replay: true },
      { trigger: 'layerInView' as const, from: 'default', to: 'phone', start: 'center' as const, replay: true },
      { trigger: 'sectionInView' as const, from: 'default', viewport: 'middle' as const, sections: [{ sectionId: 'sec1', to: 'phone' }] },
    ];
    for (const spec of specs) {
      const set = setScrollVariantInCode(PAGE, 'hero', spec);
      // pre-sync: hooks unimported → the guard would block
      expect(validateGeneratedCode(set)).toBeTruthy();
      // post-sync: imports added → clean (the real assertion; hooks vary per trigger)
      expect(validateGeneratedCode(syncImports(set))).toBeNull();
    }
  });
});
