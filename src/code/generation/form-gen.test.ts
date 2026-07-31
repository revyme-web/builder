import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { wireFormSubmitInCode, hasFormSubmitHandler, buildFormSubmitHandler, FORM_SUBMIT_ENDPOINT, FORM_ROUTE_PATH, FORM_ROUTE_CONTENT } from './form-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = (formInner = '') => `'use client';
import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <form data-id="form-1" data-name="Form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>${formInner}
        <input data-id="in-1" type="text" name="name" placeholder="Name" />
        <input data-id="in-2" type="email" name="email" placeholder="Email" />
        <button data-id="btn-1" type="submit">Submit</button>
      </form>
    </div>
  );
}
`;

describe('form-gen: wireFormSubmitInCode', () => {
  it('adds an onSubmit handler to the form that posts to the relay', () => {
    const out = wireFormSubmitInCode(PAGE(), 'form-1');
    expect(out).toContain('onSubmit={async (e) =>');
    expect(out).toContain(`fetch("${FORM_SUBMIT_ENDPOINT}"`);
    expect(out).toContain('formId: "form-1"');
    expect(out).toContain('Object.fromEntries(fd.entries())');
    expect(out).toContain('window.location.href = data.redirect');
    parses(out);
  });

  it('uses the form data-id as the formId', () => {
    const code = PAGE().replace(/form-1/g, 'contact-9');
    const out = wireFormSubmitInCode(code, 'contact-9');
    expect(out).toContain('formId: "contact-9"');
  });

  it('is idempotent — wiring twice does not duplicate the handler', () => {
    const once = wireFormSubmitInCode(PAGE(), 'form-1');
    const twice = wireFormSubmitInCode(once, 'form-1');
    expect(twice).toBe(once);
    expect((twice.match(/onSubmit=/g) || []).length).toBe(1);
    parses(twice);
  });

  it('no-ops when the data-id belongs to a non-form element', () => {
    const code = `'use client';\nexport default function P(){return (<div data-id="not-form"><span data-id="x" /></div>);}`;
    expect(wireFormSubmitInCode(code, 'not-form')).toBe(code);
  });

  it('no-ops when the form id is absent', () => {
    expect(wireFormSubmitInCode(PAGE(), 'missing')).toBe(PAGE());
  });

  it('wires a motion.form (form inside a component master)', () => {
    const code = `'use client';\nimport React from 'react';\nfunction C(){return (<motion.form data-id="form-2" layout={true}><input data-id="i" name="a" /></motion.form>);}\nexport default C;`;
    const out = wireFormSubmitInCode(code, 'form-2');
    expect(out).toContain('onSubmit={async (e) =>');
    expect(out).toContain('formId: "form-2"');
    parses(out);
  });

  it('hasFormSubmitHandler detects the wired state', () => {
    expect(hasFormSubmitHandler(PAGE(), 'form-1')).toBe(false);
    expect(hasFormSubmitHandler(wireFormSubmitInCode(PAGE(), 'form-1'), 'form-1')).toBe(true);
  });

  it('preserves existing children + the data-form attribute is untouched', () => {
    const withCfg = PAGE().replace('data-name="Form"', `data-name="Form" data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"a@b.com"}]}'`);
    const out = wireFormSubmitInCode(withCfg, 'form-1');
    expect(out).toContain(`data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"a@b.com"}]}'`);
    expect(out).toContain('data-id="in-1"');
    expect(out).toContain('data-id="btn-1"');
    parses(out);
  });
});

describe('form-gen: relay route file', () => {
  it('targets the App Router api route path', () => {
    expect(FORM_ROUTE_PATH).toBe('app/api/form/route.ts');
  });

  it('exports a POST handler and references the env bindings', () => {
    expect(FORM_ROUTE_CONTENT).toContain('export async function POST');
    expect(FORM_ROUTE_CONTENT).toContain('env.REVYME_FORMS_URL');
    expect(FORM_ROUTE_CONTENT).toContain('env.REVYME_FORM_TOKEN');
    expect(FORM_ROUTE_CONTENT).toContain('env.REVYME_WEBSITE_ID');
    parses(FORM_ROUTE_CONTENT);
  });

  it('contains NO secret values — only env references (safe to ship/export)', () => {
    expect(FORM_ROUTE_CONTENT).not.toMatch(/re_[A-Za-z0-9]{8}/); // a Resend key
    expect(FORM_ROUTE_CONTENT).not.toContain('workers.dev'); // no baked worker URL
    expect(FORM_ROUTE_CONTENT).not.toMatch(/Bearer\s+[A-Za-z0-9]{8}/); // no literal token
  });
});

describe('form-gen: buildFormSubmitHandler', () => {
  it('escapes the formId as a JSON string literal', () => {
    expect(buildFormSubmitHandler('a"b')).toContain('formId: "a\\"b"');
  });
});
