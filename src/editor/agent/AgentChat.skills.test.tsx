// Project skills in the chat: the / menu, what a message invokes, and a
// request queued from Settings → Skills (sent once, however many panels are
// mounted over the same chat).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

const ctxCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/ai/agent/agent-client', () => ({
  fetchAgentEngines: vi.fn(async () => ['revyme']),
  streamAgentTurn: vi.fn(async function* () {
    yield { type: 'text', text: 'Done.' };
    yield { type: 'done' };
  }),
}));
vi.mock('@/ai/agent/editor-context', () => ({ buildAgentContextBlock: (...args: unknown[]) => { ctxCalls.push(args); return 'ctx'; } }));
vi.mock('@/ai/agent/surface-state', () => ({ readAgentSurface: () => ({ kind: 'canvas', filePath: 'app/page.client.tsx' }) }));

import AgentChat from './AgentChat';
import { resetProjectFS } from '@/code/project/project-fs';
import { saveProjectSkill } from '@/code/stores/project-skills-store';
import { activeAgentChatIdAtom, loadedAgentChatIdAtom, getAgentChat } from '@/code/stores/agent-chats-store';
import { agentStatusAtom, agentConversationAtom, agentQueuedRequestAtom } from '@/code/stores/agent-chat-store';
import { streamAgentTurn } from '@/ai/agent/agent-client';

const store = getDefaultStore();

beforeEach(() => {
  cleanup();
  ctxCalls.length = 0;
  vi.mocked(streamAgentTurn).mockClear();
  resetProjectFS(new Map([['app/page.client.tsx', 'x']]));
  saveProjectSkill({ name: 'seo-check', description: 'Review page SEO', content: 'Titles under 60.' });
  saveProjectSkill({ name: 'brand-voice', description: 'Keep copy on brand', content: 'Short sentences.' });
  act(() => {
    store.set(activeAgentChatIdAtom, null);
    store.set(loadedAgentChatIdAtom, null);
    store.set(agentStatusAtom, 'idle');
    store.set(agentConversationAtom, []);
    store.set(agentQueuedRequestAtom, null);
  });
});

const box = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const type = (value: string) => {
  const el = box();
  fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
};

describe('the / skill menu', () => {
  it('opens on a slash, filters as you type, and Enter writes the command', async () => {
    render(<AgentChat />);
    await waitFor(() => expect(box().disabled).toBe(false));
    type('/');
    const menu = screen.getByTestId('agent-skill-menu');
    expect(menu.textContent).toContain('/brand-voice');
    expect(menu.textContent).toContain('/seo-check');
    type('/se');
    expect(screen.getByTestId('agent-skill-menu').textContent).not.toContain('/brand-voice');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('/seo-check ');
    expect(screen.queryByTestId('agent-skill-menu')).toBeNull();
    // The picked skill shows as a badge, not plain text.
    expect(screen.getByTestId('agent-composer-mirror').querySelector('[data-skill="seo-check"]')?.textContent).toBe('/seo-check');
    expect(box().className).toContain('text-transparent');
    // Enter picked the skill — it did NOT send the message.
    expect(streamAgentTurn).not.toHaveBeenCalled();
  });

  it('Escape closes it; a slash inside a word never opens it', async () => {
    render(<AgentChat />);
    await waitFor(() => expect(box().disabled).toBe(false));
    type('/');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByTestId('agent-skill-menu')).toBeNull();
    type('and/or');
    expect(screen.queryByTestId('agent-skill-menu')).toBeNull();
  });
});

describe('sending with a skill', () => {
  it('the invoked skill rides the turn, the message says so, and the chat saves it', async () => {
    render(<AgentChat />);
    await waitFor(() => expect(box().disabled).toBe(false));
    type('/seo-check the home page');
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(streamAgentTurn).toHaveBeenCalledTimes(1));
    expect(ctxCalls[ctxCalls.length - 1]?.[1]).toEqual(['seo-check']);
    await waitFor(() => expect(screen.getByTestId('agent-turn-skills').textContent).toBe('Used /seo-check'));
    // …and in the sent message too.
    expect(document.querySelector('[data-skill="seo-check"]')?.textContent).toBe('/seo-check');
    // A plain draft is a plain text box again (no highlight layer).
    type('just words');
    expect(screen.queryByTestId('agent-composer-mirror')).toBeNull();
    await waitFor(() => {
      const id = store.get(activeAgentChatIdAtom)!;
      expect(getAgentChat(id)?.messages[0].skills).toEqual(['seo-check']);
    });
  });
});

describe('a request queued from Settings', () => {
  it('is sent once — even with two panels mounted over the chat — and leaves the draft alone', async () => {
    render(<><AgentChat /><AgentChat /></>);
    await waitFor(() => expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'my draft' } });
    act(() => { store.set(agentQueuedRequestAtom, { text: 'Generate my design-system skill.', nonce: 42 }); });
    await waitFor(() => expect(streamAgentTurn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(streamAgentTurn).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(streamAgentTurn).mock.calls[0][0].messages;
    expect(sent[sent.length - 1]?.content[0]).toEqual({ type: 'text', text: 'Generate my design-system skill.' });
    expect((screen.getAllByRole('textbox')[0] as HTMLTextAreaElement).value).toBe('my draft');
  });
});
