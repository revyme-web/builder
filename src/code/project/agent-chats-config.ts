// agent-chats-config.ts — the agent's CHATS, in `_meta/agent-chats.json`.
//
// A chat is one conversation with the agent about one TASK. There is one agent
// for the whole project (see src/ai/agent/surface.ts), so a conversation belongs
// to the project, not to the file that happened to be open: "make a blog — the
// collection and the page" starts in the CMS, continues on the canvas, and is
// one chat. Before this the transcript was keyed by the ACTIVE FILE
// (`_meta/chat-history.json`), so switching page silently switched
// conversation and there was no way to start a fresh one.
//
// Lives beside chat-history.json rather than inside it on purpose: that file's
// writer PRUNES every key that is not an existing project path (its GC for
// deleted surfaces), which a chat id is not — and it still serves the chats
// that remain per-file (plugins, icon sets).
//
// `_meta/` is editor metadata: it rides the normal project save and is excluded
// from export / publish by prefix, so this never ships in the user's site.
//
// WHICH chat is open is NOT stored here. This file is shared with teammates;
// the chat one person has open is their own business, like their selection.

import { trace } from '@/shared/debug-trace';
import { parseChatHistory, type StoredChatMessage } from './chat-history-config';

export const AGENT_CHATS_FILE_PATH = '_meta/agent-chats.json';

/** Chats kept, newest first by last activity. The file is rewritten on every
 *  save; a conversation nobody has touched in forty chats is not coming back. */
export const MAX_AGENT_CHATS = 40;

/**
 * Only the most recently active chats keep their PICTURES (canvas screenshots,
 * pasted-image thumbnails). Each chat already budgets its own images, but forty
 * chats × that budget is megabytes riding every save for thumbnails nobody
 * scrolls back to. Older chats keep every word.
 */
export const CHATS_KEEPING_IMAGES = 3;

const TITLE_MAX = 42;
export const NEW_CHAT_TITLE = 'New chat';

export interface AgentChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredChatMessage[];
}

export interface AgentChatsFile {
  version: 1;
  chats: AgentChat[];
}

/**
 * A chat's name, from the first thing the user asked for: "create a header
 * component" → "Create a header component". First line only, trimmed to a
 * word boundary. An image-only opener has no words to name it by.
 */
export function chatTitleFrom(firstUserText: string | null | undefined, hasImages = false): string {
  const line = (firstUserText ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return hasImages ? 'Image' : NEW_CHAT_TITLE;
  const clean = line.replace(/\s+/g, ' ');
  const cased = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (cased.length <= TITLE_MAX) return cased;
  const cut = cased.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The title a list of messages gives a chat. */
export function titleForMessages(messages: readonly StoredChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  return chatTitleFrom(first?.content, !!first?.images?.length);
}

/** `now` · `5m` · `3h` · `2d` · `6w` · `4mo` · `2y` — how long since a chat was
 *  last active, in the space a menu row's trailing slot has. */
export function relativeAge(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function newestFirst(chats: readonly AgentChat[]): AgentChat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Drop the pictures from one chat's messages — every word stays. */
function withoutImages(messages: StoredChatMessage[]): StoredChatMessage[] {
  return messages.map((m) => {
    const { images: _images, ...rest } = m;
    if (!rest.blocks) return rest;
    return {
      ...rest,
      blocks: rest.blocks.map((b) => (b.kind === 'tools'
        ? { ...b, tools: b.tools.map(({ image: _image, ...tool }) => tool) }
        : b)),
    };
  });
}

/** Apply both bounds: how many chats, and which of them keep pictures. */
export function boundChats(chats: readonly AgentChat[]): AgentChat[] {
  return newestFirst(chats)
    .slice(0, MAX_AGENT_CHATS)
    .map((chat, i) => (i < CHATS_KEEPING_IMAGES ? chat : { ...chat, messages: withoutImages(chat.messages) }));
}

/**
 * Parse the file. Defensive in the same way as parseChatHistory, and THROUGH
 * it: each chat's messages go through that parser's sanitizer (roles, blocks,
 * image data URLs), so a hand-edited file costs history, never the panel.
 */
export function parseAgentChats(json: string | null): AgentChatsFile {
  const empty: AgentChatsFile = { version: 1, chats: [] };
  if (!json) return empty;
  try {
    const parsed = JSON.parse(json) as { chats?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.chats)) return empty;
    const seen = new Set<string>();
    const chats: AgentChat[] = [];
    for (const raw of parsed.chats as Record<string, unknown>[]) {
      if (!raw || typeof raw !== 'object') continue;
      const id = typeof raw.id === 'string' ? raw.id : '';
      if (!id || seen.has(id)) continue;
      const messages = parseChatHistory(JSON.stringify({ x: raw.messages ?? [] })).x ?? [];
      if (messages.length === 0) continue;   // a chat is its messages
      seen.add(id);
      const updatedAt = Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : 0;
      chats.push({
        id,
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : titleForMessages(messages),
        createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : updatedAt,
        updatedAt,
        messages,
      });
    }
    return { version: 1, chats };
  } catch (err) {
    trace.error('agent-chats-config:parse-failed', err);
    return empty;
  }
}

export function serializeAgentChats(file: AgentChatsFile): string {
  return JSON.stringify({ version: 1, chats: file.chats }, null, 2);
}

/**
 * Which per-file histories become chats on first run. Pages, design and code
 * components, and the old CMS assistant's per-collection transcripts all belong
 * to the one agent now. Everything else in that file still has a live per-file
 * reader (plugins, icon sets) and stays where it is.
 */
export function isAgentOwnedHistoryKey(path: string): boolean {
  return path.startsWith('app/') || path.startsWith('components/') || /^cms\/[^/]+\.schema\.json$/.test(path);
}
