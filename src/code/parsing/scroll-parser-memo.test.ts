// scroll-parser-memo.test.ts — `parseScrollHooks` is a pure function of the
// source, and the motion generators call it once per candidate node. On a
// 444KB page one animation edit ran it 46 times at 13.6ms each (measured
// 2026-09-09) — half a second of re-parsing the same unchanged string.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseScrollHooks, clearScrollHooksMemo } from './scroll-parser';
import { trace } from '@/shared/debug-trace';

const CODE = `'use client';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const boxRef = useRef(null);
  const { scrollYProgress: boxProgress } = useScroll({ target: boxRef, offset: ["start end", "end start"] });
  const boxY = useTransform(boxProgress, [0, 1], [0, 100]);
  return <motion.div data-id="box" ref={boxRef} style={{ y: boxY }} />;
}`;

describe('parseScrollHooks memo', () => {
  beforeEach(() => clearScrollHooksMemo());

  it('parses once for the same string and reuses the result', () => {
    const spy = vi.spyOn(trace, 'fn');
    const a = parseScrollHooks(CODE);
    const b = parseScrollHooks(CODE);
    const parses = spy.mock.calls.filter(c => c[0] === 'scroll-parser:parse').length;
    spy.mockRestore();
    expect(parses).toBe(1);
    expect(b).toBe(a);            // same object, no re-work
    expect(a.transforms.length).toBe(1);
  });

  it('re-parses as soon as the code changes', () => {
    const first = parseScrollHooks(CODE);
    const edited = parseScrollHooks(CODE.replace('[0, 100]', '[0, 200]'));
    expect(edited).not.toBe(first);
    expect(edited.transforms[0].outputRange).not.toEqual(first.transforms[0].outputRange);
    // …and going back to the original string parses it again, correctly.
    expect(parseScrollHooks(CODE).transforms[0].outputRange).toEqual(first.transforms[0].outputRange);
  });

  it('a file with no useScroll never reaches the parser at all', () => {
    const spy = vi.spyOn(trace, 'fn');
    const out = parseScrollHooks('export default function Page() { return null; }');
    const parses = spy.mock.calls.filter(c => c[0] === 'scroll-parser:parse').length;
    spy.mockRestore();
    expect(parses).toBe(0);
    expect(out).toEqual({ refs: [], sources: [], transforms: [], bindings: [] });
  });
});
