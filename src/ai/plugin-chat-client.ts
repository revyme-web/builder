// plugin-chat-client.ts — API client for AI-powered plugin authoring.
// Mirrors `component-chat-client.ts` exactly — different endpoint, same
// SSE-streaming protocol so the editor's Monaco fills in live as the
// model writes.

import { trace } from '@/shared/debug-trace';

// `import.meta.env` is populated by Vite at build time. The type
// declaration lives in `vite/client` (loaded transitively elsewhere
// in the app); we cast through `unknown` here for files that
// happen not to inherit that declaration in their resolution chain.
const AI_SERVICE_URL =
  (import.meta as unknown as { env?: { VITE_AI_SERVICE_URL?: string } }).env?.VITE_AI_SERVICE_URL
  || 'http://localhost:8082';

export interface PluginChatRequest {
  code: string;
  prompt: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
}

interface PluginChatResponse {
  success: boolean;
  code: string;
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    durationMs: number;
  };
}

export interface StreamCallbacks {
  onCode: (code: string) => void;
  onDone: (result: { text: string; usage: PluginChatResponse['usage'] }) => void;
  onError: (error: string) => void;
}

/**
 * Stream plugin chat — code fills into the Monaco editor live as the
 * model writes the JSON-shaped response. Returns an AbortController
 * so callers can cancel.
 */
export function pluginChatStream(req: PluginChatRequest, callbacks: StreamCallbacks): AbortController {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  trace.action('plugin-chat:stream-start', {
    promptLen: req.prompt.length,
    codeLen: req.code.length,
    historyLen: req.conversationHistory.length,
  });

  (async () => {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/plugin-chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errBody.error || `Request failed: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            if (event.type === 'code') {
              callbacks.onCode(event.code);
            } else if (event.type === 'done') {
              callbacks.onDone({ text: event.text, usage: event.usage });
            } else if (event.type === 'error') {
              callbacks.onError(event.error);
            }
          } catch {
            // Skip unparseable lines.
          }
        }
      }
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError') {
        callbacks.onError('Request timed out');
      } else {
        trace.error('plugin-chat:stream-error', { error: String(err) });
        callbacks.onError(e.message ?? 'Stream failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  })();

  return controller;
}
