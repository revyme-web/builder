// TEMPORARY REVIEW PROBE — deletes itself after the review run.
// Freezes the object the parseScrollHooks memo hands out, then drives every
// consumer over the SAME code string. Any in-place mutation of the shared
// result (push/sort/field write) throws TypeError in strict mode.
import { describe, it, expect } from 'vitest';
import {
  parseScrollHooks, clearScrollHooksMemo, getScrollDataForNode, getMultiSectionForNode,
} from './scroll-parser';
import {
  buildScrollFxSpec, composeAllScrollAppearConflicts, decomposeAllScrollConflicts,
  removeScrollAnimFromCode, getScrollFx, robustClearScrollFx, clearNodeScrollFx,
  decomposeScrollAppearInCode, decomposeScrollDirectionTransformInCode,
  removeScrollSpeedFromCode, getSpeedResponsive, updateScrollSpeedInCode,
} from '../generation/generator-motion-scroll-fx';
import {
  hasAppearTransformConflict, composeScrollAppearInCode, hasDirectionTransformConflict,
  hasGestureTransformConflict, composeGestureInCode, decomposeGestureInCode, dedupeAppearHooks,
} from '../generation/generator-motion-compose';
import { updateScrollAnimInCode, removeScrollDirectionFromCode, updateScrollDirectionAnimInCode } from '../generation/generator-motion-scroll';
import { getScrollBoundProps } from '@/editor/hooks/useScrollBoundProps';

const SRC = `'use client';
import React, { useRef, useState, useEffect } from 'react';
import { motion, useScroll, useTransform, useSpring, useMotionValueEvent } from 'framer-motion';
export default function Page() {
  const boxRef = useRef(null);
  const { scrollYProgress: boxProgress } = useScroll({ target: boxRef, offset: ["start end", "end start"] });
  const boxSmooth = useSpring(boxProgress, { stiffness: 100, damping: 30 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const boxScale = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  const { scrollYProgress: spProgress } = useScroll();
  const spSpeedY = useTransform(spProgress, (v) => v * (1 - 80 / 100));
  const [dirScrolled, setDirScrolled] = useState(false);
  const { scrollY: dirScrollY } = useScroll();
  useMotionValueEvent(dirScrollY, "change", (y) => { const prev = dirScrollY.getPrevious() ?? 0; if (y > prev) setDirScrolled(true); else if (y < prev) setDirScrolled(false); });
  const dirOpacity = useTransform(boxSmooth, [0, 1], [1, 0]);
  const secSec0Ref = useRef(null);
  const secSec1Ref = useRef(null);
  const [secSecPositions, setSecSecPositions] = useState([0, 0]);
  useEffect(() => { secSec0Ref.current = document.getElementById('a'); secSec1Ref.current = document.getElementById('b'); const compute = () => { const offsetPx = window.innerHeight / 2; }; }, []);
  const { scrollYProgress: secProgress } = useScroll();
  const secOpacity = useTransform(secProgress, [0, secSecPositions[0], secSecPositions[1], 1], [0, 0.5, 1, 1]);
  return (<div data-id="root" style={{ position: 'relative' }}>
    <motion.div data-id="box" ref={boxRef} initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }} style={{ position: 'absolute', opacity: boxOpacity, scale: boxScale }}></motion.div>
    <motion.div data-id="sp" style={{ position: 'absolute', y: spSpeedY }}></motion.div>
    <motion.div data-id="dir" animate={dirScrolled ? { opacity: 0 } : { opacity: 1 }} transition={{ type: 'spring', duration: 0.5 }} style={{ position: 'absolute', opacity: dirOpacity }}></motion.div>
    <motion.div data-id="hov" whileHover={{ opacity: 0.8 }} style={{ position: 'absolute', opacity: boxOpacity }}></motion.div>
    <motion.div data-id="sec" style={{ position: 'absolute', opacity: secOpacity }}></motion.div>
  </div>);
}`;

function deepFreeze(o: unknown): void {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) return;
  Object.freeze(o);
  for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
}

describe('probe: shared parse result is never mutated by a consumer', () => {
  it('sanity — the fixture parses into the shapes under test', () => {
    clearScrollHooksMemo();
    const d = parseScrollHooks(SRC);
    expect(d.transforms.length).toBeGreaterThan(3);
    expect(getScrollDataForNode(d, 'box').bindings.length).toBe(2);
    expect(d.multiSection?.length).toBe(1);
    expect(getMultiSectionForNode(d, 'sec')).not.toBeNull();
    expect(hasAppearTransformConflict(SRC, 'box')).toBe(true);
    expect(hasDirectionTransformConflict(SRC, 'dir')).toBe(true);
    expect(hasGestureTransformConflict(SRC, 'hov')).toBe(true);
  });

  it('every consumer runs against a FROZEN memo result without throwing', () => {
    clearScrollHooksMemo();
    deepFreeze(parseScrollHooks(SRC)); // memo slot now holds a frozen object
    const ids = ['root', 'box', 'sp', 'dir', 'hov', 'sec'];
    for (const id of ids) {
      expect(() => buildScrollFxSpec(SRC, id)).not.toThrow();
      expect(() => getScrollFx(SRC, id)).not.toThrow();
      expect(() => getScrollDataForNode(parseScrollHooks(SRC), id)).not.toThrow();
      expect(() => getScrollBoundProps(parseScrollHooks(SRC), id)).not.toThrow();
      expect(() => getMultiSectionForNode(parseScrollHooks(SRC), id)).not.toThrow();
      expect(() => hasAppearTransformConflict(SRC, id)).not.toThrow();
      expect(() => hasDirectionTransformConflict(SRC, id)).not.toThrow();
      expect(() => hasGestureTransformConflict(SRC, id)).not.toThrow();
      expect(() => composeScrollAppearInCode(SRC, id)).not.toThrow();
      expect(() => composeGestureInCode(SRC, id, 'hover')).not.toThrow();
      expect(() => decomposeGestureInCode(SRC, id, 'hover')).not.toThrow();
      expect(() => decomposeScrollAppearInCode(SRC, id)).not.toThrow();
      expect(() => decomposeScrollDirectionTransformInCode(SRC, id)).not.toThrow();
      expect(() => removeScrollAnimFromCode(SRC, id)).not.toThrow();
      expect(() => removeScrollDirectionFromCode(SRC, id)).not.toThrow();
      expect(() => removeScrollSpeedFromCode(SRC, id)).not.toThrow();
      expect(() => getSpeedResponsive(SRC, id)).not.toThrow();
      expect(() => robustClearScrollFx(SRC, id)).not.toThrow();
      expect(() => clearNodeScrollFx(SRC, id)).not.toThrow();
      expect(() => updateScrollSpeedInCode(SRC, { nodeId: id, speed: 70 })).not.toThrow();
      expect(() => updateScrollAnimInCode(SRC, {
        nodeId: id, trigger: 'layerInView',
        stops: [{ progress: 0, props: { opacity: '1' } }, { progress: 1, props: { opacity: '0' } }],
        transition: { type: 'spring', duration: '0.5', bounce: '0.25' }, direction: 'down', replay: true,
      })).not.toThrow();
      expect(() => updateScrollDirectionAnimInCode(SRC, {
        nodeId: id, toProps: { opacity: '0' }, direction: 'down', replay: true,
        transition: { type: 'spring', duration: '0.5' },
      })).not.toThrow();
    }
    expect(() => dedupeAppearHooks(SRC)).not.toThrow();
    expect(() => composeAllScrollAppearConflicts(SRC)).not.toThrow();
    expect(() => decomposeAllScrollConflicts(SRC)).not.toThrow();
  });
});
