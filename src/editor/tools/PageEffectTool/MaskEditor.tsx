// MaskEditor.tsx — Page Effect mask sub-panel (Type + Origin X/Y + live Preview).
// Maps to clip-path on the view-transition snapshot. See plan §6.2.

import { ToolRow, ToolSelect, ToolInput, RemoveButton } from '../../controls';
import { maskToClip } from '@/code/generation/view-transition-css';
import type { MaskConfig, MaskType, OriginUnit } from '@/code/project/page-effects-config';

const TYPE_OPTIONS: { value: MaskType; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'wipe-left', label: 'Wipe Left' },
  { value: 'wipe-right', label: 'Wipe Right' },
  { value: 'wipe-up', label: 'Wipe Up' },
  { value: 'wipe-down', label: 'Wipe Down' },
];
const UNIT_OPTIONS: { value: OriginUnit; label: string }[] = [
  { value: 'rel', label: 'Rel' },
  { value: 'abs', label: 'Abs' },
];

export default function MaskEditor({ mask, onChange, onRemove }: {
  mask: MaskConfig;
  onChange: (m: MaskConfig) => void;
  onRemove: () => void;
}) {
  const isCircle = mask.type === 'circle';
  // Preview the 'full' (revealed) clip-path so the box shows the shape.
  const clip = maskToClip(mask, 'full');
  return (
    <div className="flex flex-col gap-2 p-1">
      <ToolRow label="Type">
        <div className="flex items-center gap-1 w-full">
          <ToolSelect value={mask.type} onChange={(v) => onChange({ ...mask, type: v as MaskType })} options={TYPE_OPTIONS} />
          <RemoveButton onClick={onRemove} />
        </div>
      </ToolRow>
      {isCircle && (
        <>
          <ToolRow label="Origin X">
            <div className="flex items-center gap-1 w-full">
              <ToolInput value={String(mask.originX)} onChange={(v) => onChange({ ...mask, originX: parseFloat(v) || 0 })} />
              <ToolSelect value={mask.originXUnit} onChange={(v) => onChange({ ...mask, originXUnit: v as OriginUnit })} options={UNIT_OPTIONS} />
            </div>
          </ToolRow>
          <ToolRow label="Origin Y">
            <div className="flex items-center gap-1 w-full">
              <ToolInput value={String(mask.originY)} onChange={(v) => onChange({ ...mask, originY: parseFloat(v) || 0 })} />
              <ToolSelect value={mask.originYUnit} onChange={(v) => onChange({ ...mask, originYUnit: v as OriginUnit })} options={UNIT_OPTIONS} />
            </div>
          </ToolRow>
        </>
      )}
      <ToolRow label="Preview">
        <div className="w-full h-24 rounded-[var(--radius-md)] overflow-hidden bg-[var(--grid-line)] flex items-center justify-center">
          <div style={{ width: '100%', height: '100%', backgroundColor: 'var(--accent)', clipPath: clip, WebkitClipPath: clip }} />
        </div>
      </ToolRow>
    </div>
  );
}
