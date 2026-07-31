import { describe, it, expect } from 'vitest';
import { resolveResponsiveMotionProp } from './animation-scope-source';
import { parseJSXToNodes } from '@/code/parsing/parser';

// Build a parsed motion prop the way the canvas parser would, then resolve it
// for a given tile. Covers hover AND tap (same code path).
const PAGE = (whileProp: string) => `'use client';
function useMediaQuery(q: string){ return false; }
export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="root"><motion.div data-id="box" ${whileProp}></motion.div></div>;
}`;
const parse = (whileProp: string, key: 'whileHover' | 'whileTap') =>
  (parseJSXToNodes(PAGE(whileProp)).get('box') as any)?.motionProps?.[key];

const widths = [375, 768, 1470];
const onDesktop = { vpWidth: 1470, allWidths: widths, variant: null };
const onTablet = { vpWidth: 768, allWidths: widths, variant: null };

describe('resolveResponsiveMotionProp (hover + tap share this)', () => {
  it('base-only prop applies everywhere, never an override', () => {
    const p = parse('whileTap={{ scale: 0.95 }}', 'whileTap');
    const code = PAGE('whileTap={{ scale: 0.95 }}');
    const desk = resolveResponsiveMotionProp(p, code, onDesktop);
    expect(desk.applies).toBe(true); expect(desk.isOverride).toBe(false);
    expect(desk.props.scale).toBe('0.95');
  });

  it('responsive: tablet override on tablet, base on desktop', () => {
    const expr = 'whileTap={__mq0 ? { scale: 0.9, rotate: 5 } : { scale: 0.95 }}';
    const p = parse(expr, 'whileTap'); const code = PAGE(expr);
    const tab = resolveResponsiveMotionProp(p, code, onTablet);
    expect(tab.applies).toBe(true); expect(tab.isOverride).toBe(true);
    expect(tab.props).toEqual({ scale: '0.9', rotate: '5' });
    const desk = resolveResponsiveMotionProp(p, code, onDesktop);
    expect(desk.applies).toBe(true); expect(desk.isOverride).toBe(false);
    expect(desk.props).toEqual({ scale: '0.95' });          // base, not override
  });

  it('scoped-only (no base): shows on its tile only, as an override', () => {
    const expr = 'whileHover={__mq0 ? { scale: 1.1 } : undefined}';
    const p = parse(expr, 'whileHover'); const code = PAGE(expr);
    const tab = resolveResponsiveMotionProp(p, code, onTablet);
    expect(tab.applies).toBe(true); expect(tab.isOverride).toBe(true);
    const desk = resolveResponsiveMotionProp(p, code, onDesktop);
    expect(desk.applies).toBe(false);                        // no base → hidden on desktop
  });

  it('a default-variant-gated prop (solo-node appear) is NOT an override on the primary', () => {
    const COMP = `'use client';
function Comp({ initialVariant = 'default' }: { initialVariant?: string }) {
  const variant = initialVariant;
  return <motion.div data-id="box" initial={variant === 'default' ? { opacity: 0 } : undefined} whileInView={{ opacity: 1 }} viewport={{ once: true }}></motion.div>;
}`;
    const p = (parseJSXToNodes(COMP).get('box') as any)?.motionProps?.initial;
    const onPrimary = { vpWidth: 1470, allWidths: widths, variant: 'default' };
    const r = resolveResponsiveMotionProp(p, COMP, onPrimary);
    expect(r.applies).toBe(true);
    expect(r.isOverride).toBe(false); // purple Reset chip belongs on replicas only
    const onOther = { vpWidth: 1470, allWidths: widths, variant: 'variant-1' };
    expect(resolveResponsiveMotionProp(p, COMP, onOther).applies).toBe(false);
  });

  it('null prop → does not apply', () => {
    expect(resolveResponsiveMotionProp(null, '', onDesktop)).toEqual({ applies: false, isOverride: false, props: {} });
  });
});
