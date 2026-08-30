// VibeDockShell.tsx — docked chrome for the AI chat.
//
// The chat lives here when NOT detached: a fixed panel pinned to the left
// toolbar slot (where InsertPanel / PagesPanel would sit), opened by the
// VIBE icon in LeftMenu. A "Detach" button in the header pops the same chat
// into the floating `AIChatSheet`. The detached counterpart is AIChatSheet;
// PageChat / IconSetChat pick which shell to render.

import { type ReactNode } from 'react';
import { trace } from '@/shared/debug-trace';
import VibeComingSoonGate from './ui/VibeComingSoonGate';

interface Props {
  /** Accessory rendered in the header, right of the title (credits indicator). */
  headerAccessory?: ReactNode;
  /** Name of the surface the chat is editing — shown after the title. */
  contextLabel?: string;
  /** Pop the chat out into the floating sheet. */
  onDetach: () => void;
  /** Panel body — messages list, input row, etc. */
  children: ReactNode;
}

/** Pop-out glyph for the Detach button. */
function DetachIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16">
      <path d="M0 0h16v16H0z" fill="none" />
      <path fill="currentColor" d="M9 1H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h-1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6z" />
      <rect width="6" height="5" x="10" fill="currentColor" rx=".5" />
    </svg>
  );
}

export default function VibeDockShell({ headerAccessory, contextLabel, onDetach, children }: Props) {
  trace.fn('VibeDockShell.render', { contextLabel });

  // Page routes arrive slash-prefixed ("/", "/about") — drop the slash so the
  // header reads cleaner; "/" alone becomes "Home". Mirrors AIChatSheet.
  const surfaceLabel = contextLabel
    ? contextLabel.replace(/^\//, '') || 'Home'
    : undefined;

  return (
    <div
      // `data-editor-panel` lets ToolbarDragStrategy recognize "cursor over a
      // left panel, not the canvas" — same marker LeftPanel carries.
      data-editor-panel="left-primary"
      className="fixed z-[5000] flex flex-col overflow-hidden bg-[var(--bg-surface)] border-r border-[var(--border-light)]"
      style={{ left: 52, top: 52, width: 256, height: 'calc(100vh - 52px)' }}
    >
      {/* Header */}
      <div className="relative shrink-0 flex items-center justify-between px-3 h-9 select-none border-b border-[var(--border-light)]">
        <div className="flex items-center gap-1.5 leading-none min-w-0">
          <span className="text-xs font-semibold text-[var(--text-primary)] shrink-0">Vibe</span>
          {surfaceLabel && (
            <span
              className="text-[11px] text-[var(--text-secondary)] truncate"
              title={surfaceLabel}
            >
              – {surfaceLabel}
            </span>
          )}
          {headerAccessory && <span className="shrink-0">{headerAccessory}</span>}
        </div>
        <button
          onClick={() => { trace.action('vibe-dock:detach'); onDetach(); }}
          title="Detach into a floating window"
          className="w-6 h-6 flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
          style={{ border: 'none' }}
        >
          <DetachIcon />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>

      {/* Whole-panel gate (header + credits included) while the in-house
          agent is offline. The dock closes via LeftMenu's VIBE icon, so no
          close affordance is lost under the blur. */}
      <VibeComingSoonGate />
    </div>
  );
}
