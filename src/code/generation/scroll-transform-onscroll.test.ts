import { describe, it, expect } from 'vitest';
import { updateScrollAnimInCode, detectTriggerFromOffset, layerInViewOffset, layerInViewExitOffset, detectLayerExitFromOffset } from './generator-motion';
import { detectSectionViewportFromOffset } from './generator-motion-scroll';
import { parseJSX } from '@/code/parsing/ast-utils';
import { parseScrollHooks, getScrollDataForNode } from '@/code/parsing/scroll-parser';

const PAGE = `import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"><motion.div data-id="box" style={{ position: 'absolute', opacity: 1, top: '196px' }}></motion.div></div>);
}`;

describe('Scroll Transform "On Scroll" = whole-page progress (From at top)', () => {
  const out = updateScrollAnimInCode(PAGE, {
    nodeId: 'box', trigger: 'onScroll',
    stops: [{ progress: 0, props: { opacity: '0.5', scale: '0.5' } },
            { progress: 1, props: { opacity: '1', scale: '1' } }],
    transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
  });

  it('emits whole-page useScroll() with NO target/offset', () => {
    expect(out).toMatch(/useScroll\(\)/);                 // no target ref
    expect(out).not.toContain('target:');
    expect(out).not.toContain('offset:');
  });
  it('does NOT attach a ref to the element (so it round-trips as onScroll)', () => {
    expect(out).not.toMatch(/ref=\{boxRef\}/);
    expect(out).not.toContain('const boxRef = useRef');
  });
  it('From state is authored (0.5), output range [0.5, 1]', () => {
    expect(out).toMatch(/useTransform\([^,]+,\s*\[0,\s*1\],\s*\[0\.5,\s*1\]\)/);
  });
  it('valid JSX + round-trips to onScroll (no ref → hasRef false)', () => {
    expect(parseJSX(out)).not.toBeNull();
    const data = getScrollDataForNode(parseScrollHooks(out), 'box');
    const trig = detectTriggerFromOffset(data.source?.offset ?? null, !!data.source?.refVar, !!data.source?.sectionId);
    expect(trig).toBe('onScroll');
  });
});

describe('Scroll Transform output range is not reversed without direction', () => {
  const cfg = (direction?: 'down' | 'up') => ({
    nodeId: 'box', trigger: 'onScroll' as const,
    stops: [{ progress: 0, props: { opacity: '0.5', scale: '0.5' } },
            { progress: 1, props: { opacity: '1', scale: '1' } }],
    transition: { type: 'spring', stiffness: '300', damping: '74', mass: '1' },
    ...(direction ? { direction } : {}),
  });
  it('no direction → From 0.5 → To 1 (output [0.5, 1])', () => {
    const out = updateScrollAnimInCode(PAGE, cfg());
    expect(out).toMatch(/useTransform\([^,]+,\s*\[0,\s*1\],\s*\[0\.5,\s*1\]\)/);
    expect(out).not.toContain('[1, 0.5]');
  });
  it("direction:'up' DOES reverse (Animation concept) — documents the flip", () => {
    const out = updateScrollAnimInCode(PAGE, cfg('up'));
    expect(out).toMatch(/\[1,\s*0\.5\]/);
  });
});

describe('layerInViewOffset — position → useScroll offset', () => {
  it('top → finishes at viewport top (full pass-through)', () => {
    expect(layerInViewOffset('top')).toBe('["start end", "start start"]');
  });
  it('center/middle → finishes at viewport center', () => {
    expect(layerInViewOffset('center')).toBe('["start end", "start center"]');
    expect(layerInViewOffset('middle')).toBe('["start end", "start center"]');
  });
  it('bottom → finishes when the layer is fully entered (default)', () => {
    expect(layerInViewOffset('bottom')).toBe('["start end", "end end"]');
  });
  it('round-trips through detectSectionViewportFromOffset', () => {
    expect(detectSectionViewportFromOffset(layerInViewOffset('top'))).toBe('top');
    expect(detectSectionViewportFromOffset(layerInViewOffset('center'))).toBe('middle');
    expect(detectSectionViewportFromOffset(layerInViewOffset('bottom'))).toBe('bottom');
  });
});

describe('Scroll Transform "Layer in View" — scrubbed to the layer position', () => {
  const layerCfg = (sectionViewport?: 'top' | 'middle' | 'bottom', layerRange?: string) => ({
    nodeId: 'box', trigger: 'layerInView' as const,
    stops: [{ progress: 0, props: { opacity: '0', scale: '0.8' } },
            { progress: 1, props: { opacity: '1', scale: '1' } }],
    transition: { type: 'tween' as const, ease: 'linear', duration: '0' },
    ...(sectionViewport ? { sectionViewport } : {}),
    ...(layerRange ? { layerRange } : {}),
  });

  it('attaches the element ref as the scroll target (not whole-page)', () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg('middle'));
    expect(out).toContain('const boxRef = useRef');
    expect(out).toMatch(/ref=\{boxRef\}/);
    expect(out).toContain('target: boxRef');
  });

  it("position 'top' → offset [start end, start start]", () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg('top'));
    expect(out).toContain('offset: ["start end", "start start"]');
  });
  it("position 'middle' → offset [start end, start center]", () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg('middle'));
    expect(out).toContain('offset: ["start end", "start center"]');
  });
  it("position 'bottom' → offset [start end, end end]", () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg('bottom'));
    expect(out).toContain('offset: ["start end", "end end"]');
  });

  it('legacy layerRange (no position) still maps 0.3 → start 70%', () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg(undefined, '0.3'));
    expect(out).toContain('offset: ["start end", "start 70%"]');
  });

  it('valid JSX + round-trips to layerInView (ref present, no section)', () => {
    const out = updateScrollAnimInCode(PAGE, layerCfg('top'));
    expect(parseJSX(out)).not.toBeNull();
    const data = getScrollDataForNode(parseScrollHooks(out), 'box');
    const trig = detectTriggerFromOffset(
      data.source?.offset ?? null, !!data.source?.refVar, !!data.source?.sectionId,
    );
    expect(trig).toBe('layerInView');
  });
});

describe('layerInViewExitOffset — EXIT scrub (leaves off the top)', () => {
  it('top → begins when the layer top hits the viewport top', () => {
    expect(layerInViewExitOffset('top')).toBe('["start start", "end start"]');
  });
  it('center/middle → begins when the layer top hits the viewport center', () => {
    expect(layerInViewExitOffset('center')).toBe('["start center", "end start"]');
    expect(layerInViewExitOffset('middle')).toBe('["start center", "end start"]');
  });
  it('bottom → full pass-through exit (begins the moment it enters)', () => {
    expect(layerInViewExitOffset('bottom')).toBe('["start end", "end start"]');
  });
});

describe('detectLayerExitFromOffset — Enter vs Exit round-trip', () => {
  it('ENTER offsets → false', () => {
    expect(detectLayerExitFromOffset(layerInViewOffset('top'))).toBe(false);
    expect(detectLayerExitFromOffset(layerInViewOffset('center'))).toBe(false);
    expect(detectLayerExitFromOffset(layerInViewOffset('bottom'))).toBe(false);
    expect(detectLayerExitFromOffset(null)).toBe(false);
  });
  it('EXIT offsets → true', () => {
    expect(detectLayerExitFromOffset(layerInViewExitOffset('top'))).toBe(true);
    expect(detectLayerExitFromOffset(layerInViewExitOffset('center'))).toBe(true);
    expect(detectLayerExitFromOffset(layerInViewExitOffset('bottom'))).toBe(true);
  });
  it('position still decodes from an EXIT offset (first anchor)', () => {
    expect(detectSectionViewportFromOffset(layerInViewExitOffset('top'))).toBe('top');
    expect(detectSectionViewportFromOffset(layerInViewExitOffset('center'))).toBe('middle');
    expect(detectSectionViewportFromOffset(layerInViewExitOffset('bottom'))).toBe('bottom');
  });
});

describe('Scroll Transform "Layer in View" EXIT — the sticky-shrink case', () => {
  // Mirrors the user's setup: a sticky video that must stay intact through its
  // entrance + sticky hold, then scale down ONLY as it slides off the top.
  const exitCfg = (sectionViewport: 'top' | 'middle' | 'bottom') => ({
    nodeId: 'box', trigger: 'layerInView' as const,
    stops: [{ progress: 0, props: { scale: '1' } },
            { progress: 1, props: { scale: '0.5' } }],
    transition: { type: 'tween' as const, ease: 'linear', duration: '0' },
    sectionViewport, layerExit: true,
  });

  it("top exit → offset ['start start', 'end start'] (shrink as it leaves the top)", () => {
    const out = updateScrollAnimInCode(PAGE, exitCfg('top'));
    expect(out).toContain('offset: ["start start", "end start"]');
    expect(out).toContain('target: boxRef');
  });
  it('middle exit → offset [start center, end start]', () => {
    expect(updateScrollAnimInCode(PAGE, exitCfg('middle'))).toContain('offset: ["start center", "end start"]');
  });
  it('bottom exit → offset [start end, end start] (full pass-through)', () => {
    expect(updateScrollAnimInCode(PAGE, exitCfg('bottom'))).toContain('offset: ["start end", "end start"]');
  });
  it('layerExit takes precedence over a stale layerRange', () => {
    const out = updateScrollAnimInCode(PAGE, { ...exitCfg('top'), layerRange: '0.3' } as any);
    expect(out).toContain('offset: ["start start", "end start"]');
    expect(out).not.toContain('start 70%');
  });
  it('full round-trip: exit offset → layerInView trigger + Exit timing + position', () => {
    const out = updateScrollAnimInCode(PAGE, exitCfg('top'));
    expect(parseJSX(out)).not.toBeNull();
    const data = getScrollDataForNode(parseScrollHooks(out), 'box');
    const offset = data.source?.offset ?? null;
    expect(detectTriggerFromOffset(offset, !!data.source?.refVar, !!data.source?.sectionId)).toBe('layerInView');
    expect(detectLayerExitFromOffset(offset)).toBe(true);
    expect(detectSectionViewportFromOffset(offset)).toBe('top');
  });
});
