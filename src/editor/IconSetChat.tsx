// IconSetChat.tsx — AI chat for icon-set (vector set) masters, hosted in
// the bottom sheet.
//
// Renders inside `AIChatSheet` (the same drag-resizable bottom panel as
// PageChat) when the BottomToolbar's AI button has opened it. Streams code
// updates via /api/icon-set-chat/stream and applies the final code via
// modifyProjectFile() once streaming completes.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeFilePathAtom, getFileDisplayName } from '@/code/project/active-file-store';
import { getChatHistory, saveChatHistory } from '@/code/stores/chat-history-store';
import { projectFS } from '@/code/project/project-fs';
import { modifyProjectFile } from '@/code/project/modify-file';
import { checkFile } from '@/code/oracle/check-file';
import { iconSetChatStream } from '@/ai/icon-set-chat-client';
import { refreshCredits } from '@/code/stores/credits-store';
import {
  aiChatSheetOpenAtom, aiChatDetachedAtom, detachAiChatAtom, dockAiChatAtom,
} from '@/code/stores/editor-store';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { userAtom, userToAuthor } from '@/backend/user-store';
import { trace } from '@/shared/debug-trace';
import CreditsIndicator from './CreditsIndicator';
import AIChatSheet from './AIChatSheet';
import VibeDockShell from './VibeDockShell';
import ChatUserMessage from './ChatUserMessage';
import OutOfCreditsCard from './ui/OutOfCreditsCard';
import { isOutOfCreditsError } from '@/code/stores/credits-store';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  usage?: { inputTokens: number; outputTokens: number; model: string; durationMs: number };
  error?: boolean;
  /** Author stamp — user messages only. */
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
}

function SendIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

export default function IconSetChat() {
  const activeFilePath = useAtomValue(activeFilePathAtom);
  const detached = useAtomValue(aiChatDetachedAtom);
  const sheetOpen = useAtomValue(aiChatSheetOpenAtom);
  const leftPanel = useAtomValue(leftPanelAtom);
  const detach = useSetAtom(detachAiChatAtom);
  const dock = useSetAtom(dockAiChatAtom);
  const currentUser = useAtomValue(userAtom);
  // Docked in the VIBE panel vs detached into the floating popup.
  const open = detached ? sheetOpen : leftPanel === 'vibe';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamedCodeRef = useRef<string>('');

  trace.fn('IconSetChat.render', {
    activeFilePath,
    messages: messages.length,
    loading,
  });

  // Load this surface's saved chat history when the active file changes.
  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages(getChatHistory(activeFilePath));
    setPrompt('');
    setLoading(false);
    streamedCodeRef.current = '';
    trace.action('icon-set-chat:load-history-on-file-switch', { activeFilePath });
  }, [activeFilePath]);

  // Persist the (capped) history per surface — survives reload + file-switch.
  // Deps are [messages] ONLY: a surface switch changes `activeFilePath` but
  // not `messages`, and for one commit after the switch `messages` is still
  // the PREVIOUS surface's content — saving then would write it under the
  // new surface's key (cross-contaminating histories). The effect closure
  // always carries the current `activeFilePath`, so real edits save right.
  useEffect(() => {
    if (messages.length > 0) saveChatHistory(activeFilePath, messages);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom — on new messages, when the panel (re)opens, AND
  // when it detaches/docks (the messages div re-mounts into the new shell,
  // so it must be re-scrolled). Always lands on the latest message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, detached]);

  // Focus the input when the panel opens — so the user can type straight
  // after clicking the VIBE icon (and again when a detach/dock re-mounts it).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, detached]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    trace.action('icon-set-chat:stop');
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    const code = projectFS.readFile(activeFilePath) ?? '';
    if (!code) {
      trace.error('icon-set-chat:send-no-code', { activeFilePath });
      return;
    }

    trace.action('icon-set-chat:send', { prompt: trimmed, codeLen: code.length, activeFilePath });

    // Stamp the sender so a teammate's messages keep their identity.
    const author = userToAuthor(currentUser);
    setMessages(prev => [...prev, {
      role: 'user', content: trimmed,
      authorId: author.id, authorName: author.name, authorAvatar: author.avatar,
    }]);
    setPrompt('');
    setLoading(true);
    streamedCodeRef.current = '';

    const conversationHistory = messages.map(m => ({ role: m.role, content: m.content }));

    const controller = iconSetChatStream(
      {
        code,
        prompt: trimmed,
        conversationHistory,
      },
      {
        onCode: (streamedCode) => {
          streamedCodeRef.current = streamedCode;
        },
        onDone: (result) => {
          const finalCode = streamedCodeRef.current;
          if (finalCode && finalCode !== code) {
            // SYNTAX FENCE (2026-08-11): this is a whole-file replace of AI
            // output with no gate at all — a truncated/unparseable stream
            // blanked the whole icon set (the parser returns an empty node map
            // on syntax errors, silently). Icon masters have their own dialect
            // so the full oracle doesn't apply, but the file must at least
            // PARSE before it may land.
            const syntaxError = checkFile(finalCode, { kind: 'component', path: activeFilePath })
              .find((v) => v.code === 'SYNTAX_ERROR');
            if (syntaxError) {
              trace.error('icon-set-chat:apply-blocked-syntax', { filePath: activeFilePath });
              setMessages(prev => [...prev, {
                role: 'assistant',
                content: `The generated code has a syntax error and was NOT applied: ${syntaxError.message.slice(0, 200)}`,
              }]);
              setLoading(false);
              return;
            }
            trace.action('icon-set-chat:apply-code', {
              filePath: activeFilePath,
              codeLen: finalCode.length,
            });
            modifyProjectFile(activeFilePath, () => finalCode);
          }
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: result.text || 'Icon set updated',
            usage: result.usage,
          }]);
          setLoading(false);
          abortRef.current = null;
          inputRef.current?.focus();
          // Refresh the credits indicator — delayed so the generator's
          // fire-and-forget deduction has committed.
          window.setTimeout(() => { void refreshCredits(); }, 1200);
        },
        onError: (error) => {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: error,
            error: true,
          }]);
          setLoading(false);
          abortRef.current = null;
          inputRef.current?.focus();
          window.setTimeout(() => { void refreshCredits(); }, 1200);
        },
      },
    );

    abortRef.current = controller;
  }, [prompt, loading, messages, activeFilePath, currentUser]);

  const hasMessages = messages.length > 0;

  // The chat stays mounted across the docked/detached swap — detaching
  // mid-generation loses nothing.
  if (!open) return null;

  const body = (
    <>
      {/* Messages area — fills the panel between header and input row. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 scrollbar-hide"
      >
        {!hasMessages && !loading ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[11px] text-[var(--text-disabled)] text-center leading-relaxed px-6 max-w-[260px]">
              Ask AI for icons — describe a set, like "6 outline people icons".
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pb-2">
            {messages.map((msg, i) => (
              msg.role === 'user' ? (
                <ChatUserMessage
                  key={i}
                  content={msg.content}
                  authorId={msg.authorId}
                  authorName={msg.authorName}
                  authorAvatar={msg.authorAvatar}
                />
              ) : (
                msg.error && isOutOfCreditsError(msg.content) ? (
                  <OutOfCreditsCard key={i} />
                ) : (
                <div key={i} className="flex justify-start">
                  <div className={`max-w-[90%] cut-corners px-2.5 py-1.5 ${
                    msg.error
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-[var(--control-bg)] text-[var(--text-primary)]'
                  }`}>
                    <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap">{msg.content}</p>
                    {msg.usage && (
                      <div className="flex gap-2 mt-1 text-[9px] opacity-60">
                        <span>{((msg.usage.inputTokens ?? 0) + (msg.usage.outputTokens ?? 0)).toLocaleString()} tok</span>
                        <span>{msg.usage.model}</span>
                        {msg.usage.durationMs > 0 && <span>{(msg.usage.durationMs / 1000).toFixed(1)}s</span>}
                      </div>
                    )}
                  </div>
                </div>
                )
              )
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-[var(--control-bg)] cut-corners px-2.5 py-1.5">
                  <p className="text-[11px] text-[var(--text-secondary)]">Generating icons…</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input row */}
      <div className="p-2 shrink-0">
        <div className="flex items-center gap-2 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] px-3 py-1.5 bg-[var(--control-bg)]">
          <input
            ref={inputRef}
            type="text"
            placeholder={loading ? 'Generating...' : 'Ask AI for icons (e.g. "set of 6 people icons")...'}
            value={prompt}
            disabled={loading}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend(); }}
            className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none"
          />
          {loading ? (
            <button
              onClick={handleStop}
              className="w-6 h-6 cut-corners flex items-center justify-center transition-colors text-white shrink-0 bg-red-500 hover:bg-red-600 cursor-pointer"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!prompt.trim()}
              className={`w-6 h-6 cut-corners flex items-center justify-center transition-all text-[var(--accent-fg)] shrink-0 bg-[var(--accent)] ${
                !prompt.trim()
                  ? 'opacity-40 cursor-not-allowed'
                  : 'hover:brightness-110 cursor-pointer'
              }`}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </>
  );

  return detached ? (
    <AIChatSheet
      headerAccessory={<CreditsIndicator />}
      contextLabel={getFileDisplayName(activeFilePath)}
      onClose={dock}
    >
      {body}
    </AIChatSheet>
  ) : (
    <VibeDockShell
      headerAccessory={<CreditsIndicator />}
      contextLabel={getFileDisplayName(activeFilePath)}
      onDetach={detach}
    >
      {body}
    </VibeDockShell>
  );
}
