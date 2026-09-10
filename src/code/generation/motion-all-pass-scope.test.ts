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
import { composeAllScrollAppearConflicts, decomposeAllScrollConflicts, motionPassCandidates } from './generator-motion-scroll-fx';
import { hasAppearTransformConflict, hasDirectionTransformConflict, hasGestureTransformConflict } from './generator-motion-compose';
import { hasLoopConflict } from './generator-motion-loop';

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

  // ── `<` inside an attribute value ────────────────────────────────────────
  // The candidate filter must read each tag the SAME way the per-node
  // detectors do: anchored on the data-id, sliced FORWARD. An earlier version
  // searched BACKWARDS from the driver attribute with `lastIndexOf('<')`, which
  // is not string-aware — renaming a layer to `Card <Fancy>` writes
  // `data-name="Card <Fancy>"` right after the data-id, the backwards walk
  // landed inside that value, the tag slice held no data-id, and the node
  // vanished from the compose pass. Worse, the decompose pass still visited it
  // (its filter is declaration-based), so one animation edit anywhere on the
  // page tore the node apart and never put it back: the separate form shipped
  // to the .tsx, where Motion ignores the declarative `whileInView` because the
  // style MotionValue owns the prop. The reveal died on canvas AND live.
  const ANGLE_NAME = `'use client';
import React from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const { scrollYProgress } = useScroll();
  const fade = useTransform(scrollYProgress, [0, 1], [1, 0.4]);
  return (<div data-id="root">
    <motion.div data-id="card" data-name="Card <Fancy>" style={{ position: 'relative', opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}></motion.div>
    <motion.div data-id="plain" data-name="Plain" style={{ position: 'relative', opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }}></motion.div>
  </div>);
}`;

  const anyConflict = (code: string, id: string) =>
    hasAppearTransformConflict(code, id) || hasDirectionTransformConflict(code, id)
    || hasGestureTransformConflict(code, id) || hasLoopConflict(code, id);

  it('composes a node whose data-name contains a `<`', () => {
    expect(anyConflict(ANGLE_NAME, 'card')).toBe(true);          // there IS work
    const composed = composeAllScrollAppearConflicts(ANGLE_NAME);
    expect(composed).toContain('cardAppear');
    // No id is left reporting a conflict — the pass is complete, not partial.
    for (const id of ['card', 'plain']) expect(anyConflict(composed, id)).toBe(false);
  });

  it('survives the decompose → compose sandwich the mutation queue runs', () => {
    // The two passes share one candidate rule on purpose: when they disagreed,
    // decompose took a node apart that compose then refused to rebuild.
    const combined = composeAllScrollAppearConflicts(ANGLE_NAME);
    const round = composeAllScrollAppearConflicts(decomposeAllScrollConflicts(combined));
    expect(round).toContain('cardAppear');
    expect(round).toContain('plainAppear');
    for (const id of ['card', 'plain']) expect(anyConflict(round, id)).toBe(false);
  });

  // ── THE INVARIANT ────────────────────────────────────────────────────────
  // The filter exists only to skip ids that cannot possibly match, so it must
  // be a SUPERSET of the ids the per-node detectors actually flag. Over-
  // inclusion costs one re-check that returns false; under-inclusion silently
  // drops the node's effect — and because the decompose pass shares this rule,
  // an under-inclusion can tear a node apart and never put it back.
  //
  // Each shape below broke, or could break, a filter that reads tags any way
  // other than "anchor on data-id, slice forward".
  const SHAPES: Record<string, string> = {
    'driver last, `<` in data-name':
      `<motion.div data-id="a" data-name="Card <Fancy>" style={{ opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}></motion.div>`,
    'driver last, `<` and `>` in data-name':
      `<motion.div data-id="a" data-name="A <b> c" style={{ opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}></motion.div>`,
    'multi-line tag':
      `<motion.div\n  data-id="a"\n  data-name="Card <Fancy>"\n  style={{ opacity: fade }}\n  initial={{ opacity: 0 }}\n  whileInView={{ opacity: 1 }}\n></motion.div>`,
    'self-closing':
      `<motion.img data-id="a" data-name="Pic <1>" style={{ opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} />`,
    'loop carrier last':
      `<motion.div data-id="a" data-name="Row <2>" style={{ x: fade }} data-loop='{"props":{"x":"10px"},"transition":{"repeat":"Infinity","duration":"2"}}'></motion.div>`,
    'gesture driver':
      `<motion.div data-id="a" data-name="Btn <x>" style={{ scale: fade }} whileHover={{ scale: 1.1 }}></motion.div>`,
    'svg data-uri in the tag':
      `<motion.div data-id="a" style={{ opacity: fade, backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\'%3E%3C/svg%3E")' }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}></motion.div>`,
    'id with a colon (component instance)':
      `<motion.div data-id="inst:child" data-name="I <n>" style={{ opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}></motion.div>`,
    'id with a ghost suffix':
      `<motion.div data-id="row__2" data-name="R <2>" style={{ opacity: fade }} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }}></motion.div>`,
  };

  const wrap = (inner: string) => `'use client';
import React from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  const { scrollYProgress } = useScroll();
  const fade = useTransform(scrollYProgress, [0, 1], [1, 0.4]);
  return (<div data-id="root">
${inner}
  </div>);
}`;

  it('keeps a merely-POSSIBLE driver as a candidate (over-inclusion is the safe bias)', () => {
    // `animate=` is in the driver set because it CAN carry a reveal, but on its
    // own no detector flags a conflict. The filter must still offer the id — it
    // is not the filter's job to decide, and a cheap false positive costs one
    // per-node re-check that returns false.
    const code = wrap(`<motion.div data-id="a" data-name="Tag <y>" style={{ opacity: fade }} animate={{ opacity: 1 }}></motion.div>`);
    const allIds = [...new Set([...code.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
    expect(motionPassCandidates(code, allIds)).toContain('a');
    expect(anyConflict(code, 'a')).toBe(false);        // …and nothing is composed
    expect(composeAllScrollAppearConflicts(code)).toBe(code);
  });

  for (const [label, inner] of Object.entries(SHAPES)) {
    it(`filter covers every flagged id — ${label}`, () => {
      const code = wrap(inner);
      const allIds = [...new Set([...code.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]))];
      const flagged = allIds.filter((id) => anyConflict(code, id));
      expect(flagged.length).toBeGreaterThan(0);          // the shape really conflicts
      const candidates = motionPassCandidates(code, allIds);
      for (const id of flagged) expect(candidates).toContain(id);
      // …and the pass actually resolves it, end to end.
      const composed = composeAllScrollAppearConflicts(code);
      for (const id of allIds) expect(anyConflict(composed, id)).toBe(false);
      // The sandwich the mutation queue runs round-trips.
      const round = composeAllScrollAppearConflicts(decomposeAllScrollConflicts(composed));
      for (const id of allIds) expect(anyConflict(round, id)).toBe(false);
    });
  }
});
