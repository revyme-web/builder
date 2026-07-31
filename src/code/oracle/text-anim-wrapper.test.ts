// text-anim-wrapper.test.ts — the oracle must accept the runtime text-effect shape.
//
// `<RevymeSplitText>` is a TRANSPARENT tag: it carries no data-id (it isn't a design node),
// and the expression it wraps must still pass the text-expression rule. Without the
// TRANSPARENT_TAGS entry every animated text node would bounce MISSING_DATA_ID.

import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';
import { addTextAnimInCode } from '../generation/text-anim-gen';
import type { TextAnimConfig } from '@/editor/tools/AnimationTool/motion/text-anim-presets';

const CFG: TextAnimConfig = { animationType: 'character', mask: true, opacity: 0, y: '100%', delay: 0.055 };

// checkFile returns the violations ARRAY directly. Reading `.violations` off it yields
// undefined → [] → every `not.toContain` passes vacuously. Guard against that here.
const codes = (r: unknown): string[] => {
  const list = Array.isArray(r) ? r : ((r as { violations?: unknown })?.violations ?? []);
  if (!Array.isArray(list)) throw new Error('checkFile shape changed');
  return (list as Array<{ code: string }>).map(v => v.code);
};

const PAGE = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%', height: 'auto' }}>
    <p data-id="hero" style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}>Hello</p>
  </div>;
}`;

describe('oracle accepts the runtime text-effect wrapper', () => {
  it('does not require a data-id on the wrapper', () => {
    const out = addTextAnimInCode(PAGE, 'hero', CFG);
    expect(codes(checkFile(out, { kind: 'page' }))).not.toContain('MISSING_DATA_ID');
  });

  it('accepts a CMS binding inside the wrapper', () => {
    const bound = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import projects from '@/cms/projects.json';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%', height: 'auto' }}>
    {projects.map((item, idx) => (
      <p data-id="hero" key={idx} style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}>{item.title}</p>
    ))}
  </div>;
}`;
    const out = addTextAnimInCode(bound, 'hero', CFG);
    const c = codes(checkFile(out, { kind: 'page' }));
    expect(c).not.toContain('TEXT_EXPRESSION');
    expect(c).not.toContain('MISSING_DATA_ID');
    expect(out).toContain('{item.title}');
  });

  it('the file still resolves into editable nodes', () => {
    const c = codes(checkFile(addTextAnimInCode(PAGE, 'hero', CFG), { kind: 'page' }));
    expect(c).not.toContain('RESOLVE_EMPTY');
    expect(c).not.toContain('RESOLVE_THROW');
    expect(c).not.toContain('WOULD_CRASH');
  });
});

describe('TEXT_ANIM_WRAPPER — both halves or neither', () => {
  const page = (body: string) => `'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { RevymeSplitText } from '@revyme/runtime';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative', width: '100%', height: 'auto' }}>
    ${body}
  </div>;
}`;

  it('flags the spec attribute without a wrapper', () => {
    const out = page(`<p data-id="hero" data-text-anim='{"animationType":"character"}' style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}>Hello</p>`);
    expect(codes(checkFile(out, { kind: 'page' }))).toContain('TEXT_ANIM_WRAPPER');
  });

  it('flags hand-written per-character spans (the retired build-time form)', () => {
    const out = page(`<motion.p data-id="hero" data-text-anim='{"animationType":"character"}' style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}><motion.span initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} style={{ display: "inline-block" }}>H</motion.span></motion.p>`);
    expect(codes(checkFile(out, { kind: 'page' }))).toContain('TEXT_ANIM_WRAPPER');
  });

  it('flags a wrapper with no spec attribute', () => {
    const out = page(`<p data-id="hero" style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}><RevymeSplitText spec={{ animationType: "character" }}>Hello</RevymeSplitText></p>`);
    expect(codes(checkFile(out, { kind: 'page' }))).toContain('TEXT_ANIM_WRAPPER');
  });

  it('accepts the correct pairing', () => {
    const out = addTextAnimInCode(PAGE, 'hero', CFG);
    expect(codes(checkFile(out, { kind: 'page' }))).not.toContain('TEXT_ANIM_WRAPPER');
  });

  it('leaves a plain text node alone', () => {
    const out = page(`<p data-id="hero" style={{ position: 'relative', width: '100%', height: 'auto', margin: '0px' }}>Hello</p>`);
    expect(codes(checkFile(out, { kind: 'page' }))).not.toContain('TEXT_ANIM_WRAPPER');
  });
});
