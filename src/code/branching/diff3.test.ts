// branching/diff3.test.ts — P8 (iv): 3-way merge core, proofs.

import { describe, it, expect } from 'vitest';
import { diff3Merge, DIFF3_MAX_LINES, type Diff3Chunk } from './diff3';

const L = (s: string): string[] => s.split('\n');

function cleanText(chunks: Diff3Chunk[]): string {
  const out: string[] = [];
  for (const c of chunks) {
    if (c.kind === 'conflict') return '__CONFLICT__';
    out.push(...c.lines);
  }
  return out.join('\n');
}

describe('diff3Merge', () => {
  it('identical inputs merge clean', () => {
    const base = L('a\nb\nc');
    expect(cleanText(diff3Merge(base, [...base], [...base]))).toBe('a\nb\nc');
  });

  it('one-sided change wins (either side)', () => {
    const base = L('a\nb\nc');
    expect(cleanText(diff3Merge(base, L('a\nB\nc'), [...base]))).toBe('a\nB\nc');
    expect(cleanText(diff3Merge(base, [...base], L('a\nB\nc')))).toBe('a\nB\nc');
  });

  it('disjoint two-sided changes merge', () => {
    const base = L('a\nb\nc\nd');
    expect(cleanText(diff3Merge(base, L('A\nb\nc\nd'), L('a\nb\nc\nD')))).toBe('A\nb\nc\nD');
  });

  it('identical two-sided changes merge silently (no conflict)', () => {
    const base = L('a\nb\nc');
    const chunks = diff3Merge(base, L('a\nB\nc'), L('a\nB\nc'));
    expect(chunks.some((c) => c.kind === 'conflict')).toBe(false);
    expect(cleanText(chunks)).toBe('a\nB\nc');
  });

  it('overlapping changes conflict with honest ranges', () => {
    const base = L('a\nb\nc');
    const chunks = diff3Merge(base, L('a\nB1\nc'), L('a\nB2\nc'));
    const conflicts = chunks.filter((c) => c.kind === 'conflict');
    expect(conflicts).toHaveLength(1);
    const k = conflicts[0];
    if (k.kind !== 'conflict') throw new Error('unreachable');
    expect({ baseStart: k.baseStart, baseEnd: k.baseEnd }).toEqual({ baseStart: 1, baseEnd: 2 });
  });

  it('insertions at the same anchor conflict unless identical', () => {
    const base = L('a\nc');
    const same = diff3Merge(base, L('a\nb\nc'), L('a\nb\nc'));
    expect(same.some((c) => c.kind === 'conflict')).toBe(false);
    const diff = diff3Merge(base, L('a\nb1\nc'), L('a\nb2\nc'));
    expect(diff.some((c) => c.kind === 'conflict')).toBe(true);
  });

  it('insertions at different anchors both land', () => {
    const base = L('a\nd');
    expect(cleanText(diff3Merge(base, L('a\nb\nd'), L('a\nd\ne')))).toBe('a\nb\nd\ne');
  });

  it('deletion vs edit on the same lines conflicts', () => {
    const base = L('a\nb\nc');
    expect(diff3Merge(base, L('a\nc'), L('a\nB\nc')).some((c) => c.kind === 'conflict')).toBe(true);
  });

  it('deletion on one side only applies cleanly', () => {
    const base = L('a\nb\nc');
    expect(cleanText(diff3Merge(base, L('a\nc'), [...base]))).toBe('a\nc');
  });

  it('oversize input falls back to whole-file conflict (never hangs)', () => {
    const big = new Array<string>(DIFF3_MAX_LINES + 1).fill('x');
    const chunks = diff3Merge(big, [...big], [...big, 'y']);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('conflict');
  });
});
