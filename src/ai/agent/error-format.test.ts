// src/ai/agent/error-format.test.ts
//
// Unit tests for the M3 error contract: the pure formatters every tool
// failure path funnels through. Provider-agnostic by construction — no
// mocks, no stores: these functions only touch their arguments.

import { describe, it, expect } from 'vitest';
import {
  formatToolError,
  formatOracleBounce,
  formatUnknownTool,
  formatNodeNotFound,
} from './error-format';

describe('formatToolError', () => {
  it('passes non-zod errors through verbatim', () => {
    const err = new Error('boom');
    expect(formatToolError(err)).toBe('boom');
    expect(formatToolError('plain string')).toBe('plain string');
    expect(formatToolError(null)).toBe('null');
    expect(formatToolError(undefined)).toBe('undefined');
  });

  it('keeps the raw zod issue messages first, then the teaching envelope', () => {
    const err = new Error(
      JSON.stringify([
        { code: 'invalid_type', path: ['node_id'], expected: 'string', received: 'number', message: 'Invalid input: expected string, received number' },
      ]),
    );
    const out = formatToolError(err, { toolName: 'set_styles' });
    expect(out).toContain('Invalid input');
    expect(out).toContain('PROBLEM: node_id must be a string.');
    expect(out).toContain('REVYME RULE:');
    expect(out).toContain('USE INSTEAD: node_id: \'hero-cta\'');
    expect(out).toContain('NEXT ACTION: Re-issue the tool call with corrected arguments.');
  });

  it('formats nested batch paths and tailors NEXT ACTION for batch', () => {
    const err = new Error(
      JSON.stringify([
        { code: 'invalid_type', path: ['operations', 0, 'tool'], expected: 'string', received: 'object', message: 'Invalid input: expected string, received object' },
      ]),
    );
    const out = formatToolError(err, { toolName: 'batch' });
    expect(out).toContain('PROBLEM: operations[0].tool must be a string.');
    expect(out).toContain('USE INSTEAD: operations: [{ tool: \'set_styles\', args:');
    expect(out).toContain('NEXT ACTION: Re-issue `batch` with corrected operations.');
  });

  it('points wrong viewport values at the id-or-width dialect', () => {
    const err = new Error(
      JSON.stringify([
        { code: 'invalid_type', path: ['viewport'], expected: 'string', received: 'array', message: 'Invalid input: expected string, received array' },
      ]),
    );
    const out = formatToolError(err);
    expect(out).toContain('REVYME RULE: Viewport tools take a viewport id');
    expect(out).toContain('USE INSTEAD: viewport: 768');
  });

  it('buckets any number-bearing path into the data-id rule', () => {
    const err = new Error(
      JSON.stringify([
        { code: 'invalid_type', path: ['parent_id'], expected: 'string', received: 'number', message: 'Invalid input: expected string, received number' },
      ]),
    );
    expect(formatToolError(err)).toContain('Ids are the element\'s data-id');
  });

  it('caps the issue envelope at two entries with a count line', () => {
    const issue = (code: string) => ({ code, path: ['x'], expected: 'string', received: 'number', message: 'Invalid input: expected string, received number' });
    const err = new Error(JSON.stringify([issue('a'), issue('b'), issue('c'), issue('d')]));
    const out = formatToolError(err);
    expect(out).toMatch(/…and 2 more invalid fields\./);
    expect(out.split('PROBLEM:').length - 1).toBe(2);
  });

  it('ignores JSON arrays that are not zod issues', () => {
    const err = new Error('[1, 2, 3]');
    expect(formatToolError(err)).toBe('[1, 2, 3]');
    expect(formatToolError(new Error('[]'))).toBe('[]');
  });
});

describe('formatOracleBounce', () => {
  it('enriches registered codes with the USE INSTEAD dialect', () => {
    const out = formatOracleBounce([
      { code: 'CSS_TRANSITION', message: 'CSS transition tentatively rejected.' },
      { code: 'WOULD_CRASH', message: 'File would crash.' },
    ]);
    expect(out[0].code).toBe('CSS_TRANSITION');
    expect(out[0].message).toContain('CSS transition tentatively rejected.');
    expect(out[0].message).toContain('USE INSTEAD:');
    expect(out[0].message).toContain('whileInView');
    expect(out[1].message).toContain('File would crash.');
    expect(out[1].message).toContain('USE INSTEAD:');
  });

  it('passes unregistered codes through verbatim — the frozen wire shape', () => {
    const inV = [{ code: 'X', message: 'hm' }];
    expect(formatOracleBounce(inV)).toEqual(inV);
    expect(formatOracleBounce([])).toEqual([]);
  });

  it('keeps tier metadata out of the wire', () => {
    const out = formatOracleBounce([{ code: 'BARE_ANIMATE_OBJECT', message: 'plain', tier: 3 }]);
    expect(Object.keys(out[0]).sort()).toEqual(['code', 'message']);
  });

  // M6 additive: the two PIN codes (checks/style-object.ts:81,88) get the
  // same USE INSTEAD dialect treatment without touching the four existing ones.
  it('M6 — enriches PIN_VALUE_NOT_PX with the px-string dialect', () => {
    const out = formatOracleBounce([{ code: 'PIN_VALUE_NOT_PX', message: 'top must be a px string.' }]);
    expect(out[0].message).toContain('top must be a px string.');
    expect(out[0].message).toContain('USE INSTEAD:');
    expect(out[0].message).toContain("'64px'");
  });

  it('M6 — enriches PIN_PERCENT_RIGHT_BOTTOM with the right/bottom px dialect', () => {
    const out = formatOracleBounce([{ code: 'PIN_PERCENT_RIGHT_BOTTOM', message: 'right is a percentage.' }]);
    expect(out[0].message).toContain('USE INSTEAD:');
    expect(out[0].message).toContain("right: '32px'");
  });
});

describe('formatUnknownTool', () => {
  it('names the op and lists what is valid', () => {
    const out = formatUnknownTool('nope', ['set_styles', 'add_node', 'batch']);
    expect(out).toBe('Unknown tool "nope". Valid tools: set_styles, add_node, batch.');
  });

  it('degrades when nothing is known to be valid', () => {
    expect(formatUnknownTool('nope', [])).toBe('Unknown tool "nope". Valid tools: (none).');
  });
});

describe('formatNodeNotFound', () => {
  it('appends the closest valid ids, capped and sorted', () => {
    const allIds = ['zeta', 'alpha', 'beta', 'gamma', 'ample', 'removing-me'];
    const out = formatNodeNotFound('missing', allIds);
    expect(out).toContain('Node "missing" not found.');
    expect(out).toContain('Valid ids: alpha, ample, beta, gamma, removing-me, zeta');
  });

  it('excludes the requested id and reports overflow beyond the cap', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `id-${String(i).padStart(2, '0')}`);
    const out = formatNodeNotFound('id-00', ids);
    expect(out).toContain('…(+1 more)');
    expect(out.split('Valid ids: ')[1]).not.toContain('id-00');
  });

  it('falls back to the exact original message on an empty project', () => {
    expect(formatNodeNotFound('ghost', [])).toBe('Node "ghost" not found.');
    expect(formatNodeNotFound('ghost', ['ghost'])).toBe('Node "ghost" not found.');
  });
});