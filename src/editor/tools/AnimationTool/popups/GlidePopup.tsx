// AnimationTool/popups/GlidePopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useToolPopup } from '../../../ui/ToolPopup';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { TransitionRow } from './TransitionRow';

// Glide ("Flow"): a container effect whose only control is a Transition — it
// drives the spring/ease of the children's shared layout glide. Reuses the same
// TransitionRow + TransitionPanel as every other effect.
export function GlidePopup({ nodeId, spec }: { nodeId: string; spec: { transition?: Record<string, string> } }) {
  const { pushPanel } = useToolPopup();
  const transition = spec.transition || {};
  return (
    <div className="flex flex-col gap-2">
      <TransitionRow transition={transition}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={transition} onWrite={(t) => {
            queueMutation({ type: 'updateGlide', nodeId, spec: { ...spec, transition: t } });
          }} />
        ))} />
      <p className="text-[11px] text-[var(--text-disabled)] px-0.5 leading-snug">
        Children animate smoothly into place when one of them resizes.
      </p>
    </div>
  );
}
