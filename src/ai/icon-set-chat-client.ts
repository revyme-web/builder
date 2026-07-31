// icon-set-chat-client.ts — API client for AI-powered ICON SET editing.
// Streams the full updated file code via SSE from POST /api/icon-set-chat/stream.

import { trace } from '@/shared/debug-trace';

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8082';

export interface IconSetChatRequest {
  code: string;
  prompt: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string }[];
}

interface IconSetChatResponse {
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
  onDone: (result: { text: string; usage: IconSetChatResponse['usage'] }) => void;
  onError: (error: string) => void;
}

/**
 * Stream icon-set chat. Returns an AbortController so the caller can cancel.
 */
export function iconSetChatStream(req: IconSetChatRequest, callbacks: StreamCallbacks): AbortController {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  trace.action('icon-set-chat:stream-start', {
    promptLen: req.prompt.length,
    codeLen: req.code.length,
    historyLen: req.conversationHistory.length,
  });

  (async () => {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/api/icon-set-chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: req.code,
          prompt: req.prompt,
          conversationHistory: req.conversationHistory,
        }),
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
              trace.action('icon-set-chat:stream-done', {
                model: event.usage?.model,
                durationMs: event.usage?.durationMs,
              });
              callbacks.onDone({ text: event.text, usage: event.usage });
            } else if (event.type === 'error') {
              callbacks.onError(event.error);
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        callbacks.onError('Request timed out');
      } else {
        trace.error('icon-set-chat:stream-error', err);
        callbacks.onError(err.message ?? 'Stream failed');
      }
    } finally {
      clearTimeout(timeout);
    }
  })();

  return controller;
}
