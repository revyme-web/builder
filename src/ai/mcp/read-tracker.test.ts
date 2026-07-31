import { describe, it, expect, beforeEach } from 'vitest';
import { hashContent, creditRead, checkStaleWrites, resetReadTracker } from './read-tracker';

const codes = (vs: { code: string }[]) => vs.map((v) => v.code);

describe('read-tracker (MCP stale-write guard)', () => {
  beforeEach(() => resetReadTracker());

  it('hashContent is stable and discriminating', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
    expect(hashContent('')).toBe(hashContent(''));
  });

  it('NEW file (no live content) is exempt even if never read', () => {
    const live = (_p: string) => null; // path does not exist on disk
    expect(checkStaleWrites([{ path: 'components/New.tsx' }], live)).toEqual([]);
  });

  it('existing file NEVER read this session → STALE_FILE (blind overwrite)', () => {
    const live = (_p: string) => 'export const x = 1;';
    const vs = checkStaleWrites([{ path: 'components/Header.tsx' }], live);
    expect(codes(vs)).toEqual(['STALE_FILE']);
    expect(vs[0].message).toContain('have not read it');
    expect(vs[0].message).toContain('revyme_read_file("components/Header.tsx")');
  });

  it('credited then unchanged → allowed', () => {
    const code = 'export const x = 1;';
    creditRead('components/Header.tsx', code);
    expect(checkStaleWrites([{ path: 'components/Header.tsx' }], () => code)).toEqual([]);
  });

  it('credited then LIVE changed (user edited) → STALE_FILE (changed since read)', () => {
    creditRead('components/Header.tsx', 'height: 440px');
    const vs = checkStaleWrites([{ path: 'components/Header.tsx' }], () => 'height: auto');
    expect(codes(vs)).toEqual(['STALE_FILE']);
    expect(vs[0].message).toContain('has changed in the editor');
  });

  it('credits the LATEST read (re-read after an edit clears the stale state)', () => {
    creditRead('components/Header.tsx', 'height: 440px');
    // user edits live to auto; client re-reads:
    creditRead('components/Header.tsx', 'height: auto');
    expect(checkStaleWrites([{ path: 'components/Header.tsx' }], () => 'height: auto')).toEqual([]);
  });

  it('null/undefined code credits nothing (missing file read)', () => {
    creditRead('components/Ghost.tsx', null);
    creditRead('components/Ghost.tsx', undefined);
    // still counts as never-read when it later exists
    const vs = checkStaleWrites([{ path: 'components/Ghost.tsx' }], () => 'live');
    expect(codes(vs)).toEqual(['STALE_FILE']);
  });

  it('mixed batch: one fresh, one stale, one new — only the stale bounces', () => {
    creditRead('a.tsx', 'A');
    creditRead('b.tsx', 'B-old');
    const live = (p: string) => (p === 'a.tsx' ? 'A' : p === 'b.tsx' ? 'B-new' : null);
    const vs = checkStaleWrites([{ path: 'a.tsx' }, { path: 'b.tsx' }, { path: 'c-new.tsx' }], live);
    expect(vs.length).toBe(1);
    expect(vs[0].message).toContain('b.tsx');
  });

  it('resetReadTracker clears all credits', () => {
    creditRead('a.tsx', 'A');
    resetReadTracker();
    expect(codes(checkStaleWrites([{ path: 'a.tsx' }], () => 'A'))).toEqual(['STALE_FILE']);
  });
});
