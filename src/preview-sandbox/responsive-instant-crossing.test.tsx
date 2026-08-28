// Guards @revyme/runtime's withResponsiveProps breakpoint-crossing contract
// (runtime 0.0.15). Two regressions this pins, both user-visible on window
// resize across a breakpoint:
//
// 1. NO REMOUNT. The instant-crossing MotionConfig used to be CONDITIONALLY
//    wrapped — the element-type change at that slot made React tear the whole
//    design component down twice per crossing (state reset, loops restarted,
//    and the unwrap-commit remount re-played every entrance animation at full
//    duration — the post-crossing slide). The wrapper is now always mounted;
//    only its `transition` prop toggles.
//
// 2. TWO-COMMIT INSTANT WINDOW. A component WITH CONNECTIONS holds its variant
//    in state and syncs it from `initialVariant` in an effect, so its visible
//    switch lands one commit AFTER the prop change. A one-commit window
//    released in the same effect batch — the switch animated at full duration
//    (2026-08-27: header slides into mobile on resize). The window now spans
//    two commits, covering the state-sync commit.
//
// Imports the INSTALLED package (what pages actually resolve), not the
// runtime workspace — a stale node_modules copy fails this suite.
import { describe, test, expect } from 'vitest';
import { useState, useEffect, useContext, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { MotionConfigContext } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

let mounts = 0;
type RenderRecord = { variant: string; initialVariant: string; duration: number | undefined };
const renders: RenderRecord[] = [];

/** Mimics codegen's connection-bearing component: variant lives in state,
 *  synced from the `initialVariant` prop in an effect — the exact shape that
 *  escaped the one-commit window. Records what a motion element would see. */
function StatefulNav({ initialVariant = 'default' }: { initialVariant?: string; style?: React.CSSProperties }) {
  const mountId = useRef(0);
  if (mountId.current === 0) mountId.current = ++mounts;
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  const config = useContext(MotionConfigContext);
  const t = config.transition as { duration?: number } | undefined;
  renders.push({ variant, initialVariant, duration: t?.duration });
  return <div data-variant={variant} />;
}

const Wrapped = withResponsiveProps(StatefulNav as any) as any;

function setWindowWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

describe('withResponsiveProps breakpoint crossing', () => {
  test('crossing switches the stateful variant inside the instant window, without remounting', () => {
    mounts = 0;
    renders.length = 0;
    setWindowWidth(1200);
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() => {
      root.render(
        <Wrapped data-responsive='{"450":{"initialVariant":"variant-1"},"_bp":[450,1440]}' />,
      );
    });
    expect(el.querySelector('[data-variant]')!.getAttribute('data-variant')).toBe('default');
    const mountsBefore = mounts;
    renders.length = 0;

    // Cross into the 450 bucket.
    act(() => {
      setWindowWidth(400);
      window.dispatchEvent(new Event('resize'));
    });

    // The switch landed…
    expect(el.querySelector('[data-variant]')!.getAttribute('data-variant')).toBe('variant-1');
    // …without remounting the component (always-mounted MotionConfig).
    expect(mounts).toBe(mountsBefore);

    // Every render that participated in the switch — the prop-change commit
    // AND the state-sync commit where `variant` catches up — saw the
    // duration-0 default. This is the two-commit window: with the old
    // one-commit release, the sync commit recorded `duration: undefined`.
    const switching = renders.filter((r, i) => {
      const prev = i > 0 ? renders[i - 1] : null;
      return r.initialVariant === 'variant-1' && (!prev || prev.variant !== r.variant || r.variant !== r.initialVariant);
    });
    expect(switching.length).toBeGreaterThan(0);
    for (const r of switching) expect(r.duration).toBe(0);

    // The window closes: the last settled render has no duration-0 override.
    expect(renders[renders.length - 1]).toMatchObject({ variant: 'variant-1', duration: undefined });

    // Unmount so this root's resize listener can't leak into later tests.
    act(() => root.unmount());
  });

  test('resize within the same bucket does not re-render or open the window', () => {
    mounts = 0;
    renders.length = 0;
    setWindowWidth(1200);
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() => {
      root.render(
        <Wrapped data-responsive='{"450":{"initialVariant":"variant-1"},"_bp":[450,1440]}' />,
      );
    });
    const countAfterMount = renders.length;
    act(() => {
      setWindowWidth(1100); // still in the 1440 bucket
      window.dispatchEvent(new Event('resize'));
    });
    expect(renders.length).toBe(countAfterMount); // bucket unchanged → React bailed
    act(() => root.unmount());
  });
});
