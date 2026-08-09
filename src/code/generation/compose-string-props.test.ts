// compose-string-props.test.ts — a CSS-STRING appear prop must survive the
// scroll/appear composition as a quoted literal.
//
// User report 2026-08-09: adding a Width animation to an auto-width grid child
// was blocked with "References undefined identifier: auto — would crash at
// runtime", so the whole flush reverted and the property could not be added.
//
// One root cause, two call sites. `parseTagObject` STRIPS quotes — correct for
// reading and comparing — but the composer re-emits those values into generated
// JS source. A number round-trips bare, which is why every appear prop before
// this (opacity, y, scale) worked and the gap stayed invisible. The first CSS
// string to reach it, `width: 'auto'`, came out as a bare identifier.

import { describe, it, expect } from 'vitest';
import { composeScrollAppearInCode, hasAppearTransformConflict } from './generator-motion-compose';

/** A node with a scrubbed scroll transform on `y` (which is what makes the
 *  composer engage at all) plus an appear carrying a CSS-string prop. */
const PAGE = (styleWidth: string, appearWidth: string) => `'use client';
import { motion, useScroll, useTransform, useMotionValue, useInView, animate } from 'framer-motion';
import { useRef, useEffect } from 'react';
export default function Page() {
  const secRef = useRef(null);
  const { scrollYProgress } = useScroll({ target: secRef });
  const client8ScrollY = useTransform(scrollYProgress, [0, 1], [0, -40]);
  return (
    <div data-id="root" ref={secRef}>
      <motion.div data-id="client-8" initial={{
        opacity: 0,
        y: 18,
        width: ${appearWidth}
      }} whileInView={{
        opacity: 1,
        y: 0,
        width: ${appearWidth}
      }} viewport={{ once: true }} transition={{ type: 'spring', stiffness: 90 }} style={{
        y: client8ScrollY,
        width: ${styleWidth},
        height: '178px'
      }}>x</motion.div>
    </div>
  );
}
`;

/** Every identifier the composed output references, minus the ones the fixture
 *  declares or imports. Mirrors the mutation validator's scope crawl. */
function danglingIdentifiers(code: string): string[] {
  const declared = new Set([
    'motion', 'useScroll', 'useTransform', 'useMotionValue', 'useInView', 'animate',
    'useRef', 'useEffect', 'Page', 'secRef', 'scrollYProgress', 'client8ScrollY',
  ]);
  const out = new Set<string>();
  // Only look inside the generated hook lines — the JSX is not JS scope.
  for (const line of code.split('\n')) {
    if (!/^\s*const \w+ = use(Transform|MotionValue|InView|Ref)\(/.test(line)) continue;
    // Blank out string literals first — otherwise a word INSIDE a correctly
    // quoted value ('min-content') reads as a free identifier.
    const args = line.slice(line.indexOf('(') + 1)
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const m of args.matchAll(/(?<!['"\w$.])[A-Za-z_$][\w$]*/g)) {
      const id = m[0];
      // Object KEY (`{ once: false }`), not a reference.
      if (/^\s*:/.test(args.slice(m.index! + id.length))) continue;
      if (declared.has(id) || /^(use\w+|true|false|null|undefined|a|b|t|_c)$/.test(id)) continue;
      if (new RegExp(`\\bconst ${id}\\b`).test(code)) continue;
      out.add(id);
    }
  }
  return [...out];
}

describe('composeScrollAppearInCode — CSS string props', () => {
  it('THE BUG: a `width: auto` appear prop emits no bare identifier', () => {
    const out = composeScrollAppearInCode(PAGE("'auto'", "'auto'"), 'client-8');
    // Bare `auto` — i.e. not inside quotes — anywhere in a generated hook line.
    expect(out).not.toMatch(/useTransform\([^)]*(?<!')\bauto\b(?!')[^)]*\)/);
    expect(danglingIdentifiers(out)).toEqual([]);
  });

  it('re-quotes the string into the useTransform range', () => {
    const out = composeScrollAppearInCode(PAGE("'auto'", "'auto'"), 'client-8');
    expect(out).toContain("[0, 1], ['auto', 'auto']");
  });

  it('a CSS keyword in `style` is never folded in as a motion value', () => {
    // `auto` is a valid identifier BY SHAPE, which is exactly why the
    // shape-only test mistook it for one and emitted `useTransform([…, auto])`.
    const out = composeScrollAppearInCode(PAGE("'auto'", "'auto'"), 'client-8');
    expect(out).not.toContain('WidthAC');
  });

  it('a REAL motion value in `style` is still folded in', () => {
    // The capability the shape test existed for — must not regress. `y` carries
    // the declared scroll transform, so the appear's y composes with it.
    const out = composeScrollAppearInCode(PAGE("'auto'", "'auto'"), 'client-8');
    expect(out).toMatch(/client_8Y[A-Z]* = useTransform/);
    expect(danglingIdentifiers(out)).toEqual([]);
  });

  it('numbers still round-trip bare, not quoted', () => {
    const out = composeScrollAppearInCode(PAGE("'auto'", "'auto'"), 'client-8');
    expect(out).toContain('[0, 1], [0, 1]');   // opacity: no scroll binding
    // `y` DOES have one here, so it takes the multiply-with-the-scrubbed-
    // transform branch instead of the [initial, resting] range.
    expect(out).toMatch(/client_8YC = useTransform\(\[client_8Appear, client8ScrollY\]/);
  });

  it('other CSS strings are covered too — this was never auto-specific', () => {
    for (const v of ["'100%'", "'min-content'", "'none'", "'#ffffff'"]) {
      const out = composeScrollAppearInCode(PAGE(v, v), 'client-8');
      expect(danglingIdentifiers(out), `style/appear value ${v}`).toEqual([]);
      expect(out, `style/appear value ${v}`).toContain(`[0, 1], [${v}, ${v}]`);
    }
  });

  it('a quote inside the value is escaped, not left to break the literal', () => {
    const out = composeScrollAppearInCode(PAGE("'auto'", `"a'b"`), 'client-8');
    expect(out).toContain("\\'");
  });
});

// ─── The gate ───────────────────────────────────────────────────────────────
//
// The real defect. `hasAppearTransformConflict` decides whether a node needs
// the Appear × Scroll composition AT ALL, and it asked "is this style value an
// identifier?" — by SHAPE. `parseTagObject` has already stripped the quotes by
// then, so `width: 'auto'` reads as a motion-value reference and a node with no
// scroll effect whatsoever got dragged through the whole conversion: its plain
// initial/whileInView/viewport/transition torn out and replaced with
// useRef/useInView/useMotionValue/useTransform machinery it never needed.
//
// Everything downstream — the unquoted `auto`, the blocked mutation — followed
// from a gate that should have returned false.
const PLAIN = `'use client';
import { motion } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="client-8" initial={{ opacity: 0, y: 18, width: '11px' }} whileInView={{ opacity: 1, y: 0, width: 'auto' }} viewport={{ once: true }} transition={{ type: 'spring', stiffness: 90 }} style={{ position: 'relative', width: 'auto', height: '178px' }}>x</motion.div>
    </div>
  );
}
`;

describe('hasAppearTransformConflict — the gate', () => {
  it('THE BUG: a CSS keyword in `style` is not a scroll conflict', () => {
    expect(hasAppearTransformConflict(PLAIN, 'client-8')).toBe(false);
  });

  it('a node with no scroll effect is left completely alone', () => {
    // The declarative appear the user wrote must survive byte-for-byte — no
    // hooks injected, no props stripped.
    expect(composeScrollAppearInCode(PLAIN, 'client-8')).toBe(PLAIN);
  });

  it('every CSS keyword that happens to look like an identifier', () => {
    for (const v of ['auto', 'none', 'transparent', 'inherit', 'unset', 'revert', 'currentColor']) {
      const src = PLAIN.replace("width: 'auto', height", `width: '${v}', height`);
      expect(hasAppearTransformConflict(src, 'client-8'), v).toBe(false);
    }
  });

  it('a REAL motion value in `style` still opens the gate', () => {
    // The capability the check exists for — must not regress.
    const withVar = PLAIN
      .replace("import { motion } from 'framer-motion';",
        "import { motion, useTransform, useScroll } from 'framer-motion';\nimport { useRef } from 'react';")
      .replace('export default function Page() {',
        'export default function Page() {\n  const secRef = useRef(null);\n  const { scrollYProgress } = useScroll({ target: secRef });\n  const spdY = useTransform(scrollYProgress, [0, 1], [0, -40]);')
      .replace("position: 'relative', width: 'auto'", "position: 'relative', y: spdY, width: 'auto'")
      .replace('y: 18,', 'y: 18,');
    expect(hasAppearTransformConflict(withVar, 'client-8')).toBe(true);
  });
});
