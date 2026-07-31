// comments-config.ts — Project-wide comment storage in `_meta/comments.json`.
//
// Comments live in ONE file at the project root rather than inline per-page
// (the way `@rulerGuides` JSDoc lives in each page) because:
//   - the right-panel "all comments in project" list reads them all in one go
//     instead of scanning every page,
//   - threaded messages with author/avatar/timestamp would bloat each page's
//     JSX diff, and
//   - cross-page comment moves don't have to surgery two files.
//
// Each comment carries a `filePath` so it stays scoped to its page (or
// component master / icon-set master) just like ruler guides do — the
// canvas only renders comments matching the active file. When a page is
// deleted, the active-file-store calls `removeCommentsForFilePath` to GC
// the orphaned entries.
//
// Persistence path: when ProjectFS is saved (LocalBackend → localStorage,
// RevymeBackend → cloud DB), `_meta/comments.json` rides along like every
// other project file. No separate "comment backend" needed for v1.

import { trace } from '@/shared/debug-trace';

/** Path of the comments JSON file inside ProjectFS. Single global file. */
export const COMMENTS_FILE_PATH = '_meta/comments.json';

/** A single message inside a comment thread. */
export interface CommentMessage {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  authorAvatar?: string;
  /** Unix ms timestamp. */
  createdAt: number;
}

/** A comment thread anchored to a canvas position on a specific page /
 *  component master / icon-set master. `filePath` plays the same scoping
 *  role `page` does in the builder repo. */
export interface Comment {
  id: string;
  /** Canvas-space coordinate. Survives canvas pan/zoom. */
  x: number;
  y: number;
  /** Quick-preview text (mirrors first message body — kept for the
   *  right-panel list so we don't have to walk `messages` to render). */
  text: string;
  /** Unix ms timestamp of creation. */
  createdAt: number;
  /** Resolved comments are dimmed and filtered out of the default list view. */
  resolved?: boolean;
  /** Background bubble color (hex). Picked from a 10-color palette in
   *  the marker context menu; falls back to `#3b82f6` (blue) when unset. */
  color?: string;
  /** ProjectFS path of the file this comment belongs to. The canvas only
   *  renders comments matching `activeFilePathAtom`. */
  filePath: string;
  /** Reserved for component-instance-level scoping (e.g., a comment
   *  pinned to one instance of a Card on the homepage). Unused in v1. */
  componentId?: string;
  /** Threaded messages (always at least the initial post). */
  messages?: CommentMessage[];
  /** Initial-author info — duplicated on each message too, kept here for
   *  list rendering without walking the thread. */
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
}

/** Parse the comments file. Returns empty array on missing/malformed —
 *  same defensive posture `parseRulerGuides` uses. Better to lose comments
 *  than crash the editor. */
export function parseComments(json: string | null): Comment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is Comment =>
      c
      && typeof c === 'object'
      && typeof c.id === 'string'
      && typeof c.x === 'number'
      && typeof c.y === 'number'
      && typeof c.filePath === 'string'
      && Number.isFinite(c.x)
      && Number.isFinite(c.y),
    );
  } catch (err) {
    trace.error('comments-config:parse-failed', err);
    return [];
  }
}

/** Pretty-print the comments array. Two-space indent matches the rest of
 *  the project's JSON (settings.json, etc.) so diffs stay readable. */
export function serializeComments(comments: Comment[]): string {
  return JSON.stringify(comments, null, 2);
}
