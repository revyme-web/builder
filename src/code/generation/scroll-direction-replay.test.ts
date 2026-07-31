import { describe, it, expect } from 'vitest';
import { updateScrollAnimInCode } from './generator-motion';

const PAGE = `import { motion, useScroll, useTransform } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="box" style={{ opacity: 1 }}></motion.div>
    </div>
  );
}`;
const cfg = (extra: any) => ({
  nodeId: 'box', trigger: 'layerInView' as const,
  stops: [{ progress: 0, props: { opacity: '1' } }, { progress: 1, props: { opacity: '0' } }],
  ...extra,
});

describe('On Scroll — Direction + Replay codegen', () => {
  it('default (down) → resting(1)→To(0) range, no latch', () => {
    const out = updateScrollAnimInCode(PAGE, cfg({}));
    expect(out).toContain('useScroll');
    expect(out).toContain('[1, 0]');          // resting(1) → To(0)
    expect(out).not.toContain('boxPeak');     // no latch
  });
  it('direction up → reversed output range [0, 1]', () => {
    const out = updateScrollAnimInCode(PAGE, cfg({ direction: 'up' }));
    expect(out).toContain('[0, 1]');          // flipped
  });
  it('replay false → peak-latch drives the transform', () => {
    const out = updateScrollAnimInCode(PAGE, cfg({ replay: false }));
    expect(out).toContain('const boxPeak = useRef(0);');
    expect(out).toContain('if (v > boxPeak.current) boxPeak.current = v;');
    expect(out).toContain('useTransform(boxLatched,');
  });
  it('replay true → no latch', () => {
    expect(updateScrollAnimInCode(PAGE, cfg({ replay: true }))).not.toContain('boxPeak');
  });
});

import { parseScrollHooks, getScrollDataForNode } from '@/code/parsing/scroll-parser';
describe('Direction/Replay round-trip — INFERRED FROM CODE (no comment markers)', () => {
  const read = (out: string) => getScrollDataForNode(parseScrollHooks(out), 'box');
  it('no @scroll comment markers emitted', () => {
    expect(updateScrollAnimInCode(PAGE, cfg({ direction: 'up', replay: false }))).not.toContain('@scroll');
  });
  it('direction:up replay:no inferred back from the output range + latch', () => {
    const r = read(updateScrollAnimInCode(PAGE, cfg({ direction: 'up', replay: false })));
    expect(r.direction).toBe('up');
    expect(r.replay).toBe(false);
  });
  it('default → down / replay', () => {
    const r = read(updateScrollAnimInCode(PAGE, cfg({})));
    expect(r.direction).toBe('down');
    expect(r.replay).toBe(true);
  });
  it('direction down + replay false', () => {
    const r = read(updateScrollAnimInCode(PAGE, cfg({ direction: 'down', replay: false })));
    expect(r.direction).toBe('down');
    expect(r.replay).toBe(false);
  });
});

describe('re-gen does not duplicate hooks (the latch cleanup bug)', () => {
  it('apply replay:false then change direction → ONE useScroll, ONE latch', () => {
    let out = updateScrollAnimInCode(PAGE, cfg({ replay: false }));
    out = updateScrollAnimInCode(out, cfg({ replay: false, direction: 'up' }));
    expect((out.match(/scrollYProgress:\s*boxProgress/g) || []).length).toBe(1);
    expect((out.match(/boxPeak\s*=\s*useRef/g) || []).length).toBe(1);
    expect((out.match(/boxLatched\s*=\s*useTransform/g) || []).length).toBe(1);
  });
  it('replay:false → replay:true removes the latch entirely', () => {
    let out = updateScrollAnimInCode(PAGE, cfg({ replay: false }));
    out = updateScrollAnimInCode(out, cfg({ replay: true }));
    expect(out).not.toContain('boxPeak');
    expect(out).not.toContain('boxLatched');
    expect((out.match(/scrollYProgress:\s*boxProgress/g) || []).length).toBe(1);
  });
})
