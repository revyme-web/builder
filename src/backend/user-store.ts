// user-store.ts — Jotai atom for the authenticated user.

import { atom } from 'jotai';
import type { RevymeUser } from './types';

export const userAtom = atom<RevymeUser | null>(null);

/** A message author — who typed a chat message. Mirrors the comment system's
 *  author stamp so AI-chat messages carry the same identity. */
export interface ChatAuthor {
  id: string;
  name: string;
  avatar?: string;
}

/** Fallback author when no one is signed in (offline / local mode) — matches
 *  the comment store's DEFAULT_USER. */
const LOCAL_AUTHOR: ChatAuthor = { id: 'local-user', name: 'You' };

/** Map the signed-in user to a message-author stamp. */
export function userToAuthor(user: RevymeUser | null): ChatAuthor {
  if (!user) return LOCAL_AUTHOR;
  return { id: user.id, name: user.name || user.email, avatar: user.image };
}
