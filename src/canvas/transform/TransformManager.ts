// transform/TransformManager.ts — Core pan/zoom state for infinite canvas.
// Pure imperative singleton — no React, no Jotai.
// Everything else reads from this via getTransform() and subscribes via subscribe().
//
// Uses requestAnimationFrame batching so multiple pan+zoom calls in one frame
// only trigger one DOM update.

import { MIN_SCALE, MAX_SCALE } from './constants';
import { clamp } from '@/shared/math-utils';
import type { Transform } from '@/shared/types';

export type { Transform };

/**
 * After a scale change settles, wait this long before clearing `will-change`
 * on viewport roots so Chrome re-rasterizes at the new scale. Lower = sharper
 * faster but more raster work mid-gesture; higher = smoother gesture but
 * stays blurry longer after release.
 */
const ZOOM_END_DEBOUNCE_MS = 180;

class TransformManager {
  private transform: Transform = { x: 200, y: 100, scale: 0.5 };
  private listeners: Set<() => void> = new Set();
  private elements: HTMLElement[] = [];
  private rafId: number | null = null;
  private zoomEndTimer: number | null = null;
  private isZooming = false;

  // ─── Read ───────────────────────────────────────────────────────────

  getTransform(): Transform {
    return { ...this.transform };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // ─── Elements ───────────────────────────────────────────────────────

  /** Register an element to receive transform updates (content div, viewport overlay, etc.) */
  addElement(el: HTMLElement): void {
    if (!this.elements.includes(el)) {
      this.elements.push(el);
      this.applyToElement(el);
    }
  }

  /** Unregister an element */
  removeElement(el: HTMLElement): void {
    this.elements = this.elements.filter(e => e !== el);
  }

  /** Apply current transform to a single element */
  applyToElement(el: HTMLElement): void {
    const { x, y, scale } = this.transform;
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    el.style.transformOrigin = '0 0';
  }

  // ─── Mutate ─────────────────────────────────────────────────────────

  /** Pan by screen-space delta (mouse/touch movement) */
  pan(dx: number, dy: number): void {
    this.transform.x += dx;
    this.transform.y += dy;
    this.scheduleFlush();
  }

  /**
   * Zoom at a screen-space anchor point (mouse position relative to container).
   * Keeps the point under the cursor fixed.
   *
   * @param anchorX — screen X relative to container left
   * @param anchorY — screen Y relative to container top
   * @param scaleDelta — additive scale change (positive = zoom in, negative = zoom out)
   */
  zoom(anchorX: number, anchorY: number, scaleDelta: number): void {
    const { x, y, scale } = this.transform;
    const newScale = clamp(scale + scaleDelta, MIN_SCALE, MAX_SCALE);

    // Canvas point under the anchor before zoom
    const canvasX = (anchorX - x) / scale;
    const canvasY = (anchorY - y) / scale;

    // Adjust pan so the same canvas point stays under the anchor
    this.transform.x = anchorX - canvasX * newScale;
    this.transform.y = anchorY - canvasY * newScale;
    this.transform.scale = newScale;

    if (newScale !== scale) this.beginZooming();
    this.scheduleFlush();
  }

  /**
   * Zoom using a multiplicative factor (for pinch gestures).
   * factor > 1 = zoom in, factor < 1 = zoom out.
   */
  zoomByFactor(anchorX: number, anchorY: number, factor: number): void {
    const { x, y, scale } = this.transform;
    const newScale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);

    const canvasX = (anchorX - x) / scale;
    const canvasY = (anchorY - y) / scale;

    this.transform.x = anchorX - canvasX * newScale;
    this.transform.y = anchorY - canvasY * newScale;
    this.transform.scale = newScale;

    if (newScale !== scale) this.beginZooming();
    this.scheduleFlush();
  }

  /** Set transform directly (for animations, restore, etc.) */
  setTransform(t: Transform): void {
    const wasScale = this.transform.scale;
    this.transform = { ...t };
    if (this.transform.scale !== wasScale) this.beginZooming();
    this.scheduleFlush();
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Called whenever scale changes. Promotes viewport roots to GPU layers
   * (`will-change: transform`) so the in-flight zoom is composited from
   * the cached bitmap (smooth but blurry while zooming). After a debounce
   * with no further scale change, the flag is removed so Chrome
   * re-rasterizes each viewport at the new scale (sharp text/borders).
   *
   * Why not leave will-change set permanently?
   *   Chrome auto re-rasterizes on transform scale change ONLY when
   *   will-change is NOT set. With will-change, it keeps the cached
   *   bitmap and stretches it = pixelated text at any zoom > 100%.
   *   See https://developer.chrome.com/blog/re-rastering-composite.
   *
   * Why not always remove will-change?
   *   Mid-gesture, the re-raster is expensive and creates jank during
   *   continuous zoom. The debounce keeps the gesture smooth and only
   *   pays the raster cost once when the user stops.
   */
  private beginZooming(): void {
    const targets = document.querySelectorAll<HTMLElement>(
      '[data-viewport]:not([data-overlay-portal])',
    );
    if (!this.isZooming) {
      this.isZooming = true;
      for (const el of targets) el.style.willChange = 'transform';
    }
    if (this.zoomEndTimer !== null) {
      clearTimeout(this.zoomEndTimer);
    }
    this.zoomEndTimer = window.setTimeout(() => {
      this.zoomEndTimer = null;
      this.isZooming = false;
      const settled = document.querySelectorAll<HTMLElement>(
        '[data-viewport]:not([data-overlay-portal])',
      );
      for (const el of settled) el.style.willChange = '';
    }, ZOOM_END_DEBOUNCE_MS);
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      for (const el of this.elements) {
        this.applyToElement(el);
      }
      this.notify();
    });
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const transformManager = new TransformManager();
