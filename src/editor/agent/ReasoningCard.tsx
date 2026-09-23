// agent/ReasoningCard.tsx — the model's thinking, as a card in the transcript.
//
// Some models think for a long time before they act (Gemini 3.8 Flash spent
// 56 seconds on its first call, 2026-09-23) and the panel showed nothing but
// "Working…" the whole time. The thinking now streams into a card that sits
// in the transcript WHERE it happened — before the work it led to — built
// like the steps card: bounded, scrolling within itself, following the newest
// line while live and the reader has not scrolled up (useFollowingScroller).
//
// Muted on purpose: it is how the agent got there, not what it did. Only
// engines that stream their thinking produce one (OpenRouter models that
// think: Gemini, and Claude when thinking is on). The Claude CLI exposes none.

import { useFollowingScroller } from './ActivityCard';
import { renderMarkdown } from './markdown';

export function ReasoningCard({ text, live }: { text: string; live: boolean }) {
  const scroller = useFollowingScroller(`${text.length}|${live}`);
  if (!text.trim()) return null;
  return (
    <div className="agent-card cut-corners cut-border border" data-testid="agent-reasoning-card" data-live={live || undefined}>
      <div className="flex items-baseline gap-1.5 px-2 pt-1.5">
        {/* The same shimmer a live step carries — the run is alive while the
            model thinks, even though no tool has moved yet. */}
        <span className={`text-[12px] leading-relaxed ${live ? 'agent-step-live' : 'text-[var(--text-tertiary)]'}`}>
          {live ? 'Thinking' : 'Thought'}
        </span>
      </div>
      <div
        ref={scroller.ref}
        onScroll={scroller.onScroll}
        data-more-above={scroller.edges.above || undefined}
        data-more-below={scroller.edges.below || undefined}
        className="agent-steps agent-thought px-2 pb-1.5 pt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)] break-words"
      >
        {renderMarkdown(text)}
      </div>
    </div>
  );
}
