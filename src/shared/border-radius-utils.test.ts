import { describe, it, expect } from 'vitest';
import { clampRadiusToCapsule } from './border-radius-utils';

describe('clampRadiusToCapsule', () => {
  it('clamps an over-capsule px radius to floor(height/2)', () => {
    expect(clampRadiusToCapsule('95px', 65)).toBe('32px');
    expect(clampRadiusToCapsule('100px', 66)).toBe('33px');
  });
  it('passes honest values through unchanged', () => {
    expect(clampRadiusToCapsule('19px', 65)).toBe('19px');
    expect(clampRadiusToCapsule('32px', 65)).toBe('32px');
  });
  it('never touches %, multi-value, fancy or empty values', () => {
    expect(clampRadiusToCapsule('50%', 65)).toBe('50%');
    expect(clampRadiusToCapsule('10px 20px', 65)).toBe('10px 20px');
    expect(clampRadiusToCapsule('', 65)).toBe('');
    expect(clampRadiusToCapsule('95px', 0)).toBe('95px');
  });
});
