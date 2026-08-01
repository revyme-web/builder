// Comments.tsx — Canvas comment markers + edit popup + chat popup mount.
//
// Renders one bubble per comment in the active file (filtered by the
// `activeFileCommentsAtom` derivation). When comment mode is active, a
// click on the canvas places a new comment at the cursor's canvas-space
// position and opens its inline first-message input. Selecting an
// existing bubble opens the chat popup (`CommentChatPopup`).
//
// All bubbles are `position: fixed` in window-coords because the
// 280-px-wide edit popup + chat panel can extend past the canvas
// container's edge — clipping them inside the container would break
// long threads. The window-coord conversion uses the bridge's
// `getIframeOffset` (the iframe's screen rect's top-left), the same
// origin that `findNodeRect` returns rects in.
//
// Pixel-matched to `builder/src/builder/view/canvas/Comments.tsx`:
// 24×24 rounded-full bubble with white speech-icon, scale-110 hover,
// white ring on selection, 280-px input popup, right-click delete menu.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { transformManager } from '@/canvas/transform';
import { getIframeOffset } from '@/canvas/drag/helpers/coords';
import {
  activeFileCommentsAtom,
  commentModeActiveAtom,
  commentOps,
  selectedCommentIdAtom,
  editingCommentIdAtom,
  DEFAULT_COMMENT_COLOR,
  type Comment,
} from '@/code/stores/comment-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { activeFilePathAtom, isComponentFilePath } from '@/code/project/active-file-store';
import { useSetAtom } from 'jotai';
import { CommentBubbleIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import CommentChatPopup from './CommentChatPopup';
import { userAtom } from '@/backend/user-store';

/** Map the auth-session user to the comment store's `UserInfo` shape.
 *  Returns undefined in local mode so the store falls back to its
 *  generic "You" author. `name || email` guards an empty name. */
function currentUserInfo(
  user: { id: string; name: string; email: string; image?: string } | null,
): { id: string; name: string; avatar?: string } | undefined {
  if (!user) return undefined;
  return { id: user.id, name: user.name || user.email, avatar: user.image };
}

// ─── transform subscription ────────────────────────────────────────────────
// Same pattern `RulerGuides.tsx` uses — subscribe imperative changes
// from `transformManager` so bubbles re-render on pan/zoom without
// going through the slower `displayTransformAtom` path.
function useTransform() {
  const [t, setT] = useState(transformManager.getTransform());
  useEffect(() => transformManager.subscribe(() => setT(transformManager.getTransform())), []);
  return t;
}

// ─── Single bubble ─────────────────────────────────────────────────────────

interface CommentBubbleProps {
  comment: Comment;
  isSelected: boolean;
  isEditing: boolean;
  transform: { x: number; y: number; scale: number };
  /** True when the active file is a component master. On masters the
   *  default bubble color switches to the secondary (purple) accent so
   *  it matches the component-identity color used everywhere else. */
  isComponentMaster: boolean;
}

const CommentBubble: React.FC<CommentBubbleProps> = ({
  comment,
  isSelected,
  isEditing,
  transform,
  isComponentMaster,
}) => {
  // Signed-in user — stamped as the author when this comment's first
  // message is bootstrapped from the inline editor.
  const user = useAtomValue(userAtom);
  const [localText, setLocalText] = useState(comment.text);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Drag state. `dragStartRef` holds the gesture's anchors so the
  // mousemove handler can compute deltas without closure issues; the
  // 5-px threshold prevents a steady click from being mis-read as a
  // drag (matches the builder).
  const dragStartRef = useRef<{ x: number; y: number; commentX: number; commentY: number } | null>(null);
  const isDraggingRef = useRef(false);
  const justDraggedRef = useRef(false);

  // Explicit per-comment color wins; otherwise the default depends on
  // context — secondary (purple) accent on component masters, primary
  // (blue) accent on regular pages.
  const bubbleColor = comment.color
    || (isComponentMaster ? 'var(--accent-secondary)' : DEFAULT_COMMENT_COLOR);

  // Canvas → window-coord conversion. iframeOffset = iframe's screen
  // rect's top-left (= canvas content origin in window space). At
  // canvas-x = v: window-x = iframeOffset.x + v * scale + transform.x.
  const iframeOffset = getIframeOffset();
  const screenX = comment.x * transform.scale + transform.x + iframeOffset.x;
  const screenY = comment.y * transform.scale + transform.y + iframeOffset.y;

  // Focus the input as soon as the comment enters edit mode. Pulled
  // out of the render so the autofocus doesn't fire on every keystroke
  // (controlled input → re-render every keystroke).
  useEffect(() => {
    if (isEditing && inputRef.current) inputRef.current.focus();
  }, [isEditing]);

  // Sync localText with the underlying comment text when we leave edit
  // mode — so reopening the comment shows the latest persisted text.
  useEffect(() => {
    if (!isEditing) setLocalText(comment.text);
  }, [comment.text, isEditing]);

  // Close the context menu on outside click.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [contextMenu]);

  const handleBubbleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // The click event fires AFTER mouseup, so a finished drag would
    // also trigger this — skip in that case so dropping the bubble
    // doesn't toggle selection.
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      return;
    }
    if (isSelected) {
      commentOps.selectComment(null);
    } else {
      commentOps.selectComment(comment.id);
    }
  }, [comment.id, isSelected]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      commentX: comment.x,
      commentY: comment.y,
    };

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.x;
      const dy = ev.clientY - dragStartRef.current.y;
      // 5-px hysteresis so a steady click isn't read as a drag.
      if (!isDraggingRef.current && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDraggingRef.current = true;
      }
      if (isDraggingRef.current) {
        const t = transformManager.getTransform();
        const newX = dragStartRef.current.commentX + dx / t.scale;
        const newY = dragStartRef.current.commentY + dy / t.scale;
        commentOps.updateCommentPosition(comment.id, newX, newY, true);
      }
    };

    const onUp = () => {
      if (isDraggingRef.current) {
        justDraggedRef.current = true;
      }
      isDraggingRef.current = false;
      dragStartRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [comment.id, comment.x, comment.y]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = localText.trim();
    if (trimmed) commentOps.updateCommentText(comment.id, trimmed, currentUserInfo(user));
    commentOps.stopEditing();
  }, [comment.id, localText, user]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      // ESC on an empty new comment → delete it (the user cancelled
      // before typing). Otherwise just close the input. Same behaviour
      // the builder has via the global key handler — handled here
      // because the input swallows the keydown otherwise.
      if (!localText.trim()) {
        commentOps.removeComment(comment.id);
      } else {
        setLocalText(comment.text);
        commentOps.stopEditing();
      }
    }
  }, [comment.id, comment.text, handleSubmit, localText]);

  return (
    <div
      data-comment-bubble
      style={{
        position: 'fixed',
        left: screenX,
        top: screenY,
        zIndex: 9998,
        pointerEvents: 'auto',
      }}
    >
      {/* Bubble — 24×24 rounded-full, scale-110 hover/selected, white
          ring on selection. Pixel-matched to the builder. */}
      <div
        data-comment-bubble
        onMouseDown={handleMouseDown}
        onClick={handleBubbleClick}
        onContextMenu={handleContextMenu}
        className={`w-6 h-6 rounded-full flex items-center justify-center cursor-pointer transition-all ${
          isSelected ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-transparent' : 'hover:scale-110'
        }`}
        style={{
          boxShadow: isSelected
            ? `0 2px 12px ${isComponentMaster ? 'rgba(154, 102, 255, 0.5)' : 'rgba(59, 130, 246, 0.5)'}`
            : '0 2px 8px rgba(0, 0, 0, 0.3)',
          backgroundColor: bubbleColor,
        }}
      >
        <CommentBubbleIcon className="w-[14px] h-[14px] text-white pointer-events-none" />
      </div>

      {/* Right-click → "Delete Comment" — same dropdown styling as the
          ruler-guide context menu. */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          data-comment-bubble
          className="fixed py-2 min-w-[160px] bg-[var(--dropdown-bg,var(--bg-surface))] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)]"
          style={{ left: contextMenu.x, top: contextMenu.y, zIndex: 99999 }}
        >
          <div
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commentOps.removeComment(comment.id);
              setContextMenu(null);
            }}
            className="group flex items-center gap-3 mx-1.5 px-2 py-2 cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--accent)]"
          >
            <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] flex-1">
              Delete Comment
            </span>
            <span className="text-[10px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)] ml-8">⌫</span>
          </div>
        </div>
      )}

      {/* Chat popup — visible while the comment is selected but NOT in
          first-message edit mode. The 280-px inline input below covers
          the edit case; the popup covers the read-and-reply case. */}
      {isSelected && !isEditing && (
        <CommentChatPopup
          comment={comment}
          screenX={screenX}
          screenY={screenY}
          onClose={() => commentOps.selectComment(null)}
        />
      )}

      {/* 280-px first-message input — visible while a brand-new comment
          is in edit mode. Reply-thread input lives in the chat popup,
          not here. */}
      {isEditing && (
        <div
          data-comment-bubble
          className="absolute left-8 top-1/2 -translate-y-1/2 flex items-center gap-2 bg-[var(--dropdown-bg,var(--bg-surface))] border border-[var(--border-light)] rounded-lg shadow-[var(--shadow-lg)] px-3 py-2"
          style={{ width: 280, animation: 'commentFadeIn 0.15s ease-out' }}
          onClick={(e) => e.stopPropagation()}
        >
          <style>{`
            @keyframes commentFadeIn {
              from { opacity: 0; transform: translateY(-50%) scale(0.97); }
              to   { opacity: 1; transform: translateY(-50%) scale(1); }
            }
          `}</style>
          <input
            ref={inputRef}
            type="text"
            value={localText}
            onChange={(e) => setLocalText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add a comment..."
            className="flex-1 bg-transparent border-none outline-none text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] font-sans"
          />
          <button
            data-comment-bubble
            onClick={handleSubmit}
            disabled={!localText.trim()}
            className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors flex-shrink-0 ${
              localText.trim()
                ? 'bg-[var(--accent)] hover:brightness-110 text-[var(--accent-fg)]'
                : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)]'
            }`}
            style={{ cursor: localText.trim() ? 'pointer' : 'not-allowed', border: 'none' }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width={12} height={12} viewBox="0 0 24 24" style={{ pointerEvents: 'none' }}>
              <path fill="currentColor" d="M19.5 2.001a3.5 3.5 0 0 1 3.03 5.249l-7.5 12.99a3.5 3.5 0 0 1-6.411-.842l-1.5-5.595l8.77-5.064a1 1 0 0 0-1-1.732L6.12 12.07L2.026 7.975A3.5 3.5 0 0 1 4.5 2z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Top-level component ───────────────────────────────────────────────────

export default function Comments() {
  const transform = useTransform();
  const comments = useAtomValue(activeFileCommentsAtom);
  const selectedId = useAtomValue(selectedCommentIdAtom);
  const editingId = useAtomValue(editingCommentIdAtom);
  const commentMode = useAtomValue(commentModeActiveAtom);
  const setSelectedNodeIds = useSetAtom(selectedIdsAtom);
  // Component masters give comment bubbles the secondary (purple)
  // accent — matches the component-identity color used in layers /
  // selection so the canvas reads consistently as "you're in a master".
  const activeFile = useAtomValue(activeFilePathAtom);
  const isComponentMaster = isComponentFilePath(activeFile);

  // Track refs so listeners (registered once on mount) read the latest
  // values without re-binding on every selection change.
  const selectedRef = useRef(selectedId);
  const editingRef = useRef(editingId);
  const justClosedRef = useRef(false);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { editingRef.current = editingId; }, [editingId]);

  // Signed-in user, via ref — the canvas-click listener below is bound
  // once on mount and reads the latest user without re-binding.
  const user = useAtomValue(userAtom);
  const userRef = useRef(user);
  useEffect(() => { userRef.current = user; }, [user]);

  // Click-on-canvas to place a comment, gated on comment mode. We
  // attach to `document` (not the canvas container) so the listener
  // also fires when iframe events bubble up via the parent's pointer-
  // events:none on the iframe. The target check filters out clicks
  // on existing bubbles, panels, and any UI chrome.
  useEffect(() => {
    if (!commentMode) return;

    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Skip clicks on existing bubbles / their popups / context menus.
      if (target.closest('[data-comment-bubble]')) return;
      // Skip clicks outside the canvas viewport (toolbars, panels, etc).
      if (!target.closest('[data-canvas-viewport]')) return;

      // Just-closed flag: avoid creating a comment on the same click
      // that closed an existing one (mousedown deselects, then click
      // would create unless we early-return).
      if (justClosedRef.current) {
        justClosedRef.current = false;
        return;
      }

      if (selectedRef.current || editingRef.current) {
        commentOps.selectComment(null);
        justClosedRef.current = true;
        return;
      }

      // Convert window cursor → canvas-space.
      const t = transformManager.getTransform();
      const off = getIframeOffset();
      const x = (e.clientX - off.x - t.x) / t.scale;
      const y = (e.clientY - off.y - t.y) / t.scale;
      // Clear node selection so the new comment doesn't compete with
      // a still-highlighted node selection in other panels.
      setSelectedNodeIds([]);
      const id = commentOps.addComment(x, y, currentUserInfo(userRef.current));
      trace.action('comment:place-via-canvas-click', { id, x, y });
    };

    // setTimeout 100ms so the click that flipped comment mode ON
    // doesn't get re-captured by this same listener.
    const tid = window.setTimeout(() => {
      document.addEventListener('click', onClick);
    }, 100);

    return () => {
      window.clearTimeout(tid);
      document.removeEventListener('click', onClick);
    };
  }, [commentMode, setSelectedNodeIds]);

  // Click outside any comment / its popup / the right panel → deselect.
  // If the comment was empty (a brand-new placement abandoned without
  // typing), delete it instead of leaving an empty bubble around.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-comment-bubble]')) return;
      if (target.closest('[data-comment-panel]')) return; // right-panel chat list

      if (selectedRef.current) {
        if (editingRef.current) {
          // The comment-store doesn't track text live, so we can't
          // peek at it from a ref — the store ops handle both cases
          // (commit empty → keep, ESC → delete). For mouse-elsewhere
          // we just stop editing and rely on the in-bubble ESC handler
          // for the empty-delete case. Avoids cross-cutting state here.
          commentOps.stopEditing();
        }
        commentOps.selectComment(null);
        justClosedRef.current = true;
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Backspace/Delete deletes the selected comment (only when not
  // editing — input swallows the key). ESC deselects, or exits comment
  // mode if no comment is selected. Mirrors the builder's keymap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;

      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedRef.current && !editingRef.current) {
        e.preventDefault();
        commentOps.deleteSelectedComment();
      } else if (e.key === 'Escape') {
        if (editingRef.current) {
          commentOps.stopEditing();
        } else if (selectedRef.current) {
          commentOps.selectComment(null);
        }
        // Note: we don't toggle commentMode off here — that's handled
        // by the bottom-toolbar shortcut (Ctrl+Alt+C). ESC inside the
        // canvas gives a softer affordance: bubble closes first.
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Clear selection when leaving comment mode so re-entering doesn't
  // immediately re-open a previously-selected comment.
  useEffect(() => {
    if (!commentMode) commentOps.selectComment(null);
  }, [commentMode]);

  // Don't render bubbles when comment mode is off — the builder does
  // the same. Keeps the canvas clean during normal editing.
  if (!commentMode) return null;

  return (
    <>
      {comments.map((c) => (
        <CommentBubble
          key={c.id}
          comment={c}
          isSelected={selectedId === c.id}
          isEditing={editingId === c.id}
          transform={transform}
          isComponentMaster={isComponentMaster}
        />
      ))}
      {/* Crosshair cursor on the canvas while comment mode is active —
          standard "you're about to drop something" affordance. */}
      <style>{`[data-canvas-viewport] { cursor: crosshair !important; }`}</style>
    </>
  );
}
