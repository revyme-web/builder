// freeform/freeform-client.ts — browser-side loop for freeform+oracle generation.
//
// The SERVER owns the seed prompt + Gemini (ai-generator/src/freeform.ts); the
// BROWSER owns the gates: it sends the request, runs the returned file through
// the oracle (checkFile), and bounces the batched violations back until the
// file passes — then (and only then) writes it to the project. A file that
// can't pass the gates is NEVER committed (worst case: no change + a message).
//
// Hardening learned from the design-spec client's bugs (2026-06-09): per-attempt
// timeout, AbortController, and an isStillActive guard so a result never lands
// on (or saves under) a different file after the user switches away.

import { trace } from '@/shared/debug-trace';
import { projectFS } from '@/code/project/project-fs';
import { type FileKind, type OracleViolation } from '@/code/oracle/check-file';
// The gate moved to the oracle (code/oracle/gate.ts). Re-exported here so the
// existing import sites keep working; new code should import from the oracle.
import { gateTurnFiles, commitTurnFiles, formatBounce, type TurnFile } from '@/code/oracle/gate';
import { getProjectId } from '@/backend/project-id';
export { gateTurnFiles, commitTurnFiles, formatBounce, type TurnFile };

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';
const MAX_ATTEMPTS = 3;

// A turn is submitted as a JOB and polled, not held open on one request.
//
// Why the old shape had to go: a whole-file rewrite legitimately runs 2-2.5
// minutes, and when the provider stalls the server's retry pushes the total
// past seven. No timeout value survives that — the browser, nginx, and any
// proxy between them all abandon a socket that has been silent for minutes.
// A 120s limit once aborted a live rewrite 3.6 SECONDS before the answer
// arrived; raising it to 295s then lost a PERFECT generation that landed at
// 7m06s, having already charged 103 credits for it (both 2026-08-25).
//
// Polling makes every request milliseconds long, so no timeout in the stack
// can fire, and a dropped connection is survivable: the job keeps running
// server-side and the same id still yields the result that was paid for.

/** Per-HTTP-request cap. These are tiny calls; anything slower is a network fault. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Gap between polls. Fast enough to feel responsive, idle enough to be free. */
const POLL_INTERVAL_MS = 1_500;
/** Ceiling on ONE attempt's generation. Well past the observed worst case
 *  (7m06s) because nothing here is holding a connection open to wait it out. */
const JOB_TIMEOUT_MS = 12 * 60 * 1000;

export interface FreeformEditRequest {
  prompt: string;
  activeFilePath: string;
  kind: Extract<FileKind, 'page' | 'component'>;
  history?: Array<{ role: string; content: string }>;
  workspaceId?: string;
  /** OpenRouter model slug from the Vibe model select. Optional — the server
   *  clamps it to its catalog and falls back to the default when absent. */
  model?: string;
  signal?: AbortSignal;
  /** Re-checked before every apply/bounce — false means the user moved on. */
  isStillActive?: () => boolean;
  /** Progress callback per attempt: violations of the attempt that just failed. */
  onAttempt?: (attempt: number, violations: OracleViolation[]) => void;
}

export interface FreeformEditResult {
  success: boolean;
  attempts: number;
  /** Model's one-line explanation (on success). */
  text?: string;
  error?: string;
  violations?: OracleViolation[];
  /** All file paths written on success (multi-file turns create components too). */
  written?: string[];
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Read `{ error }` off a failed response without letting a non-JSON body
 *  (an nginx 502 page, say) throw over the top of the real status. */
async function errorFrom(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error || `Request failed: ${res.status}`;
}

/**
 * Submit one turn as a server-side job and poll it to completion.
 *
 * The turn used to be a single POST held open for the whole generation, which
 * cannot work: the work runs 2-7 minutes and every timeout in the stack is
 * shorter than that. Here the POST returns immediately with an id and the
 * generation continues server-side, so nothing is waiting on a silent socket.
 *
 * The property that matters beyond timeouts: the job is not owned by this
 * connection. A blip mid-poll is retried on the next tick rather than
 * destroying a generation the user has already been charged for.
 */
type JobOutcome =
  | { ok: true; data: any }
  | { ok: false; error: string };

/** Sleep that wakes early (and reports it) when the caller aborts. */

async function runTurnAsJob(payload: object, signal?: AbortSignal): Promise<JobOutcome> {
  let jobId: string;
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/freeform/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The session cookie + the project: on Revyme cloud the service bills
      // the PROJECT's workspace and refuses a caller who cannot edit it.
      credentials: 'include',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ ...payload, websiteId: getProjectId() }),
    });
    if (!res.ok) return { ok: false, error: await errorFrom(res) };
    const body = await res.json();
    if (!body.jobId) return { ok: false, error: body.error || 'The server did not start the generation.' };
    jobId = body.jobId;
  } catch (err) {
    if (signal?.aborted) return { ok: false, error: 'Stopped.' };
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }

  trace.action('freeform:job-accepted', { jobId });

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  // Transient poll failures must not kill a job that is still generating —
  // only a run of them means the server is genuinely unreachable.
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS, signal);
    if (signal?.aborted) return { ok: false, error: 'Stopped.' };

    let res: Response;
    try {
      res = await fetch(`${AI_SERVICE_URL}/api/freeform/job/${jobId}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (++consecutiveFailures >= 5) return { ok: false, error: 'Lost contact with the AI service.' };
      continue;
    }
    consecutiveFailures = 0;

    // 404 means swept or lost to a restart — it will never settle, so stop.
    if (res.status === 404) return { ok: false, error: await errorFrom(res) };
    if (!res.ok) return { ok: false, error: await errorFrom(res) };

    const data = await res.json().catch(() => null);
    if (!data) continue;
    if (data.status === 'running') continue;
    if (data.status === 'error') return { ok: false, error: data.error || 'turn failed' };
    return { ok: true, data };
  }

  return { ok: false, error: 'The generation took too long. Please try again.' };
}

export async function runFreeformEdit(req: FreeformEditRequest): Promise<FreeformEditResult> {
  const { prompt, activeFilePath, kind, history = [], workspaceId, model, signal, isStillActive = () => true, onAttempt } = req;
  trace.action('freeform:start', { activeFilePath, kind, model, prompt: prompt.slice(0, 80) });

  const currentCode = projectFS.readFile(activeFilePath);
  if (currentCode == null) return { success: false, attempts: 0, error: `File not found: ${activeFilePath}` };

  let previousAttempt: string | undefined;
  let violations: OracleViolation[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    trace.action('freeform:turn', { attempt, violations: violations.map((v) => v.code) });

    const outcome = await runTurnAsJob({
      prompt,
      kind,
      currentCode,
      // the file's REAL path — without it the model invents one and the
      // page update lands on a phantom file (live failure 2026-06-10)
      currentPath: activeFilePath,
      previousAttempt,
      violations: violations.length ? formatBounce(violations) : undefined,
      history,
      workspaceId,
      model,
    }, signal);

    if (!outcome.ok) return { success: false, attempts: attempt, error: outcome.error };
    const data = outcome.data;
    if (!data.success) return { success: false, attempts: attempt, error: data.error || 'turn failed' };

    usage.inputTokens += data.usage?.inputTokens ?? 0;
    usage.outputTokens += data.usage?.outputTokens ?? 0;
    usage.durationMs += data.usage?.durationMs ?? 0;

    // Normalize the turn's files (multi-file protocol; empty path = active file),
    // then run the shared gate (phantom-page remap + per-kind oracle + import
    // resolution) — same gatekeeper the MCP bridge uses.
    const rawFiles: TurnFile[] = (data.files as TurnFile[] | undefined)?.length
      ? (data.files as TurnFile[]).map((f) => ({ ...f, path: f.path || activeFilePath }))
      : [{ path: activeFilePath, kind, code: data.code as string }];
    const gated = gateTurnFiles(rawFiles, kind === 'page' ? activeFilePath : null);
    const files = gated.files;
    violations = gated.violations;

    if (violations.length > 0) {
      trace.action('freeform:violations', {
        attempt,
        count: violations.length,
        violations: violations.map((x) => `[${x.code}] ${x.message}`),
      });
      previousAttempt = files.length > 1
        ? files.map((f) => `--- ${f.path} (${f.kind}) ---\n${f.code}`).join('\n\n')
        : files[0].code;
      onAttempt?.(attempt, violations);
      continue;
    }

    // ── commit: all-or-nothing across the batch ──
    if (!isStillActive()) {
      trace.action('freeform:discard-after-file-switch', { activeFilePath });
      return { success: false, attempts: attempt, error: 'Discarded — you switched files while generating.' };
    }
    const written = commitTurnFiles(files);
    trace.action('freeform:committed', { activeFilePath, attempt, written });
    return { success: true, attempts: attempt, text: data.text, written, usage };
  }

  trace.action('freeform:gave-up', { count: violations.length, violations: violations.map((x) => x.code) });
  const detail = violations.slice(0, 3).map((x) => x.message).join(' · ');
  return {
    success: false,
    attempts: MAX_ATTEMPTS,
    error: `Could not produce a file that passes the checks after ${MAX_ATTEMPTS} attempts.${detail ? ` Last failures: ${detail}` : ''}`,
    violations,
    usage,
  };
}
