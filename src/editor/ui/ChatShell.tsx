// ChatShell.tsx — shared chat shell for the AI code-editing chats
// (ComponentChat, PluginChat): message list, single-line streaming
// input row, per-file history persistence, abort + clear.
//
// The wrappers stay thin: they supply the stream client, the copy
// (placeholders, empty state, loading label, done-fallback text),
// the trace names, and — for the component editor — the optional
// streaming/thinking side-channel callbacks.

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { useAtomValue } from 'jotai';
import { getChatHistory, saveChatHistory } from '@/code/stores/chat-history-store';
import { userAtom, userToAuthor } from '@/backend/user-store';
import ChatUserMessage from '@/editor/ChatUserMessage';
import { trace } from '@/shared/debug-trace';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  usage?: { inputTokens: number; outputTokens: number; model: string; durationMs: number };
  error?: boolean;
  /** Author stamp — user messages only. */
  authorId?: string;
  authorName?: string;
  authorAvatar?: string;
}

interface ChatShellProps {
  code: string;
  onCodeChange: (code: string) => void;
  /** File path keying the persisted chat history (null = no file open). */
  filePath: string | null;
  /** Streaming chat client (componentChatStream / pluginChatStream). */
  chatStream: (
    req: {
      code: string;
      prompt: string;
      conversationHistory: { role: 'user' | 'assistant'; content: string }[];
    },
    callbacks: {
      onCode: (code: string) => void;
      onDone: (result: {
        text: string;
        usage: { inputTokens: number; outputTokens: number; model: string; durationMs: number };
      }) => void;
      onError: (error: string) => void;
    },
  ) => AbortController;
  /** trace.action name fired on send. */
  sendTraceName: string;
  /** Optional trace.fn name fired on every render. */
  renderTraceName?: string;
  /** Optional trace.action name fired on clear. */
  clearTraceName?: string;
  /** Fallback assistant text when the stream finishes without text. */
  doneFallbackText: string;
  /** Empty-state copy (rendered inside the centered <p>). */
  emptyState: ReactNode;
  /** Label of the assistant bubble shown while generating. */
  loadingLabel: string;
  /** Input placeholder while idle. */
  idlePlaceholder: string;
  /** Input placeholder while generating. */
  loadingPlaceholder: string;
  /** Streaming side-channel (component editor's streaming atom). */
  onStreamingChange?: (streaming: boolean) => void;
  /** Thinking side-channel — cleared when the first chunk arrives. */
  onThinkingChange?: (thinking: boolean) => void;
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

export default function ChatShell({
  code, onCodeChange, filePath, chatStream,
  sendTraceName, renderTraceName, clearTraceName,
  doneFallbackText, emptyState, loadingLabel,
  idlePlaceholder, loadingPlaceholder,
  onStreamingChange, onThinkingChange,
}: ChatShellProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const currentUser = useAtomValue(userAtom);
  const receivedFirstChunkRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const codeAtSendRef = useRef(code);

  const hasMessages = messages.length > 0;

  if (renderTraceName) trace.fn(renderTraceName, { messages: messages.length, loading });

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Load this file's saved chat history when the editor opens it.
  useEffect(() => {
    setMessages(getChatHistory(filePath ?? ''));
  }, [filePath]);

  // Persist the (capped) history per file. Deps are [messages]
  // ONLY: a file switch changes `filePath` but not `messages`, and
  // for one commit after the switch `messages` is still the previous file's
  // content — saving then would write it under the new file's key.
  useEffect(() => {
    if (filePath && messages.length > 0) saveChatHistory(filePath, messages);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    onStreamingChange?.(false);
    onThinkingChange?.(false);
  }, [onStreamingChange, onThinkingChange]);

  const handleSend = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    trace.action(sendTraceName, { prompt: trimmed, codeLen: code.length });

    // Stamp the sender so a teammate's messages keep their identity.
    const author = userToAuthor(currentUser);
    setMessages(prev => [...prev, {
      role: 'user', content: trimmed,
      authorId: author.id, authorName: author.name, authorAvatar: author.avatar,
    }]);
    setPrompt('');
    setLoading(true);
    onStreamingChange?.(true);
    onThinkingChange?.(true);
    receivedFirstChunkRef.current = false;
    codeAtSendRef.current = code;

    const conversationHistory = messages.map(m => ({ role: m.role, content: m.content }));

    const controller = chatStream(
      {
        code,
        prompt: trimmed,
        conversationHistory,
      },
      {
        onCode: (streamedCode) => {
          if (!receivedFirstChunkRef.current) {
            receivedFirstChunkRef.current = true;
            onThinkingChange?.(false);
          }
          onCodeChange(streamedCode);
        },
        onDone: (result) => {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: result.text || doneFallbackText,
            usage: result.usage,
          }]);
          setLoading(false);
          onStreamingChange?.(false);
          onThinkingChange?.(false);
          abortRef.current = null;
          inputRef.current?.focus();
        },
        onError: (error) => {
          setMessages(prev => [...prev, {
            role: 'assistant',
            content: error,
            error: true,
          }]);
          setLoading(false);
          onStreamingChange?.(false);
          onThinkingChange?.(false);
          abortRef.current = null;
          inputRef.current?.focus();
        },
      },
    );

    abortRef.current = controller;
  }, [prompt, loading, messages, code, onCodeChange, currentUser, chatStream, sendTraceName, doneFallbackText, onStreamingChange, onThinkingChange]);

  const handleClear = useCallback(() => {
    handleStop();
    setMessages([]);
    if (clearTraceName) trace.action(clearTraceName);
  }, [handleStop, clearTraceName]);

  return (
    <div className="flex flex-col h-full">
      {/* Clear button — top-right, only when messages exist */}
      {hasMessages && (
        <div className="flex justify-end px-3 pt-1 shrink-0">
          <button
            onClick={handleClear}
            className="text-[10px] text-[var(--text-disabled)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
          >
            Clear
          </button>
        </div>
      )}

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3"
        style={{ scrollbarWidth: 'none' }}
      >
        {!hasMessages ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[10px] text-[var(--text-disabled)] text-center leading-relaxed px-4">
              {emptyState}
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
                  accentClass="bg-[#7C3AED]"
                />
              ) : (
                <div key={i} className="flex justify-start">
                  <div className={`max-w-[90%] rounded-lg px-2.5 py-1.5 ${
                    msg.error
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-[var(--control-bg)] text-[var(--text-primary)]'
                  }`}>
                    <p className="text-[11px] leading-relaxed break-words">{msg.content}</p>
                    {msg.usage && (
                      <div className="flex gap-2 mt-1 text-[9px] opacity-60">
                        <span>{((msg.usage.inputTokens ?? 0) + (msg.usage.outputTokens ?? 0)).toLocaleString()} tok</span>
                        <span>{msg.usage.model}</span>
                        {msg.usage.durationMs && <span>{(msg.usage.durationMs / 1000).toFixed(1)}s</span>}
                      </div>
                    )}
                  </div>
                </div>
              )
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-[var(--control-bg)] rounded-lg px-2.5 py-1.5">
                  <p className="text-[11px] text-[var(--text-secondary)]">{loadingLabel}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="p-2 shrink-0">
        <div className="flex items-center gap-2 rounded-lg border border-[var(--border-light)] px-3 py-1.5 bg-[var(--control-bg)]">
          <input
            ref={inputRef}
            type="text"
            placeholder={loading ? loadingPlaceholder : idlePlaceholder}
            value={prompt}
            disabled={loading}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend(); }}
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none"
          />
          {loading ? (
            <button
              onClick={handleStop}
              className="w-6 h-6 rounded-md flex items-center justify-center transition-colors text-white shrink-0 bg-red-500 hover:bg-red-600 cursor-pointer"
              title="Stop generating"
            >
              <StopIcon />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!prompt.trim()}
              className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors text-white shrink-0 ${
                !prompt.trim()
                  ? 'bg-[#7C3AED]/40 cursor-not-allowed'
                  : 'bg-[#7C3AED] hover:bg-[#9333EA] cursor-pointer'
              }`}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
