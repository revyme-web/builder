// PageChat.tsx — AI chat for normal pages, hosted in the bottom sheet.
//
// Renders inside `AIChatSheet` (a drag-resizable bottom panel) when the
// BottomToolbar's AI button has opened it (`aiChatSheetOpenAtom`).
// Returns null when the sheet is closed.
//
// Drives the page-agent: a browser-side agentic loop that calls semantic
// mutation tools routed through the real mutation queue. Mutations land
// on the canvas live during the loop — there's nothing to "apply" on
// completion.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeFilePathAtom, getFileDisplayName, isComponentFilePath } from '@/code/project/active-file-store';
import { getChatHistory, saveChatHistory } from '@/code/stores/chat-history-store';
// Type-only: old chat histories persist page-agent usage/toolCallLog stamps —
// the Message shape (and its rendering below) must keep understanding them.
import type { PageAgentResult } from '@/ai/page-agent/page-agent-client';
import { refreshCredits, getCreditsState, isOutOfCreditsError } from '@/code/stores/credits-store';
import OutOfCreditsCard from './ui/OutOfCreditsCard';
import {
  aiChatSheetOpenAtom, aiChatDetachedAtom, detachAiChatAtom, dockAiChatAtom,
  vibeModelAtom, setVibeModelAtom,
} from '@/code/stores/editor-store';
import {
  fetchVibeModels, groupByVendor, vibeModelLabel, FALLBACK_MODELS,
  type VibeModel,
} from '@/ai/vibe-models';
import { createPortal } from 'react-dom';
import { leftPanelAtom } from '@/code/stores/left-panel-store';
import { userAtom, userToAuthor } from '@/backend/user-store';
import { trace } from '@/shared/debug-trace';
import CreditsIndicator from './CreditsIndicator';
import AIChatSheet from './AIChatSheet';
import VibeDockShell from './VibeDockShell';
import ChatUserMessage from './ChatUserMessage';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  usage?: PageAgentResult['usage'];
  toolCallLog?: PageAgentResult['toolCallLog'];
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

/** Animated loader shown next to the live tool-status text. */
function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3 shrink-0 text-[var(--accent-text)]" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export default function PageChat() {
  const activeFilePath = useAtomValue(activeFilePathAtom);
  // The freeform loop drives pages AND design-component masters — word the
  // UI for whichever surface is active.
  const surfaceNoun = isComponentFilePath(activeFilePath) ? 'component' : 'page';
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
  /** Live tool activity for the current turn — shown while the loop runs. */
  const [activity, setActivity] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Vibe model select: persisted OpenRouter slug ('' = server default). The
  // catalog comes from the AI service (static mirror until it answers).
  const vibeModel = useAtomValue(vibeModelAtom);
  const setVibeModel = useSetAtom(setVibeModelAtom);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<VibeModel[]>(FALLBACK_MODELS);
  // Portal placement: the menu renders into document.body (the docked panel
  // clips overflow and --control-bg is translucent) — fixed coords anchored
  // to the chip, opening UPWARD, capped to the space above it.
  const modelChipRef = useRef<HTMLButtonElement>(null);
  const [modelMenuPos, setModelMenuPos] = useState({ left: 0, bottom: 0, maxH: 300 });
  // Always-current active path for the freeform isStillActive guard — the
  // closure in handleSend captures the path at send time; this ref tells the
  // loop whether the user has since switched files.
  const activePathRef = useRef(activeFilePath);
  activePathRef.current = activeFilePath;

  trace.fn('PageChat.render', { activeFilePath, messages: messages.length, loading });

  // Load this surface's saved chat history when the active file changes.
  useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setMessages(getChatHistory(activeFilePath));
    setPrompt('');
    setLoading(false);
    setActivity('');
    trace.action('page-chat:load-history-on-file-switch', { activeFilePath });
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

  // Auto-scroll to bottom — on new messages/activity, when the panel
  // (re)opens, AND when it detaches/docks (the messages div re-mounts into
  // the new shell, so it must be re-scrolled). Always lands on the latest.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activity, open, detached]);

  // Focus the input when the panel opens — so the user can type straight
  // after clicking the VIBE icon (and again when a detach/dock re-mounts it).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, detached]);

  // Refresh the model catalog from the AI service when the panel opens —
  // cached per session; the static fallback renders until it lands.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchVibeModels().then(({ models }) => {
      if (alive) setModelCatalog(models);
    });
    return () => { alive = false; };
  }, [open]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
    setActivity('');
    trace.action('page-chat:stop');
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    trace.action('page-chat:send', { prompt: trimmed, activeFilePath });

    const conversationHistory = messages.map(m => ({ role: m.role, content: m.content }));

    // Stamp the sender so a teammate's messages keep their identity.
    const author = userToAuthor(currentUser);
    setMessages(prev => [...prev, {
      role: 'user', content: trimmed,
      authorId: author.id, authorName: author.name, authorAvatar: author.avatar,
    }]);
    setPrompt('');
    setLoading(true);
    setActivity('Reading the page…');

    // ORACLE (freeform) pipeline — the ONLY Vibe pipeline: the model writes
    // the WHOLE file; the oracle (checkFile) gates it and violations bounce
    // until it passes. Handles pages AND design components. (The page-agent /
    // design-spec routes and the A/B toggle were retired 2026-07 — oracle won.)
    // Loaded LAZILY: checkFile pulls the parser, which must never load with
    // the builder shell.
    trace.action('page-chat:freeform-route', { activeFilePath });
    const kind = isComponentFilePath(activeFilePath) ? 'component' as const : 'page' as const;
    setActivity(kind === 'page' ? 'Writing the page…' : 'Writing the component…');
    const controller = new AbortController();
    abortRef.current = controller;
    const target = activeFilePath;
    import('@/ai/freeform/freeform-client')
      .then(({ runFreeformEdit }) => runFreeformEdit({
        prompt: trimmed,
        activeFilePath: target,
        kind,
        history: conversationHistory,
        workspaceId: getCreditsState()?.workspaceId,
        model: vibeModel || undefined,
        signal: controller.signal,
        isStillActive: () => activePathRef.current === target,
        onAttempt: (attempt, violations) => {
          setActivity(`Fixing ${violations.length} issue${violations.length === 1 ? '' : 's'} (attempt ${attempt + 1})…`);
        },
      }))
      .then((result) => {
        if (activePathRef.current !== target) return; // never land on another surface
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.success
            ? `${result.text || 'Updated.'}${result.attempts > 1 ? ` (passed after ${result.attempts} attempts)` : ''}`
            : (result.error || 'Could not produce a valid file.'),
          error: !result.success,
        }]);
      })
      .catch((err) => {
        if (activePathRef.current !== target) return;
        setMessages(prev => [...prev, { role: 'assistant', content: String(err?.message ?? err), error: true }]);
      })
      .finally(() => {
        if (activePathRef.current !== target) return;
        setLoading(false);
        setActivity('');
        abortRef.current = null;
        inputRef.current?.focus();
        window.setTimeout(() => { void refreshCredits(); }, 1200);
      });
  }, [prompt, loading, messages, activeFilePath, currentUser, vibeModel]);

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
              Ask AI to change this {surfaceNoun} — describe what you want and
              it edits the canvas live.
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
              ) : msg.error && isOutOfCreditsError(msg.content) ? (
                <OutOfCreditsCard key={i} />
              ) : (
                <div key={i} className="flex justify-start">
                  <div className={`max-w-[90%] cut-corners px-2.5 py-1.5 ${
                    msg.error
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-[var(--control-bg)] text-[var(--text-primary)]'
                  }`}>
                    <p className="text-[11px] leading-relaxed break-words whitespace-pre-wrap">{msg.content}</p>
                    {msg.toolCallLog && msg.toolCallLog.length > 0 && (
                      <div className="mt-1 text-[9px] opacity-60">
                        {msg.toolCallLog.length} tool call{msg.toolCallLog.length === 1 ? '' : 's'}
                        {msg.toolCallLog.some(t => t.isError) && (
                          <span className="text-red-400"> · {msg.toolCallLog.filter(t => t.isError).length} failed</span>
                        )}
                      </div>
                    )}
                    {msg.usage && (
                      <div className="flex gap-2 mt-1 text-[9px] opacity-60">
                        <span>{((msg.usage.inputTokens ?? 0) + (msg.usage.outputTokens ?? 0)).toLocaleString()} tok</span>
                        <span>{msg.usage.turns} turn{msg.usage.turns === 1 ? '' : 's'}</span>
                        {msg.usage.durationMs > 0 && <span>{(msg.usage.durationMs / 1000).toFixed(1)}s</span>}
                      </div>
                    )}
                  </div>
                </div>
              )
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-[var(--control-bg)] cut-corners px-2.5 py-1.5 flex items-center gap-1.5">
                  <Spinner />
                  <p className="text-[11px] text-[var(--text-secondary)]">{activity || 'Cooking…'}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input row — model chip is a TAB above the pill (top corners only,
          flush into the input's top-left so the input stays full-width). */}
      <div className="p-2 shrink-0">
        <div className="flex items-end">
          {/* Model select — chip opens a PORTALED upward menu (the docked
              panel clips overflow; --dropdown-bg is the solid menu surface). */}
          <button
            ref={modelChipRef}
            onClick={() => {
              const next = !modelMenuOpen;
              if (next && modelChipRef.current) {
                const r = modelChipRef.current.getBoundingClientRect();
                setModelMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 6, maxH: Math.max(120, r.top - 16) });
              }
              trace.action('page-chat:model-menu-toggle', { open: next });
              setModelMenuOpen(next);
            }}
            disabled={loading}
            title="Choose the AI model"
            className="relative z-10 -mb-px shrink-0 max-w-[140px] truncate text-[10px] leading-none px-2.5 pt-1.5 pb-[7px] rounded-t-md border border-b-0 border-[var(--border-light)] bg-[var(--control-bg)] transition-colors cursor-pointer text-[var(--text-disabled)] hover:text-[var(--text-secondary)]"
          >
            {vibeModelLabel(vibeModel || undefined, modelCatalog)}
          </button>
          {modelMenuOpen && createPortal(
            <>
              {/* Backdrop closes on press — also swallows the chip so a chip
                  press while open closes instead of instantly reopening. */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 100029 }} onMouseDown={() => setModelMenuOpen(false)} />
              <div
                style={{ position: 'fixed', left: modelMenuPos.left, bottom: modelMenuPos.bottom, maxHeight: modelMenuPos.maxH, zIndex: 100030, width: 200 }}
                className="bg-[var(--dropdown-bg)] border border-[var(--border-light)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] shadow-2xl py-1 overflow-y-auto"
              >
                {groupByVendor(modelCatalog).map((group) => (
                  <div key={group.vendor}>
                    <div className="px-2.5 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-disabled)]">{group.label}</div>
                    {group.models.map((m) => {
                      const selected = vibeModel === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => {
                            trace.action('page-chat:model-select', { model: m.id });
                            setVibeModel(m.id);
                            setModelMenuOpen(false);
                            inputRef.current?.focus();
                          }}
                          className={`w-full text-left px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2 hover:bg-[var(--control-bg-hover)] cursor-pointer ${
                            selected ? 'text-[var(--accent-text)]' : 'text-[var(--text-primary)]'
                          }`}
                        >
                          <span className="truncate">{m.label}</span>
                          <span className="text-[9px] shrink-0 text-[var(--text-disabled)]">{m.tier}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>,
            document.body,
          )}
        </div>
        <div className="flex items-center gap-2 cut-corners cut-border [--cut-border-color:var(--border-light)] rounded-tl-none border border-[var(--border-light)] px-3 py-1.5 bg-[var(--control-bg)]">
          <input
            ref={inputRef}
            type="text"
            placeholder={loading ? 'Working...' : `Ask AI to change this ${surfaceNoun}...`}
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
              title="Stop"
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
