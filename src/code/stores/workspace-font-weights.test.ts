import { describe, it, expect, beforeEach } from 'vitest';
import { workspaceFamilyWeights, __setWorkspaceFontsForTest } from './workspace-fonts-store';
import type { WorkspaceFont } from '@/backend/types';

const face = (family: string, weight: number, style: 'normal' | 'italic' = 'normal', extra: Partial<WorkspaceFont> = {}): WorkspaceFont => ({
  id: `${family}-${weight}-${style}`, family, weight, style, ext: 'woff2',
  fileName: `${family}-${weight}.woff2`, size: 1, url: `https://cdn/${family}-${weight}-${style}.woff2`,
  uploadedAt: '', uploadedBy: '', ...extra,
});

beforeEach(() => __setWorkspaceFontsForTest([]));

describe('workspaceFamilyWeights', () => {
  it('offers only the cuts the family actually ships', () => {
    // The flat 100–900 list would offer six weights this family cannot
    // render, and the browser would synthesise them silently.
    __setWorkspaceFontsForTest([
      face('Beatrice', 300), face('Beatrice', 400), face('Beatrice', 700),
    ]);
    expect(workspaceFamilyWeights('Beatrice')).toEqual([
      { value: '300', label: 'Light 300' },
      { value: '400', label: 'Regular 400' },
      { value: '700', label: 'Bold 700' },
    ]);
  });

  it('counts a weight once even when it ships roman AND italic', () => {
    // Italic is its own control, not a second weight.
    __setWorkspaceFontsForTest([
      face('Beatrice', 400, 'normal'), face('Beatrice', 400, 'italic'),
      face('Beatrice', 700, 'normal'), face('Beatrice', 700, 'italic'),
    ]);
    expect(workspaceFamilyWeights('Beatrice')!.map((o) => o.value)).toEqual(['400', '700']);
  });

  it('gives a variable font every step inside its axis', () => {
    // One file covers the range continuously, so each step is real.
    __setWorkspaceFontsForTest([face('Inter', 100, 'normal', { isVariable: true, weightRange: { min: 100, max: 900 } })]);
    expect(workspaceFamilyWeights('Inter')!.map((o) => o.value))
      .toEqual(['100', '200', '300', '400', '500', '600', '700', '800', '900']);
  });

  it('clips the list to a narrower axis', () => {
    __setWorkspaceFontsForTest([face('Narrow', 300, 'normal', { isVariable: true, weightRange: { min: 300, max: 600 } })]);
    expect(workspaceFamilyWeights('Narrow')!.map((o) => o.value)).toEqual(['300', '400', '500', '600']);
  });

  it('returns null for a family we do not own', () => {
    // Google + system families keep the standard control.
    __setWorkspaceFontsForTest([face('Beatrice', 400)]);
    expect(workspaceFamilyWeights('Inter')).toBeNull();
    expect(workspaceFamilyWeights('')).toBeNull();
  });
});
