// leave-builder.ts — the one way to hard-navigate OUT of the builder.
//
// `/dashboard`, `/auth` and Stripe checkout are owned by other apps, so leaving
// for them is a real page unload, not a React Router transition. Two different
// flushes have to happen first, and only doing one of them is what produced the
// "Leave site? Changes you made may not be saved" dialog on every in-app exit
// (user report 2026-08-08):
//
//   flushNow()      mutation queue → projectFS   (synchronous, in-memory)
//   flushSaveNow()  projectFS      → backend     (async, the network write)
//
// The exits already called the first one. That commits the edit locally and
// marks the project dirty — which is precisely the state `autosave`'s
// beforeunload guard exists to catch, so the guard fired every time. The guard
// itself is fine: it only appears when there IS unsaved work and sendBeacon
// can't carry it (any real project blows the ~64KB beacon quota). The bug was
// navigating away with work still unsaved and letting the browser ask about it.
//
// Awaiting the real save first means there is nothing pending by the time the
// navigation starts, so the guard early-returns and no dialog appears. Reload
// and tab-close still prompt, because nothing flushed for them — which is the
// behaviour asked for, and it falls out of the data being saved rather than
// out of suppressing the warning.
//
// If the save genuinely FAILS (offline, 500), `pendingSave` stays true and the
// dialog still appears on the way out. That is deliberate: it is the only
// remaining signal that work is about to be lost, and silencing it here would
// re-create the loss this whole path was built to prevent.

import { flushNow } from '@/code/mutation/mutation-queue';
import { flushSaveNow } from './autosave';
import { trace } from '@/shared/debug-trace';

/**
 * Commit everything, then hard-navigate to `url`.
 *
 * Callers should `await` it, but nothing breaks if they don't — the navigation
 * is the last statement either way. `reason` is trace-only.
 */
export async function leaveBuilderTo(url: string, reason: string): Promise<void> {
  flushNow();
  try {
    await flushSaveNow();
  } catch (err) {
    // performSave already recorded the failure in the save-status store, and
    // the unload guard will still speak up. Never block the exit on it: a user
    // who wants out of a project whose backend is down must be able to leave.
    trace.error('leave-builder:save-failed', { reason, error: String(err) });
  }
  trace.action('leave-builder:navigate', { reason, url });
  window.location.href = url;
}
