// CmsAiPanel.tsx — the agent, docked beside the CMS editor.
//
// Chrome only: the header (mirrors VibeDockShell) and the shared `AgentChat`
// body. This used to be a whole second assistant — its own agentic loop
// (runCmsAgent), its own Gemini tool schemas, its own transcript and composer.
// It could build a collection and nothing else, the page agent could bind a
// list and not create the collection it needed, and neither could see what the
// other had done.
//
// There is one agent now. It knows the CMS is open and on which collection
// (src/ai/agent/surface.ts), so a request typed here is about this collection
// by default — and "now build the blog page for it" is the same conversation.

import { useAtomValue } from 'jotai';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import CreditsIndicator from '@/editor/CreditsIndicator';
import AgentChat from '@/editor/agent/AgentChat';

// ─── Icons ───────────────────────────────────────────────────────────────────

/** Sparkle glyph for the toolbar's AI toggle. */
export function SparkleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.4l1.85 6.3 6.3 1.85-6.3 1.85L12 18.7l-1.85-6.3L3.85 10.55l6.3-1.85L12 2.4z" />
      <path d="M18.5 3l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3L15.5 6l2.3-.7.7-2.3z" opacity=".6" />
    </svg>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export default function CmsAiPanel({ collectionName, onClose }: {
  collectionName?: string;
  onClose: () => void;
}) {
  // Re-render the header when the open collection changes; the chat reads the
  // surface itself at send time.
  useAtomValue(cmsEditorCollectionAtom);

  return (
    <div className="relative w-[260px] shrink-0 border-l border-[var(--border-light)] bg-[var(--bg-surface)] flex flex-col">
      {/* Header — mirrors VibeDockShell. */}
      <div className="relative shrink-0 flex items-center justify-between px-3 h-9 select-none border-b border-[var(--border-light)]">
        <div className="flex items-center gap-1.5 leading-none min-w-0">
          <span className="text-xs font-semibold text-[var(--text-primary)] shrink-0">Vibe</span>
          {collectionName && (
            <span className="text-[11px] text-[var(--text-secondary)] truncate" title={collectionName}>
              – {collectionName}
            </span>
          )}
          <span className="shrink-0"><CreditsIndicator /></span>
        </div>
        <button
          onClick={onClose}
          title="Hide AI panel"
          className="w-6 h-6 flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
          style={{ border: 'none' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <AgentChat />
      </div>
    </div>
  );
}
