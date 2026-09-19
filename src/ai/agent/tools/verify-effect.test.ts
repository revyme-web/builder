// src/ai/agent/tools/verify-effect.test.ts
//
// `verify_effect` — the engine and the tool. The fixtures are REAL generated
// JSX in the builder dialect (data-id + data-name + camelCase inline styles),
// loaded through the REAL ProjectFS (loadSnapshot) — no parser mocks, no
// canvas: the verification is a headless code scan by design.
//
// The four scenarios that define the feature (each asserts the RESULT, never
// "a tool was called"):
//   1. section created + content filled        → satisfied: true
//   2. section created but text empty          → satisfied: false, feedback
//      says content is missing/empty
//   3. section partially filled (2/3)          → satisfied: false, and the
//      missing[] names exactly which card/text is empty
//   4. decorative/voluntary spacers            → NOT falsely flagged
//      (satisfied stays true)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { projectFS } from '@/code/project/project-fs';
import { deriveSpec, verifyEffect, verifyEffectTool, scanElements, isFilled, elementRole, verifyEffectConceptAST, CONCEPT_SYNONYMS, getConceptSynonymGroup } from './verify-effect';
import { trace } from '@/shared/debug-trace';

// ─── Fixtures (generated-JSX dialect, projectFS snapshots) ──────────────────

const REQUEST =
  'Add a testimonials section with 2-3 cards, each with a quote and the name of the person.';

/** One testimonial card: quote leaf + author leaf, canonical corpus ids. */
const card = (n: number, quote: string, author: string) => `
        <div data-id="testimonial-${n}" data-name="Card" style={{ position: 'relative', flex: '0 0 auto', order: '${n - 1}', width: '360px', padding: '24px', borderRadius: '16px', backgroundColor: '#fafafa', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <p data-id="testimonial-${n}-quote" data-name="Quote" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '16px' }}>${quote}</p>
          <p data-id="testimonial-${n}-author" data-name="Author" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '14px', fontWeight: '600' }}>${author}</p>
        </div>`;

const testimonialsSection = (extra: string) => `
      <div data-id="testimonials" data-name="Testimonials" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '24px', padding: '80px 40px' }}>
        <h2 data-id="testimonials-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', fontWeight: '700' }}>What people say</h2>
${extra}
      </div>`;

const pageFile = (body: string) => `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
${body}
    </div>
  );
}`;

/** Scenario 1 — section + 2 filled cards. */
export const PAGE_FILLED = pageFile(
  testimonialsSection(
    card(1, 'Revyme replaced three tools for us.', 'Alice Chen') +
      card(2, 'Shipping sites in hours, not weeks.', 'Marcus Reid'),
  ),
);

/** Scenario 2 — section created, but testimonial-1's quote is EMPTY. */
export const PAGE_EMPTY_QUOTE = pageFile(
  testimonialsSection(
    card(1, '', 'Alice Chen') + card(2, 'Shipping sites in hours, not weeks.', 'Marcus Reid'),
  ),
);

/** Scenario 3 — 3 cards, only 2 fully filled (testimonial-2 quote empty). */
export const PAGE_PARTIAL = pageFile(
  testimonialsSection(
    card(1, 'Revyme replaced three tools for us.', 'Alice Chen') +
      card(2, '', 'Marcus Reid') +
      card(3, 'The canvas re-renders as I type.', 'Sofia Alvarez'),
  ),
);

/** Scenario 4 — filled cards + voluntary decorative content: an EMPTY spacer
 *  and a filled decoration must never be flagged as missing content. */
export const PAGE_WITH_DECOR = pageFile(
  testimonialsSection(
    card(1, 'Revyme replaced three tools for us.', 'Alice Chen') +
      card(2, 'Shipping sites in hours, not weeks.', 'Marcus Reid') +
      `
        <div data-id="testimonials-spacer" data-name="Spacer" style={{ position: 'relative', flex: '0 0 auto', order: '2', height: '24px' }}></div>
        <div data-id="decoration-1" data-name="Decoration" style={{ position: 'relative', flex: '0 0 auto', order: '3' }}>✦</div>`,
  ),
);

/** No testimonials section at all — only a hero. */
export const PAGE_NO_SECTION = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', padding: '80px 40px' }}>
        <p data-id="hero-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '56px' }}>Build the future.</p>
      </div>`);

// ─── Chantier B fixtures: interactive roles (functional audit) ─────────────
//
// FAQ built in the builder corpus dialect: a numbered item row with a styled
// "question button" whose "+" is a decoration. The FAKE variant carries ONLY
// the decoration; the functional variant wires a real onClick state flip.

const faqSection = (inner: string) => `
      <div data-id="faq" data-name="FAQ" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '16px', padding: '80px 40px' }}>
        <h2 data-id="faq-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '28px', fontWeight: '700' }}>Questions</h2>
${inner}
      </div>`;

const faqItem = (n: number, q: string, a: string, buttonAttrs = '') => `
        <div data-id="faq-item-${n}" data-name="Item" style={{ position: 'relative', flex: '0 0 auto', order: '${n - 1}', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: '1px solid #e5e7eb', padding: '16px 0' }}>
          <button data-id="faq-item-${n}-q" data-name="Question" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer' }}${buttonAttrs}>${q} <span data-id="faq-item-${n}-plus" data-name="Decoration">+</span></button>
          <p data-id="faq-item-${n}-a" data-name="Answer" style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '14px', color: '#6b7280' }}>${a}</p>
        </div>`;

/** Scenario 5 — FAQ questions+answers with "+" icons but NO handler at all:
 *  visual-only, must be FAKE (this is the audit's "interactive FAQ" miss). */
export const PAGE_FAQ_FAKE = pageFile(
  faqSection(
    faqItem(1, 'What is Revyme?', 'A visual builder.') +
      faqItem(2, 'Is it code?', 'Yes, JSX is the source.'),
  ),
);

/** Scenario 5b — the SAME FAQ with a real toggle: onClick flips state. */
export const PAGE_FAQ_WIRED = pageFile(
  faqSection(
    faqItem(1, 'What is Revyme?', 'A visual builder.', ` onClick={() => setOpenFaq(!openFaq)}`) +
      faqItem(2, 'Is it code?', 'Yes, JSX is the source.', ` onClick={() => setOpenFaq(!openFaq)}`),
  ),
);

/** Scenario 5c — a handler that can never do anything: dead wiring = NOOP. */
export const PAGE_FAQ_DEAD = pageFile(
  faqSection(faqItem(1, 'What is Revyme?', 'A visual builder.', ` onClick={() => {}}`)),
);

const CTA_REQUEST = 'Add a CTA button that goes to the pricing page.';

/** Scenario 6 — a CTA-looking DIV with no href/onClick: static = FAKE. */
export const PAGE_CTA_STATIC = pageFile(`
      <div data-id="cta" data-name="CTA" style={{ position: 'relative', flex: '0 0 auto', order: '1', padding: '14px 36px', backgroundColor: '#6366f1', color: '#ffffff', borderRadius: '8px', cursor: 'pointer' }}>Get Started</div>`);

/** Scenario 6b — the CTA with a real href → wired. */
export const PAGE_CTA_LINK = pageFile(`
      <a data-id="cta" data-name="CTA" href="/pricing" style={{ position: 'relative', flex: '0 0 auto', order: '1', padding: '14px 36px', backgroundColor: '#6366f1', color: '#ffffff', borderRadius: '8px', cursor: 'pointer' }}>Get Started</a>`);

/** Scenario 6c — onclick exists but drags nowhere: href="#" = NOOP. */
export const PAGE_CTA_DEAD_LINK = pageFile(`
      <a data-id="cta" data-name="CTA" href="#" style={{ position: 'relative', flex: '0 0 auto', order: '1', padding: '14px 36px', backgroundColor: '#6366f1', color: '#ffffff', borderRadius: '8px', cursor: 'pointer' }}>Get Started</a>`);

const heroSection = (inner: string) => `
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '24px', padding: '120px 40px' }}>
        <p data-id="hero-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '56px' }}>Build the future, visually.</p>
${inner}
      </div>`;

const MOTION_REQUEST =
  'Add motion to the hero section — it should fade in and slide up when it scrolls into view.';

/** Scenario 7 — motion asked, nothing motion-like present = ABSENT. */
export const PAGE_MOTION_ABSENT = pageFile(heroSection(''));

/** Scenario 7b — a real whileInView appear → wired. */
export const PAGE_MOTION_APPEAR = pageFile(
  heroSection(`
        <p data-id="hero-sub" data-name="Subtitle" initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '18px' }}>A code-first editor.</p>`),
);

/** Scenario 7c — a bare animate= for a scroll-into-view ask = MIS-SCOPED. */
export const PAGE_MOTION_BARE_ANIMATE = pageFile(
  heroSection(`
        <p data-id="hero-sub" data-name="Subtitle" animate={{ opacity: 1 }} style={{ position: 'relative', flex: '0 0 auto', order: '1', fontSize: '18px' }}>A code-first editor.</p>`),
);

const formSection = (formAttrs: string) => `
      <div data-id="form" data-name="Form" style={{ position: 'relative', flex: '0 0 auto', order: '1', display: 'flex', flexDirection: 'column', gap: '16px', width: '420px', padding: '80px 40px' }}>
        <form data-id="form-element" data-name="Form"${formAttrs} style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input data-id="form-name" data-name="Name" name="name" placeholder="Your name" style={{ position: 'relative', flex: '0 0 auto', order: '0' }} />
          <button data-id="form-submit" data-name="Submit" style={{ position: 'relative', flex: '0 0 auto', order: '1', padding: '12px 28px' }}>Send</button>
        </form>
      </div>`;

const FORM_REQUEST = 'Add a contact form that can actually submit (name + email + send).';

/** Scenario 8 — a plain <form> that cannot submit = NOOP. */
export const PAGE_FORM_NOOP = pageFile(formSection(''));

/** Scenario 8b — the same form wired with onSubmit → wired. */
export const PAGE_FORM_WIRED = pageFile(
  formSection(` onSubmit={(e) => { e.preventDefault(); window.location.href = '/thanks'; }}`),
);

// ─── Spec derivation (pure) ─────────────────────────────────────────────────

describe('deriveSpec', () => {
  it('parses the request prose: concept, count range, unit and key texts', () => {
    const spec = deriveSpec(REQUEST);
    expect(spec).not.toBeNull();
    expect(spec!.concept).toBe('testimonial');
    expect(spec!.label).toBe('testimonials');
    expect(spec!.count).toEqual({ min: 2, max: 3, exact: false });
    expect(spec!.unitLabel).toBe('cards');
    expect(spec!.keyTexts.map((k) => k.label)).toEqual(['quote', 'author/name']);
  });

  it('honours an "exactly N" count as a hard equality', () => {
    const spec = deriveSpec('Add a pricing section with exactly three tiers, each with a price and a description.');
    expect(spec!.concept).toBe('pricing');
    expect(spec!.count).toEqual({ min: 3, max: 3, exact: true });
    expect(spec!.unitLabel).toBe('tiers');
    expect(spec!.keyTexts.map((k) => k.label)).toEqual(['description', 'price']);
  });

  it('hints win over prose (expected_roles / expected_count / key_texts)', () => {
    const spec = deriveSpec('i want the block about companies', {
      expected_roles: ['testimonials', 'quote', 'author'],
      expected_count: 3,
      key_texts: ['quote'],
    });
    expect(spec!.concept).toBe('testimonial');
    expect(spec!.count).toEqual({ min: 3, max: 3, exact: true });
    expect(spec!.keyTexts.map((k) => k.label)).toEqual(['quote']);
    expect(spec!.cardMatchers).toHaveLength(3);
  });

  it('word-number spans work ("two or three")', () => {
    const spec = deriveSpec('Add a testimonials section with two or three cards.');
    expect(spec!.count).toEqual({ min: 2, max: 3, exact: false });
  });

  it('returns null when no entity is decidable', () => {
    expect(deriveSpec('make it pop')).toBeNull();
  });

  it('detects a required mechanism for interactive roles (request prose)', () => {
    const faq = deriveSpec('Add an FAQ section with questions and their answers.');
    expect(faq!.mechanism).not.toBeNull();
    expect(faq!.mechanism!.label).toBe('FAQ/accordion toggle');

    const cta = deriveSpec(CTA_REQUEST);
    expect(cta!.mechanism!.label).toBe('CTA mechanism');
    expect(cta!.concept).toBe('cta');

    const form = deriveSpec(FORM_REQUEST);
    expect(form!.mechanism!.label).toBe('form submit');
    expect(form!.concept).toBe('form');

    const motion = deriveSpec(MOTION_REQUEST);
    expect(motion!.mechanism!.label).toBe('motion');
    expect(motion!.concept).toBe('hero');
  });

  it('a non-interactive request derives NO mechanism requirement', () => {
    const spec = deriveSpec(REQUEST);
    expect(spec!.mechanism).toBeNull();
    const pricing = deriveSpec('Add a pricing section with exactly three tiers, each with a price and a description.');
    expect(pricing!.mechanism).toBeNull();
  });

  it('expected_mechanism hint forces the requirement even when prose is silent', () => {
    const spec = deriveSpec('Add a block that opens and closes on click', {
      expected_roles: ['target'],
      expected_mechanism: ['onClick', 'useState'],
    });
    expect(spec!.mechanism).not.toBeNull();
    // parser-based: kind + tokens instead of RegExp source of truth
    expect(spec!.mechanism!.kind).toBe('expected');
    expect(spec!.mechanism!.expectedTokens).toEqual(expect.arrayContaining(['onClick', 'useState']));
    // AST verdict: wired when mechanism present, fake when absent
    const withMech = verifyEffect(
      pageFile(`      <div data-id="target" data-name="Target" onClick={() => setOpen(true)} style={{ position: 'relative' }}>Hello</div>`),
      'Add a block that opens and closes on click',
      { expected_roles: ['target'], expected_mechanism: ['onClick', 'useState'] },
    );
    expect(withMech.states[0]).toMatchObject({ label: 'expected mechanism', state: 'wired' });
    expect(withMech.satisfied).toBe(true);
    const withoutMech = verifyEffect(
      pageFile(`      <div data-id="target" data-name="Target" style={{ position: 'relative' }}>Hello</div>`),
      'Add a block that opens and closes on click',
      { expected_roles: ['target'], expected_mechanism: ['onClick', 'useState'] },
    );
    expect(withoutMech.states[0]).toMatchObject({ label: 'expected mechanism', state: 'fake' });
    expect(withoutMech.satisfied).toBe(false);
  });
});

// ─── Scanner sanity (the engine's only dependency) ──────────────────────────

describe('scanElements / isFilled', () => {
  it('finds sections, cards and leaves with lowercased roles', () => {
    const els = scanElements(PAGE_FILLED);
    const roles = els.map(elementRole);
    expect(roles).toContain('testimonials testimonials');
    expect(roles).toContain('testimonial-1 card');
    expect(roles).toContain('testimonial-1-quote quote');
    expect(isFilled(els.find((e) => e.id === 'testimonial-1-quote')!)).toBe(true);
  });

  it('an empty leaf is NOT filled (the n1-rich lesson)', () => {
    const els = scanElements(PAGE_EMPTY_QUOTE);
    expect(isFilled(els.find((e) => e.id === 'testimonial-1-quote')!)).toBe(false);
    expect(isFilled(els.find((e) => e.id === 'testimonial-2-quote')!)).toBe(true);
  });
});

// ─── The verdict engine ─────────────────────────────────────────────────────

describe('verifyEffect', () => {
  it('1. section created + content filled → satisfied: true', () => {
    const verdict = verifyEffect(PAGE_FILLED, REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.missing).toEqual([]);
    expect(verdict.checks).toEqual([
      { label: 'testimonials section', present: true, filled: 1, count: 1, required: '1' },
      { label: 'testimonials cards', present: true, filled: 2, count: 2, required: '2-3' },
      { label: 'cards quote', present: true, filled: 2, count: 2, required: 'every card' },
      { label: 'cards author/name', present: true, filled: 2, count: 2, required: 'every card' },
    ]);
    expect(verdict.feedback).toContain('Request satisfied');
  });

  it('2. section created but text empty → satisfied: false, content is missing', () => {
    const verdict = verifyEffect(PAGE_EMPTY_QUOTE, REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toEqual([
      'testimonial-1 quote is empty — add the quote text.',
    ]);
    // The cards check counts the STRUCTURE (2 cards exist) but only 1 is filled.
    const cardsCheck = verdict.checks.find((c) => c.label === 'testimonials cards');
    expect(cardsCheck).toMatchObject({ present: true, count: 2, filled: 1 });
    const quoteCheck = verdict.checks.find((c) => c.label === 'cards quote');
    expect(quoteCheck).toMatchObject({ filled: 1, count: 2 });
    expect(verdict.feedback).toMatch(/empty/i);
    expect(verdict.feedback).toMatch(/fill it/i);
  });

  it('3. partially filled (2/3) → satisfied: false, naming the empty card', () => {
    const verdict = verifyEffect(PAGE_PARTIAL, REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toEqual([
      'testimonial-2 quote is empty — add the quote text.',
    ]);
    expect(verdict.feedback).toBe(
      'Structure exists but 1 quote is empty — fill it, then verify again.',
    );
    const cardsCheck = verdict.checks.find((c) => c.label === 'testimonials cards');
    expect(cardsCheck).toMatchObject({ present: true, count: 3, filled: 2 });
  });

  it('4. decorative/voluntary spacers are NOT falsely flagged', () => {
    const verdict = verifyEffect(PAGE_WITH_DECOR, REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.missing).toEqual([]);
    // The empty spacer nor the filled decoration ever become cards.
    const cardsCheck = verdict.checks.find((c) => c.label === 'testimonials cards');
    expect(cardsCheck!.count).toBe(2);
    expect(verdict.feedback).toContain('Request satisfied');
  });

  it('a leaf is never a card: title/quote/author leaves do not inflate the count', () => {
    const verdict = verifyEffect(PAGE_FILLED, REQUEST);
    expect(verdict.checks.find((c) => c.label === 'testimonials cards')!.count).toBe(2);
  });

  it('no section → not satisfied with an actionable missing entry', () => {
    const verdict = verifyEffect(PAGE_NO_SECTION, REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing[0]).toMatch(/No testimonials section found/i);
    expect(verdict.feedback).toMatch(/No testimonials section found/i);
    expect(verdict.checks).toEqual([
      { label: 'testimonials section', present: false, filled: 0, count: 0, required: '1' },
    ]);
  });

  it('undecidable request → informative not-satisfied verdict, never a throw', () => {
    const verdict = verifyEffect(PAGE_FILLED, 'make it pop');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing[0]).toMatch(/expected_roles/i);
  });

  it('empty code → informative not-satisfied verdict, never a throw', () => {
    const verdict = verifyEffect('', REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.feedback).toMatch(/empty/i);
  });

  it('hyphenated section ids match (S1 deepseek: hero-section/faq-section invisibles) — P3-F2c', () => {
    // The id convention teaches hyphenated ids ("hero-section") — the section
    // matcher must treat "-" as a concept boundary, like space/end.
    const page = pageFile(`
      <div data-id="hero-section" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', padding: '80px 40px' }}>
        <p data-id="hero-section-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0', fontSize: '56px' }}>Build the future.</p>
      </div>`);
    const verdict = verifyEffect(page, 'Add a hero section with a title.', { expected_roles: ['hero', 'title'] });
    const sectionCheck = verdict.checks.find((c) => c.label === 'hero section');
    expect(sectionCheck).toMatchObject({ present: true });
    expect(verdict.missing.join(' ')).not.toMatch(/No hero section found/i);
  });

  it('hyphenated ids do not over-match (heron-1 ≠ hero, heroes-list ≠ hero)', () => {
    const page = pageFile(`
      <div data-id="heron-1" data-name="Heron" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>
        <p data-id="heron-1-title" data-name="Title" style={{ position: 'relative', flex: '0 0 auto', order: '0' }}>A bird.</p>
      </div>`);
    const verdict = verifyEffect(page, 'Add a hero section with a title.', { expected_roles: ['hero', 'title'] });
    expect(verdict.missing.join(' ')).toMatch(/No hero section found/i);
  });
});

// ─── Chantier B — mechanism checks: wired | fake | noop | mis-scoped | absent ──

const FAQ_REQUEST = 'Add an FAQ section with questions and their answers.';

describe('verifyEffect — interactive mechanisms (Chantier B)', () => {
  it('5. FAQ with "+" icons but NO handler → not satisfied, FAKE, actionable feedback', () => {
    const verdict = verifyEffect(PAGE_FAQ_FAKE, FAQ_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states).toEqual([
      { label: 'FAQ/accordion toggle', state: 'fake', fixHint: expect.any(String) },
    ]);
    const mechCheck = verdict.checks.find((c) => c.label === 'FAQ/accordion toggle');
    expect(mechCheck).toMatchObject({ present: true, filled: 0, count: 1, state: 'fake' });
    expect(verdict.missing.join(' ')).toMatch(/visual-only/i);
    expect(verdict.missing.join(' ')).toMatch(/toggle|onClick|variant/i);
    expect(verdict.feedback).toMatch(/visual-only: no real mechanism found/i);
    expect(verdict.feedback).toMatch(/addPageInteraction|set_variant/i);
  });

  it('5b. FAQ with an onClick toggle → satisfied: true, wired', () => {
    const verdict = verifyEffect(PAGE_FAQ_WIRED, FAQ_REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states).toEqual([
      { label: 'FAQ/accordion toggle', state: 'wired', fixHint: expect.any(String) },
    ]);
    const mechCheck = verdict.checks.find((c) => c.label === 'FAQ/accordion toggle');
    expect(mechCheck).toMatchObject({ present: true, filled: 1, state: 'wired' });
    expect(verdict.missing).toEqual([]);
    expect(verdict.feedback).toContain('Request satisfied');
  });

  it('5c. FAQ with a dead handler (onClick={() => {}}) → not satisfied, NOOP', () => {
    const verdict = verifyEffect(PAGE_FAQ_DEAD, FAQ_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'FAQ/accordion toggle', state: 'noop' });
    expect(verdict.feedback).toMatch(/not wired/i);
  });

  it('6. static CTA div without href/onClick → not satisfied, FAKE', () => {
    const verdict = verifyEffect(PAGE_CTA_STATIC, CTA_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'CTA mechanism', state: 'fake' });
    expect(verdict.missing.join(' ')).toMatch(/static/i);
    expect(verdict.missing.join(' ')).toMatch(/href/i);
    expect(verdict.missing.join(' ')).toMatch(/onClick/i);
  });

  it('6b. CTA with a real href → satisfied: true, wired', () => {
    const verdict = verifyEffect(PAGE_CTA_LINK, CTA_REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states[0]).toMatchObject({ label: 'CTA mechanism', state: 'wired' });
    expect(verdict.missing).toEqual([]);
  });

  it('6c. CTA with href="#" → not satisfied, NOOP (dead link)', () => {
    const verdict = verifyEffect(PAGE_CTA_DEAD_LINK, CTA_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'CTA mechanism', state: 'noop' });
    expect(verdict.feedback).toMatch(/not wired/i);
  });

  it('7. motion requested, hero has none → not satisfied, ABSENT', () => {
    const verdict = verifyEffect(PAGE_MOTION_ABSENT, MOTION_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states).toEqual([
      { label: 'motion', state: 'absent', fixHint: expect.any(String) },
    ]);
    expect(verdict.missing.join(' ')).toMatch(/No motion in the file/i);
    expect(verdict.missing.join(' ')).toMatch(/whileInView|whileHover|whileTap/i);
    expect(verdict.feedback).toMatch(/No motion/i);
  });

  it('7b. motion present (whileInView appear) → satisfied: true, wired', () => {
    const verdict = verifyEffect(PAGE_MOTION_APPEAR, MOTION_REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states[0]).toMatchObject({ label: 'motion', state: 'wired' });
    expect(verdict.missing).toEqual([]);
  });

  it('7c. bare animate= for a scroll-into-view ask → not satisfied, MIS-SCOPED', () => {
    const verdict = verifyEffect(PAGE_MOTION_BARE_ANIMATE, MOTION_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'motion', state: 'mis-scoped' });
    expect(verdict.feedback).toMatch(/mis-scoped/i);
    expect(verdict.feedback).toMatch(/whileInView/i);
  });

  it('8. form without onSubmit → not satisfied, NOOP', () => {
    const verdict = verifyEffect(PAGE_FORM_NOOP, FORM_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'form submit', state: 'noop' });
    expect(verdict.missing.join(' ')).toMatch(/onSubmit/i);
    expect(verdict.feedback).toMatch(/no-op|not wired/i);
  });

  it('8b. form with onSubmit → satisfied: true, wired', () => {
    const verdict = verifyEffect(PAGE_FORM_WIRED, FORM_REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states[0]).toMatchObject({ label: 'form submit', state: 'wired' });
    expect(verdict.missing).toEqual([]);
  });

  it('9. non-regression: decorative content is NOT a mechanism provider — no false "fake"', () => {
    // The 4 original scenarios keep their behavior: testimonials is not
    // interactive, so no mechanism is required and states stays empty — the
    // empty spacer and the "+"-ish filled decoration never trigger one.
    expect(verifyEffect(PAGE_FILLED, REQUEST).states).toEqual([]);
    expect(verifyEffect(PAGE_EMPTY_QUOTE, REQUEST).states).toEqual([]);
    expect(verifyEffect(PAGE_PARTIAL, REQUEST).states).toEqual([]);
    const decor = verifyEffect(PAGE_WITH_DECOR, REQUEST);
    expect(decor.satisfied).toBe(true);
    expect(decor.states).toEqual([]);
    expect(decor.checks).toHaveLength(4);
  });

  it('9b. a section that does not exist at all → absent (structure AND mechanism)', () => {
    const verdict = verifyEffect(PAGE_NO_SECTION, FAQ_REQUEST);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'FAQ/accordion toggle', state: 'absent' });
    expect(verdict.missing[0]).toMatch(/No faqs? section found/i);
  });

  it('10. expected_mechanism hint forces the mechanism bar on a silent request', () => {
    const staticBlock = pageFile(`
      <div data-id="target" data-name="Target" style={{ position: 'relative', flex: '0 0 auto', order: '1' }}>Hello</div>`);
    const hints = { expected_roles: ['target'], expected_mechanism: ['onClick', 'useState'] };
    const unwired = verifyEffect(staticBlock, 'Add a block that opens and closes on click', hints);
    expect(unwired.satisfied).toBe(false);
    expect(unwired.states[0]).toMatchObject({ label: 'expected mechanism', state: 'fake' });

    const wired = verifyEffect(
      staticBlock.replace('<div data-id="target"', '<div data-id="target" onClick={() => setOpen(true)}'),
      'Add a block that opens and closes on click',
      hints,
    );
    expect(wired.satisfied).toBe(true);
    expect(wired.states[0]).toMatchObject({ label: 'expected mechanism', state: 'wired' });
  });
});

// ─── The tool against REAL ProjectFS ────────────────────────────────────────

describe('verifyEffectTool', () => {
  let preTest: ReturnType<typeof projectFS.getSnapshot>;

  beforeEach(() => {
    preTest = projectFS.getSnapshot();
  });

  afterEach(() => {
    projectFS.loadSnapshot(preTest);
  });

  it('reads the active file through ProjectFS and returns the verdict (filled → true)', async () => {
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE_FILLED]]));
    const result = await verifyEffectTool.execute({ request: REQUEST }, {} as never);
    expect(result.isError).toBeUndefined();
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.scope).toBe('app/page.client.tsx');
    expect(verdict.missing).toEqual([]);
  });

  it('the tool verdict is false when the snapshot has an empty quote (P4 real case)', async () => {
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE_EMPTY_QUOTE]]));
    const result = await verifyEffectTool.execute({ request: REQUEST }, {} as never);
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toEqual(['testimonial-1 quote is empty — add the quote text.']);
  });

  it('passes through the expected_roles / expected_count / key_texts hints', async () => {
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE_PARTIAL]]));
    const result = await verifyEffectTool.execute(
      { request: 'make it like the other sites', expected_roles: ['testimonials', 'quote', 'author'], expected_count: 3, key_texts: ['quote', 'author'] },
      {} as never,
    );
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(false);
    // No unit word in the request → the count check is labelled with the default unit.
    expect(verdict.checks.find((c: { label: string }) => c.label === 'testimonials items')).toMatchObject({ count: 3 });
  });

  it('rejects a call without a request (fail, not a verdict)', async () => {
    const result = await verifyEffectTool.execute({}, {} as never);
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as any).text).error).toMatch(/Missing request/);
  });

  it('empty project → informative verdict (no crash, no false satisfied)', async () => {
    projectFS.loadSnapshot(new Map());
    const result = await verifyEffectTool.execute({ request: REQUEST }, {} as never);
    expect(result.isError).toBeUndefined();
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing[0]).toMatch(/active file is empty/i);
  });

  it('through ProjectFS: an FAQ with only "+" icons reads as fake, not satisfied', async () => {
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE_FAQ_FAKE]]));
    const result = await verifyEffectTool.execute({ request: FAQ_REQUEST }, {} as never);
    expect(result.isError).toBeUndefined();
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.states[0]).toMatchObject({ label: 'FAQ/accordion toggle', state: 'fake' });
    expect(verdict.scope).toBe('app/page.client.tsx');
    expect(verdict.feedback).toMatch(/visual-only/i);
  });

  it('through ProjectFS: a CTA with a real href reads as wired and satisfied', async () => {
    projectFS.loadSnapshot(new Map([['app/page.client.tsx', PAGE_CTA_LINK]]));
    const result = await verifyEffectTool.execute({ request: CTA_REQUEST }, {} as never);
    expect(result.isError).toBeUndefined();
    const verdict = JSON.parse((result.content[0] as any).text);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states[0]).toMatchObject({ label: 'CTA mechanism', state: 'wired' });
    expect(verdict.missing).toEqual([]);
  });
});

// ─── P2.3a — IDS mode (node_ids additif, parser-based) ─────────────────────
// ADDITIONS ONLY — no existing test touched.

describe('verifyEffect — node_ids IDS mode (P2.3a additif)', () => {
  const IDS_PAGE_REAL = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', display: 'flex', flexDirection: 'column', padding: '80px 40px' }}>
        <p data-id="hero-title" data-name="Title" style={{ position: 'relative' }}>Hello World</p>
        <a data-id="hero-cta" data-name="CTA" href="/pricing" style={{ position: 'relative', padding: '14px 36px' }}>Get Started</a>
        <button data-id="hero-btn" data-name="Button" onClick={() => setOpen(true)} style={{ position: 'relative', padding: '12px 24px' }}>Click me</button>
      </div>`);
  const IDS_PAGE_EMPTY_TEXT = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative' }}>
        <p data-id="empty-node" data-name="Text" style={{ position: 'relative' }}></p>
        <div data-id="filled-node" data-name="Text" style={{ position: 'relative' }}>Some text</div>
      </div>`);
  const IDS_PAGE_INERT = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative' }}>
        <button data-id="btn-empty" data-name="Button" onClick={() => {}} style={{ position: 'relative' }}>Click</button>
        <a data-id="link-hash" data-name="Link" href="#" style={{ position: 'relative' }}>Link</a>
        <div data-id="static-node" data-name="Box" style={{ position: 'relative' }}>Static</div>
      </div>`);
  const IDS_PAGE_EXISTS_ONLY = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative' }}>
        <div data-id="exists-only" data-name="Box" style={{ position: 'relative' }}></div>
      </div>`);

  it('ids: element present + filled + real mechanism → satisfied, jamais absent', () => {
    const verdict = verifyEffect(IDS_PAGE_REAL, 'verify ids', { node_ids: ['hero-cta', 'hero-btn'], checks: ['exists', 'filled', 'mechanism'] }, 'app/page.client.tsx');
    expect(verdict.satisfied).toBe(true);
    expect(verdict.concept).toBe('node-ids');
    expect(verdict.scope).toBe('app/page.client.tsx');
    expect(verdict.missing).toEqual([]);
    expect(verdict.states).toHaveLength(2);
    expect(verdict.states.every((s) => s.state === 'wired')).toBe(true);
    // present ⇒ jamais déclaré absent
    expect(verdict.checks.every((c) => c.present === true)).toBe(true);
    expect(verdict.feedback).toMatch(/Request satisfied/);
  });

  it('ids: id absent du code → missing explicite avec l\'id nommé (pas de faux positif)', () => {
    const verdict = verifyEffect(IDS_PAGE_REAL, 'verify ids', { node_ids: ['hero-title', 'missing-id'], checks: ['exists'] }, 'app/page.client.tsx');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.concept).toBe('node-ids');
    expect(verdict.missing.join(' ')).toMatch(/missing-id/);
    expect(verdict.missing.join(' ')).not.toMatch(/hero-title.*Missing/);
    expect(verdict.checks.find((c) => c.label === 'hero-title exists')!.present).toBe(true);
    expect(verdict.checks.find((c) => c.label === 'missing-id exists')!.present).toBe(false);
    expect(verdict.feedback).toMatch(/missing-id/);
  });

  it('ids: `filled` sur texte vide → missing', () => {
    const verdict = verifyEffect(IDS_PAGE_EMPTY_TEXT, 'verify ids', { node_ids: ['empty-node'], checks: ['filled'] }, '');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing[0]).toMatch(/empty-node.*empty/i);
    expect(verdict.checks[0]).toMatchObject({ label: 'empty-node filled', present: false });
    // le voisin rempli passe
    const ok = verifyEffect(IDS_PAGE_EMPTY_TEXT, 'verify ids', { node_ids: ['filled-node'], checks: ['filled'] }, '');
    expect(ok.satisfied).toBe(true);
    expect(ok.missing).toEqual([]);
  });

  it('ids: `mechanism` sur onClick={() => {}} / href="#" → non fonctionnel (noop/fake)', () => {
    const emptyHandler = verifyEffect(IDS_PAGE_INERT, 'verify ids', { node_ids: ['btn-empty'], checks: ['mechanism'] }, '');
    expect(emptyHandler.satisfied).toBe(false);
    expect(emptyHandler.states[0]).toMatchObject({ label: 'btn-empty', state: 'noop' });
    expect(emptyHandler.missing[0]).toMatch(/not wired|empty handler|href/i);

    const hashLink = verifyEffect(IDS_PAGE_INERT, 'verify ids', { node_ids: ['link-hash'], checks: ['mechanism'] }, '');
    expect(hashLink.satisfied).toBe(false);
    expect(hashLink.states[0]).toMatchObject({ label: 'link-hash', state: 'noop' });

    const staticNode = verifyEffect(IDS_PAGE_INERT, 'verify ids', { node_ids: ['static-node'], checks: ['mechanism'] }, '');
    expect(staticNode.satisfied).toBe(false);
    expect(staticNode.states[0]).toMatchObject({ label: 'static-node', state: 'fake' });
    expect(staticNode.missing[0]).toMatch(/static/i);
  });

  it('ids: `exists` seul (défaut) sur nœud présent → satisfied même sans texte', () => {
    const verdict = verifyEffect(IDS_PAGE_EXISTS_ONLY, 'verify ids', { node_ids: ['exists-only'] }, '');
    expect(verdict.satisfied).toBe(true);
    expect(verdict.concept).toBe('node-ids');
    expect(verdict.missing).toEqual([]);
    // pas de check filled demandé → le texte vide n'est pas bloquant
    expect(verdict.checks).toEqual([{ label: 'exists-only exists', present: true, filled: 1, count: 1, required: '1' }]);
    expect(verdict.feedback).toMatch(/Request satisfied/);
  });

  it('ids: défaut checks = ["exists"] quand non fourni', () => {
    const verdict = verifyEffect(IDS_PAGE_EXISTS_ONLY, 'verify ids', { node_ids: ['exists-only'] }, '');
    expect(verdict.checks).toHaveLength(1);
    expect(verdict.checks[0].label).toBe('exists-only exists');
  });

  it('ids: through verifyEffectTool + ProjectFS → IDS path is used and respects scope', async () => {
    let pre = projectFS.getSnapshot();
    try {
      projectFS.loadSnapshot(new Map([['app/page.client.tsx', IDS_PAGE_REAL]]));
      const result = await verifyEffectTool.execute(
        { request: 'verify ids', node_ids: ['hero-cta'], checks: ['exists', 'filled', 'mechanism'] },
        {} as never,
      );
      expect(result.isError).toBeUndefined();
      const verdict = JSON.parse((result.content[0] as any).text);
      expect(verdict.satisfied).toBe(true);
      expect(verdict.concept).toBe('node-ids');
      expect(verdict.scope).toBe('app/page.client.tsx');
      expect(verdict.missing).toEqual([]);
    } finally {
      projectFS.loadSnapshot(pre);
    }
  });
});

// ─── P2.3b — Concept-AST mode (additif) ───────────────────────────────────
// ADDITIONS ONLY — no existing test touched.

describe('verifyEffect — concept-AST mode (P2.3b additif)', () => {
  it('CONCEPT_SYNONYMS table is explicit and extensible', () => {
    expect(CONCEPT_SYNONYMS).toBeDefined();
    expect(getConceptSynonymGroup).toBeDefined();
    // canonical -> synonyms, synonym -> canonical (bidirectional)
    expect(CONCEPT_SYNONYMS['testimonial']).toEqual(expect.arrayContaining(['review', 'quote']));
    expect(CONCEPT_SYNONYMS['hero']).toEqual(expect.arrayContaining(['banner', 'header']));
    expect(CONCEPT_SYNONYMS['faq']).toEqual(expect.arrayContaining(['accordion']));
    expect(CONCEPT_SYNONYMS['gallery']).toEqual(expect.arrayContaining(['grid', 'photos']));
    expect(CONCEPT_SYNONYMS['pricing']).toEqual(expect.arrayContaining(['tarifs', 'plans']));
    // bidirectional helper
    expect(getConceptSynonymGroup('review')).toEqual(expect.arrayContaining(['testimonial', 'review']));
    expect(getConceptSynonymGroup('banner')).toEqual(expect.arrayContaining(['hero', 'banner']));
    expect(getConceptSynonymGroup('accordion')).toEqual(expect.arrayContaining(['faq', 'accordion']));
  });

  it('concept avec synonyme (« testimonials block » trouve la section testimonials) via AST', () => {
    // PAGE_FILLED contains a testimonials section with 2 filled cards.
    // Request uses "reviews block" (synonym of testimonials) — regex "X section" would miss, AST must find via synonyms.
    const verdictReviews = verifyEffect(PAGE_FILLED, 'Add a reviews block with 2-3 cards, each with a quote and the name of the person.');
    expect(verdictReviews.satisfied).toBe(true);
    // concept should be resolved (canonical or synonym) and section found via AST
    expect(['testimonial', 'review'].includes(verdictReviews.concept)).toBe(true);
    expect(verdictReviews.checks.some((c) => c.label.includes('section') && c.present)).toBe(true);

    // "testimonials block" phrase (block instead of section) also via AST discovery
    const verdictBlock = verifyEffect(PAGE_FILLED, 'Add a testimonials block with 2-3 cards, each with a quote and the name of the person.');
    expect(verdictBlock.satisfied).toBe(true);
    expect(verdictBlock.checks.some((c) => c.label.includes('section') && c.present)).toBe(true);

    // Direct AST engine also finds via synonym
    const direct = verifyEffectConceptAST(PAGE_FILLED, 'Add a reviews block with 2-3 cards, each with a quote and the name of the person.');
    expect(direct.satisfied).toBe(true);
    expect(direct.checks.some((c) => c.label.includes('section') && c.present)).toBe(true);

    // hero synonym: banner/header -> hero section
    const heroPage = pageFile(`
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', padding: '80px 40px' }}>
        <p data-id="hero-title" data-name="Title" style={{ position: 'relative' }}>Hello</p>
      </div>`);
    const bannerVerdict = verifyEffect(heroPage, 'Add a banner block');
    // hero section should be found via banner synonym (or at least not no-concept)
    // For a simple existence check without count/keyTexts, any present section is satisfied (unless mechanism required)
    expect(bannerVerdict.concept).not.toBe('');
    expect(bannerVerdict.satisfied).toBe(true);
  });

  it('concept introuvable ni en AST ni en regex → no-concept (comportement existant préservé)', () => {
    const verdict = verifyEffect(PAGE_FILLED, 'make it pop');
    expect(verdict.satisfied).toBe(false);
    expect(verdict.concept).toBe('');
    expect(verdict.missing[0]).toMatch(/expected_roles/i);
    expect(verdict.checks).toEqual([]);

    const direct = verifyEffectConceptAST(PAGE_FILLED, 'make it pop');
    expect(direct.satisfied).toBe(false);
    expect(direct.concept).toBe('');
    expect(direct.missing[0]).toMatch(/expected_roles/i);

    // also with empty code
    const empty = verifyEffect('', 'make it pop');
    expect(empty.satisfied).toBe(false);
    expect(empty.concept).toBe('');
  });

  it('trace mode concept-ast is observable, no-concept via concept-ast (regex removed)', () => {
    const calls: any[] = [];
    const orig = trace.fn.bind(trace);
    const spy = (...args: any[]) => {
      calls.push(args);
      return (orig as any)(...args);
    };
    (trace as any).fn = spy;
    try {
      calls.length = 0;
      verifyEffect(PAGE_FILLED, 'Add a reviews block with 2-3 cards, each with a quote and the name of the person.');
      const astCall = calls.find((c) => c[0] === 'verify:mode' && c[1]?.mode === 'concept-ast');
      expect(astCall).toBeDefined();

      calls.length = 0;
      verifyEffect(PAGE_FILLED, 'make it pop');
      const noConceptCall = calls.find((c) => c[0] === 'verify:mode' && c[1]?.mode === 'concept-ast' && c[1]?.result === 'no-concept');
      expect(noConceptCall).toBeDefined();
      const regexCall = calls.find((c) => c[0] === 'verify:mode' && c[1]?.mode === 'concept-regex');
      expect(regexCall).toBeUndefined();
    } finally {
      (trace as any).fn = orig;
    }
  });

  it('expected_roles / expected_count / key_texts conservés via AST', () => {
    const verdict = verifyEffectConceptAST(PAGE_FILLED, 'Add a reviews block', {
      expected_roles: ['testimonials', 'quote', 'author'],
      expected_count: 2,
      key_texts: ['quote', 'author'],
    });
    expect(verdict.satisfied).toBe(true);
    expect(verdict.checks.some((c) => c.label.includes('section'))).toBe(true);
    expect(verdict.checks.some((c) => c.label.includes('quote'))).toBe(true);
  });
});
// ─── P6 (iv) — ids infaillibles + wired ─────────────────────────────────────
// Pre-P6 false negatives: dynamic expressions / instance props / textish
// props read as EMPTY; prefixed ids (`page-testimonials`) never matched;
// dynamic data-ids failed silently. The `wired` state replaces `functional`.

describe('verifyEffect P6 (iv) — infallible ids + wired', () => {
  const IDS_PAGE_DYNAMIC = pageFile(`
      <div data-id="dyn" data-name="Dynamic" style={{ position: 'relative' }}>
        <p data-id="dyn-quote" data-name="Quote" style={{ position: 'relative' }}>{item.quote}</p>
        <p data-id="dyn-empty" data-name="Text" style={{ position: 'relative' }}>{null}</p>
        <p data-id="dyn-blank" data-name="Text" style={{ position: 'relative' }}>{''}</p>
        <input data-id="dyn-input" data-name="Email" placeholder="you@example.com" style={{ position: 'relative' }} />
      </div>`);
  const IDS_PAGE_EXPR_ID = pageFile(`
      <div data-id="dyn" data-name="Dynamic" style={{ position: 'relative' }}>
        <p data-id={item.id} data-name="Text" style={{ position: 'relative' }}>Hello</p>
      </div>`);
  const PREFIXED_PAGE = pageFile(`
      <div data-id="page-testimonials" data-name="Testimonials" style={{ position: 'relative' }}>
        <div data-id="page-testimonials-1" data-name="Card" style={{ position: 'relative' }}>
          <p data-id="page-testimonials-1-quote" data-name="Quote" style={{ position: 'relative' }}>Great.</p>
          <p data-id="page-testimonials-1-author" data-name="Author" style={{ position: 'relative' }}>Ann</p>
        </div>
        <div data-id="page-testimonials-2" data-name="Card" style={{ position: 'relative' }}>
          <p data-id="page-testimonials-2-quote" data-name="Quote" style={{ position: 'relative' }}>Super.</p>
          <p data-id="page-testimonials-2-author" data-name="Author" style={{ position: 'relative' }}>Bob</p>
        </div>
      </div>`);
  const CMS_PAGE = pageFile(`
      <div data-id="testimonials" data-name="Testimonials" style={{ position: 'relative' }}>
        <div data-id="testimonials-1" data-name="Card" style={{ position: 'relative' }}>
          <p data-id="testimonials-1-quote" data-name="Quote" style={{ position: 'relative' }}>{item.quote}</p>
          <p data-id="testimonials-1-author" data-name="Author" style={{ position: 'relative' }}>{item.author}</p>
        </div>
        <div data-id="testimonials-2" data-name="Card" style={{ position: 'relative' }}>
          <p data-id="testimonials-2-quote" data-name="Quote" style={{ position: 'relative' }}>{item.quote}</p>
          <p data-id="testimonials-2-author" data-name="Author" style={{ position: 'relative' }}>{item.author}</p>
        </div>
      </div>`);

  it('ids/filled: {item.quote} counts as filled (the CMS pattern)', () => {
    const verdict = verifyEffect(IDS_PAGE_DYNAMIC, 'verify ids', { node_ids: ['dyn-quote'], checks: ['exists', 'filled'] });
    expect(verdict.satisfied).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('ids/filled: placeholder= counts as filled on an input', () => {
    const verdict = verifyEffect(IDS_PAGE_DYNAMIC, 'verify ids', { node_ids: ['dyn-input'], checks: ['exists', 'filled'] });
    expect(verdict.satisfied).toBe(true);
  });

  it('ids/filled: {null} and {\' \'} stay empty (no false positive)', () => {
    const verdict = verifyEffect(IDS_PAGE_DYNAMIC, 'verify ids', { node_ids: ['dyn-empty', 'dyn-blank'], checks: ['filled'] });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing).toHaveLength(2);
  });

  it('ids/exists: a dynamic data-id={…} is named, not silently absent', () => {
    const verdict = verifyEffect(IDS_PAGE_EXPR_ID, 'verify ids', { node_ids: ['wanted'], checks: ['exists'] });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.missing[0]).toContain("Missing node 'wanted'");
    expect(verdict.missing[0]).toContain('dynamic data-id');
    expect(verdict.missing[0]).toContain('data-id={item.id}');
  });

  it('concept: a prefixed section id (page-testimonials) resolves', () => {
    const verdict = verifyEffect(
      PREFIXED_PAGE,
      'Add a testimonials section with 2 cards, each with a quote and the name of the person.',
    );
    expect(verdict.concept).toBe('testimonial');
    expect(verdict.satisfied).toBe(true);
  });

  it('concept: CMS-bound cards ({item.quote}) read as filled', () => {
    const verdict = verifyEffect(
      CMS_PAGE,
      'Add a testimonials section with 2 cards, each with a quote and the name of the person.',
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('mechanism state is `wired` (T6), never `functional`', () => {
    const verdict = verifyEffect(PAGE_CTA_LINK, CTA_REQUEST);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.states[0]).toMatchObject({ label: 'CTA mechanism', state: 'wired' });
    expect(JSON.stringify(verdict)).not.toContain('functional');
  });
});
