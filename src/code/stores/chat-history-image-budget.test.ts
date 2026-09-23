// The budget is the only thing standing between a screenshot-heavy
// conversation and an unbounded `_meta/chat-history.json` that is re-written on
// every project save and re-parsed on every load.

import { describe, test, expect } from 'vitest';
import { budgetImages, budgetUserImages } from './chat-history-store';
import { CHAT_HISTORY_IMAGE_BUDGET, CHAT_HISTORY_USER_IMAGE_BUDGET, type StoredChatMessage } from '@/code/project/chat-history-config';

/** n messages, each with one screenshot, oldest first. */
function shots(n: number): StoredChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'assistant' as const,
    content: `reply ${i}`,
    blocks: [{ kind: 'tools' as const, tools: [{ name: 'get_screenshot', ok: true, image: `img-${i}` }] }],
  }));
}

const kept = (msgs: StoredChatMessage[]) =>
  msgs.flatMap((m) => (m.blocks ?? []).flatMap((b) => (b.kind === 'tools' ? b.tools : [])))
    .filter((t) => t.image)
    .map((t) => t.image);

describe('budgetImages', () => {
  test('keeps the NEWEST captures and drops the rest', () => {
    const msgs = shots(CHAT_HISTORY_IMAGE_BUDGET + 4);
    budgetImages(msgs);
    const remaining = kept(msgs);
    expect(remaining).toHaveLength(CHAT_HISTORY_IMAGE_BUDGET);
    // The last one taken must survive; the first must not.
    expect(remaining).toContain(`img-${CHAT_HISTORY_IMAGE_BUDGET + 3}`);
    expect(remaining).not.toContain('img-0');
  });

  test('a history under budget is untouched', () => {
    const msgs = shots(2);
    budgetImages(msgs);
    expect(kept(msgs)).toEqual(['img-0', 'img-1']);
  });

  // Losing the picture must never lose the line that says it was taken.
  test('the activity survives even when its image is dropped', () => {
    const msgs = shots(CHAT_HISTORY_IMAGE_BUDGET + 1);
    budgetImages(msgs);
    const oldest = msgs[0].blocks?.[0];
    expect(oldest?.kind).toBe('tools');
    expect(oldest?.kind === 'tools' && oldest.tools[0].name).toBe('get_screenshot');
    expect(oldest?.kind === 'tools' && oldest.tools[0].image).toBeUndefined();
  });

  test('messages with no blocks are skipped without throwing', () => {
    const msgs: StoredChatMessage[] = [{ role: 'user', content: 'hi' }, ...shots(1)];
    expect(() => budgetImages(msgs)).not.toThrow();
    expect(kept(msgs)).toEqual(['img-0']);
  });
});

// Pasted images: only the THUMBNAIL is stored, under its own budget.
describe('budgetUserImages', () => {
  const pasted = (n: number, per = 1): StoredChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: 'user' as const,
      content: `ask ${i}`,
      images: Array.from({ length: per }, (_, k) => `data:image/jpeg;base64,${i}-${k}`),
    }));
  const all = (msgs: StoredChatMessage[]) => msgs.flatMap((m) => m.images ?? []);

  test('keeps the NEWEST thumbnails and drops the rest', () => {
    const msgs = pasted(CHAT_HISTORY_USER_IMAGE_BUDGET + 3);
    budgetUserImages(msgs);
    expect(all(msgs)).toHaveLength(CHAT_HISTORY_USER_IMAGE_BUDGET);
    expect(all(msgs)).toContain(`data:image/jpeg;base64,${CHAT_HISTORY_USER_IMAGE_BUDGET + 2}-0`);
    expect(all(msgs)).not.toContain('data:image/jpeg;base64,0-0');
  });

  test('a message that loses its picture keeps its words', () => {
    const msgs = pasted(CHAT_HISTORY_USER_IMAGE_BUDGET + 1);
    budgetUserImages(msgs);
    expect(msgs[0].content).toBe('ask 0');
    expect(msgs[0].images).toBeUndefined();   // removed, not left as []
  });

  test('a partly-kept message keeps its FIRST images, in paste order', () => {
    const msgs = pasted(1, CHAT_HISTORY_USER_IMAGE_BUDGET + 2);
    budgetUserImages(msgs);
    expect(msgs[0].images?.[0]).toBe('data:image/jpeg;base64,0-0');
    expect(msgs[0].images).toHaveLength(CHAT_HISTORY_USER_IMAGE_BUDGET);
  });

  test('does not touch the screenshot budget, or messages without images', () => {
    const msgs: StoredChatMessage[] = [...shots(2), { role: 'user', content: 'plain' }];
    budgetUserImages(msgs);
    expect(kept(msgs)).toHaveLength(2);
    expect(msgs[2]).toEqual({ role: 'user', content: 'plain' });
  });
});
