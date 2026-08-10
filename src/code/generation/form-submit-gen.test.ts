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

// ─── display must switch INSTANTLY ──────────────────────────────────────────
//
// Framer Motion can't interpolate `display`: a SHOW value lands at the start of
// the transition, a HIDE value only at the END. Under the default spring the old
// label stayed visible ~300ms after the state changed (measured in Chromium:
// still `block` at 200ms, `none` by 400ms). A form whose API answers faster than
// that painted "Subscribe" and "Thank you" on top of each other before settling
// green — the reported symptom (2026-08-10).

import { upgradeFormSubmitDisplayTransitions } from './form-submit-gen';

describe('display variants switch instantly', () => {
  const master = buildFormSubmitComponentCode();

  it('every display-only variant entry carries a zero-duration transition', () => {
    for (const obj of ['labelVariants', 'spinnerWrapVariants', 'successTextVariants', 'errorTextVariants']) {
      const block = master.match(new RegExp(`const ${obj} = \\{[\\s\\S]*?\\n\\};`))![0];
      const entries = block.match(/\{[^{}]*display[^{}]*\}/g) ?? [];
      expect(entries.length, `${obj} should have one entry per variant`).toBe(7);
      for (const e of entries) expect(e, `${obj}: ${e}`).toMatch(/transition:/);
    }
  });

  it('the ROOT keeps its default transition — the background still animates', () => {
    const root = master.match(/const rootVariants = \{[\s\S]*?\n\};/)![0];
    expect(root).not.toMatch(/transition:/);
  });
});

describe('upgradeFormSubmitDisplayTransitions — heal without regenerating', () => {
  // A master the user has STYLED. Regenerating would discard all of this, so the
  // upgrade must be surgical.
  const styled = `'use client';
/* @formsubmit-gen v3 */
const rootVariants = {
  default: { backgroundColor: 'var(--color-brand)', opacity: 1, borderRadius: '32px' },
  'success': { backgroundColor: '#22c55e', opacity: 1 },
};

const labelVariants = {
  default: { display: 'block', color: 'var(--color-text)' },
  'loading': { display: 'none' },
  'success': { display: 'none' },
};

const successTextVariants = {
  default: { display: 'none' },
  'success': { display: 'block' },
};
export default function X() { return <button data-id="formsubmit-root" />; }
`;

  it('adds the instant transition to display entries', () => {
    const out = upgradeFormSubmitDisplayTransitions(styled);
    expect(out).toContain(`{ display: 'block', color: 'var(--color-text)', transition: { duration: 0 } }`);
    expect(out).toContain(`{ display: 'none', transition: { duration: 0 } }`);
  });

  it('PRESERVES the user styling verbatim', () => {
    const out = upgradeFormSubmitDisplayTransitions(styled);
    expect(out).toContain(`backgroundColor: 'var(--color-brand)'`);
    expect(out).toContain(`borderRadius: '32px'`);
    expect(out).toContain(`color: 'var(--color-text)'`);
  });

  it('leaves the ROOT variants alone', () => {
    const out = upgradeFormSubmitDisplayTransitions(styled);
    const root = out.match(/const rootVariants = \{[\s\S]*?\n\};/)![0];
    expect(root).not.toMatch(/transition:/);
  });

  it('is IDEMPOTENT — the heal runs on every ensure', () => {
    const once = upgradeFormSubmitDisplayTransitions(styled);
    expect(upgradeFormSubmitDisplayTransitions(once)).toBe(once);
  });

  it('keeps a transition the user set themselves', () => {
    const custom = styled.replace(`'loading': { display: 'none' }`, `'loading': { display: 'none', transition: { duration: 0.4 } }`);
    expect(upgradeFormSubmitDisplayTransitions(custom)).toContain(`transition: { duration: 0.4 }`);
  });

  it('ignores a component that is not ours', () => {
    const foreign = `const labelVariants = { default: { display: 'block' } };\nexport default function X() { return <button />; }`;
    expect(upgradeFormSubmitDisplayTransitions(foreign)).toBe(foreign);
  });
});
