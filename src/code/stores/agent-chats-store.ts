// agent-chats-store.ts — read / write the agent's chats, and which one is open.
//
// Storage shape and the reasons for it: code/project/agent-chats-config.ts.
// Same posture as chat-history-store: the file rides the normal project save,
// so every write bumps the project version and there is no separate backend.

import { atom } from 'jotai';
import { projectFS } from '@/code/project/project-fs';
import { bumpProjectVersion } from '@/code/project/modify-file';
import {
  AGENT_CHATS_FILE_PATH, parseAgentChats, serializeAgentChats, boundChats, newestFirst,
  titleForMessages, isAgentOwnedHistoryKey, type AgentChat,
} from '@/code/project/agent-chats-config';
import {
  CHAT_HISTORY_FILE_PATH, CHAT_HISTORY_CAP, parseChatHistory, serializeChatHistory, type StoredChatMessage,
} from '@/code/project/chat-history-config';
import { budgetImages, budgetUserImages } from './chat-history-store';
import { trace } from '@/shared/debug-trace';

/**
 * The chat this person has open.
 *   undefined  not chosen yet — the first panel to mount picks the most
 *              recently active chat, so reopening the editor continues where
 *              they left off;
 *   null       a NEW chat. Nothing is stored until its first message, so
 *              pressing "+" and walking away leaves no empty rows behind;
 *   string     that chat.
 * Per session, not persisted — see the config's note.
 */
export const activeAgentChatIdAtom = atom<string | null | undefined>(undefined);

/**
 * Which chat the SHARED transcript atoms currently hold. The chat body is
 * mounted by several panels at once (the dock, the CMS panel, the component
 * editor) over ONE set of atoms — a per-instance "have I loaded yet" flag made
 * every newly opened panel reload the transcript, wiping a reply that was
 * streaming in another.
 */
export const loadedAgentChatIdAtom = atom<string | null | undefined>(undefined);

/** Ids minted this session. A chat is not in the file until its first save, so
 *  "not in the file" alone cannot tell a brand-new chat from a stale id. */
const mintedThisSession = new Set<string>();

let seq = 0;
export function newAgentChatId(): string {
  const id = `chat-${Date.now().toString(36)}-${(seq++).toString(36)}`;
  mintedThisSession.add(id);
  return id;
}

/**
 * The chat to show for a requested id. An id that is neither stored nor minted
 * this session is STALE (the project was reset under it, or the chat was pruned)
 * and resolves like "not chosen yet": the most recently active chat, else new.
 */
export function resolveAgentChatId(requested: string | null | undefined): string | null {
  if (requested === null) return null;
  const chats = listAgentChats();
  if (requested && (mintedThisSession.has(requested) || chats.some((c) => c.id === requested))) return requested;
  return chats[0]?.id ?? null;
}

function read(): AgentChat[] {
  return parseAgentChats(projectFS.readFile(AGENT_CHATS_FILE_PATH)).chats;
}

function write(chats: AgentChat[]): void {
  projectFS.writeFile(AGENT_CHATS_FILE_PATH, serializeAgentChats({ version: 1, chats: boundChats(chats) }));
  bumpProjectVersion();
}

/** Every chat, most recently active first. Read-only — safe to call in render. */
export function listAgentChats(): AgentChat[] {
  return newestFirst(read());
}

export function getAgentChat(id: string | null): AgentChat | null {
  if (!id) return null;
  return read().find((c) => c.id === id) ?? null;
}

/**
 * Persist one chat's transcript. Reads the file FRESH and replaces only this
 * chat, so a teammate's chat saved a moment ago is not overwritten by a stale
 * copy of the whole list. An empty transcript is never stored.
 *
 * `updatedAt` moves only when the transcript actually changed — merely opening
 * an old chat must not float it to the top of the list.
 */
export function saveAgentChat(id: string, messages: StoredChatMessage[], now: number = Date.now()): void {
  if (!id || messages.length === 0) return;
  const trimmed = messages.slice(-CHAT_HISTORY_CAP).map((m) => ({ ...m }));
  budgetImages(trimmed);
  budgetUserImages(trimmed);

  const chats = read();
  const existing = chats.find((c) => c.id === id);
  if (existing && JSON.stringify(existing.messages) === JSON.stringify(trimmed)) return;
  const next: AgentChat = existing
    ? { ...existing, messages: trimmed, updatedAt: now }
    : { id, title: titleForMessages(trimmed), createdAt: now, updatedAt: now, messages: trimmed };
  write([next, ...chats.filter((c) => c.id !== id)]);
  trace.action('agent-chats:save', { id, messages: trimmed.length, created: !existing });
}

export function deleteAgentChat(id: string): void {
  const chats = read();
  if (!chats.some((c) => c.id === id)) return;
  write(chats.filter((c) => c.id !== id));
  trace.action('agent-chats:delete', { id });
}

/**
 * ONE-TIME: turn the old per-FILE agent transcripts into chats.
 *
 * Runs only while agent-chats.json does not exist, so it can never re-import
 * (or resurrect a chat the user deleted). The migrated keys are then REMOVED
 * from chat-history.json — the transcripts moved, they were not copied: leaving
 * them would keep their screenshots riding every save with no reader left.
 */
export function migrateFileKeyedHistory(now: number = Date.now()): number {
  if (projectFS.exists(AGENT_CHATS_FILE_PATH)) return 0;
  const legacy = parseChatHistory(projectFS.readFile(CHAT_HISTORY_FILE_PATH));
  const owned = Object.keys(legacy).filter((k) => isAgentOwnedHistoryKey(k) && legacy[k].length > 0);
  if (owned.length === 0) return 0;

  const chats: AgentChat[] = owned.map((key, i) => ({
    id: newAgentChatId(),
    title: titleForMessages(legacy[key]),
    // The old file kept no timestamps. Stagger them so the list has a stable
    // order instead of forty rows all reading "now" in whatever order a sort
    // felt like.
    createdAt: now - i * 1000,
    updatedAt: now - i * 1000,
    messages: legacy[key],
  }));
  // Write the NEW file first: if anything below fails, the history exists
  // twice rather than nowhere.
  write(chats);
  const remaining = { ...legacy };
  for (const key of owned) delete remaining[key];
  projectFS.writeFile(CHAT_HISTORY_FILE_PATH, serializeChatHistory(remaining));
  trace.action('agent-chats:migrated', { chats: chats.length });
  return chats.length;
}
