import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  formStateVar,
  formStateSetter,
  buildInitialVariantExpr,
  parseFormStateMapping,
  setFormStateMappingInCode,
  dormantizeFormStateBinding,
  rehydrateFormStateBinding,
  healOrphanedFormStateBindings,
  healMissingFormStateDeclarations,
  dormantizeFormBindingsInCanvas,
  enclosingFormIdInCode,
  DEFAULT_FORM_STATE_MAPPING,
} from './form-state-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

const PAGE = (instance: string) => `'use client';
import React from 'react';
import { useState } from 'react';
import FormSubmit from '@/components/FormSubmit';

export default function Page() {
  return (
    <div data-id="root">
      <form data-id="form-1" data-name="Form">
        ${instance}
      </form>
    </div>
  );
}
`;

describe('form-state-gen: helpers', () => {
  it('derives a deterministic lifecycle var + setter', () => {
    expect(formStateVar('form-1')).toBe('formStateForm1');
    expect(formStateVar('contact_abc-9')).toBe('formStateContactabc9');
    expect(formStateSetter('formStateForm1')).toBe('setFormStateForm1');
  });

  it('builds an initialVariant ternary in stable state order', () => {
    expect(buildInitialVariantExpr('s', { loading: 'loading', success: 'success' }))
      .toBe("s === 'loading' ? 'loading' : s === 'success' ? 'success' : 'default'");
    expect(buildInitialVariantExpr('s', {})).toBe("'default'");
    // Order follows FORM_STATES (loading, success, error, disabled) regardless of insertion order.
    expect(buildInitialVariantExpr('s', { error: 'err', loading: 'load' }))
      .toBe("s === 'loading' ? 'load' : s === 'error' ? 'err' : 'default'");
  });
});

describe('form-state-gen: setFormStateMappingInCode + parseFormStateMapping', () => {
  const base = PAGE('<FormSubmit data-id="btn-1" data-name="Submit" label={"Send"} />');

  it('writes data-form-state + initialVariant + the lifecycle useState', () => {
    const out = setFormStateMappingInCode(base, 'btn-1', 'formStateForm1', DEFAULT_FORM_STATE_MAPPING);
    expect(out).toContain(`data-form-state='{"loading":"loading","success":"success"}'`);
    expect(out).toContain("initialVariant={formStateForm1 === 'loading' ? 'loading' : formStateForm1 === 'success' ? 'success' : 'default'}");
    expect(out).toContain("const [formStateForm1, setFormStateForm1] = useState('idle');");
    parses(out);
  });

  it('round-trips the mapping', () => {
    const out = setFormStateMappingInCode(base, 'btn-1', 'formStateForm1', { loading: 'loading', error: 'error' });
    expect(parseFormStateMapping(out, 'btn-1')).toEqual({ loading: 'loading', error: 'error' });
  });

  it('replaces an existing mapping rather than duplicating', () => {
    const once = setFormStateMappingInCode(base, 'btn-1', 'formStateForm1', { loading: 'loading' });
    const twice = setFormStateMappingInCode(once, 'btn-1', 'formStateForm1', { loading: 'loading', success: 'success' });
    expect((twice.match(/data-form-state=/g) || []).length).toBe(1);
    expect((twice.match(/initialVariant=/g) || []).length).toBe(1);
    expect(parseFormStateMapping(twice, 'btn-1')).toEqual({ loading: 'loading', success: 'success' });
    parses(twice);
  });

  it('clears the wiring when the mapping is empty', () => {
    const set = setFormStateMappingInCode(base, 'btn-1', 'formStateForm1', { loading: 'loading' });
    const cleared = setFormStateMappingInCode(set, 'btn-1', 'formStateForm1', {});
    expect(cleared).not.toContain('data-form-state=');
    expect(cleared).not.toContain('initialVariant=');
    expect(parseFormStateMapping(cleared, 'btn-1')).toEqual({});
    parses(cleared);
  });

  it('returns an empty mapping when the attr is absent', () => {
    expect(parseFormStateMapping(base, 'btn-1')).toEqual({});
  });
});

// A page where the instance lives inside <form data-id="form-A"> (so the
// lifecycle var is formStateFormA, matching the declared useState).
const FORMPAGE = (instance: string, formId = 'form-A') => `'use client';
import React from 'react';
import { useState } from 'react';
import FormSubmit from '@/components/FormSubmit';

export default function Page() {
  const [formStateFormA, setFormStateFormA] = useState('idle');
  return (
    <div data-id="root">
      <form data-id="${formId}" data-name="Form">
        ${instance}
      </form>
    </div>
  );
}
`;

describe('form-state-gen: dormantize / rehydrate (drag out / back in)', () => {
  const wired = setFormStateMappingInCode(
    FORMPAGE('<FormSubmit data-id="btn-1" data-name="Submit" label={"Send"} />'),
    'btn-1', 'formStateFormA', { loading: 'loading', success: 'success' },
  );

  it('finds the enclosing form id', () => {
    expect(enclosingFormIdInCode(wired, 'btn-1')).toBe('form-A');
  });

  it('dormantize strips initialVariant but KEEPS the data-form-state spec', () => {
    const d = dormantizeFormStateBinding(wired, 'btn-1');
    expect(d).not.toContain('initialVariant=');
    expect(d).toContain('data-form-state=');
    expect(parseFormStateMapping(d, 'btn-1')).toEqual({ loading: 'loading', success: 'success' });
    parses(d);
  });

  it('rehydrate restores the binding from the spec when back inside a form', () => {
    const d = dormantizeFormStateBinding(wired, 'btn-1');
    const r = rehydrateFormStateBinding(d, 'btn-1');
    expect(r).toContain("initialVariant={formStateFormA === 'loading' ? 'loading' : formStateFormA === 'success' ? 'success' : 'default'}");
    parses(r);
  });

  it('self-heal strips an orphaned binding whose useState is gone, keeps spec', () => {
    // Simulate a FormSubmit moved out of its form: initialVariant references
    // formStateForm1 but no `const [formStateForm1` exists in the file.
    const orphaned = `'use client';
import React from 'react';
import FormSubmit from '@/components/FormSubmit';
export default function Page() {
  return (<div data-id="root"><FormSubmit data-id="btn-1" data-form-state='{"loading":"loading"}' initialVariant={formStateForm1 === 'loading' ? 'loading' : 'default'} label={"Send"} /></div>);
}`;
    const healed = healOrphanedFormStateBindings(orphaned);
    expect(healed).not.toContain('initialVariant=');
    expect(healed).toContain('data-form-state='); // spec kept for later rehydrate
    parses(healed);
  });

  it('self-heal re-declares a formState var referenced in a master but undeclared (make-component)', () => {
    // A <form> made into a design component: master references formState<X> via
    // onSubmit setter + FormSubmit binding, but no useState declaration.
    const master = `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import FormSubmit from '@/components/FormSubmit';
function SeCoTi({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (<LayoutGroup><motion.form layout={true} onSubmit={async (e) => { e.preventDefault(); setFormStateFormX("loading"); }} data-id="f" {...rest}>
    <FormSubmit data-id="b" initialVariant={formStateFormX === 'loading' ? 'loading' : 'default'} label={"Send"} />
  </motion.form></LayoutGroup>);
}
export default withResponsiveProps(SeCoTi);`;
    const out = healMissingFormStateDeclarations(master);
    expect(out).toContain("const [formStateFormX, setFormStateFormX] = React.useState('idle');");
    // The declaration lands inside the SeCoTi function (before the return).
    expect(out.indexOf('const [formStateFormX')).toBeGreaterThan(out.indexOf('function SeCoTi'));
    expect(out.indexOf('const [formStateFormX')).toBeLessThan(out.indexOf('return (<LayoutGroup>'));
    parses(out);
  });

  it('healMissingFormStateDeclarations is a no-op when the var is already declared', () => {
    const sound = `import React from 'react';
function P() { const [formStateF, setFormStateF] = React.useState('idle'); return <form onSubmit={() => setFormStateF("loading")} data-id="f" />; }`;
    expect(healMissingFormStateDeclarations(sound)).toBe(sound);
  });

  it('self-heal leaves a binding whose useState IS declared', () => {
    const sound = setFormStateMappingInCode(
      FORMPAGE('<FormSubmit data-id="btn-1" label={"Send"} />'),
      'btn-1', 'formStateFormA', { loading: 'loading' },
    );
    expect(healOrphanedFormStateBindings(sound)).toBe(sound);
  });

  it('dormantizes a whole form dragged onto the canvas (no out-of-scope refs)', () => {
    // Matches the REAL emitted shape: `const canvasNodes = <>…</>;` (no parens),
    // form carrying onSubmit + FormSubmit initialVariant + responsive __mq attrs,
    // all referencing page-fn vars (out of scope in the module-scope fragment).
    const code = `'use client';
import React, { useState, useEffect } from 'react';
import FormSubmit from '@/components/FormSubmit';
export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  const [formStateF, setFormStateF] = useState('idle');
  return <div data-id="root"></div>;
}
const canvasNodes = <>
  <form onSubmit={async e => { e.preventDefault(); setFormStateF("loading"); try { const res = await fetch("/api/form", { body: JSON.stringify({ formId: "f" }) }); } catch (err) {} }} data-id="f" data-canvas-node="true">
    <input name={__mq0 ? "regerg" : "email"} type={__mq0 ? "date" : "email"} data-id="in-1" placeholder="Email" style={{ width: '100%' }}></input>
    <FormSubmit data-form-state='{"loading":"loading"}' initialVariant={formStateF === 'loading' ? 'loading' : 'default'} data-id="btn-1" label={"Send"} />
  </form>
</>;
`;
    const out = dormantizeFormBindingsInCanvas(code);
    // No module-scope references to the page-fn vars remain in the fragment.
    expect(out).not.toContain('onSubmit=');
    expect(out).not.toContain('formStateF ===');
    expect(out).not.toContain('__mq0 ?');
    // Responsive attrs collapsed to their base; FormSubmit + form still present.
    expect(out).toContain('name="email"');
    expect(out).toContain('type="email"');
    expect(out).toContain('<FormSubmit');
    expect(out).toContain('<form data-id="f"');
    // Page fn (above the fragment) is untouched — its useMediaQuery/useState stay.
    expect(out).toContain("const __mq0 = useMediaQuery('(max-width: 768px)')");
    parses(out);
  });

  it('rehydrate is a no-op when the instance is NOT inside a form (stays dormant)', () => {
    // Instance sitting outside any <form> — only the spec remains.
    const loose = `'use client';
import React from 'react';
import FormSubmit from '@/components/FormSubmit';
export default function Page() {
  return (<div data-id="root"><FormSubmit data-id="btn-1" data-form-state='{"loading":"loading"}' label={"Send"} /></div>);
}`;
    const r = rehydrateFormStateBinding(loose, 'btn-1');
    expect(r).not.toContain('initialVariant=');
    expect(r).toBe(loose);
  });
});
