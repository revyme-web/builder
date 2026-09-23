import { describe, it, expect } from 'vitest';
import { turnsFromStored, storedFromTurns, visibleBlocks } from './transcript-io';
import type { AgentTurn } from '@/code/stores/agent-chat-store';

const turns: AgentTurn[] = [
  { role: 'user', text: 'like this', images: [{ thumb: 'data:image/jpeg;base64,T', full: 'data:image/png;base64,FULL', width: 10, height: 10 }] },
  { role: 'assistant', text: 'Done.', reasoning: 'hm',
    blocks: [
      { kind: 'text', text: 'Building.' },
      { kind: 'tools', tools: [
        { id: 'call-1', name: 'add_node', ok: true, count: 3, ms: 120, note: 'why' },
        { id: 'call-2', name: 'get_screenshot', ok: null, image: 'data:image/png;base64,S' },
      ] },
    ],
    changes: [{ path: 'app/page.client.tsx', addedIds: ['a'] }] },
];

describe('transcript ↔ storage', () => {
  it('stores the THUMBNAIL of a pasted image, never the copy the model saw', () => {
    const stored = storedFromTurns(turns);
    expect(stored[0].images).toEqual(['data:image/jpeg;base64,T']);
    expect(JSON.stringify(stored)).not.toContain('FULL');
  });

  it('a call still in flight when the turn ended is stored as not landed', () => {
    const tools = (storedFromTurns(turns)[1].blocks![1] as { tools: { name: string; ok: boolean }[] }).tools;
    expect(tools.map((t) => [t.name, t.ok])).toEqual([['add_node', true], ['get_screenshot', false]]);
  });

  it('never stores per-run ids', () => {
    expect(JSON.stringify(storedFromTurns(turns))).not.toContain('call-1');
  });

  it('round-trips everything the transcript renders', () => {
    const back = turnsFromStored(storedFromTurns(turns));
    expect(back[1].text).toBe('Done.');
    expect(back[1].reasoning).toBe('hm');
    expect(back[1].changes).toEqual(turns[1].changes);
    expect(back[1].blocks![0]).toEqual({ kind: 'text', text: 'Building.' });
    expect(back[1].blocks![1]).toMatchObject({ kind: 'tools', tools: [{ name: 'add_node', count: 3, ms: 120, note: 'why' }, { image: 'data:image/png;base64,S' }] });
    // A restored image shows, but has no `full` to re-send.
    expect(back[0].images).toEqual([{ thumb: 'data:image/jpeg;base64,T' }]);
  });

  // The store budgets images IN PLACE on what it is handed.
  it('hands the store fresh objects — it must never reach into the live transcript', () => {
    const stored = storedFromTurns(turns);
    const liveTool = (turns[1].blocks![1] as { tools: { image?: string }[] }).tools[1];
    delete (stored[1].blocks![1] as { tools: { image?: string }[] }).tools[1].image;
    expect(liveTool.image).toBe('data:image/png;base64,S');
  });
});

describe('thinking blocks', () => {
  it('round-trip in place, between the text and the work', () => {
    const turns = [{ role: 'assistant' as const, text: 'Done.', blocks: [
      { kind: 'reasoning' as const, text: 'Planning the hero.' },
      { kind: 'tools' as const, tools: [{ id: 'a', name: 'set_styles', ok: true }] },
      { kind: 'text' as const, text: 'Done.' },
    ] }];
    const back = turnsFromStored(storedFromTurns(turns as never));
    expect(back[0].blocks?.map((b) => b.kind)).toEqual(['reasoning', 'tools', 'text']);
    expect(back[0].blocks?.[0]).toEqual({ kind: 'reasoning', text: 'Planning the hero.' });
  });
});

describe('visibleBlocks', () => {
  it('a blank line between tool calls (Gemini) no longer splits the steps into one card each', () => {
    const t = (name: string) => ({ id: name, name, ok: true });
    const shown = visibleBlocks([
      { kind: 'tools', tools: [t('a')] },
      { kind: 'text', text: '\n' },
      { kind: 'tools', tools: [t('b')] },
      { kind: 'reasoning', text: '  ' },
      { kind: 'tools', tools: [t('c')] },
      { kind: 'text', text: 'Done.' },
      { kind: 'tools', tools: [t('d')] },
    ] as never);
    expect(shown.map((b) => b.kind)).toEqual(['tools', 'text', 'tools']);
    expect((shown[0] as any).tools.map((x: any) => x.name)).toEqual(['a', 'b', 'c']);
  });
});
