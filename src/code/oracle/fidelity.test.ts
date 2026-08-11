// fidelity.test.ts — the parser-backed resolution-fidelity gate.
//
// Every fixture here PASSED the oracle with zero violations before the gate
// existed (verified probe, 2026-08-11) while rendering wrong or uneditable:
// empty text, sentinel styles, spread-blind panels. The gate reads the
// parser's own failure artifacts, so these cannot drift.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codesOf = (code: string, kind: 'page' | 'component' = 'page') =>
  checkFile(code, { kind }).map((x) => x.code);

const page = (body: string, head = '') => `'use client';
import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
${head}
export default function Page() {
  return (
    <div data-id="root" data-name="Root" style={{ position: 'relative', width: '100%' }}>
${body}
    </div>
  );
}
`;

describe('RESOLVE_TEXT_EMPTY — expression text the parser cannot read', () => {
  it('rejects a numeric literal child (renders empty)', () => {
    expect(codesOf(page(`      <p data-id="n" style={{ position: 'relative', width: '100%', height: 'auto' }}>{42}</p>`)))
      .toContain('RESOLVE_TEXT_EMPTY');
  });

  it('rejects a member-expression child (renders empty)', () => {
    expect(codesOf(page(`      <p data-id="m" style={{ position: 'relative', width: '100%', height: 'auto' }}>{window.location.href}</p>`)))
      .toContain('RESOLVE_TEXT_EMPTY');
  });

  it('accepts plain literals, {"strings"} and t() keys', () => {
    const code = page(`      <p data-id="a" style={{ position: 'relative', width: '100%', height: 'auto' }}>Hello</p>
      <p data-id="b" style={{ position: 'relative', width: '100%', height: 'auto' }}>{"Hi"}</p>`);
    expect(codesOf(code)).not.toContain('RESOLVE_TEXT_EMPTY');
  });
});

describe('RESOLVE_STYLE_SENTINEL — values the parser could not resolve', () => {
  it('rejects a member-expression style value (token: sentinel)', () => {
    const code = page(
      `      <p data-id="a" style={{ position: 'relative', width: '100%', height: 'auto', color: THEME.primary }}>Hi</p>`,
      `const THEME = { primary: '#f00' };`,
    );
    expect(codesOf(code)).toContain('RESOLVE_STYLE_SENTINEL');
  });

  it('accepts hook-derived motion-value bindings (scroll dialect)', () => {
    const code = `'use client';
import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const heroRef = useRef(null);
  const { scrollYProgress: heroP } = useScroll({ target: heroRef, offset: ["start end", "end start"] });
  const heroY = useTransform(heroP, [0, 1], [0, -80]);
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <motion.div ref={heroRef} data-id="hero" style={{ position: 'relative', width: '100%', height: '400px', y: heroY }} />
    </div>
  );
}
`;
    expect(codesOf(code)).not.toContain('RESOLVE_STYLE_SENTINEL');
  });
});

describe('RESOLVE_STYLE_DROPPED — keys that go in but not out', () => {
  it('rejects a foreign spread inside the style object', () => {
    const code = page(
      `      <div data-id="b" style={{ position: 'relative', width: '100%', height: 'auto', ...cardBase, color: 'red' }}>x</div>`,
      `const cardBase = { padding: '20px' };`,
    );
    expect(codesOf(code)).toContain('RESOLVE_STYLE_DROPPED');
  });

  it('rejects a computed style key', () => {
    const code = page(
      `      <div data-id="c" style={{ position: 'relative', width: '100%', height: 'auto', [side]: '10px' }}>x</div>`,
      `const side = 'paddingLeft';`,
    );
    expect(codesOf(code)).toContain('RESOLVE_STYLE_DROPPED');
  });

  it('rejects a template-literal value the dialect cannot read', () => {
    const code = page(
      `      <div data-id="d" style={{ position: 'relative', width: '100%', height: '300px', transform: \`translateX(\${-idx * 100}%)\` }}>x</div>`,
      '',
    ).replace('return (', 'const [idx] = useState(0);\n  return (');
    expect(codesOf(code)).toContain('RESOLVE_STYLE_DROPPED');
  });

  it("accepts the component root's mandatory ...style spread", () => {
    const code = `'use client';

/** @name "Card" */

import React from 'react';
import { motion } from 'framer-motion';

function Card({ style, ...rest }) {
  return <motion.div data-id="root-1" {...rest} style={{ position: 'absolute', width: '300px', height: '200px', ...style }}>
    <motion.p data-id="t" style={{ position: 'relative', width: '100%', height: 'auto', flex: '0 0 auto', order: '0' }}>Hi</motion.p>
  </motion.div>;
}
export default withResponsiveProps(Card);
`;
    expect(codesOf(code, 'component')).not.toContain('RESOLVE_STYLE_DROPPED');
  });
});
