// variant-text.test.ts — per-variant text content (`{variant === 'x' ? 'a' : 'b'}`).
//
// Covers the write side (updateVariantTextInCode) and round-trips through the
// parser to confirm the read side (node.conditionalText) sees the same shape.

import { describe, test, expect } from 'vitest';
import { updateVariantTextInCode } from './generator-crud';
import { parseJSXToNodes } from '../parsing/parser';

const COMP = `'use client';
import React from 'react';
import { motion } from 'framer-motion';

const variantConfig = [
  { name: 'default', label: 'Monthly', x: 0, y: 0, isPrimary: true },
  { name: 'annual', label: 'Annually', x: 420, y: 0 },
];

function Card({ initialVariant = 'default' }) {
  const [variant, setVariant] = React.useState(initialVariant);
  return (
    <motion.div data-id="root">
      <motion.span data-id="price">19</motion.span>
    </motion.div>
  );
}
export default Card;`;

describe('updateVariantTextInCode', () => {
  test('plain text + edit on a non-primary variant → ternary, original text is the fallback', () => {
    const out = updateVariantTextInCode(COMP, 'price', 'annual', '15');
    // annual is the explicit branch, the old plain text "19" is the fallback.
    expect(out).toMatch(/variant === ['"]annual['"] \? ['"]15['"] : ['"]19['"]/);
  });

  test('editing the PRIMARY variant updates the fallback, stays plain when no branches', () => {
    const out = updateVariantTextInCode(COMP, 'price', 'default', '20');
    expect(out).toMatch(/data-id="price">\s*20\s*<\/motion\.span>/);
    expect(out).not.toMatch(/variant ===/);
  });

  test('editing another variant on an existing ternary extends the chain', () => {
    const step1 = updateVariantTextInCode(COMP, 'price', 'annual', '15');
    const step2 = updateVariantTextInCode(step1, 'price', 'team', '49');
    expect(step2).toMatch(/variant === ['"]annual['"] \? ['"]15['"]/);
    expect(step2).toMatch(/variant === ['"]team['"] \? ['"]49['"]/);
    expect(step2).toMatch(/['"]19['"]/); // fallback preserved
  });

  test('editing the primary updates the fallback without dropping variant branches', () => {
    const step1 = updateVariantTextInCode(COMP, 'price', 'annual', '15');
    const step2 = updateVariantTextInCode(step1, 'price', 'default', '29');
    expect(step2).toMatch(/variant === ['"]annual['"] \? ['"]15['"] : ['"]29['"]/);
  });

  test('a branch set back to the fallback value collapses to plain text', () => {
    const step1 = updateVariantTextInCode(COMP, 'price', 'annual', '15');
    const step2 = updateVariantTextInCode(step1, 'price', 'annual', '19'); // == fallback
    expect(step2).not.toMatch(/variant ===/);
    expect(step2).toMatch(/data-id="price">\s*19\s*<\/motion\.span>/);
  });
});

describe('parser reads per-variant text into node.conditionalText', () => {
  test('a ternary text child round-trips to conditionalText + the default textContent', () => {
    const code = updateVariantTextInCode(COMP, 'price', 'annual', '15');
    const nodes = parseJSXToNodes(code);
    const price = nodes.get('price');
    expect(price).toBeDefined();
    expect(price!.conditionalText).toEqual({ annual: '15', default: '19' });
    // Static fallback (shown when no variant resolves) is the `default` branch.
    expect(price!.textContent).toBe('19');
  });

  test('plain-text nodes have no conditionalText', () => {
    const nodes = parseJSXToNodes(COMP);
    expect(nodes.get('price')!.conditionalText).toBeUndefined();
  });
});

// ─── Per-variant DETACH of a text-content variable ──────────────────────────
import { detachTextVariableForVariantInCode } from './generator-crud';

const COMP_VAR = `'use client';
/** @propMeta {"content":{"type":"plainText"}} */
import React from 'react';
import { motion } from 'framer-motion';

const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-2', label: 'Mobile', x: 998, y: 0 },
];

function Card({ initialVariant = 'default', content = "Hello" }) {
  return (
    <motion.p data-id="t" data-name="Text">{content}</motion.p>
  );
}
export default Card;`;

describe('detachTextVariableForVariantInCode — per-variant text-variable detach', () => {
  test('wraps {content} in a ternary keeping the variable as the fallback', () => {
    const out = detachTextVariableForVariantInCode(COMP_VAR, 't', 'variant-2', 'content', 'Hi');
    expect(out).toMatch(/initialVariant === ['"]variant-2['"] \? ['"]Hi['"] : content/);
    // The signature prop is untouched (variable still bound everywhere else).
    expect(out).toMatch(/content = "Hello"/);
  });

  test('round-trips: parser sees per-variant literal branch + the still-bound text variable', () => {
    const out = detachTextVariableForVariantInCode(COMP_VAR, 't', 'variant-2', 'content', 'Hi');
    const nodes = parseJSXToNodes(out);
    const t = nodes.get('t')!;
    expect(t.conditionalText).toEqual({ 'variant-2': 'Hi', default: 'Hello' });
    expect(t.textVariable).toBe('content'); // primary/other variants still resolve via the variable
  });

  test('re-detaching a variant updates its branch, fallback stays the variable', () => {
    let out = detachTextVariableForVariantInCode(COMP_VAR, 't', 'variant-2', 'content', 'Hi');
    out = detachTextVariableForVariantInCode(out, 't', 'variant-2', 'content', 'Yo'); // change the literal
    expect(out).toMatch(/: content/); // identifier fallback preserved
    const nodes = parseJSXToNodes(out);
    const ct = nodes.get('t')!.conditionalText!;
    expect(ct['variant-2']).toBe('Yo');     // updated branch
    expect(ct.default).toBe('Hello');        // primary still resolves via the variable
    expect(nodes.get('t')!.textVariable).toBe('content');
  });
});

// ─── Per-variant BIND of a text-content variable (inverse of detach) ─────────
import { bindTextVariableForVariantInCode } from '../features/variable-ops';

const COMP_PLAIN = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-2', label: 'Mobile', x: 998, y: 0 },
];
function Card({ initialVariant = 'default' }) {
  return <motion.p data-id="t" data-name="Text">Normal</motion.p>;
}
export default Card;`;

describe('bindTextVariableForVariantInCode — per-variant text-variable bind', () => {
  test('CREATE on a variant: variable in that variant branch, literal fallback, prop added', () => {
    const out = bindTextVariableForVariantInCode(COMP_PLAIN, 't', 'variant-2', 'content', 'Normal');
    expect(out).toMatch(/initialVariant === ['"]variant-2['"] \? content : ['"]Normal['"]/); // variable on variant-2
    expect(out).toMatch(/content = ['"]Normal['"]/); // prop added with the current text as default
  });

  test('round-trips: parser sees per-variant text-variable + literal fallback', () => {
    const out = bindTextVariableForVariantInCode(COMP_PLAIN, 't', 'variant-2', 'content', 'Normal');
    const nodes = parseJSXToNodes(out);
    const t = nodes.get('t')!;
    expect(t.conditionalTextVariable).toEqual({ 'variant-2': 'content' });
    // Baked: variant-2 resolves to the variable's value, default stays the literal.
    expect(t.conditionalText).toMatchObject({ 'variant-2': 'Normal', default: 'Normal' });
    expect(t.textVariable).toBe('content');
  });

  test('SET on a variant (prop already exists): does NOT re-add / reset the prop default', () => {
    const withProp = `'use client';
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-2', label: 'Mobile', x: 998, y: 0 },
];
function Card({ initialVariant = 'default', content = 'Existing' }) {
  return <p data-id="t">Normal</p>;
}
export default Card;`;
    const out = bindTextVariableForVariantInCode(withProp, 't', 'variant-2', 'content', 'Normal');
    expect(out).toMatch(/content = ['"]Existing['"]/); // default preserved, not reset to 'Normal'
    expect(out).toMatch(/initialVariant === ['"]variant-2['"] \? content : ['"]Normal['"]/);
  });
});

describe('detach of a per-variant BIND (× on the bound variant) collapses correctly', () => {
  test('detaching the only bound variant → back to plain literal text, no variable', () => {
    const bound = bindTextVariableForVariantInCode(COMP_PLAIN, 't', 'variant-2', 'content', 'Normal');
    // bound: {initialVariant === 'variant-2' ? content : 'Normal'}
    const out = detachTextVariableForVariantInCode(bound, 't', 'variant-2', 'content', 'Normal');
    expect(out).not.toMatch(/\?/);          // ternary gone
    expect(out).toMatch(/>\s*Normal\s*</);  // plain text restored
    const nodes = parseJSXToNodes(out);
    expect(nodes.get('t')!.conditionalText).toBeUndefined();
    expect(nodes.get('t')!.textVariable).toBeUndefined();
  });

  test('detaching one of two bound variants keeps the other bound', () => {
    let out = bindTextVariableForVariantInCode(COMP_PLAIN, 't', 'variant-2', 'content', 'Normal');
    out = bindTextVariableForVariantInCode(out, 't', 'default', 'content', 'Normal'); // also bind default
    out = detachTextVariableForVariantInCode(out, 't', 'variant-2', 'content', 'Normal'); // remove variant-2's binding
    const nodes = parseJSXToNodes(out);
    const ctv = nodes.get('t')!.conditionalTextVariable;
    expect(ctv && ctv['variant-2']).toBeUndefined(); // variant-2 no longer bound
    expect(ctv && (ctv['default'] || ctv['variant-1'])).toBeTruthy(); // a binding still remains
  });
});

describe('updateVariantTextInCode — preserves per-variant variable + uses the right identifier', () => {
  const CONN_LESS = `'use client';
/** @propMeta {"content":{"type":"plainText"}} */
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'D', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 9, y: 0 },
];
function Card({ initialVariant = 'default', content = 'old' }) {
  return <p data-id="t">{initialVariant === "variant-1" ? content : "old"}</p>;
}
export default Card;`;

  test('editing PRIMARY text keeps the variant variable binding + never emits a bare variant', () => {
    const out = updateVariantTextInCode(CONN_LESS, 't', 'default', 'NEW');
    // variant-1 still bound to the variable, primary fallback updated.
    expect(out).toMatch(/initialVariant === ['"]variant-1['"] \? content : ['"]NEW['"]/);
    // No undefined `variant` identifier (would crash) — only `initialVariant`.
    expect(out).not.toMatch(/[^a-zA-Z]variant === /);
    expect(parseJSXToNodes(out).get('t')).toBeDefined(); // valid, parseable output
  });

  test('round-trips: primary shows NEW, variant-1 still resolves via the variable', () => {
    const out = updateVariantTextInCode(CONN_LESS, 't', 'default', 'NEW');
    const nodes = parseJSXToNodes(out);
    const t = nodes.get('t')!;
    expect(t.conditionalText?.default).toBe('NEW');
    expect(t.conditionalTextVariable).toEqual({ 'variant-1': 'content' });
  });

  test('connection-less component never writes `variant` even from plain text', () => {
    const plain = `'use client';
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'D', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 9, y: 0 },
];
function Card({ initialVariant = 'default' }) { return <p data-id="t">Hi</p>; }
export default Card;`;
    const out = updateVariantTextInCode(plain, 't', 'variant-1', 'Yo');
    expect(out).toMatch(/initialVariant === ['"]variant-1['"]/);
    expect(out).not.toMatch(/[^a-zA-Z]variant === /);
  });
});

describe('updateVariantTextInCode — desktop (primary viewport id) normalizes to the fallback', () => {
  const CONN_LESS2 = `'use client';
/** @propMeta {"content":{"type":"plainText"}} */
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'D', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 9, y: 0 },
];
function Card({ initialVariant = 'default', content = 'old' }) {
  return <p data-id="t">{initialVariant === "variant-1" ? content : "old"}</p>;
}
export default Card;`;

  test('editing primary via "desktop" updates the fallback, never mints a desktop branch', () => {
    const out = updateVariantTextInCode(CONN_LESS2, 't', 'desktop', 'NEW');
    expect(out).toMatch(/initialVariant === ['"]variant-1['"] \? content : ['"]NEW['"]/);
    expect(out).not.toMatch(/['"]desktop['"]/); // no dead branch
  });

  test('a pre-existing dead `=== "desktop"` branch self-heals (dropped) on the next edit', () => {
    const bad = `'use client';
import React from 'react';
const variantConfig = [
  { name: 'default', label: 'D', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 9, y: 0 },
];
function Card({ initialVariant = 'default', content = 'old' }) {
  return <p data-id="t">{initialVariant === "desktop" ? "frrf" : initialVariant === "variant-1" ? content : "old"}</p>;
}
export default Card;`;
    const out = updateVariantTextInCode(bad, 't', 'desktop', 'NEW');
    expect(out).not.toMatch(/['"]desktop['"]/);  // dead branch gone
    expect(out).toMatch(/initialVariant === ['"]variant-1['"] \? content/); // variable branch preserved
    expect(out).toMatch(/['"]NEW['"]/);          // primary text applied
  });
});
