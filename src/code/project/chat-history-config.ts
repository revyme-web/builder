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
import type { ChangePart } from './change-parts';

/** Path of the chat-history JSON inside ProjectFS. Single global file. */
export const CHAT_HISTORY_FILE_PATH = '_meta/chat-history.json';

/** Max messages kept per surface — trimmed oldest-first on save. The whole
 *  (capped) history is what the agent receives as conversation context, so
 *  this also bounds the per-turn token cost. */
export const CHAT_HISTORY_CAP = 20;

/**
 * How many screenshots the whole history keeps, newest first.
 *
 * A canvas screenshot is a data-URL worth tens to hundreds of KB, and this file
 * is written on every save and parsed on every load. Keeping one per capture
 * would grow the project without bound for a thumbnail nobody scrolls back to.
 * Older captures keep their activity line and lose only the picture.
 */
export const CHAT_HISTORY_IMAGE_BUDGET = 6;

/**
 * How many PASTED-image thumbnails the whole history keeps, newest first.
 *
 * Only the thumbnail of a pasted image is ever stored (~20-40 KB; the copy the
 * model saw stays in memory), so this can be looser than the screenshot budget
 * — but it is still a file written on every save. Older turns keep their text
 * and lose the picture.
 */
export const CHAT_HISTORY_USER_IMAGE_BUDGET = 12;

/** One stored chat message — the minimal shape every chat surface shares.
 *  Display-only extras (token usage, tool-call logs) are NOT persisted; an
 *  edit chat's value is the conversation text, not the per-turn telemetry. */
/** One persisted tool call. Deliberately minimal — a name, whether it landed,
 *  and the numbers the transcript phrases from. The call's ARGUMENTS and the
 *  tool's RESULT are never stored: they are large, they are written for the
 *  model, and nothing on screen reads them back. */
export interface StoredToolCall {
  name: string;
  ok: boolean;
  detail?: string;
  count?: number;
  ms?: number;
  /** Why the agent made this call, if the engine streamed reasoning. */
  note?: string;
  /** A screenshot's data-URL, kept only for the most recent few (see
   *  CHAT_HISTORY_IMAGE_BUDGET) — this file rides every project save. */
  image?: string;
}

/** The chronological shape of an assistant reply, so a reload reproduces the
 *  transcript exactly rather than collapsing it to its final paragraph. */
export type StoredBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tools'; tools: StoredToolCall[] };

export interface StoredChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Thumbnails of images the user pasted with this message (data URLs).
   *  User messages only; budgeted by CHAT_HISTORY_USER_IMAGE_BUDGET. */
  images?: string[];
  /** Interleaved text and activity. Absent on user messages and on histories
   *  written before this existed — those still render from `content`. */
  blocks?: StoredBlock[];
  /** The model's collapsed deliberation. */
  reasoning?: string;
  /** What this turn changed, so its Changes card survives a reload. Paths and
   *  id lists only — small, and the counts are derived from them. */
  changes?: { path: string; addedIds?: string[]; removedIds?: string[]; changedIds?: string[]; parts?: ChangePart[] }[];
  /** True for an error reply, so it re-renders in the error style. */
  error?: boolean;
  /** Author of a `user` message — stamped from the signed-in user on send,
   *  persisted so each teammate's messages keep their identity (name +
   *  avatar) when the history is reloaded. Assistant messages have none. */
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
  /** The MCP client a request came through ("Claude Code"), for work asked
   *  for outside the builder and mirrored into this chat. */
  via?: string;
  skills?: string[];
  /** The error an assistant run ended on (see AgentTurn.error). */
  errorMessage?: string;
}

/** filePath → that surface's message history. */
export type ChatHistoryMap = Record<string, StoredChatMessage[]>;

/**
 * Drop anything in `blocks` that is not the shape the transcript renders.
 *
 * The message filter only ever checked `role` and `content`; blocks are nested
 * and would reach `b.tools.map(...)` unverified. This file is user-editable
 * JSON in the project, so a hand-edit or a truncated save must cost the
 * transcript's activity, never the panel.
 */
function sanitize(m: StoredChatMessage): StoredChatMessage {
  if (!Array.isArray(m.blocks)) {
    return { ...m, blocks: undefined, images: sanitizeImages(m.images) };
  }
  const blocks: StoredBlock[] = [];
  for (const b of m.blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.kind === 'text' || b.kind === 'reasoning') {
      if (typeof b.text === 'string') blocks.push({ kind: b.kind, text: b.text });
    } else if (b.kind === 'tools' && Array.isArray(b.tools)) {
      const tools = b.tools.filter(
        (t): t is StoredToolCall => !!t && typeof t === 'object' && typeof t.name === 'string',
      );
      if (tools.length > 0) blocks.push({ kind: 'tools', tools });
    }
  }
  const changes = Array.isArray(m.changes)
    ? m.changes.filter((c) => !!c && typeof c === 'object' && typeof c.path === 'string')
    : undefined;
  return {
    ...m,
    blocks: blocks.length > 0 ? blocks : undefined,
    changes: changes && changes.length > 0 ? changes : undefined,
    images: sanitizeImages(m.images),
  };
}

/** Only image data URLs reach an `<img src>` — this file is hand-editable. */
function sanitizeImages(images: unknown): string[] | undefined {
  if (!Array.isArray(images)) return undefined;
  const ok = images.filter((u): u is string => typeof u === 'string' && u.startsWith('data:image/'));
  return ok.length > 0 ? ok : undefined;
}

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
      ).map(sanitize);
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
