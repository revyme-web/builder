import { describe, test, expect, vi, beforeEach } from 'vitest';
import { EntryDetector, type EntryCandidate } from './entry-detector';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

function mockCandidate(id: string): EntryCandidate {
  return { id, el: document.createElement('div') };
}

describe('EntryDetector', () => {
  let detector: EntryDetector;

  beforeEach(() => {
    detector = new EntryDetector(['node-1'], 3);
  });

  // ─── Basic grace period ─────────────────────────────────────────────

  test('does not confirm before threshold is reached', () => {
    const c = mockCandidate('frame-a');
    expect(detector.update('node-1', c)).toBe(false); // frame 1
    expect(detector.update('node-1', c)).toBe(false); // frame 2
    expect(detector.getState('node-1')!.confirmed).toBe(false);
  });

  test('confirms on the threshold frame', () => {
    const c = mockCandidate('frame-a');
    detector.update('node-1', c); // frame 1
    detector.update('node-1', c); // frame 2
    const result = detector.update('node-1', c); // frame 3 = threshold
    expect(result).toBe(true);
    expect(detector.getState('node-1')!.confirmed).toBe(true);
    expect(detector.getState('node-1')!.confirmedId).toBe('frame-a');
  });

  test('returns false on frames after confirmation (only true once)', () => {
    const c = mockCandidate('frame-a');
    detector.update('node-1', c);
    detector.update('node-1', c);
    expect(detector.update('node-1', c)).toBe(true);  // confirmed
    expect(detector.update('node-1', c)).toBe(false);  // already confirmed
    expect(detector.update('node-1', c)).toBe(false);
  });

  // ─── Candidate change resets grace ──────────────────────────────────

  test('resets grace when candidate changes', () => {
    const a = mockCandidate('frame-a');
    const b = mockCandidate('frame-b');
    detector.update('node-1', a); // frame 1 for A
    detector.update('node-1', a); // frame 2 for A
    detector.update('node-1', b); // candidate changed → reset to 1
    expect(detector.getState('node-1')!.graceFrames).toBe(1);
    expect(detector.getState('node-1')!.candidateId).toBe('frame-b');
  });

  test('null candidate resets grace to 0', () => {
    const a = mockCandidate('frame-a');
    detector.update('node-1', a);
    detector.update('node-1', a);
    detector.update('node-1', null); // left all frames
    expect(detector.getState('node-1')!.graceFrames).toBe(0);
    expect(detector.getState('node-1')!.candidateId).toBeNull();
  });

  // ─── Different thresholds ──────────────────────────────────────────

  test('works with threshold of 1 (immediate confirmation)', () => {
    detector = new EntryDetector(['node-1'], 1);
    expect(detector.update('node-1', mockCandidate('frame-a'))).toBe(true);
  });

  test('works with threshold of 5', () => {
    detector = new EntryDetector(['node-1'], 5);
    const c = mockCandidate('frame-a');
    for (let i = 0; i < 4; i++) {
      expect(detector.update('node-1', c)).toBe(false);
    }
    expect(detector.update('node-1', c)).toBe(true); // frame 5
  });

  // ─── Multi-node tracking ──────────────────────────────────────────

  test('tracks multiple nodes independently', () => {
    detector = new EntryDetector(['a', 'b', 'c'], 2);
    const frameX = mockCandidate('frame-x');
    const frameY = mockCandidate('frame-y');

    detector.update('a', frameX);
    detector.update('b', frameY);
    detector.update('c', null);

    // Second frame
    expect(detector.update('a', frameX)).toBe(true);  // confirmed
    expect(detector.update('b', frameY)).toBe(true);  // confirmed
    expect(detector.update('c', null)).toBe(false);    // still null

    expect(detector.getState('a')!.confirmedId).toBe('frame-x');
    expect(detector.getState('b')!.confirmedId).toBe('frame-y');
    expect(detector.getState('c')!.confirmed).toBe(false);
  });

  // ─── clearNode ────────────────────────────────────────────────────

  test('clearNode resets a specific node', () => {
    const c = mockCandidate('frame-a');
    detector.update('node-1', c);
    detector.update('node-1', c);
    detector.update('node-1', c); // confirmed
    expect(detector.getState('node-1')!.confirmed).toBe(true);

    detector.clearNode('node-1');
    expect(detector.getState('node-1')!.confirmed).toBe(false);
    expect(detector.getState('node-1')!.candidateId).toBeNull();
    expect(detector.getState('node-1')!.graceFrames).toBe(0);
  });

  // ─── hasConfirmed ─────────────────────────────────────────────────

  test('hasConfirmed returns true if any node is confirmed', () => {
    detector = new EntryDetector(['a', 'b'], 2);
    const c = mockCandidate('frame-x');
    expect(detector.hasConfirmed()).toBe(false);
    detector.update('a', c);
    detector.update('a', c); // confirmed
    expect(detector.hasConfirmed()).toBe(true);
  });

  // ─── reset ────────────────────────────────────────────────────────

  test('reset clears all nodes', () => {
    const c = mockCandidate('frame-a');
    detector.update('node-1', c);
    detector.update('node-1', c);
    detector.update('node-1', c); // confirmed
    detector.reset();
    expect(detector.getState('node-1')!.confirmed).toBe(false);
    expect(detector.getState('node-1')!.graceFrames).toBe(0);
  });

  // ─── Unknown node ID ─────────────────────────────────────────────

  test('update returns false for unknown node ID', () => {
    expect(detector.update('unknown', mockCandidate('x'))).toBe(false);
  });

  test('getState returns undefined for unknown node ID', () => {
    expect(detector.getState('unknown')).toBeUndefined();
  });
});
