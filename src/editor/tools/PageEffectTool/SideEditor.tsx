// SideEditor.tsx — one side (This Page = exit / Next Page = enter) of a Page
// Effect: Opacity, Scale, Rotate (2D/3D), Offset X/Y, Mask, Transition. Reuses
// the AnimationTool SliderRow + the TransitionPanel overlay (user requirement).

import { ToolRow, ToolInput, ToolSelect, ToolSegmentedControl } from '../../controls';
import { SliderRow, PanelRow } from '../AnimationTool/shared';
import { useToolPopup } from '../../ui/ToolPopup';
import TransitionPanel from '../AnimationTool/TransitionPanel';
import MaskEditor from './MaskEditor';
import { transitionConfigToRecord, recordToTransitionConfig, pageEffectTransitionSummary } from './transition-adapter';
import type { SideConfig, OffsetUnit, MaskConfig, RotateMode } from '@/code/project/page-effects-config';

const OFFSET_UNIT_OPTIONS: { value: OffsetUnit; label: string }[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'relative', label: 'Relative' },
];

const DEFAULT_MASK: MaskConfig = { type: 'circle', originX: 50, originXUnit: 'rel', originY: 50, originYUnit: 'rel' };

export default function SideEditor({ side, onChange }: {
  side: SideConfig;
  onChange: (s: SideConfig) => void;
}) {
  const { pushPanel } = useToolPopup();
  const set = (patch: Partial<SideConfig>) => onChange({ ...side, ...patch });

  const openTransition = () => pushPanel('Transition', () => (
    <TransitionPanel
      initialTransition={transitionConfigToRecord(side.transition)}
      onWrite={(r) => onChange({ ...side, transition: recordToTransitionConfig(r) })}
      restrictTo={['ease', 'spring']}
    />
  ));
  const openMask = () => pushPanel('Mask', () => (
    <MaskEditor
      mask={side.mask ?? DEFAULT_MASK}
      onChange={(m) => onChange({ ...side, mask: m })}
      onRemove={() => { onChange({ ...side, mask: undefined }); }}
    />
  ));

  return (
    <div className="flex flex-col gap-2 p-1">
      <SliderRow label="Opacity" value={side.opacity} min={0} max={1} step={0.01} onChange={(v) => set({ opacity: v })} />
      <SliderRow label="Scale" value={side.scale} min={0} max={4} step={0.1} onChange={(v) => set({ scale: v })} />

      <ToolRow label="Rotate">
        <div className="flex items-center gap-1 w-full">
          <ToolInput value={String(side.rotateZ)} onChange={(v) => set({ rotateZ: parseFloat(v) || 0 })} />
          <ToolSegmentedControl value={side.rotate} onChange={(v) => set({ rotate: v as RotateMode })}
            options={[{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }]} size="sm" />
        </div>
      </ToolRow>
      {side.rotate === '3d' && (
        <ToolRow label="">
          <div className="flex items-center gap-1 w-full">
            <ToolInput value={String(side.rotateX)} onChange={(v) => set({ rotateX: parseFloat(v) || 0 })} placeholder="X" />
            <ToolInput value={String(side.rotateY)} onChange={(v) => set({ rotateY: parseFloat(v) || 0 })} placeholder="Y" />
            <ToolInput value={String(side.rotateZ)} onChange={(v) => set({ rotateZ: parseFloat(v) || 0 })} placeholder="Z" />
          </div>
        </ToolRow>
      )}

      <ToolRow label="Offset X">
        <div className="flex items-center gap-1 w-full">
          <ToolInput value={String(side.offsetX)} onChange={(v) => set({ offsetX: parseFloat(v) || 0 })} />
          <ToolSelect value={side.offsetXUnit} onChange={(v) => set({ offsetXUnit: v as OffsetUnit })} options={OFFSET_UNIT_OPTIONS} />
        </div>
      </ToolRow>
      <ToolRow label="Offset Y">
        <div className="flex items-center gap-1 w-full">
          <ToolInput value={String(side.offsetY)} onChange={(v) => set({ offsetY: parseFloat(v) || 0 })} />
          <ToolSelect value={side.offsetYUnit} onChange={(v) => set({ offsetYUnit: v as OffsetUnit })} options={OFFSET_UNIT_OPTIONS} />
        </div>
      </ToolRow>

      <PanelRow label="Mask" summary={side.mask ? side.mask.type : 'Add…'} onClick={openMask} />
      <PanelRow label="Transition" summary={pageEffectTransitionSummary(side.transition)} onClick={openTransition} />
    </div>
  );
}
