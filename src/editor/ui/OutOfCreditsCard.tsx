// OutOfCreditsCard.tsx — what an AI panel shows when the workspace pool is dry.
//
// Every AI endpoint answers 402 with the same sentence (the shared
// `refuseIfOutOfCredits` helper in the AI service), so every chat surface can
// hit this — Vibe, icon-set chat, and the component/plugin chats via ChatShell.
// One component, four call sites.
//
// It is deliberately NOT the red error bubble those panels use for failures.
// Running out of credits isn't a fault the user can debug; it's a task with
// exactly one next step, and red styling reads as "something broke" and invites
// a bug report. This reads as "here's the button".
//
// The button targets the CURRENT workspace's credits tab (the id comes from
// credits-store, set at editor load), so nobody has to work out which of their
// workspaces was short. It opens in a new tab — the editor holds unsaved canvas
// state and must not be navigated away from.

import { openWorkspaceCreditsPage } from '@/code/stores/credits-store';

export default function OutOfCreditsCard() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] w-full cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--control-bg)] px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-[var(--accent)] shrink-0" aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="text-[11px] font-medium text-[var(--text-primary)]">Out of credits</span>
        </div>
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-secondary)]">
          This workspace has no AI credits left. Top up to keep using AI.
        </p>
        <button
          type="button"
          onClick={openWorkspaceCreditsPage}
          className="mt-2 w-full cut-corners bg-[var(--accent)] px-2 py-1.5 text-[11px] font-medium text-[var(--accent-fg)] transition-[filter] hover:brightness-110 cursor-pointer"
        >
          Top up credits
        </button>
      </div>
    </div>
  );
}
