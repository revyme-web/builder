// Project-level chats, against the REAL in-memory ProjectFS.
import { describe, test, expect, beforeEach } from 'vitest';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import {
  AGENT_CHATS_FILE_PATH, MAX_AGENT_CHATS, CHATS_KEEPING_IMAGES, NEW_CHAT_TITLE,
  chatTitleFrom, relativeAge, parseAgentChats, isAgentOwnedHistoryKey,
} from '@/code/project/agent-chats-config';
import { CHAT_HISTORY_FILE_PATH, parseChatHistory, type StoredChatMessage } from '@/code/project/chat-history-config';
import {
  listAgentChats, getAgentChat, saveAgentChat, deleteAgentChat, migrateFileKeyedHistory, newAgentChatId, resolveAgentChatId,
} from './agent-chats-store';

const user = (content: string, extra: Partial<StoredChatMessage> = {}): StoredChatMessage => ({ role: 'user', content, ...extra });
const bot = (content: string, extra: Partial<StoredChatMessage> = {}): StoredChatMessage => ({ role: 'assistant', content, ...extra });
const shot = (n: number): StoredChatMessage => bot('looked', { blocks: [{ kind: 'tools', tools: [{ name: 'get_screenshot', ok: true, image: `data:image/png;base64,S${n}` }] }] });

beforeEach(() => { resetProjectFS(new Map([['app/page.client.tsx', 'x'], ['components/Nav.tsx', 'x']])); });

describe('chatTitleFrom', () => {
  test('names a chat after the first thing asked for', () => {
    expect(chatTitleFrom('create a header component')).toBe('Create a header component');
  });
  test('first line only, whitespace collapsed', () => {
    expect(chatTitleFrom('\n  make   the hero bigger \nand also the footer')).toBe('Make the hero bigger');
  });
  test('cuts a long opener at a word, with an ellipsis', () => {
    const t = chatTitleFrom('build me a full landing page for a dental clinic in Lyon with booking');
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(43);
    expect(t).not.toMatch(/\s…$/);
    expect('build me a full landing page for a dental clinic in Lyon with booking'.toLowerCase().startsWith(t.slice(0, -1).toLowerCase())).toBe(true);
  });
  test('an image-only opener, and nothing at all', () => {
    expect(chatTitleFrom('', true)).toBe('Image');
    expect(chatTitleFrom('   ')).toBe(NEW_CHAT_TITLE);
  });
});

describe('relativeAge', () => {
  const now = 1_800_000_000_000;
  const ago = (ms: number) => relativeAge(now - ms, now);
  test('fits a menu row', () => {
    expect(ago(5_000)).toBe('now');
    expect(ago(5 * 60_000)).toBe('5m');
    expect(ago(3 * 3_600_000)).toBe('3h');
    expect(ago(2 * 86_400_000)).toBe('2d');
    expect(ago(21 * 86_400_000)).toBe('3w');
    expect(ago(120 * 86_400_000)).toBe('4mo');
    expect(ago(800 * 86_400_000)).toBe('2y');
  });
  test('a clock that ran backwards is "now", not negative', () => {
    expect(relativeAge(now + 60_000, now)).toBe('now');
  });
});

describe('saving and listing', () => {
  test('a chat is created by its first save, titled from its first message', () => {
    const id = newAgentChatId();
    saveAgentChat(id, [user('create a header component'), bot('Done.')], 1000);
    expect(listAgentChats()).toMatchObject([{ id, title: 'Create a header component', createdAt: 1000, updatedAt: 1000 }]);
    expect(getAgentChat(id)!.messages).toHaveLength(2);
  });

  test('an EMPTY chat is never stored — opening the panel leaves no "New chat" rows behind', () => {
    saveAgentChat(newAgentChatId(), [], 1000);
    expect(projectFS.exists(AGENT_CHATS_FILE_PATH)).toBe(false);
  });

  test('lists most recently ACTIVE first', () => {
    const a = newAgentChatId(); const b = newAgentChatId();
    saveAgentChat(a, [user('first')], 1000);
    saveAgentChat(b, [user('second')], 2000);
    saveAgentChat(a, [user('first'), bot('more')], 3000);
    expect(listAgentChats().map((c) => c.id)).toEqual([a, b]);
  });

  test('the title is fixed at creation — a later message does not rename the chat', () => {
    const id = newAgentChatId();
    saveAgentChat(id, [user('make a hero')], 1000);
    saveAgentChat(id, [user('make a hero'), bot('ok'), user('now something else entirely')], 2000);
    expect(getAgentChat(id)!.title).toBe('Make a hero');
  });

  // Opening an old chat re-runs the save with the SAME transcript.
  test('re-saving an unchanged transcript does not float the chat to the top', () => {
    const old = newAgentChatId(); const recent = newAgentChatId();
    saveAgentChat(old, [user('old')], 1000);
    saveAgentChat(recent, [user('recent')], 2000);
    saveAgentChat(old, [user('old')], 9000);
    expect(listAgentChats().map((c) => c.id)).toEqual([recent, old]);
    expect(getAgentChat(old)!.updatedAt).toBe(1000);
  });

  test('saving one chat leaves the others exactly as they were', () => {
    const a = newAgentChatId(); const b = newAgentChatId();
    saveAgentChat(a, [user('a')], 1000);
    saveAgentChat(b, [user('b')], 2000);
    const before = JSON.stringify(getAgentChat(a));
    saveAgentChat(b, [user('b'), bot('reply')], 3000);
    expect(JSON.stringify(getAgentChat(a))).toBe(before);
  });

  test('delete removes one chat and only that one', () => {
    const a = newAgentChatId(); const b = newAgentChatId();
    saveAgentChat(a, [user('a')], 1000);
    saveAgentChat(b, [user('b')], 2000);
    deleteAgentChat(a);
    expect(listAgentChats().map((c) => c.id)).toEqual([b]);
  });
});

describe('the file stays bounded — it rides every project save', () => {
  test(`keeps the ${MAX_AGENT_CHATS} most recently active chats`, () => {
    for (let i = 0; i < MAX_AGENT_CHATS + 5; i++) saveAgentChat(`c${i}`, [user(`chat ${i}`)], 1000 + i);
    const ids = listAgentChats().map((c) => c.id);
    expect(ids).toHaveLength(MAX_AGENT_CHATS);
    expect(ids[0]).toBe(`c${MAX_AGENT_CHATS + 4}`);
    expect(ids).not.toContain('c0');
  });

  test('only the most recently active chats keep their PICTURES; every word stays', () => {
    const n = CHATS_KEEPING_IMAGES + 2;
    for (let i = 0; i < n; i++) {
      saveAgentChat(`c${i}`, [user(`ask ${i}`, { images: ['data:image/jpeg;base64,T'] }), shot(i)], 1000 + i);
    }
    const chats = listAgentChats();
    const pictures = (c: (typeof chats)[number]) => JSON.stringify(c.messages).includes('data:image/');
    expect(chats.slice(0, CHATS_KEEPING_IMAGES).every(pictures)).toBe(true);
    expect(chats.slice(CHATS_KEEPING_IMAGES).some(pictures)).toBe(false);
    const oldest = chats[chats.length - 1];
    expect(oldest.messages.map((m) => m.content)).toEqual(['ask 0', 'looked']);
    expect(oldest.messages[1].blocks?.[0]).toMatchObject({ kind: 'tools', tools: [{ name: 'get_screenshot', ok: true }] });
  });
});

describe('parseAgentChats — a shared, hand-editable file', () => {
  test('junk costs history, never the panel', () => {
    for (const bad of [null, '', 'not json', '[]', '{"chats":"nope"}', '{"chats":[null, 7, {"id":5}]}']) {
      expect(parseAgentChats(bad).chats).toEqual([]);
    }
  });
  test('drops duplicate ids and chats with no usable messages; sanitizes the rest', () => {
    const file = parseAgentChats(JSON.stringify({ chats: [
      { id: 'a', title: 'A', updatedAt: 5, messages: [{ role: 'user', content: 'hi', images: ['javascript:alert(1)', 'data:image/png;base64,AA'] }] },
      { id: 'a', title: 'dup', updatedAt: 9, messages: [{ role: 'user', content: 'x' }] },
      { id: 'b', title: 'B', updatedAt: 6, messages: [{ role: 'system', content: 'nope' }] },
      { id: 'c', updatedAt: 7, messages: [{ role: 'user', content: 'untitled one' }] },
    ] }));
    expect(file.chats.map((c) => [c.id, c.title])).toEqual([['a', 'A'], ['c', 'Untitled one']]);
    expect(file.chats[0].messages[0].images).toEqual(['data:image/png;base64,AA']);
  });
});

describe('one-time migration from per-FILE transcripts', () => {
  const legacy = {
    'app/page.client.tsx': [user('make a hero'), bot('Done.')],
    'components/Nav.tsx': [user('add a burger menu')],
    'plugins/gradient/plugin.tsx': [user('plugin chat — still read per file')],
  };
  const seed = () => projectFS.writeFile(CHAT_HISTORY_FILE_PATH, JSON.stringify(legacy));

  test('pages and components become chats; chats that still have a per-file reader stay put', () => {
    seed();
    expect(migrateFileKeyedHistory(5000)).toBe(2);
    expect(listAgentChats().map((c) => c.title).sort()).toEqual(['Add a burger menu', 'Make a hero']);
    const left = parseChatHistory(projectFS.readFile(CHAT_HISTORY_FILE_PATH));
    expect(Object.keys(left)).toEqual(['plugins/gradient/plugin.tsx']);
  });

  test('MOVED, not copied — no transcript exists twice', () => {
    seed();
    migrateFileKeyedHistory(5000);
    expect(projectFS.readFile(CHAT_HISTORY_FILE_PATH)).not.toContain('make a hero');
  });

  test('never runs twice — a chat the user deleted stays deleted', () => {
    seed();
    migrateFileKeyedHistory(5000);
    for (const c of listAgentChats()) deleteAgentChat(c.id);
    seed();                                   // the old file reappears (a teammate on an older build)
    expect(migrateFileKeyedHistory(6000)).toBe(0);
    expect(listAgentChats()).toEqual([]);
  });

  test('nothing to migrate writes nothing', () => {
    expect(migrateFileKeyedHistory(5000)).toBe(0);
    expect(projectFS.exists(AGENT_CHATS_FILE_PATH)).toBe(false);
  });

  test('the old CMS assistant\'s per-collection transcripts belong to the one agent too', () => {
    expect(isAgentOwnedHistoryKey('cms/blog.schema.json')).toBe(true);
    expect(isAgentOwnedHistoryKey('cms/blog.json')).toBe(false);
    expect(isAgentOwnedHistoryKey('icons/Brand.tsx')).toBe(false);
  });
});

describe('resolveAgentChatId — which chat a panel opens on', () => {
  test('nothing chosen yet → the most recently active chat', () => {
    saveAgentChat('old', [user('old')], 1000);
    saveAgentChat('recent', [user('recent')], 2000);
    expect(resolveAgentChatId(undefined)).toBe('recent');
  });
  test('nothing chosen and no chats → a new chat', () => {
    expect(resolveAgentChatId(undefined)).toBeNull();
  });
  test('a NEW chat the user asked for stays new — it is not replaced by the latest one', () => {
    saveAgentChat('recent', [user('recent')], 2000);
    expect(resolveAgentChatId(null)).toBeNull();
  });
  test('a chat minted this session is valid before its first save', () => {
    saveAgentChat('recent', [user('recent')], 2000);
    const fresh = newAgentChatId();
    expect(resolveAgentChatId(fresh)).toBe(fresh);
  });
  // The project was reset under the panel, or the chat was pruned.
  test('a STALE id falls back instead of showing (and re-saving) a transcript that is not this project\'s', () => {
    saveAgentChat('recent', [user('recent')], 2000);
    expect(resolveAgentChatId('chat-from-another-project')).toBe('recent');
  });
});
