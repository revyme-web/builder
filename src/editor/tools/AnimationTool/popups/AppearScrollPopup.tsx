// AnimationTool/popups/AppearScrollPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ToolSelect } from '../../../controls';
import { ScrollTransformEditor } from '../motion/ScrollEditor';
import { SCROLL_TRIGGER_LABELS } from '@/code/generation/generator-motion';
import { AppearPopup } from './AppearPopup';
import { seedAppear, seedScroll } from './seeds';
import { flushNow } from '@/code/mutation/mutation-queue';

/**
 * Unified Appear / Scroll popup (the reference model). ONE Trigger dropdown with three
 * choices — On Appear / Layer in View / Section in View — swaps the underlying
 * MECHANISM:
 *   On Appear        → `initial` + `whileInView` + `viewport` (animate once)
 *   Layer/Section in → `useScroll` + `useTransform` (scrubbed)
 * In Scroll mode the scroll editor owns the dropdown (its existing Layer/Section
 * select gains an "On Appear" option). In Appear mode this component renders the
 * SAME dropdown (so there's never a second Trigger row). Title set by the caller.
 */
export function AppearScrollPopup({ nodeId, node, trigger, enterProps, transition, scrollPayload, isVariantMode, initialName, scopedDirectionWrite, onPickSectionInView }: {
  nodeId: string; node: any; trigger: 'appear' | 'scroll';
  enterProps: Record<string, string>; transition: Record<string, string>;
  scrollPayload: any; isVariantMode: boolean; initialName?: string;
  scopedDirectionWrite?: (patch: { direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }) => boolean;
  /** Section in View is SCRUBBED, so the effect re-classifies as the separate
   *  Scroll Transform entry after the write — the open popup must FOLLOW it
   *  there or it re-renders as an empty Appear ("switched to Section in View
   *  and it reverted to On Appear", 2026-08-07). Caller moves the active
   *  popup to 'scrollTransform'. */
  onPickSectionInView?: () => void;
}) {
  const pickSectionInView = () => {
    // Flush BEFORE the popup moves: the Scroll Transform editor seeds its
    // internal state from the parsed entry on mount — moving first would
    // mount it against the pre-write (chain-less) parse.
    flushNow();
    onPickSectionInView?.();
  };
  if (trigger === 'scroll') {
    // Scroll editor owns the Trigger dropdown (with the injected "On Appear").
    // mode='animation' → Section in View is single (no Add Section); the
    // scrubbed multi-section lives in the separate Scroll Transform entry.
    return <ScrollTransformEditor key={nodeId} nodeId={nodeId} scrollData={scrollPayload}
      mode="animation" onSwitchToAppear={(t) => seedAppear(nodeId, t)} scopedDirectionWrite={scopedDirectionWrite}
      onSwitchToSectionInView={onPickSectionInView ? pickSectionInView : undefined} />;
  }
  // Appear mode: render the SAME unified Trigger dropdown; picking a scroll
  // trigger switches the mechanism and seeds useScroll with it.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Trigger" property="" plain />
        <div className="w-full">
          <ToolSelect value="__appear"
            onChange={(v) => {
              if (v === '__appear') return;
              seedScroll(nodeId, v as any);
              if (v === 'sectionInView') pickSectionInView();
            }}
            options={[
              { value: '__appear', label: 'On Appear' },
              ...Object.entries(SCROLL_TRIGGER_LABELS).map(([value, label]) => ({ value, label })),
            ]} />
        </div>
      </div>
      <AppearPopup key={nodeId} nodeId={nodeId} node={node} enterProps={enterProps}
        transition={transition} isVariantMode={isVariantMode} initialName={initialName} />
    </div>
  );
}
