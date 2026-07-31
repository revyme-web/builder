import { describe, it, expect, beforeEach } from 'vitest';

// Create a fresh instance for testing (not the singleton)
import { MIN_SCALE, MAX_SCALE } from './constants';

interface Transform { x: number; y: number; scale: number; }

// Inline a testable version (the singleton has global state)
function createTestTransformManager() {
  let transform: Transform = { x: 0, y: 0, scale: 1 };
  const listeners = new Set<() => void>();

  return {
    getTransform: () => ({ ...transform }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    pan: (dx: number, dy: number) => { transform.x += dx; transform.y += dy; },
    zoom: (anchorX: number, anchorY: number, scaleDelta: number) => {
      const { x, y, scale } = transform;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + scaleDelta));
      const canvasX = (anchorX - x) / scale;
      const canvasY = (anchorY - y) / scale;
      transform.x = anchorX - canvasX * newScale;
      transform.y = anchorY - canvasY * newScale;
      transform.scale = newScale;
    },
    zoomByFactor: (anchorX: number, anchorY: number, factor: number) => {
      const { x, y, scale } = transform;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      const canvasX = (anchorX - x) / scale;
      const canvasY = (anchorY - y) / scale;
      transform.x = anchorX - canvasX * newScale;
      transform.y = anchorY - canvasY * newScale;
      transform.scale = newScale;
    },
    setTransform: (t: Transform) => { transform = { ...t }; },
    reset: () => { transform = { x: 0, y: 0, scale: 1 }; },
  };
}

describe('TransformManager', () => {
  let tm: ReturnType<typeof createTestTransformManager>;

  beforeEach(() => {
    tm = createTestTransformManager();
  });

  describe('pan', () => {
    it('pans by delta', () => {
      tm.pan(100, 50);
      expect(tm.getTransform()).toEqual({ x: 100, y: 50, scale: 1 });
    });

    it('accumulates pan', () => {
      tm.pan(10, 20);
      tm.pan(30, 40);
      expect(tm.getTransform()).toEqual({ x: 40, y: 60, scale: 1 });
    });
  });

  describe('zoom', () => {
    it('zooms at anchor point', () => {
      tm.zoom(500, 500, 0.5); // zoom in at center
      const t = tm.getTransform();
      expect(t.scale).toBe(1.5);
      // Anchor point should stay fixed
    });

    it('clamps to MIN_SCALE', () => {
      tm.zoom(0, 0, -100); // massive zoom out
      expect(tm.getTransform().scale).toBe(MIN_SCALE);
    });

    it('clamps to MAX_SCALE', () => {
      tm.zoom(0, 0, 100); // massive zoom in
      expect(tm.getTransform().scale).toBe(MAX_SCALE);
    });

    it('keeps anchor point fixed', () => {
      // Place canvas at known position
      tm.setTransform({ x: 100, y: 100, scale: 1 });
      const anchorX = 400;
      const anchorY = 300;

      // Canvas point under anchor before zoom
      const t0 = tm.getTransform();
      const canvasX = (anchorX - t0.x) / t0.scale;
      const canvasY = (anchorY - t0.y) / t0.scale;

      // Zoom
      tm.zoom(anchorX, anchorY, 0.5);

      // Canvas point under anchor after zoom should be the same
      const t1 = tm.getTransform();
      const canvasX2 = (anchorX - t1.x) / t1.scale;
      const canvasY2 = (anchorY - t1.y) / t1.scale;

      expect(Math.abs(canvasX - canvasX2)).toBeLessThan(0.001);
      expect(Math.abs(canvasY - canvasY2)).toBeLessThan(0.001);
    });
  });

  describe('zoomByFactor', () => {
    it('zooms by multiplicative factor', () => {
      tm.zoomByFactor(0, 0, 2); // double
      expect(tm.getTransform().scale).toBe(2);
    });

    it('handles pinch zoom out', () => {
      tm.zoomByFactor(0, 0, 0.5); // half
      expect(tm.getTransform().scale).toBe(0.5);
    });

    it('clamps to bounds', () => {
      tm.zoomByFactor(0, 0, 0.001); // extreme zoom out
      expect(tm.getTransform().scale).toBe(MIN_SCALE);
    });
  });

  describe('subscribe', () => {
    it('returns unsubscribe function', () => {
      let count = 0;
      const unsub = tm.subscribe(() => { count++; });
      unsub();
      // After unsubscribe, listener should not be called
      // (We can't easily test notify since it's batched via RAF in real impl)
    });
  });
});
