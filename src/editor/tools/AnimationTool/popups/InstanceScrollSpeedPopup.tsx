// AnimationTool/popups/InstanceScrollSpeedPopup.tsx — lifted verbatim from AnimationTool/index.tsx
// (Phase 7 god-file split, item 7.6).

import { useState, useEffect, useRef } from 'react';
import { ControlLabel, ToolInput, ToolPlusMinus } from '../../../controls';
import { getActiveAnimationScope } from '../animation-scope-source';
import type { SerScope } from '@/code/generation/generator-motion';
import { resolveSpeedValue, setSpeedScoped, type InstanceFxSpec } from '@/code/generation/instance-fx-gen';

/** Scroll Speed (parallax) editor for a component instance — writes `speed` into the
 *  instance-fx spec so it composes with the rest. */
export function InstanceScrollSpeedPopup({ spec, write }: {
  spec: InstanceFxSpec;
  write: (mutate: (s: InstanceFxSpec) => InstanceFxSpec) => void;
}) {
  // VALUE-responsive: editing on a replica writes that tile's speed override (base ⊕ scope).
  const activeScope = getActiveAnimationScope() as SerScope | null;
  const [val, setVal] = useState(resolveSpeedValue(spec, activeScope));
  // External re-seed (undo/redo while open): the parsed spec comes back via
  // the prop; own writes round-trip to the value already in `val`.
  const resolved = resolveSpeedValue(spec, activeScope);
  const prevResolvedRef = useRef(resolved);
  useEffect(() => {
    if (resolved === prevResolvedRef.current) return;
    prevResolvedRef.current = resolved;
    setVal(resolved);
  }, [resolved]);
  const set = (n: number) => { setVal(n); write((s) => setSpeedScoped(s, n, activeScope)); };
  return (
    <div className="flex items-center justify-between w-full gap-2">
      <ControlLabel label="Speed" property="" plain />
      <div className="flex items-center gap-2 w-full">
        <ToolInput value={`${val}%`} step={10} onChange={(v) => set(parseFloat(v) || 0)} />
        <div className="w-[72px] shrink-0">
          <ToolPlusMinus value={val} step={10} min={0} max={1000} onChange={set} />
        </div>
      </div>
    </div>
  );
}
