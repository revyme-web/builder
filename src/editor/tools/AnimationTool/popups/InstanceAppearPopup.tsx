// AnimationTool/popups/InstanceAppearPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ToolSelect, ToolSegmentedControl, ControlActionRow } from '../../../controls';
import { AnimationIcon } from '@/design-system/PropertyIcons';
import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { TransitionRow } from './TransitionRow';
import { getActiveAnimationScope } from '../animation-scope-source';
import type { SerScope } from '@/code/generation/generator-motion';
import { resolveFxValue, setFxValueScoped, type InstanceFxSpec } from '@/code/generation/instance-fx-gen';
import { fxToStr, strToFx, fxTransitionToStr, strToFxTransition } from './fx-utils';

/** Appear editor for a component instance — SAME structure as the element
 *  AppearPopup (live find 2026-07-14: the instance variant inlined the raw
 *  property editor and had NO Transition row even though the spec + codegen
 *  fully support `appear.transition`): Trigger dropdown (On Appear / On
 *  Scroll / Layer in View), an Enter sub-panel for the From state, and a
 *  Transition sub-panel writing the spec's transition. */
export function InstanceAppearPopup({ nodeId, spec, write }: {
  nodeId: string;
  spec: InstanceFxSpec;
  write: (mutate: (s: InstanceFxSpec) => InstanceFxSpec) => void;
}) {
  const { pushPanel } = useToolPopup();
  const ap = spec.appear || { from: { opacity: 0, y: 30 } };
  const trigger = ap.trigger || 'onAppear';
  const activeScope = getActiveAnimationScope() as SerScope | null;
  // Structural fields (trigger/direction/start/replay) are NEVER per-viewport — they
  // edit the base. Only the FROM values get scoped to the active tile (value-responsive).
  const set = (patch: Partial<NonNullable<InstanceFxSpec['appear']>>) =>
    write((s) => ({ ...s, appear: { ...(s.appear || ap), ...patch } }));
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <div className="w-full">{children}</div>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <Row label="Trigger">
        <ToolSelect value={trigger} onChange={(v) => set({ trigger: v as any })}
          options={[{ value: 'onAppear', label: 'On Appear' }, { value: 'onScroll', label: 'On Scroll' }, { value: 'layerInView', label: 'Layer in View' }]} />
      </Row>
      {trigger === 'onScroll' && (
        <Row label="Direction">
          <ToolSegmentedControl value={ap.direction || 'down'} size="sm"
            onChange={(v) => set({ direction: v as 'down' | 'up' })}
            options={[{ value: 'down', label: 'Down' }, { value: 'up', label: 'Up' }]} />
        </Row>
      )}
      {trigger === 'layerInView' && (
        <Row label="Start">
          <ToolSegmentedControl value={ap.start || 'center'} size="sm"
            onChange={(v) => set({ start: v as 'top' | 'center' | 'bottom' })}
            options={[{ value: 'top', label: 'Top' }, { value: 'center', label: 'Center' }, { value: 'bottom', label: 'Bottom' }]} />
        </Row>
      )}
      {trigger !== 'onAppear' && (
        <Row label="Replay">
          <ToolSegmentedControl value={ap.replay === false ? 'no' : 'yes'} size="sm"
            onChange={(v) => set({ replay: v === 'yes' })}
            options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} />
        </Row>
      )}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Enter" property="" plain />
        <ControlActionRow onClick={() => pushPanel('Enter', (
          <MotionPropsEditor nodeId={nodeId} preview props={fxToStr(resolveFxValue(spec, 'appear', activeScope))}
            onChange={(p) => write((s) => setFxValueScoped(s, 'appear', strToFx(p), activeScope))} />
        ))}>
          <AnimationIcon width={20} height={20} className="shrink-0" />
          <span className="text-[var(--text-secondary)]">Effect</span>
        </ControlActionRow>
      </div>

      <TransitionRow transition={fxTransitionToStr(ap.transition)}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={fxTransitionToStr(ap.transition)}
            onWrite={(t) => set({ transition: strToFxTransition(t) })} />
        ))} />
    </div>
  );
}
