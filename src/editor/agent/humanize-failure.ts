// agent/humanize-failure.ts — a failed tool call, in words the user can read.
//
// Shared by the chat's own turns (AgentChat) and the mirror of work asked for
// through MCP (ai/agent/external-run.ts).

/**
 * Turn a failed tool's payload into one readable line.
 *
 * The gate answers with the oracle's own violation objects. Their CODES are
 * the actionable part — `USE_CLIENT_REQUIRED` says exactly what was wrong,
 * where a wall of prose does not — so lead with those and fall back to the
 * first line of text when the failure is not a gate bounce.
 */
/**
 * A failed step, in plain language.
 *
 * The payload is written for the MODEL — oracle violation codes, tool
 * ledgers, retry hints. The person reading is looking at their website: codes
 * like `COMPONENT_ROOT_POSITION` tell them nothing except that something
 * technical went wrong, which reads as breakage even though almost every one
 * of these is caught, explained and corrected on the next step.
 *
 * So: say what happened and that it was handled. Never a code.
 */
export function humanizeFailure(content: string): string {
  const c = content.toLowerCase();

  // Oracle bounce — the gate refused the code. The most common failure by far,
  // and the most reassuring: nothing was written and the agent was told why.
  if (/"code"\s*:\s*"[A-Z0-9_]+"/.test(content) || /oracle .*gate|\bgate blocked\b/i.test(content)) {
    return 'Revyme wouldn\u2019t accept that code — the agent was shown what was wrong and corrected it.';
  }
  // The user was dragging/resizing while the agent wrote.
  if (c.includes('mid-interaction') || c.includes('drag/resize')) {
    return 'You were editing at the same moment, so this step waited and ran again.';
  }
  // A tool that cannot run inside a bulk edit.
  if (c.includes('cannot run inside batch') || c.includes('unknown tool')) {
    return 'A step was grouped with others when it needed its own turn — the agent split it out.';
  }
  // An anchored edit whose anchor moved.
  if (c.includes('oldtext not found') || c.includes('anchor must match')) {
    return 'The file had changed since the agent last read it, so it re-read and edited again.';
  }
  // The editor never answered.
  if (c.includes('could not run') || c.includes('timeout') || c.includes('no editor')) {
    return 'The editor didn\u2019t respond to this step.';
  }
  if (c.includes('not found') || c.includes('missing')) {
    return 'Something the agent expected to find wasn\u2019t there, so it looked again.';
  }
  return 'This step didn\u2019t apply — the agent adjusted and carried on.';
}
