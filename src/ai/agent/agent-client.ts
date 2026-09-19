// agent-client.ts — start a turn and consume its event stream.
//
// POSTs to ai-generator's /api/agent/turn and reads the SSE reply. The service
// drives the model and calls back into THIS tab over the existing MCP bridge
// to run each tool, so by the time an event arrives the edit has already
// landed on the canvas.

import { getProjectId } from '@/backend/project-id';
import { trace } from '@/shared/debug-trace';
import type { AgentProviderConfig } from '@/code/stores/agent-chat-store';

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
  | { type: 'turn_changes'; changes: { path: string; addedIds?: string[]; removedIds?: string[]; changedIds?: string[] }[] }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentMessageOut {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string }[];
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
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const res = await fetch(`${AI_SERVICE_URL}/api/agent/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      websiteId: getProjectId(),
      messages: opts.messages,
      provider: opts.config.provider,
      model: opts.config.model,
      apiKey: opts.config.apiKey,
      contextBlock: opts.contextBlock,
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
