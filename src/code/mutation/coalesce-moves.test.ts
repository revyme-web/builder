// coalesce-moves.test.ts — a superseded move's STYLES are not disposable.
//
// User report 2026-08-09: a frame added directly on the third viewport, dragged
// out to the canvas and straight into the primary in ONE gesture, vanished on
// mouse-up. It landed under the right parent at the right position, still
// `display: none`.
//
// The queue is HELD for the whole drag, so at drop it contains BOTH moves:
// exit→canvas (carrying the styles that undo the replica-solo hide) and
// enter→root. Only the last move per node may run — the destination is where
// the gesture ended — but the old filter dropped the earlier mutation whole,
// and a move's `styles` are the commit's CLEANUP, not positional noise.
//
// Starting the same drag from the canvas works because there is no earlier move
// to discard, which is exactly why this looked like a replica-only bug.

import { describe, it, expect } from 'vitest';
import { coalesceMoves } from './mutation-queue';

const move = (nodeId: string, newParentId: string | null, styles?: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ({ type: 'move', nodeId, newParentId, styles, ...extra }) as never;

describe('coalesceMoves', () => {
  it('THE BUG: the exit move`s cleanup styles survive onto the entry move', () => {
    const out = coalesceMoves([
      move('n1', null, { display: '', left: '1600px', top: '1300px' }),
      move('n1', 'root', { position: 'absolute', left: '173px', top: '157px' }),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as any).styles).toEqual({
      display: '',                    // carried from the dropped exit move
      position: 'absolute',
      left: '173px', top: '157px',    // the survivor's own values win
    });
  });

  it('the destination is the LAST move`s, never the dropped one`s', () => {
    const out = coalesceMoves([move('n1', null, { display: '' }), move('n1', 'root')]);
    expect((out[0] as any).newParentId).toBe('root');
  });

  it('non-style fields come from the survivor only', () => {
    const out = coalesceMoves([
      move('n1', null, {}, { canvasNode: true, sourceVpWidth: 666 }),
      move('n1', 'root', {}, { canvasNode: false, index: 2 }),
    ]);
    expect(out[0]).toMatchObject({ newParentId: 'root', canvasNode: false, index: 2 });
    expect((out[0] as any).sourceVpWidth).toBeUndefined();
  });

  it('three moves fold left-to-right, latest winning each key', () => {
    const out = coalesceMoves([
      move('n1', null, { display: '', left: '1px' }),
      move('n1', 'a', { left: '2px', top: '5px' }),
      move('n1', 'root', { left: '3px' }),
    ]);
    expect((out[0] as any).styles).toEqual({ display: '', left: '3px', top: '5px' });
  });

  it('keeps moves for different nodes independent', () => {
    const out = coalesceMoves([
      move('a', null, { display: '' }),
      move('b', null, { opacity: '0' }),
      move('a', 'root', { left: '1px' }),
    ]);
    expect(out).toHaveLength(2);
    const a = out.find((m: any) => m.nodeId === 'a') as any;
    const b = out.find((m: any) => m.nodeId === 'b') as any;
    expect(a.styles).toEqual({ display: '', left: '1px' });
    expect(b.styles).toEqual({ opacity: '0' });
  });

  it('a single move is returned untouched', () => {
    const one = [move('n1', 'root', { left: '1px' })];
    expect(coalesceMoves(one)).toEqual(one);
  });

  it('non-move mutations pass through in order', () => {
    const a = { type: 'updateStyles', nodeId: 'n1', styles: {} } as never;
    const b = { type: 'clearContainerStyles', nodeId: 'n1' } as never;
    const out = coalesceMoves([a, move('n1', null), b, move('n1', 'root')]);
    expect(out.map((m: any) => m.type)).toEqual(['updateStyles', 'clearContainerStyles', 'move']);
  });

  it('a dropped move with no styles carries nothing', () => {
    const out = coalesceMoves([move('n1', null), move('n1', 'root', { left: '1px' })]);
    expect((out[0] as any).styles).toEqual({ left: '1px' });
  });

  it('a survivor with no styles still receives the carried ones', () => {
    // Without this the cleanup is lost exactly as before, just more quietly.
    const out = coalesceMoves([move('n1', null, { display: '' }), move('n1', 'root')]);
    expect((out[0] as any).styles).toEqual({ display: '' });
  });
});
