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
  /** Size variant — 'sm' for compact distance labels, 'md' (default) for resize/dimensions */
  size?: 'sm' | 'md';
}

const sizes = {
  sm: { borderRadius: 5, padding: '2px 6px', fontWeight: 500, fontSize: 10 },
  md: { borderRadius: 8, padding: '4px 12px', fontWeight: 600, fontSize: 13 },
};

/**
 * Fixed-position pill badge portaled to document.body.
 * Center-anchored at (x, y) in screen coordinates.
 */
export default function StyleIndicator({ x, y, children, color = 'var(--accent)', size = 'md' }: StyleIndicatorProps) {
  const s = sizes[size];
  return createPortal(
    <div
      style={{
        position: 'fixed',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        zIndex: 4999,
        backgroundColor: color,
        borderRadius: s.borderRadius,
        padding: s.padding,
        fontWeight: s.fontWeight,
        fontSize: s.fontSize,
        fontFamily: 'Inter, system-ui, sans-serif',
        color: '#fff',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.2)',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
