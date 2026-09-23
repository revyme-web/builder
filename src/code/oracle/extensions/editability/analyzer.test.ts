import { describe, it, expect } from 'vitest';
import { analyzeEditability } from './analyzer';

// ─── P2 page (variants/connections toggle) ──────────────────────────────────
const P2 = `'use client';
/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }, { "id": "mobile", "label": "Mobile", "width": 375, "height": "auto", "isPrimary": false, "order": 1 } ], "positions": { "desktop": { "x": 0, "y": 0 }, "mobile": { "x": 1560, "y": 0 } } } */
import { useState } from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  const [variant, setVariant] = useState('a');
  const variantConfig = [
    { name: 'a', label: 'Closed', x: 0, y: 0, isPrimary: true },
    { name: 'b', label: 'Open', x: 0, y: 0, isPrimary: false },
  ];
  const faqVariants = {
    a: { display: 'none' },
    b: { display: 'flex' },
  };
  const connections = [
    { from: 'a', to: 'b', trigger: 'click', sourceNode: 'faq-toggle-1' },
    { from: 'b', to: 'a', trigger: 'click', sourceNode: 'faq-toggle-1' },
  ];
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <section data-id="faq-section">
        <div data-id="faq-toggle-1" onTap={() => { const _n = variant === 'a' ? 'b' : null; if (_n) setVariant(_n); }}>Question ?</div>
        <motion.div data-id="faq-answer-1" variants={faqVariants} animate={variant}>Réponse</motion.div>
      </section>
    </div>
  );
}`;

// ─── P6 annotée (canonical) ──────────────────────────────────────────────────
const P6_ANNOTATED = `'use client';
/** @canvas { "viewports": [ { "id": "desktop", "label": "Desktop", "width": 1440, "height": "auto", "isPrimary": true, "order": 0 }, { "id": "mobile", "label": "Mobile", "width": 375, "height": "auto", "isPrimary": false, "order": 1 } ], "positions": { "desktop": { "x": 0, "y": 0 }, "mobile": { "x": 1560, "y": 0 } } } */
/** @pageVariables { "variables": [{ "name": "open", "type": "boolean", "default": "false" }] } */
import { useState } from 'react';

export default function Page() {
  const [open, setOpen] = useState(false);
  return (
    <div data-id="root" style={{ position: 'relative', width: '100%' }}>
      <section data-id="s">
        <div data-id="t" onClick={() => setOpen(true)}>Ouvrir</div>
      </section>
    </div>
  );
}`;

// ─── P6 shadow ───────────────────────────────────────────────────────────────
const P6_SHADOW = `export default function Page() {
  const [open, setOpen] = useState(false);
  return (
    <section data-id="s">
      <div data-id="t" onClick={() => setOpen(true)}>Ouvrir</div>
    </section>
  );
}`;

// ─── P1 (free boolean condition + shadow setter on a literal) ────────────────
const P1 = `export default function Page() {
  const [open, setOpen] = useState(false);
  return (
    <section data-id="faq-section">
      <div data-id="faq-toggle-1" onClick={() => setOpen(true)}>Question ?</div>
      {open && <p data-id="faq-answer-1">Réponse</p>}
    </section>
  );
}`;

// ─── P3 (@media manuscrit) ───────────────────────────────────────────────────
const P3 = `export default function Page() {
  return (
    <>
      <style>{\`
        @media (max-width: 375px) {
          [data-id="hero-title"] { font-size: 28px; }
        }
      \`}</style>
      <section data-id="hero">
        <h1 data-id="hero-title" style={{fontSize: '48px'}}>Titre</h1>
      </section>
    </>
  );
}`;

// ─── P4 (useEffect + nodes natifs) ──────────────────────────────────────────
const P4 = `import { useEffect, useState } from 'react';

export default function Page() {
  const [customCount, setCustomCount] = useState(0);
  useEffect(() => {
    document.title = 'Custom ' + customCount;
  }, [customCount]);
  return (
    <section data-id="section-1">
      <div data-id="card-1">
        <span data-id="card-1-label">Prix</span>
        <p data-id="card-1-text">Contenu original</p>
      </div>
      <button data-id="custom-btn" onClick={() => setCustomCount(customCount + 1)}>+1</button>
    </section>
  );
}`;

// ─── P5 (motion prop sur instance PascalCase) ───────────────────────────────
const P5 = `export default function Page() {
  return (
    <section data-id="s1">
      <MyCard data-id="inst-1" title="Hello" whileHover={{ scale: '1.05' }} />
      <div data-id="plain-1" style={{padding: '8px'}}>Plain</div>
    </section>
  );
}`;

// ─── GSAP + texte binaire ───────────────────────────────────────────────────
const GSAP_PAGE = `import gsap from 'gsap';
export default function Page() {
  const a = 1;
  const b = 2;
  return (
    <div data-id="root">
      <span data-id="s">{a + b}</span>
    </div>
  );
}`;

describe('oracle/extensions/editability/analyzer', () => {
  it('P2 · variants/connections toggle → NATIVE', () => {
    const r = analyzeEditability(P2, { kind: 'page' });
    expect(r.verdict).toBe('NATIVE');
    expect(r.counts.unsupported).toBe(0);
    expect(r.counts.custom).toBe(0);
  });

  it('P6 annotée → NATIVE', () => {
    const r = analyzeEditability(P6_ANNOTATED, { kind: 'page' });
    expect(r.verdict).toBe('NATIVE');
    expect(r.counts.unsupported).toBe(0);
    expect(r.findings.some((f) => f.capability === 'variables' && f.class === 'NATIVE')).toBe(true);
    expect(r.findings.some((f) => f.capability === 'interactions' && f.class === 'NATIVE')).toBe(true);
  });

  it('P6 shadow (setter sur variable non déclarée) → RECOVERABLE', () => {
    const r = analyzeEditability(P6_SHADOW, { kind: 'page' });
    expect(r.verdict).toBe('RECOVERABLE');
    const finding = r.findings.find((f) => f.capability === 'interactions');
    expect(finding?.class).toBe('RECOVERABLE');
    expect(finding?.evidence).toMatch(/declare "open" in @pageVariables/);
  });

  it('P1 (condition libre non déclarée + shadow setter) → MIXED', () => {
    const r = analyzeEditability(P1, { kind: 'page' });
    expect(r.verdict).toBe('MIXED');
    expect(r.findings.some((f) => f.capability === 'visibility' && f.class === 'CUSTOM')).toBe(true);
    expect(r.findings.some((f) => f.capability === 'interactions' && f.class === 'RECOVERABLE')).toBe(true);
  });

  it('P3 (@media manuscrit) → RECOVERABLE (finding responsive)', () => {
    const r = analyzeEditability(P3, { kind: 'page' });
    expect(r.verdict).toBe('RECOVERABLE');
    const finding = r.findings.find((f) => f.capability === 'responsive');
    expect(finding?.class).toBe('RECOVERABLE');
    expect(finding?.evidence).toMatch(/media-normalizer/);
  });

  it('P4 (useEffect + nodes natifs) → MIXED', () => {
    const r = analyzeEditability(P4, { kind: 'page' });
    expect(r.verdict).toBe('MIXED');
    expect(r.findings.some((f) => f.capability === 'custom-logic' && f.class === 'CUSTOM')).toBe(true);
    expect(r.findings.some((f) => f.capability === 'structure' && f.class === 'NATIVE')).toBe(true);
  });

  it('P5 (instance avec whileHover) → UNSUPPORTED', () => {
    const r = analyzeEditability(P5, { kind: 'page' });
    expect(r.verdict).toBe('UNSUPPORTED');
    expect(r.findings.some((f) => f.capability === 'motion' && f.class === 'UNSUPPORTED')).toBe(true);
  });

  it('GSAP import → UNSUPPORTED', () => {
    const r = analyzeEditability(GSAP_PAGE, { kind: 'page' });
    expect(r.verdict).toBe('UNSUPPORTED');
    expect(r.findings.some((f) => f.capability === 'unsupported-signatures' && f.class === 'UNSUPPORTED')).toBe(true);
    expect(r.findings.some((f) => f.evidence.includes('gsap'))).toBe(true);
  });

  it('texte {a + b} → UNSUPPORTED', () => {
    const r = analyzeEditability(GSAP_PAGE, { kind: 'page' });
    expect(r.findings.some((f) => f.class === 'UNSUPPORTED' && f.evidence.includes('{'))).toBe(true);
  });

  it('agrégation : verdict cohérent avec counts', () => {
    // Atomic counts on each verdict class
    const N = analyzeEditability(P6_ANNOTATED, { kind: 'page' });
    expect(N.verdict).toBe('NATIVE');
    expect(N.counts.unsupported + N.counts.custom + N.counts.recoverable).toBe(0);

    const R = analyzeEditability(P3, { kind: 'page' });
    expect(R.verdict).toBe('RECOVERABLE');
    expect(R.counts.unsupported).toBe(0);
    expect(R.counts.custom).toBe(0);
    expect(R.counts.recoverable).toBeGreaterThan(0);

    const U = analyzeEditability(P5, { kind: 'page' });
    expect(U.verdict).toBe('UNSUPPORTED');
    expect(U.counts.unsupported).toBeGreaterThan(0);
  });

  it('opts.coreViolations tier-3 court-circuite en UNSUPPORTED', () => {
    const r = analyzeEditability(P6_ANNOTATED, {
      kind: 'page',
      coreViolations: [{ code: 'X', tier: 3, message: 'blocker' }],
    });
    expect(r.verdict).toBe('UNSUPPORTED');
    expect(r.findings[0]?.evidence).toContain('X');
  });

  it('structure: data-ids dynamiques → UNSUPPORTED', () => {
    const code = `export default function Page() {
      return <div data-id={\`dyn-\${1}\`}>x</div>;
    }`;
    const r = analyzeEditability(code, { kind: 'page' });
    expect(r.findings.some((f) => f.capability === 'structure' && f.class === 'UNSUPPORTED')).toBe(true);
  });

  it('structure: data-id manquant → UNSUPPORTED', () => {
    const code = `export default function Page() {
      return <div>plain</div>;
    }`;
    const r = analyzeEditability(code, { kind: 'page' });
    expect(r.findings.some((f) => f.capability === 'structure' && f.class === 'UNSUPPORTED')).toBe(true);
  });
});
describe("P7 I8-calibrated canonical master", () => {
  const CANONICAL_MASTER = `"use client";
import { withResponsiveProps } from "@revyme/runtime";
/** @name "Card" */
export const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];
function Card({ style, title = "T" }: { style?: React.CSSProperties; title?: string }) {
  return (
    <div data-id="card-root" style={{ ...style }}>
      <p data-id="card-title" style={{ position: 'relative' }}>{title}</p>
    </div>
  );
}
export default withResponsiveProps(Card);
`;
  it('canonical master (own declaration + mandated runtime import) rates NATIVE', () => {
    const r = analyzeEditability(CANONICAL_MASTER, { kind: 'component' });
    expect(r.verdict).toBe('NATIVE');
    expect(r.findings.some((f) => f.capability === 'custom-logic')).toBe(false);
  });
});

describe('the builder\'s MotionLink wrapper is plumbing, not a node', () => {
  it('a master with a Link (via MotionLink) keeps a NATIVE structure verdict', () => {
    const code = `'use client';
import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const MotionLink = motion.create(React.forwardRef(function MotionLinkBase({ href, ...props }: any, ref: any) { return href ? <Link ref={ref} href={href} {...props} /> : <div ref={ref} {...props} />; }));
/** @name "Button" */
export const variantConfig = [{ name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true }];
function Button({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <MotionLink href="/about" data-id="btn-root" data-name="Button" style={{ position: 'relative', width: 'auto', height: 'auto', ...style }}>
      <p data-id="btn-label" data-name="Label" style={{ position: 'relative', margin: '0px' }}>Go</p>
    </MotionLink>
  );
}
export default withResponsiveProps(Button);
`;
    const r = analyzeEditability(code, { kind: 'component', path: 'components/Button.tsx' }) as { findings: { capability: string; class: string }[] };
    const structure = r.findings.find((f) => f.capability === 'structure');
    expect(structure?.class).toBe('NATIVE');
  });
});
