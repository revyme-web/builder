import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

/** CANONICAL FIXTURE — a real page written by the builder's own generator with
 *  EVERY animation type composed on one element (scroll transform + speed +
 *  direction + hover + tap + loop via data-scroll-fx). Provided by the user
 *  2026-06-10. The oracle must accept the builder's own output with ZERO
 *  violations — bouncing this would bounce the editor itself. */
const CANONICAL_COMPOSED_PAGE = `'use client';\n\n/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 }
  }
} */

import React, { useState, useEffect, useRef } from 'react';
import { motion, useScroll, useTransform, useSpring, useInView, useMotionValueEvent, useMotionValue, animate } from 'framer-motion';

export default function Page() {
  const [frameMq7uhstk_2Scrolled, setFrameMq7uhstk_2Scrolled] = useState(false);
  const { scrollY: frameMq7uhstk_2ScrollY } = useScroll();
  useMotionValueEvent(frameMq7uhstk_2ScrollY, "change", (y) => {
    const prev = frameMq7uhstk_2ScrollY.getPrevious() ?? 0;
    if (y > prev) setFrameMq7uhstk_2Scrolled(true); else if (y < prev) setFrameMq7uhstk_2Scrolled(false);
  });
  const { scrollY: frameMq7uhstk_2SpeedScroll } = useScroll();
  const frameMq7uhstk_2SpeedY = useTransform(frameMq7uhstk_2SpeedScroll, (v) => v * (1 - 110 / 100));
  const { scrollYProgress: frameMq7uhstk_2Progress } = useScroll();
  const frameMq7uhstk_2Smooth = useSpring(frameMq7uhstk_2Progress, { duration: 0.5, bounce: 0.25 });
  const frameMq7uhstk_2Opacity = useTransform(frameMq7uhstk_2Smooth, [0, 1], [0.5, 1]);
  const frameMq7uhstk_2Scale = useTransform(frameMq7uhstk_2Smooth, [0, 1], [0.5, 1]);
  const frameMq7uhstk_2Ref = useRef(null);
  const frameMq7uhstk_2AnimOpacity = useMotionValue(1);
  useEffect(() => { const _c = animate(frameMq7uhstk_2AnimOpacity, frameMq7uhstk_2Scrolled ? 0 : 1, { type: 'spring', duration: 0.5, bounce: 0.25 }); return () => _c.stop(); }, [frameMq7uhstk_2Scrolled]);
  const frameMq7uhstk_2OpacityDC = useTransform([frameMq7uhstk_2AnimOpacity, frameMq7uhstk_2Opacity], ([a, t]) => a * t);
  const frameMq7uhstk_2LoopInView = useInView(frameMq7uhstk_2Ref);
  const frameMq7uhstk_2LoopRotate = useMotionValue(0);
  useEffect(() => { if (frameMq7uhstk_2LoopInView) { const _c = animate(frameMq7uhstk_2LoopRotate, 360, { duration: 2, repeat: Infinity, ease: 'linear' }); return () => _c.stop(); } }, [frameMq7uhstk_2LoopInView]);
  const frameMq7uhstk_2HovScale = useMotionValue(1);
  const frameMq7uhstk_2ScaleHovC = useTransform([frameMq7uhstk_2Scale, frameMq7uhstk_2HovScale], ([s, h]) => s * h);
  const frameMq7uhstk_2TapScale = useMotionValue(1);
  const frameMq7uhstk_2ScaleTapC = useTransform([frameMq7uhstk_2ScaleHovC, frameMq7uhstk_2TapScale], ([s, h]) => s * h);
                                      return (
<div data-id="root" data-name="Page 3" style={{
  position: 'relative', width: '100%', height: '900px',
  backgroundColor: '#ffffff'
}}>

    <motion.div data-scroll-fx='{"transform":{"trigger":"onScroll","from":{"opacity":"0.5","scale":"0.5"},"to":{"opacity":"1","scale":"1"}},"speed":110,"animation":{"direction":"down","replay":true,"toProps":{"opacity":"0"},"transition":{"type":"spring","duration":"0.5","bounce":"0.25"}},"hover":{"props":{"scale":"1.05"}},"tap":{"props":{"scale":"0.95"}},"loop":{"props":{"rotate":"360"},"transition":{"duration":"2","repeat":"Infinity","ease":"linear"}}}'
          onTapStart={() => { animate(frameMq7uhstk_2TapScale, 0.95, { type: 'spring', stiffness: 400, damping: 30 }); }}
          onTap={() => { animate(frameMq7uhstk_2TapScale, 1, { type: 'spring', stiffness: 400, damping: 30 }); }}
          onTapCancel={() => { animate(frameMq7uhstk_2TapScale, 1, { type: 'spring', stiffness: 400, damping: 30 }); }}
          onHoverStart={() => { animate(frameMq7uhstk_2HovScale, 1.05, { type: 'spring', stiffness: 400, damping: 30 }); }}
          onHoverEnd={() => { animate(frameMq7uhstk_2HovScale, 1, { type: 'spring', stiffness: 400, damping: 30 }); }} ref={frameMq7uhstk_2Ref} data-id="frame-mq7uhstk-2" data-name="Frame" style={{position: 'absolute', width: '342px', height: '225px', backgroundColor: '#ffb3ba', borderRadius: '0px', overflow: 'hidden', left: '488px', top: '240px', y: frameMq7uhstk_2SpeedY, opacity: frameMq7uhstk_2OpacityDC, rotate: frameMq7uhstk_2LoopRotate, scale: frameMq7uhstk_2ScaleTapC}}
          ></motion.div>
  </div>
  );
}`;

/** Minimal valid scroll scrub in the simple dialect the AI is taught. */
const SIMPLE_SCRUB = `'use client';\n\n/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

/** @canvas { "viewports": [], "positions": {} } */

import React, { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

export default function Page() {
  const heroRef = useRef(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ['start end', 'end start'] });
  const heroY = useTransform(heroProgress, [0, 1], [0, -80]);
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <motion.div ref={heroRef} data-id="hero" data-name="Hero" style={{ display: 'flex', y: heroY }}>
        <p data-id="title">Hello</p>
      </motion.div>
    </div>
  );
}`;

describe('scroll dialect — canonical fixtures pass', () => {
  it('accepts the builder-generated composed-fx page with ZERO violations', () => {
    expect(checkFile(CANONICAL_COMPOSED_PAGE, { kind: 'page' })).toEqual([]);
  });

  it('accepts the simple scrub dialect with ZERO violations', () => {
    expect(checkFile(SIMPLE_SCRUB, { kind: 'page' })).toEqual([]);
  });
});

describe('scroll dialect — sinners bounce', () => {
  it('bounces style-before-data-id attribute order (bindings invisible to the binding scan)', () => {
    // the live failure: style={{ x: featLeftX }} written BEFORE data-id
    const code = SIMPLE_SCRUB.replace(
      '<motion.div ref={heroRef} data-id="hero" data-name="Hero" style={{ display: \'flex\', y: heroY }}>',
      '<motion.div ref={heroRef} style={{ display: \'flex\', y: heroY }} data-id="hero" data-name="Hero">',
    );
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('ATTR_ORDER_DATA_ID_FIRST');
  });

  it('flags TypeScript generics on scroll refs', () => {
    const code = SIMPLE_SCRUB.replace('useRef(null)', 'useRef<HTMLDivElement>(null)');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_REF_SHAPE');
  });

  it('flags a useScroll target that is never attached via ref={}', () => {
    const code = SIMPLE_SCRUB.replace('ref={heroRef} ', '');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_TARGET_UNATTACHED');
  });

  it('accepts an IMPERATIVELY attached target (querySelector effect — the On-Scroll text-effect form)', () => {
    // The editor's text effect never binds ref=; it resolves the target in an
    // effect. That form must NOT bounce as unattached.
    const code = SIMPLE_SCRUB
      .replace('ref={heroRef} ', '')
      .replace(
        'const { scrollYProgress: heroProgress }',
        'useEffect(() => { heroRef.current = document.querySelector("[data-id=\'hero\']") || document.body; }, []);\n  const { scrollYProgress: heroProgress }',
      )
      .replace('import React, { useRef }', 'import React, { useRef, useEffect }');
    expect(codes(checkFile(code, { kind: 'page' }))).not.toContain('SCROLL_TARGET_UNATTACHED');
  });

  it('still flags an unattached target when the .current assignment has no data-id selector', () => {
    const code = SIMPLE_SCRUB
      .replace('ref={heroRef} ', '')
      .replace(
        'const { scrollYProgress: heroProgress }',
        'useEffect(() => { heroRef.current = document.querySelector(".hero") || document.body; }, []);\n  const { scrollYProgress: heroProgress }',
      )
      .replace('import React, { useRef }', 'import React, { useRef, useEffect }');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_TARGET_UNATTACHED');
  });

  it('flags non-array useTransform ranges', () => {
    const code = SIMPLE_SCRUB.replace('useTransform(heroProgress, [0, 1], [0, -80])', 'useTransform(heroProgress, 0, 1)');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_TRANSFORM_RANGES');
  });

  it('flags declared-but-unbound motion values (dead animations)', () => {
    const code = SIMPLE_SCRUB.replace('y: heroY, ', '').replace('style={{ display: \'flex\', y: heroY }}', 'style={{ display: \'flex\' }}');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_UNBOUND_VALUE');
  });

  it('flags motion values used inside style expressions instead of bare bindings', () => {
    const code = SIMPLE_SCRUB.replace('y: heroY', 'y: heroY * 2');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('MOTION_VALUE_EXPRESSION');
  });

  it('flags a wrong useScroll destructure key', () => {
    const code = SIMPLE_SCRUB.replace('{ scrollYProgress: heroProgress }', '{ progress: heroProgress }');
    expect(codes(checkFile(code, { kind: 'page' }))).toContain('SCROLL_USESCROLL_SHAPE');
  });
});
