import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { ensureShapeChildIds, updateHtmlAttrsInCode, stripDataResponsiveInSubtree, changeTagInCode } from './generator-attrs';

const parses = (c: string) =>
  expect(() => transform(c, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
const wrap = (inner: string) =>
  `import React from 'react';\nexport default function P() {\n  return (<div data-id="root">${inner}</div>);\n}\n`;

describe('ensureShapeChildIds — make inner shapes addressable for per-tile geometry', () => {
  it('stamps a stable data-id on a single inner path', () => {
    const r = ensureShapeChildIds(wrap('<svg data-id="shape-1" viewBox="0 0 10 10"><path d="M0,0 L10,10 Z" /></svg>'), 'shape-1');
    expect(r.ids).toEqual(['shape-1-g0']);
    expect(r.code).toContain('data-id="shape-1-g0"');
    expect(r.code).toContain('d="M0,0 L10,10 Z"');
    parses(r.code);
  });

  it('converts composite polygons (nested svgs) to data-id\'d paths, preserving attrs', () => {
    const r = ensureShapeChildIds(
      wrap('<svg data-id="vec-1"><svg data-id="shape-a"><polygon points="0,0 10,0 5,10" fill="#3b82f6" /></svg><svg data-id="shape-b"><polygon points="1,1 2,2 0,2" /></svg></svg>'),
      'vec-1',
    );
    expect(r.ids).toEqual(['vec-1-g0', 'vec-1-g1']);
    expect(r.code).toContain('d="M0,0 L10,0 L5,10 Z"');
    expect(r.code).not.toContain('<polygon');
    expect(r.code).toContain('fill="#3b82f6"');
    parses(r.code);
  });

  it('is idempotent (keeps existing ids, no re-stamp, no churn)', () => {
    const r1 = ensureShapeChildIds(wrap('<svg data-id="s"><path d="M0,0 Z" /></svg>'), 's');
    const r2 = ensureShapeChildIds(r1.code, 's');
    expect(r2.ids).toEqual(['s-g0']);
    expect(r2.code).toBe(r1.code);
  });

  it('no-op (no geometry children) returns the code unchanged', () => {
    const src = wrap('<div data-id="x">hi</div>');
    expect(ensureShapeChildIds(src, 'x').code).toBe(src);
  });
});

describe('updateHtmlAttrsInCode — single-quoted (JSON) attrs', () => {
  // Regression: a JSON attr (data-overlay-trigger) is emitted SINGLE-quoted. The
  // old double-quote-only match missed it and APPENDED a second, double-quoted
  // copy — `key="{"targetId":…}"` — invalid JSX that crashed the page on paste.
  const code = `function P() {
  return <div data-id="t" data-overlay-trigger='{"targetId":"old","trigger":"click"}' style={{ left: '0px' }}></div>;
}`;

  it('REPLACES a single-quoted JSON attr in place (no duplicate, valid JSX)', () => {
    const next = JSON.stringify({ targetId: 'new', trigger: 'click' });
    const out = updateHtmlAttrsInCode(code, 't', { 'data-overlay-trigger': next });
    expect(() => transform(out, { presets: ['react'] })).not.toThrow();
    expect((out.match(/data-overlay-trigger=/g) || []).length).toBe(1); // not duplicated
    expect(out).toContain(`data-overlay-trigger='${next}'`);            // single-quoted
    expect(out).not.toContain('"targetId":"old"');                      // old value gone
  });

  it('values containing double quotes are written single-quoted', () => {
    const out = updateHtmlAttrsInCode(code, 't', { 'data-x': '{"a":1}' });
    expect(() => transform(out, { presets: ['react'] })).not.toThrow();
    expect(out).toContain(`data-x='{"a":1}'`);
  });

  it('removes a single-quoted attr', () => {
    const out = updateHtmlAttrsInCode(code, 't', { 'data-overlay-trigger': '' });
    expect(out).not.toContain('data-overlay-trigger');
  });
});

// ─── stripDataResponsiveInSubtree — exit-to-canvas sheds breakpoint overrides ─
// `data-responsive` keys instance-prop overrides to the SOURCE page's viewport
// widths. A canvas node has no viewports, and re-entering a page with a
// different breakpoint set applies stale widths' overrides (user report
// 2026-07-27) — every drop-to-canvas strips it, subtree-wide.
describe('stripDataResponsiveInSubtree', () => {
  const RESP = `data-responsive='{"375":{"initialVariant":"variant-2"},"768":{"initialVariant":"variant-1"},"_bp":[375,768,1440]}'`;

  it('strips the attribute off a self-closing instance', () => {
    const code = `<div data-id="root"><KaPoJo ${RESP} data-id="KaPoJo-1" data-name="KaPoJo" style={{ width: '100%' }} /></div>`;
    const out = stripDataResponsiveInSubtree(code, 'KaPoJo-1');
    expect(out).not.toContain('data-responsive');
    expect(out).toContain('data-id="KaPoJo-1" data-name="KaPoJo"');
    expect(out).toContain("width: '100%'");
  });

  it('strips DESCENDANT instances when a whole section exits to canvas', () => {
    const code = `<div data-id="root">
      <div data-id="section-1" data-name="Section" style={{ display: 'flex' }}>
        <KaFiBi ${RESP} data-id="KaFiBi-2" data-name="Header"></KaFiBi>
        <KaPoJo data-responsive='{"768":{"initialVariant":"v1"},"_bp":[768,1440]}' data-id="KaPoJo-3" data-name="Footer"></KaPoJo>
      </div>
      <KaMuTa ${RESP} data-id="KaMuTa-4" data-name="Outside"></KaMuTa>
    </div>`;
    const out = stripDataResponsiveInSubtree(code, 'section-1');
    // Both nested instances stripped…
    expect(out.match(/data-responsive/g)?.length).toBe(1);
    // …while the sibling OUTSIDE the subtree keeps its overrides.
    const outside = out.slice(out.indexOf('KaMuTa-4') - 200, out.indexOf('KaMuTa-4'));
    expect(outside).toContain('data-responsive');
  });

  it('double-quoted variant is stripped too, and no-op input returns identical code', () => {
    const dq = `<div data-id="root"><KaPoJo data-responsive="simple" data-id="k-1"></KaPoJo></div>`;
    expect(stripDataResponsiveInSubtree(dq, 'k-1')).not.toContain('data-responsive');
    const clean = `<div data-id="root"><KaPoJo data-id="k-1"></KaPoJo></div>`;
    expect(stripDataResponsiveInSubtree(clean, 'k-1')).toBe(clean);
  });
});

// ─── changeTag keeps the motion wrapper ─────────────────────────────────────
//
// `motion.div` is ONE tag token, so renaming it replaced the whole thing and
// the element silently stopped being a motion component while keeping every
// motion prop. A component root retagged to `nav` for semantics stopped
// FLIP-animating — no warning, and the canvas (static, no motion) looked
// identical (user report 2026-08-08).

describe('changeTagInCode — motion prefix', () => {
  const root = (tag: string) =>
    `const C = () => <${tag} layout={true} data-id="n1" variants={v} animate={['default', variant]}>x</${tag}>;`;

  it('keeps the wrapper when giving a motion element a semantic tag', () => {
    const out = changeTagInCode(root('motion.div'), 'n1', 'nav');
    expect(out).toContain('<motion.nav');
    expect(out).toContain('</motion.nav>');
    expect(out).not.toMatch(/<nav\b/);
  });

  it('retags a plain element without adding a wrapper it never had', () => {
    const out = changeTagInCode(`const C = () => <div data-id="n1">x</div>;`, 'n1', 'section');
    expect(out).toContain('<section');
    expect(out).toContain('</section>');
    expect(out).not.toContain('motion.');
  });

  it('never produces motion.<Uppercase> — the proxy knows HTML tags only', () => {
    const out = changeTagInCode(root('motion.div'), 'n1', 'Link');
    expect(out).toContain('<Link');
    expect(out).not.toContain('motion.Link');
  });

  it('does not double a prefix the caller already supplied', () => {
    // LinkTool's revert passes `motion.div` outright for a MotionLink.
    const out = changeTagInCode(`const C = () => <MotionLink data-id="n1">x</MotionLink>;`, 'n1', 'motion.div');
    expect(out).toContain('<motion.div');
    expect(out).not.toContain('motion.motion.');
  });

  it('is a no-op when the semantic tag would resolve to what it already is', () => {
    const code = root('motion.div');
    expect(changeTagInCode(code, 'n1', 'div')).toBe(code);
  });
});
