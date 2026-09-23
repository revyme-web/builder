// What a paste becomes, and what the model is sent. The canvas encode is a
// browser shim and is not under test here; every DECISION around it is.
import { describe, it, expect } from 'vitest';
import {
  imageFilesFromClipboard, fitWithin, roomFor, buildAgentHistory,
  MAX_ATTACHMENTS, MAX_IMAGE_EDGE, HISTORY_IMAGE_TURNS, IMAGE_DROPPED_NOTE, IMAGE_ONLY_TEXT,
} from './attachments';
import type { AgentTurn } from '@/code/stores/agent-chat-store';

const file = (type: string, name = 'x') => new File(['x'], name, { type });
const clip = (o: { text?: string; files?: File[]; items?: { kind: string; type: string; getAsFile: () => File | null }[] }) => ({
  getData: (k: string) => (k === 'text/plain' ? (o.text ?? '') : ''),
  files: (o.files ?? []) as unknown as FileList,
  items: (o.items ?? []) as unknown as DataTransferItemList,
});

describe('imageFilesFromClipboard', () => {
  it('takes a pasted screenshot', () => {
    expect(imageFilesFromClipboard(clip({ files: [file('image/png')] }))).toHaveLength(1);
  });

  // A spreadsheet copy carries a rendered bitmap of the cells NEXT TO the text.
  it('leaves a TEXT paste alone even when a bitmap rides with it', () => {
    expect(imageFilesFromClipboard(clip({ text: 'A1\tB1', files: [file('image/png')] }))).toEqual([]);
  });

  it('ignores files that are not images the providers accept', () => {
    const got = imageFilesFromClipboard(clip({ files: [file('application/pdf'), file('image/svg+xml'), file('image/jpeg'), file('image/webp')] }));
    expect(got.map((f) => f.type)).toEqual(['image/jpeg', 'image/webp']);
  });

  it('falls back to `items` when the browser exposes the bitmap only there', () => {
    const f = file('image/png');
    const got = imageFilesFromClipboard(clip({ items: [
      { kind: 'string', type: 'text/html', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => f },
    ] }));
    expect(got).toEqual([f]);
  });

  it('does not count one bitmap twice when both lists carry it', () => {
    const f = file('image/png');
    const got = imageFilesFromClipboard(clip({ files: [f], items: [{ kind: 'file', type: 'image/png', getAsFile: () => f }] }));
    expect(got).toHaveLength(1);
  });

  it('survives no clipboard at all', () => {
    expect(imageFilesFromClipboard(null)).toEqual([]);
  });
});

describe('fitWithin', () => {
  it('bounds the LONG edge and keeps the aspect', () => {
    expect(fitWithin(4000, 2000, MAX_IMAGE_EDGE)).toEqual({ width: 2000, height: 1000 });
    expect(fitWithin(1440, 6000, MAX_IMAGE_EDGE)).toEqual({ width: 480, height: 2000 });   // a tall page capture
  });
  it('never scales up', () => {
    expect(fitWithin(300, 200, MAX_IMAGE_EDGE)).toEqual({ width: 300, height: 200 });
  });
  it('never returns a zero side for a sliver', () => {
    expect(fitWithin(8000, 2, MAX_IMAGE_EDGE).height).toBe(1);
  });
  it('rejects a decode that reported no size', () => {
    expect(fitWithin(0, 0, MAX_IMAGE_EDGE)).toEqual({ width: 0, height: 0 });
  });
});

describe('roomFor', () => {
  it('caps a message', () => {
    expect(roomFor(0)).toBe(MAX_ATTACHMENTS);
    expect(roomFor(MAX_ATTACHMENTS)).toBe(0);
    expect(roomFor(MAX_ATTACHMENTS + 3)).toBe(0);
  });
});

describe('buildAgentHistory', () => {
  const img = (n: number) => ({ thumb: `data:image/jpeg;base64,t${n}`, full: `data:image/png;base64,F${n}` });

  it('sends the new message as text + its images, text first', () => {
    const out = buildAgentHistory([], { text: 'build this', images: [img(1), img(2)] });
    expect(out).toEqual([{ role: 'user', content: [
      { type: 'text', text: 'build this' },
      { type: 'image', dataUrl: 'data:image/png;base64,F1' },
      { type: 'image', dataUrl: 'data:image/png;base64,F2' },
    ] }]);
  });

  it('sends the FULL image, never the thumbnail', () => {
    const out = buildAgentHistory([], { text: 'x', images: [img(1)] });
    expect(JSON.stringify(out)).not.toContain('base64,t1');
  });

  it('gives an image-only message words — an empty text block is a 400', () => {
    const out = buildAgentHistory([], { text: '   ', images: [img(1)] });
    expect(out[0].content[0]).toEqual({ type: 'text', text: IMAGE_ONLY_TEXT });
  });

  it('keeps a follow-up able to SEE the earlier reference', () => {
    const convo: AgentTurn[] = [
      { role: 'user', text: 'like this', images: [img(1)] },
      { role: 'assistant', text: 'Done.' },
    ];
    const out = buildAgentHistory(convo, { text: 'more like the image' });
    expect(out[0].content.some((b) => b.type === 'image')).toBe(true);
  });

  it(`re-sends pixels for only the newest ${HISTORY_IMAGE_TURNS} image turns, and says so for the rest`, () => {
    const convo: AgentTurn[] = [];
    for (let n = 1; n <= HISTORY_IMAGE_TURNS + 1; n++) {
      convo.push({ role: 'user', text: `ref ${n}`, images: [img(n)] }, { role: 'assistant', text: 'ok' });
    }
    const out = buildAgentHistory(convo, { text: 'go' });
    const users = out.filter((m) => m.role === 'user');
    expect(users[0].content).toEqual([{ type: 'text', text: `ref 1\n\n${IMAGE_DROPPED_NOTE}` }]);   // oldest: words only
    expect(users[1].content.some((b) => b.type === 'image')).toBe(true);
    expect(users[2].content.some((b) => b.type === 'image')).toBe(true);
  });

  // After a reload only the thumbnail exists. The model must be TOLD, or it
  // answers "the image you sent" about pixels it never received.
  it('a turn restored from disk shows its image but does not send one', () => {
    const convo: AgentTurn[] = [{ role: 'user', text: 'like this', images: [{ thumb: 'data:image/jpeg;base64,t' }] }];
    const out = buildAgentHistory(convo, { text: 'again' });
    expect(out[0].content).toEqual([{ type: 'text', text: `like this\n\n${IMAGE_DROPPED_NOTE}` }]);
  });

  it('drops a tools-only assistant turn instead of sending an empty block', () => {
    const convo: AgentTurn[] = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: '' }];
    const out = buildAgentHistory(convo, { text: 'next' });
    expect(out.map((m) => m.role)).toEqual(['user', 'user']);
    expect(out.every((m) => m.content.every((b) => b.type !== 'text' || b.text.length > 0))).toBe(true);
  });

  it('never attaches images to an assistant turn', () => {
    const convo = [{ role: 'assistant', text: 'x', images: [img(1)] }] as AgentTurn[];
    const out = buildAgentHistory(convo, { text: 'y' });
    expect(out[0].content).toEqual([{ type: 'text', text: 'x' }]);
  });

  it('a plain text conversation is unchanged', () => {
    const convo: AgentTurn[] = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }];
    expect(buildAgentHistory(convo, { text: 'c' })).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ]);
  });
});
