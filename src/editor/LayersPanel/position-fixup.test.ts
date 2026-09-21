// Layers-tree reparent of a `position: fixed` node (2026-09-06): fixed is
// page-level only; inside any frame it must become absolute — the canvas drag
// already does this on entry, the layers drop didn't for flex/grid targets.
import { describe, it, expect } from 'vitest';
import { positionFixupForLayersReparent } from './drag';

describe('positionFixupForLayersReparent', () => {
  it('fixed → absolute (pins kept by the caller)', () => {
    expect(positionFixupForLayersReparent({ position: 'fixed', left: '10px', bottom: '20px' })).toEqual({ position: 'absolute' });
  });
  it('relative / absolute / static / missing → no change', () => {
    expect(positionFixupForLayersReparent({ position: 'relative' })).toBeNull();
    expect(positionFixupForLayersReparent({ position: 'absolute' })).toBeNull();
    expect(positionFixupForLayersReparent({ position: 'static' })).toBeNull();
    expect(positionFixupForLayersReparent({})).toBeNull();
    expect(positionFixupForLayersReparent(undefined)).toBeNull();
  });
});

// B14 (2026-09-21): an ABSOLUTE node dropped INTO a flex/grid frame kept
// `position: absolute` and its pins, so it ignored the layout and sat wherever
// its old left/top put it. A layout child has to join the flow — the same delta
// the canvas drag commits on layout entry (CanvasDragStrategy.ts:2910).
describe('positionFixupForLayersReparent — entering a layout', () => {
  const ABS = { position: 'absolute', left: '27.69%', top: '53.25%' };

  it('absolute → relative with every inset cleared, on flex', () => {
    expect(positionFixupForLayersReparent(ABS, 'flex'))
      .toEqual({ position: 'relative', left: '', top: '', right: '', bottom: '' });
  });

  it('does the same on grid', () => {
    expect(positionFixupForLayersReparent(ABS, 'grid')?.position).toBe('relative');
  });

  it('converts fixed all the way to flow, not just to absolute', () => {
    expect(positionFixupForLayersReparent({ position: 'fixed', left: '10px' }, 'flex'))
      .toEqual({ position: 'relative', left: '', top: '', right: '', bottom: '' });
  });

  // A stale inset still offsets a relatively-positioned box, so clearing them
  // is the point — not cosmetic.
  it('clears insets the node did not declare, so none can survive', () => {
    const out = positionFixupForLayersReparent({ position: 'absolute', left: '10px' }, 'flex')!;
    expect(out.right).toBe('');
    expect(out.bottom).toBe('');
  });

  // Outside a layout the pins still anchor to the new frame — unchanged.
  it('keeps the old behaviour when the destination has no layout', () => {
    expect(positionFixupForLayersReparent(ABS, 'none')).toBeNull();
    expect(positionFixupForLayersReparent(ABS, undefined)).toBeNull();
    expect(positionFixupForLayersReparent({ position: 'fixed' }, 'none')).toEqual({ position: 'absolute' });
  });

  it('leaves a flow node alone', () => {
    expect(positionFixupForLayersReparent({ position: 'relative' }, 'flex')).toBeNull();
    expect(positionFixupForLayersReparent({}, 'flex')).toBeNull();
  });
});
