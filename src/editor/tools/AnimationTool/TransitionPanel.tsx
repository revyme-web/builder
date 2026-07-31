// TransitionPanel.tsx — Reusable Ease/Spring transition editor.
// Manages its own state so it works inside pushPanel (frozen content).
// Matches Motion's transition API exactly.

import { useState, useEffect, useRef } from 'react';
import { ToolSelect, ToolSegmentedControl, ToolInput, ToolSlider, ControlLabel } from '../../controls';
import { SliderRow } from './shared';
import CurvePreview, { EASE_BEZIERS } from './CurvePreview';

const MOTION_EASING_OPTIONS = [
  { value: 'easeOut', label: 'Ease Out' },
  { value: 'easeIn', label: 'Ease In' },
  { value: 'easeInOut', label: 'Ease In Out' },
  { value: 'linear', label: 'Linear' },
  { value: 'backOut', label: 'Back Out' },
  { value: 'backIn', label: 'Back In' },
  { value: 'circOut', label: 'Circ Out' },
  { value: 'circIn', label: 'Circ In' },
  { value: 'anticipate', label: 'Anticipate' },
  { value: 'custom', label: 'Custom' },
];

export default function TransitionPanel({ initialTransition, onWrite, restrictTo }: {
  initialTransition: Record<string, string>;
  onWrite: (t: Record<string, string>) => void;
  /** Restrict which transition types the user can pick. Used by Scroll
   *  Transform to lock to Spring only — matches the reference where scroll-linked
   *  animations have no Instant or Ease, only spring smoothing. */
  restrictTo?: Array<'instant' | 'ease' | 'spring'>;
}) {
  const [t, setT] = useState<Record<string, string>>(() => ({ ...initialTransition }));
  const isSpring = t.type === 'spring';
  const hasPhysics = !!(initialTransition.stiffness || initialTransition.damping || initialTransition.mass);
  const [springMode, setSpringMode] = useState<'time' | 'physics'>(hasPhysics ? 'physics' : 'time');

  // EXTERNAL change re-seed (undo/redo while the panel is open): the parsed
  // transition comes back through `initialTransition` — re-seed local state
  // when it actually changed. Own writes round-trip to the same cleaned
  // object; the self-write counter skips them so a live slider drag (local
  // state intentionally ahead of code) is never clobbered.
  const initSig = JSON.stringify(initialTransition);
  const selfWriteRef = useRef(0);
  const prevInitSigRef = useRef(initSig);
  useEffect(() => {
    if (initSig === prevInitSigRef.current) return;
    prevInitSigRef.current = initSig;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    setT({ ...initialTransition });
    setSpringMode((initialTransition.stiffness || initialTransition.damping || initialTransition.mass) ? 'physics' : 'time');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSig]);

  // The single expensive write: clean empties → onWrite (edits the code file +
  // triggers a backend PUT). MUST NOT run per drag tick.
  const emit = (next: Record<string, string>) => {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (v !== '' && v !== undefined) clean[k] = v;
    }
    selfWriteRef.current++;
    onWrite(clean);
  };

  const write = (next: Record<string, string>) => {
    setT(next);
    emit(next);
  };

  const update = (patch: Record<string, string>) => write({ ...t, ...patch });

  // Slider DRAG: update only the panel's local state (slider values + curve
  // preview) — NO code write, so 60fps stays smooth. The transition is a
  // framer-motion prop (not a live-patchable DOM style), so there's nothing to
  // preview on the canvas mid-drag anyway; the curve preview reads local `t`.
  // Same live/commit split as the color + slider controls ([[feedback_color_live_update]]).
  const live = (patch: Record<string, string>) => setT((prev) => ({ ...prev, ...patch }));
  // Slider RELEASE: fold the final value onto the freshest state + ONE code write.
  const commit = (patch: Record<string, string>) =>
    setT((prev) => { const next = { ...prev, ...patch }; emit(next); return next; });

  const switchToTween = () => write({ type: 'tween', duration: t.duration || '0.3', ease: t.ease || 'easeOut', delay: t.delay || '0' });
  const switchToSpring = () => {
    if (springMode === 'physics') write({ type: 'spring', stiffness: '300', damping: '25', mass: '1', delay: t.delay || '0' });
    else write({ type: 'spring', duration: t.duration || '0.5', bounce: '0.25', delay: t.delay || '0' });
  };
  const switchSpringMode = (mode: 'time' | 'physics') => {
    setSpringMode(mode);
    if (mode === 'physics') write({ type: 'spring', stiffness: t.stiffness || '300', damping: t.damping || '25', mass: t.mass || '1', delay: t.delay || '0' });
    else write({ type: 'spring', duration: t.duration || '0.5', bounce: t.bounce || '0.25', delay: t.delay || '0' });
  };

  // Build the type-picker options. When `restrictTo` is set we trim the
  // segmented control to just those types — caller hides the picker
  // entirely if there's only one allowed type (no point showing a
  // single-option segmented control).
  const typeOptions = [
    { value: 'instant', label: 'Instant' },
    { value: 'ease',    label: 'Ease' },
    { value: 'spring',  label: 'Spring' },
  ].filter(o => !restrictTo || restrictTo.includes(o.value as 'instant' | 'ease' | 'spring'));

  return (
    <div className="flex flex-col gap-3">
      {typeOptions.length > 1 && (
        <ToolSegmentedControl value={t.type === 'instant' ? 'instant' : isSpring ? 'spring' : 'ease'}
          onChange={(v) => {
            if (v === 'instant') write({ type: 'instant' });
            else if (v === 'spring') switchToSpring();
            else switchToTween();
          }}
          options={typeOptions} size="sm" />
      )}

      {t.type !== 'instant' && (
        <>
          <CurvePreview isSpring={isSpring} ease={t.ease || 'easeOut'}
            bounce={parseFloat(t.bounce || '0.25')} stiffness={parseFloat(t.stiffness || '300')}
            damping={parseFloat(t.damping || '25')} mass={parseFloat(t.mass || '1')}
            springMode={springMode}
            onEaseChange={(bezier) => update({ ease: `[${bezier.join(', ')}]` })} />

          {isSpring ? (
            <>
              <div className="flex items-center justify-between w-full">
                <ControlLabel label="Based On" property="" plain />
                <div className="w-full">
                  <ToolSegmentedControl value={springMode}
                    onChange={(v) => switchSpringMode(v as 'time' | 'physics')}
                    options={[{ value: 'time', label: 'Time' }, { value: 'physics', label: 'Physics' }]} size="sm" />
                </div>
              </div>
              {springMode === 'time' ? (
                <>
                  <SliderRow label="Duration" value={parseFloat(t.duration || '0.5')} min={0} max={5} step={0.05} onChange={(v) => live({ duration: String(v) })} onCommit={(v) => commit({ duration: String(v) })} suffix="s" />
                  <SliderRow label="Bounce" value={parseFloat(t.bounce || '0.25')} min={0} max={1} step={0.05} onChange={(v) => live({ bounce: String(v) })} onCommit={(v) => commit({ bounce: String(v) })} />
                </>
              ) : (
                <>
                  <SliderRow label="Stiffness" value={parseFloat(t.stiffness || '300')} min={0} max={1000} step={10} onChange={(v) => live({ stiffness: String(v) })} onCommit={(v) => commit({ stiffness: String(v) })} />
                  <SliderRow label="Damping" value={parseFloat(t.damping || '25')} min={0} max={100} step={1} onChange={(v) => live({ damping: String(v) })} onCommit={(v) => commit({ damping: String(v) })} />
                  <SliderRow label="Mass" value={parseFloat(t.mass || '1')} min={0.1} max={10} step={0.1} onChange={(v) => live({ mass: String(v) })} onCommit={(v) => commit({ mass: String(v) })} />
                </>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between w-full">
                <ControlLabel label="Ease" property="" plain />
                <div className="w-full">
                  <ToolSelect value={EASE_BEZIERS[t.ease || ''] ? (t.ease || 'easeOut') : 'custom'}
                    onChange={(v) => { if (v !== 'custom') update({ ease: v }); }}
                    options={MOTION_EASING_OPTIONS} />
                </div>
              </div>
              {!EASE_BEZIERS[t.ease || ''] && t.ease && t.ease !== 'easeOut' && (
                <div className="flex items-center justify-between w-full">
                  <ControlLabel label="Bezier" property="" plain />
                  <div className="w-full">
                    <span className="text-[10px] text-[var(--text-disabled)]">{t.ease.replace(/[[\]]/g, '')}</span>
                  </div>
                </div>
              )}
              <SliderRow label="Duration" value={parseFloat(t.duration || '0.3')} min={0} max={5} step={0.05} onChange={(v) => live({ duration: String(v) })} onCommit={(v) => commit({ duration: String(v) })} suffix="s" />
            </>
          )}

          <div className="flex items-center justify-between w-full">
            <ControlLabel label="Delay" property="" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={parseFloat(t.delay || '0')} min={0} max={10} step={0.05} onChange={(v) => live({ delay: String(v) })} onCommit={(v) => commit({ delay: String(v) })} />
              <ToolInput value={t.delay || '0'} onChange={(v) => commit({ delay: String(parseFloat(v) || 0) })} step={0.05} chevronLabel="s" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
