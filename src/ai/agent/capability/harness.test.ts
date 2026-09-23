import { test, expect } from 'vitest';
import { runCase } from './harness';
test('a wrong EFFECT is caught', async () => {
  const r = await runCase({ id: 'layout/x', domain: 'layout', status: 'supported', feature: 'x', ask: 'x',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero', styles: { backgroundColor: '#111111' } } }],
    expect: (w) => { if (w.node('hero').styles.backgroundColor !== '#222222') throw new Error('not #222222'); } });
  expect(r.ok).toBe(false); expect(r.failures[0]).toMatch(/effect: not #222222/);
});
test('an INVALID result is caught by the oracle even when the tool says ok', async () => {
  const r = await runCase({ id: 'layout/y', domain: 'layout', status: 'supported', feature: 'y', ask: 'y',
    calls: [{ tool: 'set_styles', args: { node_id: 'hero-title', styles: { lineHeight: '24px' } } }], expect: () => {} });
  expect(r.ok).toBe(false); expect(r.failures.join(' ')).toMatch(/LINE_HEIGHT_FORMAT/);
});
test('an unknown tool and a failing call are failures, not crashes', async () => {
  const r = await runCase({ id: 'layout/z', domain: 'layout', status: 'supported', feature: 'z', ask: 'z',
    calls: [{ tool: 'no_such_tool', args: {} }, { tool: 'set_size', args: { node_id: 'hero', width: '50%' } }], expect: () => {} });
  expect(r.ok).toBe(false); expect(r.failures.join(' ')).toMatch(/not registered/);
  console.log('FAILURES:', JSON.stringify(r.failures).slice(0, 400));
});
