import { describe, it, expect } from 'vitest';
import { PathModel } from './PathModel';
import { ellipsePathD } from '@/shared/svg-geometry';

// A 4-bezier ellipse returns to its M point with an explicit final curve, which
// used to leave a REDUNDANT anchor stacked on the start → a circle showed 5
// vertices (two at the top) and dragging "the top" tore the stacked pair apart.
describe('PathModel — closed contour returning to its start', () => {
  it('an ellipse parses to 4 anchors, not 5 (no stacked anchor at the start)', () => {
    const m = new PathModel(ellipsePathD(121, 82));
    expect(m.closed).toBe(true);
    expect(m.anchors.length).toBe(4);
    // The first anchor (top) absorbs the closing curve's incoming handle, so it
    // is a proper smooth vertex with BOTH handles.
    expect(m.anchors[0].handleIn).not.toBeNull();
    expect(m.anchors[0].handleOut).not.toBeNull();
    // No two anchors coincide.
    for (let i = 0; i < m.anchors.length; i++) {
      for (let j = i + 1; j < m.anchors.length; j++) {
        const dx = Math.abs(m.anchors[i].point.x - m.anchors[j].point.x);
        const dy = Math.abs(m.anchors[i].point.y - m.anchors[j].point.y);
        expect(dx + dy).toBeGreaterThan(0.5);
      }
    }
  });

  it('a triangle (Z closes a REAL gap, last != first) keeps all 3 anchors', () => {
    const m = new PathModel('M60.5,0 L121,82 L0,82 Z');
    expect(m.closed).toBe(true);
    expect(m.anchors.length).toBe(3);
  });

  it('an open path is unaffected (no merge)', () => {
    const m = new PathModel('M0,0 L10,10 L20,0');
    expect(m.closed).toBe(false);
    expect(m.anchors.length).toBe(3);
  });
});

describe('PathModel — dragging the start of a closed contour keeps it closed', () => {
  it('moving the ellipse top anchor moves M AND the closing endpoint together (no split)', () => {
    const m = new PathModel(ellipsePathD(290, 222));
    expect(m.anchors.length).toBe(4);
    const top = { ...m.anchors[0].point };
    m.moveAnchor(0, 8, 85); // drag the top like the user did
    // still 4 anchors, still closed — did NOT tear into 5
    expect(m.anchors.length).toBe(4);
    expect(m.closed).toBe(true);
    // the serialized path's start == its closing endpoint (contour intact)
    const d = m.serialize();
    const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const startX = nums[0], startY = nums[1];
    expect(startX).toBeCloseTo(top.x + 8, 1);
    expect(startY).toBeCloseTo(top.y + 85, 1);
    // last coordinate pair before Z == start (closed, not split)
    expect(d.trim().toLowerCase().endsWith('z')).toBe(true);
  });

  it('moving a triangle start vertex does NOT drag the bottom-left vertex', () => {
    const m = new PathModel('M60.5,0 L121,82 L0,82 Z');
    m.moveAnchor(0, 10, 10);
    // 3 anchors preserved; the L0,82 vertex stays put
    expect(m.anchors.length).toBe(3);
    const bottomLeft = m.anchors.find(a => Math.abs(a.point.x - 0) < 1 && Math.abs(a.point.y - 82) < 1);
    expect(bottomLeft).toBeTruthy();
  });
});

describe('PathModel — closed-start anchor is mirror-capable', () => {
  it('a fresh ellipse top anchor is detected as mirrored (smooth)', () => {
    const m = new PathModel(ellipsePathD(200, 200));
    expect(m.anchors[0].handleMode).toBe('mirrored');
    // both handles present and roughly opposite
    const hi = m.anchors[0].handleIn!, ho = m.anchors[0].handleOut!;
    expect(Math.abs(hi.x + ho.x)).toBeLessThan(2);
    expect(Math.abs(hi.y + ho.y)).toBeLessThan(2);
  });

  it('dragging the top anchor OUT handle in mirror mode moves the IN handle too', () => {
    const m = new PathModel(ellipsePathD(200, 200));
    m.setHandleMode(0, 'mirrored');
    const inBefore = { ...m.anchors[0].handleIn! };
    // drag the outgoing handle to a new absolute position
    const a0 = m.anchors[0].point;
    m.setHandleAbsolute(0, 'out', { x: a0.x + 40, y: a0.y + 10 });
    const inAfter = m.anchors[0].handleIn!;
    // the incoming handle (on the CLOSING curve) actually changed → mirror works
    expect(Math.abs(inAfter.x - inBefore.x) + Math.abs(inAfter.y - inBefore.y)).toBeGreaterThan(1);
    // and it's the mirror of the new outgoing handle
    const ho = m.anchors[0].handleOut!;
    expect(Math.abs(inAfter.x + ho.x)).toBeLessThan(2);
    expect(Math.abs(inAfter.y + ho.y)).toBeLessThan(2);
  });
});
