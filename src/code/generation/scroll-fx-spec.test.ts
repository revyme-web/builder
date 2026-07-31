import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import { decomposeAllScrollConflicts, composeAllScrollAppearConflicts, updateMotionPropInCode, setMotionPropScopedValue, setLoopInCode, updateScrollDirectionAnimInCode, updateScrollAnimInCode, updateScrollSpeedInCode, removeScrollSpeedScopeBranch, getSpeedResponsive, getScrollFx, setScrollFxInCode, buildScrollFxSpec, clearNodeScrollFx, dormantizeScrollFx, rehydrateScrollFx } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { syncImports, validateGeneratedCode } from '@/code/mutation/mutation-queue';
import { presentOn } from '@/code/animations/presence';
const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default);
const reformat = (c: string) => generate(parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }), { retainLines: false, concise: false }, c).code;
const A = (c: string, fn: (x: string) => string) => composeAllScrollAppearConflicts(fn(decomposeAllScrollConflicts(c)));
const BASE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return (<div data-id="root"><motion.div data-id="frame-x" style={{ position: 'absolute' }}></motion.div></div>);
}`;
function rich() {
  let code = A(BASE, c => updateMotionPropInCode(c, 'frame-x', 'whileHover', { scale: '1.05' }));
  code = A(code, c => updateMotionPropInCode(c, 'frame-x', 'whileTap', { scale: '0.95' }));
  code = A(code, c => updateScrollDirectionAnimInCode(c, { nodeId: 'frame-x', toProps: { opacity: '0' }, direction: 'down', replay: true, transition: { type: 'spring', duration: '0.5' } }));
  code = A(code, c => updateScrollAnimInCode(c, { nodeId: 'frame-x', trigger: 'onScroll', stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '2' } }], transition: { type: 'spring', duration: '0.5' } } as any));
  code = A(code, c => updateScrollSpeedInCode(c, { nodeId: 'frame-x', speed: 110 }));
  return code;
}
describe('spec-driven scroll-fx (robust regenerate)', () => {
  it('regenerate from spec after a REFORMAT is clean (no orphans/dupes), then remove cleanly', () => {
    const code = rich();
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    const spec = getScrollFx(code, 'frame-x');
    expect(Object.keys(spec!).sort()).toEqual(['animation', 'hover', 'speed', 'tap', 'transform']);
    // reformat = what an AST-path mutation (updateStyles) does to the page
    const regen = setScrollFxInCode(reformat(code), 'frame-x', spec);
    expect(parseJSX(regen)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(regen))).toBeNull();
    // drop one effect
    const { transform, ...rest } = spec as any;
    const removed = setScrollFxInCode(regen, 'frame-x', rest);
    expect(validateGeneratedCode(syncImports(removed))).toBeNull();
    // remove ALL
    const cleared = setScrollFxInCode(removed, 'frame-x', null);
    expect(parseJSX(cleared)).not.toBeNull();
    expect(cleared).not.toMatch(/frameX[A-Z]/);
    expect(cleared).not.toMatch(/data-scroll-fx|whileHover|whileInView/);
  });
  it('setScrollFxInCode is compose-idempotent (the mutation path must not double-compose)', () => {
    // updateScrollFx routes through applyMutationCore (NOT the decompose→apply→compose
    // wrapper) precisely because setScrollFxInCode already composes. But even if compose
    // ran twice it must be a no-op — assert that here so the routing stays safe.
    const code = rich();
    const set = setScrollFxInCode(reformat(code), 'frame-x', getScrollFx(code, 'frame-x'));
    const twice = composeAllScrollAppearConflicts(set);
    expect(twice).toBe(set);
    expect(validateGeneratedCode(syncImports(twice))).toBeNull();
  });
  it('RESPONSIVE: a scoped (per-viewport) gesture survives spec regenerate, not flattened to base', () => {
    // base hover scale 1.05 + a 768px-viewport override scale 1.2 (the existing
    // responsive ternary form), then add a loop so a regenerate is triggered.
    let code = updateMotionPropInCode(BASE, 'frame-x', 'whileHover', { scale: '1.05' });
    code = setMotionPropScopedValue(code, 'frame-x', 'whileHover', { scale: '1.2' }, { query: '(max-width: 768px)' } as any);
    code = setLoopInCode(code, 'frame-x', { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity' } });
    // the spec must CAPTURE both the base and the override
    const spec = getScrollFx(code, 'frame-x')!;
    expect(spec.hover!.props).toEqual({ scale: '1.05' });
    expect(spec.hover!.responsive).toEqual([{ scope: { query: '(max-width: 768px)' }, props: { scale: '1.2' } }]);
    // regenerate (what any sibling-effect change does) must KEEP the override ternary
    const regen = setScrollFxInCode(code, 'frame-x', spec);
    expect(regen).toContain('max-width: 768px');
    expect(regen).toMatch(/scale: 1\.2/);    // override branch
    expect(regen).toMatch(/scale: 1\.05/);   // base branch
    expect(validateGeneratedCode(syncImports(regen))).toBeNull();
    // round-trips: reading the regenerated code yields the same responsive spec
    expect(getScrollFx(regen, 'frame-x')!.hover!.responsive).toEqual(spec.hover!.responsive);
  });
  it('RESPONSIVE: a per-viewport Scroll Transform gates the output range + round-trips via the attr', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const code = setScrollFxInCode(BASE, 'frame-x', {
      transform: { trigger: 'onScroll', from: { scale: '0.5' }, to: { scale: '1' },
        responsive: [{ scope: { query: TABLET }, to: { scale: '1.5' } }] },
    });
    expect(parseJSX(code)).not.toBeNull();
    // The output RANGE is gated: tablet [0.5, 1.5], base [0.5, 1].
    expect(code).toMatch(/= useTransform\(\w+, \[0, 1\], \(__mq0 \? \[0\.5, 1\.5\] : \[0\.5, 1\]\)\)/);
    expect(code).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // Authoritative attr persisted → getScrollFx reads the responsive back verbatim.
    expect(code).toContain("data-scroll-fx='");
    const spec = getScrollFx(code, 'frame-x')!;
    expect(spec.transform!.to).toEqual({ scale: '1' });                                   // base intact
    expect(spec.transform!.responsive).toEqual([{ scope: { query: TABLET }, to: { scale: '1.5' } }]);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
  });

  it('PRESENCE: a Scroll Transform ADDED on a replica is scoped to that tile (no scrub off-scope) + only shows there', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // Added on the Tablet tile: present-only there. No `responsive` (no per-tile value
    // override) — just `scope`. Off-scope the range must collapse to a no-scrub identity.
    const code = setScrollFxInCode(BASE, 'frame-x', {
      transform: { trigger: 'onScroll', from: { scale: '0.5' }, to: { scale: '1' }, scope: [{ query: TABLET }] },
    });
    expect(parseJSX(code)).not.toBeNull();
    // On tablet → real scrub [0.5, 1]; off-scope → identity [1, 1] (scale rest = 1) = no scrub.
    expect(code).toMatch(/= useTransform\(\w+, \[0, 1\], \(__mq0 \? \[0\.5, 1\] : \[1, 1\]\)\)/);
    expect(code).toContain("data-scroll-fx='");
    const spec = getScrollFx(code, 'frame-x')!;
    expect((spec.transform as any).scope).toEqual([{ query: TABLET }]);
    // Detection presence: present on the tablet tile, ABSENT on primary/other tiles.
    expect(presentOn({ scope: (spec.transform as any).scope }, { query: TABLET } as any)).toBe(true);
    expect(presentOn({ scope: (spec.transform as any).scope }, null)).toBe(false);
    expect(presentOn({ scope: (spec.transform as any).scope }, { query: '(max-width: 375px)' } as any)).toBe(false);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
  });

  it('DELETE: clearing a node with a RESPONSIVE Direction removes the reset-on-resize useEffect (no dangling setter)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // Per-viewport Direction emits `useEffect(() => { set<Cap>Scrolled(false); }, [__mq0]);`.
    // That effect references ONLY the capitalised setter, so the node-delete cleanup used
    // to leave it dangling → "References undefined identifier: set…Scrolled" at validate.
    const code = setScrollFxInCode(BASE, 'frame-x', {
      animation: { direction: 'down', replay: true, toProps: { opacity: '0' }, transition: { type: 'spring', duration: '0.5' },
        responsive: [{ scope: { query: TABLET }, direction: 'up' }] },
    });
    expect(code).toMatch(/useEffect\(\(\) => \{ setFrameXScrolled\(false\); \}, \[__mq\d+\]\);/);  // the effect exists
    // clearNodeScrollFx is what removeNodeInCode runs before stripping the JSX.
    const cleared = clearNodeScrollFx(code, 'frame-x');
    expect(cleared).not.toMatch(/setFrameXScrolled/);   // setter usage gone
    expect(cleared).not.toMatch(/frameXScrolled/);       // state var gone
    expect(parseJSX(cleared)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(cleared))).toBeNull();
  });

  it('RESPONSIVE: a scoped (tablet-only) hover composes with a scroll-transform on the SAME prop (gated, not fighting)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // base scroll transform driving scale, + a tablet-only hover scale (scoped ternary).
    let code = updateScrollAnimInCode(BASE, { nodeId: 'frame-x', trigger: 'onScroll',
      stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '1' } }] } as any);
    code = setMotionPropScopedValue(code, 'frame-x', 'whileHover', { scale: '1.05' }, { query: TABLET } as any);
    // compose: the gated hover must fold into the scroll scale motion value, NOT stay a
    // declarative whileHover (which would fight the style scale MV → the jump/ugly bug).
    const composed = composeAllScrollAppearConflicts(code);
    expect(parseJSX(composed)).not.toBeNull();
    expect(composed).not.toMatch(/whileHover=/);                                   // folded, not declarative
    expect(composed).toMatch(/onHoverStart=\{\(\) => \{ animate\([^,]+, \(__mq\d+ \? 1\.05 : 1\)/);  // gated target, rest=1
    expect(composed).toMatch(/onHoverEnd=\{\(\) => \{ animate\([^,]+, 1,/);         // returns to rest
    expect(composed).toMatch(/useTransform\(\[[^\]]+\], \(\[s, h\]\) => s \* h\)/);  // multiply-folded into scale
    expect(validateGeneratedCode(syncImports(composed))).toBeNull();
  });

  it('RESPONSIVE: a scoped gesture survives decompose→recompose (the add-Appear-after corruption)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    let code = updateScrollAnimInCode(BASE, { nodeId: 'frame-x', trigger: 'onScroll',
      stops: [{ progress: 0, props: { scale: '0.5' } }, { progress: 1, props: { scale: '1' } }] } as any);
    code = setMotionPropScopedValue(code, 'frame-x', 'whileHover', { scale: '1.05' }, { query: TABLET } as any);
    const composed = composeAllScrollAppearConflicts(code);
    // Decompose (what a scroll-affecting mutation like add-Appear triggers) must NOT
    // corrupt the tag — it must restore the GATED whileHover, not a quoted string.
    const decomposed = decomposeAllScrollConflicts(composed);
    expect(parseJSX(decomposed)).not.toBeNull();
    expect(decomposed).not.toMatch(/motion\.div__mq|'''/);                      // no corruption
    expect(decomposed).toMatch(/whileHover=\{__mq\d+ \? \{ scale: 1\.05 \} : undefined\}/);  // gated form restored
    // and it re-composes cleanly (idempotent round-trip)
    const recomposed = composeAllScrollAppearConflicts(decomposed);
    expect(parseJSX(recomposed)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(recomposed))).toBeNull();
  });

  it('RESPONSIVE: a loop scoped to a viewport gates the keyframe target (no loop off-scope) + round-trips', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const code = setScrollFxInCode(BASE, 'frame-x', {
      loop: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' }, scope: [{ query: TABLET }] },
    });
    expect(parseJSX(code)).not.toBeNull();
    // PRESENCE-gated: off-scope settle to rest ONCE (no repeat) so it stops; the repeating
    // loop runs only in-scope (raw target), and the gate is in the effect deps.
    expect(code).toMatch(/if \(!\(__mq\d+\)\) \{ const _s = animate\([^,]+, 0, \{ duration: 0\.3 \}\)/);
    expect(code).toMatch(/animate\([^,]+, 360, \{[^}]*repeat: Infinity/);
    expect(code).toMatch(/\}, \[[^\]]*__mq\d+[^\]]*\]\)/);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    expect((getScrollFx(code, 'frame-x')!.loop as any).scope).toEqual([{ query: TABLET }]);
  });

  it('RESPONSIVE: a scoped loop KEEPS its scope through decompose→recompose (add-Speed-after bug)', () => {
    const MOBILE = '(max-width: 375px)';
    // a mobile-only loop, composed (data-scroll-fx attr carries loop.scope).
    const code = setScrollFxInCode(BASE, 'frame-x', {
      loop: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' }, scope: [{ query: MOBILE }] },
    });
    expect((getScrollFx(code, 'frame-x')!.loop as any).scope).toEqual([{ query: MOBILE }]);
    // adding another scroll effect triggers decompose→recompose — the loop must NOT become
    // a base (every-viewport) loop.
    const after = composeAllScrollAppearConflicts(decomposeAllScrollConflicts(code));
    expect(parseJSX(after)).not.toBeNull();
    expect((getScrollFx(after, 'frame-x')!.loop as any).scope).toEqual([{ query: MOBILE }]);
    expect(after).toMatch(/if \(!\(__mq\d+\)\)/);              // still presence-gated
    expect(validateGeneratedCode(syncImports(after))).toBeNull();
  });

  it('non-responsive loop is unchanged — bare keyframe, no gate (zero regression)', () => {
    const code = setScrollFxInCode(BASE, 'frame-x', { loop: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity' } } });
    expect(code).toMatch(/animate\([^,]+, 360,/);
    expect(code).not.toMatch(/__mq/);
  });

  it('RESPONSIVE: a per-viewport transform survives a CROSS-effect edit (parser reads the gated range)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const code = setScrollFxInCode(BASE, 'frame-x', {
      transform: { trigger: 'onScroll', from: { scale: '0.5' }, to: { scale: '1' },
        responsive: [{ scope: { query: TABLET }, to: { scale: '1.5' } }] },
    });
    // Re-parsing the gated code (what the wrapper does when another effect is added) must
    // recover transform.responsive — not drop the transform or its override.
    const reparsed = buildScrollFxSpec(code, 'frame-x');
    expect(reparsed.transform).toBeTruthy();
    expect(reparsed.transform!.to).toEqual({ scale: '1' });                       // base
    expect((reparsed.transform as any).responsive).toEqual([{ scope: { query: TABLET }, from: { scale: '0.5' }, to: { scale: '1.5' } }]);
  });

  it('RESPONSIVE: a scoped Direction (On-Scroll) animation gates the ternary + round-trips', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const code = setScrollFxInCode(BASE, 'frame-x', {
      animation: { direction: 'down', replay: true, toProps: { opacity: '0' }, transition: { type: 'spring', duration: '0.5' }, scope: [{ query: TABLET }] },
    });
    expect(parseJSX(code)).not.toBeNull();
    // Only animates when scrolled AND in-scope → off-scope stays at rest (no animation).
    expect(code).toMatch(/animate=\{\(frameXScrolled && \(__mq\d+\)\) \?/);
    expect(code).toMatch(/const __mq\d+ = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    expect((getScrollFx(code, 'frame-x')!.animation as any).scope).toEqual([{ query: TABLET }]);
  });

  it('RESPONSIVE: per-viewport Direction (Tablet up, Desktop down) — branched handler + round-trip', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const code = setScrollFxInCode(BASE, 'frame-x', {
      animation: { direction: 'down', replay: true, toProps: { opacity: '0' }, transition: { type: 'spring', duration: '0.5' },
        responsive: [{ scope: { query: TABLET }, direction: 'up' }] },
    });
    expect(parseJSX(code)).not.toBeNull();
    // Branched handler: Tablet (gate) scrolls UP to trigger; base scrolls DOWN.
    expect(code).toMatch(/if \(__mq\d+\) \{ if \(y < prev\) setFrameXScrolled\(true\);/);   // tablet = up
    expect(code).toMatch(/if \(y > prev\) setFrameXScrolled\(true\);/);                      // base = down
    // resets to rest when the breakpoint flips (handler only fires on scroll) so it adapts
    // on resize like the loop — not stuck in the previous viewport's direction.
    expect(code).toMatch(/useEffect\(\(\) => \{ setFrameXScrolled\(false\); \}, \[__mq\d+\]\)/);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    // round-trips via the authoritative attr.
    const spec = getScrollFx(code, 'frame-x')!;
    expect((spec.animation as any).responsive).toEqual([{ scope: { query: TABLET }, direction: 'up' }]);
  });

  it('non-responsive Scroll Transform is unchanged — bare range, no gate, no attr (zero regression)', () => {
    const code = setScrollFxInCode(BASE, 'frame-x', { transform: { trigger: 'onScroll', from: { scale: '0.5' }, to: { scale: '1' } } });
    expect(code).toMatch(/= useTransform\(\w+, \[0, 1\], \[0\.5, 1\]\)/);
    expect(code).not.toMatch(/useMediaQuery/);
    expect(code).not.toContain('data-scroll-fx');
  });

  it('RESPONSIVE: a scoped-ONLY (base-less) appear From state round-trips', () => {
    // appear with NO base initial, only a 600px override (scoped-only → undefined tail)
    let code = setMotionPropScopedValue(BASE, 'frame-x', 'initial', { opacity: '0', y: '40' }, { query: '(max-width: 600px)' } as any);
    code = updateMotionPropInCode(code, 'frame-x', 'whileInView', { opacity: '1', y: '0' });
    code = updateMotionPropInCode(code, 'frame-x', 'viewport', { once: 'true' });
    const spec = getScrollFx(code, 'frame-x')!;
    expect(spec.appear!.responsive).toEqual([{ scope: { query: '(max-width: 600px)' }, props: { opacity: '0', y: '40' } }]);
    const regen = setScrollFxInCode(reformat(code), 'frame-x', spec);
    expect(regen).toContain('max-width: 600px');
    expect(regen).toMatch(/initial=\{__mq\d+ \? \{[^}]*\} : undefined\}/);   // scoped-only tail stays undefined
    expect(regen).toMatch(/whileInView=\{\{ opacity: 1, y: 0 \}\}/);          // resting covers the override's keys
    expect(validateGeneratedCode(syncImports(regen))).toBeNull();
  });
  it('RESPONSIVE Scroll Speed: scoped edit → gated ternary, regen preserves, reset-override drops branch', () => {
    const Q = '(max-width: 768px)';
    // base speed 110, then a scoped edit on a 768 viewport → 80
    let code = updateScrollSpeedInCode(BASE, { nodeId: 'frame-x', speed: 110 });
    code = updateScrollSpeedInCode(code, { nodeId: 'frame-x', speed: 80, scope: { query: Q } });
    expect(code).toMatch(/v \* \(1 - \(__mq\d+ \? 80 : 110\) \/ 100\)/);   // gated ternary, base kept
    expect(code).toContain(`useMediaQuery('${Q}')`);
    // capture: base + override
    expect(getSpeedResponsive(code, 'frame-x')).toEqual({ base: 110, responsive: [{ scope: { query: Q }, speed: 80 }] });
    // spec round-trips it
    const spec = getScrollFx(code, 'frame-x')!;
    expect(spec.speed).toBe(110);
    expect(spec.speedResponsive).toEqual([{ scope: { query: Q }, speed: 80 }]);
    // regenerate (sibling change / reformat) keeps the override
    const regen = setScrollFxInCode(reformat(code), 'frame-x', spec);
    expect(regen).toMatch(/\(__mq\d+ \? 80 : 110\)/);
    expect(validateGeneratedCode(syncImports(regen))).toBeNull();
    // reset override → back to base-only
    const reset = removeScrollSpeedScopeBranch(regen, 'frame-x', { query: Q });
    expect(reset).toMatch(/v \* \(1 - 110 \/ 100\)/);
    expect(reset).not.toMatch(/__mq\d+ \? 80/);
    expect(validateGeneratedCode(syncImports(reset))).toBeNull();
  });
  it('regenerating an already-DUPLICATED (corrupted) node heals it', () => {
    const code = rich();
    const spec = getScrollFx(code, 'frame-x');
    // simulate corruption: reformat twice + a stray duplicate decl injected
    let corrupt = reformat(reformat(code));
    corrupt = corrupt.replace('export default function Page() {', 'export default function Page() {\n  const frameXStray = useMotionValue(0);');
    const healed = setScrollFxInCode(corrupt, 'frame-x', spec);
    expect(validateGeneratedCode(syncImports(healed))).toBeNull();
  });

  // Dragging a NORMAL scroll-fx node out of a viewport to the canvas would leave its hooks
  // (useScroll/useTransform/useMotionValue/useEffect) behind in the page body while the moved
  // JSX still binds `scale: frameXScaleTapC` / `ref={frameXRef}` / handlers → "undefined identifier".
  it('DORMANTIZE strips the page-level hooks + bindings but KEEPS the data-scroll-fx spec', () => {
    const live = reformat(rich());
    expect(live).toMatch(/useTransform\(/);
    const dormant = dormantizeScrollFx(live, 'frame-x');
    expect(parseJSX(dormant)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(dormant))).toBeNull();   // no undefined identifier
    expect(dormant).not.toMatch(/frameX[A-Z]\w*/);                    // every <cn>… hook/binding gone
    expect(dormant).not.toMatch(/useTransform\(|useMotionValue\(|onHoverStart=/);
    expect(dormant).toMatch(/data-scroll-fx=/);                      // spec PRESERVED
    expect(getScrollFx(dormant, 'frame-x')!.speed).toBe(110);        // round-trippable
  });

  it('REHYDRATE regenerates the hooks + bindings from the preserved spec', () => {
    const dormant = dormantizeScrollFx(reformat(rich()), 'frame-x');
    const back = rehydrateScrollFx(dormant, 'frame-x');
    expect(parseJSX(back)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(back))).toBeNull();
    expect(back).toMatch(/useTransform\(/);                          // hooks back
    expect(getScrollFx(back, 'frame-x')!.hover!.props).toMatchObject({ scale: '1.05' });
  });

  it('PRESENCE: an Appear hidden on a VARIANT replica gates initial to false there, keeps the base, and round-trips', () => {
    // Component-shaped code: the variant gate must resolve `initialVariant` (no useState).
    const COMP = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
function MoMoFe({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (<LayoutGroup><motion.div data-id="frame-a" style={{ position: 'absolute', width: '524px', ...style }}>
    <motion.div data-id="frame-b" style={{ position: 'absolute', width: '204px' }}></motion.div>
  </motion.div></LayoutGroup>);
}
export default withResponsiveProps(MoMoFe);`;
    let code = updateMotionPropInCode(COMP, 'frame-b', 'initial', { opacity: '0', y: '30' });
    code = updateMotionPropInCode(code, 'frame-b', 'whileInView', { opacity: '1', y: '0' });
    code = updateMotionPropInCode(code, 'frame-b', 'viewport', { once: 'true' });

    // X on the variant-1 replica → hide there only (the live-find repro).
    const spec = getScrollFx(code, 'frame-b')!;
    expect(spec.appear).toBeTruthy();
    const hidden = { ...spec, appear: { ...spec.appear!, hiddenOn: [{ variant: 'variant-1' }] } };
    const out = setScrollFxInCode(code, 'frame-b', hidden as any);

    // base initial survives; the replica branch collapses it to `false` (skip enter)
    expect(out).toMatch(/initial=\{initialVariant === 'variant-1' \? false : \{[^}]*opacity: 0/);
    expect(out).toMatch(/whileInView=/);
    expect(validateGeneratedCode(syncImports(out))).toBeNull();

    // round-trip: the spec (attr-persisted) still knows the hidden tile
    const back = getScrollFx(out, 'frame-b')!;
    expect(back.appear!.hiddenOn).toEqual([{ variant: 'variant-1' }]);
    expect(back.appear!.initial).toMatchObject({ opacity: '0', y: '30' });

    // un-hide (remove the last hidden tile) → clean base form again
    const restored = setScrollFxInCode(out, 'frame-b', { ...back, appear: { ...back.appear!, hiddenOn: [] } } as any);
    expect(restored).not.toMatch(/\? false :/);
    expect(getScrollFx(restored, 'frame-b')!.appear!.initial).toMatchObject({ opacity: '0' });
  });

  it('PRESENCE: a hover hidden on a viewport replica gates whileHover to undefined there', () => {
    const code = updateMotionPropInCode(BASE, 'frame-x', 'whileHover', { scale: '1.05' });
    const spec = getScrollFx(code, 'frame-x')!;
    const hidden = { ...spec, hover: { ...spec.hover!, hiddenOn: [{ query: '(max-width: 768px)' }] } };
    const out = setScrollFxInCode(code, 'frame-x', hidden as any);
    expect(out).toMatch(/whileHover=\{__mq\d+ \? undefined : \{ scale: 1.05 \}\}/);
    expect(validateGeneratedCode(syncImports(out))).toBeNull();
    const back = getScrollFx(out, 'frame-x')!;
    expect(back.hover!.hiddenOn).toEqual([{ query: '(max-width: 768px)' }]);
    expect(back.hover!.props).toMatchObject({ scale: '1.05' });
  });
});
