// Deleting a Scroll Variant node must remove its page-level hooks + the multi-line
// useMotionValueEvent handler too — not just the const decls (which the scroll-fx
// const-sweep handled), or the handler dangles on now-undefined ids and the
// validation guard blocks the delete (the user-reported "would crash at runtime").
import { describe, it, expect } from 'vitest';
import { setScrollVariantInCode } from './scroll-variant-gen';
import { removeNodeInCode } from './generator-crud';
import { parseJSX } from '@/code/parsing/ast-utils';

const PAGE = `'use client';
import React, { useState, useRef } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root">
    <TiFiPa data-id="tifi" data-name="TiFiPa" style={{ position: 'absolute' }}></TiFiPa>
  </div>);
}`;

describe('Scroll Variant — delete cleanup', () => {
  for (const trigger of ['layerInView', 'onScroll', 'sectionInView'] as const) {
    it(`deleting a ${trigger} node leaves no dangling hooks/handler`, () => {
      const spec = trigger === 'sectionInView'
        ? { trigger, from: 'default', viewport: 'middle' as const, sections: [{ sectionId: 'sec1', to: 'variant-1' }] }
        : { trigger, from: 'default', to: 'variant-1', start: 'top' as const, direction: 'down' as const, replay: true };
      const withFx = setScrollVariantInCode(PAGE, 'tifi', spec as any);
      expect(parseJSX(withFx)).not.toBeNull();
      const deleted = removeNodeInCode(withFx, 'tifi');
      expect(parseJSX(deleted)).not.toBeNull();
      // every Sv identifier (decls AND handler refs) is gone — only unused motion
      // imports may linger (syncImports prunes them; they don't crash at runtime).
      expect(deleted).not.toMatch(/Sv\b/);
      expect(deleted).not.toMatch(/useMotionValueEvent\(|getBoundingClientRect|data-scroll-variant|useInView\(/);
      expect(deleted).not.toContain('TiFiPa data-id="tifi"'); // instance removed
    });
  }
});
