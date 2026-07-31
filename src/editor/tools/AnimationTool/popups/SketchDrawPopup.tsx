// AnimationTool/popups/SketchDrawPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ToolSelect, ToolSlider, ToolInput } from '../../../controls';
import { useToolPopup } from '../../../ui/ToolPopup';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { SketchAnimConfig, SketchAnimMode, SketchAnimTrigger } from '@/code/sketch/sketch-anim-config';
import { TransitionRow } from './TransitionRow';

// ─── Sketch draw popup ────────────────────────────────────────────────────
//
// Editor for the per-wrapper draw animation. Reuses the canonical row
// shape (ControlLabel + control widget) from the rest of the panel.
// Trigger / Mode are segmented controls; durationScale + stagger are
// sliders; the full transition (spring/tween + tuning) opens the
// shared TransitionPanel so the user gets the same editing experience
// they have for every other motion animation.

export function SketchDrawPopup({ nodeId, config }: {
  nodeId: string;
  config: SketchAnimConfig;
}) {
  const { pushPanel } = useToolPopup();
  const update = (patch: Partial<SketchAnimConfig>) => {
    const next: SketchAnimConfig = { ...config, ...patch };
    queueMutation({ type: 'setSketchAnim', nodeId, config: next });
  };
  // Convert the SketchAnimTransition shape to/from the
  // TransitionPanel's `Record<string,string>` props shape so we can
  // reuse the existing editor without forking it. The panel emits
  // strings for every field; we cast back to numbers on the way in.
  const transitionAsProps: Record<string, string> = (() => {
    const t = config.transition;
    const out: Record<string, string> = { type: t.type };
    if (t.duration !== undefined) out.duration = String(t.duration);
    if (t.ease !== undefined) out.ease = t.ease;
    if (t.stiffness !== undefined) out.stiffness = String(t.stiffness);
    if (t.damping !== undefined) out.damping = String(t.damping);
    if (t.mass !== undefined) out.mass = String(t.mass);
    if (t.velocity !== undefined) out.velocity = String(t.velocity);
    return out;
  })();
  const writeTransition = (props: Record<string, string>) => {
    const transition: SketchAnimConfig['transition'] = {
      type: (props.type as 'tween' | 'spring') || 'tween',
    };
    if (props.duration) transition.duration = parseFloat(props.duration);
    if (props.ease) transition.ease = props.ease;
    if (props.stiffness) transition.stiffness = parseFloat(props.stiffness);
    if (props.damping) transition.damping = parseFloat(props.damping);
    if (props.mass) transition.mass = parseFloat(props.mass);
    if (props.velocity) transition.velocity = parseFloat(props.velocity);
    update({ transition });
  };
  return (
    <div className="flex flex-col gap-2">
      {/* Trigger */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Trigger" property="" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSelect
            value={config.trigger}
            onChange={(v) => update({ trigger: v as SketchAnimTrigger })}
            options={[
              { value: 'mount', label: 'Mount' },
              { value: 'inView', label: 'In View' },
              { value: 'hover', label: 'Hover' },
              { value: 'tap', label: 'Tap' },
            ]}
          />
        </div>
      </div>

      {/* Mode */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Mode" property="" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSelect
            value={config.mode}
            onChange={(v) => update({ mode: v as SketchAnimMode })}
            options={[
              { value: 'sequential', label: 'Sequential' },
              { value: 'staggered', label: 'Staggered' },
              { value: 'simultaneous', label: 'All at once' },
            ]}
          />
        </div>
      </div>

      {/* Stagger — only meaningful in staggered mode but always
          editable so the user can tune ahead of switching modes. */}
      <div className="flex items-center justify-between w-full" style={config.mode !== 'staggered' ? { opacity: 0.5 } : undefined}>
        <ControlLabel label="Stagger" property="" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider
            value={config.stagger}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => update({ stagger: v })}
          />
          <ToolInput value={config.stagger.toFixed(2)} onChange={(raw) => {
            const v = parseFloat(raw);
            if (Number.isFinite(v)) update({ stagger: Math.max(0, Math.min(1, v)) });
          }} step={0.05} />
        </div>
      </div>

      {/* Duration scale — multiplier on per-stroke duration which
          itself scales with point count. 1× = the duration in the
          transition. */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Speed" property="" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider
            value={config.durationScale}
            min={0.1}
            max={5}
            step={0.1}
            onChange={(v) => update({ durationScale: v })}
          />
          <ToolInput value={config.durationScale.toFixed(1)} onChange={(raw) => {
            const v = parseFloat(raw);
            if (Number.isFinite(v) && v > 0) update({ durationScale: v });
          }} step={0.1} />
        </div>
      </div>

      <TransitionRow transition={transitionAsProps}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={transitionAsProps} onWrite={writeTransition} />
        ))} />
    </div>
  );
}
