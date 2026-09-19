import { describe, it, expect } from 'vitest';
import { humanizeFailure } from './AgentChat';

// The payload is written for the MODEL — violation codes, tool ledgers, retry
// hints. Shown to a person, `COMPONENT_ROOT_POSITION` reads as breakage, even
// though nearly every one of these is caught and corrected on the next step.
describe('humanizeFailure', () => {
  const noJargon = (s: string) => {
    expect(s).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);      // no SCREAMING_CODES
    expect(s.toLowerCase()).not.toContain('oracle');
    expect(s.toLowerCase()).not.toContain('json');
    expect(s).not.toContain('{');
  };

  it('explains an oracle bounce as caught-and-corrected', () => {
    const out = humanizeFailure('[{"code":"COMPONENT_ROOT_POSITION","message":"…"}]');
    expect(out).toMatch(/corrected/i);
    noJargon(out);
  });

  it('handles the gate-blocked wording too', () => {
    const out = humanizeFailure('Oracle file gate blocked batch: [FORBIDDEN_ALIGN_VALUE]');
    expect(out).toMatch(/corrected/i);
    noJargon(out);
  });

  it('explains a mid-interaction clash in the user’s own terms', () => {
    const out = humanizeFailure('ERROR: The editor is mid-interaction (drag/resize in progress). Retry in a moment.');
    expect(out).toMatch(/editing at the same moment/i);
    noJargon(out);
  });

  it('explains a non-batchable tool without naming the tool plumbing', () => {
    const out = humanizeFailure('{"reason":"set_motion_preset cannot run inside batch — call it directly"}');
    expect(out).toMatch(/own turn/i);
    noJargon(out);
  });

  it('explains a stale anchor', () => {
    const out = humanizeFailure('edit 1/1: oldText not found: "<AnimatePresence>"');
    expect(out).toMatch(/re-read/i);
    noJargon(out);
  });

  it('explains an unresponsive editor', () => {
    noJargon(humanizeFailure('The editor could not run set_styles: timeout'));
  });

  it('always says something, for anything unrecognised', () => {
    for (const input of ['', '???', '{}', 'weird']) {
      const out = humanizeFailure(input);
      expect(out.length).toBeGreaterThan(10);
      noJargon(out);
    }
  });
});
