import { describe, it, expect } from 'vitest';
import { setInstanceFxInCode } from '@/code/generation/instance-fx-gen';
import { syncImports, validateGeneratedCode } from './mutation-queue';

const PAGE = `'use client';
import React from 'react';
import Card from '@/components/Card';
export default function Page() {
  return (<div data-id="root"><Card data-id="card" style={{ position: 'absolute' }} /></div>);
}`;

describe('instance-fx — imports synced before validation', () => {
  it('hover+tap+appear+loop validate clean once syncImports adds the hooks/fns', () => {
    const set = setInstanceFxInCode(PAGE, 'card', {
      hover: { to: { scale: 1.05 } },
      tap: { to: { scale: 0.95 } },
      appear: { from: { opacity: 0, y: 20 } },
      loop: { keyframes: { rotate: [0, 360] } },
    });
    // pre-sync: hooks unimported → the guard would block
    expect(validateGeneratedCode(set)).toBeTruthy();
    // post-sync: useMotionValue/useTransform/animate/hover/press/useEffect/useRef added → clean
    expect(validateGeneratedCode(syncImports(set))).toBeNull();
    const synced = syncImports(set);
    expect(synced).toMatch(/import \{[^}]*\bhover\b[^}]*\} from 'framer-motion'/);
    expect(synced).toMatch(/import \{[^}]*\bpress\b[^}]*\} from 'framer-motion'/);
  });

  it('responsive Scroll Transform: useMediaQuery hook validates after its useState/useEffect imports sync', () => {
    const set = setInstanceFxInCode(PAGE, 'card', {
      transform: {
        from: { scale: 0.5 }, to: { scale: 1 }, trigger: 'onScroll',
        responsive: [{ scope: { query: '(max-width: 768px) and (min-width: 376px)' }, to: { scale: 1.5 } }],
      },
    });
    // The emitted useMediaQuery hook uses useState/useEffect — syncImports must add them.
    expect(set).toMatch(/function useMediaQuery\(/);
    expect(validateGeneratedCode(syncImports(set))).toBeNull();
    const synced = syncImports(set);
    expect(synced).toMatch(/import React, \{[^}]*\buseState\b/);
    expect(synced).toMatch(/import React, \{[^}]*\buseEffect\b/);
  });
});
