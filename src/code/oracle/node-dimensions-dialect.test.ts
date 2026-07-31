import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { ensureNodeDimensions } from './check-file';

const PAGE = (body: string) => `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React from 'react';

export default function Page() {
  return (
<div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
${body}
</div>
  );
}`;

// The gate runs ensureNodeDimensions before checkFile so EVERY committed normal node
// carries an explicit width + height (an omitted dimension IS auto, but the editor falls
// back to auto WITHOUT writing it → sizeless source → make-component / resize break).
describe('ensureNodeDimensions — inject explicit width/height where missing', () => {
  it("injects width AND height: 'auto' into a sizeless node", () => {
    const out = ensureNodeDimensions(PAGE(`  <div data-id="box" data-name="Box" style={{ position: 'relative' }}>x</div>`));
    expect(out).toContain("width: 'auto'");
    expect(out).toContain("height: 'auto'");
    // existing props preserved
    expect(out).toContain("position: 'relative'");
  });

  it('injects ONLY the missing dimension (keeps the present one)', () => {
    const out = ensureNodeDimensions(PAGE(`  <div data-id="box" data-name="Box" style={{ position: 'relative', height: '50px' }}>x</div>`));
    expect(out).toContain("width: 'auto'");
    expect(out).toContain("height: '50px'");
    expect(out).not.toContain("height: 'auto'");
  });

  it('handles motion.* tags', () => {
    const out = ensureNodeDimensions(PAGE(`  <motion.div data-id="box" data-name="Box" style={{ position: 'relative' }}>x</motion.div>`));
    expect(out).toContain("width: 'auto'");
    expect(out).toContain("height: 'auto'");
  });

  it('is idempotent — a node that already has both is untouched, and re-running is stable', () => {
    const code = PAGE(`  <div data-id="box" data-name="Box" style={{ position: 'relative', width: '100px', height: '50px' }}>x</div>`);
    expect(ensureNodeDimensions(code)).toBe(code);
    // sizeless → inject once → second pass is a no-op
    const once = ensureNodeDimensions(PAGE(`  <div data-id="box" data-name="Box" style={{ position: 'relative' }}>x</div>`));
    expect(ensureNodeDimensions(once)).toBe(once);
  });

  it('does NOT touch the page root (the artboard: width 100% / auto height)', () => {
    // root has no height, but is exempt
    const code = PAGE(`  <div data-id="box" data-name="Box" style={{ position: 'relative', width: '1px', height: '1px' }} />`);
    const out = ensureNodeDimensions(code);
    // root style stays exactly as-is (no height injected on root)
    expect(out).toContain(`data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}`);
  });

  it('does NOT touch design-component instances (PascalCase)', () => {
    const code = PAGE(`  <CompanyMarquee data-id="mq" data-name="Marquee" style={{ position: 'relative' }} />`);
    expect(ensureNodeDimensions(code)).toBe(code);
  });

  it('DOES inject into the link primitives <Link> and <MotionLink> (they carry real layout style)', () => {
    const link = ensureNodeDimensions(PAGE(`  <Link data-id="cta" data-name="CTA" href="#" style={{ display: 'inline-flex', padding: '8px' }}>Go</Link>`));
    expect(link).toContain("width: 'auto'");
    expect(link).toContain("height: 'auto'");
    const mlink = ensureNodeDimensions(PAGE(`  <MotionLink data-id="ml" data-name="a" href="#" style={{ display: 'inline-flex' }}>Go</MotionLink>`));
    expect(mlink).toContain("width: 'auto'");
    expect(mlink).toContain("height: 'auto'");
  });

  it('does NOT touch parked canvas-nodes', () => {
    const code = PAGE(`  <div data-id="cn" data-name="Parked" data-canvas-node="true" style={{ position: 'absolute', left: '0px', top: '0px' }} />`);
    expect(ensureNodeDimensions(code)).toBe(code);
  });

  it('produces valid, re-parseable JSX (multi-node)', () => {
    const out = ensureNodeDimensions(PAGE(
      `  <div data-id="a" data-name="A" style={{ position: 'relative' }}><p data-id="b" data-name="B" style={{ margin: 0 }}>hi</p></div>`,
    ));
    // both nodes got dimensions, output still has balanced braces
    expect((out.match(/width: 'auto'/g) || []).length).toBe(2);
    expect((out.match(/height: 'auto'/g) || []).length).toBe(2);
  });
});

// ─── Vector interiors are exempt (builder-vs-own-oracle regression) ─────────
// A nested <svg> / svg geometry child is sized by viewBox + x/y/width/height
// ATTRIBUTES. Chromium doesn't paint CSS box props on a nested svg, and
// NESTED_SVG_BOX_IN_STYLE rejects them — so injecting width/height: 'auto'
// there produced source the builder's OWN oracle bounced (a Figma import came
// back from a commit with 1717 such nodes; the next submit failed, 2026-07-30).
describe('ensureNodeDimensions — svg interiors are exempt', () => {
  const SVG = `  <svg data-id="icon" data-name="Icon" viewBox="0 0 24 24" style={{ position: 'relative' }}>
    <svg data-id="shape" data-name="Vector" x="0" y="0" width="24" height="24" viewBox="0 0 24 24" style={{}}>
      <path data-id="shape-g0" d="M0 0 L10 10" fill="none" stroke="#000" style={{}}></path>
    </svg>
  </svg>`;

  it('never injects into a NESTED svg or its geometry child', () => {
    const out = ensureNodeDimensions(PAGE(SVG));
    expect(out).toContain(`data-id="shape" data-name="Vector" x="0" y="0" width="24" height="24" viewBox="0 0 24 24" style={{}}`);
    expect(out).toMatch(/data-id="shape-g0"[^>]*style=\{\{\}\}/);
  });

  it('still sizes the OUTER svg wrapper (a real CSS box)', () => {
    const out = ensureNodeDimensions(PAGE(SVG));
    const outer = out.slice(out.indexOf('data-id="icon"'), out.indexOf('data-id="shape"'));
    expect(outer).toContain("width: 'auto'");
    expect(outer).toContain("height: 'auto'");
  });

  it('output of the pass is oracle-clean (no NESTED_SVG_BOX_IN_STYLE)', async () => {
    const { checkFile } = await import('./check-file');
    const out = ensureNodeDimensions(PAGE(SVG));
    expect(checkFile(out, { kind: 'page' }).map(v => v.code)).not.toContain('NESTED_SVG_BOX_IN_STYLE');
  });
});
