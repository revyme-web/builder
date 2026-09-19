// bridge-tools.ts — execute agent tools on behalf of the remote turn loop.
//
// The brain (turn loop, providers, system prompt) runs in the ai-generator
// service; the HANDS are here, because the project files, the mutation queue
// and the oracle all live in this tab. The service asks "run set_styles with
// these args"; this module validates, executes and answers.
//
// The checkpoint is per RUN, not per call: the first mutating tool of a run
// snapshots ProjectFS and holds history coalescing, so the whole run collapses
// to ONE undo entry and can be reverted as a unit — the same contract the
// in-editor agent had. `agentRunEnd` seals it and reports what changed.

import { z } from 'zod';
import { findTool, buildToolManifest, type ToolManifestEntry } from './tool-manifest';
import { TurnCheckpoint } from './checkpoint';
import { formatToolError } from './error-format';
import { getDefaultStore } from 'jotai';
import { interactingViewportWidthAtom } from '@/code/stores/viewport-store';
import { lockBranch, unlockBranch, withAgentWriteAccessAsync } from '@/code/stores/agent-run-lock-store';
import { projectFS } from '@/code/project/project-fs';
import type { TurnFileChange } from '@/code/project/file-diff';
import { trace } from '@/shared/debug-trace';

interface ActiveRun {
  runId: string;
  checkpoint: TurnCheckpoint;
  abort: AbortController;
  releaseLock: () => void;
}

let active: ActiveRun | null = null;

/** Viewport width the tools resolve responsive writes against — the same
 *  atom the in-editor agent read, so a tool writes to the band the user is
 *  actually looking at. */
function activeViewportWidth(): number {
  try {
    return getDefaultStore().get(interactingViewportWidthAtom) || 1440;
  } catch {
    return 1440;
  }
}

export function agentToolManifest(): { tools: ToolManifestEntry[] } {
  return { tools: buildToolManifest() };
}

/** Open a run: lock the branch, arm a checkpoint. Idempotent per runId. */
export function agentRunStart(params: { runId?: string } = {}): { runId: string; branch: string } {
  const runId = params.runId ?? `run-${Date.now().toString(36)}`;
  if (active?.runId === runId) return { runId, branch: projectFS.getActiveBranchId() };
  if (active) agentRunEnd({ runId: active.runId });
  const branch = projectFS.getActiveBranchId();
  active = {
    runId,
    checkpoint: new TurnCheckpoint(),
    abort: new AbortController(),
    releaseLock: (lockBranch(branch), () => unlockBranch(branch)),
  };
  trace.action('agent-bridge:run-start', { runId, branch });
  return { runId, branch };
}

/** Close a run: seal the checkpoint, release the lock, report the diff. */
export function agentRunEnd(params: { runId?: string } = {}): { runId: string | null; changes: TurnFileChange[] } {
  if (!active) return { runId: null, changes: [] };
  if (params.runId && params.runId !== active.runId) {
    trace.action('agent-bridge:run-end-mismatch', { asked: params.runId, active: active.runId });
  }
  const { runId, checkpoint, releaseLock } = active;
  active = null;
  let changes: TurnFileChange[] = [];
  try {
    changes = checkpoint.end();
  } catch (err) {
    trace.error('agent-bridge:checkpoint-end-failed', err);
  } finally {
    try { releaseLock(); } catch { /* lock already released */ }
  }
  trace.action('agent-bridge:run-end', { runId, files: changes.length });
  return { runId, changes };
}

/** Abort the in-flight run's tools; the service stops streaming separately. */
export function agentRunAbort(): { aborted: boolean } {
  if (!active) return { aborted: false };
  active.abort.abort();
  trace.action('agent-bridge:run-abort', { runId: active.runId });
  return { aborted: true };
}

/**
 * Execute ONE tool call. Never throws across the bridge: a failure comes back
 * as `{ isError: true }` with a teaching message, because the model's next
 * move depends on reading WHY it failed — a transport-level rejection would
 * strand the loop instead of letting it self-correct.
 */
export async function agentToolCall(params: {
  name?: string;
  input?: Record<string, unknown>;
  runId?: string;
}): Promise<{ isError: boolean; content: unknown[] }> {
  const name = String(params.name ?? '');
  const tool = findTool(name);
  if (!tool) {
    const known = buildToolManifest().map((t) => t.name).join(', ');
    return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}". Available: ${known}` }] };
  }
  if (!active) agentRunStart({ runId: params.runId });
  const run = active!;

  let args: Record<string, unknown>;
  try {
    args = z.object(tool.inputSchema).parse(params.input ?? {}) as Record<string, unknown>;
  } catch (err) {
    // The teaching envelope: zod issues become a rule + an example, so the
    // model can fix the call rather than retry the same shape.
    return { isError: true, content: [{ type: 'text', text: formatToolError(err, { toolName: name }) }] };
  }

  try {
    const result = await withAgentWriteAccessAsync(async () =>
      tool.execute(args, {
        ensureCheckpoint: () => run.checkpoint.begin(),
        vpWidth: activeViewportWidth(),
        signal: run.abort.signal,
      }));
    trace.action('agent-bridge:tool', { name, isError: !!result.isError });
    return { isError: !!result.isError, content: result.content };
  } catch (err) {
    trace.error('agent-bridge:tool-threw', { name, error: String(err) });
    return { isError: true, content: [{ type: 'text', text: formatToolError(err, { toolName: name }) }] };
  }
}
