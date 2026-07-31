// transform-template.test.ts — the static-transform × motion-animation composer.
//
// framer-motion rebuilds `style.transform` from its own values the moment any
// transform value animates, silently dropping a static authored string — a
// pinned aura's `translate(-50%, -50%)` vanished when an Appear animated `y`,
// shifting it by half its own size on the live page while the canvas looked
// right (user report 2026-07-27). `ensureTransformTemplateInCode` pairs the
// static string with framer-motion's composing `transformTemplate`, and is the
// SINGLE writer for it: motion-prop writes and `transform` style writes both
// re-derive it, so the two can never drift.

import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { ensureTransformTemplateInCode, updateMotionPropInCode, removeMotionPropFromCode } from './generator-motion';
import { updateNodeInCode } from './generator-crud';

const NID = 'div-aura-1';
const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'p.tsx' })).not.toThrow();

/** A pinned, centred aura; `attrs` lets each test vary the motion props. */
const page = (attrs: string, styleExtra = '') => `'use client';
import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <motion.div data-id="${NID}" data-name="Aura"${attrs} style={{ opacity: '0.2', top: '67%', left: '51%', width: '360px', height: '446px', position: 'absolute', transform: 'translate(-50%, -50%)'${styleExtra} }} data-pinned="true"></motion.div>
    </div>
  );
}
`;

const APPEAR = ` initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 0.2, y: 0 }} viewport={{ once: true }}`;
const TT = (prefix: string) => `transformTemplate={(_, generated) => \`${prefix} \${generated}\`}`;

describe('ensureTransformTemplateInCode', () => {
  it('adds the composer when a static transform meets an animated y', () => {
    const out = ensureTransformTemplateInCode(page(APPEAR), NID);
    expect(out).toContain(TT('translate(-50%, -50%)'));
    parses(out);
  });

  it('is idempotent', () => {
    const once = ensureTransformTemplateInCode(page(APPEAR), NID);
    expect(ensureTransformTemplateInCode(once, NID)).toBe(once);
  });

  it('no-op without a static transform', () => {
    const noT = page(APPEAR).replace(", transform: 'translate(-50%, -50%)'", '');
    expect(ensureTransformTemplateInCode(noT, NID)).toBe(noT);
  });

  it('no-op when nothing animates a transform (opacity-only appear)', () => {
    const fadeOnly = page(` initial={{ opacity: 0 }} whileInView={{ opacity: 0.2 }}`);
    expect(ensureTransformTemplateInCode(fadeOnly, NID)).toBe(fadeOnly);
  });

  it('a motion shorthand in style (rotate) also counts as animating', () => {
    const out = ensureTransformTemplateInCode(page('', ", rotate: '90'"), NID);
    expect(out).toContain(TT('translate(-50%, -50%)'));
  });

  it('REFRESHES a stale prefix to the current style.transform', () => {
    const stale = page(APPEAR + ' ' + TT('translate(-10%, -10%)'));
    const out = ensureTransformTemplateInCode(stale, NID);
    expect(out).toContain(TT('translate(-50%, -50%)'));
    expect(out).not.toContain('-10%');
  });

  it('REMOVES the canonical attr when the static transform is gone', () => {
    const orphan = page(APPEAR + ' ' + TT('translate(-50%, -50%)'))
      .replace(", transform: 'translate(-50%, -50%)'", '');
    const out = ensureTransformTemplateInCode(orphan, NID);
    expect(out).not.toContain('transformTemplate');
    parses(out);
  });

  it('leaves a FOREIGN (hand-written) template untouched', () => {
    const foreign = page(APPEAR + ' transformTemplate={(v, g) => `perspective(500px) ${g}`}');
    expect(ensureTransformTemplateInCode(foreign, NID)).toBe(foreign);
  });

  it('handles a DOUBLE-quoted static transform (AST-generator output)', () => {
    // Live-page find: the writer's single-quote-only match skipped a
    // `transform: "translate(-50%, -50%)"` node; the oracle drift rule (AST,
    // quote-agnostic) caught it (2026-07-27).
    const dq = page(APPEAR).replace("transform: 'translate(-50%, -50%)'", 'transform: "translate(-50%, -50%)"');
    const out = ensureTransformTemplateInCode(dq, NID);
    expect(out).toContain(TT('translate(-50%, -50%)'));
    parses(out);
  });

  it('skips non-motion elements', () => {
    const plain = page(APPEAR).replace(/motion\.div/g, 'div');
    expect(ensureTransformTemplateInCode(plain, NID)).toBe(plain);
  });
});

describe('the writers keep style.transform and the template IN SYNC', () => {
  it('updateMotionPropInCode(whileInView with y) pairs the template automatically', () => {
    const out = updateMotionPropInCode(page(''), NID, 'whileInView', { opacity: '0.2', y: '0' });
    expect(out).toContain(TT('translate(-50%, -50%)'));
    parses(out);
  });

  it('a transform-touching style write refreshes the prefix (the probe drift)', () => {
    // The measured failure: pin write updated style.transform, template kept
    // the old prefix, file still parsed → silent off-centre on live.
    const withTT = ensureTransformTemplateInCode(page(APPEAR), NID);
    const out = updateNodeInCode(withTT, NID, { transform: 'translate(-25%, -75%)' });
    const styleT = out.match(/transform: '(translate\([^']*\))'/)?.[1];
    const tmplT = out.match(/transformTemplate=\{\(_, generated\) => `([^`$]*)/)?.[1]?.trim();
    expect(styleT).toBe('translate(-25%, -75%)');
    expect(tmplT).toBe(styleT);
    parses(out);
  });

  it('clearing the transform reaps the template', () => {
    const withTT = ensureTransformTemplateInCode(page(APPEAR), NID);
    const out = updateNodeInCode(withTT, NID, { transform: '' });
    expect(out).not.toContain('transformTemplate');
    parses(out);
  });

  it('removing the last transform-animating prop reaps the template', () => {
    const withTT = ensureTransformTemplateInCode(page(APPEAR), NID);
    let out = removeMotionPropFromCode(withTT, NID, 'initial');
    out = removeMotionPropFromCode(out, NID, 'whileInView');
    expect(out).not.toContain('transformTemplate');
    parses(out);
  });

  it('a non-transform style write leaves the pair alone', () => {
    const withTT = ensureTransformTemplateInCode(page(APPEAR), NID);
    const out = updateNodeInCode(withTT, NID, { width: '400px' });
    expect(out).toContain(TT('translate(-50%, -50%)'));
    expect(out).toContain("width: '400px'");
  });
});

// ─── The oracle rule and the writer must agree ───────────────────────────────
import { checkFile } from '@/code/oracle/check-file';

const driftOf = (code: string) =>
  checkFile(code, { kind: 'page' }).filter(x => x.code === 'MOTION_TRANSFORM_TEMPLATE_DRIFT');

describe('MOTION_TRANSFORM_TEMPLATE_DRIFT', () => {
  it('fires on the raw bug (static transform + animated y, no template)', () => {
    const v = driftOf(page(APPEAR));
    expect(v.length).toBe(1);
    expect(v[0].message).toContain('DROPS the static string');
  });

  it('fires on a STALE prefix', () => {
    const stale = page(APPEAR + ' ' + TT('translate(-10%, -10%)'));
    expect(driftOf(stale).length).toBe(1);
    expect(driftOf(stale)[0].message).toContain("prefix 'translate(-10%, -10%)'");
  });

  it('fires on an ORPHANED template (no animation)', () => {
    const orphan = page(' ' + TT('translate(-50%, -50%)'));
    expect(driftOf(orphan).length).toBe(1);
    expect(driftOf(orphan)[0].message).toContain('orphaned');
  });

  it('silent on the writer-paired shape — the builder passes its own oracle', () => {
    expect(driftOf(ensureTransformTemplateInCode(page(APPEAR), NID))).toEqual([]);
  });

  it('silent on an opacity-only appear with a static transform', () => {
    expect(driftOf(page(` initial={{ opacity: 0 }} whileInView={{ opacity: 0.2 }}`))).toEqual([]);
  });

  it('silent on a foreign template', () => {
    const foreign = page(APPEAR + ' transformTemplate={(v, g) => `perspective(500px) ${g}`}');
    expect(driftOf(foreign)).toEqual([]);
  });

  it('silent on plain (non-motion) elements', () => {
    expect(driftOf(page(APPEAR).replace(/motion\.div/g, 'div'))).toEqual([]);
  });
});
