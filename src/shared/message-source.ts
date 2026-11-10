// message-source.ts — who may talk to us over postMessage.
//
// Any window holding a reference to ours can post to it: a page that opened
// the editor in a popup, a page that framed it, or whatever a frame we embed
// has navigated to. A message's `data` is whatever the sender wants it to be;
// only `source` (the sending window) and `origin` are filled in by the
// browser. So a listener that acts on a message checks those two, and a post
// that carries project data names the exact origin it is meant for, not '*'.

import type { Endpoint } from 'comlink';

/** True when `e` was posted by `from` — and, when given, from `origin`. */
export function isMessageFrom(
  e: MessageEvent,
  from: Window | null | undefined,
  origin?: string,
): boolean {
  if (!from || e.source !== from) return false;
  return origin === undefined || e.origin === origin;
}

/**
 * A Comlink endpoint that talks to ONE window. Comlink's own `windowEndpoint`
 * hands Comlink every message posted to this window and posts to '*'. This one:
 *   · delivers only messages whose `source` is `peer` (and whose origin is
 *     `origin`, when given) — no other window can call the exposed API or
 *     answer a pending call;
 *   · posts to `origin`, or — when the peer's origin isn't known up front
 *     (the canvas sandbox doesn't know which editor host embedded it) — to the
 *     origin of the first message accepted from it. Until then it posts to
 *     '*'; an exposed API only ever answers a call, so in practice the origin
 *     is always known by the time it posts.
 */
export function trustedWindowEndpoint(
  peer: Window,
  origin?: string,
  context: EventTarget = self,
): Endpoint {
  let peerOrigin = origin;
  const filtered = new Map<EventListenerOrEventListenerObject, EventListener>();
  return {
    postMessage(message: unknown, transfer?: Transferable[]) {
      peer.postMessage(message, peerOrigin ?? '*', transfer);
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const onlyPeer = (ev: Event) => {
        const e = ev as MessageEvent;
        if (!isMessageFrom(e, peer, origin)) return;
        if (peerOrigin === undefined && e.origin && e.origin !== 'null') peerOrigin = e.origin;
        if (typeof listener === 'function') listener(e);
        else listener.handleEvent(e);
      };
      filtered.set(listener, onlyPeer);
      context.addEventListener(type, onlyPeer);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const onlyPeer = filtered.get(listener);
      if (!onlyPeer) return;
      filtered.delete(listener);
      context.removeEventListener(type, onlyPeer);
    },
  };
}
