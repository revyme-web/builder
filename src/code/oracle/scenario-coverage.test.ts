// scenario-coverage.test.ts — THE ACCEPTANCE NET for the 2026-08-11 gap
// analysis (canvas-poc-private/oracle-gap-analysis-2026-08-11.md).
//
// Every fixture here is a user-ask scenario that VERIFIABLY PASSED the oracle
// with zero violations while rendering wrong or being permanently uneditable
// in the builder. Each must now bounce with (at least) the named rule. If a
// refactor ever lets one slip back to zero violations, this file is the alarm.
//
// The BLOCKED-BY-ADJACENT section pins scenarios that were only ever caught by
// neighbouring rules — they must stay blocked by SOMETHING.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const codesOf = (code: string, kind: 'page' | 'component' = 'page') =>
  checkFile(code, { kind, path: kind === 'page' ? 'app/probe/page.client.tsx' : 'components/Probe.tsx' })
    .map((x) => x.code);

const PAGE_HEAD = `'use client';

/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0, "height": "auto" }], "positions": { "desktop": { "x": 0, "y": 0 } } } */

import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';

export default function Page() {
`;
const page = (body: string, extraTop = '') =>
  PAGE_HEAD.replace('import React', `${extraTop}import React`) + `  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
${body}
  </div>;
}
`;

/** scenario id → { fixture, expected rule } — every one passed clean before. */
const MUST_BOUNCE: Array<{ id: string; code: string; kind?: 'page' | 'component'; fixture: string }> = [
  { id: 'S1 numeric text renders empty', code: 'RESOLVE_TEXT_EMPTY',
    fixture: page(`    <p data-id="count" style={{ position: 'relative', width: '100%', height: 'auto' }}>{42}</p>`) },
  { id: 'S2 member-expression text renders empty', code: 'RESOLVE_TEXT_EMPTY',
    fixture: page(`    <p data-id="len" style={{ position: 'relative', width: '100%', height: 'auto' }}>{window.location.href}</p>`) },
  { id: 'S4 member-expression style -> token sentinel', code: 'RESOLVE_STYLE_SENTINEL',
    fixture: page(`    <p data-id="a" style={{ position: 'relative', width: '100%', height: 'auto', color: THEME.primary }}>Hi</p>`, `const THEME = { primary: '#f00' };\n`) },
  { id: 'S5 spread in style object', code: 'RESOLVE_STYLE_DROPPED',
    fixture: page(`    <div data-id="b" style={{ position: 'relative', width: '100%', height: 'auto', ...cardBase, color: 'red' }}>x</div>`, `const cardBase = { padding: '20px' };\n`) },
  { id: 'S6 computed style key', code: 'RESOLVE_STYLE_DROPPED',
    fixture: page(`    <div data-id="c" style={{ position: 'relative', width: '100%', height: 'auto', [side]: '10px' }}>x</div>`, `const side = 'paddingLeft';\n`) },
  { id: 'S9 touch/scroll-snap cluster', code: 'STYLE_PROP_NO_CONTROL',
    fixture: page(`    <div data-id="rail" style={{ position: 'relative', width: '100%', height: 'auto', display: 'flex', touchAction: 'pan-y', scrollSnapType: 'x mandatory' }}>x</div>`) },
  { id: 'S10 CSS custom property', code: 'STYLE_PROP_NO_CONTROL',
    fixture: page(`    <div data-id="brand" style={{ position: 'relative', width: '100%', height: 'auto', '--brand': '#ff4524' }}>x</div>`) },
  { id: 'S11 overflow auto (blank select)', code: 'STYLE_PROP_NO_CONTROL',
    fixture: page(`    <div data-id="s" style={{ position: 'relative', width: '100%', height: '400px', overflow: 'auto' }}>x</div>`) },
  { id: 'S11d string style attr (React render crash)', code: 'STRING_STYLE_ATTR',
    fixture: page(`    <svg data-id="badge" data-name="Badge" viewBox="0 0 125 45" preserveAspectRatio="none" style={{ position: 'relative', width: '125px', height: '45px' }}><path d="M0 0L125 0L125 45L0 45z" fill="#bb9224" style="fill: rgb(187, 146, 36)" /></svg>`) },
  { id: 'S11a empty style value (CSR/SSR divergence)', code: 'EMPTY_STYLE_VALUE',
    fixture: page(`    <div data-id="pad" style={{ position: 'relative', width: '100%', height: 'auto', paddingTop: '80px', padding: "" }}>x</div>`) },
  { id: 'S11b rem padding (px-only spacing)', code: 'SPACING_UNIT_NOT_PX',
    fixture: page(`    <div data-id="card" style={{ position: 'relative', width: '100%', height: 'auto', padding: '2rem' }}>x</div>`) },
  { id: 'S11c percent radius (px-only spacing)', code: 'SPACING_UNIT_NOT_PX',
    fixture: page(`    <div data-id="avatar" style={{ position: 'relative', width: '80px', height: '80px', borderRadius: '50%' }}>x</div>`) },
  { id: 'S12 whiteSpace on a wrapper div', code: 'TEXT_STYLE_ON_FRAME',
    fixture: page(`    <div data-id="pill" style={{ position: 'relative', width: '100%', height: 'auto', whiteSpace: 'nowrap' }}><p data-id="t" style={{ position: 'relative', width: '100%', height: 'auto' }}>x</p></div>`) },
  { id: 'S13 ul/li list', code: 'ELEMENT_UNSUPPORTED_TAG',
    fixture: page(`    <ul data-id="list" style={{ position: 'relative', width: '100%', height: 'auto' }}><li data-id="li1" style={{ position: 'relative', width: '100%', height: 'auto' }}>One</li></ul>`) },
  { id: 'S14 raw iframe embed', code: 'ELEMENT_UNSUPPORTED_TAG',
    fixture: page(`    <iframe data-id="yt" src="https://www.youtube.com/embed/abc" style={{ position: 'relative', width: '100%', height: '400px' }} />`) },
  { id: 'S15 checkbox input', code: 'ELEMENT_UNSUPPORTED_TAG',
    fixture: page(`    <input data-id="consent" type="checkbox" name="consent" style={{ position: 'relative', width: '20px', height: '20px' }} />`) },
  { id: 'S16 ternary conditional render', code: 'CONDITIONAL_RENDER_UNSUPPORTED',
    fixture: page(`    {mounted ? <div data-id="popup" style={{ position: 'relative', width: '100%', height: 'auto' }}>hello</div> : null}`)
      .replace('return <div', 'const [mounted] = useState(true);\n  return <div') },
  { id: 'S17b setInterval countdown (defined state)', code: 'PAGE_HOOK_UNRESOLVED',
    fixture: page(`    <p data-id="cd" style={{ position: 'relative', width: '100%', height: 'auto' }}>{secs}</p>`)
      .replace('return <div', `const [secs, setSecs] = useState(60);
  useEffect(() => { const t = setInterval(() => setSecs((s) => s - 1), 1000); return () => clearInterval(t); }, []);
  return <div`) },
  { id: 'S19b scroll listener side-effect', code: 'PAGE_HOOK_UNRESOLVED',
    fixture: page(`    <div data-id="nav" style={{ position: 'relative', width: '100%', height: '96px' }}>nav</div>`)
      .replace('return <div', `useEffect(() => { const on = () => document.body.classList.toggle('scrolled', window.scrollY > 40); window.addEventListener('scroll', on); return () => window.removeEventListener('scroll', on); }, []);
  return <div`) },
  { id: 'S20 clipboard onClick body', code: 'INTERACTION_HANDLER_BODY_UNREADABLE',
    fixture: page(`    <div data-id="copy" onClick={() => { navigator.clipboard.writeText('hi'); }} style={{ position: 'relative', width: '120px', height: '40px' }}>Copy</div>`) },
  { id: 'S21 marquee without data-loop', code: 'LOOP_MISSING_CARRIER',
    fixture: page(`    <motion.div data-id="marq" animate={{ x: '-50%' }} transition={{ repeat: Infinity, duration: 12 }} style={{ position: 'relative', width: '200%', height: '60px' }}>logos</motion.div>`) },
  { id: 'S22 details/summary accordion', code: 'ELEMENT_UNSUPPORTED_TAG',
    fixture: page(`    <details data-id="faq1" style={{ position: 'relative', width: '100%', height: 'auto' }}><summary data-id="q1" style={{ position: 'relative', width: '100%', height: 'auto' }}>Q?</summary></details>`) },
  { id: 'S23 page style block free CSS', code: 'RAW_STYLE_TAG',
    fixture: page(`    <div data-id="glow" style={{ position: 'relative', width: '100%', height: 'auto' }}>x</div>
    <style>{\`
      [data-id="glow"] { box-shadow: 0 0 40px rgba(255,69,36,.6); }
      @keyframes pulse { 0% { opacity: .4; } 100% { opacity: 1; } }
    \`}</style>`) },
  { id: 'S24 pricing table', code: 'ELEMENT_UNSUPPORTED_TAG',
    fixture: page(`    <table data-id="cmp" style={{ position: 'relative', width: '100%', height: 'auto' }}><tbody data-id="tb" style={{ width: '100%', height: 'auto' }}><tr data-id="r1" style={{ width: '100%', height: 'auto' }}><td data-id="c1" style={{ width: '50%', height: 'auto' }}>x</td></tr></tbody></table>`) },
  { id: 'S26 independent translate property', code: 'STYLE_PROP_NO_CONTROL',
    fixture: page(`    <div data-id="mix" style={{ position: 'relative', width: '100%', height: 'auto', translate: '0 20px' }}>x</div>`) },
  { id: 'S29 typography on a wrapper frame', code: 'TEXT_STYLE_ON_FRAME',
    fixture: page(`    <div data-id="wrap" style={{ position: 'relative', width: '100%', height: 'auto', fontFamily: 'Manrope, sans-serif', fontSize: '18px', color: '#B5B2B1' }}>
      <p data-id="txt" style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}>Inherited</p>
    </div>`) },
  { id: 'S30 API-helper export in a page', code: 'PAGE_EXTRA_EXPORT',
    fixture: page(`    <p data-id="t" style={{ position: 'relative', width: '100%', height: 'auto' }}>Hello</p>`,
      `export async function submitLead(data) { const res = await fetch('https://api.example.com/leads', { method: 'POST' }); return res.json(); }\n`) },
];

describe('scenario coverage — every verified gap now bounces', () => {
  for (const s of MUST_BOUNCE) {
    it(s.id, () => {
      expect(codesOf(s.fixture, s.kind ?? 'page')).toContain(s.code);
    });
  }
});

describe('scenarios covered by adjacent rules must STAY blocked', () => {
  it('S3 undefined text identifier', () => {
    const fx = page(`    <p data-id="ttl" style={{ position: 'relative', width: '100%', height: 'auto' }}>{title}</p>`);
    expect(codesOf(fx).length).toBeGreaterThan(0);
  });
  it('S7 expression data-id', () => {
    const fx = page(`    <p data-id={dynId} style={{ position: 'relative', width: '100%', height: 'auto' }}>Hi</p>`, `const dynId = 'p-1';\n`);
    expect(codesOf(fx).length).toBeGreaterThan(0);
  });
  it('S18 template-literal transform carousel', () => {
    const fx = page(`    <div data-id="track" style={{ position: 'relative', width: '100%', height: '300px', display: 'flex', transform: \`translateX(\${-idx * 100}%)\` }}><div data-id="s1" style={{ position: 'relative', width: '100%', height: '100%', flex: '0 0 auto', order: '0' }}>1</div></div>`)
      .replace('return <div', 'const [idx, setIdx] = useState(0);\n  return <div');
    expect(codesOf(fx).length).toBeGreaterThan(0);
  });
});

describe('a fully canonical page still passes CLEAN', () => {
  it('literal text, banded style block, motion channels on motion tags', () => {
    const fx = page(`    <motion.p data-id="headline" data-name="Headline" style={{ position: 'relative', width: '100%', height: 'auto', fontSize: '48px', color: '#fff', rotate: 2 }} whileInView={{ opacity: 1 }} initial={{ opacity: 0 }} viewport={{ once: true }}>Real literal text</motion.p>
    <style>{\`
    @media (max-width: 375px) {
      [data-id="headline"] { font-size: 32px !important; }
    }
    \`}</style>`).replace(
      '"viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0, "height": "auto" }], "positions": { "desktop": { "x": 0, "y": 0 } }',
      '"viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0, "height": "auto" }, { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 1, "height": "auto" }], "positions": { "desktop": { "x": 0, "y": 0 }, "mobile": { "x": 1600, "y": 0 } }',
    );
    expect(codesOf(fx)).toEqual([]);
  });
});
