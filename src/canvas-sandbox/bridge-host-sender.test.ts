// bridge-host-sender.test.ts — security report 2026-11-06: the editor
// accepted `dndCommit` (and every other canvas event) from ANY window. A page
// that opened the editor in a popup could post forged canvas edits, which
// were written into the project and saved. Only the canvas iframe may drive
// the bridge.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), error: vi.fn(), dom: vi.fn() } }));
import { PostMessageBridge } from './bridge-host';
import { SANDBOX_ORIGIN } from './protocol';

const commit = (source: unknown, origin: string) => ({
  data: { type: 'dndCommit', updates: [{ nodeId: 'hero', styles: { left: '0px' } }] },
  source,
  origin,
} as unknown as MessageEvent);

describe('PostMessageBridge — only the canvas iframe may send events', () => {
  let bridge: PostMessageBridge;
  let iframe: HTMLIFrameElement;
  let onDndCommit: Mock<NonNullable<PostMessageBridge['onDndCommit']>>;
  const handle = (e: MessageEvent) => (bridge as any).handleMessage(e);

  beforeEach(() => {
    bridge = new PostMessageBridge();
    onDndCommit = vi.fn<NonNullable<PostMessageBridge['onDndCommit']>>();
    bridge.onDndCommit = onDndCommit;
    iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
  });
  afterEach(() => {
    bridge.destroy();
    iframe.remove();
  });

  it('a commit from another website is ignored', () => {
    handle(commit(window.opener ?? {}, 'https://evil.example'));
    expect(onDndCommit).not.toHaveBeenCalled();
  });

  it('before the iframe is known, the sandbox origin is accepted (it announces itself early)', () => {
    handle(commit({}, SANDBOX_ORIGIN));
    expect(onDndCommit).toHaveBeenCalledTimes(1);
  });

  it('once the iframe is known, only its window is accepted', () => {
    bridge.setIframe(iframe);
    handle(commit({}, SANDBOX_ORIGIN));               // another window at the sandbox origin
    expect(onDndCommit).not.toHaveBeenCalled();
    handle(commit(iframe.contentWindow, 'https://evil.example')); // our frame, navigated away
    expect(onDndCommit).not.toHaveBeenCalled();
    handle(commit(iframe.contentWindow, SANDBOX_ORIGIN));
    expect(onDndCommit).toHaveBeenCalledTimes(1);
  });

  it('sandbox events (sandboxReady) follow the same rule', () => {
    bridge.setIframe(iframe);
    const ready = (source: unknown) => ({
      data: { __sandbox: true, payload: { type: 'sandboxReady' } }, source, origin: SANDBOX_ORIGIN,
    } as unknown as MessageEvent);
    handle(ready({}));
    expect((bridge as any).ready).toBe(false);
    handle(ready(iframe.contentWindow));
    expect((bridge as any).ready).toBe(true);
  });
});
