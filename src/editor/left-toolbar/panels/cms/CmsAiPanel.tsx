// CmsAiPanel.tsx — AI assistant side panel for the CMS editor overlay.
//
// Docked chat surface that visually mirrors the left-menu Vibe panel
// (VibeDockShell header + PageChat body). It drives the CMS agent
// (runCmsAgent) — a browser-side agentic loop whose tools edit the active
// collection's schema and items through cms-ops. History persists per
// collection (keyed by the schema file path, so it's pruned when the
// collection is deleted).

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { cmsEditorCollectionAtom } from '@/code/stores/cms-editor-store';
import { getChatHistory, saveChatHistory, type StoredChatMessage } from '@/code/stores/chat-history-store';
import { runCmsAgent } from '@/ai/cms-agent/cms-agent-client';
import { userAtom, userToAuthor } from '@/backend/user-store';
import { refreshCredits } from '@/code/stores/credits-store';
import { trace } from '@/shared/debug-trace';
import CreditsIndicator from '@/editor/CreditsIndicator';
import ChatUserMessage from '@/editor/ChatUserMessage';

// ─── Icons ───────────────────────────────────────────────────────────────────

/** Sparkle glyph — used by the overlay header's panel toggle. */
export function SparkleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.4l1.85 6.3 6.3 1.85-6.3 1.85L12 18.7l-1.85-6.3L3.85 10.55l6.3-1.85L12 2.4z" />
      <path d="M18.5 3l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3L15.5 6l2.3-.7.7-2.3z" opacity=".6" />
    </svg>
  );
}

/** Paper-plane send glyph — identical to PageChat's composer. */
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

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3 shrink-0 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Live-activity label ─────────────────────────────────────────────────────

/** Friendly per-turn status from the tool names the agent just called. */
function cmsTurnLabel(names: string[]): string {
  if (names.includes('create_collection')) return 'Creating the collection…';
  if (names.includes('add_item')) return 'Adding items…';
  if (names.includes('add_field')) return 'Adding fields…';
  if (names.some(n => n.startsWith('update'))) return 'Updating…';
  if (names.some(n => n.startsWith('remove') || n.startsWith('delete'))) return 'Removing…';
  if (names.some(n => n.startsWith('get') || n.startsWith('list'))) return 'Reading the CMS…';
  return 'Working…';
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export default function CmsAiPanel({ collectionName, onClose }: {
  collectionName?: string;
  onClose: () => void;
}) {
  const activeSlug = useAtomValue(cmsEditorCollectionAtom);
  const currentUser = useAtomValue(userAtom);
  // History rides the project save path; key it by the collection's schema
  // file so it's auto-pruned when the collection is deleted.
  const historyKey = activeSlug ? `cms/${activeSlug}.schema.json` : '';

  const [messages, setMessages] = useState<StoredChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [activity, setActivity] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  trace.fn('CmsAiPanel.render', { activeSlug, messages: messages.length, loading });

  // Load this collection's saved history when the collection changes.
  useEffect(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setMessages(getChatHistory(historyKey));
    setPrompt('');
    setLoading(false);
    setActivity('');
  }, [historyKey]);

  // Persist (capped) history. Deps are [messages] ONLY — a collection switch
  // changes historyKey but not messages, and for one commit after the switch
  // `messages` is still the PREVIOUS collection's content; saving then would
  // cross-contaminate. The closure always carries the current historyKey.
  useEffect(() => {
    if (messages.length > 0) saveChatHistory(historyKey, messages);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to the latest message / activity.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, activity]);

  // Focus the composer on mount.
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleStop = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setLoading(false);
    setActivity('');
    trace.action('cms-ai-panel:stop');
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    trace.action('cms-ai-panel:send', { prompt: trimmed, activeSlug });
    const history = messages.map(m => ({ role: m.role, content: m.content }));
    const author = userToAuthor(currentUser);

    setMessages(prev => [...prev, {
      role: 'user', content: trimmed,
      authorId: author.id, authorName: author.name, authorAvatar: author.avatar,
    }]);
    setPrompt('');
    setLoading(true);
    setActivity('Reading the CMS…');

    abortRef.current = runCmsAgent(
      { prompt: trimmed, history },
      {
        onTurn: ({ toolCalls }) => setActivity(cmsTurnLabel(toolCalls.map(t => t.name))),
        onDone: (result) => {
          setMessages(prev => [...prev, { role: 'assistant', content: result.text || 'Done.' }]);
          setLoading(false);
          setActivity('');
          abortRef.current = null;
          inputRef.current?.focus();
          window.setTimeout(() => { void refreshCredits(); }, 1200);
        },
        onError: (error) => {
          setMessages(prev => [...prev, { role: 'assistant', content: error, error: true }]);
          setLoading(false);
          setActivity('');
          abortRef.current = null;
          inputRef.current?.focus();
          window.setTimeout(() => { void refreshCredits(); }, 1200);
        },
      },
    );
  }, [prompt, loading, messages, activeSlug, currentUser]);

  const hasMessages = messages.length > 0;

  return (
    <div className="w-[260px] shrink-0 border-l border-[var(--border-light)] bg-[var(--bg-surface)] flex flex-col">
      {/* Header — mirrors VibeDockShell. */}
      <div className="relative shrink-0 flex items-center justify-between px-3 h-9 select-none border-b border-[var(--border-light)]">
        <div className="flex items-center gap-1.5 leading-none min-w-0">
          <span className="text-xs font-semibold text-[var(--text-primary)] shrink-0">Vibe</span>
          {collectionName && (
            <span className="text-[11px] text-[var(--text-secondary)] truncate" title={collectionName}>
              – {collectionName}
            </span>
          )}
          <span className="shrink-0"><CreditsIndicator /></span>
        </div>
        <button
          onClick={onClose}
          title="Hide AI panel"
          className="w-6 h-6 flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
          style={{ border: 'none' }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Body — messages + composer, mirrors PageChat. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 scrollbar-hide">
          {!hasMessages && !loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-[11px] text-[var(--text-disabled)] text-center leading-relaxed px-6 max-w-[260px]">
                Ask AI to shape this collection — build its schema or generate
                content, e.g. "create a 10-article blog".
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
                  <div key={i} className="flex justify-start">
                    <div className={`max-w-[90%] rounded-lg px-2.5 py-1.5 ${
                      msg.error
                        ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                        : 'bg-[var(--control-bg)] text-[var(--text-primary)]'
                    }`}>
                      <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  </div>
                )
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-[var(--control-bg)] rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                    <Spinner />
                    <p className="text-[11px] text-[var(--text-secondary)]">{activity || 'Cooking…'}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="p-2 shrink-0">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--border-light)] px-3 py-1.5 bg-[var(--control-bg)]">
            <input
              ref={inputRef}
              type="text"
              placeholder={loading ? 'Working...' : 'Ask AI about this collection...'}
              value={prompt}
              disabled={loading}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleSend(); }}
              className="flex-1 min-w-0 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-disabled)] outline-none"
            />
            {loading ? (
              <button
                onClick={handleStop}
                title="Stop"
                className="w-6 h-6 rounded-md flex items-center justify-center transition-colors text-white shrink-0 bg-red-500 hover:bg-red-600 cursor-pointer"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!prompt.trim()}
                className={`w-6 h-6 rounded-md flex items-center justify-center transition-all text-[var(--accent-fg)] shrink-0 bg-[var(--accent)] ${
                  !prompt.trim() ? 'opacity-40 cursor-not-allowed' : 'hover:brightness-110 cursor-pointer'
                }`}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
