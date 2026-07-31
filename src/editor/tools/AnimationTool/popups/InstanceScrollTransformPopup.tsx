// AnimationTool/popups/InstanceScrollTransformPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { ControlLabel, ControlActionRow, ToolSelect, ToolSegmentedControl } from '../../../controls';
import { AnimationIcon } from '@/design-system/PropertyIcons';
import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import { ViewportIcon } from '../motion/ScrollEditor';
import { getAnchorsForPage } from '../../LinkTool/LinkUrlControl';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getActiveAnimationScope } from '../animation-scope-source';
import type { SerScope } from '@/code/generation/generator-motion';
import { resolveTransformValue, setTransformValueScoped, type InstanceFxSpec } from '@/code/generation/instance-fx-gen';
import { fxToStr, strToFx } from './fx-utils';

/** Scroll Transform (scrubbed From→To) editor for a component instance — writes
 *  `transform` into the instance-fx spec. From/To are page-scroll-progress endpoints. */
export function InstanceScrollTransformPopup({ nodeId, spec, write }: {
  nodeId: string;
  spec: InstanceFxSpec;
  write: (mutate: (s: InstanceFxSpec) => InstanceFxSpec) => void;
}) {
  const { pushPanel } = useToolPopup();
  const tf = spec.transform || { from: { opacity: 0.5, scale: 0.5 }, to: { opacity: 1, scale: 1 } };
  const trigger = tf.trigger || 'onScroll';
  // Structural fields (trigger/viewport/section) are NEVER per-viewport — they edit
  // the base. Only the from/to VALUES get scoped to the active tile.
  const set = (patch: Partial<NonNullable<InstanceFxSpec['transform']>>) =>
    write((s) => ({ ...s, transform: { ...tf, ...patch } }));
  // The tile/variant being worked on (null = Desktop/base → edits the base value;
  // a replica → upserts a per-viewport override, keeping the base + siblings). The
  // override INDICATOR + Reset live on the "Scroll" group label in the Effects list
  // (group-level, standard) — NOT on these From/To rows.
  const activeScope = getActiveAnimationScope() as SerScope | null;
  // Section anchors = page elements with an `id` (same source as Scroll Variant).
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const anchors = useMemo(() => (activeFilePath ? getAnchorsForPage(activeFilePath) : []), [activeFilePath]);
  const editor = (which: 'from' | 'to') => (
    // Seed with the active tile's resolved value (base ⊕ this scope's override) so
    // editing on Tablet shows Tablet's numbers, on Desktop the base.
    <MotionPropsEditor nodeId={nodeId} preview deferCommit props={fxToStr(resolveTransformValue(tf, which, activeScope))}
      onChange={(p) => write((s) => setTransformValueScoped(s, which, strToFx(p), activeScope))} />
  );
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <div className="w-full">{children}</div>
    </div>
  );
  const effectRow = (which: 'from' | 'to', label: string) => (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <ControlActionRow onClick={() => pushPanel(label, editor(which))}>
        <AnimationIcon width={20} height={20} className="shrink-0" />
        <span className="text-[var(--text-secondary)]">Effect</span>
      </ControlActionRow>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <Row label="Trigger">
        <ToolSelect value={trigger} onChange={(v) => set({ trigger: v as any })}
          options={[{ value: 'onScroll', label: 'On Scroll' }, { value: 'layerInView', label: 'Layer in View' }, { value: 'sectionInView', label: 'Section in View' }]} />
      </Row>
      {trigger === 'sectionInView' && (<>
        <Row label="Viewport">
          <ToolSegmentedControl value={tf.viewport || 'middle'} size="sm"
            onChange={(v) => set({ viewport: v as 'top' | 'middle' | 'bottom' })}
            options={[
              { value: 'top', icon: <ViewportIcon position="top" /> },
              { value: 'middle', icon: <ViewportIcon position="middle" /> },
              { value: 'bottom', icon: <ViewportIcon position="bottom" /> },
            ]} />
        </Row>
        <Row label="Section">
          <ToolSelect value={tf.sectionId || ''} onChange={(id) => set({ sectionId: id })}
            options={[{ value: '', label: anchors.length ? 'Select…' : 'No anchors on page' },
              ...anchors.map((id) => ({ value: id, label: `#${id}` }))]} />
        </Row>
      </>)}
      {effectRow('from', 'From')}
      {effectRow('to', 'To')}
    </div>
  );
}
