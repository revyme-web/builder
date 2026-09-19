import { describe, test, expect } from 'vitest';
import { parseChatHistory, serializeChatHistory, type ChatHistoryMap } from './chat-history-config';

const wrap = (msgs: unknown[]) => JSON.stringify({ 'app/page.client.tsx': msgs });
const first = (json: string) => parseChatHistory(json)['app/page.client.tsx']?.[0];

describe('parseChatHistory — transcript blocks', () => {
  test('round-trips a reply with its activity and reasoning', () => {
    const map: ChatHistoryMap = {
      'app/page.client.tsx': [{
        role: 'assistant',
        content: 'Added a header.',
        reasoning: 'thinking out loud',
        blocks: [
          { kind: 'text', text: 'Building it now.' },
          { kind: 'tools', tools: [{ name: 'add_node', ok: true, count: 15, ms: 900 }] },
        ],
      }],
    };
    const back = parseChatHistory(serializeChatHistory(map))['app/page.client.tsx'][0];
    expect(back.reasoning).toBe('thinking out loud');
    expect(back.blocks).toHaveLength(2);
    expect(back.blocks?.[1]).toEqual({
      kind: 'tools',
      tools: [{ name: 'add_node', ok: true, count: 15, ms: 900 }],
    });
  });

  // This file is plain JSON inside the user's project — a hand-edit or a
  // half-written save must cost the activity lines, never the panel.
  test('a non-array blocks field is dropped, not rendered', () => {
    expect(first(wrap([{ role: 'user', content: 'hi', blocks: 'oops' }]))?.blocks).toBeUndefined();
  });

  test('blocks of an unknown kind are dropped', () => {
    expect(first(wrap([{ role: 'assistant', content: 'x', blocks: [{ kind: 'video' }] }]))?.blocks)
      .toBeUndefined();
  });

  test('a tools block missing its array is dropped', () => {
    expect(first(wrap([{ role: 'assistant', content: 'x', blocks: [{ kind: 'tools' }] }]))?.blocks)
      .toBeUndefined();
  });

  test('a nameless tool is dropped but its siblings survive', () => {
    const b = first(wrap([{
      role: 'assistant', content: 'x',
      blocks: [{ kind: 'tools', tools: [{ ok: true }, { name: 'add_node', ok: true }] }],
    }]))?.blocks;
    expect(b).toHaveLength(1);
    expect(b?.[0]).toEqual({ kind: 'tools', tools: [{ name: 'add_node', ok: true }] });
  });

  test('a text block with a non-string body is dropped', () => {
    expect(first(wrap([{ role: 'assistant', content: 'x', blocks: [{ kind: 'text', text: 7 }] }]))?.blocks)
      .toBeUndefined();
  });

  // Histories written before blocks existed must keep rendering from `content`.
  test('a message with no blocks is untouched', () => {
    const m = first(wrap([{ role: 'user', content: 'hello' }]));
    expect(m).toEqual({ role: 'user', content: 'hello' });
  });
});
