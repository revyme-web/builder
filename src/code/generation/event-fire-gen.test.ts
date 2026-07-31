import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import { setChildEventFireInCode, removeChildEventFireInCode, parseChildEventFires } from './event-fire-gen';

const parses = (c: string) => { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; };

const MASTER = `function Card({ style, childtrigger1, ...rest }: any) {
  return <motion.div data-id="root" {...rest} style={{ ...style }}>
    <motion.div data-id="child" style={{ width: '50px' }}></motion.div>
  </motion.div>;
}`;
const SELF_CLOSE = `function Card({ childtrigger1 }: any) {
  return <div data-id="root"><Inner data-id="child" style={{ width: '5px' }} /></div>;
}`;

describe('event-fire-gen', () => {
  it('binds a child onClick to an event var', () => {
    const out = setChildEventFireInCode(MASTER, 'child', 'click', 'childtrigger1');
    expect(parses(out)).toBe(true);
    expect(out).toMatch(/data-id="child"[^>]*onClick=\{childtrigger1\}/);
    expect(parseChildEventFires(out, 'child', ['childtrigger1'])).toEqual([{ trigger: 'click', eventVar: 'childtrigger1', delay: 0 }]);
  });

  it('works on a self-closing child tag', () => {
    const out = setChildEventFireInCode(SELF_CLOSE, 'child', 'mouseEnter', 'childtrigger1');
    expect(parses(out)).toBe(true);
    expect(out).toMatch(/onMouseEnter=\{childtrigger1\}\s*\/>/);
  });

  it('replaces an existing same-trigger binding (no duplicate)', () => {
    let out = setChildEventFireInCode(MASTER, 'child', 'click', 'childtrigger1');
    out = setChildEventFireInCode(out, 'child', 'click', 'childtrigger1');
    expect((out.match(/onClick=/g) || []).length).toBe(1);
  });

  it('removes a binding', () => {
    let out = setChildEventFireInCode(MASTER, 'child', 'click', 'childtrigger1');
    out = removeChildEventFireInCode(out, 'child', 'click');
    expect(out).not.toContain('onClick');
    expect(parseChildEventFires(out, 'child', ['childtrigger1'])).toEqual([]);
  });

  it('parseChildEventFires ignores onClick referencing a NON-event identifier', () => {
    const out = setChildEventFireInCode(MASTER, 'child', 'click', 'childtrigger1');
    expect(parseChildEventFires(out, 'child', ['somethingElse'])).toEqual([]); // not in the event list
  });
});

describe('event-fire-gen — delay', () => {
  const M = `function C({ ev }: any) { return <div data-id="root"><div data-id="child" /></div>; }`;
  it('delay>0 emits setTimeout and parses back the delay', () => {
    const out = setChildEventFireInCode(M, 'child', 'click', 'ev', 0.5);
    expect(out).toMatch(/onClick=\{\(\) => setTimeout\(ev, 500\)\}/);
    expect(parseChildEventFires(out, 'child', ['ev'])).toEqual([{ trigger: 'click', eventVar: 'ev', delay: 0.5 }]);
  });
  it('delay 0 stays direct', () => {
    const out = setChildEventFireInCode(M, 'child', 'click', 'ev', 0);
    expect(out).toMatch(/onClick=\{ev\}/);
    expect(parseChildEventFires(out, 'child', ['ev'])).toEqual([{ trigger: 'click', eventVar: 'ev', delay: 0 }]);
  });
});

describe('event-fire-gen — per-variant (variant-agnostic) firing', () => {
  // Simple master → detectVariantVar returns `initialVariant` (a param in scope).
  const VM = `function Card({ initialVariant = 'default', ev }: any) {
    return <motion.div data-id="root"><motion.div data-id="child" style={{ width: '5px' }} /></motion.div>;
  }`;

  it('removing on a non-primary variant keeps the base, blanks only that variant', () => {
    let out = setChildEventFireInCode(VM, 'child', 'click', 'ev'); // base on all
    out = removeChildEventFireInCode(out, 'child', 'click', 'variant-2'); // remove on v2 only
    expect(parses(out)).toBe(true);
    expect(out).toMatch(/onClick=\{initialVariant === 'variant-2' \? undefined : ev\}/);
    // still fires on the primary / variant-1, NOT on variant-2
    expect(parseChildEventFires(out, 'child', ['ev'], 'default')).toEqual([{ trigger: 'click', eventVar: 'ev', delay: 0 }]);
    expect(parseChildEventFires(out, 'child', ['ev'], 'variant-1')).toEqual([{ trigger: 'click', eventVar: 'ev', delay: 0 }]);
    expect(parseChildEventFires(out, 'child', ['ev'], 'variant-2')).toEqual([]);
  });

  it('removing on the PRIMARY removes the binding everywhere', () => {
    let out = setChildEventFireInCode(VM, 'child', 'click', 'ev');
    out = removeChildEventFireInCode(out, 'child', 'click', 'variant-2'); // create a per-variant ternary
    out = removeChildEventFireInCode(out, 'child', 'click', 'default');   // primary remove
    expect(out).not.toContain('onClick');
    expect(parseChildEventFires(out, 'child', ['ev'], 'variant-2')).toEqual([]);
  });

  it('adding ONLY on a specific variant fires there and nowhere else', () => {
    const out = setChildEventFireInCode(VM, 'child', 'click', 'ev', 0, 'variant-2');
    expect(parses(out)).toBe(true);
    expect(out).toMatch(/onClick=\{initialVariant === 'variant-2' \? ev : undefined\}/);
    expect(parseChildEventFires(out, 'child', ['ev'], 'variant-2')).toEqual([{ trigger: 'click', eventVar: 'ev', delay: 0 }]);
    expect(parseChildEventFires(out, 'child', ['ev'], 'default')).toEqual([]);
  });

  it('re-adding on the removed variant collapses back to the plain base form', () => {
    let out = setChildEventFireInCode(VM, 'child', 'click', 'ev');
    out = removeChildEventFireInCode(out, 'child', 'click', 'variant-2');
    out = setChildEventFireInCode(out, 'child', 'click', 'ev', 0, 'variant-2'); // re-enable on v2
    expect(out).toMatch(/onClick=\{ev\}/); // collapsed — no ternary
    expect(out).not.toContain('?');
  });

  it('uses `variant` when the master has connection state', () => {
    const CONN = `function Card({ initialVariant = 'default', ev }: any) {
      const [variant, setVariant] = useState(initialVariant);
      return <motion.div data-id="root" animate={['default', variant]}><motion.div data-id="child" /></motion.div>;
    }`;
    let out = setChildEventFireInCode(CONN, 'child', 'click', 'ev');
    out = removeChildEventFireInCode(out, 'child', 'click', 'variant-2');
    expect(out).toMatch(/onClick=\{variant === 'variant-2' \? undefined : ev\}/);
  });
});
