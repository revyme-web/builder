// StyleIndicator.tsx — Reusable pill badge for showing live values on canvas.
// Used by: resize helpers, ALT distance lines, CTRL+ALT dimensions, gap/padding handles.

import React, { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface StyleIndicatorProps {
  /** Screen-space X coordinate (centered) */
  x: number;
  /** Screen-space Y coordinate (centered) */
  y: number;
  /** Content to display */
  children: ReactNode;
  /** Background color — defaults to var(--accent) */
  color?: string;
  /**
   * Label color. Defaults to `var(--accent-fg)` so it tracks whatever
   * `--accent` currently is — near-black on the gold brand accent, white on
   * the violet the component-mode re-skin swaps in. It was hardcoded `#fff`,
   * which is 1.9:1 on gold.
   *
   * Callers that pass a CUSTOM `color` must pass a matching `fg` — the
   * default only holds for the accent background.
   */
  fg?: string;
  /** Size variant — 'sm' for compact distance labels, 'md' (default) for resize/dimensions */
  size?: 'sm' | 'md';
}

/**
 * The MEASUREMENT badge palette — the pill that reports a live width/height
 * while resizing, drawing a frame, or holding ⌥⌘.
 *
 * Fixed blue with white text, deliberately NOT the theme accent: a measurement
 * should read the same on every theme, and on the gold brand accent the badge
 * needs a near-black label, which looks like a different component. Inside a
 * component master it switches to the component-system violet, like the rest of
 * that chrome.
 *
 * Shared so the resize/draw helper and the ⌥⌘ dimensions badge can't drift —
 * they were two different colours for the same idea (user call 2026-08-08).
 */
export function measurementColors(isComponentFile: boolean): { color: string; fg: string } {
  return isComponentFile
    ? { color: 'var(--accent-secondary)', fg: 'var(--accent-secondary-fg)' }
    : { color: 'var(--selection)', fg: '#ffffff' };
}

// Cut tiers, not radii: the md pill takes the default --cut, the compact sm
// labels the .cut-sm tier so the notch stays proportional at 10px type.
const sizes = {
  sm: { cutClass: 'cut-corners cut-sm', padding: '2px 6px', fontWeight: 500, fontSize: 10 },
  md: { cutClass: 'cut-corners', padding: '4px 12px', fontWeight: 600, fontSize: 13 },
};

/**
 * Fixed-position pill badge portaled to document.body.
 * Center-anchored at (x, y) in screen coordinates.
 */
export default function StyleIndicator({ x, y, children, color = 'var(--accent)', fg = 'var(--accent-fg)', size = 'md' }: StyleIndicatorProps) {
  const s = sizes[size];
  return createPortal(
    <div
      className={s.cutClass}
      // No boxShadow: clip-path clips shadows at the notches, and a
      // partially-clipped shadow reads as a rendering glitch. The solid
      // accent fill separates fine from canvas content on its own.
      style={{
        position: 'fixed',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        zIndex: 4999,
        backgroundColor: color,
        padding: s.padding,
        fontWeight: s.fontWeight,
        fontSize: s.fontSize,
        fontFamily: 'Inter, system-ui, sans-serif',
        color: fg,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
