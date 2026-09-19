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

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import Button from '@/design-system/Button';
import type { AgentBlock } from '@/code/stores/agent-chat-store';
import {
  agentStatusAtom, agentErrorAtom, agentConversationAtom, agentStreamAtom,
  agentToolsAtom, agentReasoningAtom, agentChangedFilesAtom, agentConfigAtom,
  isAgentConfiguredAtom, type AgentToolEntry, type AgentChangedFile,
} from '@/code/stores/agent-chat-store';
import { renderMarkdown } from './markdown';
import { foldActivity, countFor, type ActivityStep, type ActivitySubstep } from './activity';
import ChangesCard from './ChangesCard';
import { streamAgentTurn, type AgentMessageOut } from '@/ai/agent/agent-client';
import { buildAgentContextBlock } from '@/ai/agent/editor-context';
import { projectVersionAtom } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { getChatHistory, saveChatHistory } from '@/code/stores/chat-history-store';
import AgentConfigModal from '@/editor/left-toolbar/panels/agent/AgentConfigModal';
import { trace } from '@/shared/debug-trace';

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/**
 * Turn a failed tool's payload into one readable line.
 *
 * The gate answers with the oracle's own violation objects. Their CODES are
 * the actionable part — `USE_CLIENT_REQUIRED` says exactly what was wrong,
 * where a wall of prose does not — so lead with those and fall back to the
 * first line of text when the failure is not a gate bounce.
 */
/**
 * A failed step, in plain language.
 *
 * The payload is written for the MODEL — oracle violation codes, tool
 * ledgers, retry hints. The person reading is looking at their website: codes
 * like `COMPONENT_ROOT_POSITION` tell them nothing except that something
 * technical went wrong, which reads as breakage even though almost every one
 * of these is caught, explained and corrected on the next step.
 *
 * So: say what happened and that it was handled. Never a code.
 */
export function humanizeFailure(content: string): string {
  const c = content.toLowerCase();

  // Oracle bounce — the gate refused the code. The most common failure by far,
  // and the most reassuring: nothing was written and the agent was told why.
  if (/"code"\s*:\s*"[A-Z0-9_]+"/.test(content) || /oracle .*gate|\bgate blocked\b/i.test(content)) {
    return 'Revyme wouldn\u2019t accept that code — the agent was shown what was wrong and corrected it.';
  }
  // The user was dragging/resizing while the agent wrote.
  if (c.includes('mid-interaction') || c.includes('drag/resize')) {
    return 'You were editing at the same moment, so this step waited and ran again.';
  }
  // A tool that cannot run inside a bulk edit.
  if (c.includes('cannot run inside batch') || c.includes('unknown tool')) {
    return 'A step was grouped with others when it needed its own turn — the agent split it out.';
  }
  // An anchored edit whose anchor moved.
  if (c.includes('oldtext not found') || c.includes('anchor must match')) {
    return 'The file had changed since the agent last read it, so it re-read and edited again.';
  }
  // The editor never answered.
  if (c.includes('could not run') || c.includes('timeout') || c.includes('no editor')) {
    return 'The editor didn\u2019t respond to this step.';
  }
  if (c.includes('not found') || c.includes('missing')) {
    return 'Something the agent expected to find wasn\u2019t there, so it looked again.';
  }
  return 'This step didn\u2019t apply — the agent adjusted and carried on.';
}

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

/** The page-with-corner mark Framer uses for a capture. */
function ViewIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-[var(--text-tertiary)]">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/** `6.7s` — only once a step is slow enough for the number to mean anything. */
function secs(ms: number): string | null {
  if (ms < 1000) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One turn's tool calls as a handful of OUTCOME lines.
 *
 * Previously this rendered a row per call: 28 rows of "Reading source",
 * "Auditing design", "Revyme Edit File" — the agent's internal mechanics,
 * which the person reading is not the audience for. `foldActivity` collapses
 * consecutive calls of a kind into one line phrased as what changed, so the
 * run reads as "looked → built 15 layers → looked again".
 *
 * Deliberately NOT a bordered card. These lines sit between the agent's
 * sentences as quiet grey asides, the way a caption sits under a paragraph;
 * boxing them gave each group the visual weight of a message.
 *
 * They are the SAME SIZE as the prose and differ only in colour. Shrinking
 * them to 11px made the transcript look like a log with captions wedged
 * between paragraphs; matching the body size lets one rhythm carry the whole
 * column and leaves colour to do the work of separating comment from content.
 *
 * FAILURES ARE NOT RENDERED. Every message `humanizeFailure` produces says
 * some version of "the agent adjusted and carried on" — which is, by
 * definition, not something the reader has to do anything about. Printed under
 * the step it reads as debris and makes a healthy run look broken. A failure
 * that the user must actually act on belongs in the agent's closing sentence,
 * which the prompt already requires; `failures` stays on the step for tracing.
 */
function ActivityList({ tools, live }: { tools: AgentToolEntry[]; live?: boolean }) {
  const steps = foldActivity(tools);
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const working = !!live && s.running && i === steps.length - 1;
        const t = secs(s.ms);
        // A capture is the one result worth showing in full — it is the
        // evidence behind the next decision — so it gets a card with its own
        // label and duration rather than a bare image under a grey line.
        if (s.images.length > 0) {
          return (
            <div key={i} className="cut-corners cut-border [--cut-border-color:var(--border-default)] border border-[var(--border-default)] p-1.5">
              <div className="flex items-center gap-1.5 px-0.5 pb-1.5">
                <ViewIcon />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">{s.label}</span>
                {t && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{t}</span>}
              </div>
              <div className="flex flex-col gap-1.5">
                {s.images.map((src, ii) => (
                  <img
                    key={ii}
                    src={src}
                    alt="Canvas screenshot the agent captured"
                    loading="lazy"
                    className="max-h-40 w-full cut-corners object-cover object-top"
                  />
                ))}
              </div>
            </div>
          );
        }
        return <ActivityRow key={i} step={s} seconds={t} live={working} />;
      })}
    </div>
  );
}

/**
 * One folded step, expandable into the calls behind it.
 *
 * The fold is what makes the transcript readable, but it also hides the only
 * record of what the agent actually did — so the line opens. Inside, each call
 * is phrased on its own with its own duration, and a call whose reasoning was
 * captured can be opened once more to show WHY it happened. That is the one
 * thing a folded label genuinely cannot carry.
 *
 * A step of one call has nothing to reveal and renders with no chevron.
 */
function ActivityRow({ step, seconds, live }: { step: ActivityStep; seconds: string | null; live: boolean }) {
  const [open, setOpen] = useState(false);
  const expandable = step.substeps.length > 1;

  const line = (
    <>
      {/* The shimmer runs on the TEXT, so a live row is the same size as a
          finished one and nothing shifts when the step completes. */}
      <span className={`truncate text-[12px] leading-relaxed ${live ? 'agent-step-live' : 'text-[var(--text-tertiary)]'}`}>
        {step.label}
      </span>
      {seconds && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{seconds}</span>}
      {expandable && (
        <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{open ? '▾' : '▸'}</span>
      )}
    </>
  );

  return (
    <div className="min-w-0">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-baseline gap-1.5 px-0.5 text-left transition-colors hover:[&>span:first-child]:text-[var(--text-secondary)]"
        >
          {line}
        </button>
      ) : (
        <div className="flex min-w-0 items-baseline gap-1.5 px-0.5">{line}</div>
      )}
      {open && (
        <div className="mt-2 flex flex-col gap-2 pl-2">
          {step.substeps.map((sub, i) => <Substep key={i} sub={sub} />)}
        </div>
      )}
    </div>
  );
}

/** One call inside an expanded step, itself expandable when it has reasoning. */
function Substep({ sub }: { sub: ActivitySubstep }) {
  const [open, setOpen] = useState(false);
  const t = secs(sub.ms);
  const hasNote = !!sub.note?.trim();
  const body = (
    <>
      <span className="truncate text-[12px] leading-relaxed text-[var(--text-tertiary)]">{sub.label}</span>
      {t && <span className="shrink-0 text-[11px] text-[var(--text-disabled)]">{t}</span>}
      {hasNote && <span className="shrink-0 text-[10px] text-[var(--text-disabled)]">{open ? '▾' : '▸'}</span>}
    </>
  );
  return (
    <div className="min-w-0">
      {hasNote ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full min-w-0 items-baseline gap-1.5 text-left transition-colors hover:[&>span:first-child]:text-[var(--text-secondary)]"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 items-baseline gap-1.5">{body}</div>
      )}
      {open && sub.note && (
        <p className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {sub.note}
        </p>
      )}
    </div>
  );
}

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
      <div className="px-0.5 text-[12px] leading-relaxed text-[var(--text-primary)] break-words">
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

export default function AgentChat() {
  const [status, setStatus] = useAtom(agentStatusAtom);
  const [error, setError] = useAtom(agentErrorAtom);
  const [conversation, setConversation] = useAtom(agentConversationAtom);
  const [stream, setStream] = useAtom(agentStreamAtom);
  const [tools, setTools] = useAtom(agentToolsAtom);
  const [reasoning, setReasoning] = useAtom(agentReasoningAtom);
  const [changed, setChanged] = useAtom(agentChangedFilesAtom);
  const config = useAtomValue(agentConfigAtom);
  const configured = useAtomValue(isAgentConfiguredAtom);
  const bump = useSetAtom(projectVersionAtom);

  // PER-SURFACE HISTORY. The conversation belongs to the thing being edited —
  // a page, a design component, a collection — and lives in
  // `_meta/chat-history.json`, keyed by that file's path, riding the normal
  // project save. So it survives a reload, follows the user between surfaces,
  // and is shared with teammates, exactly like comments and ruler guides.
  const activeFile = useAtomValue(activeFilePathAtom);
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFile || loadedFor.current === activeFile) return;
    loadedFor.current = activeFile;
    const stored = getChatHistory(activeFile);
    // Restore the FULL transcript, not just the prose: the activity lines and
    // screenshots are the record of what the agent did to this surface, and
    // dropping them on reload left a reply with no visible work behind it.
    setConversation(stored.map((m) => ({
      role: m.role,
      text: m.content,
      blocks: m.blocks?.map((b) => (b.kind === 'text'
        ? { kind: 'text' as const, text: b.text }
        : {
            kind: 'tools' as const,
            tools: b.tools.map((t, i): AgentToolEntry => ({
              // Ids are per-run and not persisted; the transcript only needs
              // them to be unique within their block for React keys.
              id: `stored-${i}`,
              name: t.name, ok: t.ok, detail: t.detail,
              count: t.count, ms: t.ms, image: t.image, note: t.note,
            })),
          })),
      reasoning: m.reasoning,
      changes: m.changes,
    })));
    setStream('');
    setTools([]);
    setReasoning('');
    setChanged([]);
    setError(null);
  }, [activeFile, setConversation, setStream, setTools, setReasoning, setChanged, setError]);

  // Persist whenever the transcript settles — the prose AND the activity
  // behind it, so reopening the surface shows the same transcript it showed
  // before. Token counts stay out: they are per-run telemetry, not a record of
  // what happened to the website. Screenshots are budgeted by the store.
  useEffect(() => {
    if (!activeFile || loadedFor.current !== activeFile) return;
    if (status === 'running') return;
    saveChatHistory(activeFile, conversation.map((t) => ({
      role: t.role,
      content: t.text,
      blocks: t.blocks?.map((b) => (b.kind === 'text'
        ? { kind: 'text' as const, text: b.text }
        : {
            kind: 'tools' as const,
            tools: b.tools.map((x) => ({
              name: x.name,
              // A call still in flight when the turn ended did not land.
              ok: x.ok === true,
              detail: x.detail, count: x.count, ms: x.ms, image: x.image, note: x.note,
            })),
          })),
      reasoning: t.reasoning,
      changes: t.changes,
    })));
  }, [activeFile, conversation, status]);

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
  const [showConfig, setShowConfig] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!stick.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status === 'running') return;

    const history: AgentMessageOut[] = [
      ...conversation.map((t) => ({ role: t.role, content: [{ type: 'text' as const, text: t.text }] })),
      { role: 'user' as const, content: [{ type: 'text' as const, text }] },
    ];
    stick.current = true;   // sending is an explicit "show me"
    setConversation((c) => [...c, { role: 'user', text }]);
    setInput('');
    setStream('');
    setTools([]);
    setReasoning('');
    setChanged([]);
    setError(null);
    setStatus('running');

    const ac = new AbortController();
    abortRef.current = ac;
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
    // Chronological record: a run alternates between talking and acting, and
    // the transcript has to show that order or the closing summary lands above
    // the work it summarizes.
    const blocks: AgentBlock[] = [];
    const appendText = (text: string) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'text') last.text += text;
      else blocks.push({ kind: 'text', text });
    };
    const appendTool = (tool: AgentToolEntry) => {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'tools') last.tools.push(tool);
      else blocks.push({ kind: 'tools', tools: [tool] });
    };

    try {
      for await (const ev of streamAgentTurn({
        messages: history,
        config,
        contextBlock: buildAgentContextBlock(),
        signal: ac.signal,
      })) {
        if (ev.type === 'text') { assistantText += ev.text; appendText(ev.text); setStream(assistantText); }
        else if (ev.type === 'reasoning') { runReasoning += ev.text; pendingNote += ev.text; setReasoning(runReasoning); }
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
          }
          // A tool landed — refresh every panel that reads the project.
          bump((v) => v + 1);
        } else if (ev.type === 'turn_changes') {
          runChanges = ev.changes;
          setChanged(ev.changes);
        } else if (ev.type === 'error') {
          setError(ev.message);
          setStatus('error');
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    } finally {
      abortRef.current = null;
      if (assistantText || runTools.length) {
        setConversation((c) => [...c, { role: 'assistant', text: assistantText, blocks, tools: runTools, reasoning: runReasoning, changes: runChanges }]);
      }
      setStream('');
      setTools([]);
      setReasoning('');
      setStatus((s) => (s === 'error' ? 'error' : 'idle'));
      bump((v) => v + 1);
      trace.action('agent-panel:turn-end', { tools: runTools.length, chars: assistantText.length });
    }
  }, [input, status, conversation, config, setConversation, setStream, setTools, setReasoning, setChanged, setError, setStatus, bump]);

  const stop = () => { abortRef.current?.abort(); setStatus('idle'); };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto scrollbar-hide px-3 py-1">
        {conversation.length === 0 && !stream && (
          <p className="py-6 text-center text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            {configured
              ? 'Ask for a change to this page — a section, a restyle, a new component.'
              : 'Pick a provider in settings to start.'}
          </p>
        )}

        <div className="flex flex-col gap-3">
          {conversation.map((turn, i) => (
            <div key={i} className="flex flex-col gap-3">
              {turn.role === 'assistant' && turn.reasoning && <ThoughtBlock text={turn.reasoning} />}
              {turn.role === 'user' || !turn.blocks ? (
                (turn.text || turn.role === 'user') && (turn.role === 'user'
                  ? <Bubble role="user">{turn.text}</Bubble>
                  : <AssistantText text={turn.text} />)
              ) : (
                turn.blocks.map((b, bi) => (b.kind === 'text'
                  ? (b.text.trim() && <AssistantText key={bi} text={b.text} />)
                  : <ActivityList key={bi} tools={b.tools} />))
              )}
              {/* Older turns (recorded before blocks existed) still render
                  their tools the flat way rather than losing them. */}
              {turn.role === 'assistant' && !turn.blocks && turn.tools && turn.tools.length > 0 && (
                <ActivityList tools={turn.tools} />
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
              {reasoning && <ThoughtBlock text={reasoning} live={status === 'running'} />}
              {stream && (
                <Bubble role="assistant">
                  {renderMarkdown(stream)}
                  {status === 'running' && <span className="text-[var(--text-tertiary)]"><BusyDots /></span>}
                </Bubble>
              )}
              <ActivityList tools={tools} live={status === 'running'} />
              {/* Something IS happening even before the first token or tool
                  lands — say so, rather than leaving a blank panel that reads
                  as a hang. */}
              {status === 'running' && !stream && tools.length === 0 && (
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

      <div className="p-2">
        <textarea
          rows={2}
          value={input}
          disabled={!configured}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
          placeholder={configured ? 'Describe the change…' : 'Open settings first'}
          className="w-full resize-none px-[var(--control-pad-x)] py-1.5 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] hover:[--cut-border-color:var(--control-border-hover)] focus:border-[var(--border-focus)] focus:[--cut-border-color:var(--border-focus)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] cut-corners cut-border focus:outline-none transition-colors disabled:opacity-40"
        />
        <div className="flex items-center justify-between pt-1.5">
          <button
            type="button"
            title="Agent settings"
            onClick={() => setShowConfig(true)}
            className="flex h-5 w-5 items-center justify-center cut-corners text-[var(--text-disabled)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <GearIcon />
          </button>
          <div className="flex gap-1.5">
          {status === 'running' ? (
            <Button variant="secondary" size="sm" onClick={stop}>Stop</Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => void send()} disabled={!configured || !input.trim()}>
              Send
            </Button>
          )}
          </div>
        </div>
      </div>

      <AgentConfigModal isOpen={showConfig} onClose={() => setShowConfig(false)} />
    </div>
  );
}
