// The budget is the only thing standing between a screenshot-heavy
// conversation and an unbounded `_meta/chat-history.json` that is re-written on
// every project save and re-parsed on every load.

import { describe, test, expect } from 'vitest';
import { budgetImages } from './chat-history-store';
import { CHAT_HISTORY_IMAGE_BUDGET, type StoredChatMessage } from '@/code/project/chat-history-config';

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
