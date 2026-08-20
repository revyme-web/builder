// SkewControl.tsx — Skew ToolAtom with uniform/individual toggle.
// Layout matches SpacingControl: top row = global input + toggle, bottom row = X/Y when individual.
// Uniform: writes `skew`. Individual: writes `skewX` + `skewY`.

import { useState, useEffect, useRef } from 'react';
import { ToolInput, ControlLabel } from '../../../controls';
import { UnifiedControlProvider, useControlContext, UsedByRow } from '../../../controls/unified';
import type { AtomProps } from '../../../controls/unified/types';

function UniformIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="2 2 20 20" className={className}>
      <rect width="16.5" height="16.5" x="3.75" y="3.75" fill="none" stroke="currentColor"
        strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" rx="4" />
    </svg>
  );
}

function IndividualIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" className={className}>
      <path fill="currentColor"
        d="M93.66 202.34A8 8 0 0 1 88 216H48a8 8 0 0 1-8-8v-40a8 8 0 0 1 13.66-5.66ZM88 40H48a8 8 0 0 0-8 8v40a8 8 0 0 0 13.66 5.66l40-40A8 8 0 0 0 88 40m123.06 120.61a8 8 0 0 0-8.72 1.73l-40 40A8 8 0 0 0 168 216h40a8 8 0 0 0 8-8v-40a8 8 0 0 0-4.94-7.39M208 40h-40a8 8 0 0 0-5.66 13.66l40 40A8 8 0 0 0 216 88V48a8 8 0 0 0-8-8" />
    </svg>
  );
}

function SkewAtom() {
  const { allProps, onChangeMultiple, mode, binding } = useControlContext();

  if (mode === 'direct' && binding.bound) {
    return <UsedByRow binding={binding} />;
  }

  // Keyframe stops author skewX/skewY individually — no combined skew.
  const isKeyframe = mode === 'cssKeyframe';
  const hasIndividual = isKeyframe || !!(allProps.skewX || allProps.skewY);
  const [showIndividual, setShowIndividual] = useState(hasIndividual);
  const userToggledRef = useRef(false);

  // Sync from props when they change externally
  useEffect(() => {
    if (!userToggledRef.current) {
      setShowIndividual(!!(allProps.skewX || allProps.skewY));
    }
  }, [allProps.skewX, allProps.skewY, allProps.skew]);

  const uniformVal = allProps.skew || '0';
  const xVal = allProps.skewX || allProps.skew || '0';
  const yVal = allProps.skewY || allProps.skew || '0';

  return (
    <div className="w-full">
      {/* Keyframe mode: always individual (skewX/skewY only, no combined skew) */}
      {isKeyframe ? (
        <div className="flex items-center gap-1 w-full">
          <ToolInput value={xVal} onChange={(v) => onChangeMultiple({ skewX: v, skew: '' })} step={1} chevronLabel="X" />
          <ToolInput value={yVal} onChange={(v) => onChangeMultiple({ skewY: v, skew: '' })} step={1} chevronLabel="Y" />
        </div>
      ) : (
        <>
          {/* Row 1: Global input + toggle */}
          <div className="flex items-center w-full gap-2">
            <ToolInput
              value={uniformVal}
              onChange={(v) => onChangeMultiple({ skew: v, skewX: '', skewY: '' })}
              step={1}
            />
            <div className="flex items-center border border-[var(--control-border)] cut-corners cut-border [--cut-border-color:var(--control-border)] overflow-hidden shrink-0">
              <button tabIndex={-1}
                onClick={() => {
                  if (showIndividual) {
                    setShowIndividual(false);
                    userToggledRef.current = true;
                    onChangeMultiple({ skew: xVal, skewX: '', skewY: '' });
                  }
                }}
                className={`flex items-center justify-center h-7 w-7 transition-colors cursor-pointer ${
                  !showIndividual
                    ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]'
                    : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title="Uniform">
                <UniformIcon className="w-3 h-3" />
              </button>
              <button tabIndex={-1}
                onClick={() => {
                  setShowIndividual(true);
                  userToggledRef.current = true;
                  onChangeMultiple({ skewX: uniformVal, skewY: uniformVal, skew: '' });
                }}
                className={`flex items-center justify-center h-7 w-7 transition-colors cursor-pointer ${
                  showIndividual
                    ? 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)]'
                    : 'bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
                title="Individual X/Y">
                <IndividualIcon className="w-3 h-3" />
              </button>
            </div>
          </div>

          {/* Row 2: X/Y inputs when individual */}
          {showIndividual && (
            <div className="mt-2 flex items-center gap-1 w-full">
              <ToolInput value={xVal} onChange={(v) => onChangeMultiple({ skewX: v, skew: '' })} step={1} chevronLabel="X" />
              <ToolInput value={yVal} onChange={(v) => onChangeMultiple({ skewY: v, skew: '' })} step={1} chevronLabel="Y" />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function SkewControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="skew" defaultValue="0" mode={mode} {...mp}>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Skew" property="skew" plain={mode !== 'direct'} />
        <SkewAtom />
      </div>
    </UnifiedControlProvider>
  );
}
