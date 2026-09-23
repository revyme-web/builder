import { describe, it, expect } from 'vitest';
import { scrollTargetRef } from './scroll-target';
import { validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { parseScrollHooks, clearScrollHooksMemo } from '@/code/parsing/scroll-parser';
import { checkFile } from '@/code/oracle/check-file';

const GATED = `target: variant !== 'variant-2' ? heroRef : undefined, offset: ["start end", "end start"]`;

describe('scrollTargetRef', () => {
  it('reads a plain target', () => {
    expect(scrollTargetRef(`target: heroRef, offset: ['start end', 'end start']`)).toBe('heroRef');
  });
  it('reads the REF of a variant-gated target, not the condition', () => {
    expect(scrollTargetRef(GATED)).toBe('heroRef');
  });
  it('reads a target gated on several variants', () => {
    expect(scrollTargetRef(`target: variant !== 'a' && variant !== 'b' ? heroRef : undefined`)).toBe('heroRef');
  });
  it('reads a container key and returns null when absent', () => {
    expect(scrollTargetRef(`container: listRef`, 'container')).toBe('listRef');
    expect(scrollTargetRef(`offset: ['start end', 'end start']`)).toBeNull();
  });
});

/** A component whose scroll target is hidden in one of its variants. */
const component = (target: string, attached = true) => `'use client';
import React, { useRef, useState } from 'react';
import { motion, useScroll, useTransform, AnimatePresence } from 'framer-motion';

export default function Card({ initialVariant = 'default' }) {
  const [variant] = useState(initialVariant);
  const heroRef = useRef(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: ${target}, offset: ["start end", "end start"] });
  const heroY = useTransform(heroProgress, [0, 1], [-40, 0]);
  return (
    <div data-id="root" data-name="Card" style={{ position: 'relative', width: '100%' }}>
      <AnimatePresence mode="popLayout">
      {variant !== 'variant-2' && (
        <motion.div ${attached ? 'ref={heroRef} ' : ''}data-id="hero" data-name="Hero" key="hero" layout={true} style={{ position: 'relative', y: heroY }}></motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}`;

const GATED_TARGET = `variant !== 'variant-2' ? heroRef : undefined`;

describe('the builder accepts a variant-gated scroll target', () => {
  it('crash validator: attached gated target passes', () => {
    expect(validateGeneratedCode(component(GATED_TARGET))).toBeNull();
  });

  it('crash validator: an UNATTACHED gated target still fails, naming the ref', () => {
    const msg = validateGeneratedCode(component(GATED_TARGET, false));
    expect(msg).toContain('heroRef');
    expect(msg).not.toMatch(/\bref variant\b/);
  });

  // The AST scroll-dialect rule only runs on PAGES (check-file gates it on
  // kind === 'page'); components get the crash validator (WOULD_CRASH) only.
  it('oracle (page): no SCROLL_USESCROLL_SHAPE / UNATTACHED for a gated target', () => {
    const codes = checkFile(component(GATED_TARGET), { kind: 'page' }).map((v) => v.code);
    expect(codes).not.toContain('SCROLL_USESCROLL_SHAPE');
    expect(codes).not.toContain('SCROLL_TARGET_UNATTACHED');
  });

  it('oracle (page): a non-gated expression target is still rejected — proves the rule ran', () => {
    const codes = checkFile(component(`flag ? heroRef : otherRef`), { kind: 'page' }).map((v) => v.code);
    expect(codes).toContain('SCROLL_USESCROLL_SHAPE');
  });

  it('oracle (component): no WOULD_CRASH for a gated target', () => {
    const codes = checkFile(component(GATED_TARGET), { kind: 'component' }).map((v) => v.code);
    expect(codes).not.toContain('WOULD_CRASH');
  });

  it('panel parser: resolves the source to the ref', () => {
    clearScrollHooksMemo();
    const data = parseScrollHooks(component(GATED_TARGET));
    expect(data.sources.map((s) => s.refVar)).toContain('heroRef');
    expect(data.sources.map((s) => s.refVar)).not.toContain('variant');
  });
});
