import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import {
  setResponsiveAttrInCode,
  setVariantAttrInCode,
  resetResponsiveAttrInCode,
  parseResponsiveAttr,
  getResponsiveAttrAtViewport,
  getResponsiveAttrForVariant,
  setResponsiveAttrBaseInCode,
} from './responsive-attrs-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

// No useMediaQuery import — ensureMediaQueryHook injects a local hook definition.
const PAGE = (input: string) => `'use client';
import React from 'react';
import { useState, useEffect } from 'react';

export default function Page() {
  return (
    <form data-id="form-1">
      ${input}
    </form>
  );
}
`;

describe('responsive-attrs-gen: per-viewport overrides', () => {
  const base = PAGE('<input data-id="in-1" type="text" name="email" placeholder="Email" />');

  it('encodes a viewport override as an __mq-gated ternary + ensures the gate', () => {
    const out = setResponsiveAttrInCode(base, 'in-1', 768, 'type', 'date', 'text');
    expect(out).toMatch(/const __mq\d+ = useMediaQuery\('\(max-width: 768px\)'\)/);
    expect(out).toMatch(/type=\{__mq\d+ \? "date" : "text"\}/);
    parses(out);
  });

  it('round-trips: parse reads base + per-viewport value back', () => {
    const out = setResponsiveAttrInCode(base, 'in-1', 768, 'type', 'date', 'text');
    const r = parseResponsiveAttr(out, 'in-1', 'type');
    expect(r.base).toBe('text');
    expect(r.byViewport.get(768)).toBe('date');
    expect(getResponsiveAttrAtViewport(out, 'in-1', 'type', 768)).toBe('date');
    expect(getResponsiveAttrAtViewport(out, 'in-1', 'type', 1440)).toBe('text'); // no override → base
  });

  it('chains multiple viewport overrides smallest-width first', () => {
    let out = setResponsiveAttrInCode(base, 'in-1', 768, 'type', 'tel', 'text');
    out = setResponsiveAttrInCode(out, 'in-1', 375, 'type', 'date', 'text');
    // 375 (smaller) must come before 768 in the chain, base last.
    expect(out).toMatch(/type=\{__mq\d+ \? "date" : __mq\d+ \? "tel" : "text"\}/);
    const r = parseResponsiveAttr(out, 'in-1', 'type');
    expect(r.byViewport.get(375)).toBe('date');
    expect(r.byViewport.get(768)).toBe('tel');
    parses(out);
  });

  it('reset removes the override (back to a plain string attr) + sweeps the orphan gate', () => {
    const set = setResponsiveAttrInCode(base, 'in-1', 768, 'type', 'date', 'text');
    const reset = resetResponsiveAttrInCode(set, 'in-1', 768, 'type');
    expect(reset).toContain('type="text"');
    expect(reset).not.toMatch(/type=\{/);
    expect(reset).not.toMatch(/useMediaQuery\('\(max-width: 768px\)'\)/); // gate swept
    parses(reset);
  });

  it('setting the override equal to base is a no-op override (stays base)', () => {
    const out = setResponsiveAttrInCode(base, 'in-1', 768, 'type', 'text', 'text');
    expect(out).toContain('type="text"');
    expect(out).not.toMatch(/type=\{/);
  });

  it('works for required (boolean) — override removes it on mobile', () => {
    const withReq = PAGE('<input data-id="in-1" type="text" required="true" />');
    const out = setResponsiveAttrInCode(withReq, 'in-1', 768, 'required', '', 'true');
    // empty value === remove override → required stays base "true" (no ternary)
    expect(out).toContain('required="true"');
    // Now actually override to a different value:
    const out2 = setResponsiveAttrInCode(withReq, 'in-1', 768, 'required', 'false', 'true');
    expect(out2).toMatch(/required=\{__mq\d+ \? "false" : "true"\}/);
    parses(out2);
  });
});

describe('responsive-attrs-gen: per-variant overrides', () => {
  const base = PAGE('<input data-id="in-1" type="text" name="email" />');

  it('encodes a variant override as an `initialVariant === ...` ternary (always defined in masters)', () => {
    const out = setVariantAttrInCode(base, 'in-1', 'variant-1', 'type', 'date', 'text');
    expect(out).toContain(`type={initialVariant === 'variant-1' ? "date" : "text"}`);
    expect(out).not.toContain('variant === '); // NOT the connections-only `variant` var
    expect(getResponsiveAttrForVariant(out, 'in-1', 'type', 'variant-1')).toBe('date');
    expect(getResponsiveAttrForVariant(out, 'in-1', 'type', 'default')).toBe('text');
    parses(out);
  });
});

// ── FIT viewBox: per-viewport svg attr + base-preserving writes ──────────────
describe('responsive-attrs-gen: svg viewBox (FIT per-viewport)', () => {
  const SVG_PAGE = `'use client';
import React from 'react';
import { useState, useEffect } from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <svg data-id="t1-svg" data-name="FIT" viewBox="0 0 1010 78" style={{width: '100%'}}>
        <foreignObject width="100%" height="100%"><p data-id="t1">Hi</p></foreignObject>
      </svg>
    </div>
  );
}
`;

  it('writes a per-viewport viewBox override as an __mq ternary', () => {
    const out = setResponsiveAttrInCode(SVG_PAGE, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    expect(out).toMatch(/viewBox=\{__mq\d+ \? "0 0 1010 120" : "0 0 1010 78"\}/);
    const r = parseResponsiveAttr(out, 't1-svg', 'viewBox');
    expect(r.base).toBe('0 0 1010 78');
    expect(r.byViewport.get(768)).toBe('0 0 1010 120');
    parses(out);
  });

  it('setResponsiveAttrBaseInCode updates the BASE and PRESERVES viewport overrides', () => {
    const withOverride = setResponsiveAttrInCode(SVG_PAGE, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    const rebased = setResponsiveAttrBaseInCode(withOverride, 't1-svg', 'viewBox', '0 0 1010 90');
    const r = parseResponsiveAttr(rebased, 't1-svg', 'viewBox');
    expect(r.base).toBe('0 0 1010 90');
    expect(r.byViewport.get(768)).toBe('0 0 1010 120'); // override survives
    parses(rebased);
  });

  it('setResponsiveAttrBaseInCode with NO overrides emits a plain string attr', () => {
    const out = setResponsiveAttrBaseInCode(SVG_PAGE, 't1-svg', 'viewBox', '0 0 1010 90');
    expect(out).toContain('viewBox="0 0 1010 90"');
    expect(out).not.toContain('__mq');
    parses(out);
  });
});

// ── gate anchoring with module-scope helpers above the component ─────────────
// The live crash (2026-07-03): a page carrying the injected useResponsiveText
// helper (module scope, ABOVE Page) got its `const __mq0 = useMediaQuery(…)`
// inserted into the HELPER's body (old anchor = "first function in the file")
// → `__mq0` undefined at the JSX reference; and the injected useMediaQuery hook
// references useEffect which the page never imported. Both blocked by the
// validator as "References undefined identifiers: useEffect, __mq0".
describe('responsive-attrs-gen: gate anchoring + react imports', () => {
  const PAGE_WITH_HELPER = `'use client';
import React, { useState, useRef, useLayoutEffect } from 'react';

function useResponsiveText(primary, overrides, vpWidths) {
  const ref = useRef(null);
  return primary;
}

export default function Page() {
  return (
    <div data-id="root">
      <svg data-id="t1-svg" data-name="FIT" viewBox="0 0 1010 78" style={{width: '100%'}}>
        <foreignObject width="100%" height="100%"><p data-id="t1">Hi</p></foreignObject>
      </svg>
    </div>
  );
}
`;

  it('inserts the gate in the COMPONENT (before its render return), not the helper', () => {
    const out = setResponsiveAttrInCode(PAGE_WITH_HELPER, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    const gateIdx = out.indexOf('const __mq0 = useMediaQuery');
    const pageIdx = out.indexOf('export default function Page');
    expect(gateIdx).toBeGreaterThan(pageIdx);              // inside Page, not the helper
    expect(out.indexOf('viewBox={__mq0')).toBeGreaterThan(gateIdx); // declared before use
    parses(out);
  });

  it('extends the react import with useEffect (the injected hook needs it)', () => {
    const out = setResponsiveAttrInCode(PAGE_WITH_HELPER, 't1-svg', 768, 'viewBox', '0 0 1010 120', '0 0 1010 78');
    expect(out).toMatch(/import React, \{[^}]*useEffect[^}]*\} from 'react'/);
    expect(out).toMatch(/import React, \{[^}]*useState[^}]*\} from 'react'/);
    // no duplicate names
    const named = out.match(/import React, \{([^}]*)\} from 'react'/)![1].split(',').map(s => s.trim());
    expect(new Set(named).size).toBe(named.length);
    parses(out);
  });
});
