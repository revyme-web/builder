// motion-all-pass-scope.test.ts — the all-node compose/decompose passes must
// only VISIT nodes that can possibly match, and must still catch every node
// that can.
//
// Both passes used to walk every `data-id` in the file and call per-node
// helpers that each re-scan the whole source with a RegExp built from that
// node's name. On a real 444KB page with 853 ids that is ~4,000 full-file
// scans per animation edit — measured 822ms (decompose) + 699ms (compose),
// and the mutation queue runs BOTH around every animation mutation, so a
// single click on an offset value took ~3 seconds (user report 2026-09-09).
import { describe, it, expect, vi } from 'vitest';
import { trace } from '@/shared/debug-trace';
import { composeAllScrollAppearConflicts, decomposeAllScrollConflicts } from './generator-motion-scroll-fx';

/** One conflicting node (appear + a scroll transform on the same prop) buried
 *  in a page full of ordinary elements — the shape the filters must not miss. */
const filler = (n: number) => Array.from({ length: n }, (_, i) =>
  `    <div data-id="filler-${i}" style={{ position: 'relative' }}>text ${i}</div>`).join('\n');

const PAGE = (n: number) => `'use client';
import React from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const { scrollYProgress: boxProgress } = useScroll();
  const boxSmooth = useSpring(boxProgress, { duration: 0.5, bounce: 0.25 });
  const boxOpacity = useTransform(boxSmooth, [0, 1], [0.5, 1]);
  return (<div data-id="root">
${filler(n)}
    <motion.div data-id="box" initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ type: 'spring', duration: 0.5, bounce: 0.25 }} style={{position:'absolute', opacity: boxOpacity}}></motion.div>
  </div>);
}`;

describe('all-node motion passes', () => {
  it('still composes the one conflicting node in a page full of unrelated ids', () => {
    const combined = composeAllScrollAppearConflicts(PAGE(400));
    expect(combined).toContain('boxAppear');            // the node WAS composed
    expect(combined).not.toBe(PAGE(400));
    // Untouched neighbours stay byte-identical.
    expect(combined).toContain('<div data-id="filler-399"');
  });

  it('round-trips: decompose(compose(x)) restores the separate form', () => {
    const src = PAGE(50);
    const combined = composeAllScrollAppearConflicts(src);
    const back = decomposeAllScrollConflicts(combined);
    expect(back).toContain('whileInView={{');
    expect(back).not.toContain('boxAppear');
  });

  it('a page with no drivers and no motion declarations is returned untouched', () => {
    const plain = `'use client';\nexport default function Page() {\n  return (<div data-id="root">\n${filler(200)}\n  </div>);\n}`;
    expect(composeAllScrollAppearConflicts(plain)).toBe(plain);
    expect(decomposeAllScrollConflicts(plain)).toBe(plain);
  });

  it('visits only the conflicting nodes — the count does not grow with the page', () => {
    // Deterministic version of "it must not be O(page)": both passes trace how
    // many of the file's ids they actually visit. A wall-clock assertion here
    // would just be a flake under parallel test load.
    const candidates = (code: string) => {
      const spy = vi.spyOn(trace, 'fn');
      composeAllScrollAppearConflicts(code);
      decomposeAllScrollConflicts(code);
      const rows = spy.mock.calls
        .filter((c) => c[0] === 'compose-all:candidates' || c[0] === 'decompose-all:candidates')
        .map((c) => c[1] as { total: number; candidates: number });
      spy.mockRestore();
      return rows;
    };

    // Compose runs on the separate form; decompose only has work once the page
    // IS combined (its fast path returns early when no motion value exists), so
    // feed each pass the form it acts on.
    const small = [...candidates(PAGE(50)), ...candidates(composeAllScrollAppearConflicts(PAGE(50)))];
    const big = [...candidates(PAGE(1000)), ...candidates(composeAllScrollAppearConflicts(PAGE(1000)))];
    const totals = (rows: { total: number }[]) => Math.max(...rows.map((r) => r.total));
    // The page grew 20x…
    expect(totals(big)).toBeGreaterThan(totals(small) * 15);
    // …and every pass still visits exactly the one node that can conflict.
    expect(small.length).toBeGreaterThanOrEqual(2);
    expect(big.length).toBeGreaterThanOrEqual(2);
    for (const row of [...small, ...big]) expect((row as { candidates: number }).candidates).toBe(1);
  });
});
