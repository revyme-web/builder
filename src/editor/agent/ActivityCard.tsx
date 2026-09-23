// agent/ActivityCard.tsx — a run's tool calls, as a card that scrolls within itself.
//
// `foldActivity` collapses the calls into outcome lines ("Edited 4 layers,
// added 4 design tokens"). Those lines used to sit loose in the transcript,
// and a long run — thirty steps between two sentences — pushed the prompt and
// the last reply out of view: a wall of grey the reader had to scroll past to
// find any words (owner, 2026-09-22). So consecutive steps now share ONE card
// with a bounded height. It shows the latest lines and follows them while the
// run is live; the reader scrolls inside it for the rest. A sentence from the
// agent ends the card — the next step opens a new one underneath — so the
// transcript keeps its rhythm: prompt, a card of work, a sentence, a card…
//
// A screenshot stays its own card: the image IS the content, and it should
// never be a row lost inside a scroller.

import { useEffect, useRef, useState } from 'react';
import type { AgentToolEntry } from '@/code/stores/agent-chat-store';
import { foldActivity, type ActivityStep, type ActivitySubstep } from './activity';

/** `6.7s` — only once a step is slow enough for the number to mean anything. */
export function secs(ms: number): string | null {
  if (ms < 1000) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The page-with-corner mark the reference builder uses for a capture. */
export function ViewIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/** Consecutive step rows share a card; a capture stands alone. */
type Run = { kind: 'steps'; steps: ActivityStep[] } | { kind: 'capture'; step: ActivityStep };

export function groupRuns(steps: ActivityStep[]): Run[] {
  const runs: Run[] = [];
  for (const step of steps) {
    if (step.images.length > 0) { runs.push({ kind: 'capture', step }); continue; }
    const last = runs[runs.length - 1];
    if (last && last.kind === 'steps') last.steps.push(step);
    else runs.push({ kind: 'steps', steps: [step] });
  }
  return runs;
}

export function ActivityList({ tools, live }: { tools: AgentToolEntry[]; live?: boolean }) {
  const steps = foldActivity(tools);
  if (steps.length === 0) return null;
  const runs = groupRuns(steps);
  return (
    <div className="flex flex-col gap-3">
      {runs.map((run, ri) => {
        // THE LAST ROW SHIMMERS FOR AS LONG AS THE RUN IS LIVE — not only while
        // its own call is in flight. A call returns in a second; the model
        // then thinks, reads the result, decides the next move — and during
        // that the row went still, so the panel looked finished mid-run
        // (owner, 2026-09-22: "I see it for a very short time"). The run is
        // the unit of "something is happening"; the newest row carries it.
        const working = !!live && ri === runs.length - 1;
        if (run.kind === 'capture') {
          const t = secs(run.step.ms);
          return (
            <div key={ri} className="agent-card cut-corners cut-border border p-1.5">
              <div className="flex items-center gap-1.5 px-0.5 pb-1.5">
                <ViewIcon />
                <span className={`min-w-0 flex-1 truncate text-[12px] ${working ? 'agent-step-live' : 'text-[var(--text-secondary)]'}`}>{run.step.label}</span>
                {t && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{t}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                {run.step.images.map((src, ii) => (
                  <img key={ii} src={src} alt="Canvas screenshot the agent captured" loading="lazy" className="max-h-40 w-full cut-corners object-cover object-top" />
                ))}
              </div>
            </div>
          );
        }
        return <StepsCard key={ri} steps={run.steps} live={working} />;
      })}
    </div>
  );
}

/** How many rows show before the card scrolls. Enough to read the shape of
 *  the work, few enough that the words around it stay on screen. */
export const STEPS_CARD_MAX_ROWS = 7;

/**
 * The card. Bounded, scrolls within itself, follows the newest row while the
 * run is live and the reader has not scrolled up (the same rule as the
 * transcript's own sticky scroll). A finished card opens on its LAST rows —
 * what the run ended with is what the reader wants first; the beginning is a
 * scroll away.
 */
export function StepsCard({ steps, live }: { steps: ActivityStep[]; live: boolean }) {
  const scroller = useFollowingScroller(`${steps.length}|${steps[steps.length - 1]?.label}|${steps[steps.length - 1]?.calls}|${live}`);
  return (
    <div className="agent-card cut-corners cut-border border" data-testid="agent-steps-card" data-rows={steps.length}>
      <div
        ref={scroller.ref}
        onScroll={scroller.onScroll}
        data-more-above={scroller.edges.above || undefined}
        data-more-below={scroller.edges.below || undefined}
        className="agent-steps flex flex-col gap-2 p-1.5"
      >
        {steps.map((s, i) => (
          <ActivityRow key={i} step={s} seconds={secs(s.ms)} live={live && i === steps.length - 1} />
        ))}
      </div>
    </div>
  );
}

/**
 * A bounded box that follows its newest content while the reader sits at the
 * end, and stays put once they scroll up — the transcript's own sticky-scroll
 * rule, per card. `edges` says which sides have content beyond them, for the
 * fade (`.agent-steps[data-more-above|below]`). `follow` changes whenever new
 * content lands. Shared by the steps card and the thinking card.
 */
export function useFollowingScroller(follow: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Which edges have rows beyond them — the fade appears on THAT edge only,
  // so the last row is never dimmed once the card sits at its end.
  const [edges, setEdges] = useState<{ above: boolean; below: boolean }>({ above: false, below: false });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = below < 24;
    const next = { above: el.scrollTop > 2, below: below > 2 };
    setEdges((prev) => (prev.above === next.above && prev.below === next.below ? prev : next));
  };

  // Follow the newest content while the reader is at the end.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    onScroll();
  }, [follow]);

  return { ref, edges, onScroll };
}

/**
 * One folded step, expandable into the calls behind it.
 *
 * The fold is what makes the transcript readable, but it also hides the only
 * record of what the agent actually did — so the line opens. Inside, each call
 * is phrased on its own with its own duration, and a call whose reasoning was
 * captured can be opened once more to show WHY it happened. That is the one
 * thing a folded label genuinely cannot carry.
 *
 * A step of one call has nothing to reveal and renders with no chevron.
 *
 * FAILURES ARE NOT RENDERED. Every message `humanizeFailure` produces says
 * some version of "the agent adjusted and carried on" — which is, by
 * definition, not something the reader has to do anything about. A failure
 * the user must act on belongs in the agent's closing sentence.
 */
export function ActivityRow({ step, seconds, live }: { step: ActivityStep; seconds: string | null; live: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = step.substeps.length > 1;

  const line = (
    <>
      {/* The shimmer runs on the TEXT, so a live row is the same size as a
          finished one and nothing shifts when the step completes. */}
      <span className={`truncate text-[12px] leading-relaxed ${live ? 'agent-step-live' : 'text-[var(--text-tertiary)]'}`}>
        {step.label}
      </span>
      {seconds && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{seconds}</span>}
      {expandable && (
        <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{open ? '▾' : '▸'}</span>
      )}
    </>
  );

  return (
    <div className="min-w-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-baseline gap-1.5 px-0.5 text-left transition-colors hover:[&>span:first-child]:text-[var(--text-secondary)]"
        >
          {line}
        </button>
      ) : (
        <div className="flex min-w-0 items-baseline gap-1.5 px-0.5">{line}</div>
      )}
      {open && (
        <div className="mt-2 flex flex-col gap-2 pl-2">
          {step.substeps.map((sub, i) => <Substep key={i} sub={sub} />)}
        </div>
      )}
    </div>
  );
}

/** One call inside an expanded step, itself expandable when it has reasoning. */
export function Substep({ sub }: { sub: ActivitySubstep }) {
  const [open, setOpen] = useState(false);
  const t = secs(sub.ms);
  const hasNote = !!sub.note?.trim();
  const body = (
    <>
      <span className="truncate text-[12px] leading-relaxed text-[var(--text-tertiary)]">{sub.label}</span>
      {t && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{t}</span>}
      {hasNote && <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{open ? '▾' : '▸'}</span>}
    </>
  );
  return (
    <div className="min-w-0">
      {hasNote ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-baseline gap-1.5 text-left transition-colors hover:[&>span:first-child]:text-[var(--text-secondary)]"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 items-baseline gap-1.5">{body}</div>
      )}
      {open && sub.note && (
        <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {sub.note}
        </p>
      )}
    </div>
  );
}
