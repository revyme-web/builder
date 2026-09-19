// oracle/telemetry.test.ts — P6 (vi): published shadow/bounce counters.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getOracleTelemetry,
  recordOracleBounce,
  recordOracleShadow,
  resetOracleTelemetry,
  setOracleShadowNotifier,
} from './telemetry';

beforeEach(() => {
  resetOracleTelemetry();
  setOracleShadowNotifier(null);
});

describe('oracle telemetry', () => {
  it('starts at zero with no last shadow', () => {
    expect(getOracleTelemetry()).toEqual({ shadows: 0, bounces: 0, lastShadow: null });
  });

  it('counts bounces', () => {
    recordOracleBounce();
    recordOracleBounce();
    const snap = getOracleTelemetry();
    expect(snap.bounces).toBe(2);
    expect(snap.shadows).toBe(0);
  });

  it('counts shadows, keeps the last sample, and notifies softly', () => {
    const seen: string[] = [];
    setOracleShadowNotifier((msg) => void seen.push(msg));
    recordOracleShadow(['MISSING_DATA_ID'], { sync: false });
    recordOracleShadow(['FORBIDDEN_IMPORT'], { sync: true });
    const snap = getOracleTelemetry();
    expect(snap.shadows).toBe(2);
    expect(snap.lastShadow).toMatchObject({ codes: ['FORBIDDEN_IMPORT'], sync: true });
    expect(typeof snap.lastShadow!.at).toBe('number');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain('non-blocking');
    expect(seen[0]).toContain('MISSING_DATA_ID');
  });

  it('a throwing notifier never breaks the write path', () => {
    setOracleShadowNotifier(() => {
      throw new Error('toast down');
    });
    expect(() => recordOracleShadow(['X'], { sync: true })).not.toThrow();
    expect(getOracleTelemetry().shadows).toBe(1);
  });

  it('reset clears everything', () => {
    recordOracleBounce();
    recordOracleShadow(['X'], { sync: false });
    resetOracleTelemetry();
    expect(getOracleTelemetry()).toEqual({ shadows: 0, bounces: 0, lastShadow: null });
  });
});
