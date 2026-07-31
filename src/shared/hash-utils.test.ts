import { describe, it, expect } from 'vitest';
import { simpleHash } from './hash-utils';

// Locks the exact historic output of the three consolidated copies
// (component-registry / icon-set-registry `simpleHash`, code-component-runtime
// `fastContentHash`) — cache keys must stay byte-identical across versions.
describe('simpleHash', () => {
  it('returns "0" for the empty string', () => {
    expect(simpleHash('')).toBe('0');
  });

  it('matches the djb2-style reference for known inputs', () => {
    const reference = (str: string): string => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return hash.toString(36);
    };
    for (const input of ['a', 'hello world', 'export default function Page() {}', '💧 unicode']) {
      expect(simpleHash(input)).toBe(reference(input));
    }
  });

  it('is stable and distinguishes different inputs', () => {
    expect(simpleHash('abc')).toBe(simpleHash('abc'));
    expect(simpleHash('abc')).not.toBe(simpleHash('abd'));
  });
});
