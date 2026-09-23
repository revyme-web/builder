// agent/external-run.ts — work asked for OUTSIDE the builder, shown inside it.
//
// An external agent (the user's Claude Code / Claude Desktop through the
// Revyme MCP connector) drives the same tools through the same bridge as the
// builder's own agent. What it did not get was the chat: the request, the
// live activity, Stop, the Changes card and the saved transcript. This module
// drives the SAME chat state an in-house turn drives — agentStatusAtom,
// agentToolsAtom, agentBlocksAtom, the conversation — from the bridge's
// external-run events (ai/agent/bridge-tools.ts `ExternalRunObserver`), so
// an MCP run looks exactly like a chat run: the VIBE icon works, the panel
// shows the rows as they happen, Stop stops it, and the turn lands in the
// open chat with its Changes card.
//
// Imperative (getDefaultStore), not a hook: the chat panel may be closed
// while the work happens, and the transcript must still record it.
// Registered by `startMcpBridge()` — external runs only ever arrive through
// the bridge — and never at import: bridge-tools' own import graph reaches
// this file (tools/assets → bridge-client), and registering while that graph
// is still evaluating hit bridge-tools' observer in its TDZ.

import { getDefaultStore } from 'jotai';
import { setExternalRunObserver, type ExternalRunObserver } from '@/ai/agent/bridge-tools';
import {
  agentStatusAtom, agentErrorAtom, agentConversationAtom, agentStreamAtom, agentToolsAtom,
  agentBlocksAtom, agentReasoningAtom, agentChangedFilesAtom,
  type AgentToolEntry, type AgentBlock, type AgentTurn, type AgentChangedFile,
} from '@/code/stores/agent-chat-store';
import {
  activeAgentChatIdAtom, loadedAgentChatIdAtom, resolveAgentChatId, newAgentChatId, getAgentChat, saveAgentChat,
} from '@/code/stores/agent-chats-store';
import { projectVersionAtom } from '@/code/project/project-fs';
import { turnsFromStored, storedFromTurns } from './transcript-io';
import { countFor } from './activity';
import { humanizeFailure } from './humanize-failure';
import { trace } from '@/shared/debug-trace';

const store = getDefaultStore();

/** The run being mirrored — module state, like the chat's own run handle. */
let mirror: { runId: string; tools: AgentToolEntry[]; blocks: AgentBlock[]; byId: Map<string, AgentToolEntry> } | null = null;

/** The chat the work lands in: the open one, loaded if the panel never
 *  loaded it this session, or a fresh one when there is none. */
function openChatForWork(): string {
  const resolved = resolveAgentChatId(store.get(activeAgentChatIdAtom));
  if (!resolved) {
    const id = newAgentChatId();
    store.set(loadedAgentChatIdAtom, id);
    store.set(activeAgentChatIdAtom, id);
    store.set(agentConversationAtom, []);
    return id;
  }
  if (store.get(activeAgentChatIdAtom) !== resolved) store.set(activeAgentChatIdAtom, resolved);
  if (store.get(loadedAgentChatIdAtom) !== resolved) {
    store.set(loadedAgentChatIdAtom, resolved);
    store.set(agentConversationAtom, turnsFromStored(getAgentChat(resolved)?.messages ?? []));
  }
  return resolved;
}

/** "claude-code" → "Claude Code"; unknown names are shown as given. */
export function clientLabel(client: string | undefined): string {
  if (!client) return 'MCP';
  const known: Record<string, string> = { 'claude-code': 'Claude Code', 'claude-ai': 'Claude', 'claude desktop': 'Claude Desktop', cursor: 'Cursor' };
  return known[client.toLowerCase()] ?? client;
}

function publish(): void {
  if (!mirror) return;
  store.set(agentToolsAtom, [...mirror.tools]);
  store.set(agentBlocksAtom, [...mirror.blocks]);
}

export const externalRunMirror: ExternalRunObserver = {
  begin({ runId, request, client }) {
    const via = clientLabel(client);
    openChatForWork();
    const ask: AgentTurn = { role: 'user', text: request?.trim() || `Work asked for in ${via}`, via };
    store.set(agentConversationAtom, (c) => [...c, ask]);
    store.set(agentStreamAtom, '');
    store.set(agentToolsAtom, []);
    store.set(agentBlocksAtom, []);
    store.set(agentReasoningAtom, '');
    store.set(agentChangedFilesAtom, []);
    store.set(agentErrorAtom, null);
    store.set(agentStatusAtom, 'running');
    mirror = { runId, tools: [], blocks: [], byId: new Map() };
    trace.action('agent-external-run:begin', { runId, via });
  },

  toolStart({ id, name, input }) {
    if (!mirror) return;
    const entry: AgentToolEntry = { id, name, ok: null, count: countFor(input) };
    mirror.tools.push(entry);
    mirror.byId.set(id, entry);
    const last = mirror.blocks[mirror.blocks.length - 1];
    if (last?.kind === 'tools') last.tools.push(entry);
    else mirror.blocks.push({ kind: 'tools', tools: [entry] });
    publish();
  },

  toolEnd({ id, ok, content, image, ms }) {
    const entry = mirror?.byId.get(id);
    if (!entry) return;
    entry.ok = ok;
    entry.ms = ms;
    if (!ok) entry.detail = humanizeFailure(content);
    if (image) entry.image = image;
    publish();
    // A tool landed — refresh every panel that reads the project (as the chat does).
    store.set(projectVersionAtom, (v) => v + 1);
  },

  end({ runId, changes, summary, stopped }) {
    const run = mirror && mirror.runId === runId ? mirror : null;
    mirror = null;
    const blocks: AgentBlock[] = run ? [...run.blocks] : [];
    const closing = summary?.trim() || (stopped ? 'Stopped from the editor.' : '');
    if (closing) blocks.push({ kind: 'text', text: closing });
    const reply: AgentTurn = {
      role: 'assistant',
      text: closing,
      blocks,
      tools: run ? run.tools : [],
      changes: changes as AgentChangedFile[],
    };
    const conversation = [...store.get(agentConversationAtom), reply];
    store.set(agentConversationAtom, conversation);
    store.set(agentChangedFilesAtom, changes as AgentChangedFile[]);
    store.set(agentStreamAtom, '');
    store.set(agentToolsAtom, []);
    store.set(agentBlocksAtom, []);
    store.set(agentStatusAtom, 'idle');
    store.set(projectVersionAtom, (v) => v + 1);
    // Saved HERE, not only by the panel's effect: the panel may be closed.
    const chatId = store.get(activeAgentChatIdAtom);
    if (chatId && store.get(loadedAgentChatIdAtom) === chatId) saveAgentChat(chatId, storedFromTurns(conversation));
    trace.action('agent-external-run:end', { runId, files: changes.length, stopped });
  },
};

/** Idempotent. */
export function registerExternalRunMirror(): void {
  setExternalRunObserver(externalRunMirror);
}
