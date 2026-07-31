// chat-history-config.ts — Per-surface AI chat history in `_meta/chat-history.json`.
//
// Mirrors comments-config.ts: ONE JSON file at the project root, a map keyed by
// the surface's ProjectFS path — page, design component, vector set, code
// component, or plugin. It rides along with the normal project save (like
// `_meta/comments.json`), so there's no separate "chat backend".
//
// `_meta/` is editor metadata and is EXCLUDED from project export / publish —
// chat history must not ship in the user's site, the same as comments.

import { trace } from '@/shared/debug-trace';

/** Path of the chat-history JSON inside ProjectFS. Single global file. */
export const CHAT_HISTORY_FILE_PATH = '_meta/chat-history.json';

/** Max messages kept per surface — trimmed oldest-first on save. The whole
 *  (capped) history is what the agent receives as conversation context, so
 *  this also bounds the per-turn token cost. */
export const CHAT_HISTORY_CAP = 20;

/** One stored chat message — the minimal shape every chat surface shares.
 *  Display-only extras (token usage, tool-call logs) are NOT persisted; an
 *  edit chat's value is the conversation text, not the per-turn telemetry. */
export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** True for an error reply, so it re-renders in the error style. */
  error?: boolean;
  /** Author of a `user` message — stamped from the signed-in user on send,
   *  persisted so each teammate's messages keep their identity (name +
   *  avatar) when the history is reloaded. Assistant messages have none. */
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
}

/** filePath → that surface's message history. */
export type ChatHistoryMap = Record<string, StoredChatMessage[]>;

/** Parse the chat-history file. Returns {} on missing/malformed — defensive,
 *  same posture as `parseComments`: better to lose history than crash. */
export function parseChatHistory(json: string | null): ChatHistoryMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ChatHistoryMap = {};
    for (const [path, msgs] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof path !== 'string' || !Array.isArray(msgs)) continue;
      out[path] = msgs.filter(
        (m): m is StoredChatMessage =>
          !!m
          && typeof m === 'object'
          && ((m as StoredChatMessage).role === 'user' || (m as StoredChatMessage).role === 'assistant')
          && typeof (m as StoredChatMessage).content === 'string',
      );
    }
    return out;
  } catch (err) {
    trace.error('chat-history-config:parse-failed', err);
    return {};
  }
}

/** Pretty-print — two-space indent matches the project's other JSON. */
export function serializeChatHistory(map: ChatHistoryMap): string {
  return JSON.stringify(map, null, 2);
}
