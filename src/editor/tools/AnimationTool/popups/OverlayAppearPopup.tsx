// AnimationTool/popups/OverlayAppearPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useState } from 'react';
import { ControlLabel, ControlActionRow } from '../../../controls';
import { AnimationIcon } from '@/design-system/PropertyIcons';
import { useToolPopup } from '../../../ui/ToolPopup';
import MotionPropsEditor from '../motion/MotionPropsEditor';
import TransitionPanel from '../TransitionPanel';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';
import { appearReveal, appearUnionKeys } from '../appear-utils';
import { TransitionRow } from './TransitionRow';

// Overlay Appear = ENTER + EXIT (the reference's "Appear Effect" with both rows). The
// overlay is wrapped in <AnimatePresence>, so it animates from `initial` → its
// resting state (`animate`, derived neutral) on open, and to `exit` on close.
// A lock links Exit to Enter (default); unlinking lets you edit Exit alone.
export function OverlayAppearPopup({ nodeId, node, enterProps, exitProps, transition }: {
  nodeId: string; node: any; enterProps: Record<string, string>;
  exitProps: Record<string, string>; transition: Record<string, string>;
}) {
  const { pushPanel } = useToolPopup();
  const sameProps = (a: Record<string, string>, b: Record<string, string>) => {
    const ak = Object.keys(a), bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
  };
  // Linked by default when Exit is empty or already mirrors Enter.
  const [linked, setLinked] = useState(
    () => Object.keys(exitProps).length === 0 || sameProps(enterProps, exitProps),
  );

  const writeEnter = (newProps: Record<string, string>) => {
    // Scoped enter + derived neutral resting state (`animate`).
    queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: newProps, scope: getActiveAnimationScope() });
    queueMutation({ type: 'updateMotionProp', nodeId, propName: 'animate',
      props: appearReveal(appearUnionKeys(node?.motionProps?.initial, newProps), node?.styles) });
    if (linked) queueMutation({ type: 'updateMotionProp', nodeId, propName: 'exit', props: newProps });
  };
  const writeExit = (newProps: Record<string, string>) => {
    queueMutation({ type: 'updateMotionProp', nodeId, propName: 'exit', props: newProps });
    // Locked → Enter and Exit stay identical, so mirror the edit back to Enter
    // (+ its derived resting `animate`). The lock only changes via its button.
    if (linked) {
      queueMutation({ type: 'updateMotionProp', nodeId, propName: 'initial', props: newProps, scope: getActiveAnimationScope() });
      queueMutation({ type: 'updateMotionProp', nodeId, propName: 'animate',
        props: appearReveal(appearUnionKeys(node?.motionProps?.exit, newProps), node?.styles) });
    }
  };
  const toggleLink = () => {
    const next = !linked;
    setLinked(next);
    if (next) queueMutation({ type: 'updateMotionProp', nodeId, propName: 'exit', props: enterProps });
  };

  const stroke = linked ? 'var(--accent)' : 'var(--text-secondary)';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Enter" property="" plain />
        <ControlActionRow onClick={() => pushPanel('Enter', (
          <MotionPropsEditor nodeId={nodeId} props={enterProps} preview onChange={writeEnter} />
        ))}>
          <AnimationIcon width={20} height={20} className="shrink-0" />
          <span className="text-[var(--text-secondary)]">Effect</span>
        </ControlActionRow>
      </div>

      {/* Enter↔Exit lock — same bracket + lock affordance as SizeTool's aspect
          ratio lock (0-height row; absolutely-positioned lock + connector curves
          bridging the gap). Locked → editing Enter mirrors to Exit. */}
      <div className="relative" style={{ height: 0, marginTop: '-0.25rem', marginBottom: '-0.25rem' }}>
        <div className="absolute flex items-center justify-center" style={{ left: '35%', top: -10, transform: 'translateX(-50%)' }}>
          <svg className="absolute pointer-events-none" style={{ left: 1, top: -38, width: 10, height: 40, overflow: 'visible' }}>
            <path d="M 0,37 Q 0,31 6,29 L 11,29" fill="none" stroke={stroke} strokeWidth="1" />
          </svg>
          <button
            type="button"
            onClick={toggleLink}
            className={`p-0.5 hover:bg-[var(--bg-hover)] rounded transition-colors absolute z-10 pointer-events-auto cursor-pointer ${linked ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}
            style={{ left: -7, top: 2 }}
            title={linked ? 'Exit linked to Enter — unlink to edit separately' : 'Exit unlinked — link to mirror Enter'}
          >
            {linked ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
              </svg>
            )}
          </button>
          <svg className="absolute pointer-events-none" style={{ left: 1, top: 19, width: 10, height: 40, overflow: 'visible' }}>
            <path d="M 0,3 Q 0,8 6,11 L 11,11" fill="none" stroke={stroke} strokeWidth="1" />
          </svg>
        </div>
      </div>

      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Exit" property="" plain />
        <ControlActionRow onClick={() => pushPanel('Exit', (
          <MotionPropsEditor nodeId={nodeId} props={linked ? enterProps : exitProps} preview onChange={writeExit} />
        ))}>
          <AnimationIcon width={20} height={20} className="shrink-0" />
          <span className="text-[var(--text-secondary)]">Effect</span>
        </ControlActionRow>
      </div>

      <TransitionRow transition={transition}
        onClick={() => pushPanel('Transition', (
          <TransitionPanel initialTransition={transition} onWrite={(t) => {
            queueMutation({ type: 'updateMotionProp', nodeId, propName: 'transition', props: t });
          }} />
        ))} />
    </div>
  );
}
