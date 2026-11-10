// message-source.test.ts — security report 2026-11-06: the canvas sandbox's
// Comlink API and the editor's message handlers accepted messages from ANY
// window, and replies were posted to '*'.
import { describe, it, expect, vi } from 'vitest';
import * as Comlink from 'comlink';
import { isMessageFrom, trustedWindowEndpoint } from './message-source';

const fakeWindow = () => ({ postMessage: vi.fn() }) as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };

function message(data: unknown, source: unknown, origin: string): MessageEvent {
  const e = new Event('message');
  Object.defineProperties(e, {
    data: { value: data },
    source: { value: source },
    origin: { value: origin },
  });
  return e as MessageEvent;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('isMessageFrom', () => {
  const editor = fakeWindow();
  const stranger = fakeWindow();

  it('accepts the expected window', () => {
    expect(isMessageFrom(message({}, editor, 'https://revyme.com'), editor)).toBe(true);
    expect(isMessageFrom(message({}, editor, 'https://revyme.com'), editor, 'https://revyme.com')).toBe(true);
  });

  it('refuses another window, even posting the same data from the same origin', () => {
    expect(isMessageFrom(message({}, stranger, 'https://revyme.com'), editor)).toBe(false);
  });

  it('refuses the expected window at an unexpected origin (it navigated away)', () => {
    expect(isMessageFrom(message({}, editor, 'https://evil.example'), editor, 'https://revyme.com')).toBe(false);
  });

  it('refuses everything while the expected window is unknown', () => {
    expect(isMessageFrom(message({}, editor, 'https://revyme.com'), null)).toBe(false);
    expect(isMessageFrom(message({}, null, 'https://revyme.com'), undefined)).toBe(false);
  });
});

describe('trustedWindowEndpoint', () => {
  it('delivers only the peer\'s messages', () => {
    const context = new EventTarget();
    const peer = fakeWindow();
    const ep = trustedWindowEndpoint(peer, 'https://revyme.com:5174', context);
    const heard: unknown[] = [];
    ep.addEventListener('message', (e) => heard.push((e as MessageEvent).data));
    context.dispatchEvent(message('forged', fakeWindow(), 'https://revyme.com:5174'));
    context.dispatchEvent(message('wrong-origin', peer, 'https://evil.example'));
    context.dispatchEvent(message('real', peer, 'https://revyme.com:5174'));
    expect(heard).toEqual(['real']);
  });

  it('posts to the given origin, never "*"', () => {
    const peer = fakeWindow();
    trustedWindowEndpoint(peer, 'https://revyme.com:5174', new EventTarget()).postMessage({ x: 1 });
    expect(peer.postMessage).toHaveBeenCalledWith({ x: 1 }, 'https://revyme.com:5174', undefined);
  });

  it('learns the peer origin from its first message when none is given', () => {
    const context = new EventTarget();
    const peer = fakeWindow();
    const ep = trustedWindowEndpoint(peer, undefined, context);
    ep.addEventListener('message', () => {});
    context.dispatchEvent(message('hi', peer, 'https://revyme.com'));
    ep.postMessage('reply');
    expect(peer.postMessage).toHaveBeenLastCalledWith('reply', 'https://revyme.com', undefined);
  });

  it('removeEventListener detaches the filtered listener', () => {
    const context = new EventTarget();
    const peer = fakeWindow();
    const ep = trustedWindowEndpoint(peer, undefined, context);
    const listener = vi.fn();
    ep.addEventListener('message', listener);
    ep.removeEventListener('message', listener);
    context.dispatchEvent(message('late', peer, 'https://revyme.com'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('an exposed Comlink API ignores calls from other windows and answers its parent only', async () => {
    const context = new EventTarget();
    const editor = fakeWindow();
    const api = { renderNodes: vi.fn(() => 'rendered') };
    Comlink.expose(api, trustedWindowEndpoint(editor, undefined, context));
    const call = { id: 'call-1', type: 'APPLY', path: ['renderNodes'], argumentList: [] };

    context.dispatchEvent(message(call, fakeWindow(), 'https://evil.example'));
    await settle();
    expect(api.renderNodes).not.toHaveBeenCalled();

    context.dispatchEvent(message(call, editor, 'https://revyme.com'));
    await vi.waitFor(() => expect(editor.postMessage).toHaveBeenCalled());
    expect(api.renderNodes).toHaveBeenCalledTimes(1);
    const [reply, targetOrigin] = editor.postMessage.mock.calls[0];
    expect(reply).toMatchObject({ id: 'call-1', value: 'rendered' });
    expect(targetOrigin).toBe('https://revyme.com');
  });
});
