import { describe, it, expect } from 'vitest';
import {
  setResponsiveInstancePropVarInCode,
  resetResponsiveInstancePropVarInCode,
  getResponsiveInstancePropVarAtViewport,
  getResponsiveInstancePropValueAtViewport,
  getInstancePropBaseValue,
  setInstancePropBaseInCode,
  setLocaleInstancePropInCode,
  setBoolNavCondForViewport,
  setBoolNavCondBase,
  getBoolNavCondBase,
  getBoolNavCondAtViewport,
  resetBoolNavCondForViewport,
} from './responsive-instance-prop-vars-gen';
import { parseJSXToNodes } from '../parsing/parser';
import { setResponsiveOverride, getResponsiveOverridesAtViewport } from '../components/instance-prop-overrides';

const Q768 = '(max-width: 768px) and (min-width: 376px)';

const base = `'use client';
function LayoutClient({ direction5hoisted = "column", direction2hoisted = "row" }) {
  return <div><YuKuZa data-id="frame-1" data-name="Frame" direction={direction5hoisted} /></div>;
}`;

describe('per-viewport instance-prop variable (inline __mq ternary on the attr)', () => {
  it('binds a variable at the tablet band, KEEPS the base (no clobber)', () => {
    const out = setResponsiveInstancePropVarInCode(base, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    expect(out).toMatch(/direction=\{\(__mq\d+ \? direction2hoisted : direction5hoisted\)\}/);
    expect(out).toContain(`useMediaQuery('${Q768}')`);
  });

  it('read: the variable surfaces at the tablet width, NOT at desktop', () => {
    const out = setResponsiveInstancePropVarInCode(base, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    expect(getResponsiveInstancePropVarAtViewport(out, 'frame-1', 'YuKuZa', 768).get('direction')).toBe('direction2hoisted');
    expect(getResponsiveInstancePropVarAtViewport(out, 'frame-1', 'YuKuZa', 1440).get('direction')).toBeUndefined();
  });

  it('X on a per-viewport VARIANT variable → base var kept + tablet gets a per-viewport LITERAL (plain select, not the base var)', () => {
    // Tablet has its OWN variant variable; base is ALSO a variable. The X must drop the tablet branch AND
    // leave a per-viewport literal so the replica shows a SELECT — never inheriting the base variable.
    const layout = `'use client';
function LayoutClient({ startTrialButtonVariant = "default", startTrialButtonVariant1 = "default" }) {
  return <div><StartTrialButton data-id="btn" data-name="Start Trial Button" initialVariant={(__mq2 ? startTrialButtonVariant1 : startTrialButtonVariant)} /></div>;
}`;
    // 1) drop the tablet variable branch → base variable kept
    let c = resetResponsiveInstancePropVarInCode(layout, 'btn', 'StartTrialButton', Q768, 'initialVariant');
    expect(c).toMatch(/initialVariant=\{startTrialButtonVariant\}/); // base var binding remains
    expect(getResponsiveInstancePropVarAtViewport(c, 'btn', 'StartTrialButton', 768).get('initialVariant')).toBeUndefined();
    // 2) tablet gets a per-viewport LITERAL (the unbound variable's resolved value) via data-responsive
    c = setResponsiveOverride(c, 'btn', 'StartTrialButton', 768, 'initialVariant', 'variant-2', null);
    expect(getResponsiveOverridesAtViewport(c, 'btn', 'StartTrialButton', 768).get('initialVariant')).toBe('variant-2');
    // the base (desktop) is untouched — still the variable, NOT a literal
    expect(c).toMatch(/initialVariant=\{startTrialButtonVariant\}/);
  });

  it('reset: drops the branch, reverts to the base, sweeps the orphan gate', () => {
    // No @pageVariables in `base` → the removed branch var isn't a known page variable → defensive drop
    // (revert to base). The REAL case (var IS in @pageVariables) bakes a literal — covered below.
    let out = setResponsiveInstancePropVarInCode(base, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    out = resetResponsiveInstancePropVarInCode(out, 'frame-1', 'YuKuZa', Q768, 'direction');
    expect(out).toMatch(/direction=\{direction5hoisted\}/);
    expect(out).not.toContain('__mq');
  });

  it('reset WITH @pageVariables → inline reverts to base + removed value re-added as a per-viewport DATA-RESPONSIVE literal (NOT the primary var)', () => {
    const layout = `'use client';
/** @pageVariables { "variables": [ { "name":"direction5hoisted","type":"text","default":"column" }, { "name":"direction2hoisted","type":"text","default":"row" } ] } */
function LayoutClient({ direction5hoisted = "column", direction2hoisted = "row" }) {
  return <div><YuKuZa data-id="frame-1" data-name="Frame" direction={direction5hoisted} /></div>;
}`;
    let out = setResponsiveInstancePropVarInCode(layout, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    out = resetResponsiveInstancePropVarInCode(out, 'frame-1', 'YuKuZa', Q768, 'direction');
    // Inline attr reverts to the base var; the removed value lives as a per-viewport data-responsive literal.
    expect(out).toMatch(/direction=\{direction5hoisted\}/);
    expect(out).toContain('data-responsive');
    // The variable PILL is gone on tablet; the panel reads the data-responsive LITERAL "row" (→ propOverridden).
    expect(getResponsiveInstancePropVarAtViewport(out, 'frame-1', 'YuKuZa', 768).get('direction')).toBeUndefined();
    expect(getResponsiveOverridesAtViewport(out, 'frame-1', 'YuKuZa', 768).get('direction')).toBe('row');
    // The literal lives in `data-responsive` — the SAME per-viewport-override field the Renderer + panel
    // both read for every instance-prop override; the base/primary var ref is unchanged.
    const node = parseJSXToNodes(out, { direction5hoisted: 'column' }).get('frame-1')!;
    expect(node.attrs?.['data-responsive']).toContain('"direction":"row"');
    expect(node.attrPropRefs?.direction).toBe('direction5hoisted');
  });

  it('reset a BOOLEAN per-viewport var → data-responsive literal coerced to a RAW boolean (true, not "true")', () => {
    const layout = `'use client';
/** @pageVariables { "variables": [ { "name":"hidehoist","type":"boolean","default":"false" }, { "name":"hide12","type":"boolean","default":"true" } ] } */
function LayoutClient({ hidehoist = false, hide12 = true }) {
  return <div><KuWoCo data-id="k" data-name="Frame" hide={hidehoist} /></div>;
}`;
    let out = setResponsiveInstancePropVarInCode(layout, 'k', 'KuWoCo', Q768, 'hide', 'hide12');
    out = resetResponsiveInstancePropVarInCode(out, 'k', 'KuWoCo', Q768, 'hide');
    expect(out).toMatch(/hide=\{hidehoist\}/);             // inline reverts to base
    expect(out).toMatch(/"hide":\s*true/);                 // data-responsive literal coerced to a raw boolean
  });

  it('absent base → ternary else is `undefined`; reset removes the attr', () => {
    const noAttr = `function C(){ return <YuKuZa data-id="f2" data-name="Frame" />; }`;
    let out = setResponsiveInstancePropVarInCode(noAttr, 'f2', 'YuKuZa', Q768, 'direction', 'dv');
    expect(out).toMatch(/direction=\{\(__mq\d+ \? dv : undefined\)\}/);
    out = resetResponsiveInstancePropVarInCode(out, 'f2', 'YuKuZa', Q768, 'direction');
    expect(out).not.toMatch(/(?<![\w-])direction=/);
  });

  it('PARSE round-trip: parser reads the per-viewport var + resolves its value, base preserved', () => {
    const written = setResponsiveInstancePropVarInCode(base, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    const nodes = parseJSXToNodes(written, { direction5hoisted: 'column', direction2hoisted: 'row' });
    const node = nodes.get('frame-1')!;
    expect(node.responsiveAttrPropVariables?.direction?.[768]).toBe('direction2hoisted'); // var (pill)
    expect(node.responsiveAttrPropValues?.direction?.[768]).toBe('row');                  // resolved (canvas)
    expect(node.responsiveAttrPropBands?.direction?.[768]).toBe(376);                      // banded floor
    expect(node.attrPropRefs?.direction).toBe('direction5hoisted');                        // base intact
  });

  it('VARIANT (initialVariant) per-viewport: ternary written + parsed, primary base kept', () => {
    const vbase = `function L({ startTrialButtonVariant = "default" }) {
      return <div><StartTrialButton data-id="btn-1" data-name="Start Trial Button" initialVariant={startTrialButtonVariant} /></div>;
    }`;
    const out = setResponsiveInstancePropVarInCode(vbase, 'btn-1', 'StartTrialButton', Q768, 'initialVariant', 'stbVariant1');
    expect(out).toMatch(/initialVariant=\{\(__mq\d+ \? stbVariant1 : startTrialButtonVariant\)\}/);
    const node = parseJSXToNodes(out, { startTrialButtonVariant: 'default', stbVariant1: 'hover' }).get('btn-1')!;
    expect(node.responsiveAttrPropVariables?.initialVariant?.[768]).toBe('stbVariant1');
    expect(node.responsiveAttrPropValues?.initialVariant?.[768]).toBe('hover'); // expandComponent → responsiveVariantMap[768]
    expect(node.attrPropRefs?.initialVariant).toBe('startTrialButtonVariant'); // primary base UNCHANGED
  });

  it('a SECOND viewport override on the same prop CHAINS (does not clobber the first)', () => {
    const Q375 = '(max-width: 375px)';
    let out = setResponsiveInstancePropVarInCode(base, 'frame-1', 'YuKuZa', Q768, 'direction', 'direction2hoisted');
    out = setResponsiveInstancePropVarInCode(out, 'frame-1', 'YuKuZa', Q375, 'direction', 'mobileDir');
    // both branches present, base intact
    expect(out).toContain('direction2hoisted');
    expect(out).toContain('mobileDir');
    expect(out).toContain('direction5hoisted');
    expect(getResponsiveInstancePropVarAtViewport(out, 'frame-1', 'YuKuZa', 768).get('direction')).toBe('direction2hoisted');
    expect(getResponsiveInstancePropVarAtViewport(out, 'frame-1', 'YuKuZa', 375).get('direction')).toBe('mobileDir');
  });

  it('LITERAL variant ternary reset (deleted variant var → inlined to a literal) reverts to the base', () => {
    // After a per-viewport variant VARIABLE is deleted it inlines to a LITERAL ternary; Reset Override on the
    // replica drops the branch → reverts the prop to the base variant ("default"), no data-responsive baked.
    const code = `function L(){ return <div><StartTrialButton initialVariant={__mq2 ? "variant-3" : "default"} data-id="b" data-name="Btn" /></div>; }`;
    const out = resetResponsiveInstancePropVarInCode(code, 'b', 'StartTrialButton', Q768, 'initialVariant');
    expect(out).toMatch(/initialVariant=\{"default"\}/);
    expect(out).not.toContain('__mq2 ?');
  });

  it('per-viewport on a LINK href attr (write + read + reset to base) — the per-replica link variable rail', () => {
    const base = `function L({ baseHref = "/a", tabHref = "/b" }){
      return <div><MotionLink href={baseHref} data-id="lnk" data-name="Link" /></div>;
    }`;
    let out = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', 'tabHref');
    expect(out).toMatch(/href=\{\(__mq\d+ \? tabHref : baseHref\)\}/);   // per-tile var, primary kept
    expect(getResponsiveInstancePropVarAtViewport(out, 'lnk', 'MotionLink', 768).get('href')).toBe('tabHref');
    out = resetResponsiveInstancePropVarInCode(out, 'lnk', 'MotionLink', Q768, 'href');
    expect(out).toMatch(/href=\{baseHref\}/);                            // reverts to the base href
    expect(getResponsiveInstancePropVarAtViewport(out, 'lnk', 'MotionLink', 768).get('href')).toBeUndefined();
  });

  it('per-viewport LITERAL branch (X a base href var on a replica → unbind THIS tile, keep the primary var)', () => {
    const base = `function L({ linkHref = "/about" }){ return <div><MotionLink href={linkHref} data-id="lnk" data-name="Link" /></div>; }`;
    // Passing the variable's VALUE as a quoted literal writes a per-tile literal branch; the primary keeps the var.
    const out = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', JSON.stringify('/about'));
    expect(out).toMatch(/href=\{\(__mq\d+ \? "\/about" : linkHref\)\}/);
  });

  it('getResponsiveInstancePropValueAtViewport distinguishes a per-tile LITERAL branch from a VARIABLE branch', () => {
    // After X-ing a base var on a replica the tile holds a literal — the panel must render it as a normal
    // input (override), NOT mistake the `__mq` gate for a variable. Build via the real writer (adds the gate).
    const base = `function L({ linkHref = "/a", tab = "/b" }){ return <div><MotionLink href={linkHref} data-id="lnk" data-name="Link" /></div>; }`;
    const lit = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', JSON.stringify(''));
    expect(getResponsiveInstancePropValueAtViewport(lit, 'lnk', 'MotionLink', 768).get('href')).toEqual({ value: '', isVar: false });
    const varc = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', 'tab');
    expect(getResponsiveInstancePropValueAtViewport(varc, 'lnk', 'MotionLink', 768).get('href')).toEqual({ value: 'tab', isVar: true });
  });

  it('getInstancePropBaseValue returns the BASE (else-branch) of a ternary — so the PRIMARY keeps its var', () => {
    // The parser reports the `__mq` gate for a ternary href, hiding the base; this recovers it for the primary.
    const base = `function L({ linkHref = "/a", tab = "/b" }){ return <div><MotionLink href={linkHref} data-id="lnk" data-name="Link" /></div>; }`;
    const v = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', 'tab');
    expect(getInstancePropBaseValue(v, 'lnk', 'MotionLink', 'href')).toEqual({ value: 'linkHref', isVar: true });
    expect(getInstancePropBaseValue(base, 'lnk', 'MotionLink', 'href')).toBeNull(); // not gated → caller uses node value
  });

  it('setInstancePropBaseInCode clears ONLY the base — per-viewport branches (individual replicas) stay intact', () => {
    // Remove from PRIMARY when tablet has its own value: base → "", tablet branch kept (the user-reported bug
    // where removing from primary wiped the replicas' individual link configs).
    const base = `function L({ linkHref1 = "/a", linkHref2 = "/b" }){ return <div><MotionLink href={linkHref2} data-id="lnk" data-name="Link" /></div>; }`;
    const ternary = setResponsiveInstancePropVarInCode(base, 'lnk', 'MotionLink', Q768, 'href', 'linkHref1');
    const out = setInstancePropBaseInCode(ternary, 'lnk', 'MotionLink', 'href', '""');
    expect(getResponsiveInstancePropVarAtViewport(out, 'lnk', 'MotionLink', 768).get('href')).toBe('linkHref1'); // tablet kept
    expect(getInstancePropBaseValue(out, 'lnk', 'MotionLink', 'href')).toEqual({ value: '', isVar: false });   // base cleared
    // No per-viewport branches → no-op (caller removes the whole binding instead).
    expect(setInstancePropBaseInCode(base, 'lnk', 'MotionLink', 'href', '""')).toBe(base);
  });

  it('setInstancePropBaseInCode on a LOCALE-scoped prop: base (Fallback) rewrite keeps every locale branch', () => {
    // The popup's editable Fallback commits through this path — editing the
    // default-locale value must never drop the fr/it branches.
    const base = `function L(){ return <div><Hero justify="flex-start" data-id="h" data-name="Hero" /></div>; }`;
    const fr = setLocaleInstancePropInCode(base, 'h', 'Hero', 'justify', 'fr', 'flex-end');
    const out = setInstancePropBaseInCode(fr, 'h', 'Hero', 'justify', JSON.stringify('center'));
    expect(out).toContain(`__activeLocale === 'fr' ? "flex-end"`);
    expect(out).toContain('"center"');
    expect(out).not.toContain('"flex-start"');
  });

  it('per-viewport New Tab (target attr): Yes/No per tile; `undefined` No-state reads as empty, not a variable', () => {
    // No on the tablet ("" literal), Yes on the base ("_blank")
    const yesBase = `function L(){ return <div><MotionLink href="/a" target="_blank" data-id="c" data-name="L" /></div>; }`;
    const out = setResponsiveInstancePropVarInCode(yesBase, 'c', 'MotionLink', Q768, 'target', '""');
    expect(getResponsiveInstancePropValueAtViewport(out, 'c', 'MotionLink', 768).get('target')).toEqual({ value: '', isVar: false });
    expect(getInstancePropBaseValue(out, 'c', 'MotionLink', 'target')).toEqual({ value: '_blank', isVar: false });
    // Absent base → setResponsiveInstancePropVar writes `undefined` as the base; it must read as empty, NOT a var.
    const absent = `function L(){ return <div><MotionLink href="/a" data-id="c" data-name="L" /></div>; }`;
    const out2 = setResponsiveInstancePropVarInCode(absent, 'c', 'MotionLink', Q768, 'target', '"_blank"');
    expect(getInstancePropBaseValue(out2, 'c', 'MotionLink', 'target')).toEqual({ value: '', isVar: false });
  });

  // ── Boolean nav attrs (New Tab `target`) — per-viewport on the INNER condition ──
  // The boolean's value lives in `<cond> ? "_blank" : undefined`; the simple-scalar rail mis-reads that `? :`,
  // so the condition itself is made per-viewport. These cover the user-reported bugs (remove/add on a replica
  // hit every viewport; remove from primary wiped the replicas).
  const bnTag = (t: string) => `function L({openInNewTab2=false,nt=false}){ return <div><MotionLink href="/a" ${t} data-id="c" data-name="L" /></div>; }`;
  it('boolean nav: No-on-tablet keeps the base VARIABLE; reset reverts', () => {
    const out = setBoolNavCondForViewport(bnTag(`target={openInNewTab2 ? "_blank" : undefined}`), 'c', 'MotionLink', Q768, 'target', 'false');
    expect(out).toMatch(/target=\{\(__mq\d+ \? false : openInNewTab2\) \? "_blank" : undefined\}/);
    expect(getBoolNavCondBase(out, 'c', 'MotionLink', 'target')).toBe('openInNewTab2');
    expect(getBoolNavCondAtViewport(out, 'c', 'MotionLink', 'target', 768)).toBe('false');
    expect(resetBoolNavCondForViewport(out, 'c', 'MotionLink', Q768, 'target')).toMatch(/target=\{openInNewTab2 \? "_blank" : undefined\}/);
  });
  it('boolean nav: Yes-on-tablet from an absent base; desktop has no override', () => {
    const out = setBoolNavCondForViewport(bnTag(``), 'c', 'MotionLink', Q768, 'target', 'true');
    expect(getBoolNavCondAtViewport(out, 'c', 'MotionLink', 'target', 768)).toBe('true');
    expect(getBoolNavCondAtViewport(out, 'c', 'MotionLink', 'target', 1440)).toBe(null);
  });
  it('smooth scroll: onClick reads the RESOLVED data-smooth-scroll; per-viewport keeps the brace (no dup attr)', async () => {
    const { setSmoothScrollInCode, syncLinkHandlerInCode } = await import('./generator-styles');
    const base = `function L(){ return <div><MotionLink href="/a#sec" data-id="c" data-name="L" /></div>; }`;
    let out = syncLinkHandlerInCode(setSmoothScrollInCode(base, 'c', true), 'c');
    expect(out).toContain(`behavior: (e.currentTarget.dataset.smoothScroll === 'true') ? 'smooth' : 'auto'`);
    out = syncLinkHandlerInCode(setBoolNavCondForViewport(out, 'c', 'MotionLink', Q768, 'data-smooth-scroll', 'false'), 'c');
    expect(getBoolNavCondBase(out, 'c', 'MotionLink', 'data-smooth-scroll')).toBe('true');
    expect(getBoolNavCondAtViewport(out, 'c', 'MotionLink', 'data-smooth-scroll', 768)).toBe('false');
    expect((out.match(/data-smooth-scroll=/g) || []).length).toBe(1); // single attr, onClick still dataset-read
    expect(out).toContain(`dataset.smoothScroll === 'true'`);
  });
  it('boolean nav: bind a variable on a tablet (Yes string base kept); change-from-primary keeps branches', () => {
    const tablet = setBoolNavCondForViewport(bnTag(`target="_blank"`), 'c', 'MotionLink', Q768, 'target', 'nt');
    expect(getBoolNavCondBase(tablet, 'c', 'MotionLink', 'target')).toBe('true');
    expect(getBoolNavCondAtViewport(tablet, 'c', 'MotionLink', 'target', 768)).toBe('nt');
    const out = setBoolNavCondBase(tablet, 'c', 'MotionLink', 'target', 'false');
    expect(getBoolNavCondBase(out, 'c', 'MotionLink', 'target')).toBe('false');
    expect(getBoolNavCondAtViewport(out, 'c', 'MotionLink', 'target', 768)).toBe('nt'); // tablet kept
  });
});
