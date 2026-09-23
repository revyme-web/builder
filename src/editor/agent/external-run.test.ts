// An EXTERNAL agent (Claude Code over the Revyme MCP connector) doing work
// through begin_work → tools → finish_work must be the SAME thing in the
// editor as the builder's own agent: the branch lock (editor read-only), one
// run, the chat showing the request + live rows + the Changes card, the turn
// saved in the chat, and Stop working on it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import {
  agentRunStart, agentRunEnd, agentToolCall, stopExternalRun, isExternalRunActive,
  EXTERNAL_STOPPED_MESSAGE, MCP_RUN_IDLE_MS, agentContext,
} from '@/ai/agent/bridge-tools';
import { clientLabel, registerExternalRunMirror } from './external-run';
import { runBridgeRequest } from '@/ai/mcp/bridge-client';
import { isBranchLocked, isActiveBranchLocked } from '@/code/stores/agent-run-lock-store';
import { isViewerMode } from '@/code/stores/viewer-mode-store';
import { projectFS, resetProjectFS, MAIN_BRANCH_ID } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { setActiveFilePath, syncQueueCode, initMutationQueue } from '@/code/mutation/mutation-queue';
import { agentStatusAtom, agentConversationAtom, agentToolsAtom } from '@/code/stores/agent-chat-store';
import { activeAgentChatIdAtom, loadedAgentChatIdAtom, getAgentChat } from '@/code/stores/agent-chats-store';

const PAGE = `export default function Page() {
  return (<div data-id="root" style={{ display: 'flex' }}>
    <p data-id="title">Hello</p>
  </div>);
}`;
const store = getDefaultStore();

beforeEach(() => {
  registerExternalRunMirror();
  resetProjectFS(new Map([['app/page.client.tsx', PAGE]]));
  store.set(activeFilePathAtom, 'app/page.client.tsx');
  setActiveFilePath('app/page.client.tsx');
  // The queue's drain writes the active file — wired the way the editor wires it.
  initMutationQueue(PAGE, (code) => projectFS.writeFile('app/page.client.tsx', code));
  syncQueueCode(PAGE);
  store.set(activeAgentChatIdAtom, undefined);
  store.set(loadedAgentChatIdAtom, undefined);
  store.set(agentConversationAtom, []);
  store.set(agentStatusAtom, 'idle');
});
afterEach(() => { agentRunEnd({}); vi.useRealTimers(); });

describe('an MCP run in the editor', () => {
  it('locks the branch (editor read-only) for the whole run, and releases it at finish', async () => {
    agentRunStart({ source: 'mcp', request: 'make the title red', client: 'claude-code' });
    expect(isActiveBranchLocked()).toBe(true);
    expect(isViewerMode()).toBe(true);
    await agentToolCall({ name: 'get_node_tree', input: {} });
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
    agentRunEnd({ summary: 'Done.' });
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
    expect(isViewerMode()).toBe(false);
  });

  it('shows in the chat like a chat run: the request (via the client), live rows, then the reply with its Changes', async () => {
    agentRunStart({ source: 'mcp', request: 'make the title red', client: 'claude-code' });
    expect(store.get(agentStatusAtom)).toBe('running');
    expect(store.get(agentConversationAtom)).toEqual([{ role: 'user', text: 'make the title red', via: 'Claude Code' }]);

    await agentToolCall({ name: 'set_styles', input: { node_id: 'title', styles: { color: 'red' } } });
    const live = store.get(agentToolsAtom);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ name: 'set_styles', ok: true });

    agentRunEnd({ summary: 'The title is red now.' });
    expect(store.get(agentStatusAtom)).toBe('idle');
    const [, reply] = store.get(agentConversationAtom);
    expect(reply.role).toBe('assistant');
    expect(reply.text).toBe('The title is red now.');
    expect(reply.tools?.map((t) => t.name)).toEqual(['set_styles']);
    expect(reply.changes?.map((c) => c.path)).toEqual(['app/page.client.tsx']);
    expect(projectFS.readFile('app/page.client.tsx')).toContain('red');
    // …and it is SAVED in the chat, with the panel never opened.
    const chatId = store.get(activeAgentChatIdAtom)!;
    const saved = getAgentChat(chatId)!.messages;
    expect(saved.map((m) => [m.role, m.content, m.via])).toEqual([
      ['user', 'make the title red', 'Claude Code'],
      ['assistant', 'The title is red now.', undefined],
    ]);
  });

  it('Stop ends it, keeps the work, and refuses the agent\'s next call with the reason — until its next begin_work', async () => {
    agentRunStart({ source: 'mcp', request: 'restyle everything', client: 'claude-code' });
    await agentToolCall({ name: 'set_styles', input: { node_id: 'title', styles: { color: 'blue' } } });
    expect(stopExternalRun()).toBe(true);
    expect(isExternalRunActive()).toBe(false);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
    expect(store.get(agentStatusAtom)).toBe('idle');
    expect(store.get(agentConversationAtom).slice(-1)[0]?.text).toBe('Stopped from the editor.');
    expect(projectFS.readFile('app/page.client.tsx')).toContain('blue');

    const refused = await agentToolCall({ name: 'get_node_tree', input: {} });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain(EXTERNAL_STOPPED_MESSAGE.slice(0, 40));

    // A new request clears it.
    agentRunStart({ source: 'mcp', request: 'next thing' });
    const ok = await agentToolCall({ name: 'get_node_tree', input: {} });
    expect(ok.isError).toBe(false);
  });

  it('a crashed client cannot hold the editor forever: the run ends after its idle lease', async () => {
    vi.useFakeTimers();
    agentRunStart({ source: 'mcp', request: 'x' });
    await agentToolCall({ name: 'get_node_tree', input: {} });
    vi.advanceTimersByTime(MCP_RUN_IDLE_MS - 1000);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
    expect(store.get(agentStatusAtom)).toBe('idle');
  });

  it('begin_work gets the same context block the chat\'s turn starts with', () => {
    const ctx = agentContext();
    expect(ctx.branch).toBe(MAIN_BRANCH_ID);
    expect(ctx.surface.kind).toBeTruthy();
    expect(ctx.contextBlock.length).toBeGreaterThan(0);
  });

  it('names clients the way the user knows them', () => {
    expect(clientLabel('claude-code')).toBe('Claude Code');
    expect(clientLabel(undefined)).toBe('MCP');
    expect(clientLabel('my-agent')).toBe('my-agent');
  });

  it('the MCP proxy\'s own file tools are part of the run too: a row in the chat, and in the Changes', async () => {
    agentRunStart({ source: 'mcp', request: 'add a card component', client: 'claude-code' });
    // The bridge suite's known-clean component — committed by the oracle gate.
    const CARD = `import React from 'react';
import { motion, LayoutGroup, MotionConfig } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Test Card" */

function TestCard({ style }: { style?: React.CSSProperties }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }}>
    <motion.div data-id="card" layout style={{ position: 'relative', display: 'flex', padding: '24px', ...style }}>
      <motion.p data-id="label" layout style={{ position: 'relative', flex: '0 0 auto', order: '0', color: '#fff' }}>Hello</motion.p>
    </motion.div>
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(TestCard);
`;
    await runBridgeRequest('submitFiles', { files: [{ path: 'components/TestCard.tsx', kind: 'component', code: CARD }] });
    expect(store.get(agentToolsAtom).map((t) => t.name)).toEqual(['revyme_submit_files']);
    agentRunEnd({ summary: 'Added the card.' });
    const reply = store.get(agentConversationAtom).slice(-1)[0];
    expect(reply.tools?.map((t) => t.name)).toEqual(['revyme_submit_files']);
    expect(projectFS.exists('components/TestCard.tsx')).toBe(true);
    expect(reply.changes?.map((c) => c.path)).toContain('components/TestCard.tsx');
  });

  it('a bare write through the MCP proxy (no begin_work) still runs inside a run — locked, then released by its lease', async () => {
    vi.useFakeTimers();
    await runBridgeRequest('submitFiles', { files: [] }).catch(() => {});
    expect(isExternalRunActive()).toBe(true);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(isBranchLocked(MAIN_BRANCH_ID)).toBe(false);
  });
});
