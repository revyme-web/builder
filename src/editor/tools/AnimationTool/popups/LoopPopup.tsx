// AnimationTool/popups/LoopPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useCallback } from 'react';
import { ControlLabel, ToolInput, ToolSlider, ToolSegmentedControl } from '../../../controls';
import { useToolPopup } from '../../../ui/ToolPopup';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { SerScope } from '@/code/generation/generator-motion';
import { TransitionRow } from './TransitionRow';

/** Loop-specific inline controls rendered ABOVE the Transition button:
 *    - Repeat:    ∞ (Infinity) | N (finite count)
 *    - Count:     numeric input, only shown when Repeat = N
 *    - Yoyo:      No | Yes  (toggles transition.repeatType = 'reverse')
 *    - Loop Delay: seconds between each repetition
 *  These map to Motion's `transition` keys: `repeat`, `repeatType`,
 *  `repeatDelay`. The user can still open the Transition panel below for
 *  duration / ease and the full set. */
// Default (no-op) value per loop prop — opacity/scale rest at 1, transforms at 0.
const LOOP_BASE: Record<string, string> = { opacity: '1', scale: '1' };
const loopBase = (k: string) => LOOP_BASE[k] ?? '0';

// Label + control row. Hoisted to module scope so it keeps a STABLE component
// identity across renders — defining it inside a popup remounts the subtree each
// change, which kills ToolSegmentedControl's sliding highlight.
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex items-center justify-between w-full">
    <ControlLabel label={label} property="" plain />
    <div className="w-full">{children}</div>
  </div>
);

/**
 * Loop popup — matches the reference's Loop Effect 1:1 (Type, Delay, Opacity, Scale,
 * Rotate 2D/3D, Skew X/Y, Offset X/Y, Off Screen, Transition).
 * "Yoyo Yes/No" is the reference's "Type: Mirror" (repeatType 'mirror' vs 'loop'); a loop
 * always repeats Infinity. Each row writes the loop's `animate={{…}}` target (base
 * values are omitted) or its `transition`. Off Screen Play/Pause is stored on the
 * transition (`__offscreen`); compose gates the loop's run-loop with `useInView`.
 */
export function LoopPopup({ nodeId, props, transition, offscreen: offscreenIn, scope: loopScope }: {
  nodeId: string;
  props: Record<string, string>;
  transition: Record<string, string>;
  offscreen?: string;
  scope?: SerScope[];
}) {
  const { pushPanel } = useToolPopup();

  // The Loop is one effect with its OWN carrier — every control patches the full
  // { props, transition, offscreen } spec and writes a single `updateLoop`. The
  // per-viewport `scope` is PRESERVED across value edits (presence is set on add /
  // changed via delete-here / reset, not by editing the keyframes).
  const writeLoop = useCallback((patch: { props?: Record<string, string>; transition?: Record<string, string>; offscreen?: string }) => {
    queueMutation({ type: 'updateLoop', nodeId, spec: {
      props: patch.props ?? props,
      transition: { ...(patch.transition ?? transition), repeat: 'Infinity' },
      offscreen: patch.offscreen ?? offscreenIn,
      ...(loopScope?.length ? { scope: loopScope } : {}),
    } });
  }, [nodeId, props, transition, offscreenIn, loopScope]);
  const writeAnimate = useCallback((next: Record<string, string>) => writeLoop({ props: next }), [writeLoop]);
  const writeTransition = useCallback((patch: Record<string, string>) => writeLoop({ transition: { ...transition, ...patch } }), [writeLoop, transition]);

  // Set one animate target; drop it back out when it returns to its base value.
  const setProp = useCallback((key: string, value: string) => {
    const next = { ...props };
    if (value === '' || value === loopBase(key)) delete next[key]; else next[key] = value;
    writeAnimate(next);
  }, [props, writeAnimate]);
  const val = (key: string) => props[key] ?? loopBase(key);

  const repeatType = transition.repeatType === 'mirror' ? 'mirror' : 'loop';
  const offscreen = offscreenIn === 'play' ? 'play' : 'pause';

  return (
    <div className="flex flex-col gap-2">
      {/* Type — Loop (reset each cycle) vs Mirror (alternate direction = "yoyo"). */}
      <Row label="Type">
        <ToolSegmentedControl value={repeatType}
          onChange={(v) => writeTransition({ repeatType: v })}
          options={[{ value: 'loop', label: 'Loop' }, { value: 'mirror', label: 'Mirror' }]} size="sm" />
      </Row>
      <Row label="Delay">
        <ToolInput value={transition.delay || '0'} step={0.1} chevronLabel="s"
          onChange={(v) => writeTransition({ delay: v })} />
      </Row>
      <Row label="Opacity">
        <div className="flex items-center gap-2">
          <ToolInput value={val('opacity')} step={0.05} onChange={(v) => setProp('opacity', v)} />
          <ToolSlider value={parseFloat(val('opacity')) || 0} min={0} max={1} step={0.01}
            onChange={(n) => setProp('opacity', String(n))} />
        </div>
      </Row>
      <Row label="Scale">
        <div className="flex items-center gap-2">
          <ToolInput value={val('scale')} step={0.05} onChange={(v) => setProp('scale', v)} />
          <ToolSlider value={parseFloat(val('scale')) || 0} min={0} max={2} step={0.01}
            onChange={(n) => setProp('scale', String(n))} />
        </div>
      </Row>
      {/* Rotate — plain 2D `rotate`, like hover/tap/appear (slider + deg input). */}
      <Row label="Rotate">
        <div className="flex items-center gap-2">
          <ToolSlider value={parseFloat(val('rotate')) || 0} min={-360} max={360} step={1}
            onChange={(n) => setProp('rotate', String(n))} />
          <ToolInput value={val('rotate')} step={1} chevronLabel="deg" onChange={(v) => setProp('rotate', v)} />
        </div>
      </Row>
      {/* Rotate 3D — independent `rotateX` / `rotateY` axis tilt. */}
      <Row label="Rotate 3D">
        <div className="flex items-center gap-2">
          <ToolInput value={val('rotateX')} step={1} chevronLabel="X" onChange={(v) => setProp('rotateX', v)} />
          <ToolInput value={val('rotateY')} step={1} chevronLabel="Y" onChange={(v) => setProp('rotateY', v)} />
        </div>
      </Row>
      <Row label="Skew">
        <div className="flex items-center gap-2">
          <ToolInput value={val('skewX')} step={1} chevronLabel="X" onChange={(v) => setProp('skewX', v)} />
          <ToolInput value={val('skewY')} step={1} chevronLabel="Y" onChange={(v) => setProp('skewY', v)} />
        </div>
      </Row>
      <Row label="Offset">
        <div className="flex items-center gap-2">
          <ToolInput value={val('x')} step={1} chevronLabel="X" onChange={(v) => setProp('x', v)} />
          <ToolInput value={val('y')} step={1} chevronLabel="Y" onChange={(v) => setProp('y', v)} />
        </div>
      </Row>
      {/* Off Screen — Pause (perf, the reference default) gates the loop with useInView. */}
      <Row label="Off Screen">
        <ToolSegmentedControl value={offscreen}
          onChange={(v) => writeLoop({ offscreen: v })}
          options={[{ value: 'play', label: 'Play' }, { value: 'pause', label: 'Pause' }]} size="sm" />
      </Row>
      <TransitionRow transition={transition}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={{ ...transition, repeat: 'Infinity' }} onWrite={(t) => {
            writeLoop({ transition: { ...t, repeat: 'Infinity', repeatType } });
          }} />
        ))} />
    </div>
  );
}
