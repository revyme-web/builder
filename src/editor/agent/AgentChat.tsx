// AgentChat.tsx — the conversational agent's transcript + composer.
//
// Thin on purpose. The turn loop runs in the ai-generator service and the
// tools run in this tab over the MCP bridge, so by the time an event reaches
// this component the edit is already on the canvas: what it renders is a
// record of what happened, not a request for it.
//
// Shell-agnostic: this is the BODY the VIBE surfaces host — the docked
// `VibeDockShell`, the detached `AIChatSheet`, and the CMS / component /
// plugin panels. Each shell owns its own chrome; the conversation is the
// same one everywhere, so a user learns it once.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { AgentBlock, AgentTurnImage } from '@/code/stores/agent-chat-store';
import {
  agentStatusAtom, agentErrorAtom, agentConversationAtom, agentStreamAtom,
  agentToolsAtom, agentBlocksAtom, agentReasoningAtom, agentChangedFilesAtom, effectiveAgentConfigAtom, agentEnginesAtom, agentServiceReachableAtom,
  isAgentConfiguredAtom, agentEffortAtom, effortFor, effortWire, agentQueuedRequestAtom, type AgentToolEntry, type AgentChangedFile,
} from '@/code/stores/agent-chat-store';
import { useProjectSkills, listProjectSkills } from '@/code/stores/project-skills-store';
import { invokedSkillNames } from '@/code/project/skills-config';
import { SkillMenu, SkillText, slashQueryAt, applySkillPick, matchSkills, skillSegments } from './SkillMenu';
import { settingsOverlayOpenAtom, settingsSectionAtom } from '@/code/stores/website-settings-store';
import { renderMarkdown } from './markdown';
import { countFor } from './activity';
import { ActivityList } from './ActivityCard';
import { ReasoningCard } from './ReasoningCard';
import ChangesCard from './ChangesCard';
import {
  buildAgentHistory, fileToAttachment, imageFilesFromClipboard, roomFor,
  MAX_ATTACHMENTS, type AgentAttachment,
} from './attachments';
import { streamAgentTurn, fetchAgentEngines } from '@/ai/agent/agent-client';
import { buildAgentContextBlock } from '@/ai/agent/editor-context';
import { surfaceForRequest, resolveAgentSurface, surfaceCopy } from '@/ai/agent/surface';
import { readAgentSurface } from '@/ai/agent/surface-state';
import { runBeforeAgentTurn } from '@/ai/agent/turn-hooks';
import { projectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { componentEditorFileAtom } from '@/code/stores/component-editor-store';
import { cmsEditorOpenAtom } from '@/code/stores/cms-editor-store';
import {
  activeAgentChatIdAtom, loadedAgentChatIdAtom, listAgentChats, getAgentChat, saveAgentChat, deleteAgentChat,
  migrateFileKeyedHistory, newAgentChatId, resolveAgentChatId,
} from '@/code/stores/agent-chats-store';
import { NEW_CHAT_TITLE, chatTitleFrom, relativeAge, type AgentChat as StoredAgentChat } from '@/code/project/agent-chats-config';
import { turnsFromStored, storedFromTurns, visibleBlocks } from './transcript-io';
import DropdownMenu, { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import ConfirmDialog from '@/design-system/ConfirmDialog';
import { BranchSelector, BranchCreateModal } from './BranchSwitcher';
import { ModelSelector } from './ModelSelector';
import { trace } from '@/shared/debug-trace';
import { agentRunEnd, stopExternalRun, isExternalRunActive } from '@/ai/agent/bridge-tools';
import { refreshCredits } from '@/code/stores/credits-store';


// humanizeFailure lives in ./humanize-failure (the MCP run mirror uses it
// too); re-exported for the existing importers.
import { humanizeFailure } from './humanize-failure';
export { humanizeFailure };

/** The last queued request sent (agentQueuedRequestAtom). Module-level: the
 *  chat body is mounted by several panels at once, and only ONE may send it. */
let consumedQueuedNonce = -1;

/** "." → ".." → "..." on a slow cycle. A static ellipsis reads as a frozen
 *  row; the movement is the only thing that says the run is still alive
 *  between tool calls, when nothing else on screen changes. */
function Ellipsis() {
  const [n, setN] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setN((v) => (v % 3) + 1), 420);
    return () => clearInterval(id);
  }, []);
  return <span className="inline-block w-3 text-left">{'.'.repeat(n)}</span>;
}

function BusyDots() {
  return (
    <span className="inline-flex gap-[2px] align-middle">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-[3px] w-[3px] animate-pulse rounded-full bg-current opacity-60"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/** The model's deliberation: collapsed by default, muted, and visually
 *  separate from the answer. Open it when you want to know WHY, not WHAT.
 *
 *  Now only for turns saved before the thinking got its own card in the
 *  blocks (ReasoningCard.tsx) — they carry `reasoning` but no reasoning block.
 *
 *  Only rendered when there IS reasoning. The BYOK providers stream it
 *  (`reasoning_delta`); Claude Code's headless output does NOT expose
 *  thinking content in any form — verified against 2.1.277 via the thinking
 *  block type, MAX_THINKING_TOKENS and --include-partial-messages — so on
 *  that engine this block correctly stays absent rather than showing an
 *  empty shell that never fills. */
function ThoughtBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="px-0.5">
      {/* One muted line, like an activity step — deliberately NOT a bordered
          uppercase box. Reasoning is an aside the reader can open, and giving
          it a container made the least important thing in the turn look like
          the most important. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-1.5 text-left text-[12px] leading-relaxed text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
      >
        {live && <BusyDots />}
        <span>Thought</span>
        <span className="text-[10px] text-[var(--text-disabled)]">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {text}
        </p>
      )}
    </div>
  );
}

// The run's tool calls render through ActivityCard.tsx (a bounded card that
// scrolls within itself; a capture is its own card).

/**
 * A message.
 *
 * MONOCHROME on purpose. The accent used to fill the user's bubble, which made
 * every prompt the loudest thing in a panel whose actual subject is the
 * website — and the accent is the selection colour, so it read as "this is
 * selected". Both roles now sit on neutral surfaces and the accent goes back to
 * meaning selection.
 *
 * The assistant gets NO container: its reply is the panel's main text, and
 * boxing it made a paragraph look like a notification. Only the user's prompt
 * is enclosed, which is what distinguishes the two without any colour at all.
 */
function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  if (role === 'assistant') {
    return (
      <div className="px-0.5 text-[12px] leading-relaxed text-[var(--text-prose)] break-words">
        {children}
      </div>
    );
  }
  return (
    <div className="cut-corners bg-[var(--bg-hover)]/50 px-2.5 py-1.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-[var(--text-secondary)]">
      {children}
    </div>
  );
}

/** An assistant reply is Markdown; what the USER typed is literal text and is
 *  never parsed — their asterisks are their own. */
function AssistantText({ text }: { text: string }) {
  return <Bubble role="assistant">{renderMarkdown(text)}</Bubble>;
}

/**
 * Pasted images — the composer's pending strip and a sent turn's record share
 * this. `onRemove` is what makes it the composer's: a sent message is history
 * and offers nothing to remove.
 *
 * Fixed square tiles, `object-cover`: a reference can be any aspect (a tall
 * page capture, a wide banner), and letting each set its own box would make
 * the strip jump around as images are added.
 */
function ImageStrip({ images, onRemove }: { images: readonly (AgentTurnImage & { id?: string })[]; onRemove?: (index: number) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((im, i) => (
        <div key={im.id ?? i} className="group relative h-12 w-12 shrink-0">
          <img
            src={im.thumb}
            alt={onRemove ? 'Image to send with your message' : 'Image sent with this message'}
            className="h-full w-full cut-corners border border-[var(--border-default)] object-cover"
          />
          {onRemove && (
            <button
              type="button"
              title="Remove image"
              aria-label="Remove image"
              onClick={() => onRemove(i)}
              className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-panel)] text-[11px] leading-none text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-tertiary)]">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/**
 * Which chat is open, and the way to another one or a new one.
 *
 * The LIST is read when the menu opens, never during render: this body
 * re-renders on every streamed token, and the chats file (transcripts,
 * screenshots) is not something to re-parse sixty times a second for a menu
 * that is closed.
 *
 * Disabled during a run — the reply is streaming into the transcript that is
 * loaded, and swapping it mid-flight would commit that reply to the wrong chat.
 */
function ChatSwitcher({ activeId, title, disabled, onPick, onNew, onDelete }: {
  activeId: string | null;
  title: string;
  disabled: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The menu hangs off the whole ROW (name + "+"), not the name button: that
  // is the panel's inner width, which is the width the menu should have.
  const rowRef = useRef<HTMLDivElement>(null);
  const chats: StoredAgentChat[] = useMemo(() => (open ? listAgentChats() : []), [open]);

  const items: DropdownMenuEntry[] = useMemo(() => {
    if (!open) return [];
    const now = Date.now();
    const rows: DropdownMenuEntry[] = chats.map((c) => ({
      id: c.id,
      label: c.title,
      shortcut: relativeAge(c.updatedAt, now),
      // The open chat is marked with a check, not a colour: the accent is the
      // selection colour everywhere else in the editor, and a tinted row in a
      // list of plain ones read as a warning rather than "you are here".
      trailingIcon: c.id === activeId ? <CheckIcon /> : undefined,
      onClick: () => onPick(c.id),
    }));
    if (rows.length === 0) rows.push({ id: 'none', label: 'No earlier chats', disabled: true, onClick: () => {} });
    // Only a STORED chat can be deleted; a new one has nothing to delete yet.
    if (activeId && chats.some((c) => c.id === activeId)) {
      rows.push({ type: 'separator' }, { id: 'delete', label: 'Delete this chat', onClick: () => setConfirming(true) });
    }
    return rows;
  }, [open, chats, activeId, onPick]);

  return (
    <div className="px-2 pt-2">
      <div ref={rowRef} className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={disabled}
          title={disabled ? 'Available when the agent has finished' : 'Switch chat'}
          onClick={() => setOpen((v) => !v)}
          className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 px-[var(--control-pad-x)] text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] text-[var(--text-primary)] cut-corners cut-border transition-colors focus:outline-none focus-visible:border-[var(--control-border-hover)] focus-visible:[--cut-border-color:var(--control-border-hover)] disabled:opacity-40 disabled:cursor-default"
        >
          <span className="truncate">{title}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          type="button"
          title="New chat"
          aria-label="New chat"
          disabled={disabled || !activeId}
          onClick={onNew}
          className="flex h-7 w-7 shrink-0 items-center justify-center cut-corners cut-border bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] text-[var(--text-secondary)] transition-colors enabled:hover:border-[var(--control-border-hover)] enabled:hover:[--cut-border-color:var(--control-border-hover)] enabled:hover:text-[var(--text-primary)] focus:outline-none disabled:opacity-40 disabled:cursor-default"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <DropdownMenu
        isOpen={open}
        onClose={() => setOpen(false)}
        anchorRef={rowRef}
        position="bottom-left"
        matchAnchorWidth
        hoverStyle="subtle"
        items={items}
      />
      {/* One click in a menu, and a chat has no undo — it is not part of the
          document's history. */}
      <ConfirmDialog
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); onDelete(); }}
        title="Delete this chat?"
        message={`"${title}" and its transcript will be removed for everyone on this project. What the agent built stays exactly as it is.`}
        confirmLabel="Delete chat"
        danger
      />
    </div>
  );
}

/** How tall the composer may grow before it scrolls instead (~10 lines). */
const COMPOSER_MAX_HEIGHT = 200;

/** The in-flight run's abort handle. Module-level for the same reason the chat
 *  ids are atoms: Stop has to work from whichever panel the user is looking at,
 *  not only from the one that started the run. */
let runAbort: AbortController | null = null;

export default function AgentChat() {
  const [status, setStatus] = useAtom(agentStatusAtom);
  const [error, setError] = useAtom(agentErrorAtom);
  const [conversation, setConversation] = useAtom(agentConversationAtom);
  const [stream, setStream] = useAtom(agentStreamAtom);
  const [tools, setTools] = useAtom(agentToolsAtom);
  const [liveBlocks, setLiveBlocks] = useAtom(agentBlocksAtom);
  const [reasoning, setReasoning] = useAtom(agentReasoningAtom);
  const [changed, setChanged] = useAtom(agentChangedFilesAtom);
  // What the turn runs with — the stored choice, or credits on cloud when the
  // stored one is not offered there (effectiveAgentConfig).
  const config = useAtomValue(effectiveAgentConfigAtom);
  // The chosen model's thinking effort (picked in the model select).
  const efforts = useAtomValue(agentEffortAtom);
  // Which engines the connected service runs — asked once; none when there
  // is no service (the open-source builder), and the panel says so.
  const [engines, setEngines] = useAtom(agentEnginesAtom);
  const [reachable, setReachable] = useAtom(agentServiceReachableAtom);
  // Ask until the service answers: an unreachable one (restarting, killed,
  // not started yet) is retried every few seconds and on window focus, so
  // the chat unblocks by itself the moment it is back.
  // Re-armed only when the NEED changes (answered ↔ not yet): a failed ask
  // flips `reachable` to false but must not re-run this at once — the timer
  // and window focus do the retrying.
  const needsAsk = engines === null || reachable !== true;
  useEffect(() => {
    if (!needsAsk) return;
    let live = true;
    const ask = () => {
      void fetchAgentEngines().then((e) => {
        if (!live) return;
        if (e === null) { setReachable(false); return; }
        setEngines(e);
        setReachable(true);
      });
    };
    ask();
    const timer = window.setInterval(ask, 5_000);
    window.addEventListener('focus', ask);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', ask); };
  }, [needsAsk, setEngines, setReachable]);
  const configured = useAtomValue(isAgentConfiguredAtom);
  const bump = useSetAtom(projectVersionAtom);

  const activeFile = useAtomValue(activeFilePathAtom);
  // Which panel this chat is sitting in — for its COPY only. What the agent is
  // told is read fresh at send time (readAgentSurface), never from a render.
  const componentEditorFile = useAtomValue(componentEditorFileAtom);
  const cmsOpen = useAtomValue(cmsEditorOpenAtom);
  const copy = surfaceCopy(resolveAgentSurface({
    activeFilePath: activeFile ?? null, componentEditorFile, cmsOpen,
    cmsCollection: null, cmsExpandedItem: null, cmsFocusedField: null,
  }).kind);
  // CHATS. A conversation belongs to the PROJECT and to a task, not to the file
  // that happens to be open — there is one agent, and "make a blog: the
  // collection and the page" is one conversation across two panels. Stored in
  // `_meta/agent-chats.json` (code/project/agent-chats-config.ts).
  //
  // Both ids live in ATOMS, not refs: several panels mount this body at once
  // over one transcript, and a per-instance "loaded yet?" flag made each newly
  // opened panel reload it — wiping a reply streaming in another.
  const [activeChatId, setActiveChatId] = useAtom(activeAgentChatIdAtom);
  const [loadedChatId, setLoadedChatId] = useAtom(loadedAgentChatIdAtom);
  useEffect(() => {
    // Never swap the transcript under a live run: its reply is still streaming
    // into these atoms and is committed to whatever chat is loaded when it ends.
    if (status === 'running') return;
    migrateFileKeyedHistory();                        // one-time; a no-op ever after
    const id = resolveAgentChatId(activeChatId);
    if (id !== activeChatId) { setActiveChatId(id); return; }
    if (loadedChatId === id) return;
    setLoadedChatId(id);
    setConversation(turnsFromStored(getAgentChat(id)?.messages ?? []));
    setStream('');
    setTools([]);
    setLiveBlocks([]);
    setReasoning('');
    setChanged([]);
    setError(null);
    trace.action('agent-panel:chat-loaded', { id });
  }, [activeChatId, loadedChatId, status, setActiveChatId, setLoadedChatId, setConversation, setStream, setTools, setReasoning, setChanged, setError]);

  // Persist whenever the transcript settles. Guarded on loaded === active: for
  // one render after a switch the atoms still hold the PREVIOUS chat, and
  // saving then would write chat A's transcript into chat B.
  useEffect(() => {
    if (status === 'running') return;
    if (!activeChatId || loadedChatId !== activeChatId) return;
    saveAgentChat(activeChatId, storedFromTurns(conversation));
  }, [activeChatId, loadedChatId, conversation, status]);

  // The stored title is fixed when the chat is created; a chat not stored yet
  // is named by what is being asked right now. Read on a switch or when a run
  // settles — not per render (see ChatSwitcher).
  const chatTitle = useMemo(() => {
    const stored = getAgentChat(activeChatId ?? null)?.title;
    if (stored) return stored;
    const first = conversation.find((t) => t.role === 'user');
    return first ? chatTitleFrom(first.text, !!first.images?.length) : NEW_CHAT_TITLE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChatId, loadedChatId, status, conversation.length]);

  const pickChat = useCallback((id: string) => {
    trace.action('agent-panel:chat-switch', { id });
    setActiveChatId(id);
  }, [setActiveChatId]);
  const newChat = useCallback(() => {
    trace.action('agent-panel:chat-new', {});
    setActiveChatId(null);
  }, [setActiveChatId]);
  const deleteChat = useCallback(() => {
    if (!activeChatId) return;
    trace.action('agent-panel:chat-delete', { id: activeChatId });
    deleteAgentChat(activeChatId);
    // "Not chosen" — resolves to the most recently active chat that is left,
    // or a new one. Same render as the delete, so the save effect never sees
    // the deleted chat as active and writes it back.
    setActiveChatId(undefined);
  }, [activeChatId, setActiveChatId]);

  // STICKY SCROLL. Follow the newest row while the user is already at the
  // bottom, and stop the moment they scroll up to read something — yanking
  // the view back mid-read is worse than missing a row. `nearBottom` carries a
  // few px of slack so sub-pixel layout never reads as "scrolled away".
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  // THE COMPOSER GROWS WITH WHAT IS TYPED. It was a fixed two rows, so a real
  // request — a few sentences — scrolled out of its own box after the second
  // line and had to be written blind. Two rows at rest, growing to a cap, then
  // scrolling; measured from the element because only the browser knows how the
  // text wrapped.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // No layout (a hidden panel, a test DOM) reports 0 — leave the rows to size it.
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    if (mirrorRef.current) mirrorRef.current.scrollTop = el.scrollTop;
  }, [input]);
  const [attachNote, setAttachNote] = useState<string | null>(null);
  // The `/` skill menu (SkillMenu.tsx): the query being typed at the caret,
  // and the highlighted row.
  const skills = useProjectSkills();
  const [slash, setSlash] = useState<{ query: string; start: number } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMatches = slash ? matchSkills(skills, slash.query) : [];
  // Open on a bare "/" even with no skills yet (it points to Settings); once
  // letters are typed, only while something matches — "/tmp" is not a menu.
  const slashOpen = !!slash && (slash.query === '' || slashMatches.length > 0);
  // Skill commands in the draft show as badges (SkillMenu SkillText): a
  // layer under the text box draws the text, the box's own glyphs go
  // transparent. Only while the draft HAS a command — plain typing stays a
  // plain text box.
  const skillNames = skills.map((k) => k.name);
  const draftHasSkill = skillSegments(input, skillNames).some((seg) => seg.skill);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const readSlash = (el: HTMLTextAreaElement) => {
    const next = slashQueryAt(el.value, el.selectionStart ?? el.value.length);
    setSlash((prev) => (prev?.query === next?.query && prev?.start === next?.start ? prev : next));
    if (next?.query !== slash?.query) setSlashIndex(0);
  };
  const pickSkill = (name: string) => {
    const el = composerRef.current;
    if (!el || !slash) return;
    const next = applySkillPick(input, el.selectionStart ?? input.length, slash.start, name);
    setInput(next.text);
    setSlash(null);
    trace.action('agent-panel:skill-picked', { name });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); });
  };
  const setSettingsOpen = useSetAtom(settingsOverlayOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const manageSkills = () => {
    setSlash(null);
    setSettingsSection('skills');
    setSettingsOpen(true);
  };
  const [creatingBranch, setCreatingBranch] = useState(false);

  useEffect(() => {
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // PASTE AN IMAGE. Only a paste that IS an image is taken over — text pastes
  // (including the ones that carry a rendered bitmap beside the text) fall
  // through to the textarea untouched; see imageFilesFromClipboard.
  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(e.clipboardData);
    if (files.length === 0) return;
    e.preventDefault();
    const room = roomFor(attachments.length);
    const taken = files.slice(0, room);
    trace.action('agent-panel:paste-image', { pasted: files.length, taken: taken.length });
    setAttachNote(files.length > room ? `Up to ${MAX_ATTACHMENTS} images per message.` : null);
    if (taken.length === 0) return;
    void Promise.all(taken.map(fileToAttachment)).then((made) => {
      const ok = made.filter((a): a is AgentAttachment => !!a);
      if (ok.length < made.length) setAttachNote('That image could not be read.');
      // Re-check the room at commit time: two quick pastes both measured it
      // against the same stale count.
      if (ok.length > 0) setAttachments((cur) => [...cur, ...ok.slice(0, roomFor(cur.length))]);
    });
  }, [attachments.length]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((cur) => cur.filter((_, i) => i !== index));
    setAttachNote(null);
  }, []);

  // `override`: a request queued from outside the chat (Settings → Skills) —
  // sent as is, leaving whatever the user is typing (and attaching) alone.
  const send = useCallback(async (override?: string) => {
    const fromDraft = override === undefined;
    const text = (override ?? input).trim();
    if ((!text && (!fromDraft || attachments.length === 0)) || status === 'running') return;

    const images: AgentTurnImage[] = fromDraft ? attachments.map(({ full, thumb, width, height }) => ({ full, thumb, width, height })) : [];
    // Skills the message names with /name ride this turn's context.
    const invoked = invokedSkillNames(text, listProjectSkills());
    const history = buildAgentHistory(conversation, { text, images });
    stick.current = true;   // sending is an explicit "show me"
    // A NEW chat becomes a real one with its first message. Mark it loaded in
    // the same breath, or the load effect would "open" it — empty — over this
    // very message.
    if (!activeChatId) {
      const id = newAgentChatId();
      setLoadedChatId(id);
      setActiveChatId(id);
    }
    setConversation((c) => [...c, { role: 'user', text, ...(images.length > 0 ? { images } : {}), ...(invoked.length > 0 ? { skills: invoked } : {}) }]);
    if (fromDraft) {
      setInput('');
      setAttachments([]);
      setAttachNote(null);
    }
    setSlash(null);
    setStream('');
    setTools([]);
    setLiveBlocks([]);
    setReasoning('');
    setChanged([]);
    setError(null);
    setStatus('running');

    const ac = new AbortController();
    runAbort = ac;
    let assistantText = '';
    let runReasoning = '';
    const runTools: AgentToolEntry[] = [];
    // Wall time per call, closed out when its result lands. The service does
    // not timestamp events, and the duration is what tells a slow step from a
    // stuck one.
    const startedAt = new Map<string, number>();
    // Reasoning streamed since the last call is the reason for the NEXT one —
    // that is the text a sub-step reveals when opened. Engines that do not
    // stream thinking (the Claude CLI) simply leave it empty.
    let pendingNote = '';
    let runChanges: AgentChangedFile[] = [];
    // The error the run ended on — committed WITH the turn (AgentTurn.error).
    let runError: string | null = null;
    // Chronological record: a run alternates between talking and acting, and
    // the transcript has to show that order or the closing summary lands above
    // the work it summarizes.
    const blocks: AgentBlock[] = [];
    // The live view renders the same blocks — a fresh array each time so the
    // atom sees a change (the blocks themselves are appended in place).
    const publish = () => setLiveBlocks([...blocks]);
    const appendText = (text: string) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') last.text += text;
      else blocks.push({ kind: 'text', text });
      publish();
    };
    // Thinking gets its own block, in place: before the work it led to.
    const appendReasoning = (text: string) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'reasoning') last.text += text;
      else blocks.push({ kind: 'reasoning', text });
      publish();
    };
    const appendTool = (tool: AgentToolEntry) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'tools') last.tools.push(tool);
      else blocks.push({ kind: 'tools', tools: [tool] });
      publish();
    };

    try {
      // Settle the panel FIRST (the component editor saves its buffer), then
      // read where the user is ONCE, so the description and the manual the
      // service attaches can never disagree about the surface.
      runBeforeAgentTurn();
      const surface = readAgentSurface();
      trace.action('agent-panel:turn-start', { surface: surface.kind, images: images.length });
      for await (const ev of streamAgentTurn({
        messages: history,
        config,
        contextBlock: buildAgentContextBlock(surface, invoked),
        surface: surfaceForRequest(surface),
        reasoning: effortWire(effortFor(efforts, config.provider, config.model)),
        signal: ac.signal,
      })) {
        if (ev.type === 'text') { assistantText += ev.text; appendText(ev.text); setStream(assistantText); }
        else if (ev.type === 'reasoning') { runReasoning += ev.text; pendingNote += ev.text; setReasoning(runReasoning); appendReasoning(ev.text); }
        else if (ev.type === 'tool_call') {
          const entry: AgentToolEntry = { id: ev.id, name: ev.name, ok: null, count: countFor(ev.input), note: pendingNote.trim() || undefined };
          pendingNote = '';
          startedAt.set(ev.id, Date.now());
          runTools.push(entry);
          appendTool(entry);
          setTools([...runTools]);
        } else if (ev.type === 'tool_result') {
          const t = runTools.find((x) => x.id === ev.id);
          if (t) {
            t.ok = ev.ok;
            const began = startedAt.get(ev.id);
            if (began !== undefined) t.ms = Date.now() - began;
            // Keep the reason for a FAILURE only. A gate bounce and a real
            // breakage look identical as a red dot, and the difference is the
            // whole story: one means the oracle refused bad source and the
            // model will fix it, the other means something is wrong.
            if (!ev.ok) t.detail = humanizeFailure(ev.content);
            if (ev.image) t.image = ev.image;
            setTools([...runTools]);
            publish();
          }
          // A tool landed — refresh every panel that reads the project.
          bump((v) => v + 1);
        } else if (ev.type === 'turn_changes') {
          runChanges = ev.changes;
          setChanged(ev.changes);
        } else if (ev.type === 'error') {
          runError = ev.message;
          setError(ev.message);
          setStatus('error');
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        runError = err instanceof Error ? err.message : String(err);
        setError(runError);
        setStatus('error');
      }
    } finally {
      if (runAbort === ac) runAbort = null;
      // The service ends the run over the bridge (run_end releases the branch
      // lock). When the stream DIES instead — the service crashed or
      // restarted, the network dropped — that message never comes, and the
      // tab stayed locked read-only ("Agent is editing main") until a reload
      // (2026-09-22). The panel is the one place that knows the turn is over,
      // so it closes any run still open. A normal turn has already been
      // ended by the service, and this is a no-op; if the service is in fact
      // still alive and calls another tool, that call opens a fresh run.
      try {
        const orphan = agentRunEnd({});
        if (orphan.runId) trace.action('agent-panel:orphan-run-closed', { runId: orphan.runId, files: orphan.changes.length });
      } catch (err) { trace.error('agent-panel:orphan-run-close-failed', err); }
      if (assistantText || runTools.length || runError) {
        setConversation((c) => [...c, {
          role: 'assistant', text: assistantText, blocks, tools: runTools, reasoning: runReasoning, changes: runChanges,
          ...(runError ? { error: runError } : {}),
        }]);
        // Now in the transcript (and saved with the chat) — not also as the
        // loose line under it.
        if (runError) setError(null);
      }
      setStream('');
      setTools([]);
      setLiveBlocks([]);
      setReasoning('');
      setStatus((s) => (s === 'error' ? 'error' : 'idle'));
      bump((v) => v + 1);
      // A credits run was billed when it ended — show the new balance (after
      // the service's write lands, like the other AI panels do).
      if (config.provider === 'revyme') window.setTimeout(() => { void refreshCredits(); }, 1200);
      trace.action('agent-panel:turn-end', { tools: runTools.length, chars: assistantText.length });
    }
  }, [input, attachments, status, conversation, config, efforts, activeChatId, setActiveChatId, setLoadedChatId, setConversation, setStream, setTools, setReasoning, setChanged, setError, setStatus, bump]);

  // Stop whichever run is live: the chat's own (abort its stream — the
  // service ends the turn), or an EXTERNAL agent's (end it here; its client
  // is out of reach, so its next calls are refused with the reason).
  // A request queued from outside the chat (Settings → Skills → Generate).
  // Sent once, by whichever mounted chat gets here first.
  const queued = useAtomValue(agentQueuedRequestAtom);
  useEffect(() => {
    if (!queued || status === 'running' || !configured || consumedQueuedNonce === queued.nonce) return;
    consumedQueuedNonce = queued.nonce;
    trace.action('agent-panel:queued-request', { chars: queued.text.length });
    void send(queued.text);
  }, [queued, status, configured, send]);

  const stop = () => {
    if (runAbort) runAbort.abort();
    else if (isExternalRunActive()) stopExternalRun();
    setStatus('idle');
  };

  return (
    <div className="flex h-full flex-col">
      <ChatSwitcher
        activeId={activeChatId ?? null}
        title={chatTitle}
        disabled={status === 'running'}
        onPick={pickChat}
        onNew={newChat}
        onDelete={deleteChat}
      />
      {/* The wrapper is the positioning context for the two edge strips; the
          scroller inside keeps the ref, so sticky-scroll is unchanged. Soft
          edges: see `.agent-scroll-fade` in globals.css. */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="agent-scroll-fade h-full overflow-auto scrollbar-hide px-3">
          {conversation.length === 0 && !stream && (
            <p className="py-6 text-center text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              {configured
                ? copy.empty
                : 'The agent runs on Revyme credits, which this AI service does not offer.'}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {conversation.map((turn, i) => (
              <div key={i} className="flex flex-col gap-3">
                {/* Turns saved before thinking had its own card keep the
                    folded line; newer ones carry it in their blocks. */}
                {turn.role === 'assistant' && turn.reasoning && !turn.blocks?.some((b) => b.kind === 'reasoning') && <ThoughtBlock text={turn.reasoning} />}
                {turn.role === 'user' || !turn.blocks ? (
                  (turn.text || turn.role === 'user') && (turn.role === 'user'
                    ? (
                      <>
                        {turn.images && <ImageStrip images={turn.images} />}
                        {/* An image-only message has no words to enclose. */}
                        {(turn.text || !turn.images?.length) && (
                          <Bubble role="user">{turn.skills?.length ? <SkillText text={turn.text} names={turn.skills} /> : turn.text}</Bubble>
                        )}
                        {/* Asked outside the builder (MCP) — say where, or the
                            transcript shows a prompt nobody typed here. */}
                        {turn.via && <span className="-mt-2 px-0.5 text-[10px] text-[var(--text-tertiary)]" data-testid="agent-turn-via">via {turn.via}</span>}
                        {/* Which project skills this message invoked with /name. */}
                        {turn.skills && turn.skills.length > 0 && (
                          <span className="-mt-2 px-0.5 text-[10px] text-[var(--text-tertiary)]" data-testid="agent-turn-skills">
                            Used {turn.skills.map((n) => `/${n}`).join(', ')}
                          </span>
                        )}
                      </>
                    )
                    : <AssistantText text={turn.text} />)
                ) : (
                  visibleBlocks(turn.blocks).map((b, bi) => (b.kind === 'text'
                    ? (b.text.trim() && <AssistantText key={bi} text={b.text} />)
                    : b.kind === 'reasoning'
                      ? <ReasoningCard key={bi} text={b.text} live={false} />
                      : <ActivityList key={bi} tools={b.tools} />))
                )}
                {/* Older turns (recorded before blocks existed) still render
                    their tools the flat way rather than losing them. */}
                {turn.role === 'assistant' && !turn.blocks && turn.tools && turn.tools.length > 0 && (
                  <ActivityList tools={turn.tools} />
                )}
                {/* The error this run ended on — kept in the transcript (and
                    saved with the chat) so a failed run can be debugged later. */}
                {turn.role === 'assistant' && turn.error && (
                  <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--accent-danger,#dc2626)]" data-testid="agent-turn-error">
                    {turn.error}
                  </div>
                )}
                {/* Each turn keeps its own card, in place. Undo/redo are offered
                    only on the LAST one: history is a stack, so the button on an
                    older card would revert the most recent turn instead of the
                    one it sits under — a quiet, destructive lie. Older cards stay
                    fully navigable. */}
                {turn.role === 'assistant' && turn.changes && turn.changes.length > 0 && (
                  <ChangesCard
                    files={turn.changes}
                    canRevert={i === conversation.length - 1 && status !== 'running'}
                  />
                )}
              </div>
            ))}

            {(stream || reasoning || tools.length > 0 || status === 'running') && (
              <div className="flex flex-col gap-3">
                {/* The in-flight turn, in the order it happens: a sentence, a
                    card of work, a sentence… — the same shape it keeps once it
                    is committed. Only the LAST block is live: a text block
                    still typing gets the dots, a tool block the shimmer. */}
                {visibleBlocks(liveBlocks).map((b, bi, shown) => {
                  const last = bi === shown.length - 1;
                  if (b.kind === 'reasoning') return <ReasoningCard key={bi} text={b.text} live={last && status === 'running'} />;
                  if (b.kind === 'text') {
                    if (!b.text.trim()) return null;
                    return (
                      <Bubble key={bi} role="assistant">
                        {renderMarkdown(b.text)}
                        {last && status === 'running' && <span className="text-[var(--text-tertiary)]"><BusyDots /></span>}
                      </Bubble>
                    );
                  }
                  return <ActivityList key={bi} tools={b.tools} live={last && status === 'running'} />;
                })}
                {/* Something IS happening even before the first token or tool
                    lands — say so, rather than leaving a blank panel that reads
                    as a hang. */}
                {status === 'running' && visibleBlocks(liveBlocks).length === 0 && (
                  <div className="flex items-center gap-1.5 px-0.5 text-[11px] text-[var(--text-tertiary)]">
                    <BusyDots />
                    <span>Working…</span>
                  </div>
                )}
              </div>
            )}
          </div>



          {error && <div className="py-2 text-[11px] text-[var(--accent-danger,#dc2626)]">{error}</div>}
        </div>
        <div aria-hidden className="agent-edge-blur agent-edge-blur-top" />
        <div aria-hidden className="agent-edge-blur agent-edge-blur-bottom" />
      </div>

      {/* Breathing room under the field: the footer's buttons sat on the
          panel's bottom edge with the symmetric p-2. */}
      <div className="relative px-2 pt-2 pb-4">
        {slashOpen && (
          <SkillMenu skills={slashMatches} activeIndex={Math.min(slashIndex, Math.max(0, slashMatches.length - 1))} onPick={pickSkill} onHover={setSlashIndex} onManage={manageSkills} />
        )}
        {(attachments.length > 0 || attachNote) && (
          <div className="flex flex-col gap-1 pb-1.5 pt-1">
            <ImageStrip images={attachments} onRemove={removeAttachment} />
            {attachNote && <span className="text-[11px] text-[var(--text-tertiary)]">{attachNote}</span>}
          </div>
        )}
        {/* ONE box: the text area on top, a footer inside it — a hairline, the
            model and branch chips on the left, Send / Stop on the right. The border and
            its hover / focus steps live on the wrapper (focus-within), so the
            footer is part of the field rather than a row floating under it.
            NEUTRAL focus, not --border-focus: that token is the accent, and the
            accent means "selected" everywhere else in this editor — a composer
            ringed in it the whole time you type reads as an alarm. */}
        <div
          data-testid="agent-composer"
          className={`flex flex-col bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] focus-within:border-[var(--control-border-hover)] focus-within:[--cut-border-color:var(--control-border-hover)] cut-corners cut-border transition-colors ${configured ? '' : 'opacity-40'}`}
        >
          <div className="relative">
          {draftHasSkill && (
            <div
              ref={mirrorRef}
              aria-hidden
              data-testid="agent-composer-mirror"
              // Same box as the textarea below: padding, size, line height,
              // wrapping — so every glyph lands where the caret thinks it is.
              className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] px-3 py-2.5 text-xs leading-relaxed text-[var(--text-primary)]"
            >
              {/* A trailing newline needs a glyph after it to take its line. */}
              <SkillText text={`${input}\u200b`} names={skillNames} />
            </div>
          )}
          <textarea
            ref={composerRef}
            // Two lines empty; it grows with the text (the effect above) up
            // to COMPOSER_MAX_HEIGHT. Three empty lines was mostly blank box.
            rows={2}
            value={input}
            disabled={!configured}
            onChange={(e) => { setInput(e.target.value); readSlash(e.target); }}
            onPaste={onPaste}
            onClick={(e) => readSlash(e.currentTarget)}
            onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') readSlash(e.currentTarget); }}
            onBlur={() => setSlash(null)}
            onKeyDown={(e) => {
              // The skill menu takes the keys while it is open.
              if (slashOpen) {
                if (e.key === 'ArrowDown' && slashMatches.length > 0) { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashMatches.length); return; }
                if (e.key === 'ArrowUp' && slashMatches.length > 0) { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                if ((e.key === 'Enter' || e.key === 'Tab') && slashMatches.length > 0 && !e.shiftKey) {
                  e.preventDefault();
                  pickSkill(slashMatches[Math.min(slashIndex, slashMatches.length - 1)].name);
                  return;
                }
                if (e.key === 'Escape') { e.preventDefault(); setSlash(null); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={configured ? copy.placeholder
              : reachable === false ? 'Can\u2019t reach the Revyme AI service — retrying…'
              : engines && engines.length === 0 ? 'No agent runs on this server'
              : 'This AI service does not run Revyme credits'}
            onScroll={(e) => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop; }}
            className={`relative block w-full resize-none bg-transparent px-3 py-2.5 text-xs leading-relaxed placeholder:text-[var(--text-tertiary)] focus:outline-none ${
              draftHasSkill ? 'scrollbar-hide text-transparent caret-[var(--text-primary)]' : 'text-[var(--text-primary)]'
            }`}
          />
          </div>
          {/* The chips SHRINK and truncate; the send never does. The chip
              buttons kept their full text width and ran under the send
              circle in a narrow panel (2026-09-23). */}
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border-light)] px-2 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {/* The credit model the next turn runs on — ModelSelector.tsx. */}
              <ModelSelector />
              <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--border-light)]" />
              {/* The branch the next turn lands on — see BranchSwitcher.tsx. */}
              <BranchSelector disabled={status === 'running'} onRequestCreate={() => setCreatingBranch(true)} />
            </div>
            {/* The comment box's round send — same glyph, same 24px circle —
                and while a run is live the same circle in red with a square:
                stop. One spot, one shape, the meaning in the colour. */}
            {status === 'running' ? (
              <button
                type="button"
                onClick={stop}
                title="Stop the run"
                aria-label="Stop"
                data-testid="agent-stop"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-danger,#dc2626)] text-white transition-[filter] hover:brightness-110"
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" style={{ pointerEvents: 'none' }}>
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void send()}
                disabled={!configured || (!input.trim() && attachments.length === 0)}
                title="Send"
                aria-label="Send"
                data-testid="agent-send"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors enabled:bg-[var(--accent)] enabled:text-[var(--accent-fg)] enabled:hover:brightness-110 disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" style={{ pointerEvents: 'none' }}>
                  <path fill="currentColor" d="M19.5 2.001a3.5 3.5 0 0 1 3.03 5.249l-7.5 12.99a3.5 3.5 0 0 1-6.411-.842l-1.5-5.595l8.77-5.064a1 1 0 0 0-1-1.732L6.12 12.07L2.026 7.975A3.5 3.5 0 0 1 4.5 2z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      <BranchCreateModal isOpen={creatingBranch} onClose={() => setCreatingBranch(false)} />
    </div>
  );
}
