import { describe, test, expect } from 'vitest';
import { parse } from '@babel/parser';
import { setTemplateRouteValueInCode, parseTemplateRouteMap, getTemplateRouteValues, removeTemplateVarFromCode, substituteTemplateVarAttrsForCanvas, getTemplateRouteValueForViewport, hasViewportOverride, viewportVarKey, splitViewportKey } from './template-route-gen';

const parses = (c: string) => { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; };

const LAYOUT = `'use client';

/** @propMeta {"content":{"type":"plainText","label":"Content"},"joijoijoi":{"type":"color"}} */

import React from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';

const MotionLink = motion.create(Link);
export default function LayoutClient({
  children, content = "Ready to change", joijoijoi = "#1e3c1b"
}: {children: React.ReactNode;}) {
  return <div data-id="root" style={{ backgroundColor: joijoijoi }}>
    <p>{content}</p>{children}
  </div>;
}`;

const VARS = ['content', 'joijoijoi'];

describe('template-route-gen — native per-page resolution', () => {
  const out = setTemplateRouteValueInCode(LAYOUT, '/', 'content', 'hhhiu', VARS);

  test('produces valid code', () => { expect(parses(out)).toBe(true); });

  test('stores a TRANSITION (object-JSON) value as a real OBJECT with numeric fields, not an escaped string', () => {
    // framer-motion silently ignores a STRING transition (every variant animates with the default) — the route
    // map must hold a real object with numeric physics fields so the runtime `v = __tp.v ?? v` + canvas attr
    // substitution pass an OBJECT to the component.
    const tx = setTemplateRouteValueInCode(LAYOUT, '/', 'joijoijoi', '{"type":"spring","stiffness":"300","damping":"77","mass":"1"}', VARS);
    expect(tx).toMatch(/"joijoijoi":\{"type":"spring","stiffness":300,"damping":77,"mass":1\}/);
    expect(tx).not.toContain('"joijoijoi":"{'); // NOT an escaped JSON string
    expect(parses(tx)).toBe(true);
    // canvas substitution then yields an object literal attr, not a quoted string
    const baked = substituteTemplateVarAttrsForCanvas('<Frame transition1={joijoijoi} />', getTemplateRouteValues(tx, '/'));
    expect(baked).toMatch(/transition1=\{\{"type":"spring","stiffness":300/);
    // a plain string value (color) still stores as a string
    const col = setTemplateRouteValueInCode(LAYOUT, '/', 'joijoijoi', '#53cf46', VARS);
    expect(col).toContain('"joijoijoi":"#53cf46"');
  });

  test('adds usePathname import', () => {
    expect(out).toMatch(/import\s*\{\s*usePathname\s*\}\s*from\s*'next\/navigation'/);
  });

  test('adds the route map const with the value', () => {
    expect(parseTemplateRouteMap(out)).toEqual({ '/': { content: 'hhhiu' } });
  });

  test('adds the resolution block (dynamic-aware matcher lookup + reassign per var) before return', () => {
    expect(out).toContain('const __tp = __matchTemplateRoute(usePathname());');
    expect(out).toContain('content = __tp.content ?? content;');
    expect(out).toContain('joijoijoi = __tp.joijoijoi ?? joijoijoi;');
    const blockIdx = out.indexOf('const __tp =');
    const retIdx = out.indexOf('return <div');
    expect(blockIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(retIdx); // block before return
  });

  test('emits the __matchTemplateRoute helper and matches DYNAMIC routes ([slug]) at runtime', () => {
    // The bug: usePathname() returns the resolved path (/blog/my-post), which never equals
    // the literal dynamic key (/blog/[slug]) — so a plain map lookup left detail pages on
    // their defaults. The matcher pattern-matches the dynamic key.
    let dyn = setTemplateRouteValueInCode(LAYOUT, '/blog', 'content', 'index', VARS);
    dyn = setTemplateRouteValueInCode(dyn, '/blog/[slug]', 'content', 'detail', VARS);
    expect(parses(dyn)).toBe(true);
    expect(dyn).toContain('const __matchTemplateRoute =');
    // Evaluate the emitted matcher against a real resolved pathname.
    const map = parseTemplateRouteMap(dyn);
    const body = dyn.match(/const __matchTemplateRoute = (\(__p\) => \{[\s\S]*?\n\});/)![1];
     
    const match = new Function('__templateProps', `return (${body});`)(map) as (p: string) => Record<string, string>;
    expect(match('/blog')).toEqual({ content: 'index' });                       // exact static wins
    expect(match('/blog/how-ai-rewrites-finance')).toEqual({ content: 'detail' }); // dynamic pattern match
    expect(match('/nope')).toEqual({});                                          // no match → empty
  });

  test('JSX usage of the vars is unchanged (still {content} / backgroundColor: joijoijoi)', () => {
    expect(out).toContain('<p>{content}</p>');
    expect(out).toContain('backgroundColor: joijoijoi');
    // params preserved (reader + defaults intact)
    expect(out).toContain('content = "Ready to change"');
  });

  test('setting a second var on the same route merges (no duplicate map/block)', () => {
    const out2 = setTemplateRouteValueInCode(out, '/', 'joijoijoi', '#39CB2B', VARS);
    expect(parses(out2)).toBe(true);
    expect(parseTemplateRouteMap(out2)).toEqual({ '/': { content: 'hhhiu', joijoijoi: '#39CB2B' } });
    expect((out2.match(/const __templateProps =/g) || []).length).toBe(1);
    expect((out2.match(/const __tp = __matchTemplateRoute/g) || []).length).toBe(1);
    expect((out2.match(/const __matchTemplateRoute =/g) || []).length).toBe(1);  // helper not duplicated
  });

  test('a second route is independent', () => {
    const out2 = setTemplateRouteValueInCode(out, '/about', 'content', 'About us', VARS);
    expect(getTemplateRouteValues(out2, '/')).toEqual({ content: 'hhhiu' });
    expect(getTemplateRouteValues(out2, '/about')).toEqual({ content: 'About us' });
  });

  test('values with commas/quotes (colors, gradients) round-trip via JSON', () => {
    const out2 = setTemplateRouteValueInCode(LAYOUT, '/', 'joijoijoi', 'linear-gradient(90deg, #000, #fff)', VARS);
    expect(parses(out2)).toBe(true);
    expect(getTemplateRouteValues(out2, '/').joijoijoi).toBe('linear-gradient(90deg, #000, #fff)');
  });

  test('clearing a value removes it; clearing the last removes the route', () => {
    const out2 = setTemplateRouteValueInCode(out, '/', 'content', '', VARS);
    expect(parseTemplateRouteMap(out2)).toEqual({});
  });

  describe('removeTemplateVarFromCode', () => {
    test('drops the var from every route, collapsing emptied routes', () => {
      let c = setTemplateRouteValueInCode(LAYOUT, '/', 'content', 'home', VARS);
      c = setTemplateRouteValueInCode(c, '/', 'joijoijoi', '#111', VARS);
      c = setTemplateRouteValueInCode(c, '/about', 'content', 'about', VARS);
      const out2 = removeTemplateVarFromCode(c, 'content');
      // '/' keeps joijoijoi; '/about' had only content → route removed entirely.
      expect(parseTemplateRouteMap(out2)).toEqual({ '/': { joijoijoi: '#111' } });
      expect(parses(out2)).toBe(true);
    });

    test('removing the only var collapses the map to {}', () => {
      const c = setTemplateRouteValueInCode(LAYOUT, '/', 'content', 'home', VARS);
      const out2 = removeTemplateVarFromCode(c, 'content');
      expect(parseTemplateRouteMap(out2)).toEqual({});
      expect(parses(out2)).toBe(true);
    });

    test('no-op when the var is absent or there is no map', () => {
      expect(removeTemplateVarFromCode(LAYOUT, 'content')).toBe(LAYOUT); // no map at all
      const c = setTemplateRouteValueInCode(LAYOUT, '/', 'content', 'home', VARS);
      expect(removeTemplateVarFromCode(c, 'joijoijoi')).toBe(c);        // var not in map
    });
  });

  describe('substituteTemplateVarAttrsForCanvas', () => {
    test('bakes a template var passed into a component-instance prop', () => {
      const src = `<Frame color={myVar} other="x" />`;
      const out = substituteTemplateVarAttrsForCanvas(src, { myVar: '#3a89c6' });
      expect(out).toContain('color={"#3a89c6"}');
      expect(out).not.toContain('color={myVar}');
    });

    test('does NOT touch the param declaration, the __templateProps map, the usePathname reassignment, direct styles, or text', () => {
      const src = [
        'function LayoutClient({ myVar = "#fff" }) {',
        '  const __templateProps = {"/":{"myVar":"#3a89c6"}};',
        '  myVar = __tp.myVar ?? myVar;',
        '  return <div style={{ backgroundColor: myVar }}>{myVar}<Frame c={myVar}/></div>;',
        '}',
      ].join('\n');
      const out = substituteTemplateVarAttrsForCanvas(src, { myVar: '#3a89c6' });
      expect(out).toContain('myVar = "#fff"');                    // param decl untouched
      expect(out).toContain('"myVar":"#3a89c6"');                 // map untouched
      expect(out).toContain('myVar = __tp.myVar ?? myVar;');      // reassignment untouched
      expect(out).toContain('backgroundColor: myVar');            // direct style untouched (handled elsewhere)
      expect(out).toContain('>{myVar}<');                          // text untouched (handled elsewhere)
      expect(out).toContain('c={"#3a89c6"}');                     // ONLY the component-instance attr baked
    });

    test('no-op for empty route values', () => {
      const src = `<Frame color={myVar} />`;
      expect(substituteTemplateVarAttrsForCanvas(src, {})).toBe(src);
    });
  });
});

describe('template-route-gen — PER-VIEWPORT (responsive) template variables', () => {
  test('key helpers split + build @<width> keys', () => {
    expect(splitViewportKey('headerVariant')).toEqual({ base: 'headerVariant', width: null });
    expect(splitViewportKey('headerVariant@768')).toEqual({ base: 'headerVariant', width: 768 });
    expect(viewportVarKey('headerVariant', null)).toBe('headerVariant');
    expect(viewportVarKey('headerVariant', 768)).toBe('headerVariant@768');
  });

  test('a base value still generates a plain reassignment (no gates)', () => {
    const out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    expect(out).toContain('content = __tp.content ?? content;');
    expect(out).not.toContain('useMediaQuery');
    expect(parses(out)).toBe(true);
  });

  test('a per-viewport override generates a __mq-gated reassignment + injects useMediaQuery', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);            // base
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS); // tablet override
    // Map carries both the base and the @768 key.
    expect(parseTemplateRouteMap(out)['/advisors']).toEqual({ content: 'desk', 'content@768': 'tab' });
    // Gated reassignment references __mq + the @768 key, falling through to base.
    expect(out).toMatch(/content = \(__mq\d+ \? __tp\['content@768'\] : undefined\) \?\? __tp\.content \?\? content;/);
    expect(out).toContain("useMediaQuery('(max-width: 768px)')");
    // The OTHER var stays plain.
    expect(out).toContain('joijoijoi = __tp.joijoijoi ?? joijoijoi;');
    expect(parses(out)).toBe(true);
  });

  test('mobile + tablet overrides → smallest-width-first ternary (mobile checked before tablet)', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 375), 'mob', VARS);
    // Order: the 375 gate must appear before the 768 gate in the ternary.
    const m = out.match(/content = \((.+?)\) \?\? __tp\.content/);
    expect(m).toBeTruthy();
    const ternary = m![1];
    expect(ternary.indexOf("content@375")).toBeLessThan(ternary.indexOf("content@768"));
    expect(parses(out)).toBe(true);
  });

  test('resetting a per-viewport override reverts to a plain reassignment + sweeps the orphan gate', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS);
    expect(out).toContain('useMediaQuery');
    // Reset: empty value clears the @768 key.
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), '', VARS);
    expect(parseTemplateRouteMap(out)['/advisors']).toEqual({ content: 'desk' });
    expect(out).toContain('content = __tp.content ?? content;');     // back to plain
    expect(out).not.toContain('content@768');
    // The __mq GATE const is swept (its only consumer is gone). The shared
    // useMediaQuery hook DEFINITION may remain — it's an unused helper, harmless
    // and reusable — so assert specifically on the gate declaration.
    expect(out).not.toMatch(/const __mq\d+ = useMediaQuery/);
    expect(parses(out)).toBe(true);
  });

  test('getTemplateRouteValueForViewport resolves override → base → empty', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS);
    expect(getTemplateRouteValueForViewport(out, '/advisors', 'content', null)).toBe('desk');  // primary → base
    expect(getTemplateRouteValueForViewport(out, '/advisors', 'content', 768)).toBe('tab');     // tablet → override
    expect(getTemplateRouteValueForViewport(out, '/advisors', 'content', 375)).toBe('desk');    // mobile → falls to base
  });

  test('hasViewportOverride is true only where an explicit override exists', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS);
    expect(hasViewportOverride(out, '/advisors', 'content', null)).toBe(false);  // primary never "overridden"
    expect(hasViewportOverride(out, '/advisors', 'content', 768)).toBe(true);
    expect(hasViewportOverride(out, '/advisors', 'content', 375)).toBe(false);
  });

  test('deleting the variable strips base AND per-viewport keys', () => {
    let out = setTemplateRouteValueInCode(LAYOUT, '/advisors', 'content', 'desk', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 768), 'tab', VARS);
    out = setTemplateRouteValueInCode(out, '/advisors', viewportVarKey('content', 375), 'mob', VARS);
    out = removeTemplateVarFromCode(out, 'content');
    const entry = parseTemplateRouteMap(out)['/advisors'] ?? {};
    expect(Object.keys(entry).some(k => splitViewportKey(k).base === 'content')).toBe(false);
  });
});
