import { describe, it, expect } from 'vitest';
import { setInstanceFxInCode, getInstanceFx, setTransformValueScoped, resolveTransformValue, resetTransformScope, hasTransformScope, resolveFxValue, setFxValueScoped, resetFxValueScope, hasFxValueScope, resolveSpeedValue, setSpeedScoped, hasSpeedScope, instanceFxNeedsRef, instanceFxPresentOn, instanceFxIsOverride, addInstanceFxScope, hideInstanceFxOn, resetInstanceFxScope, dormantizeInstanceFx, rehydrateInstanceFx, stripDeadFxStyleRefs, type InstanceFxSpec } from './instance-fx-gen';
import { moveNodeInCode } from './generator-crud';
import { dormantizeScrollVariant, rehydrateScrollVariant, getScrollVariant } from './scroll-variant-gen';
import { setScrollVariantInCode } from './scroll-variant-gen';
import type { SerScope } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import { clearNodeScrollFx } from './generator-motion';
import { syncImports, validateGeneratedCode } from '@/code/mutation/mutation-queue';

const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default);
const reformat = (c: string) => generate(parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }), { retainLines: false, concise: false }, c).code;

const PAGE = `'use client';
import React, { useState, useRef, useEffect } from 'react';
import { useMotionValue, useTransform, animate, hover, press } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;

describe('instance-fx codegen', () => {
  it('hover: motion value + motion hover() on the shared ref, bound to style', () => {
    const out = setInstanceFxInCode(PAGE, 'card', { hover: { to: { scale: 1.05 } } });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardRef = useRef\(null\)/);
    expect(out).toMatch(/const cardFxHovScale = useMotionValue\(1\)/);
    expect(out).toMatch(/return hover\(el, \(\) => \{/);
    expect(out).toMatch(/animate\(cardFxHovScale, 1\.05/);
    expect(out).toMatch(/<Card[^>]*ref=\{cardRef\}/);
    expect(out).toMatch(/style=\{\{ scale: cardFxHovScale/);
    expect(out).toMatch(/data-instance-fx=/);
  });

  it('appear: starts at FROM, animates to base on mount', () => {
    const out = setInstanceFxInCode(PAGE, 'card', { appear: { from: { opacity: 0, scale: 0.8 } } });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardFxAppOpacity = useMotionValue\(0\)/);
    expect(out).toMatch(/const cardFxAppScale = useMotionValue\(0\.8\)/);
    expect(out).toMatch(/animate\(cardFxAppOpacity, 1/);
    expect(out).toMatch(/animate\(cardFxAppScale, 1/);
    // no ref needed for appear-only
    expect(out).not.toMatch(/cardRef/);
  });

  it('appear: a CUSTOM transition from the spec replaces the default spring (Transition panel)', () => {
    const out = setInstanceFxInCode(PAGE, 'card', {
      appear: { from: { opacity: 0 }, transition: { type: 'tween', duration: 1.2, ease: 'easeOut', delay: 0.3 } },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/animate\(cardFxAppOpacity, 1, \{ type: 'tween', duration: 1\.2, ease: 'easeOut', delay: 0\.3 \}\)/);
    expect(out).not.toMatch(/stiffness: 300/);
  });

  it('compose: hover + tap + appear all on scale → one useTransform (multiply)', () => {
    const out = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.1 } }, tap: { to: { scale: 0.95 } }, appear: { from: { scale: 0.8 } },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardFxCScale = useTransform\(\[[^\]]*cardFxHovScale[^\]]*cardFxTapScale[^\]]*cardFxAppScale[^\]]*\], \(vals\) => vals\.reduce\(\(a, v\) => a \* v, 1\)\)/);
    expect(out).toMatch(/style=\{\{ scale: cardFxCScale/);
    expect(out).toMatch(/return press\(el/); // tap uses press()
  });

  it('loop: repeating keyframes via animate(), stopped on cleanup', () => {
    const out = setInstanceFxInCode(PAGE, 'card', { loop: { keyframes: { rotate: [0, 360] } } });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardFxLoopRotate = useMotionValue\(0\)/);
    expect(out).toMatch(/const c0 = animate\(cardFxLoopRotate, \[0, 360\], \{ type: 'tween'.*repeat: Infinity/);
    expect(out).toMatch(/return \(\) => \{ c0\.stop\(\); \}/);
    expect(out).toMatch(/style=\{\{ rotate: cardFxLoopRotate/);
  });

  it('transform with NO responsive → bare range (zero regression for non-responsive)', () => {
    const out = setInstanceFxInCode(PAGE, 'card', {
      transform: { from: { scale: 0.5 }, to: { scale: 1 }, trigger: 'onScroll' },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardFxTfScale = useTransform\(cardFxTfP, \[0, 1\], \[0\.5, 1\]\)/);
    expect(out).not.toMatch(/useMediaQuery/);          // no gate when not responsive
  });

  it('transform per-viewport: a Tablet override on scale.to gates the range, base preserved (the TiFiPa repro)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setInstanceFxInCode(PAGE, 'card', {
      transform: {
        from: { scale: 0.5 }, to: { scale: 1 }, trigger: 'onScroll',
        responsive: [{ scope: { query: TABLET }, to: { scale: 1.5 } }],
      },
    });
    expect(parseJSX(out)).not.toBeNull();
    // SSR-safe gate hook + a const for the tablet band.
    expect(out).toMatch(/function useMediaQuery\(/);
    expect(out).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // The `to` endpoint is gated; the `from` endpoint (no override) stays bare.
    expect(out).toMatch(/useTransform\(cardFxTfP, \[0, 1\], \[0\.5, \(__mq0 \? 1\.5 : 1\)\]\)/);
    // Spec round-trips through the data-instance-fx attr (no parser needed).
    const back = getInstanceFx(out, 'card');
    expect(back?.transform?.to?.scale).toBe(1);                 // desktop base intact
    expect(back?.transform?.responsive?.[0]?.to?.scale).toBe(1.5);
    expect((back?.transform?.responsive?.[0]?.scope as any)?.query).toBe(TABLET);
  });

  it('hover per-viewport: a Tablet override on scale gates the ENTER target, base preserved (the reported bug)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.05 }, responsive: [{ scope: { query: TABLET }, to: { scale: 1.5 } }] },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // The hover enter target is per-tile; the revert target (rest) stays bare 1.
    expect(out).toMatch(/animate\(cardFxHovScale, \(__mq0 \? 1\.5 : 1\.05\),/);
    // The value gate is listed in the effect deps so it re-attaches on resize.
    expect(out).toMatch(/\}, \[__mq0\]\);/);
    const back = getInstanceFx(out, 'card');
    expect(back?.hover?.to?.scale).toBe(1.05);                          // desktop base intact
    expect(back?.hover?.responsive?.[0]?.to?.scale).toBe(1.5);          // tablet override
  });

  it('hover OVERRIDE-ONLY prop: a Tablet-only rotate emits a gated motion value (the reported bug)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // Base hover is scale only; Tablet adds rotate 70 (a prop absent from the base `to`).
    const out = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.05 }, responsive: [{ scope: { query: TABLET }, to: { scale: 1.05, rotate: 70 } }] },
    });
    expect(parseJSX(out)).not.toBeNull();
    // rotate MUST get its own motion value (was dropped → "stays as desktop"), gated to
    // its neutral 0 off Tablet.
    expect(out).toMatch(/const cardFxHovRotate = useMotionValue\(0\)/);
    expect(out).toMatch(/animate\(cardFxHovRotate, \(__mq0 \? 70 : 0\),/);
    // scale is equal base/override → stays bare (no redundant gate).
    expect(out).toMatch(/animate\(cardFxHovScale, 1\.05,/);
    expect(out).not.toMatch(/\? 1\.05 : 1\.05/);
    // rotate binds to the instance style via the compose/single path.
    expect(out).toMatch(/rotate:/);
  });

  it('REFORMAT-proof delete: strips the multi-line useScroll destructure (no dangling ref)', () => {
    // A Scroll Transform creates `const cardFxRef = useRef(null)` + `const { scrollYProgress:
    // cardFxTfP } = useScroll({ target: cardFxRef, … })`. After a babel reflow that destructure
    // is multi-line; deleting the node (clearNodeScrollFx) used to leave it dangling on the
    // swept ref → "References undefined identifier: cardFxRef". Strip must drop the multi-line form.
    const gen = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.05 } },
      transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 }, trigger: 'onScroll' },
    });
    const reflowed = reformat(gen);
    expect(reflowed).toMatch(/scrollYProgress:\s*cardFxTfP/);   // multi-line destructure present
    // The delete path runs clearNodeScrollFx before stripping the JSX.
    const cleared = clearNodeScrollFx(reflowed, 'card');
    expect(cleared).not.toMatch(/cardFxTfP/);                   // destructure gone (not dangling)
    expect(cleared).not.toMatch(/cardFx/);                      // all instance-fx vars gone
    expect(parseJSX(cleared)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(cleared))).toBeNull();   // no undefined ref
  });

  it('non-responsive hover → bare target (zero regression)', () => {
    const out = setInstanceFxInCode(PAGE, 'card', { hover: { to: { scale: 1.05 } } });
    expect(out).toMatch(/animate\(cardFxHovScale, 1\.05,/);             // no gate
    expect(out).not.toMatch(/__mq\d+ \? 1\.05/);
  });

  it('speed per-viewport: a Tablet override gates the parallax factor, base preserved', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setInstanceFxInCode(PAGE, 'card', {
      speed: 110, speedResponsive: [{ scope: { query: TABLET }, speed: 60 }],
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/v \* \(1 - \(__mq0 \? 60 : 110\) \/ 100\)/);
    const back = getInstanceFx(out, 'card');
    expect(back?.speed).toBe(110);
    expect(back?.speedResponsive?.[0]?.speed).toBe(60);
  });

  it('prunes base-equal override keys → only the genuinely-different prop is gated', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // The popup writes the WHOLE `to` map; here only `rotate` actually differs.
    const out = setInstanceFxInCode(PAGE, 'card', {
      transform: {
        from: { opacity: 0.5, scale: 0.5, rotate: 0 }, to: { opacity: 1, scale: 1, rotate: 0 }, trigger: 'onScroll',
        responsive: [{ scope: { query: TABLET }, to: { opacity: 1, scale: 1, rotate: 82 } }],
      },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).not.toMatch(/\? 1 : 1/);                                 // no redundant gate
    expect(out).toMatch(/cardFxTfOpacity = useTransform\(cardFxTfP, \[0, 1\], \[0\.5, 1\]\)/);  // bare
    expect(out).toMatch(/cardFxTfRotate = useTransform\(cardFxTfP, \[0, 1\], \[0, \(__mq0 \? 82 : 0\)\]\)/);  // gated
  });
});

describe('instance-fx transform scope helpers (pure spec)', () => {
  const TABLET: SerScope = { query: '(max-width: 768px) and (min-width: 376px)' };
  const MOBILE: SerScope = { query: '(max-width: 375px)' };
  const base: InstanceFxSpec = { transform: { from: { scale: 0.5 }, to: { scale: 1 }, trigger: 'onScroll' } };

  it('scope=null edits the base, leaving overrides untouched', () => {
    const withOv = setTransformValueScoped(base, 'to', { scale: 1.5 }, TABLET);
    const out = setTransformValueScoped(withOv, 'to', { scale: 2 }, null);
    expect(out.transform!.to.scale).toBe(2);                       // base changed
    expect(out.transform!.responsive![0].to!.scale).toBe(1.5);     // tablet intact
  });

  it('upserts per-scope (one entry per viewport), keeping siblings', () => {
    let out = setTransformValueScoped(base, 'to', { scale: 1.5 }, TABLET);
    out = setTransformValueScoped(out, 'to', { scale: 0.8 }, MOBILE);
    out = setTransformValueScoped(out, 'to', { scale: 1.6 }, TABLET);   // update tablet
    expect(out.transform!.responsive).toHaveLength(2);
    expect(out.transform!.responsive!.find(r => 'query' in r.scope && r.scope.query === TABLET.query)!.to!.scale).toBe(1.6);
    expect(out.transform!.responsive!.find(r => 'query' in r.scope && r.scope.query === MOBILE.query)!.to!.scale).toBe(0.8);
  });

  it('resolveTransformValue overlays the matching override on the base', () => {
    const out = setTransformValueScoped(base, 'to', { scale: 1.5 }, TABLET);
    expect(resolveTransformValue(out.transform!, 'to', null)).toEqual({ scale: 1 });        // desktop
    expect(resolveTransformValue(out.transform!, 'to', TABLET)).toEqual({ scale: 1.5 });    // tablet
    expect(resolveTransformValue(out.transform!, 'to', MOBILE)).toEqual({ scale: 1 });      // falls back to base
  });

  it('gesture value helpers (hover/tap): scope=null edits base, replica upserts, reset drops, has tracks', () => {
    const h0: InstanceFxSpec = { hover: { to: { scale: 1.05 } } };
    const h1 = setFxValueScoped(h0, 'hover', { scale: 1.5 }, TABLET);   // tablet override
    expect(h1.hover!.to.scale).toBe(1.05);                              // base intact
    expect(h1.hover!.responsive![0].to!.scale).toBe(1.5);
    expect(resolveFxValue(h1, 'hover', null)).toEqual({ scale: 1.05 }); // desktop = base
    expect(resolveFxValue(h1, 'hover', TABLET)).toEqual({ scale: 1.5 });// tablet = override
    expect(resolveFxValue(h1, 'hover', MOBILE)).toEqual({ scale: 1.05 });// unlisted = base
    expect(hasFxValueScope(h1, 'hover', TABLET)).toBe(true);
    expect(hasFxValueScope(h1, 'hover', MOBILE)).toBe(false);
    const h2 = setFxValueScoped(h1, 'hover', { scale: 2 }, null);       // edit base, keep override
    expect(h2.hover!.to.scale).toBe(2);
    expect(h2.hover!.responsive![0].to!.scale).toBe(1.5);
    const h3 = resetFxValueScope(h2, 'hover', TABLET);                  // drop tablet
    expect(h3.hover!.responsive).toBeUndefined();
    expect(h3.hover!.to.scale).toBe(2);
  });

  it('speed value helpers: scope=null edits base, replica upserts, reset drops, has tracks', () => {
    const s0: InstanceFxSpec = { speed: 110 };
    const s1 = setSpeedScoped(s0, 60, TABLET);
    expect(s1.speed).toBe(110);
    expect(s1.speedResponsive![0].speed).toBe(60);
    expect(resolveSpeedValue(s1, null)).toBe(110);
    expect(resolveSpeedValue(s1, TABLET)).toBe(60);
    expect(resolveSpeedValue(s1, MOBILE)).toBe(110);
    expect(hasSpeedScope(s1, TABLET)).toBe(true);
  });

  it('instanceFx presence helpers: add/hide/reset per replica (the reference 3-state)', () => {
    const TABLET: any = { query: '(max-width: 768px) and (min-width: 376px)' };
    const MOBILE: any = { query: '(max-width: 375px)' };
    const base: InstanceFxSpec = { hover: { to: { scale: 1.05 } } };

    // add on a replica → scoped-only (absent on primary).
    const added = addInstanceFxScope(base, 'hover', TABLET);
    expect(instanceFxPresentOn(added, 'hover', null)).toBe(false);   // not on Desktop
    expect(instanceFxPresentOn(added, 'hover', TABLET)).toBe(true);
    expect(instanceFxIsOverride(added, 'hover', TABLET)).toBe(true);
    // THEN add on the PRIMARY: clears the present-only scope → present EVERYWHERE (the
    // "add on tablet, then on desktop" sequence that used to no-op). The replica keeps any
    // value-override; here there's none, so no blue flag.
    const alsoPrimary = addInstanceFxScope(added, 'hover', null);
    expect(instanceFxPresentOn(alsoPrimary, 'hover', null)).toBe(true);    // now on Desktop
    expect(instanceFxPresentOn(alsoPrimary, 'hover', TABLET)).toBe(true);  // still on Tablet
    expect(instanceFxIsOverride(alsoPrimary, 'hover', TABLET)).toBe(false);// base everywhere → no override
    // add on Desktop → base (runs everywhere, no presence entry).
    expect(addInstanceFxScope(base, 'hover', null).presence).toBeUndefined();
    expect(instanceFxPresentOn(base, 'hover', null)).toBe(true);
    expect(instanceFxPresentOn(base, 'hover', TABLET)).toBe(true);

    // delete on a replica: base effect → hidden there; scoped-only's last tile → effect removed.
    const hidden = hideInstanceFxOn(base, 'hover', TABLET);
    expect(instanceFxPresentOn(hidden, 'hover', TABLET)).toBe(false);
    expect(instanceFxPresentOn(hidden, 'hover', null)).toBe(true);   // stays on Desktop
    expect(hideInstanceFxOn(added, 'hover', TABLET).hover).toBeUndefined();  // last scope → removed

    // reset on a replica: hidden → back to base; scoped-only → removed.
    expect(resetInstanceFxScope(hidden, 'hover', TABLET)).toEqual(base);
    expect(resetInstanceFxScope(added, 'hover', TABLET).hover).toBeUndefined();
  });

  it('instanceFxNeedsRef: a non-section Scroll Transform needs the forwarded ref (the crash)', () => {
    // The repro: a Scroll Transform on an instance attaches useScroll({ target: ref }),
    // so the component MUST forward the ref or motion throws "Target ref … not hydrated".
    expect(instanceFxNeedsRef({ transform: { from: {}, to: {}, trigger: 'onScroll' } })).toBe(true);
    expect(instanceFxNeedsRef({ transform: { from: {}, to: {}, trigger: 'layerInView' } })).toBe(true);
    // sectionInView targets a page anchor (not the instance) → no instance ref needed.
    expect(instanceFxNeedsRef({ transform: { from: {}, to: {}, trigger: 'sectionInView', sectionId: 'x' } })).toBe(false);
    expect(instanceFxNeedsRef({ hover: { to: { scale: 1.1 } } })).toBe(true);
    expect(instanceFxNeedsRef({ appear: { from: { opacity: 0 }, trigger: 'layerInView' } })).toBe(true);
    expect(instanceFxNeedsRef({ appear: { from: { opacity: 0 }, trigger: 'onAppear' } })).toBe(false);
    expect(instanceFxNeedsRef({ speed: 120 })).toBe(false);
    expect(instanceFxNeedsRef(null)).toBe(false);
  });

  it('PRESENCE: hover scoped to Tablet gates the enter target to neutral off-scope (the repro)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.05 } },
      presence: { hover: { scope: [{ query: TABLET }] } },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // enter animates to 1.05 only on Tablet, to 1 (neutral = no hover) elsewhere.
    expect(out).toMatch(/animate\(cardFxHovScale, \(__mq0 \? 1\.05 : 1\),/);
    // leave always returns to neutral.
    expect(out).toMatch(/animate\(cardFxHovScale, 1,/);
    // REACTIVITY: the effect must depend on the gate, or the [] capture freezes the
    // tablet-only target and it keeps firing on desktop after a resize.
    expect(out).toMatch(/\}, \[__mq0\]\);/);
  });

  it('non-presence hover keeps an empty dep array (zero regression)', () => {
    const out = setInstanceFxInCode(PAGE, 'card', { hover: { to: { scale: 1.05 } } });
    expect(out).toMatch(/animate\(cardFxHovScale, 1\.05,/);   // bare target, no gate
    expect(out).toMatch(/\}, \[\]\);/);
  });

  it('PRESENCE: speed hidden on Tablet → 100 (no parallax) there, real elsewhere', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setInstanceFxInCode(PAGE, 'card', {
      speed: 120,
      presence: { speed: { hiddenOn: [{ query: TABLET }] } },
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/v \* \(1 - \(__mq0 \? 100 : 120\) \/ 100\)/);
  });

  it('reset drops the scope override; hasTransformScope tracks it', () => {
    const out = setTransformValueScoped(base, 'to', { scale: 1.5 }, TABLET);
    expect(hasTransformScope(out, TABLET)).toBe(true);
    expect(hasTransformScope(out, null)).toBe(false);
    const reset = resetTransformScope(out, TABLET);
    expect(hasTransformScope(reset, TABLET)).toBe(false);
    expect(reset.transform!.responsive).toBeUndefined();
  });

  it('folds an EXTERNAL scroll y/scale binding into the composition', () => {
    const withScroll = `'use client';
import React from 'react';
import { useScroll, useTransform } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  const { scrollY: cardSpeedScroll } = useScroll();
  const cardSpeedScale = useTransform(cardSpeedScroll, (v) => 1 + v / 1000);
  return (<div data-id="root"><Card data-id="card" style={{ scale: cardSpeedScale, position: 'absolute' }} /></div>);
}`;
    const out = setInstanceFxInCode(withScroll, 'card', { hover: { to: { scale: 1.05 } } });
    expect(parseJSX(out)).not.toBeNull();
    // scroll scale + hover scale compose into ONE value
    expect(out).toMatch(/useTransform\(\[cardSpeedScale, cardFxHovScale\]/);
    expect(out).toMatch(/style=\{\{ scale: cardFxCScale/);
  });

  it('round-trips: set then remove leaves no dangling Fx code', () => {
    const set = setInstanceFxInCode(PAGE, 'card', { hover: { to: { scale: 1.05 } }, appear: { from: { opacity: 0 } } });
    expect(getInstanceFx(set, 'card')).toMatchObject({ hover: { to: { scale: 1.05 } } });
    const cleared = setInstanceFxInCode(set, 'card', null);
    expect(parseJSX(cleared)).not.toBeNull();
    expect(cleared).not.toMatch(/Fx/);                 // no effect vars
    expect(cleared).not.toMatch(/data-instance-fx|cardRef|useMotionValue\(|hover\(/); // calls gone (imports may linger)
  });
});

describe('instance-fx + scroll-variant coexistence', () => {
  it('regenerating instance-fx does NOT eat the scroll-variant sectionInView code', () => {

    const base = `'use client';
import React, { useState, useRef, useEffect } from 'react';
import { useScroll, useMotionValueEvent, useInView, useMotionValue, animate, hover, press } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
    // 1. scroll variant (sectionInView, multi-section) + 2. hover, then 3. add tap (regenerate)
    let code = setScrollVariantInCode(base, 'card', { trigger: 'sectionInView', from: 'default', viewport: 'middle',
      sections: [{ sectionId: '1', to: 'variant-1' }, { sectionId: '2', to: 'variant-2' }] });
    code = setInstanceFxInCode(code, 'card', { hover: { to: { scale: 1.05 } } });
    code = setInstanceFxInCode(code, 'card', { hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } } });
    expect(parseJSX(code)).not.toBeNull();
    // the variant binding + its declaration both survive (the bug: const cardSv got eaten)
    expect(code).toMatch(/const \[cardSv, setCardSv\] = useState\(/); // state decl present
    expect(code).toMatch(/const cardSvSec0El = document\.getElementById/); // section lookup (re-queried in handler) present
    expect(code).toMatch(/initialVariant=\{cardSv\}/);            // binding present
    // and instance-fx is there too
    expect(code).toMatch(/cardFxHovScale/);
    expect(code).toMatch(/cardFxTapScale/);
  });

  it('adding an onScroll Scroll Variant LAST keeps instance-fx ref (transform target stays hydrated)', () => {
    const base = `'use client';
import React, { useState, useRef, useEffect } from 'react';
import { useScroll, useTransform, useMotionValueEvent, useMotionValue, animate, hover, press } from 'framer-motion';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
    // instance-fx WITH a scroll transform → attaches ref={cardRef} + useScroll({ target: cardRef })
    let code = setInstanceFxInCode(base, 'card', {
      hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } },
      appear: { from: { opacity: 0, y: 30 } }, speed: 110,
      transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } },
    });
    expect(code).toMatch(/ref=\{cardRef\}/);
    expect(code).toMatch(/useScroll\(\{ target: cardRef/);
    // NOW add an onScroll Scroll Variant (needs no ref of its own) — must NOT strip cardRef
    code = setScrollVariantInCode(code, 'card', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true });
    expect(parseJSX(code)).not.toBeNull();
    expect(code).toMatch(/ref=\{cardRef\}/);                 // instance-fx ref SURVIVES
    expect(code).toMatch(/useScroll\(\{ target: cardRef/);   // transform target still wired to it
    expect(code).toMatch(/data-scroll-variant=/);            // variant added
    // removing the variant again must also keep the instance-fx ref
    const removed = setScrollVariantInCode(code, 'card', null);
    expect(removed).toMatch(/ref=\{cardRef\}/);
    expect(removed).not.toMatch(/data-scroll-variant=/);
  });
});

describe('instance-fx scroll effects (speed + transform)', () => {
  const P = `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
  it('transform + speed compose with hover into the instance style', () => {
    const out = setInstanceFxInCode(P, 'card', {
      hover: { to: { scale: 1.05 } },
      transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } },
      speed: 110,
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const cardFxTfScale = useTransform\(cardFxTfP, \[0, 1\], \[0\.5, 1\]\)/);
    expect(out).toMatch(/const cardFxSpeedY = useTransform\(cardFxSpeedScroll, \(v\) => v \* \(1 - 110 \/ 100\)\)/);
    // scale composes hover×transform (order-agnostic), opacity is transform-only
    expect(out).toMatch(/const cardFxCScale = useTransform\(\[cardFx(Hov|Tf)Scale, cardFx(Tf|Hov)Scale\]/);
    expect(out).toMatch(/scale: cardFxCScale/);
    expect(out).toMatch(/opacity: cardFxTfOpacity/);
    expect(out).toMatch(/y: cardFxSpeedY/);
  });
  it('speed=100 (none) emits nothing', () => {
    const out = setInstanceFxInCode(P, 'card', { speed: 100 });
    expect(out).not.toMatch(/Fx/);
  });
});

describe('instance-fx full-suite e2e (the user scenario)', () => {
  it('variant + hover + tap, then add scroll transform → composes, validates, variant intact', async () => {
    const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
    const BASE = `'use client';
import React from 'react';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root"><TiFiPa data-id="ti" style={{ position: 'absolute' }} /></div>);
}`;
    let code = setScrollVariantInCode(BASE, 'ti', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true } as any);
    code = setInstanceFxInCode(code, 'ti', { hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } } });
    code = setInstanceFxInCode(code, 'ti', { hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } }, transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } } });
    expect(parseJSX(code)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
    expect(code).toMatch(/const tiFxCScale = useTransform\(\[tiFxHovScale, tiFxTapScale, tiFxTfScale\]/);
    expect(code).toMatch(/initialVariant=\{tiSv\}/);
    expect(code).toMatch(/setTiSv/);
  });
});

describe('instance-fx regen with scroll effects (destructure strip)', () => {
  it('adding speed on top of variant+hover+tap+transform persists (no duplicate decls)', async () => {
    const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
    const BASE = `'use client';
import React from 'react';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root"><TiFiPa data-id="ti" style={{ position: 'absolute' }} /></div>);
}`;
    let code = setScrollVariantInCode(BASE, 'ti', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true } as any);
    code = setInstanceFxInCode(code, 'ti', { hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } }, transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } } });
    const next = { ...(getInstanceFx(code, 'ti') || {}), speed: 110 };
    code = setInstanceFxInCode(code, 'ti', next);
    expect(parseJSX(code)).not.toBeNull();
    expect(getInstanceFx(code, 'ti')?.speed).toBe(110);             // speed persisted
    expect(code).toMatch(/tiFxSpeedY/);                             // speed code generated
    // no duplicate scroll destructures
    expect((code.match(/scrollYProgress: tiFxTfP/g) || []).length).toBe(1);
    expect((code.match(/scrollY: tiFxSpeedScroll/g) || []).length).toBe(1);
    expect(validateGeneratedCode(syncImports(code))).toBeNull();
  });
});

describe('instance-fx delete cleanup', () => {
  it('removeNodeInCode strips instance-fx (no dangling Ref/FxHovScale on delete)', async () => {
    const { removeNodeInCode } = await import('./generator-crud');
    const BASE = `'use client';
import React from 'react';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root"><TiFiPa data-id="ti" style={{ position: 'absolute' }} /></div>);
}`;
    let code = setScrollVariantInCode(BASE, 'ti', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true } as any);
    code = setInstanceFxInCode(code, 'ti', { hover: { to: { scale: 1.05 } }, tap: { to: { scale: 0.95 } }, transform: { from: { opacity: 0.5 }, to: { opacity: 1 } }, speed: 110 });
    const deleted = removeNodeInCode(code, 'ti');
    expect(parseJSX(deleted)).not.toBeNull();
    expect(deleted).not.toMatch(/Fx/);          // no instance-fx vars
    expect(deleted).not.toMatch(/tiSv\b/);       // no scroll-variant vars
    expect(deleted).not.toMatch(/<TiFiPa/);      // instance removed
  });
});

describe('instance-fx transform is element-relative', () => {
  const P = `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
  it('transform ties scrollYProgress to the element ref + offset (not whole-page)', () => {
    const out = setInstanceFxInCode(P, 'card', { transform: { from: { opacity: 0.5 }, to: { opacity: 1 } } });
    expect(parseJSX(out)).not.toBeNull();
    // transform-only still ensures the ref + attaches it
    expect(out).toMatch(/const cardRef = useRef\(null\)/);
    expect(out).toMatch(/<Card[^>]*ref=\{cardRef\}/);
    expect(out).toMatch(/const \{ scrollYProgress: cardFxTfP \} = useScroll\(\{ target: cardRef, offset: \['start end', 'end start'\] \}\)/);
  });
});

describe('instance-fx appear triggers', () => {
  const P = `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
  for (const trigger of ['onAppear', 'onScroll', 'layerInView'] as const) {
    it(`appear trigger=${trigger} generates, composes with hover, strips clean`, async () => {
      const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
      const out = setInstanceFxInCode(P, 'card', { hover: { to: { scale: 1.2 } }, appear: { from: { opacity: 0, y: 30 }, trigger, start: 'center', direction: 'down', replay: true } });
      expect(parseJSX(out)).not.toBeNull();
      expect(validateGeneratedCode(syncImports(out))).toBeNull();
      if (trigger === 'onScroll') expect(out).toMatch(/useMotionValueEvent\(cardFxAppScroll, "change", \(y\)/);
      if (trigger === 'layerInView') { expect(out).toMatch(/getBoundingClientRect/); expect(out).toMatch(/<Card[^>]*ref=\{cardRef\}/); }
      const cleared = setInstanceFxInCode(out, 'card', null);
      expect(cleared).not.toMatch(/Fx/);                 // balanced-call strip removes the multi-line handler
      expect(parseJSX(cleared)).not.toBeNull();
    });
  }
});

describe('data-scroll-fx generators insert at the render return, not a nested handler', () => {
  it('adding Scroll Speed to a plain node on a page WITH instance-fx hooks validates', async () => {
    const { decomposeAllScrollConflicts, composeAllScrollAppearConflicts, updateScrollSpeedInCode } = await import('./generator-motion');
    const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
    const BASE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root">
    <TiFiPa data-id="ti" style={{ position: 'absolute' }} />
    <motion.div data-id="frame-x" style={{ position: 'absolute', width: '243px' }}></motion.div>
  </div>);
}`;
    // instance-fx with hover => a nested `return () => {…}` handler appears BEFORE the render return
    let code = setInstanceFxInCode(BASE, 'ti', { hover: { to: { scale: 1.2 } } });
    // give the plain node an appear so the compose runs (data-scroll-fx)
    const { updateMotionPropInCode } = await import('./generator-motion');
    code = updateMotionPropInCode(code, 'frame-x', 'initial', { opacity: '0', y: '30' });
    code = updateMotionPropInCode(code, 'frame-x', 'whileInView', { opacity: '1', y: '0' });
    // now add scroll speed via the same pipeline applyMutation uses
    const decomposed = decomposeAllScrollConflicts(code);
    const applied = updateScrollSpeedInCode(decomposed, { nodeId: 'frame-x', speed: 110 } as any);
    const composed = composeAllScrollAppearConflicts(applied);
    expect(parseJSX(composed)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(composed))).toBeNull();  // decls in Page scope, not the hover callback
  });
});

describe('data-scroll-fx Scroll Transform on a plain node, instance-fx on page', () => {
  it('updateScrollAnim inserts at the render return (not a nested handler) → validates', async () => {
    const { decomposeAllScrollConflicts, composeAllScrollAppearConflicts, updateScrollAnimInCode } = await import('./generator-motion');
    const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
    const BASE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import TiFiPa from '@/components/TiFiPa';
export default function Page() {
  return (<div data-id="root">
    <TiFiPa data-id="ti" style={{ position: 'absolute' }} />
    <motion.div data-id="frame-x" style={{ position: 'absolute', width: '171px' }}></motion.div>
  </div>);
}`;
    const code = setInstanceFxInCode(BASE, 'ti', { hover: { to: { scale: 1.2 } } });
    const decomposed = decomposeAllScrollConflicts(code);
    const applied = updateScrollAnimInCode(decomposed, {
      nodeId: 'frame-x', trigger: 'onScroll',
      stops: [{ progress: 0, props: { opacity: '0.5', scale: '0.5' } }, { progress: 1, props: { opacity: '1', scale: '1' } }],
      transition: { type: 'spring', duration: '0.5', bounce: '0.25' },
    } as any);
    const composed = composeAllScrollAppearConflicts(applied);
    expect(parseJSX(composed)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(composed))).toBeNull();
  });
});

describe('instance-fx transform triggers (onScroll / layerInView / sectionInView)', () => {
  const P = `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><div data-id="sec" id="hero" style={{ height: '500px' }}></div><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;
  for (const trigger of ['onScroll', 'layerInView', 'sectionInView'] as const) {
    it(`transform trigger=${trigger} generates + validates + strips`, async () => {
      const { syncImports, validateGeneratedCode } = await import('@/code/mutation/mutation-queue');
      const spec: any = { transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 }, trigger, sectionId: 'hero', viewport: 'middle' } };
      const out = setInstanceFxInCode(P, 'card', spec);
      expect(parseJSX(out)).not.toBeNull();
      expect(validateGeneratedCode(syncImports(out))).toBeNull();
      if (trigger === 'sectionInView') expect(out).toMatch(/cardFxTfSecRef\.current = document\.getElementById\('hero'\)/);
      else expect(out).toMatch(/useScroll\(\{ target: cardRef/);
      const cleared = setInstanceFxInCode(out, 'card', null);
      expect(cleared).not.toMatch(/Fx/);
      expect(parseJSX(cleared)).not.toBeNull();
    });
  }
});

describe('instance-fx — dormantize / rehydrate (drag instance out to canvas + back)', () => {
  const FULL_SPEC: InstanceFxSpec = {
    hover: { to: { scale: 1.05 } },
    tap: { to: { scale: 0.95 } },
    appear: { from: { opacity: 0, y: 30 } },
    loop: { keyframes: { rotate: [0, 360] } },
    transform: { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } },
    speed: 110,
  };

  it('DORMANTIZE strips the page-level Fx hooks + style bindings but KEEPS the spec attr', () => {
    const live = reformat(setInstanceFxInCode(PAGE, 'card', FULL_SPEC));
    expect(live).toMatch(/useMotionValue\(/);
    const dormant = dormantizeInstanceFx(live, 'card');
    expect(parseJSX(dormant)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(dormant))).toBeNull();   // no undefined identifier
    expect(dormant).not.toMatch(/cardFx/);                            // every Fx hook/binding gone
    expect(dormant).not.toMatch(/useMotionValue\(|useTransform\(/);   // no orphan hooks
    expect(dormant).toMatch(/data-instance-fx=/);                     // spec PRESERVED (standard)
    expect(getInstanceFx(dormant, 'card')!.speed).toBe(110);          // round-trippable
  });

  it('REHYDRATE regenerates the hooks + bindings from the preserved spec', () => {
    const live = reformat(setInstanceFxInCode(PAGE, 'card', FULL_SPEC));
    const dormant = dormantizeInstanceFx(live, 'card');
    const rehydrated = rehydrateInstanceFx(dormant, 'card');
    expect(parseJSX(rehydrated)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(rehydrated))).toBeNull();
    expect(rehydrated).toMatch(/cardFx/);                             // hooks back
    expect(getInstanceFx(rehydrated, 'card')!.hover?.to).toMatchObject({ scale: 1.05 });
  });

  it('COMBINED scroll-variant + instance-fx (the drag-out crash): both dormantize/rehydrate cleanly', () => {
    // The exact user scenario: an instance with BOTH a sectionInView Scroll Variant AND full
    // instance-fx, dragged out to the canvas. A real drag runs an AST mutation first (reflow to
    // multi-line) — then dormantizing BOTH (scroll variant, then fx) must leave parseable code.
    let live = setInstanceFxInCode(PAGE, 'card', FULL_SPEC);
    live = setScrollVariantInCode(live, 'card', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: '1', to: 'variant-2' }, { sectionId: '2', to: 'default' }],
    } as any);
    live = reformat(live);
    // Exit to canvas: dormantize order matches the move mutation (scroll variant, then fx).
    let dormant = dormantizeScrollVariant(live, 'card');
    dormant = dormantizeInstanceFx(dormant, 'card');
    expect(parseJSX(dormant)).not.toBeNull();                        // was "Unexpected token (74:3)"
    expect(validateGeneratedCode(syncImports(dormant))).toBeNull();
    expect(dormant).not.toMatch(/useInView\(|cardFx|getElementById/); // all page-level machinery gone
    expect(dormant).toMatch(/data-scroll-variant=/);                  // BOTH specs preserved
    expect(dormant).toMatch(/data-instance-fx=/);
    // Back into a viewport: rehydrate both, code is whole again.
    let back = rehydrateScrollVariant(dormant, 'card');
    back = rehydrateInstanceFx(back, 'card');
    expect(parseJSX(back)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(back))).toBeNull();
    expect(getScrollVariant(back, 'card')!.trigger).toBe('sectionInView');
    expect(getInstanceFx(back, 'card')!.speed).toBe(110);
  });
});

describe('stripDeadFxStyleRefs — drag-to-canvas drops dead motion-value transform (the drag freeze)', () => {
  it('removes a transform that references this node\'s own fx motion values', () => {
    // cleanNameOf('frame-mpz9wc85-1') → 'frameMpz9wc85_1'; the drag captures the parsed transform.
    const captured = {
      left: '257px', top: '1101px', position: 'absolute',
      transform: 'scale(var:frameMpz9wc85_1FxCScale) rotate(var:frameMpz9wc85_1FxLoopRotate)',
    };
    const out = stripDeadFxStyleRefs(captured, 'frame-mpz9wc85-1');
    expect(out.transform).toBe('');          // '' = remove property → drag isn't frozen
    expect(out.left).toBe('257px');          // position untouched
    expect(out.position).toBe('absolute');
  });

  it('leaves transforms that do NOT reference this node\'s fx vars alone', () => {
    const captured = { transform: 'scale(var:someHoistedVar)', rotate: '45deg', left: '10px' };
    const out = stripDeadFxStyleRefs(captured, 'frame-mpz9wc85-1');
    expect(out.transform).toBe('scale(var:someHoistedVar)');  // foreign var kept
    expect(out.rotate).toBe('45deg');
  });

  it('end-to-end: moveNodeInCode with the cleaned styles emits a canvas node WITHOUT the dead transform', () => {
    const code = `export default function Page() {\n  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);\n}\nconst canvasNodes = <></>;`;
    const cleaned = stripDeadFxStyleRefs(
      { left: '257px', top: '1101px', transform: 'scale(var:cardFxCScale) rotate(var:cardFxLoopRotate)' },
      'card',
    );
    const moved = moveNodeInCode(code, 'card', null, cleaned, undefined, true);
    expect(parseJSX(moved)).not.toBeNull();
    expect(moved).not.toMatch(/var:cardFx/);     // dead transform did NOT land on the canvas node
    expect(moved).toMatch(/left: ['"]257px['"]/); // position did
  });
});
