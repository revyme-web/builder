// credits-store.ts — workspace AI-credit balance for the editor UI.
//
// The website being edited belongs to a workspace, and AI credits are a
// workspace-level pool. Fetched once on editor load (ProjectLoader),
// then read by the AI chat bars to show the live balance. Cloud-only —
// stays null in standalone / local-project mode.
//
// Module-level state + `useSyncExternalStore`, the same pattern as
// `viewer-mode-store` — readable from React and imperative code, and
// dodges the editor's `<Provider>` store.

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';
import { backend } from '@/backend';

export interface CreditsState {
  /** Credits available in the workspace pool. */
  balance: number;
  /** Owning workspace id — used to deep-link to its credits page. */
  workspaceId: string;
}

let _state: CreditsState | null = null;
const listeners = new Set<() => void>();

/** Set (or clear with `null`) the credit state. Called by ProjectLoader
 *  once the workspace id + balance have been fetched. */
export function setCredits(next: CreditsState | null): void {
  _state = next;
  trace.action('credits:set', { balance: next?.balance ?? null });
  for (const fn of listeners) fn();
}

/** Imperative read. */
export function getCreditsState(): CreditsState | null {
  return _state;
}

/** Re-fetch the workspace balance and update the store. Call after an
 *  AI run consumes credits so the indicator reflects the new total
 *  without a page reload. No-op when there's no workspace (local mode)
 *  or the fetch fails (the stale balance is kept rather than cleared). */
export async function refreshCredits(): Promise<void> {
  const current = _state;
  if (!current) return;
  const balance = await backend.getCredits(current.workspaceId);
  if (balance !== null) {
    setCredits({ balance, workspaceId: current.workspaceId });
  }
}

/** Open the workspace's credits page (revyme-cloud dashboard settings) in a
 *  new tab. Shared by every "top up" affordance (CreditsIndicator pill, AI
 *  out-of-credits popovers). No-op when there's no workspace (local mode). */
export function openWorkspaceCreditsPage(): void {
  openWorkspaceSettingsPage('credits');
}

/**
 * Does this AI error mean "the workspace pool is empty"?
 *
 * The AI service answers 402 with one fixed sentence from a single shared
 * helper (`refuseIfOutOfCredits` in ai-generator/src/server.ts), so every
 * endpoint phrases it identically. The clients rethrow only `err.message` —
 * the status code is lost on the way to the chat panel — so the text is what
 * we have to match on. Kept HERE, in one place, rather than as a regex copied
 * into each panel: if the server wording ever changes, this is the only line
 * that has to follow it.
 */
export function isOutOfCreditsError(text: string | null | undefined): boolean {
  return !!text && /out of credits/i.test(text);
}

/** Open ANY workspace dashboard settings tab in a new tab (credits,
 *  api-tokens, …). No-op when there's no workspace (local mode). */
export function openWorkspaceSettingsPage(tab: string): void {
  const ws = _state?.workspaceId;
  if (!ws) return;
  trace.action('credits:open-settings-page', { workspaceId: ws, tab });
  // Same origin as the editor — the dashboard lives at /dashboard.
  const href =
    `${window.location.origin}/dashboard` +
    `?ws=${encodeURIComponent(ws)}` +
    `&view=${encodeURIComponent(`settings:${tab}`)}`;
  window.open(href, '_blank', 'noopener,noreferrer');
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): CreditsState | null {
  return _state;
}

/** React hook — reactive credit state, or `null` when unavailable
 *  (standalone mode, not yet loaded, or the fetch failed). */
export function useCredits(): CreditsState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
