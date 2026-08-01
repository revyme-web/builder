// CommentChatPopup.tsx — Floating thread panel for the selected comment.
//
// Mounted by `Comments.tsx` when `selectedCommentIdAtom` matches a
// rendered bubble and the comment is NOT in first-message edit mode
// (the inline 280-px input handles that case). Renders a compact 320×400
// chat panel anchored to the bubble — flips to the bubble's left side
// when it would otherwise overflow the viewport.
//
// v1 ports the messages list + reply textarea exactly. The builder's
// emoji picker + @mention picker are GATED ON COLLAB and intentionally
// omitted here — they pull from `useCollaborationSafe()`, which the
// open-source Revyme doesn't have. They'll be added back when
// collaboration lands; the data model already carries the per-message
// authorId/authorName/authorAvatar fields for that.
//
// All styling pixel-matched to `builder/.../Comments.tsx > CommentChatPopup`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAtomValue } from 'jotai';
import {
  commentOps,
  DEFAULT_COMMENT_COLOR,
  type Comment,
  type CommentMessage,
} from '@/code/stores/comment-store';
import { userAtom } from '@/backend/user-store';
import { useCollaboratorColors, resolveCollaboratorAvatar } from '@/code/stores/collaborator-colors-store';

/** Map the auth-session user to the comment store's `UserInfo` shape.
 *  Returns undefined in local mode (no signed-in user) so the store
 *  falls back to its generic "You" author. `name || email` guards
 *  against an empty name string. */
function currentUserInfo(
  user: { id: string; name: string; email: string; image?: string } | null,
): { id: string; name: string; avatar?: string } | undefined {
  if (!user) return undefined;
  return { id: user.id, name: user.name || user.email, avatar: user.image };
}

// ─── Local helpers ─────────────────────────────────────────────────────────

const POPUP_WIDTH = 320;
const POPUP_MAX_HEIGHT = 400;
const VIEWPORT_MARGIN = 16;

/** "Just now" / "5m ago" / "2h ago" / "3d ago". Same scale the builder
 *  uses — keeps timestamps glanceable without dragging in date-fns. */
function formatTimestamp(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ─── Props + component ─────────────────────────────────────────────────────

interface Props {
  comment: Comment;
  /** Bubble's window-coord screen position — used for the smart-flip
   *  positioning math (ideal: right of bubble; flips to left when the
   *  popup would overflow the viewport). */
  screenX: number;
  screenY: number;
  onClose: () => void;
}

export default function CommentChatPopup({ comment, screenX, screenY, onClose }: Props) {
  const [replyText, setReplyText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // The signed-in user — drives both the author stamped on new replies
  // and the `isMine` check that right-aligns own messages.
  const user = useAtomValue(userAtom);
  const currentUserId = user?.id ?? 'local-user';
  // Per-website collaborator colors — each message's avatar fallback
  // uses the AUTHOR's chosen color (recolors live when the owner
  // changes it). Profile picture still wins over color.
  const collaboratorColors = useCollaboratorColors();

  // Build the visible messages list. If the comment was created via the
  // legacy text-only path (no `messages` array), synthesize a single
  // entry from `comment.text` so legacy data still renders without the
  // user seeing an empty thread.
  const messages: CommentMessage[] = useMemo(() => {
    if (comment.messages && comment.messages.length > 0) return comment.messages;
    if (!comment.text) return [];
    return [{
      id: `msg-initial-${comment.id}`,
      text: comment.text,
      authorId: comment.authorId ?? 'local-user',
      authorName: comment.authorName ?? 'You',
      authorAvatar: comment.authorAvatar,
      createdAt: comment.createdAt,
    }];
  }, [comment.id, comment.text, comment.messages, comment.authorId, comment.authorName, comment.authorAvatar, comment.createdAt]);

  // Auto-scroll to the latest message on every thread update — same
  // behaviour as a normal chat client. `behavior: 'smooth'` is fine
  // for short threads; on very long threads the browser caps it.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Auto-focus the reply textarea when the popup opens. Tiny delay so
  // the popup is mounted + positioned before focus tries to scroll.
  useEffect(() => {
    const id = window.setTimeout(() => textareaRef.current?.focus(), 100);
    return () => window.clearTimeout(id);
  }, []);

  // Auto-resize textarea — grow up to 80px, then scroll. Uses the
  // imperative `style.height = 'auto'` trick to recompute scrollHeight
  // on every keystroke (without that the height is sticky after a
  // delete).
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 80)}px`;
  }, [replyText]);

  const handleSendReply = useCallback(() => {
    const trimmed = replyText.trim();
    if (!trimmed) return;
    // Stamp the reply with the signed-in user so the thread shows the
    // real author (name + avatar) instead of the generic "You".
    commentOps.addReply(comment.id, trimmed, currentUserInfo(user));
    setReplyText('');
    // Re-focus so the user can keep typing without clicking back in.
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [comment.id, replyText, user]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendReply();
    }
  }, [handleSendReply]);

  // Smart positioning — anchored to the right of the bubble by default,
  // flips to the left if it would overflow the viewport. Clamps top to
  // stay fully visible. Re-runs only when the bubble moves (drag) or
  // when the viewport resizes implicitly via `screenX/Y` changes.
  const position = useMemo(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    let top = screenY - POPUP_MAX_HEIGHT / 2;
    let left = screenX + 32;
    if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;
    else if (top + POPUP_MAX_HEIGHT > vh - VIEWPORT_MARGIN) top = vh - POPUP_MAX_HEIGHT - VIEWPORT_MARGIN;
    if (left + POPUP_WIDTH > vw - VIEWPORT_MARGIN) left = screenX - POPUP_WIDTH - 8;
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
    return { left, top };
  }, [screenX, screenY]);

  return createPortal(
    <div
      data-comment-bubble
      className="flex flex-col bg-[var(--dropdown-bg,var(--bg-surface))] border border-[var(--border-light)] rounded-lg shadow-[var(--shadow-lg)] overflow-hidden"
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        width: POPUP_WIDTH,
        maxHeight: POPUP_MAX_HEIGHT,
        zIndex: 9999,
        cursor: 'default',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header: message count + close button */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
        <span className="text-[12px] font-semibold text-[var(--text-primary)] font-sans">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'}
        </span>
        <button
          onClick={onClose}
          className="w-5 h-5 rounded hover:bg-[var(--bg-hover)] flex items-center justify-center transition-colors"
          style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
          title="Close"
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-[var(--text-secondary)]">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Messages list — scrolls when full. Local-user messages right-
          align with a different bubble color (mirror of the builder). */}
      <div className="flex-1 overflow-y-auto scrollbar-hide px-3 py-3" style={{ maxHeight: 280 }}>
        {messages.map((m, idx) => {
          // "Mine" = authored by the signed-in user (right-aligned,
          // shown as "You"). Everyone else's messages left-align with
          // their real name + avatar — WhatsApp-style. `local-user` is
          // the local-mode fallback id so single-player still right-
          // aligns.
          const isMine = m.authorId === currentUserId || m.authorId === 'local-user';
          // Avatar fallback color = the author's per-website collaborator
          // color (the dot the owner picked). Falls back to the comment
          // bubble color, then the default, for authors not in the
          // collaborator list (e.g. legacy data).
          const avatarColor =
            collaboratorColors.get(m.authorId)?.color || comment.color || DEFAULT_COMMENT_COLOR;
          // Resolve the avatar from LIVE data (signed-in user / seeded
          // collaborator list), not the avatar frozen on the message at
          // send time — so a profile picture added later shows up on
          // every past message by that author.
          const avatarUrl = resolveCollaboratorAvatar(collaboratorColors, m.authorId, m.authorAvatar, user);
          return (
            <div key={m.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'} ${idx > 0 ? 'mt-3 pt-3 border-t border-white/5' : ''}`}>
              <div className={`flex gap-2 max-w-[85%] ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
                {/* Avatar — image when available, else colored circle
                    with the author's first initial. */}
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden"
                  style={{ backgroundColor: avatarUrl ? 'transparent' : avatarColor }}
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt={m.authorName} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-[9px] font-semibold text-white">
                      {m.authorName.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>

                <div className={`flex flex-col min-w-0 ${isMine ? 'items-end' : 'items-start'}`}>
                  <div className={`flex items-center gap-1.5 mb-0.5 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}>
                    <span className="text-[10px] font-medium text-[var(--text-secondary)] font-sans">
                      {isMine ? 'You' : m.authorName}
                    </span>
                    <span className="text-[9px] text-[var(--text-tertiary)] opacity-50 font-sans">
                      {formatTimestamp(m.createdAt)}
                    </span>
                  </div>
                  <div
                    className={`max-w-full px-2.5 py-1.5 rounded-xl text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed font-sans text-[var(--text-primary)] ${
                      isMine
                        ? 'bg-[var(--grid-line)] rounded-tr-sm'
                        : 'bg-[var(--bg-hover)] rounded-tl-sm'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Reply input — inner card with subtle border. Enter sends,
          Shift+Enter inserts a newline (default textarea behavior). */}
      <div className="p-2">
        <div className="bg-[var(--grid-line)] rounded-lg px-3 pt-2 pb-2">
          <textarea
            ref={textareaRef}
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply..."
            className="w-full px-0 py-1 text-[13px] bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none resize-none overflow-hidden font-sans leading-[18px]"
            style={{ minHeight: 22, maxHeight: 80, cursor: 'text' }}
            rows={1}
          />
          <div className="my-2" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }} />
          <div className="flex items-center justify-end" style={{ cursor: 'default' }}>
            <button
              data-comment-bubble
              onClick={handleSendReply}
              disabled={!replyText.trim()}
              className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                replyText.trim()
                  ? 'bg-[var(--accent)] hover:brightness-110 text-[var(--accent-fg)]'
                  : 'bg-[var(--bg-hover)] text-[var(--text-tertiary)]'
              }`}
              style={{ cursor: replyText.trim() ? 'pointer' : 'not-allowed', border: 'none' }}
              title="Send"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width={12} height={12} viewBox="0 0 24 24" style={{ pointerEvents: 'none' }}>
                <path fill="currentColor" d="M19.5 2.001a3.5 3.5 0 0 1 3.03 5.249l-7.5 12.99a3.5 3.5 0 0 1-6.411-.842l-1.5-5.595l8.77-5.064a1 1 0 0 0-1-1.732L6.12 12.07L2.026 7.975A3.5 3.5 0 0 1 4.5 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
