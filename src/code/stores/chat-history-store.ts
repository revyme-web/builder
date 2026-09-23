// chat-history-store.ts — Read / write per-surface AI chat history.
//
// Source of truth: `_meta/chat-history.json` in ProjectFS (chat-history-config).
// Same pattern as comment-store — the file rides the normal project-save path,
// so no separate backend.
//
// GC: every write PRUNES orphan entries (a surface whose file no longer exists
// in ProjectFS). Deleting any surface — page, design component, vector set,
// code component, plugin — therefore drops its history on the next save, with
// no per-delete-flow hook. That hook would be a circular import anyway (it's
// exactly why comment-store's `removeCommentsForFilePath` is left unwired).

import { projectFS } from '@/code/project/project-fs';
import { bumpProjectVersion } from '@/code/project/modify-file';
import {
  CHAT_HISTORY_FILE_PATH,
  CHAT_HISTORY_CAP,
  CHAT_HISTORY_IMAGE_BUDGET,
  CHAT_HISTORY_USER_IMAGE_BUDGET,
  parseChatHistory,
  serializeChatHistory,
  type StoredChatMessage,
  type ChatHistoryMap,
} from '@/code/project/chat-history-config';
import { trace } from '@/shared/debug-trace';

export type { StoredChatMessage };

function readMap(): ChatHistoryMap {
  return parseChatHistory(projectFS.readFile(CHAT_HISTORY_FILE_PATH));
}

/** Persist the map, pruning orphan entries first, then bump the project
 *  version so the write rides the autosave/project-save path (like comments). */
function writeMap(map: ChatHistoryMap): void {
  const pruned: ChatHistoryMap = {};
  for (const [path, msgs] of Object.entries(map)) {
    if (projectFS.exists(path)) pruned[path] = msgs;
  }
  projectFS.writeFile(CHAT_HISTORY_FILE_PATH, serializeChatHistory(pruned));
  bumpProjectVersion();
}

/**
 * Drop all but the newest CHAT_HISTORY_IMAGE_BUDGET screenshots, IN PLACE.
 *
 * Walks newest-first so the captures a user might actually scroll back to are
 * the ones kept. The activity line survives either way — only the thumbnail
 * goes — so an old turn still reads correctly, just without the picture.
 */
export function budgetImages(messages: StoredChatMessage[]): void {
  let left = CHAT_HISTORY_IMAGE_BUDGET;
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks;
    if (!blocks) continue;
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.kind !== 'tools') continue;
      for (let t = block.tools.length - 1; t >= 0; t--) {
        const tool = block.tools[t];
        if (!tool.image) continue;
        if (left > 0) left--;
        else delete tool.image;
      }
    }
  }
}

/**
 * Drop all but the newest CHAT_HISTORY_USER_IMAGE_BUDGET pasted thumbnails, IN
 * PLACE — the same policy as `budgetImages`, for the user's side of the
 * transcript. The message and its text always survive.
 */
export function budgetUserImages(messages: StoredChatMessage[]): void {
  let left = CHAT_HISTORY_USER_IMAGE_BUDGET;
  for (let i = messages.length - 1; i >= 0; i--) {
    const images = messages[i].images;
    if (!images?.length) continue;
    // Within one message keep the FIRST ones: they are in paste order, and a
    // partly-kept message should still start where the user started.
    const keep = images.slice(0, left);
    left -= keep.length;
    if (keep.length > 0) messages[i].images = keep;
    else delete messages[i].images;
  }
}

/** The stored history for one surface — empty array when there is none. */
export function getChatHistory(filePath: string): StoredChatMessage[] {
  if (!filePath) return [];
  return readMap()[filePath] ?? [];
}

/** Persist a surface's history — trimmed to the last CHAT_HISTORY_CAP messages
 *  (oldest dropped). Display-only fields are stripped to the stored shape. */
export function saveChatHistory(filePath: string, messages: StoredChatMessage[]): void {
  if (!filePath) return;
  const map = readMap();
  const trimmed: StoredChatMessage[] = messages
    .map((m) => {
      // Persist text + error flag + the author stamp (user messages only);
      // display-only extras (token usage, tool-call logs) are dropped.
      const out: StoredChatMessage = { role: m.role, content: m.content };
      if (m.blocks) out.blocks = m.blocks;
      if (m.role === 'user' && m.images?.length) out.images = m.images;
      if (m.reasoning) out.reasoning = m.reasoning;
      if (m.changes?.length) out.changes = m.changes;
      if (m.error) out.error = true;
      if (m.authorId) out.authorId = m.authorId;
      if (m.authorName) out.authorName = m.authorName;
      if (m.authorAvatar) out.authorAvatar = m.authorAvatar;
      return out;
    })
    .slice(-CHAT_HISTORY_CAP);
  budgetImages(trimmed);
  budgetUserImages(trimmed);
  if (trimmed.length === 0) delete map[filePath];
  else map[filePath] = trimmed;
  writeMap(map);
  trace.action('chat-history:save', { filePath, count: trimmed.length });
}
