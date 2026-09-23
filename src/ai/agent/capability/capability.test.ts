// The agent capability suite — one case per Revyme feature.
//
//   npx vitest run src/ai/agent/capability
//
// A `supported` case drives the agent's REAL tools through the real builder and
// is checked twice: the result is VALID (passes the oracle) and INTENDED (the
// effect is really in the re-parsed file). A `missing` case is a feature the
// agent has no way to do yet — listed by name, so a gap is never invisible
// again (that is how "the agent cannot add an image" went unnoticed until a
// blog came out with no pictures).
//
// THE RATCHET: `FLOOR` is how many features are proven today. It only goes UP —
// raise it in the same change that turns a `missing` case into a `supported`
// one. A change that breaks a proven feature fails here, before a user finds it.

import { describe, test, expect, afterAll } from 'vitest';
import { runCase, type CaseResult } from './harness';
import { ALL_CASES } from './cases';
import { summarize, coverageTable } from './coverage';

const results: CaseResult[] = [];

describe('agent capability', () => {
  for (const c of ALL_CASES) {
    if (c.status === 'missing') { test.todo(`${c.id} — ${c.feature}${c.gap ? ` (${c.gap})` : ''}`); continue; }
    test(`${c.id} — ${c.feature}`, async () => {
      const r = await runCase(c);
      results.push(r);
      // The message IS the diagnosis — vitest truncates an array diff to "[ …(2) ]".
      expect(r.failures.length, `\n  ${r.failures.join('\n  ')}\n`).toBe(0);
    });
  }
});

describe('the case list itself', () => {
  test('ids are unique and carry their domain', () => {
    const ids = ALL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ALL_CASES) expect(c.id.startsWith(`${c.domain}/`), c.id).toBe(true);
  });
  test('a supported case proves something; a missing one says what is missing', () => {
    for (const c of ALL_CASES) {
      if (c.status === 'supported') {
        expect(c.calls?.length ?? 0, `${c.id} has no calls`).toBeGreaterThan(0);
        expect(typeof c.expect, `${c.id} never checks the effect`).toBe('function');
      } else {
        expect(c.gap, `${c.id} does not say what is missing`).toBeTruthy();
      }
    }
  });
});

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`\n${coverageTable(summarize(ALL_CASES, results))}\n`);
});
