import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import { dedupeAppearHooks } from './generator-motion';

const parses = (c: string) => { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; };

// The exact shape that crashed the deployed site: TWO duplicate appear effects
// ABOVE the `const heroBgInView`/`heroBgAppear` declarations + one below. The
// deps array `[heroBgInView]` is evaluated during render → temporal-dead-zone
// ReferenceError under production SSR.
const BROKEN = `export default function Page() {
  const heroBgSpeedY = useTransform(s, (v) => v);
  useEffect(() => {
    if (heroBgInView) {
      const _c = animate(heroBgAppear, 1, {
        type: 'spring',
        duration: 2.3,
        bounce: 0,
        delay: 0
      });
      return () => _c.stop();
    }
  }, [heroBgInView]);
  useEffect(() => {
    if (heroBgInView) {
      const _c = animate(heroBgAppear, 1, {
        type: 'spring',
        duration: 2.3,
        bounce: 0,
        delay: 0
      });
      return () => _c.stop();
    }
  }, [heroBgInView]);
  const heroBgRef = useRef(null);
  const heroBgInView = useInView(heroBgRef, { once: true });
  const heroBgAppear = useMotionValue(0);
  useEffect(() => {if (heroBgInView) {const _c = animate(heroBgAppear, 1, { type: 'spring', duration: 2.3, bounce: 0, delay: 0 });return () => _c.stop();}}, [heroBgInView]);
  return <div data-id="root" />;
}`;

describe('dedupeAppearHooks', () => {
  const out = dedupeAppearHooks(BROKEN);

  test('collapses the 3 appear effects to exactly one', () => {
    expect((out.match(/\}, \[heroBgInView\]\);/g) || []).length).toBe(1);
  });

  test('the surviving effect comes AFTER the const declarations (no TDZ)', () => {
    const declIdx = out.indexOf('const heroBgInView = useInView');
    const appearDeclIdx = out.indexOf('const heroBgAppear = useMotionValue(0)');
    const effIdx = out.indexOf(', [heroBgInView]);');
    expect(declIdx).toBeGreaterThan(-1);
    expect(effIdx).toBeGreaterThan(appearDeclIdx);
    expect(effIdx).toBeGreaterThan(declIdx);
  });

  test('keeps the spring params + still parses', () => {
    expect(out).toContain("type: 'spring'");
    expect(out).toContain('duration: 2.3');
    expect(parses(out)).toBe(true);
  });

  test('idempotent — running twice is a no-op on the second pass', () => {
    const twice = dedupeAppearHooks(out);
    expect(twice).toBe(out);
  });

  test('leaves a correctly-ordered single appear effect untouched', () => {
    const good = `function P() {
  const xRef = useRef(null);
  const xInView = useInView(xRef, { once: true });
  const xAppear = useMotionValue(0);
  useEffect(() => { if (xInView) { const _c = animate(xAppear, 1, { type: 'spring', duration: 0.5 }); return () => _c.stop(); } }, [xInView]);
  return <div/>;
}`;
    expect((dedupeAppearHooks(good).match(/\}, \[xInView\]\);/g) || []).length).toBe(1);
    expect(parses(dedupeAppearHooks(good))).toBe(true);
  });
});
