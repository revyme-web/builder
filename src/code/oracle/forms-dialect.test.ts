import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

// Wrap a form snippet in a minimal, parseable page. We only assert on FORM_*
// codes, so unrelated violations (missing data-id, @canvas, etc.) are ignored.
const page = (inner: string) => `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root">${inner}</div>;
}`;

const formCodes = (inner: string) =>
  checkFile(page(inner), { kind: 'page' })
    .filter((v) => v.code.startsWith('FORM_'))
    .map((v) => v.code);

const GOOD_HANDLER =
  `onSubmit={async (e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); ` +
  `const fields = Object.fromEntries(fd.entries()); await fetch("/api/form", { method: "POST", ` +
  `headers: { "Content-Type": "application/json" }, body: JSON.stringify({ formId: "form-1", fields }) }); }}`;

const CLEAN_FORM = `<form data-id="form-1" data-form='{"sendTo":[{"id":"d1","type":"email","recipient":"a@b.com"}]}' ${GOOD_HANDLER}>
  <input data-id="in-1" type="text" name="name" placeholder="Name" />
  <input data-id="in-2" type="email" name="email" placeholder="Email" />
  <button data-id="btn-1" type="submit">Send</button>
</form>`;

describe('oracle: forms dialect', () => {
  it('a correctly-wired form passes clean', () => {
    expect(formCodes(CLEAN_FORM)).toEqual([]);
  });

  it('flags a form with no onSubmit (would do a native navigation)', () => {
    const inner = `<form data-id="form-1" data-form='{"sendTo":[]}'>
      <input data-id="in-1" name="email" />
    </form>`;
    expect(formCodes(inner)).toContain('FORM_MISSING_ONSUBMIT');
  });

  it('flags an onSubmit that posts to the wrong endpoint', () => {
    const inner = `<form data-id="form-1" data-form='{"sendTo":[]}' onSubmit={async (e) => { e.preventDefault(); await fetch("/submit"); }}>
      <input data-id="in-1" name="email" />
    </form>`;
    expect(formCodes(inner)).toContain('FORM_WRONG_ENDPOINT');
  });

  it('flags an input inside a form with no name', () => {
    const inner = `<form data-id="form-1" data-form='{"sendTo":[]}' ${GOOD_HANDLER}>
      <input data-id="in-1" type="text" placeholder="Name" />
    </form>`;
    expect(formCodes(inner)).toContain('FORM_INPUT_MISSING_NAME');
  });

  it('does NOT require a name on submit/button/reset inputs', () => {
    const inner = `<form data-id="form-1" data-form='{"sendTo":[]}' ${GOOD_HANDLER}>
      <input data-id="in-1" type="text" name="name" />
      <input data-id="in-2" type="submit" value="Send" />
      <input data-id="in-3" type="reset" value="Clear" />
    </form>`;
    expect(formCodes(inner)).not.toContain('FORM_INPUT_MISSING_NAME');
  });

  it('does NOT flag an input that is not inside a form', () => {
    const inner = `<input data-id="loose" type="text" />`;
    expect(formCodes(inner)).not.toContain('FORM_INPUT_MISSING_NAME');
  });

  it('warns (tier 3) when a form has no data-form destination', () => {
    const inner = `<form data-id="form-1" ${GOOD_HANDLER}>
      <input data-id="in-1" name="email" />
    </form>`;
    const vs = checkFile(page(inner), { kind: 'page' }).filter((v) => v.code === 'FORM_NO_DESTINATION');
    expect(vs).toHaveLength(1);
    expect(vs[0].tier).toBe(3);
  });

  it('onSubmit + endpoint rules are tier 2 (blocking)', () => {
    const inner = `<form data-id="form-1" data-form='{"sendTo":[]}'><input data-id="i" name="x" /></form>`;
    const vs = checkFile(page(inner), { kind: 'page' }).filter((v) => v.code === 'FORM_MISSING_ONSUBMIT');
    expect(vs[0].tier).toBe(2);
  });
});
