import { describe, it, expect } from 'vitest';
import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import { setScrollVariantInCode, getScrollVariant, scrollVariantPresentOn, scrollVariantIsOverride, hideScrollVariantOn, resetScrollVariantScope, hasScrollVariantTargetScope, dormantizeScrollVariant, rehydrateScrollVariant, substituteScrollVariantFromVarForCanvas, removeScrollVariantFromVarRefs, type ScrollVariantSpec } from './scroll-variant-gen';
import type { SerScope } from './generator-motion';
import { parseJSX } from '@/code/parsing/ast-utils';
import { syncImports, validateGeneratedCode } from '@/code/mutation/mutation-queue';

const generate = (typeof _generate === 'function' ? _generate : (_generate as any).default);
// What an AST-path mutation (e.g. moving the node) does: reflows single-line hooks to
// multi-line — the exact state that broke the per-line strip filters.
const reformat = (c: string) => generate(parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }), { retainLines: false, concise: false }, c).code;

const PAGE = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { useScroll, useMotionValueEvent, useInView } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  return (<div data-id="root">
    <Hero data-id="hero" initialVariant="default" />
  </div>);
}`;

describe('Scroll Variant — page-level initialVariant control', () => {
  it('onScroll (direction) drives initialVariant via a state + useMotionValueEvent', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const \[heroSv, setHeroSv\] = useState\('default'\)/);
    expect(out).toMatch(/if \(y > prev\) setHeroSv\('phone'\)/);
    expect(out).toMatch(/else if \(y < prev\) setHeroSv\('default'\)/);
    expect(out).toMatch(/<Hero[^>]*initialVariant=\{heroSv\}/);
    expect(getScrollVariant(out, 'hero')?.to).toBe('phone');
  });

  it('section bound to a VARIABLE re-queries getElementById(<var>) inside the handler (no cached ref)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'middle',
      sections: [{ sectionId: 'leadership', to: 'phone', sectionVar: 'scrollSection' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const heroSvSec0El = document\.getElementById\(scrollSection\)/);  // identifier ref, NOT a string
    expect(out).not.toMatch(/getElementById\(['"]scrollSection['"]\)/);
    // Re-queried every scroll tick — NOT cached in a mount-time, name-keyed useEffect ref
    // (which goes stale across client navigation when two routes share the anchor name).
    expect(out).not.toMatch(/SvSec0Ref/);
    expect(out).not.toMatch(/useEffect\(\(\) => \{ heroSvSec0\w*\.current/);
  });

  it('resting-reset useEffect lists the route-bound fromVar deps (soft-nav variant switch from the TOP)', () => {
    // A template header whose resting variant is route-bound (fromVar=headerVariant + per-viewport
    // tabletVariant/mobileVariant) reassigns those vars per route via usePathname. Navigating from the TOP of
    // a page fires no scroll event, so the reset effect MUST re-run on the fromVar change — i.e. list them as
    // deps — or the header stays on the previous page's variant until you scroll.
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      fromVar: 'headerVariant',
      responsive: [
        { scope: { query: '(max-width: 768px) and (min-width: 376px)' }, fromVar: 'tabletVariant' },
        { scope: { query: '(max-width: 375px)' }, fromVar: 'mobileVariant' },
      ],
      sections: [{ sectionId: 'hero', to: 'default-scrolled', sectionVar: 'scrollSection' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    const m = out.match(/useEffect\(\(\) => \{ setHeroSv\([^\n]*?\}, \[([^\]]*)\]\);/);
    expect(m).toBeTruthy();
    const deps = m![1];
    expect(deps).toContain('headerVariant');
    expect(deps).toContain('tabletVariant');
    expect(deps).toContain('mobileVariant');
    // sanity: a plain scroll variant with NO fromVar keeps the old viewport-only deps (no route vars injected)
    const plain = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true });
    expect(plain).not.toMatch(/setHeroSv\([^\n]*\}, \[[^\]]*headerVariant/);
  });

  it('section with a LITERAL id re-queries getElementById(\'id\') in the handler (no cached ref)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'middle',
      sections: [{ sectionId: 'leadership', to: 'phone' }],
    } as ScrollVariantSpec);
    expect(out).toMatch(/const heroSvSec0El = document\.getElementById\('leadership'\)/);
    expect(out).not.toMatch(/SvSec0Ref/);
  });

  it('section element is resolved INSIDE the scroll handler, not a mount effect (survives client nav)', () => {
    // The regression: a template header's section lives on the page (`{children}`), which
    // remounts on soft navigation while the LayoutClient persists — a mount-time ref then
    // points at the previous page's detached element. Resolving per-tick fixes it.
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
    } as ScrollVariantSpec);
    const handler = out.slice(out.indexOf('useMotionValueEvent('));
    expect(handler).toMatch(/document\.getElementById\('hero'\)/);   // the lookup lives in the handler body
    expect(out).not.toMatch(/\.current = document\.getElementById/); // never cached on a ref
  });

  it('REMOVING a legacy section-VAR tracker (multi-line, non-empty deps) strips it cleanly — no dangling ref', () => {
    // The regression the user hit: an OLD-form tracker cached the element in a ref via
    // `useEffect(() => { xSvSec0Ref.current = getElementById(scrollSection3); }, [scrollSection3])`.
    // The strip only matched EMPTY deps `[]`, so the sectionVar form ([scrollSection3]) survived →
    // dangling `xSvSec0Ref` after its const was removed → "References undefined identifier … would
    // crash at runtime" blocked BOTH remove and re-apply. The deps are now matched as `[<anything>]`.
    const LEGACY = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import { usePathname } from 'next/navigation';
import Header from '@/components/Header';
const __templateProps = {"/":{"scrollSection3":"hero"}};
const __matchTemplateRoute = (__p) => __templateProps[__p] ?? {};
export default function LayoutClient({ children, scrollSection3 = "" }: { children: React.ReactNode }) {
  scrollSection3 = (__matchTemplateRoute(usePathname())).scrollSection3 ?? scrollSection3;
  const {
    scrollY: heroSvScrollY
  } = useScroll();
  const [heroSv, setHeroSv] = useState('default');
  const heroSvSec0Ref = useRef(null);
  useEffect(() => {
    heroSvSec0Ref.current = document.getElementById(scrollSection3);
  }, [scrollSection3]);
  useMotionValueEvent(heroSvScrollY, "change", () => {
    let v = 'default';
    if (heroSvSec0Ref.current && heroSvSec0Ref.current.getBoundingClientRect().top < 0) v = 'default-scrolled';
    setHeroSv(v);
  });
  return (<div data-id="root">
    <Header data-scroll-variant='{"trigger":"sectionInView","from":"default","to":"default-scrolled","viewport":"top","sections":[{"sectionId":"","to":"default-scrolled","sectionVar":"scrollSection3"}]}' initialVariant={heroSv} data-id="hero" data-name="Header" />
  </div>);
}`;
    // REMOVE — must not leave a dangling reference (the user's blocked mutation).
    const removed = setScrollVariantInCode(LEGACY, 'hero', null);
    expect(parseJSX(removed)).not.toBeNull();
    expect(removed).not.toMatch(/heroSvSec0Ref/);                       // no dangling identifier
    expect(removed).not.toMatch(/getElementById/);                      // section lookup gone
    expect(validateGeneratedCode(syncImports(removed))).toBeNull();     // validator no longer blocks

    // RE-APPLY the same spec — upgrades to the per-tick form, also no dangling ref.
    const reapplied = setScrollVariantInCode(LEGACY, 'hero', getScrollVariant(LEGACY, 'hero')!);
    expect(parseJSX(reapplied)).not.toBeNull();
    expect(reapplied).not.toMatch(/heroSvSec0Ref/);                     // old cached ref gone
    expect(reapplied).toMatch(/const heroSvSec0El = document\.getElementById\(scrollSection3\)/); // new live form
    expect(validateGeneratedCode(syncImports(reapplied))).toBeNull();
  });

  it('responsive instance: base resting = primary default (desktop must NOT init to the mobile variant)', () => {
    // The instance carries data-responsive (desktop→default implicit, 768/375→mobile).
    // Adding an onScroll variant must seed the per-viewport RESTING from that map: BASE
    // = the primary 'default', each listed breakpoint = 'mobile'. The bug took the
    // largest breakpoint (768) as "primary" and set the base from to 'mobile' → desktop
    // initialized to the mobile variant on the live page.
    const RESPONSIVE_PAGE = `'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
export default function Page() {
  return (<div data-id="root">
    <Header data-id="nav" data-responsive='{"768":{"initialVariant":"mobile"},"375":{"initialVariant":"mobile"},"_bp":[768,375]}' initialVariant="default" />
  </div>);
}`;
    // Pass a WRONG base from:'mobile' (what the buggy run stored) — onScroll must reset it.
    const out = setScrollVariantInCode(RESPONSIVE_PAGE, 'nav', { trigger: 'onScroll', from: 'mobile', to: 'default-scrolled', direction: 'down', replay: true });
    expect(parseJSX(out)).not.toBeNull();
    // Base resting corrected to the primary 'default'.
    expect(getScrollVariant(out, 'nav')?.from).toBe('default');
    const resp = getScrollVariant(out, 'nav')?.responsive ?? [];
    // Both replica breakpoints seeded as per-viewport resting overrides.
    expect(resp.length).toBe(2);
    // CRITICAL: every resting scope is a CAPPED max-width query. An unbounded
    // `(min-width: …)` (the old viewportSetToQuery output for the top breakpoint) also
    // matches desktop (1440) → desktop would resolve to 'mobile'. Capped queries match
    // only viewports ≤ W, so desktop (wider than every breakpoint) matches none → 'default'.
    for (const r of resp) {
      expect((r.scope as { query: string }).query).toMatch(/^\(max-width: \d+px\)$/);
    }
    expect(out).not.toMatch(/useMediaQuery\('\(min-width:/);   // nothing desktop-matching
    // The bound initial is per-viewport GATED, not a bare ungated 'mobile' for all tiles.
    expect(out).toMatch(/useMediaQuery/);
    expect(out).toMatch(/useState\(\(/);                 // gated init expression
    expect(out).not.toMatch(/useState\('mobile'\)/);     // the exact regression shape
  });

  it('per-viewport presence: scope=[tablet] gates the bind so it is ABSENT on primary', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      scope: [{ query: TABLET }],
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/function useMediaQuery\(/);
    expect(out).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // present (Sv) only when the gate matches; off-scope → 'default' (from) = no morph.
    expect(out).toMatch(/<Hero[^>]*initialVariant=\{\(__mq0 \? heroSv : 'default'\)\}/);
    expect((getScrollVariant(out, 'hero')?.scope?.[0] as any)?.query).toBe(TABLET);
  });

  it('per-viewport presence: hiddenOn=[tablet] keeps it on base, OFF on tablet', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      hiddenOn: [{ query: TABLET }],
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/<Hero[^>]*initialVariant=\{\(__mq0 \? 'default' : heroSv\)\}/);
  });

  it('no scope → bare bind (zero regression)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true });
    expect(out).toMatch(/<Hero[^>]*initialVariant=\{heroSv\}/);
    expect(out).not.toMatch(/useMediaQuery/);
  });

  it('REFORMAT-proof: editing after a babel reflow does NOT duplicate the multi-line SvScroll decl', () => {
    // Generate, then REFLOW to multi-line (`const {\n scrollY: heroSvScroll\n} = useScroll()`)
    // — what an unrelated AST mutation does. Editing must strip the multi-line decl before
    // regenerating, else "Identifier 'heroSvScroll' already declared".
    const gen = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true });
    const reflowed = reformat(gen);
    expect(reflowed).toMatch(/scrollY:\s*heroSvScroll/);
    // Edit (change To) — re-runs strip + regen on the reflowed code.
    const edited = setScrollVariantInCode(reflowed, 'hero', { trigger: 'onScroll', from: 'default', to: 'variant-2', direction: 'down', replay: true });
    expect(parseJSX(edited)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(edited))).toBeNull();   // no dup → no "already declared"
    // Exactly ONE SvScroll destructure.
    expect((edited.match(/scrollY:\s*heroSvScroll/g) || []).length).toBe(1);
  });

  it('per-viewport TARGET: Tablet scrolls to a DIFFERENT variant — gated to + round-trip', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      responsive: [{ scope: { query: TABLET }, to: 'tablet' }],
    });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const __mq0 = useMediaQuery\('\(max-width: 768px\) and \(min-width: 376px\)'\)/);
    // The scroll-DOWN target is gated per tile: Desktop → 'phone', Tablet → 'tablet'.
    expect(out).toMatch(/if \(y > prev\) setHeroSv\(\(__mq0 \? 'tablet' : 'phone'\)\)/);
    const back = getScrollVariant(out, 'hero')!;
    expect(back.to).toBe('phone');                                  // base intact
    expect(back.responsive?.[0]?.to).toBe('tablet');
  });

  it('per-viewport fromVar: Desktop binds the base var, Tablet binds a SEPARATE override var', () => {
    const TABLET = '(max-width: 768px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'scrolled', direction: 'down', replay: true,
      fromVar: 'headerVariant',
      responsive: [{ scope: { query: TABLET }, fromVar: 'headerVariantTablet' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // The resting BINDING is per-viewport: (__mq ? tabletVar : baseVar) || (resting).
    expect(out).toMatch(/useState\(\(__mq\d+ \? headerVariantTablet : headerVariant\) \|\| \(/);
    // Round-trips through getScrollVariant.
    const back = getScrollVariant(out, 'hero')!;
    expect(back.fromVar).toBe('headerVariant');
    expect(back.responsive?.[0]?.fromVar).toBe('headerVariantTablet');
  });

  it("per-viewport fromVar='' (sentinel) breaks the cascade — that tile falls to its resting, not the base var", () => {
    const TABLET = '(max-width: 768px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'scrolled', direction: 'down', replay: true,
      fromVar: 'headerVariant',
      responsive: [{ scope: { query: TABLET }, fromVar: '' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // The Tablet branch contributes '' (no variable) → `('' || resting)`; Desktop keeps headerVariant.
    expect(out).toMatch(/useState\(\(__mq\d+ \? '' : headerVariant\) \|\| \(/);
    expect(getScrollVariant(out, 'hero')?.responsive?.[0]?.fromVar).toBe('');
  });

  it('removeScrollVariantFromVarRefs clears a deleted variable from the base + per-viewport fromVars (no dangling ref)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    // Header binds the BASE to tabletVariant and a per-viewport scope to headerVariantsdf2.
    const code = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
      fromVar: 'tabletVariant',
      responsive: [{ scope: { query: TABLET }, fromVar: 'headerVariantsdf2' }],
    } as ScrollVariantSpec);
    expect(code).toContain('tabletVariant');                       // present before
    // Delete `tabletVariant` → its binding is cleared, the OTHER variable survives.
    const out = removeScrollVariantFromVarRefs(code, 'tabletVariant');
    const spec = getScrollVariant(out, 'hero')!;
    expect(spec.fromVar).toBeUndefined();                          // base binding gone
    expect(spec.responsive?.[0]?.fromVar).toBe('headerVariantsdf2'); // per-viewport binding kept
    // The generated runtime no longer references the deleted identifier as a bare var.
    expect(out).not.toMatch(/\btabletVariant\b/);
    expect(out).toContain('headerVariantsdf2');
    expect(parseJSX(out)).not.toBeNull();
  });

  it('base-only fromVar stays the bare global binding (backward compatible)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'scrolled', direction: 'down', replay: true,
      fromVar: 'headerVariant',
    } as ScrollVariantSpec);
    expect(out).toMatch(/useState\(headerVariant \|\| \(/);   // bare base binding
    expect(out).not.toMatch(/\? headerVariant :/);             // NOT per-viewport gated
  });

  it('REFORMAT/EDIT-proof: the reset-on-resize useEffect is stripped on regen (no pile-up)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const spec: ScrollVariantSpec = {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      responsive: [{ scope: { query: TABLET }, to: 'tablet' }],
    };
    const gen = setScrollVariantInCode(PAGE, 'hero', spec);
    // The responsive form emits ONE reset effect referencing the capitalised setter.
    expect((gen.match(/useEffect\(\(\) => \{ setHeroSv\(/g) || []).length).toBe(1);
    // Editing re-runs strip + regen — it must REMOVE the old reset, not pile a 2nd one.
    const edited = setScrollVariantInCode(reformat(gen), 'hero', { ...spec, to: 'desktop' });
    expect(parseJSX(edited)).not.toBeNull();
    expect((edited.match(/useEffect\(\(\) => \{ setHeroSv\(/g) || []).length).toBe(1);
    expect(validateGeneratedCode(syncImports(edited))).toBeNull();
  });

  const PAGE_RESP = `'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  return (<div data-id="root">
    <Hero data-id="hero" initialVariant="default" data-responsive='{"768":{"initialVariant":"variant-1"},"375":{"initialVariant":"variant-2"},"_bp":[1440,768,375]}' />
  </div>);
}`;

  it('keeps data-responsive INTACT (per-viewport choice) + seeds the Sv resting from it', () => {
    // The per-viewport variant CHOICE (data-responsive) and the scroll From/To are SEPARATE.
    // Adding a scroll variant must NOT modify data-responsive (canvas + dropdown + delete keep
    // owning it). It only READS data-responsive to seed the Sv's per-tile resting (`from`); the
    // runtime morph wins because the withResponsiveProps HOC skips initialVariant when
    // data-scroll-variant is present.
    const out = setScrollVariantInCode(PAGE_RESP, 'hero', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true });
    expect(parseJSX(out)).not.toBeNull();
    // data-responsive byte-intact (NOT stripped).
    expect(out).toMatch(/data-responsive='\{"768":\{"initialVariant":"variant-1"\},"375":\{"initialVariant":"variant-2"\},"_bp":\[1440,768,375\]\}'/);
    // The Sv resting is seeded per-tile from data-responsive (tablet → variant-1, mobile → variant-2).
    const spec = getScrollVariant(out, 'hero')!;
    const tabletQ = spec.responsive?.find((r) => 'query' in r.scope && (r.scope as any).query.includes('768'));
    const mobileQ = spec.responsive?.find((r) => 'query' in r.scope && (r.scope as any).query === '(max-width: 375px)');
    expect(tabletQ?.from).toBe('variant-1');
    expect(mobileQ?.from).toBe('variant-2');
    expect(out).toMatch(/initialVariant=\{heroSv\}/);
  });

  it('DORMANTIZE for canvas: strips the Sv hooks + binds a static resting variant, KEEPS the spec (no undefined ref)', () => {
    // Moving a scroll-variant instance into canvasNodes (module scope) would leave
    // `initialVariant={heroSv}` referencing the page-scoped Sv → "undefined identifier" crash.
    // Dormantize bakes the binding static + strips the hooks, but keeps data-scroll-variant.
    const live = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true });
    expect(live).toMatch(/initialVariant=\{heroSv\}/);
    const dormant = dormantizeScrollVariant(live, 'hero');
    expect(parseJSX(dormant)).not.toBeNull();
    expect(validateGeneratedCode(syncImports(dormant))).toBeNull();   // no undefined identifier
    expect(dormant).not.toMatch(/\{heroSv\}/);                        // binding baked
    expect(dormant).not.toMatch(/const \[heroSv/);                    // hooks stripped
    expect(dormant).toMatch(/initialVariant="default"/);              // static resting
    expect(dormant).toMatch(/data-scroll-variant=/);                  // spec PRESERVED
    expect(getScrollVariant(dormant, 'hero')!.to).toBe('variant-1');  // round-trippable
  });

  it('DORMANTIZE a sectionInView variant after a babel reflow: no dangling section machinery', () => {
    // sectionInView emits a `useMotionValueEvent` handler + per-section refs/getElementById
    // effects. A real drag-out runs an AST mutation first, which reflows the hooks to
    // MULTI-LINE — the strip must still remove the whole handler + refs cleanly (a per-line
    // filter would leave the handler body dangling → "Unexpected token"). Reflow before dormantizing.
    const live = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'middle',
      sections: [{ sectionId: '1', to: 'variant-2' }, { sectionId: '2', to: 'default' }],
    } as ScrollVariantSpec);
    const reflowed = reformat(live);                  // single-line hooks → multi-line (the breaking state)
    expect(reflowed).toMatch(/useMotionValueEvent\(/);  // sanity: the multi-line handler is present
    const dormant = dormantizeScrollVariant(reflowed, 'hero');
    expect(parseJSX(dormant)).not.toBeNull();                          // parses (was "Unexpected token")
    expect(validateGeneratedCode(syncImports(dormant))).toBeNull();
    expect(dormant).not.toMatch(/useMotionValueEvent\(/);              // scroll handler gone
    expect(dormant).not.toMatch(/getBoundingClientRect/);             // section position checks gone
    expect(dormant).not.toMatch(/getElementById/);                     // section ref effects gone
    expect(dormant).not.toMatch(/SvSec/);                              // no dangling section identifiers
    expect(dormant).toMatch(/data-scroll-variant=/);                   // spec PRESERVED (standard)
    expect(getScrollVariant(dormant, 'hero')!.trigger).toBe('sectionInView');
  });

  it('REHYDRATE: regenerates the Sv hooks + binding from the preserved spec (canvas → viewport)', () => {
    const live = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true });
    const dormant = dormantizeScrollVariant(live, 'hero');
    const rehydrated = rehydrateScrollVariant(dormant, 'hero');
    expect(parseJSX(rehydrated)).not.toBeNull();
    expect(rehydrated).toMatch(/initialVariant=\{heroSv\}/);          // binding back
    expect(rehydrated).toMatch(/const \[heroSv, setHeroSv\] = useState\(/);  // hooks back
    expect(validateGeneratedCode(syncImports(rehydrated))).toBeNull();
    expect(getScrollVariant(rehydrated, 'hero')!.to).toBe('variant-1');
  });

  it('RESET OVERRIDE: clears the per-tile override (migration-seeded `from`-only is NOT an override)', () => {
    const T: SerScope = { query: '(max-width: 768px) and (min-width: 376px)' };
    // A `from`-only entry (the resting migrated from the per-viewport choice) is NOT an override.
    expect(hasScrollVariantTargetScope({ trigger: 'onScroll', from: 'default', responsive: [{ scope: T, from: 'variant-1' }] }, T)).toBe(false);
    // A per-tile `to` or `direction` IS a real user override.
    expect(hasScrollVariantTargetScope({ trigger: 'onScroll', from: 'default', responsive: [{ scope: T, from: 'variant-1', to: 'variant-2' }] }, T)).toBe(true);
    expect(hasScrollVariantTargetScope({ trigger: 'onScroll', from: 'default', responsive: [{ scope: T, direction: 'up' }] }, T)).toBe(true);

    // Full round-trip: a tablet override, reset → re-migrated to from-only → override cleared.
    const PAGE_RESP = `'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Hero from '@/components/Hero';
export default function Page() {
  return (<div data-id="root">
    <Hero data-id="hero" initialVariant="default" data-responsive='{"768":{"initialVariant":"variant-1"},"_bp":[1440,768]}' />
  </div>);
}`;
    const withOverride = setScrollVariantInCode(PAGE_RESP, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'variant-1', direction: 'down', replay: true,
      responsive: [{ scope: T, from: 'variant-1', to: 'variant-2' }],
    });
    expect(hasScrollVariantTargetScope(getScrollVariant(withOverride, 'hero')!, T)).toBe(true);  // override present
    // Reset → drop the tablet override → re-run codegen (migration re-adds from-only resting).
    const resetSpec = resetScrollVariantScope(getScrollVariant(withOverride, 'hero')!, T)!;
    const afterReset = setScrollVariantInCode(withOverride, 'hero', resetSpec);
    expect(parseJSX(afterReset)).not.toBeNull();
    expect(hasScrollVariantTargetScope(getScrollVariant(afterReset, 'hero')!, T)).toBe(false);   // override CLEARED
  });

  it('DELETE leaves data-responsive intact (nothing to restore — it was never touched)', () => {
    const added = setScrollVariantInCode(PAGE_RESP, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true });
    const removed = setScrollVariantInCode(added, 'hero', null);
    expect(parseJSX(removed)).not.toBeNull();
    // Per-viewport choice survives delete exactly as set.
    expect(removed).toMatch(/"768":\{"initialVariant":"variant-1"\}/);
    expect(removed).toMatch(/"375":\{"initialVariant":"variant-2"\}/);
    // The scroll machinery is gone.
    expect(removed).not.toMatch(/data-scroll-variant/);
    expect(removed).not.toMatch(/heroSv/);
  });

  it('per-viewport DIRECTION: Desktop scrolls Down→phone, Tablet scrolls Up→phone (gated down/up targets)', () => {
    const TABLET = '(max-width: 768px) and (min-width: 376px)';
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      responsive: [{ scope: { query: TABLET }, direction: 'up' }],
    });
    expect(parseJSX(out)).not.toBeNull();
    // Direction is encoded as which target each scroll way sets. Base down=phone, up=default.
    // Tablet (direction up) swaps: down=default, up=phone.
    expect(out).toMatch(/if \(y > prev\) setHeroSv\(\(__mq0 \? 'default' : 'phone'\)\)/);   // scroll down
    expect(out).toMatch(/else if \(y < prev\) setHeroSv\(\(__mq0 \? 'phone' : 'default'\)\)/); // scroll up
    // Resets on resize so the gate re-evaluates.
    expect(out).toMatch(/useEffect\(\(\) => \{ setHeroSv\(/);
    expect(getScrollVariant(out, 'hero')!.responsive?.[0]?.direction).toBe('up');
  });

  describe('per-viewport presence helpers (the reference 3-state)', () => {
    const TABLET: SerScope = { query: '(max-width: 768px) and (min-width: 376px)' };
    const MOBILE: SerScope = { query: '(max-width: 375px)' };
    const base: ScrollVariantSpec = { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true };

    it('base effect is present everywhere', () => {
      expect(scrollVariantPresentOn(base, null)).toBe(true);
      expect(scrollVariantPresentOn(base, TABLET)).toBe(true);
      expect(scrollVariantIsOverride(base, TABLET)).toBe(false);
    });

    it('scoped-only (added on Tablet) is ABSENT on primary, present on Tablet', () => {
      const sv: ScrollVariantSpec = { ...base, scope: [TABLET] };
      expect(scrollVariantPresentOn(sv, null)).toBe(false);     // not on Desktop
      expect(scrollVariantPresentOn(sv, TABLET)).toBe(true);
      expect(scrollVariantPresentOn(sv, MOBILE)).toBe(false);
      expect(scrollVariantIsOverride(sv, TABLET)).toBe(true);
    });

    it('hiddenOn (deleted on Tablet) stays on base, off on Tablet', () => {
      const sv: ScrollVariantSpec = { ...base, hiddenOn: [TABLET] };
      expect(scrollVariantPresentOn(sv, null)).toBe(true);
      expect(scrollVariantPresentOn(sv, TABLET)).toBe(false);
      expect(scrollVariantPresentOn(sv, MOBILE)).toBe(true);
    });

    it('delete on a replica: base → hidden here; scoped-only → removed when last', () => {
      expect(hideScrollVariantOn(base, TABLET)).toEqual({ ...base, hiddenOn: [TABLET] });
      expect(hideScrollVariantOn({ ...base, scope: [TABLET] }, TABLET)).toBeNull();           // last scope → remove
      expect(hideScrollVariantOn({ ...base, scope: [TABLET, MOBILE] }, TABLET)).toEqual({ ...base, scope: [MOBILE] });
    });

    it('reset on a replica: drop the tile customization; scoped-only with no base → remove', () => {
      expect(resetScrollVariantScope({ ...base, hiddenOn: [TABLET] }, TABLET)).toEqual(base);
      expect(resetScrollVariantScope({ ...base, scope: [TABLET] }, TABLET)).toBeNull();
      expect(resetScrollVariantScope({ ...base, scope: [TABLET, MOBILE] }, TABLET)).toEqual({ ...base, scope: [MOBILE] });
    });
  });

  it('onScroll without replay latches (no revert on scroll up)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: false });
    expect(out).toMatch(/if \(y > prev\) setHeroSv\('phone'\)/);
    expect(out).not.toMatch(/else if \(y < prev\)/);
  });

  it('layerInView drives off useScroll + the element rect (no IntersectionObserver), with a real ref', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'layerInView', from: 'default', to: 'phone', start: 'center', replay: true });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).not.toContain('querySelector');
    expect(out).not.toMatch(/useInView\(/);                          // no rootMargin observer call
    expect(out).toMatch(/const heroSvRef = useRef\(null\)/);
    expect(out).toMatch(/<Hero[^>]*ref=\{heroSvRef\}/);
    expect(out).toMatch(/const \{ scrollY: heroSvScrollY \} = useScroll\(\)/);
    expect(out).toMatch(/useMotionValueEvent\(heroSvScrollY, "change"/);
    expect(out).toMatch(/getBoundingClientRect\(\)\.top <= window\.innerHeight \* 0\.5/); // center
    expect(out).toMatch(/setHeroSv\(past \? 'phone' : 'default'\)/);
  });

  it('layerInView start=top triggers only when the element top reaches the viewport top (<= 0)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'layerInView', from: 'default', to: 'phone', start: 'top', replay: true });
    expect(out).toMatch(/getBoundingClientRect\(\)\.top <= 0;/);
    expect(out).not.toMatch(/innerHeight \* 0\b/); // not the silly `* 0`
  });

  it('layerInView start=bottom triggers when the element enters from the bottom (<= innerHeight)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'layerInView', from: 'default', to: 'phone', start: 'bottom', replay: true });
    expect(out).toMatch(/getBoundingClientRect\(\)\.top <= window\.innerHeight \* 1;/);
  });

  it('sectionInView: POSITION-based (top edge past the line) per section, LATER sections win', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'sectionInView', from: 'default', viewport: 'middle',
      sections: [{ sectionId: 'sec1', to: 'tablet' }, { sectionId: 'sec2', to: 'phone' }] });
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/const heroSvSec0El = document\.getElementById\('sec1'\)/);
    expect(out).toMatch(/const heroSvSec1El = document\.getElementById\('sec2'\)/);
    // Position checks, NOT useInView intersection.
    expect(out).not.toMatch(/useInView\(/);
    expect(out).toMatch(/if \(heroSvSec0El && heroSvSec0El\.getBoundingClientRect\(\)\.top < window\.innerHeight \* 0\.5\) v = 'tablet'/);
    expect(out).toMatch(/if \(heroSvSec1El && heroSvSec1El\.getBoundingClientRect\(\)\.top < window\.innerHeight \* 0\.5\) v = 'phone'/);
    // Later section (sec2 → 'phone') is checked AFTER sec1, so it overwrites → wins.
    expect(out.indexOf("v = 'tablet'")).toBeLessThan(out.indexOf("v = 'phone'"));
  });

  it('sectionInView Viewport=Top on a responsive instance: dark past the section top, resting per viewport (design-tool parity)', () => {
    const RESPONSIVE_PAGE = `'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
export default function Page() {
  return (<div data-id="root">
    <div data-id="hero" id="hero" />
    <Header data-id="nav" data-responsive='{"768":{"initialVariant":"mobile"},"375":{"initialVariant":"mobile"},"_bp":[768,375]}' initialVariant="default" />
  </div>);
}`;
    const out = setScrollVariantInCode(RESPONSIVE_PAGE, 'nav', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // Viewport=Top → line 0: dark once the hero's TOP edge scrolls ABOVE the viewport top
    // (i.e. you've scrolled down), transparent at the very top. Reverts ONLY at the top.
    expect(out).toMatch(/navSvSec0El && navSvSec0El\.getBoundingClientRect\(\)\.top < 0\) v = 'default-scrolled'/);
    expect(out).not.toMatch(/useInView\(/);
    // Resting is per-viewport gated (desktop 'default', mobile 'mobile'), base = primary 'default'.
    expect(out).toMatch(/useMediaQuery/);
    expect(out).toMatch(/let v = \(/);
    expect(getScrollVariant(out, 'nav')?.from).toBe('default');
  });

  it('sectionInView per-viewport target: the section To is gated per tile (desktop vs mobile scrolled)', () => {
    const RESPONSIVE_PAGE = `'use client';
import React, { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
export default function Page() {
  return (<div data-id="root">
    <div data-id="hero" id="hero" />
    <Header data-id="nav" data-responsive='{"768":{"initialVariant":"mobile"},"375":{"initialVariant":"mobile"},"_bp":[768,375]}' initialVariant="default" />
  </div>);
}`;
    // Base section To = default-scrolled; a (max-width: 768px) override = mobile-scrolled.
    const out = setScrollVariantInCode(RESPONSIVE_PAGE, 'nav', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
      responsive: [{ scope: { query: '(max-width: 768px)' }, to: 'mobile-scrolled' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // Section target gated per viewport (NOT a bare 'mobile-scrolled' for all tiles).
    expect(out).toMatch(/v = \(__mq\d+ \? 'mobile-scrolled' : 'default-scrolled'\)/);
    expect(out).not.toMatch(/v = 'mobile-scrolled';/);
  });

  it('sweeps an orphaned useMediaQuery gate left by a previous spec (no dead __mq const)', () => {
    // A page that already carries a stale `(min-width: 376px)` gate (the kind an older
    // resting expression created) which the NEW spec never references.
    const STALE_PAGE = `'use client';
import React, { useState, useEffect, useRef } from 'react';
import { motion, useScroll, useMotionValueEvent } from 'framer-motion';
import Header from '@/components/Header';
function useMediaQuery(query) { return false; }
export default function Page() {
  const __mq0 = useMediaQuery('(min-width: 376px)');
  return (<div data-id="root">
    <div data-id="hero" id="hero" />
    <Header data-id="nav" data-responsive='{"768":{"initialVariant":"mobile"},"375":{"initialVariant":"mobile"},"_bp":[768,375]}' initialVariant="default" />
  </div>);
}`;
    const out = setScrollVariantInCode(STALE_PAGE, 'nav', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero', to: 'default-scrolled' }],
      responsive: [{ scope: { query: '(max-width: 768px)' }, to: 'mobile-scrolled' }],
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // The stale min-width gate is gone (nothing referenced it after migration).
    expect(out).not.toMatch(/useMediaQuery\('\(min-width: 376px\)'\)/);
    // Every surviving gate const is actually referenced (no declaration-only orphan).
    for (const mm of out.matchAll(/const (__mq\d+) = useMediaQuery/g)) {
      const refs = out.match(new RegExp(`\\b${mm[1]}\\b`, 'g'))?.length ?? 0;
      expect(refs).toBeGreaterThan(1);
    }
  });

  it('set replaces (no duplicate decls) and remove strips everything', () => {
    let out = setScrollVariantInCode(PAGE, 'hero', { trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down' });
    out = setScrollVariantInCode(out, 'hero', { trigger: 'onScroll', from: 'default', to: 'tablet', direction: 'down' });  // edit
    expect((out.match(/const \[heroSv,/g) || []).length).toBe(1);     // not duplicated
    expect(out).toMatch(/setHeroSv\('tablet'\)/);
    const removed = setScrollVariantInCode(out, 'hero', null);
    expect(parseJSX(removed)).not.toBeNull();
    expect(removed).not.toContain('heroSv');
    expect(removed).not.toContain('data-scroll-variant');
    expect(removed).toMatch(/<Hero data-id="hero"/);
  });
});

describe('Scroll Variant — fromVar (per-route resting variable; coexists with the effect)', () => {
  it('sectionInView: resting reads `fromVar || (...)`, target + binding untouched', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero-sec', to: 'default-scrolled' }],
      fromVar: 'headerVariant',
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    // Resting (useState init + the not-triggered value) is overridable per route.
    expect(out).toMatch(/useState\(headerVariant \|\| \('default'\)\)/);
    expect(out).toMatch(/let v = headerVariant \|\| \('default'\)/);
    // The scroll TARGET is NEVER wrapped — the effect always animates to it.
    expect(out).toMatch(/v = 'default-scrolled'/);
    expect(out).not.toMatch(/headerVariant \|\| \('default-scrolled'\)/);
    // The instance binding stays OWNED by the scroll machine (NOT swapped to the var).
    expect(out).toMatch(/initialVariant=\{heroSv\}/);
  });

  it('onScroll: useState resting wrapped, the scroll-down target stays a literal', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'onScroll', from: 'default', to: 'phone', direction: 'down', replay: true,
      fromVar: 'headerVariant',
    } as ScrollVariantSpec);
    expect(parseJSX(out)).not.toBeNull();
    expect(out).toMatch(/useState\(headerVariant \|\| \('default'\)\)/);
    expect(out).toMatch(/'phone'/);                              // target present
    expect(out).not.toMatch(/headerVariant \|\| \('phone'\)/);   // target never var-wrapped
  });

  it('no fromVar → resting unwrapped (zero regression)', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero-sec', to: 'default-scrolled' }],
    } as ScrollVariantSpec);
    expect(out).not.toMatch(/\|\| \(/);
    expect(out).toMatch(/useState\('default'\)/);
  });

  it('round-trips fromVar through getScrollVariant', () => {
    const out = setScrollVariantInCode(PAGE, 'hero', {
      trigger: 'sectionInView', from: 'default', viewport: 'top',
      sections: [{ sectionId: 'hero-sec', to: 'default-scrolled' }],
      fromVar: 'headerVariant',
    } as ScrollVariantSpec);
    expect(getScrollVariant(out, 'hero')?.fromVar).toBe('headerVariant');
  });
});

// ─── Canvas: bake a `fromVar` route value into the scroll-variant's display ───
// variant. The deploy/preview resolves the resting variant at runtime
// (`useState(headerVariant || …)` via usePathname); the canvas can't run that,
// so store.ts pre-bakes the per-route value into `canvasVariant` before the
// parser expands the instance. This is the unit for that pre-bake.
describe('substituteScrollVariantFromVarForCanvas', () => {
  const attr = (spec: Partial<ScrollVariantSpec>) => `data-scroll-variant='${JSON.stringify(spec)}'`;
  const readSpecs = (code: string): ScrollVariantSpec[] =>
    [...code.matchAll(/data-scroll-variant='([^']*)'/g)].map((m) => JSON.parse(m[1]));
  const base = { trigger: 'onScroll', from: 'default', canvasVariant: 'default', fromVar: 'headerVariant' } as Partial<ScrollVariantSpec>;

  it('bakes the fromVar route value into canvasVariant', () => {
    const code = `<Header ${attr(base)} />`;
    const out = substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'desktop-scrolled' });
    const spec = readSpecs(out)[0];
    expect(spec.canvasVariant).toBe('desktop-scrolled');
    // Other spec fields are preserved (round-trip safe).
    expect(spec.fromVar).toBe('headerVariant');
    expect(spec.from).toBe('default');
  });

  it('no-op when routeValues is empty (untemplated/clean pages byte-identical)', () => {
    const code = `<Header ${attr(base)} />`;
    expect(substituteScrollVariantFromVarForCanvas(code, {})).toBe(code);
  });

  it('no-op when the spec has no fromVar', () => {
    const code = `<Header ${attr({ trigger: 'onScroll', from: 'default', canvasVariant: 'default' })} />`;
    expect(substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'desktop-scrolled' })).toBe(code);
  });

  it('no-op when fromVar is not among the route values', () => {
    const code = `<Header ${attr({ ...base, fromVar: 'otherVar' })} />`;
    expect(substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'desktop-scrolled' })).toBe(code);
  });

  it('empty route value keeps the spec own canvasVariant (page falls back to the effect default)', () => {
    const code = `<Header ${attr(base)} />`;
    expect(substituteScrollVariantFromVarForCanvas(code, { headerVariant: '' })).toBe(code);
  });

  it('rewrites ONLY the matching instance among several scroll variants', () => {
    const code = `<Header ${attr(base)} />\n<Nav ${attr({ trigger: 'onScroll', from: 'default', canvasVariant: 'open', fromVar: 'navVar' })} />`;
    const out = substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'desktop-scrolled' });
    const specs = readSpecs(out);
    expect(specs[0].canvasVariant).toBe('desktop-scrolled'); // header rewritten
    expect(specs[1].canvasVariant).toBe('open');             // nav untouched
  });

  it('leaves malformed scroll-variant JSON untouched', () => {
    const code = `<Header data-scroll-variant='{not valid json' />`;
    expect(substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'desktop-scrolled' })).toBe(code);
  });

  // ── PASS 2: per-viewport `responsive[scope].fromVar` → data-responsive initialVariant ──
  // A replica binds its own variable via `spec.responsive[scope].fromVar`; that variable's
  // per-page value bakes into data-responsive[<scope max-width>].initialVariant so the
  // replica tile resolves it. The two attrs are emitted adjacently on the tag.
  const PAIRED = (sv: any, resp: any) =>
    `<Header data-scroll-variant='${JSON.stringify(sv)}' initialVariant={HeaderSv} data-responsive='${JSON.stringify(resp)}' data-id="h" />`;
  const readResp = (code: string) => JSON.parse(code.match(/data-responsive='([^']*)'/)![1]);
  const TABLET_Q = '(max-width: 768px) and (min-width: 376px)';
  const MOBILE_Q = '(max-width: 375px)';
  // Base binds `headerVariant`; Tablet binds its OWN `headerVariantTablet`.
  const baseSv = {
    trigger: 'sectionInView', from: 'default', canvasVariant: 'default', fromVar: 'headerVariant',
    responsive: [{ scope: { query: TABLET_Q }, fromVar: 'headerVariantTablet' }],
  };
  const baseResp = { '375': { initialVariant: 'mobile' }, '768': { initialVariant: 'mobile' }, _bp: [375, 768, 1440] };

  it("resolves a replica's own fromVar variable into data-responsive[width].initialVariant", () => {
    const code = PAIRED(baseSv, baseResp);
    const out = substituteScrollVariantFromVarForCanvas(code, { headerVariant: 'default-scrolled', headerVariantTablet: 'mobile-scrolled' });
    const resp = readResp(out);
    expect(resp['768'].initialVariant).toBe('mobile-scrolled'); // tablet → its own variable's value (scope max-width 768)
    expect(resp['375'].initialVariant).toBe('mobile');          // mobile untouched (no per-viewport fromVar there)
    // PASS 1 still ran: primary canvasVariant baked from the BASE fromVar.
    const sv = JSON.parse(out.match(/data-scroll-variant='([^']*)'/)![1]);
    expect(sv.canvasVariant).toBe('default-scrolled');
  });

  it('resolves Tablet AND Mobile per-viewport fromVars independently', () => {
    const sv = {
      ...baseSv,
      responsive: [
        { scope: { query: TABLET_Q }, fromVar: 'headerVariantTablet' },
        { scope: { query: MOBILE_Q }, fromVar: 'headerVariantMobile' },
      ],
    };
    const out = substituteScrollVariantFromVarForCanvas(PAIRED(sv, baseResp), {
      headerVariant: 'default-scrolled', headerVariantTablet: 'mobile-scrolled', headerVariantMobile: 'mobile-open-scrolled',
    });
    const resp = readResp(out);
    expect(resp['768'].initialVariant).toBe('mobile-scrolled');
    expect(resp['375'].initialVariant).toBe('mobile-open-scrolled');
    expect(resp._bp).toEqual([375, 768, 1440]); // _bp preserved
  });

  it('leaves data-responsive untouched when the spec has NO per-viewport fromVar', () => {
    const sv = { trigger: 'sectionInView', from: 'default', canvasVariant: 'default', fromVar: 'headerVariant' };
    const out = substituteScrollVariantFromVarForCanvas(PAIRED(sv, baseResp), { headerVariant: 'default-scrolled' });
    expect(readResp(out)).toEqual(baseResp); // PASS 2 no-op
  });

  it('leaves the breakpoint untouched when the per-viewport fromVar has no route value', () => {
    const out = substituteScrollVariantFromVarForCanvas(PAIRED(baseSv, baseResp), { headerVariant: 'default-scrolled' });
    expect(readResp(out)['768'].initialVariant).toBe('mobile'); // headerVariantTablet unset → keep literal resting
  });
});
