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

// `_meta/chat-history.json` is hand-editable, and `images` goes straight into
// an <img src>.
describe('parseChatHistory — pasted image thumbnails', () => {
  const parse = (images: unknown, extra: Record<string, unknown> = {}) =>
    parseChatHistory(JSON.stringify({ 'app/page.tsx': [{ role: 'user', content: 'hi', images, ...extra }] }))['app/page.tsx'][0];

  test('round-trips image data URLs', () => {
    const map: ChatHistoryMap = { 'app/page.tsx': [{ role: 'user', content: 'like this', images: ['data:image/jpeg;base64,AAAA'] }] };
    expect(parseChatHistory(serializeChatHistory(map))).toEqual(map);
  });

  test('keeps only image data URLs', () => {
    expect(parse(['data:image/png;base64,AA', 'https://evil.example/x.png', 'javascript:alert(1)', 7, null]).images)
      .toEqual(['data:image/png;base64,AA']);
  });

  test('a malformed or empty list is dropped, never the message', () => {
    expect(parse('nope').images).toBeUndefined();
    expect(parse([]).images).toBeUndefined();
    expect(parse('nope').content).toBe('hi');
  });

  test('is sanitized on a message WITH blocks too', () => {
    const m = parse(['data:image/png;base64,AA', 'x'], { blocks: [{ kind: 'text', text: 't' }] });
    expect(m.images).toEqual(['data:image/png;base64,AA']);
  });
});

describe('thinking blocks in the saved file', () => {
  test('survive the parser — a hand-edited one without text is dropped, not the panel', () => {
    const map = { 'app/page.tsx': [{ role: 'assistant', content: 'Done.', blocks: [
      { kind: 'reasoning', text: 'Planning the hero.' },
      { kind: 'reasoning', text: 42 },
      { kind: 'text', text: 'Done.' },
    ] }] };
    const parsed = parseChatHistory(JSON.stringify(map)) as ChatHistoryMap;
    expect(parsed['app/page.tsx'][0].blocks).toEqual([
      { kind: 'reasoning', text: 'Planning the hero.' },
      { kind: 'text', text: 'Done.' },
    ]);
  });
});
