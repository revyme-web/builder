// AnimationTool/popups/ScrollSpeedPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useState, useEffect, useRef } from 'react';
import { ControlLabel, ToolInput, ToolPlusMinus } from '../../../controls';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getActiveAnimationScope } from '../animation-scope-source';

// Scroll Speed (the reference parallax). 100% = normal; <100 lags (further), >100 leads.
export function ScrollSpeedPopup({ nodeId, speed }: { nodeId: string; speed: number }) {
  const [val, setVal] = useState(speed);
  // External re-seed (undo/redo while open): the parsed speed comes back via
  // the prop; own writes round-trip to the value already in `val`, so
  // syncing on prop-change is a no-op for them and correct for undo.
  const prevSpeedRef = useRef(speed);
  useEffect(() => {
    if (speed === prevSpeedRef.current) return;
    prevSpeedRef.current = speed;
    setVal(speed);
  }, [speed]);
  const write = (n: number) => {
    setVal(n);
    // Scope the write to the active viewport/variant (null = base) — a per-viewport
    // Speed override, same responsive model as hover/tap.
    queueMutation({ type: 'updateScrollSpeed', config: { nodeId, speed: n, scope: getActiveAnimationScope() as any } });
  };
  return (
    <div className="flex items-center justify-between w-full gap-2">
      <ControlLabel label="Speed" property="" plain />
      <div className="flex items-center gap-2 w-full">
        <ToolInput value={`${val}%`} step={10} onChange={(v) => write(parseFloat(v) || 0)} />
        <div className="w-[72px] shrink-0">
          <ToolPlusMinus value={val} step={10} min={0} max={1000} onChange={write} />
        </div>
      </div>
    </div>
  );
}
