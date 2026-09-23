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
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { flushNow } from '@/code/mutation/mutation-queue';
import { checkFile, isAgentBlockingOracleViolation } from '@/code/oracle/check-file';
import { oracleFileKind, isBuilderMaterializedFile } from '@/code/oracle/file-kind';
import type { TurnFileChange } from '@/code/project/file-diff';
import { buildAgentContextBlock } from './editor-context';
import { readAgentSurface } from './surface-state';
import { surfaceForRequest } from './surface';
import { runBeforeAgentTurn } from './turn-hooks';
import { trace } from '@/shared/debug-trace';

/**
 * Who opened a run.
 *  · `service` — the builder's own chat: the agent service opens it with
 *    `run_start` and closes it with `run_end` around the turn.
 *  · `mcp`     — an EXTERNAL agent (the user's Claude Code / Claude Desktop
 *    through the Revyme MCP connector) that called `begin_work`: a real run,
 *    exactly like the chat's — lock, one undo step, Changes card, mirrored
 *    into the chat — closed by its `finish_work`.
 *  · `lazy`    — an external agent that called a tool without `begin_work`.
 *
 * Every run behaves the same inside the editor; the difference is only who
 * is trusted to close it (see RUN_LEASE_MS).
 */
export type RunSource = 'service' | 'mcp' | 'lazy';

interface ActiveRun {
  runId: string;
  checkpoint: TurnCheckpoint;
  abort: AbortController;
  releaseLock: () => void;
  source: RunSource;
  /** Tool calls made in this run, for the per-call ids the mirror keys on. */
  calls: number;
}

let active: ActiveRun | null = null;

/**
 * THE LEASE. An external client never sends `run_end` by itself (a lazy one)
 * or may crash before it calls `finish_work` (an MCP one); a run nobody
 * closes keeps the branch locked, and since the lock is a viewer-mode reason
 * the editor sat read-only ("Agent is editing…") until a reload
 * (2026-09-22). So an external run ends itself this long after its LAST tool
 * call returns. The chat's own runs are closed by the service (and by the
 * chat when its stream dies) and hold no lease.
 */
export const LAZY_RUN_IDLE_MS = 20_000;
export const MCP_RUN_IDLE_MS = 5 * 60_000;
const RUN_LEASE_MS: Record<RunSource, number | null> = { service: null, mcp: MCP_RUN_IDLE_MS, lazy: LAZY_RUN_IDLE_MS };
let leaseTimer: ReturnType<typeof setTimeout> | null = null;
/** Tool calls in flight — a slow tool (a screenshot, a big write) must not
 *  see its own run expire under it; the lease counts from the LAST return. */
let callsInFlight = 0;
function armLease(): void {
  if (leaseTimer) clearTimeout(leaseTimer);
  leaseTimer = null;
  const ms = active ? RUN_LEASE_MS[active.source] : null;
  if (!active || ms == null) return;
  const runId = active.runId;
  leaseTimer = setTimeout(() => {
    leaseTimer = null;
    if (active?.runId !== runId) return;
    if (callsInFlight > 0) { armLease(); return; }
    trace.action('agent-bridge:external-run-expired', { runId });
    endRun({ runId }, false);
  }, ms);
}

/**
 * The chat's view of an EXTERNAL run (mcp / lazy). The editor's agent panel
 * registers one (editor/agent/external-run.ts) and renders the run exactly
 * as it renders its own: the request, live activity rows, Stop, the Changes
 * card, the saved transcript. Absent in headless contexts — nothing to show.
 */
export interface ExternalRunObserver {
  begin(run: { runId: string; source: 'mcp' | 'lazy'; request?: string; client?: string }): void;
  toolStart(call: { id: string; name: string; input: Record<string, unknown> }): void;
  toolEnd(result: { id: string; ok: boolean; content: string; image?: string; ms: number }): void;
  end(run: { runId: string; changes: TurnFileChange[]; summary?: string; stopped: boolean }): void;
}
let observer: ExternalRunObserver | null = null;
export function setExternalRunObserver(next: ExternalRunObserver | null): void {
  observer = next;
}
const notify = (fn: (o: ExternalRunObserver) => void): void => {
  if (!observer) return;
  try { fn(observer); } catch (err) { trace.error('agent-bridge:observer-threw', err); }
};

/**
 * STOP, for an external run. The chat's Stop aborts its own stream; an
 * external agent's loop runs in ITS client, out of reach — so Stop ends the
 * run here (lock released, work so far kept as one undo step) and refuses
 * that agent's next calls for a while, with a message telling it the user
 * stopped it. Its next `begin_work` (a new request) clears this.
 */
export const EXTERNAL_STOP_MS = 2 * 60_000;
let externalStopUntil = 0;
export const EXTERNAL_STOPPED_MESSAGE =
  'The user pressed Stop in the Revyme editor — this work was ended and kept as it was. Do not continue it: tell the user it was stopped, and wait for their next request (call begin_work when they ask for something new).';

export function stopExternalRun(): boolean {
  if (!active || active.source === 'service') return false;
  active.abort.abort();
  externalStopUntil = Date.now() + EXTERNAL_STOP_MS;
  trace.action('agent-bridge:external-run-stopped', { runId: active.runId });
  endRun({ runId: active.runId }, true);
  return true;
}

/** Is the run in flight an external agent's? (the chat's Stop routes on it) */
export function isExternalRunActive(): boolean {
  return !!active && active.source !== 'service';
}

/**
 * What the chat sends the service at the start of every turn — the context
 * block (page, surface, selection, branch…) and the surface whose manual goes
 * with it — for an external agent's `begin_work`, so it starts from exactly
 * the same knowledge. Settles the panel first, like the chat does.
 */
export function agentContext(): { contextBlock: string; surface: { kind: string; skill: string | null }; branch: string } {
  runBeforeAgentTurn();
  const surface = readAgentSurface();
  return { contextBlock: buildAgentContextBlock(surface), surface: surfaceForRequest(surface), branch: projectFS.getActiveBranchId() };
}

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

/** Open a run: lock the branch, arm a checkpoint. Idempotent per runId.
 *  `source` / `request` / `client` describe an external agent's run (see
 *  RunSource); the chat's service omits them. */
export function agentRunStart(params: { runId?: string; source?: RunSource; request?: string; client?: string } = {}): { runId: string; branch: string } {
  const source: RunSource = params.source === 'mcp' || params.source === 'lazy' ? params.source : 'service';
  const runId = params.runId ?? `run-${Date.now().toString(36)}`;
  if (active?.runId === runId) return { runId, branch: projectFS.getActiveBranchId() };
  if (active) agentRunEnd({ runId: active.runId });
  // A new request from the external agent ends the "you were stopped" window.
  if (source === 'mcp') externalStopUntil = 0;
  const branch = projectFS.getActiveBranchId();
  active = {
    runId,
    checkpoint: new TurnCheckpoint(),
    abort: new AbortController(),
    releaseLock: (lockBranch(branch), () => unlockBranch(branch)),
    source,
    calls: 0,
  };
  trace.action('agent-bridge:run-start', { runId, branch, source });
  if (source !== 'service') {
    const ext = source;
    notify((o) => o.begin({ runId, source: ext, request: params.request, client: params.client }));
  }
  armLease();
  return { runId, branch };
}

/** Close a run: seal the checkpoint, release the lock, report the diff.
 *  `summary` is an external agent's closing sentence (finish_work). */
export function agentRunEnd(params: { runId?: string; summary?: string } = {}): { runId: string | null; changes: TurnFileChange[] } {
  return endRun(params, false);
}

function endRun(params: { runId?: string; summary?: string }, stopped: boolean): { runId: string | null; changes: TurnFileChange[] } {
  if (!active) return { runId: null, changes: [] };
  if (params.runId && params.runId !== active.runId) {
    trace.action('agent-bridge:run-end-mismatch', { asked: params.runId, active: active.runId });
  }
  const { runId, checkpoint, releaseLock, source } = active;
  active = null;
  if (leaseTimer) { clearTimeout(leaseTimer); leaseTimer = null; }
  let changes: TurnFileChange[] = [];
  try {
    changes = checkpoint.end();
  } catch (err) {
    trace.error('agent-bridge:checkpoint-end-failed', err);
  } finally {
    try { releaseLock(); } catch { /* lock already released */ }
  }
  trace.action('agent-bridge:run-end', { runId, files: changes.length, source, stopped });
  if (source !== 'service') notify((o) => o.end({ runId, changes, summary: params.summary, stopped }));
  return { runId, changes };
}

/**
 * The run moved to another branch (create_branch / switch_branch): the lock
 * follows it, so the human cannot switch the tab away from under the run's
 * writes, and run-end releases the branch the run actually ended on.
 */
export function agentRunFollowBranch(branchId: string): void {
  if (!active) return;
  try { active.releaseLock(); } catch { /* already released */ }
  lockBranch(branchId);
  active.releaseLock = () => unlockBranch(branchId);
  trace.action('agent-bridge:run-follow-branch', { runId: active.runId, branch: branchId });
}

/** Abort the in-flight run's tools; the service stops streaming separately. */
export function agentRunAbort(): { aborted: boolean } {
  if (!active) return { aborted: false };
  active.abort.abort();
  trace.action('agent-bridge:run-abort', { runId: active.runId });
  return { aborted: true };
}

/**
 * A bridge method an agent calls OUTSIDE the agent tool set — the MCP proxy's
 * own file / CMS / preset / translation / upload tools (`revyme_submit_files`
 * …). They wrote straight through, outside any run: no undo checkpoint, no
 * row in the chat, no lock opened. Attributed here like an agent tool: a
 * write opens a (lazy) run when none is open and begins its checkpoint, so it
 * lands in the same undo step and Changes card; an external run shows it as
 * a row. Reads outside a run stay plain reads.
 */
export async function attributeBridgeCall<T>(
  toolName: string,
  input: Record<string, unknown>,
  write: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!active) {
    if (Date.now() < externalStopUntil) throw new Error(EXTERNAL_STOPPED_MESSAGE);
    if (!write) return fn();
    agentRunStart({ source: 'lazy' });
  }
  const run = active!;
  if (write) run.checkpoint.begin();
  const external = run.source !== 'service';
  const callId = `${run.runId}:${++run.calls}`;
  const began = Date.now();
  if (external) notify((o) => o.toolStart({ id: callId, name: toolName, input }));
  callsInFlight++;
  try {
    const result = await fn();
    if (external) {
      const failed = !!result && typeof result === 'object' && ((result as { committed?: unknown }).committed === false || typeof (result as { error?: unknown }).error === 'string');
      notify((o) => o.toolEnd({ id: callId, ok: !failed, content: JSON.stringify(result ?? null).slice(0, 4000), ms: Date.now() - began }));
    }
    return result;
  } catch (err) {
    if (external) notify((o) => o.toolEnd({ id: callId, ok: false, content: String((err as Error)?.message ?? err), ms: Date.now() - began }));
    throw err;
  } finally {
    callsInFlight--;
    armLease();
  }
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
  if (!active) {
    // The user stopped this external agent a moment ago: refuse, and say why,
    // rather than quietly opening a new run for work they just cancelled.
    if (Date.now() < externalStopUntil) {
      return { isError: true, content: [{ type: 'text', text: EXTERNAL_STOPPED_MESSAGE }] };
    }
    // No run_start / begin_work came first: an external client calling
    // tools directly. It will never close the run itself — it gets a lease.
    agentRunStart({ runId: params.runId, source: 'lazy' });
  }
  const run = active!;
  const external = run.source !== 'service';
  const callId = `${run.runId}:${++run.calls}`;
  const began = Date.now();
  if (external) notify((o) => o.toolStart({ id: callId, name, input: params.input ?? {} }));
  callsInFlight++;
  try {
    const result = await executeToolCall(tool, name, params, run);
    if (external) {
      const blocks = result.content as Array<{ type?: string; text?: string; dataUrl?: string }>;
      notify((o) => o.toolEnd({
        id: callId,
        ok: !result.isError,
        content: blocks.map((b) => b.text ?? '').filter(Boolean).join('\n'),
        image: blocks.find((b) => b.type === 'image' && typeof b.dataUrl === 'string')?.dataUrl,
        ms: Date.now() - began,
      }));
    }
    return result;
  } finally {
    callsInFlight--;
    armLease();
  }
}

async function executeToolCall(
  tool: NonNullable<ReturnType<typeof findTool>>,
  name: string,
  params: { input?: Record<string, unknown> },
  run: ActiveRun,
): Promise<{ isError: boolean; content: unknown[] }> {
  let args: Record<string, unknown>;
  try {
    args = z.object(tool.inputSchema).parse(params.input ?? {}) as Record<string, unknown>;
  } catch (err) {
    // The teaching envelope: zod issues become a rule + an example, so the
    // model can fix the call rather than retry the same shape.
    return { isError: true, content: [{ type: 'text', text: formatToolError(err, { toolName: name }) }] };
  }

  try {
    // Every write path is judged (audit tier 0): the semantic tools write
    // through generators, which the gate never sees. Snapshot the files a
    // call can touch, run the oracle on what changed, and report what the
    // call INTRODUCED — tier 3 as a failure the model must fix now, the
    // rest as `oracle` rows on the reply.
    const watched = tool.category === 'semantic' ? oracleSnapshot() : null;
    const result = await withAgentWriteAccessAsync(async () =>
      tool.execute(args, {
        ensureCheckpoint: () => run.checkpoint.begin(),
        vpWidth: activeViewportWidth(),
        signal: run.abort.signal,
      }));
    trace.action('agent-bridge:tool', { name, isError: !!result.isError });
    if (watched && !result.isError) return oracleReport(name, watched, result);
    return { isError: !!result.isError, content: result.content };
  } catch (err) {
    trace.error('agent-bridge:tool-threw', { name, error: String(err) });
    return { isError: true, content: [{ type: 'text', text: formatToolError(err, { toolName: name }) }] };
  }
}

// ─── Post-write oracle report ────────────────────────────────────────────────

type OracleRow = { file: string; code: string; tier: number; line?: number; element?: string; message: string };

/** The files a semantic write can land in: the active file plus every
 *  page / component (masters are written through modifyProjectFile). Small
 *  projects make this a cheap read; the oracle only runs on files that changed. */
function oracleSnapshot(): Map<string, string> {
  const snap = new Map<string, string>();
  try { flushNow(); } catch { /* nothing queued */ }
  const active = getDefaultStore().get(activeFilePathAtom);
  const paths = new Set<string>([active, ...projectFS.listFiles('app/'), ...projectFS.listFiles('components/')]);
  for (const p of paths) {
    if (!p || !/\.tsx$/.test(p)) continue;
    const code = projectFS.readFile(p);
    if (code != null) snap.set(p, code);
  }
  return snap;
}

function violationsOf(path: string, code: string): OracleRow[] {
  const kind = oracleFileKind(path, code);
  if (!kind || isBuilderMaterializedFile(code)) return [];
  try {
    return checkFile(code, { kind, path }).map((v) => ({ file: path, code: v.code, tier: v.tier, line: v.line, element: v.elementId ?? undefined, message: v.message.slice(0, 280) }));
  } catch (err) {
    return [{ file: path, code: 'SYNTAX_ERROR', tier: 3, message: String(err).slice(0, 280) }];
  }
}

function oracleReport(toolName: string, before: Map<string, string>, result: { isError?: boolean; content: unknown[] }): { isError: boolean; content: unknown[] } {
  try { flushNow(); } catch { /* nothing queued */ }
  const introduced: OracleRow[] = [];
  const paths = new Set<string>([...before.keys(), ...projectFS.listFiles('app/'), ...projectFS.listFiles('components/')]);
  for (const p of paths) {
    if (!/\.tsx$/.test(p)) continue;
    const after = projectFS.readFile(p);
    const prev = before.get(p);
    if (after == null || after === prev) continue;
    const baseline = new Set((prev != null ? violationsOf(p, prev) : []).map((v) => v.code));
    for (const v of violationsOf(p, after)) if (!baseline.has(v.code)) introduced.push(v);
  }
  if (introduced.length === 0) return { isError: !!result.isError, content: result.content };
  // BLOCKING = the builder's own agent-flush bounce set (crash-class codes),
  // not every tier-3 rule: FORM_NO_DESTINATION on a form the next call
  // configures is a step in a flow, not a broken file.
  const blocking = introduced.filter((v) => isAgentBlockingOracleViolation(v.code));
  trace.action('agent-bridge:oracle-report', { tool: toolName, introduced: introduced.length, blocking: blocking.length });
  // Fold the rows into the reply: JSON replies get an `oracle` key, prose
  // replies a trailing block. A tier-3 row flips the call to an error — the
  // file would not build; the model fixes it before anything else.
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  const rows = introduced.map((v) => ({ file: v.file, code: v.code, tier: v.tier, line: v.line, element: v.element, fix: v.message }));
  let text: string;
  if (first?.type === 'text' && typeof first.text === 'string') {
    try {
      const json = JSON.parse(first.text);
      text = JSON.stringify(typeof json === 'object' && json ? { ...json, ...(blocking.length ? { error: `${toolName} wrote source the site cannot build (${blocking.map((v) => v.code).join(', ')}) — fix it now` } : {}), oracle: rows } : { result: json, oracle: rows });
    } catch {
      text = `${first.text}\n\noracle: ${JSON.stringify(rows)}`;
    }
  } else {
    text = JSON.stringify({ oracle: rows });
  }
  return { isError: blocking.length > 0, content: [{ type: 'text', text }, ...result.content.slice(1)] };
}
