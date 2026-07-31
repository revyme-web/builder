import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  buildFormSubmitComponentCode,
  convertSubmitButtonInCode,
  FORMSUBMIT_COMPONENT_NAME,
} from './form-submit-gen';
import { formStateVar, parseFormStateMapping } from './form-state-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = (button = '<button data-id="btn-1" type="submit">Send</button>') => `'use client';
import React from 'react';
import { useState } from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <form data-id="form-1" data-name="Form" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <input data-id="in-1" type="text" name="name" placeholder="Name" />
        ${button}
      </form>
    </div>
  );
}
`;

describe('form-submit-gen: buildFormSubmitComponentCode', () => {
  const code = buildFormSubmitComponentCode();

  it('emits a parseable design-component master', () => {
    parses(code);
  });

  it('ships the full the reference form-button variant set', () => {
    for (const v of ['default', 'default-hover', 'default-pressed', 'loading', 'disabled', 'success', 'error']) {
      expect(code).toContain(`name: '${v}'`);
    }
    expect(code).toContain("interactionType: 'hover'");
    expect(code).toContain("interactionType: 'pressed'");
  });

  it('is a submit-typed motion.button that reuses the Spinner', () => {
    expect(code).toContain('data-id="formsubmit-root"');
    expect(code).toContain('motion.button');
    expect(code).toContain('type="submit"');
    expect(code).toContain('<Spinner data-id="formsubmit-spinner"');
    expect(code).toContain("import Spinner from '@/components/Spinner'");
  });

  it('uses the variant-list dialect + connection wiring (editor-compatible)', () => {
    expect(code).toContain("animate={['default', variant]}");
    expect(code).toContain("initial={['default', initialVariant]}");
    expect(code).toContain('const [variant, setVariant] = useState(initialVariant)');
    expect(code).toContain('const connections =');
    expect(code).toContain('onHoverStart=');
    expect(code).toContain('onTapStart=');
  });

  it('has per-state child texts (label/success/error) toggled by variant objects', () => {
    expect(code).toContain('data-id="formsubmit-label"');
    expect(code).toContain('data-id="formsubmit-success"');
    expect(code).toContain('data-id="formsubmit-error"');
    expect(code).toContain('Thank you');
    expect(code).toContain('Something went wrong');
    expect(code).toContain('{label}');
  });

  it('follows the variant component export pattern', () => {
    expect(code).toContain('const variantConfig =');
    expect(code).toContain(`export default withResponsiveProps(${FORMSUBMIT_COMPONENT_NAME})`);
    expect(code).not.toContain('export default function');
  });

  it('roots the button at a hardcoded 200px width', () => {
    expect(code).toContain("width: '200px'");
    expect(code).not.toContain("width: 'min-content'");
  });
});

describe('form-submit-gen: convertSubmitButtonInCode', () => {
  it('swaps the submit button for a FormSubmit instance with the default state mapping', () => {
    const stateVar = formStateVar('form-1');
    const out = convertSubmitButtonInCode(PAGE(), 'form-1', stateVar);
    expect(out).toContain(`<${FORMSUBMIT_COMPONENT_NAME} `);
    expect(out).toContain('data-id="btn-1"');
    expect(out).toContain('label={"Send"}');
    expect(out).toContain('style={{ width: "100%" }}'); // instance fills the form column
    expect(out).toContain('data-form-state=');
    expect(out).toContain(`initialVariant={${stateVar} === 'loading' ? 'loading'`);
    expect(out).not.toContain('<button');
    parses(out);
  });

  it('adds the FormSubmit import and the lifecycle useState', () => {
    const stateVar = formStateVar('form-1');
    const out = convertSubmitButtonInCode(PAGE(), 'form-1', stateVar);
    expect(out).toContain("import FormSubmit from '@/components/FormSubmit'");
    expect(out).toContain(`const [${stateVar}, setFormStateForm1] = useState('idle');`);
  });

  it('the round-tripped mapping parses back to the reference defaults', () => {
    const out = convertSubmitButtonInCode(PAGE(), 'form-1', formStateVar('form-1'));
    expect(parseFormStateMapping(out, 'btn-1')).toEqual({ loading: 'loading', success: 'success' });
  });

  it('preserves the original button label text', () => {
    const out = convertSubmitButtonInCode(
      PAGE('<button data-id="btn-1" type="submit">Request a call</button>'),
      'form-1',
      formStateVar('form-1'),
    );
    expect(out).toContain('label={"Request a call"}');
  });

  it('canvas drop (wireFormState:false) converts the button WITHOUT lifecycle state', () => {
    const out = convertSubmitButtonInCode(PAGE(), 'form-1', formStateVar('form-1'), { wireFormState: false });
    expect(out).toContain(`<${FORMSUBMIT_COMPONENT_NAME} `);
    expect(out).toContain('data-id="btn-1"');
    expect(out).toContain('label={"Send"}');
    // No state binding / useState — module-scope canvas JSX can't hold a hook.
    expect(out).not.toContain('data-form-state=');
    expect(out).not.toContain('initialVariant=');
    expect(out).not.toContain("useState('idle')"); // no lifecycle var declared
    expect(out).not.toContain('<button');
    parses(out);
  });

  it('is idempotent — skips a form already converted', () => {
    const stateVar = formStateVar('form-1');
    const once = convertSubmitButtonInCode(PAGE(), 'form-1', stateVar);
    const twice = convertSubmitButtonInCode(once, 'form-1', stateVar);
    expect(twice).toBe(once);
  });

  it('no-ops a form with no button', () => {
    const code = PAGE('<input data-id="in-2" name="email" />');
    expect(convertSubmitButtonInCode(code, 'form-1', formStateVar('form-1'))).toBe(code);
  });
});
