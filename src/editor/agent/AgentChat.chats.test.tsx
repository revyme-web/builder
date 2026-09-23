// The chat body's load / save / switch state machine, driven through the REAL
// component over the real in-memory ProjectFS. Only the network turn is faked.
//
// What this guards: several panels mount this body over ONE transcript, the
// transcript is swapped when the chat changes, and it is saved when it settles.
// Get the ordering wrong and chat A's transcript is written into chat B.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

vi.mock('@/ai/agent/agent-client', () => ({
  // The service in these tests runs the local engines (the chat is configured).
  fetchAgentEngines: vi.fn(async () => ['revyme', 'claude-cli']),
  streamAgentTurn: vi.fn(async function* () {
    yield { type: 'text', text: 'Built it.' };
    yield { type: 'done' };
  }),
}));
vi.mock('@/ai/agent/editor-context', () => ({ buildAgentContextBlock: () => 'ctx' }));
vi.mock('@/ai/agent/surface-state', () => ({ readAgentSurface: () => ({ kind: 'canvas', filePath: 'app/page.client.tsx' }) }));

import AgentChat from './AgentChat';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { CHAT_HISTORY_FILE_PATH } from '@/code/project/chat-history-config';
import {
  activeAgentChatIdAtom, loadedAgentChatIdAtom, saveAgentChat, getAgentChat, listAgentChats,
} from '@/code/stores/agent-chats-store';
import {
  agentStatusAtom, agentConversationAtom, agentStreamAtom, agentToolsAtom, agentBlocksAtom, agentReasoningAtom, agentErrorAtom,
} from '@/code/stores/agent-chat-store';

const store = getDefaultStore();
const seed = () => {
  saveAgentChat('old', [{ role: 'user', content: 'make a footer' }, { role: 'assistant', content: 'Footer is in.' }], 1000);
  saveAgentChat('recent', [{ role: 'user', content: 'make a hero' }, { role: 'assistant', content: 'Hero is in.' }], 2000);
};

beforeEach(() => {
  cleanup();
  resetProjectFS(new Map([['app/page.client.tsx', 'x']]));
  act(() => {
    store.set(activeAgentChatIdAtom, undefined);
    store.set(loadedAgentChatIdAtom, undefined);
    store.set(agentStatusAtom, 'idle');
    store.set(agentConversationAtom, []);
    store.set(agentStreamAtom, '');
    store.set(agentToolsAtom, []);
    store.set(agentBlocksAtom, []);
    store.set(agentReasoningAtom, '');
    store.set(agentErrorAtom, null);
  });
});

describe('opening the panel', () => {
  it('continues the most recently active chat', () => {
    seed();
    render(<AgentChat />);
    expect(screen.getByText('Hero is in.')).toBeTruthy();
    expect(screen.queryByText('Footer is in.')).toBeNull();
    expect(store.get(activeAgentChatIdAtom)).toBe('recent');
  });

  it('with no chats, is a new chat that stores nothing', () => {
    render(<AgentChat />);
    expect(screen.getByText('New chat')).toBeTruthy();
    expect(listAgentChats()).toEqual([]);
  });

  it('turns the old per-FILE transcript into a chat, once', () => {
    projectFS.writeFile(CHAT_HISTORY_FILE_PATH, JSON.stringify({
      'app/page.client.tsx': [{ role: 'user', content: 'add a pricing table' }, { role: 'assistant', content: 'Pricing is in.' }],
    }));
    render(<AgentChat />);
    expect(screen.getByText('Pricing is in.')).toBeTruthy();
    expect(listAgentChats().map((c) => c.title)).toEqual(['Add a pricing table']);
  });
});

describe('switching', () => {
  it('swaps the transcript — and writes NEITHER chat into the other', () => {
    seed();
    const before = JSON.stringify(listAgentChats());
    render(<AgentChat />);
    act(() => { store.set(activeAgentChatIdAtom, 'old'); });
    expect(screen.getByText('Footer is in.')).toBeTruthy();
    expect(screen.queryByText('Hero is in.')).toBeNull();
    act(() => { store.set(activeAgentChatIdAtom, 'recent'); });
    expect(screen.getByText('Hero is in.')).toBeTruthy();
    // Same transcripts, same order, same timestamps: looking is not editing.
    expect(JSON.stringify(listAgentChats())).toBe(before);
  });

  it('"+" is an empty chat, and the one left behind is untouched', () => {
    seed();
    render(<AgentChat />);
    fireEvent.click(screen.getByLabelText('New chat'));
    expect(screen.queryByText('Hero is in.')).toBeNull();
    expect(store.get(activeAgentChatIdAtom)).toBeNull();
    expect(getAgentChat('recent')!.messages).toHaveLength(2);
    expect(listAgentChats()).toHaveLength(2);           // an empty chat is not stored
  });
});

describe('errors stay in the chat', () => {
  it('a run that ends on an error keeps it on its turn — shown, and saved with the chat for later debugging', async () => {
    const { streamAgentTurn } = await import('@/ai/agent/agent-client');
    vi.mocked(streamAgentTurn).mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'Setting the pink.' };
      yield { type: 'error', message: 'Unreconciled verification — done refused: audit_design pending' };
    });
    seed();
    render(<AgentChat />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'make the hero pink' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => expect(screen.getByTestId('agent-turn-error').textContent).toContain('Unreconciled verification'));
    await waitFor(() => {
      const saved = getAgentChat('recent')!.messages.slice(-1)[0];
      expect(saved.role).toBe('assistant');
      expect(saved.errorMessage).toContain('Unreconciled verification');
    });
  });
});

describe('the model\'s thinking', () => {
  it('streams into its own card, in place before the work it led to — and is saved that way', async () => {
    const { streamAgentTurn } = await import('@/ai/agent/agent-client');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.mocked(streamAgentTurn).mockImplementationOnce(async function* () {
      yield { type: 'reasoning', text: '**Planning the hero**\n\nA dark, bold ' };
      yield { type: 'reasoning', text: 'layout with a big headline.' };
      await gate;
      yield { type: 'tool_call', id: 't1', name: 'set_styles', input: { node_id: 'hero', styles: {} }, label: 'set_styles' };
      yield { type: 'tool_result', id: 't1', ok: true, content: '{}' };
      yield { type: 'text', text: 'Built a bold dark hero.' };
    });
    seed();
    render(<AgentChat />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'make me a hero' } });
    fireEvent.click(screen.getByLabelText('Send'));
    // Live, while the model is still thinking: a card that says so, no "Working…".
    const card = await screen.findByTestId('agent-reasoning-card');
    await waitFor(() => expect(card.textContent).toContain('layout with a big headline.'));
    expect(card.textContent).toContain('Thinking');
    expect(card.getAttribute('data-live')).toBe('true');
    expect(screen.queryByText('Working…')).toBeNull();
    release();
    // Finished: the card stays, BEFORE the steps it led to, and is no longer live.
    await waitFor(() => expect(screen.getByText('Built a bold dark hero.')).toBeTruthy());
    const done = screen.getByTestId('agent-reasoning-card');
    expect(done.textContent).toContain('Thought');
    expect(done.getAttribute('data-live')).toBeNull();
    expect(done.compareDocumentPosition(screen.getByTestId('agent-steps-card')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => {
      const saved = getAgentChat('recent')!.messages.slice(-1)[0];
      expect(saved.blocks?.map((b) => b.kind)).toEqual(['reasoning', 'tools', 'text']);
    });
  });
});

describe('the AI service is down, then comes back', () => {
  it('says it cannot reach the service (not "open settings"), and unblocks by itself when it answers', async () => {
    const { fetchAgentEngines } = await import('@/ai/agent/agent-client');
    const { agentEnginesAtom, agentServiceReachableAtom } = await import('@/code/stores/agent-chat-store');
    act(() => { store.set(agentEnginesAtom, null); store.set(agentServiceReachableAtom, null); });
    vi.mocked(fetchAgentEngines).mockResolvedValueOnce(null);
    render(<AgentChat />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await waitFor(() => expect(box.placeholder).toContain('reach the Revyme AI service'));
    expect(box.disabled).toBe(true);
    // The service is back: the next ask (focus / the retry timer) unblocks the chat.
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false));
  });
});

describe('a stream that dies mid-run', () => {
  it('releases the branch lock the service never got to release (the tab was stuck read-only)', async () => {
    const { streamAgentTurn } = await import('@/ai/agent/agent-client');
    const { agentRunStart } = await import('@/ai/agent/bridge-tools');
    const { isActiveBranchLocked } = await import('@/code/stores/agent-run-lock-store');
    // The service opens a run over the bridge, streams a little, then the
    // connection drops — no run_end ever arrives.
    vi.mocked(streamAgentTurn).mockImplementationOnce(async function* () {
      agentRunStart({ runId: 'run-dies' });
      yield { type: 'text', text: 'Now the article pages.' };
      throw new TypeError('network error');
    });
    seed();
    render(<AgentChat />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'build the journal' } });
    fireEvent.click(screen.getByLabelText('Send'));
    await waitFor(() => expect(screen.getByText('network error')).toBeTruthy());
    expect(isActiveBranchLocked()).toBe(false);
  });
});

describe('sending', () => {
  it('the first message of a new chat CREATES it, named after what was asked', async () => {
    seed();
    render(<AgentChat />);
    fireEvent.click(screen.getByLabelText('New chat'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'create a header component' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(listAgentChats()).toHaveLength(3));
    const created = listAgentChats()[0];
    expect(created.title).toBe('Create a header component');
    expect(created.messages.map((m) => [m.role, m.content])).toEqual([['user', 'create a header component'], ['assistant', 'Built it.']]);
    // …and the message went to THAT chat, not into the one that was open before.
    expect(getAgentChat('recent')!.messages).toHaveLength(2);
    expect(screen.getByText('Built it.')).toBeTruthy();
  });

  it('a message in an existing chat is appended to it, and it moves to the top', async () => {
    seed();
    render(<AgentChat />);
    act(() => { store.set(activeAgentChatIdAtom, 'old'); });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'make it darker' } });
    fireEvent.click(screen.getByLabelText('Send'));

    await waitFor(() => expect(getAgentChat('old')!.messages).toHaveLength(4));
    expect(listAgentChats().map((c) => c.id)).toEqual(['old', 'recent']);
    expect(getAgentChat('old')!.title).toBe('Make a footer');     // not renamed by a later message
    expect(getAgentChat('recent')!.messages).toHaveLength(2);
  });
});

// The dock, the CMS panel and the component editor all mount this body.
describe('a second panel opening', () => {
  it('does not reload the transcript over a reply that is streaming in the first', () => {
    seed();
    render(<AgentChat />);
    act(() => {
      store.set(agentStatusAtom, 'running');
      store.set(agentStreamAtom, 'Working on the hero');
    });
    render(<AgentChat />);                                        // e.g. the CMS panel opens
    expect(store.get(agentStreamAtom)).toBe('Working on the hero');
    expect(store.get(agentConversationAtom)).toHaveLength(2);
  });

  it('shows the same chat, not its own', () => {
    seed();
    render(<AgentChat />);
    act(() => { store.set(activeAgentChatIdAtom, 'old'); });
    render(<AgentChat />);
    expect(screen.getAllByText('Footer is in.')).toHaveLength(2);
    expect(screen.queryByText('Hero is in.')).toBeNull();
  });

  it('cannot switch chat while a run is in flight', () => {
    seed();
    render(<AgentChat />);
    act(() => { store.set(agentStatusAtom, 'running'); });
    expect((screen.getByLabelText('New chat') as HTMLButtonElement).disabled).toBe(true);
    // The chat switcher AND the branch switcher: neither may move the base
    // out from under a live run.
    const held = screen.getAllByTitle('Available when the agent has finished') as HTMLButtonElement[];
    expect(held).toHaveLength(2);
    for (const b of held) expect(b.disabled).toBe(true);
  });
});

describe('deleting', () => {
  it('removes the open chat, lands on the next one, and does NOT write it back', async () => {
    seed();
    render(<AgentChat />);
    fireEvent.click(screen.getByTitle('Switch chat'));
    fireEvent.click(await screen.findByText('Delete this chat'));
    fireEvent.click(await screen.findByText('Delete chat'));

    await waitFor(() => expect(listAgentChats().map((c) => c.id)).toEqual(['old']));
    expect(screen.getByText('Footer is in.')).toBeTruthy();
    expect(getAgentChat('recent')).toBeNull();
  });
});

describe('the in-flight turn reads like a finished one', () => {
  it('shows the sentences BETWEEN the work as they arrive, in order', () => {
    seed();
    render(<AgentChat />);
    act(() => {
      store.set(agentStatusAtom, 'running');
      store.set(agentBlocksAtom, [
        { kind: 'text', text: 'Looking at the hero first.' },
        { kind: 'tools', tools: [{ id: 't1', name: 'get_node_tree', ok: true }, { id: 't2', name: 'set_styles', ok: true }] },
        { kind: 'text', text: 'Now the footer.' },
      ]);
    });
    const first = screen.getByText('Looking at the hero first.');
    const second = screen.getByText('Now the footer.');
    const card = screen.getByTestId('agent-steps-card');
    // Document order: sentence, card of work, sentence — not all text above all tools.
    expect(first.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The last block is the live one: the card in the middle is not shimmering.
    expect(card.querySelectorAll('.agent-step-live')).toHaveLength(0);
  });
});
