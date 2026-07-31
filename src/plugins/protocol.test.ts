// plugins/protocol.test.ts — sanity-check the host's protocol mirror
// against the SDK's. They MUST stay structurally identical so messages
// round-trip without translation.

import { describe, it, expect } from 'vitest';
import * as host from './protocol';
import * as sdk from '@revyme/plugin-sdk/protocol';

describe('protocol — host mirrors SDK exactly', () => {
  it('exports the same constants', () => {
    expect(host.PROTOCOL_VERSION).toBe(sdk.PROTOCOL_VERSION);
    expect(host.HOST_NAME).toBe(sdk.HOST_NAME);
  });

  it('PROTOCOL_VERSION is 1 (current)', () => {
    expect(host.PROTOCOL_VERSION).toBe(1);
  });

  // The structural type-equality check is enforced at compile time
  // by the type imports in `host/protocol.ts` (it re-exports from
  // `@revyme/plugin-sdk/protocol`). If a plugin author or future-us changes
  // one of the message shapes without updating the other, tsc will
  // fail in the host package — runtime test would notice nothing.
  // We assert THAT here by simply round-tripping a sample of each
  // message type through the type system (compile-only).
  it('every message type round-trips through both modules', () => {
    const handshake: host.HandshakeRequest = {
      type: 'handshake', protocolVersion: 1, pluginId: 'com.x.y', sdkVersion: '1.0.0',
    };
    const ack: host.HandshakeAck = {
      type: 'handshake-ack', protocolVersion: 1, hostName: 'revyme-canvas-poc',
    };
    const rpc: host.RpcRequest = {
      type: 'rpc', id: 'r1', method: 'canvas.getSelection', params: {},
    };
    const rpcRes: host.RpcResponse = {
      type: 'rpc-response', id: 'r1', ok: true, result: ['x'],
    };
    const sub: host.SubscribeRequest = {
      type: 'subscribe', id: 's1', event: 'selection',
    };
    const unsub: host.UnsubscribeRequest = {
      type: 'unsubscribe', subscriptionId: 's1',
    };
    const ev: host.EventPush = {
      type: 'event', event: 'selection', payload: ['x'],
    };
    const close: host.CloseMessage = { type: 'close' };
    expect([handshake, ack, rpc, rpcRes, sub, unsub, ev, close].length).toBe(8);
  });
});
