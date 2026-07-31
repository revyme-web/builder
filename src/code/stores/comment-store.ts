// comment-store.ts — Atoms + ops for canvas comments.
//
// Source of truth = `_meta/comments.json` in ProjectFS (see
// `comments-config.ts`). Atoms below are READ-ONLY derivations of that
// file — every mutation routes through `commentOps`, which calls the
// shared `writeComments` helper to update the file (which then bumps
// `projectVersionAtom`, refreshing the read atoms).
//
// Why not store the comments array directly in an atom? Because then the
// canvas-state snapshot wouldn't include comments, and any "save the
// project" code path (LocalBackend, RevymeBackend) would have to know
// about a separate atom. Keeping comments in ProjectFS means they
// piggyback on the existing project-save mechanism for free.

import { atom, getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { projectVersionAtom, projectFS } from '@/code/project/project-fs';
import { bumpProjectVersion } from '@/code/project/modify-file';
import {
  COMMENTS_FILE_PATH,
  parseComments,
  serializeComments,
  type Comment,
  type CommentMessage,
} from '@/code/project/comments-config';
import { trace } from '@/shared/debug-trace';

export type { Comment, CommentMessage };

// ─── Read atoms ────────────────────────────────────────────────────────────

/** All comments across the project, parsed from `_meta/comments.json`.
 *  Re-derives whenever `projectVersionAtom` ticks (same dependency
 *  shape `activeRulerGuidesAtom` uses). */
export const allCommentsAtom = atom<Comment[]>((get) => {
  get(projectVersionAtom);
  return parseComments(projectFS.readFile(COMMENTS_FILE_PATH));
});

/** Comments scoped to the currently active file (page / component
 *  master / icon-set master). The canvas marker layer reads this. */
export const activeFileCommentsAtom = atom<Comment[]>((get) => {
  const all = get(allCommentsAtom);
  const filePath = get(activeFilePathAtom);
  return all.filter((c) => c.filePath === filePath);
});

/** Currently selected comment id (the one whose chat panel is open).
 *  Session-only — selection doesn't persist across reloads. */
export const selectedCommentIdAtom = atom<string | null>(null);

/** Currently editing comment id (the one whose initial-text input is
 *  active). Session-only. */
export const editingCommentIdAtom = atom<string | null>(null);

/** Comment mode toggle — flipped by the bottom-toolbar comment button.
 *  When true: cursor switches, click on canvas creates a new comment,
 *  the right panel switches to the comments-list view. Mutually
 *  exclusive with frame/text/shape creator modes (the toolbar handles
 *  the toggle-off when those are picked). */
export const commentModeActiveAtom = atom<boolean>(false);

// ─── Internal write helper ─────────────────────────────────────────────────

/** Mutate `_meta/comments.json` via a transform function and bump the
 *  project version so subscribers re-read. Mirrors the `modifyProjectFile`
 *  pattern but specialized for the JSON file (no need to round-trip
 *  through code parsing — just JSON). */
function writeComments(transform: (current: Comment[]) => Comment[]): Comment[] {
  const current = parseComments(projectFS.readFile(COMMENTS_FILE_PATH));
  const next = transform(current);
  projectFS.writeFile(COMMENTS_FILE_PATH, serializeComments(next));
  bumpProjectVersion();
  return next;
}

// ─── ID generators (same shape as builder) ─────────────────────────────────

const generateCommentId = () =>
  `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const generateMessageId = () =>
  `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ─── Default user (single-player mode) ─────────────────────────────────────
// In cloud / multi-user mode, `userInfo` is supplied from the auth
// session. Local mode falls back to a generic "You" so attribution
// still works on every comment without forcing the user to sign in.

interface UserInfo {
  id?: string;
  name?: string;
  avatar?: string;
}

const DEFAULT_USER: Required<Pick<UserInfo, 'id' | 'name'>> = {
  id: 'local-user',
  name: 'You',
};

function resolveAuthor(userInfo?: UserInfo): {
  authorId: string;
  authorName: string;
  authorAvatar?: string;
} {
  return {
    authorId: userInfo?.id ?? DEFAULT_USER.id,
    authorName: userInfo?.name ?? DEFAULT_USER.name,
    authorAvatar: userInfo?.avatar,
  };
}

// ─── Operations ────────────────────────────────────────────────────────────

export const commentOps = {
  /** Add a comment at canvas-space (x, y) on the current active file.
   *  Returns the new id. The new comment auto-selects + enters edit mode
   *  so the inline-text input opens for the user to type their first
   *  message. */
  addComment(x: number, y: number, userInfo?: UserInfo): string {
    const id = generateCommentId();
    const filePath = getDefaultStore().get(activeFilePathAtom);
    const author = resolveAuthor(userInfo);
    const createdAt = Date.now();

    const newComment: Comment = {
      id,
      x,
      y,
      text: '',
      createdAt,
      resolved: false,
      filePath,
      messages: [],
      ...author,
    };

    writeComments((current) => [...current, newComment]);

    const store = getDefaultStore();
    store.set(selectedCommentIdAtom, id);
    store.set(editingCommentIdAtom, id);

    trace.action('comment:add', { id, filePath, x, y });
    return id;
  },

  /** Remove a comment by id. Clears selection if it was the selected one. */
  removeComment(commentId: string): void {
    writeComments((current) => current.filter((c) => c.id !== commentId));

    const store = getDefaultStore();
    if (store.get(selectedCommentIdAtom) === commentId) {
      store.set(selectedCommentIdAtom, null);
      store.set(editingCommentIdAtom, null);
    }
    trace.action('comment:remove', { id: commentId });
  },

  /** Remove all comments tied to a file path. Called by
   *  `active-file-store.deletePage` so deleting a page doesn't leave
   *  orphan comments in `_meta/comments.json`. */
  removeCommentsForFilePath(filePath: string): void {
    writeComments((current) => current.filter((c) => c.filePath !== filePath));
    trace.action('comment:remove-for-file', { filePath });
  },

  /** Update the initial-text field. Also bootstraps `messages` with the
   *  first message when the comment was created with empty text (matches
   *  the builder's `updateCommentText` behavior). */
  updateCommentText(commentId: string, text: string, userInfo?: UserInfo): void {
    writeComments((current) =>
      current.map((c) => {
        if (c.id !== commentId) return c;
        const needsBootstrapMessage = !c.messages || c.messages.length === 0;
        const author = resolveAuthor(userInfo);
        const messages = needsBootstrapMessage
          ? [{
              id: generateMessageId(),
              text,
              authorId: userInfo?.id ?? c.authorId ?? author.authorId,
              authorName: userInfo?.name ?? c.authorName ?? author.authorName,
              authorAvatar: userInfo?.avatar ?? c.authorAvatar,
              createdAt: Date.now(),
            }]
          : c.messages;
        return { ...c, text, messages };
      }),
    );
    trace.action('comment:update-text', { id: commentId, len: text.length });
  },

  /** Append a reply to a comment's thread. */
  addReply(commentId: string, text: string, userInfo?: UserInfo): void {
    const author = resolveAuthor(userInfo);
    const newMessage: CommentMessage = {
      id: generateMessageId(),
      text,
      ...author,
      createdAt: Date.now(),
    };
    writeComments((current) =>
      current.map((c) =>
        c.id === commentId
          ? { ...c, messages: [...(c.messages ?? []), newMessage] }
          : c,
      ),
    );
    trace.action('comment:add-reply', { id: commentId, len: text.length });
  },

  /** Update the bubble color (hex from the 10-color palette). */
  updateCommentColor(commentId: string, color: string): void {
    writeComments((current) =>
      current.map((c) => (c.id === commentId ? { ...c, color } : c)),
    );
    trace.action('comment:color', { id: commentId, color });
  },

  /** Update canvas-space position. Drag uses skipHistory=true mid-drag
   *  (the file still updates each frame so other windows / collaborators
   *  see the move live) — kept for parity with the builder API even
   *  though Revyme has no separate undo-history flush yet. */
  updateCommentPosition(
    commentId: string,
    x: number,
    y: number,
    _skipHistory = false,
  ): void {
    writeComments((current) =>
      current.map((c) => (c.id === commentId ? { ...c, x, y } : c)),
    );
  },

  /** Toggle resolved flag. Resolved comments dim out of the canvas
   *  marker layer and the right-panel list (until the user opts in to
   *  "show resolved"). */
  toggleResolved(commentId: string): void {
    writeComments((current) =>
      current.map((c) =>
        c.id === commentId ? { ...c, resolved: !c.resolved } : c,
      ),
    );
    trace.action('comment:toggle-resolved', { id: commentId });
  },

  /** Select a comment (opens its chat panel). Pass null to deselect. */
  selectComment(commentId: string | null): void {
    const store = getDefaultStore();
    store.set(selectedCommentIdAtom, commentId);
    if (!commentId) store.set(editingCommentIdAtom, null);
  },

  /** Open the inline first-message input for a comment. */
  startEditing(commentId: string): void {
    const store = getDefaultStore();
    store.set(selectedCommentIdAtom, commentId);
    store.set(editingCommentIdAtom, commentId);
  },

  /** Close the inline first-message input. */
  stopEditing(): void {
    getDefaultStore().set(editingCommentIdAtom, null);
  },

  /** Delete the currently selected comment (Backspace shortcut). */
  deleteSelectedComment(): void {
    const id = getDefaultStore().get(selectedCommentIdAtom);
    if (id) commentOps.removeComment(id);
  },

  /** Wipe every comment in the project. */
  clearAllComments(): void {
    writeComments(() => []);
    const store = getDefaultStore();
    store.set(selectedCommentIdAtom, null);
    store.set(editingCommentIdAtom, null);
    trace.action('comment:clear-all');
  },
};

/** Color palette mirrored from the builder's marker context menu. The
 *  blue is the default when a comment is created without a color. */
const COMMENT_COLOR_PALETTE: readonly string[] = [
  '#3b82f6', // blue (default)
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
  '#6366f1', // indigo
] as const;

export const DEFAULT_COMMENT_COLOR = COMMENT_COLOR_PALETTE[0];
