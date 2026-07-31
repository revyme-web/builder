// loop-canvas-node.test.ts — Loop effect on a CANVAS node (module-scope
// `canvasNodes` fragment). The hook form (useMotionValue/useEffect/useInView +
// ref) can't exist at module scope — adding a Loop to a marquee word tile was
// blocked with "References undefined identifiers: rmqStarRef, rmqStarLoopRotate"
// (live find 2026-07-13). The compose now emits a SELF-CONTAINED declarative
// loop there, keeps data-loop as the spec carrier, and upgrades to the hook
// form when the node lives inside the component render.

import { describe, test, expect } from 'vitest';
import { setLoopInCode, composeLoopInCode } from './generator-motion-loop';

const SPEC = { props: { rotate: '360' }, transition: { duration: '6', repeat: 'Infinity', ease: 'linear' } };

const CANVAS_PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%' }}></div>;
}
const canvasNodes = <>
  <p data-id="rmq-star" data-name="Star" data-canvas-node="true" style={{
    position: 'absolute',
    left: '-780px',
    top: '3790px',
    fontSize: '88px',
    color: '#D9A441'
  }}>✳</p>
</>;
`;

const VIEWPORT_PAGE = `'use client';
import React, { useRef, useEffect } from 'react';
import { motion, useMotionValue, useInView, animate } from 'framer-motion';

export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <p data-id="star" data-name="Star" style={{ position: 'relative', order: '0', flex: '0 0 auto', fontSize: '88px' }}>✳</p>
  </div>;
}
`;

describe('Loop on a canvas node — self-contained declarative form', () => {
  test('composes animate + repeating transition, NO hooks, keeps data-loop', () => {
    let code = setLoopInCode(CANVAS_PAGE, 'rmq-star', SPEC);
    code = composeLoopInCode(code, 'rmq-star');

    // Declarative form on a motion tag.
    expect(code).toMatch(/<motion\.p [^>]*data-id="rmq-star"/);
    expect(code).toContain('animate={{ rotate: 360 }}');
    expect(code).toMatch(/transition=\{\{[^}]*repeat: Infinity/);
    // Spec carrier survives for the panel round-trip.
    expect(code).toContain('data-loop=');
    // NO hook form — nothing undefined at module scope.
    expect(code).not.toMatch(/rmqStarRef|rmqStarLoop|useMotionValue|useInView/);
  });

  test('repeat: Infinity is added when the spec transition lacks it', () => {
    let code = setLoopInCode(CANVAS_PAGE, 'rmq-star', { props: { rotate: '360' }, transition: { duration: '6' } });
    code = composeLoopInCode(code, 'rmq-star');
    expect(code).toMatch(/transition=\{\{ repeat: Infinity, duration: 6 \}\}/);
  });

  test('removeLoop clears the dormant declarative form too', () => {
    let code = setLoopInCode(CANVAS_PAGE, 'rmq-star', SPEC);
    code = composeLoopInCode(code, 'rmq-star');
    code = setLoopInCode(code, 'rmq-star', null);
    expect(code).not.toContain('data-loop=');
    expect(code).not.toContain('animate={');
    expect(code).not.toMatch(/transition=\{\{[^}]*repeat/);
  });

  test('re-compose is idempotent (sweep runs repeatedly, no attr growth)', () => {
    let code = setLoopInCode(CANVAS_PAGE, 'rmq-star', SPEC);
    code = composeLoopInCode(code, 'rmq-star');
    const again = composeLoopInCode(code, 'rmq-star');
    expect(again.match(/animate=\{/g)?.length).toBe(1);
    expect(again.match(/transition=\{/g)?.length).toBe(1);
  });
});

describe('Loop on a SLOT-HOISTED canvas node (connected to a component)', () => {
  // The second live find (2026-07-13): after connecting the word tiles to a
  // marquee, the node moved OUT of canvasNodes into a hoisted
  // `const cn_X = <jsx/>` — still module scope, still no hooks allowed. The
  // canvasNodes-only check missed it and the hook form errored again.
  const SLOT_PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import Marquee from '@/components/Marquee';

export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%' }}>
    <Marquee data-id="mq-1" data-name="Marquee" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%' }}>{cn_rmq_star}</Marquee>
  </div>;
}
const cn_rmq_star = <p data-id="rmq-star" data-name="Star" data-canvas-node="true" style={{
  position: 'absolute',
  left: '-729px',
  top: '1201px',
  fontSize: '88px',
  color: '#D9A441'
}}>✳</p>;
const canvasNodes = <>
</>;
`;

  test('composes the declarative form inside the slot const — no hooks', () => {
    let code = setLoopInCode(SLOT_PAGE, 'rmq-star', SPEC);
    code = composeLoopInCode(code, 'rmq-star');
    expect(code).toMatch(/<motion\.p [^>]*data-id="rmq-star"/);
    expect(code).toContain('animate={{ rotate: 360 }}');
    expect(code).toMatch(/transition=\{\{[^}]*repeat: Infinity/);
    expect(code).toContain('data-loop=');
    expect(code).not.toMatch(/rmqStarRef|rmqStarLoop|useMotionValue|useInView/);
  });
});

describe('Loop inside the component render — hook form (unchanged behavior)', () => {
  test('composes motion values + effects, strips data-loop from the tag', () => {
    let code = setLoopInCode(VIEWPORT_PAGE, 'star', SPEC);
    code = composeLoopInCode(code, 'star');
    expect(code).toContain('const starLoopRotate = useMotionValue(0)');
    expect(code).toMatch(/useEffect\(/);
    expect(code).not.toContain('data-loop=');
  });

  test('a dragged-in dormant node upgrades: declarative form stripped before hooks', () => {
    // Simulate: the canvas dormant tag moved into the render (same attrs).
    const moved = VIEWPORT_PAGE.replace(
      `<p data-id="star" data-name="Star" style={{ position: 'relative', order: '0', flex: '0 0 auto', fontSize: '88px' }}>✳</p>`,
      `<motion.p data-id="star" data-name="Star" data-loop='${JSON.stringify(SPEC)}' animate={{ rotate: 360 }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} style={{ position: 'relative', order: '0', flex: '0 0 auto', fontSize: '88px' }}>✳</motion.p>`,
    );
    const composed = composeLoopInCode(moved, 'star');
    // Hook form present, dormant declarative animate gone (no double-run).
    expect(composed).toContain('const starLoopRotate = useMotionValue(0)');
    expect(composed).not.toMatch(/animate=\{\{ rotate: 360 \}\}/);
  });
});
