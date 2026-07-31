import { describe, it, expect } from 'vitest';
import { updateMotionPropInCode, scopeMotionPropInCode } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
// extractMotionProps isn't exported; assert via the generated string + a re-parse
// of the scoped form through the public parser would need a full file. Here we
// verify the codegen round-trip at the string level (what the canvas parser reads).

// `animate={variant}` signals a connection-style component → variant gates use
// the `variant` (useState) variable. Components WITHOUT it use `initialVariant`
// (see the dedicated regression test at the bottom).
const BASE = `function C() {
  const [variant, setVariant] = React.useState('default');
  return <motion.div data-id="box" animate={variant} style={{ width: '100px' }}></motion.div>;
}`;

describe('motion whileHover — per-scope wrap (gen)', () => {
  it('variant scope wraps the value in a name ternary', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    expect(out).toContain('whileHover={{ scale: 1.05 }}');
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { variant: 'variant-2' });
    expect(out).toContain("whileHover={variant === 'variant-2' ? { scale: 1.05 } : undefined}");
  });

  it('viewport scope injects a REACTIVE useMediaQuery hook + const and gates on it', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { query: '(max-width: 375px)' });
    // hook injected once at module scope
    expect(out).toContain('function useMediaQuery(query: string): boolean');
    expect(out).toContain('addEventListener'); // reactive — re-renders on resize
    // const in the component body
    expect(out).toContain("const __mq0 = useMediaQuery('(max-width: 375px)');");
    // prop gates on the reactive boolean
    expect(out).toContain('whileHover={__mq0 ? { scale: 1.05 } : undefined}');
  });

  it('reuses one useMediaQuery const for the same query across props', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    out = updateMotionPropInCode(out, 'box', 'whileTap', { scale: '0.95' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { query: '(max-width: 375px)' });
    out = scopeMotionPropInCode(out, 'box', 'whileTap', { query: '(max-width: 375px)' });
    // one hook, one const, both props gate on __mq0
    expect((out.match(/function useMediaQuery/g) || []).length).toBe(1);
    expect((out.match(/= useMediaQuery\(/g) || []).length).toBe(1);
    expect(out).toContain('whileHover={__mq0 ?');
    expect(out).toContain('whileTap={__mq0 ?');
  });

  it('re-editing props on a SCOPED hover replaces the object, keeps the wrapper (no dup)', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { variant: 'variant-2' });
    out = updateMotionPropInCode(out, 'box', 'whileHover', { scale: '1.2', opacity: '0.8' });
    expect((out.match(/whileHover=/g) || []).length).toBe(1);           // no duplicate attr
    expect(out).toContain("variant === 'variant-2' ?");                  // wrapper preserved
    expect(out).toContain('scale: 1.2');
    expect(out).toContain("opacity: 0.8");
  });

  it('null scope unwraps back to the bare object', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { variant: 'variant-2' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', null);
    expect(out).toContain('whileHover={{ scale: 1.05 }}');
    expect(out).not.toContain('variant ===');
  });

  it('parser reads the scoped object + _scope marker', () => {
    let out = updateMotionPropInCode(BASE, 'box', 'whileHover', { scale: '1.05' });
    out = scopeMotionPropInCode(out, 'box', 'whileHover', { variant: 'variant-2' });
    // the scoped form must still be valid JSX
    expect(parseJSX(out)).not.toBeNull();
  });
});

import { removeMotionPropFromCode } from './generator-motion';
describe('removeMotionPropFromCode — handles the scoped ternary form', () => {
  it('removes a viewport-scoped whileHover (ternary), not just bare {{…}}', () => {
    const SCOPED = `function P() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  return <motion.div data-id="box" style={{ width: '1px' }} whileHover={__mq0 ? { scale: 1.05 } : undefined}></motion.div>;
}`;
    const out = removeMotionPropFromCode(SCOPED, 'box', 'whileHover');
    expect(out).not.toContain('whileHover');
    expect(out).toContain("data-id=\"box\"");
  });
  it('still removes the bare form', () => {
    const BARE = `<motion.div data-id="box" whileHover={{ scale: 1.05 }}></motion.div>`;
    expect(removeMotionPropFromCode(BARE, 'box', 'whileHover')).not.toContain('whileHover');
  });
  it('variant ternary too', () => {
    const V = `<motion.div data-id="box" whileHover={variant === 'v2' ? { scale: 1.1 } : undefined}></motion.div>`;
    expect(removeMotionPropFromCode(V, 'box', 'whileHover')).not.toContain('whileHover');
  });
});

import { setMotionPropScopedValue, removeMotionPropScopeBranch } from './generator-motion';
describe('responsive VALUE override (base + per-viewport branch)', () => {
  const BASE_HOVER = `function P() {
  return <motion.div data-id="box" style={{ width: '1px' }} whileHover={{ scale: 1.05 }}></motion.div>;
}`;
  it('edit on a replica keeps the base and adds the tablet branch', () => {
    const out = setMotionPropScopedValue(BASE_HOVER, 'box', 'whileHover',
      { scale: '1.05', rotate: '110' }, { query: '(max-width: 768px)' });
    expect(out).toContain("const __mq0 = useMediaQuery('(max-width: 768px)')");
    expect(out).toContain('whileHover={__mq0 ? { scale: 1.05, rotate: 110 } : { scale: 1.05 }}');
  });
  it('edit on primary (scope null) updates the base, keeps the override', () => {
    let out = setMotionPropScopedValue(BASE_HOVER, 'box', 'whileHover',
      { scale: '1.05', rotate: '110' }, { query: '(max-width: 768px)' });
    out = setMotionPropScopedValue(out, 'box', 'whileHover', { scale: '1.2' }, null);
    expect(out).toContain('whileHover={__mq0 ? { scale: 1.05, rotate: 110 } : { scale: 1.2 }}');
  });
  it('no base (scoped-only add) → `? … : undefined`', () => {
    const NO_HOVER = `<motion.div data-id="box" animate={variant} style={{ width: '1px' }}></motion.div>`;
    const out = setMotionPropScopedValue(NO_HOVER, 'box', 'whileHover', { scale: '1.05' }, { variant: 'v2' });
    expect(out).toContain("whileHover={variant === 'v2' ? { scale: 1.05 } : undefined}");
  });
  it('reset override drops the branch → back to base', () => {
    let out = setMotionPropScopedValue(BASE_HOVER, 'box', 'whileHover',
      { scale: '1.05', rotate: '110' }, { query: '(max-width: 768px)' });
    out = removeMotionPropScopeBranch(out, 'box', 'whileHover', { query: '(max-width: 768px)' });
    expect(out).toContain('whileHover={{ scale: 1.05 }}');  // collapsed to base
    expect(out).not.toContain('__mq0 ?');
  });
  it('reset override on a scoped-only effect removes the prop', () => {
    let out = setMotionPropScopedValue(`<motion.div data-id="box"></motion.div>`, 'box', 'whileHover',
      { scale: '1.05' }, { variant: 'v2' });
    out = removeMotionPropScopeBranch(out, 'box', 'whileHover', { variant: 'v2' });
    expect(out).not.toContain('whileHover');
  });
});

describe('variant gate uses the RIGHT variable (variant vs initialVariant)', () => {
  // A component WITHOUT connections drives its variant via the `initialVariant`
  // prop (`animate={initialVariant}`) — there is NO `variant` variable in scope.
  // Gating a variant hover on `variant` → runtime `variant is not defined`.
  const INITIAL_VARIANT_COMP = `function PoGaDu({ style, initialVariant = 'default' }) {
  return <motion.div data-id="box" variants={v} initial={initialVariant} animate={initialVariant} style={{ width: '1px' }}></motion.div>;
}`;
  it('gates on initialVariant when the component has no `variant` useState', () => {
    const out = setMotionPropScopedValue(INITIAL_VARIANT_COMP, 'box', 'whileHover',
      { scale: '1.05', rotate: '62' }, { variant: 'variant-2' });
    expect(out).toContain("whileHover={initialVariant === 'variant-2' ? { scale: 1.05, rotate: 62 } : undefined}");
    expect(out).not.toContain("variant === 'variant-2'"); // would be `variant is not defined`
  });
  it('editing a base hover on a variant replica keeps the base (responsive)', () => {
    const WITH_BASE = `function PoGaDu({ style, initialVariant = 'default' }) {
  return <motion.div data-id="box" animate={initialVariant} whileHover={{ scale: 1.05 }} style={{ width: '1px' }}></motion.div>;
}`;
    const out = setMotionPropScopedValue(WITH_BASE, 'box', 'whileHover',
      { scale: '1.05', rotate: '62' }, { variant: 'variant-2' });
    expect(out).toContain("whileHover={initialVariant === 'variant-2' ? { scale: 1.05, rotate: 62 } : { scale: 1.05 }}");
  });
});

import { parseJSXToNodes } from '@/code/parsing/parser';
describe('parser — chained responsive hover (one branch per viewport)', () => {
  const CHAINED = `'use client';
function useMediaQuery(q: string){ return false; }
export default function Page() {
  const __mq1 = useMediaQuery('(max-width: 375px)');
  const __mq0 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="root"><motion.div data-id="box"
    whileHover={__mq0 ? { scale: 1.05, rotate: 45 } : __mq1 ? { scale: 1.4 } : { scale: 1.05 }}></motion.div></div>;
}`;
  it('captures EVERY branch in _chain + the final _base', () => {
    const nodes = parseJSXToNodes(CHAINED);
    const box = nodes.get('box');
    const hover = box?.motionProps?.whileHover as any;
    expect(hover).toBeTruthy();
    const chain = JSON.parse(hover._chain);
    expect(chain).toHaveLength(2);
    expect(chain[0].marker).toBe('gate:__mq0');
    expect(chain[0].query).toBe('(max-width: 768px) and (min-width: 376px)'); // resolved from the const
    expect(chain[0].props).toEqual({ scale: '1.05', rotate: '45' });
    expect(chain[1].marker).toBe('gate:__mq1');
    expect(chain[1].query).toBe('(max-width: 375px)');
    expect(chain[1].props).toEqual({ scale: '1.4' });
    expect(JSON.parse(hover._base)).toEqual({ scale: '1.05' });
  });
});

import { updateMotionPropInCode as _umpic2, scopeMotionPropInCode as _smpic2 } from './generator-motion';
describe('useMediaQuery hook — lazy init for mount-time `initial`', () => {
  it('newly injected hook reads matchMedia on first render (not useState(false))', () => {
    let out = _umpic2(BASE, 'box', 'initial', { opacity: '0' });
    out = _smpic2(out, 'box', 'initial', { query: '(max-width: 768px)' });
    expect(out).toContain("useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)");
    expect(out).not.toContain('= useState(false)');
  });
  it('upgrades an existing legacy useState(false) hook in place', () => {
    const LEGACY = `function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {}, [query]);
  return matches;
}
function C() {
  return <motion.div data-id="box" animate={variant}></motion.div>;
}`;
    let out = _umpic2(LEGACY, 'box', 'whileHover', { scale: '1.05' });
    out = _smpic2(out, 'box', 'whileHover', { query: '(max-width: 768px)' });
    expect(out).toContain("useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)");
    expect(out).not.toContain('= useState(false)');
    expect((out.match(/function useMediaQuery/g) || []).length).toBe(1); // not duplicated
  });
});
