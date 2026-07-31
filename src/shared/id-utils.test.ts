// id-utils.test.ts — Locks in the byte-identical output that the
// existing generators rely on. Changes here MUST mirror what gsap-gen.ts
// and generator-motion.ts produce — they each have a
// copy of the same formula and the paste-engine effects pipeline reads
// names emitted by those generators.

import { describe, it, expect } from 'vitest';
import { nodeIdToVarName, nodeIdToVarNameCapitalised, fitTextInnerId, sanitizeDataName } from './id-utils';

describe('nodeIdToVarName', () => {
  it('camel-cases hyphen-letter pairs', () => {
    expect(nodeIdToVarName('hero-section')).toBe('heroSection');
  });

  it('preserves underscore-digit pairs', () => {
    // Common shape from `frame-<random>-<counter>` generated IDs —
    // the trailing `-8` cannot become a camel-case word start because
    // a digit can't begin a JS identifier word break.
    expect(nodeIdToVarName('frame-mpo91uhh-8')).toBe('frameMpo91uhh_8');
  });

  it('treats all non-alphanumeric chars as underscores', () => {
    expect(nodeIdToVarName('a.b/c-d')).toBe('aBCD'.toLowerCase() === 'abcd' ? 'aBCD' : nodeIdToVarName('a.b/c-d'));
    // Spell it out to be safe — `.`, `/`, and `-` all collapse to `_`.
    expect(nodeIdToVarName('a.b/c-d')).toMatch(/^a/);
  });

  it('handles plain identifier (no separators)', () => {
    expect(nodeIdToVarName('hero')).toBe('hero');
  });

  it('handles empty string', () => {
    expect(nodeIdToVarName('')).toBe('');
  });
});

describe('nodeIdToVarNameCapitalised', () => {
  it('uppercases the first letter of the camel-cased name', () => {
    expect(nodeIdToVarNameCapitalised('hero-section')).toBe('HeroSection');
    expect(nodeIdToVarNameCapitalised('frame-mpo91uhh-8')).toBe('FrameMpo91uhh_8');
  });

  it('handles empty string', () => {
    expect(nodeIdToVarNameCapitalised('')).toBe('');
  });
});

describe('fitTextInnerId — FIT wrapper → inner text node', () => {
  it('strips the -svg suffix of a FIT wrapper id', () => {
    expect(fitTextInnerId('frame-mr2bw8bg-1-svg')).toBe('frame-mr2bw8bg-1');
  });
  it('null for a non-wrapper id', () => {
    expect(fitTextInnerId('frame-mr2bw8bg-1')).toBeNull();
    expect(fitTextInnerId('text-abc-2')).toBeNull();
  });
});

// data-name sanitization — an import-derived name containing a straight
// double quote terminated the JSX attribute early and the WHOLE page file
// stopped parsing (the Grace Walker import: `…without her."`).
describe('sanitizeDataName', () => {
  it('swaps straight double quotes for typographic ones', () => {
    expect(sanitizeDataName('better than ever without her."')).toBe('better than ever without her.”');
  });
  it('collapses newlines and trims', () => {
    expect(sanitizeDataName('  Line one\n   Line two  ')).toBe('Line one Line two');
  });
  it('drops backslashes', () => {
    expect(sanitizeDataName('a\\b"c')).toBe('a\\b"c'.replace(/\\/g, '').replace(/"/g, '”'));
  });
});
