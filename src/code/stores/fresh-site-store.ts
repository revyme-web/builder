// fresh-site-store.ts — arms the "start from a template" prompt for
// brand-new cloud websites.
//
// The dashboard's New Website flow creates the `websites` row with ZERO
// files (`json: '{}'`); ProjectLoader detects that (`fileCount === 0`,
// the `seeded-empty` branch) and arms this store so the editor offers the
// free marketplace templates before the user starts building. Dismissing
// the prompt keeps the blank site and is remembered per website id in
// localStorage so a reload of the still-empty site doesn't nag again.
//
// Same module-state + useSyncExternalStore pattern as viewer-mode-store /
// closed-source-store so the non-React ProjectLoader can write it.

import { useSyncExternalStore } from 'react';
import { trace } from '@/shared/debug-trace';
import { setAutosaveHeld } from '@/backend/autosave';

let _armed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Armed by ProjectLoader's seeded-empty branch (cloud, non-viewer, real
 *  website id, not previously dismissed); cleared by the prompt itself on
 *  dismiss or apply. Arming also HOLDS autosave: boot machinery (the
 *  initial fit-all's camera persist) saves the scaffold into the empty
 *  backend row otherwise, and the remix-into endpoint refuses non-empty
 *  rows. Disarming releases the hold on every path (dismiss, empty
 *  catalog, fetch failure) since this is the single choke point. */
export function setTemplatePromptArmed(v: boolean): void {
  if (_armed === v) return;
  _armed = v;
  setAutosaveHeld(v);
  trace.action('fresh-site:template-prompt-armed', { armed: v });
  emit();
}

/** Sync read for non-React contexts (OnboardingTutorial's auto-show gate). */
export function isTemplatePromptArmed(): boolean {
  return _armed;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React hook — true while the fresh-site template prompt should show. */
export function useTemplatePromptArmed(): boolean {
  return useSyncExternalStore(subscribe, isTemplatePromptArmed, isTemplatePromptArmed);
}

/** Per-website dismissal marker — "he closed it, the site stays from
 *  scratch" must survive a reload of the still-empty site. */
export function templatePromptDismissKey(websiteId: string): string {
  return `revyme-template-prompt-dismissed:${websiteId}`;
}
