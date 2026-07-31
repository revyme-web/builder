import { describe, it, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn() } }));
import { checkFile } from './check-file';

// Minimal page carrying a @pageVariables block — the only thing under test is the `type` validity.
const PAGE = (pageVars: string) => `'use client';

/** @pageVariables ${pageVars} */

import React from 'react';
import { motion } from 'framer-motion';

export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', height: '100%' }}></div>;
}`;

const violations = (pv: string) =>
  checkFile(PAGE(pv), { kind: 'page' }).filter((x) => x.code === 'PAGE_VARIABLE_INVALID_TYPE');

describe('PAGE_VARIABLE_INVALID_TYPE — @pageVariables base-type validity', () => {
  it('bounces a transition type (the parser would silently DROP it) + teaches the fix', () => {
    const out = violations('{ "variables": [{ "name": "myTransition", "type": "transition", "default": "" }] }');
    expect(out.length).toBe(1);
    expect(out[0].message).toContain('"text"');      // valid base
    expect(out[0].message).toContain('@propMeta');    // where the rich type goes
    expect(out[0].message).toContain('myTransition'); // names the offending var
  });

  it('bounces shadow / border / radius likewise (rich @propMeta-only types)', () => {
    for (const ty of ['shadow', 'border', 'radius']) {
      expect(violations(`{ "variables": [{ "name": "x", "type": "${ty}", "default": "" }] }`).length).toBe(1);
    }
  });

  it('accepts every valid base type', () => {
    for (const ty of ['text', 'number', 'boolean', 'color', 'image', 'componentCursor']) {
      const dflt = ty === 'number' ? '0' : '';
      expect(violations(`{ "variables": [{ "name": "x", "type": "${ty}", "default": "${dflt}" }] }`)).toEqual([]);
    }
  });

  it('tolerates option (round-trips via @propMeta + the component-info parser)', () => {
    expect(violations('{ "variables": [{ "name": "justify", "type": "option", "default": "center" }] }')).toEqual([]);
  });

  it('no @pageVariables block → no violation', () => {
    const code = `'use client';\nexport default function Page() { return <div data-id="root" data-name="P" style={{ position: 'relative', width: '100%', height: '100%' }}></div>; }`;
    expect(checkFile(code, { kind: 'page' }).filter((x) => x.code === 'PAGE_VARIABLE_INVALID_TYPE')).toEqual([]);
  });

  it('one violation per invalid var; valid ones pass through', () => {
    const out = violations('{ "variables": [{ "name": "a", "type": "transition", "default": "" }, { "name": "b", "type": "shadow", "default": "" }, { "name": "c", "type": "text", "default": "" }] }');
    expect(out.length).toBe(2);
  });

  it('malformed @pageVariables JSON is left to another check (no throw, no false bounce)', () => {
    expect(violations('{ "variables": [ BROKEN ] }')).toEqual([]);
  });
});
