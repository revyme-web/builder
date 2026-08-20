// UsedByRow.tsx — Compact button showing the binding source. Clicking navigates to it.

import { useRef } from 'react';
import type { ControlBinding } from './types';
import { trace } from '@/shared/debug-trace';

/** Global anchor override — when UsedByRow triggers navigation, the popup should anchor HERE */
let pendingAnchorOverride: HTMLElement | null = null;
export function consumeAnchorOverride(): HTMLElement | null {
  const el = pendingAnchorOverride;
  pendingAnchorOverride = null;
  return el;
}

export function UsedByRow({ binding }: { binding: ControlBinding }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={btnRef}
      onClick={() => {
        if (binding.onNavigate) {
          trace.action('used-by:navigate', { boundBy: binding.boundBy });
          // Store this button as the anchor for the popup that's about to open
          pendingAnchorOverride = btnRef.current;
          binding.onNavigate();
        }
      }}
      className={`w-full h-8 flex items-center justify-between px-2 bg-[var(--grid-line)] border border-[var(--control-border)] cut-border ${binding.onNavigate ? 'hover:border-[var(--accent)] hover:[--cut-border-color:var(--accent)] cursor-pointer' : 'cursor-default'} cut-corners transition-colors text-xs`}
    >
      <span className="text-[var(--text-primary)] truncate">{binding.boundBy}</span>
      {binding.onNavigate && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" className="text-[var(--text-secondary)] shrink-0">
          <path d="M4 3.5a.5.5 0 0 0-.5.5v4a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-.25a.75.75 0 0 1 1.5 0V8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h.25a.75.75 0 0 1 0 1.5zm2.75 0a.75.75 0 0 1 0-1.5h2.5a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-.69L7.28 5.78a.75.75 0 0 1-1.06-1.06L7.44 3.5z" />
        </svg>
      )}
    </button>
  );
}
