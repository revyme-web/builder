// agent-client.ts — start a turn and consume its event stream.
//
// POSTs to ai-generator's /api/agent/turn and reads the SSE reply. The service
// drives the model and calls back into THIS tab over the existing MCP bridge
// to run each tool, so by the time an event arrives the edit has already
// landed on the canvas.

import { getProjectId } from '@/backend/project-id';
import { getCreditsState } from '@/code/stores/credits-store';
import { trace } from '@/shared/debug-trace';
import { providerNeedsKey, type AgentProviderConfig } from '@/code/stores/agent-chat-store';
import type { ChangePart } from '@/code/project/change-parts';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; label: string }
  | { type: 'tool_result'; id: string; ok: boolean; content: string; image?: string }
  | { type: 'usage'; usage: Record<string, number> }
  // Carries the per-file id diffs, not just the path: the Changes card counts
  // layers, and narrowing to `{path}` here threw away numbers the service had
  // already computed.
  | { type: 'turn_changes'; changes: { path: string; addedIds?: string[]; removedIds?: string[]; changedIds?: string[]; parts?: ChangePart[] }[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentMessageOut {
  role: 'user' | 'assistant';
  /** `image` is a base64 data URL and rides USER messages only — the same
   *  block the service's providers already convert (agent/types.ts). */
  content: ({ type: 'text'; text: string } | { type: 'image'; dataUrl: string })[];
}

/**
 * Stream one turn. Yields every event as it arrives.
 *
 * The SSE body is parsed by hand rather than with EventSource because
 * EventSource cannot POST — and the turn needs a body (messages, key, model).
 */
export async function* streamAgentTurn(opts: {
  messages: AgentMessageOut[];
  config: AgentProviderConfig;
  contextBlock?: string;
  /** Which panel the user is in, and the manual that goes with it. The
   *  DESCRIPTION of the surface is in `contextBlock`; this is the part the
   *  service acts on (it owns the manuals). See surface.ts. */
  surface?: { kind: string; skill: string | null };
  /** The model's thinking effort (agentEffortAtom) — nothing = its default. */
  reasoning?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${AI_SERVICE_URL}/api/agent/turn`, {
    method: 'POST',
    // The session cookie: on Revyme cloud the service checks this user may
    // edit the project and bills the project's own workspace.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      websiteId: getProjectId(),
      // The workspace Revyme credits are billed to (cloud); absent locally.
      workspaceId: getCreditsState()?.workspaceId,
      messages: opts.messages,
      provider: opts.config.provider,
      model: opts.config.model,
      // Only a pasted-key engine sends it — the stored key stays behind when
      // the model select switches to credits or the CLI.
      apiKey: providerNeedsKey(opts.config.provider) ? opts.config.apiKey : undefined,
      contextBlock: opts.contextBlock,
      surface: opts.surface,
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    let message = `The agent service answered ${res.status}.`;
    try {
      const j = await res.json() as { error?: string };
      if (j?.error) message = j.error;
    } catch { /* not JSON — keep the status message */ }
    trace.error('agent-client:start-failed', { status: res.status, message });
    yield { type: 'error', message };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a chunk can split one, so
      // keep the tail until its terminator arrives.
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(5).trim()) as AgentEvent;
        } catch {
          trace.error('agent-client:bad-frame', { frame: frame.slice(0, 120) });
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * The engines the AI service runs the agent on (see agentEnginesAtom), or
 * `null` when the service could not be REACHED — a different answer from
 * "it runs none": a local service that is restarting (or was killed) comes
 * back, and the chat must unblock when it does (it read "unreachable" as
 * "no engines" and stayed blocked on "Open settings first", 2026-09-23).
 */
export async function fetchAgentEngines(): Promise<AgentProviderConfig['provider'][] | null> {
  try {
    const res = await fetch(`${AI_SERVICE_URL}/api/agent/engines`);
    if (!res.ok) return null;
    const body = await res.json() as { engines?: unknown };
    return Array.isArray(body.engines) ? body.engines.filter((e): e is AgentProviderConfig['provider'] => typeof e === 'string') : [];
  } catch {
    return null;
  }
}
