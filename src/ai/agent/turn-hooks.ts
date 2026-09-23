// turn-hooks.ts — let a panel get its house in order before the agent looks.
//
// The agent reads FILES. A panel that edits a buffer — the code-component
// editor holds the user's typing in Monaco until they press Save — shows the
// user one thing while the agent would read another: "make the glow bigger"
// lands on a file that does not yet contain the glow they just typed.
//
// A panel registers a hook that settles that (the component editor saves its
// buffer, exactly as its Save button would); the chat runs the hooks before it
// builds the turn's context. Deliberately tiny and synchronous: a hook that
// could fail or wait would turn "send a message" into something that can hang.

import { trace } from '@/shared/debug-trace';

type BeforeTurnHook = () => void;

const hooks = new Set<BeforeTurnHook>();

/** Register a hook; returns its unregister function (use as an effect cleanup). */
export function registerBeforeAgentTurn(hook: BeforeTurnHook): () => void {
  hooks.add(hook);
  return () => { hooks.delete(hook); };
}

/** Run every hook. One that throws is traced and skipped — it must never cost
 *  the user their message. */
export function runBeforeAgentTurn(): void {
  for (const hook of [...hooks]) {
    try {
      hook();
    } catch (err) {
      trace.error('agent-turn-hooks:hook-threw', err);
    }
  }
}
