// AnimationTool/popups/TransitionRow.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { ControlLabel, ControlActionRow } from '../../../controls';
import { summarizeTransition, TransitionCurveIcon } from '../CurvePreview';

// ─── Transition Button Row ──────────────────────────────────────────────────

export function TransitionRow({ transition, onClick }: { transition: Record<string, string>; onClick: () => void }) {
  const isSpring = transition.type === 'spring';
  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Transition" property="" plain />
      {/* Wrap in a w-full div so the right column resolves to the same
          width as sibling rows whose right control is rendered directly
          (e.g. Preserve3D's ToolSegmentedControl). Without this wrapper
          the flex algorithm gives ControlActionRow slightly more width
          because its intrinsic content (icon + truncated text) differs. */}
      <div className="w-full">
        <ControlActionRow onClick={onClick}>
          <TransitionCurveIcon isSpring={isSpring} />
          <span className="truncate flex-1">{summarizeTransition(transition)}</span>
        </ControlActionRow>
      </div>
    </div>
  );
}
